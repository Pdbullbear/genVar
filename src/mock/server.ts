#!/usr/bin/env node
// A local, spec-shaped mock of the Omni API for development and paper trading.
// It verifies real Ed25519 signatures, enforces the timestamp window and a 60-weight/min
// sliding window, random-walks prices, fills market/limit orders, and triggers TP/SL.
// Things the public docs don't specify (per-endpoint weights, exact fill model,
// margin math) are simplified guesses: treat the real testnet as the source of truth.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { canonicalString, verifySignature } from "../sdk/signing.js";
import { roundPrice } from "../sdk/precision.js";
import type { Fill, Instrument, Order, Ticker } from "../sdk/types.js";

const PORT = Number(process.env.MOCK_PORT ?? 8787);
const ENV = process.env.MOCK_ENV ?? "testnet";
const WEIGHT_LIMIT = Number(process.env.MOCK_WEIGHT ?? 60);
const START_COLLATERAL = 10_000;
const LEVERAGE = 10;
const OLP_HALF_SPREAD = Number(process.env.MOCK_OLP_SPREAD_BPS ?? 3) / 1e4;

// ---------- Market ----------
// A swap can be linked to a perp: its index follows the perp's index × ratio × (1 + dev), where dev is
// a mean-reverting spread. That is the perp/swap dislocation a delta-neutral arb bot trades.
interface Mkt { inst: Instrument; index: number; basis: number; vol: number; t: number; link?: { perp: string; ratio: number; dev: number } }
const pp = { min_decimal_figures: 2, max_decimal_only_figures: 5, max_significant_figures: 6 };
function mkInst(symbol: string, underlying: string, step: string): Instrument {
  return {
    symbol, underlying, settlement_asset: "USDC", contract_multiplier: 1, price_precision: pp,
    size_step: step, min_notional: "10", close_only: false, margin_modes: ["cross", "isolated"],
    status: "open", next_open_at: null, next_close_at: null, scheduled_delist_at: null,
  };
}
const markets = new Map<string, Mkt>([
  ["BTC-PERP", { inst: mkInst("BTC-PERP", "BTC", "0.00001"), index: 95000, basis: 0, vol: 0.0006, t: Date.now() }],
  ["ETH-PERP", { inst: mkInst("ETH-PERP", "ETH", "0.0001"), index: 3500, basis: 0, vol: 0.0008, t: Date.now() }],
  ["SOL-PERP", { inst: mkInst("SOL-PERP", "SOL", "0.01"), index: 180, basis: 0, vol: 0.001, t: Date.now() }],
  ["HYPE-PERP", { inst: mkInst("HYPE-PERP", "HYPE", "0.001"), index: 62, basis: 0, vol: 0.0012, t: Date.now() }],
  ["DOGE-PERP", { inst: mkInst("DOGE-PERP", "DOGE", "1"), index: 0.18, basis: 0, vol: 0.0012, t: Date.now() }],
  ["XAU-PERP", { inst: mkInst("XAU-PERP", "XAU", "0.0001"), index: 4100, basis: 0, vol: 0.0003, t: Date.now() }],
  ["US500-PERP", { inst: mkInst("US500-PERP", "US500", "0.001"), index: 690, basis: 0, vol: 0.0003, t: Date.now() }],
  ["XAG-PERP", { inst: mkInst("XAG-PERP", "XAG", "0.001"), index: 41.6, basis: 0, vol: 0.0004, t: Date.now() }],
  ["XAG-SWAP", { inst: mkSwap("XAG-SWAP", "XAG", "0.001"), index: 41.6, basis: 0, vol: 0, t: Date.now(), link: { perp: "XAG-PERP", ratio: 1, dev: 0 } }],
  ["XAU-SWAP", { inst: mkSwap("XAU-SWAP", "XAU", "0.0001"), index: 4100, basis: 0, vol: 0, t: Date.now(), link: { perp: "XAU-PERP", ratio: 1, dev: 0 } }],
  // Different price level on purpose: an index swap vs an ETF-basket perp need not trade at parity.
  ["US500-SWAP", { inst: mkSwap("US500-SWAP", "US500", "0.0001"), index: 6900, basis: 0, vol: 0, t: Date.now(), link: { perp: "US500-PERP", ratio: 10, dev: 0 } }],
]);
function mkSwap(symbol: string, underlying: string, step: string): Instrument {
  // Swaps: isolated margin only and a trading schedule (the mock keeps them open).
  return { ...mkInst(symbol, underlying, step), margin_modes: ["isolated"], next_close_at: Date.now() + 6 * 3600_000, next_open_at: Date.now() + 7 * 3600_000 };
}
const DEV_VOL = Number(process.env.MOCK_SWAP_DEV_BPS ?? 4) / 1e4;
const mark = (m: Mkt) => m.index * (1 + m.basis);
const fmt = (m: Mkt, p: number) => roundPrice(p.toFixed(10), m.inst.price_precision);

function tick() {
  for (const m of markets.values()) {
    const z = (Math.random() + Math.random() + Math.random() - 1.5) * 2;
    if (m.link) {
      // Ornstein-Uhlenbeck spread around 0 with ~25s half-life.
      m.link.dev = m.link.dev * 0.973 + z * DEV_VOL;
      m.index = markets.get(m.link.perp)!.index * m.link.ratio * (1 + m.link.dev);
    } else m.index *= 1 + z * m.vol;
    // mean-reverting basis (mark vs index), a few bps
    m.basis = m.basis * 0.9 + (Math.random() - 0.5) * 0.0006;
    m.t = Date.now();
  }
  for (const acct of accounts.values()) processTriggers(acct);
}
setInterval(tick, 1000).unref();
// Limit orders are checked against the quote far more often than prices move (Omni: every 0.1s).
setInterval(() => { for (const a of accounts.values()) processTriggers(a); }, 200).unref();

// ---------- Accounts ----------
interface Pos { size: number; entry: number; realized: number; opened: number; updated: number }
interface Acct {
  key: string; collateral: number; positions: Map<string, Pos>; orders: Order[]; fills: Fill[];
  spent: { t: number; w: number }[]; sigs: Set<string>; strikes: number; bannedUntil: number;
}
const accounts = new Map<string, Acct>();
function acct(key: string): Acct {
  let a = accounts.get(key);
  if (!a) {
    a = { key, collateral: START_COLLATERAL, positions: new Map(), orders: [], fills: [], spent: [], sigs: new Set(), strikes: 0, bannedUntil: 0 };
    accounts.set(key, a);
  }
  return a;
}

function posView(a: Acct, symbol: string) {
  const m = markets.get(symbol)!;
  const p = a.positions.get(symbol);
  const mk = mark(m);
  const size = p?.size ?? 0;
  const upnl = size ? (mk - p!.entry) * size : 0;
  const notional = Math.abs(size) * mk;
  const im = notional / LEVERAGE, mm = notional / (LEVERAGE * 2);
  return { m, p, size, upnl, im, mm, mk };
}

function accountView(a: Acct) {
  let upnl = 0, im = 0, mm = 0;
  for (const s of a.positions.keys()) {
    const v = posView(a, s);
    upnl += v.upnl; im += v.im; mm += v.mm;
  }
  const bal = a.collateral + upnl;
  return {
    equity: bal.toFixed(6), unrealized_pnl: upnl.toFixed(6), initial_margin: im.toFixed(6), maintenance_margin: mm.toFixed(6),
    cross: { balance: bal.toFixed(6), initial_margin: im.toFixed(6), maintenance_margin: mm.toFixed(6), available: (bal - im).toFixed(6) },
    isolated: [],
  };
}

function positionJson(a: Acct, symbol: string) {
  const v = posView(a, symbol);
  const p = v.p;
  const { equity } = accountView(a);
  // crude cross liq estimate: price where equity hits maintenance on this position alone
  let liq: string | null = null;
  if (v.size) {
    const buffer = (Number(equity) - v.mm) / v.size;
    const lp = v.mk - buffer;
    liq = lp > 0 ? fmt(v.m, lp) : null;
  }
  return {
    symbol, size: String(+v.size.toFixed(8)), entry_price: p && v.size ? fmt(v.m, p.entry) : null,
    mark_price: fmt(v.m, v.mk), unrealized_pnl: v.upnl.toFixed(6), realized_pnl: (p?.realized ?? 0).toFixed(6),
    cum_funding: "0", initial_margin: v.im.toFixed(6), maintenance_margin: v.mm.toFixed(6), margin_mode: "cross",
    isolated_margin: null, leverage: String(LEVERAGE), liquidation_price: liq,
    opened_at: v.size ? p!.opened : null, updated_at: v.size ? p!.updated : null,
  };
}

// ---------- Execution ----------
function applyFill(a: Acct, o: Order, price: number, size: number) {
  const m = markets.get(o.symbol!)!;
  const signed = o.side === "buy" ? size : -size;
  const p = a.positions.get(o.symbol!) ?? { size: 0, entry: 0, realized: 0, opened: Date.now(), updated: Date.now() };
  if (p.size === 0) p.opened = Date.now();
  if (p.size === 0 || Math.sign(p.size) === Math.sign(signed)) {
    p.entry = (p.entry * Math.abs(p.size) + price * size) / (Math.abs(p.size) + size);
    p.size += signed;
  } else {
    const closing = Math.min(Math.abs(p.size), size);
    const pnl = (price - p.entry) * closing * Math.sign(p.size);
    p.realized += pnl; a.collateral += pnl;
    const rest = size - closing;
    p.size += signed;
    if (Math.abs(p.size) < 1e-12) p.size = 0;
    if (rest > 1e-12) { p.entry = price; p.opened = Date.now(); }
  }
  p.updated = Date.now();
  a.positions.set(o.symbol!, p);
  o.status = "filled";
  o.fill_price = fmt(m, price);
  if (o.size === null) o.size = String(+size.toFixed(8));
  a.fills.unshift({
    trade_id: randomUUID(), order_id: o.order_id, client_order_id: o.client_order_id, symbol: o.symbol,
    type: "trade", side: o.side, size: String(+size.toFixed(8)), price: o.fill_price, created_at: Date.now(),
  });
  // activate children
  for (const c of a.orders) if (c.parent_order_id === o.order_id && c.status === "queued") c.status = "untriggered";
  // a flat position leaves nothing for TP/SL to reduce
  if (p.size === 0)
    for (const c of a.orders)
      if (c.symbol === o.symbol && c.status === "untriggered" && c.reduce_only) { c.status = "canceled"; c.reason = "no_position_to_reduce"; }
}

function reject(o: Order, reason: string) {
  o.status = "rejected";
  o.reason = reason;
}

function execute(a: Acct, o: Order, refPrice?: number) {
  const m = markets.get(o.symbol!)!;
  const mk = mark(m);
  const pos = a.positions.get(o.symbol!)?.size ?? 0;
  let size = o.size === null ? Math.abs(pos) : Number(o.size);
  if (o.reduce_only) {
    const reducing = (o.side === "sell" && pos > 0) || (o.side === "buy" && pos < 0);
    if (!reducing) return reject(o, "reduce_only_violated");
    size = Math.min(size, Math.abs(pos));
  }
  // OLP quote: mark ± 3 bps spread for market orders, exact limit price for limits.
  const quote = refPrice ?? mk * (1 + (o.side === "buy" ? OLP_HALF_SPREAD : -OLP_HALF_SPREAD));
  if (o.max_slippage !== null && Math.abs(quote - mk) / mk > Number(o.max_slippage)) return reject(o, "slippage_exceeded");
  if (!o.reduce_only) {
    const v = accountView(a);
    if (Number(v.cross.available) < (size * quote) / LEVERAGE) return reject(o, "insufficient_margin");
  }
  applyFill(a, o, quote, size);
}

function processTriggers(a: Acct) {
  for (const o of a.orders) {
    if (!o.symbol) continue;
    const m = markets.get(o.symbol)!;
    const mk = mark(m);
    if (o.status === "open" && o.type === "limit") {
      const px = Number(o.price);
      // All-or-nothing: fills when OLP's quote crosses the limit, at the quote (limit or better).
      const ask = mk * (1 + OLP_HALF_SPREAD), bid = mk * (1 - OLP_HALF_SPREAD);
      if (o.side === "buy" && ask <= px) execute(a, o, ask);
      else if (o.side === "sell" && bid >= px) execute(a, o, bid);
    } else if (o.status === "untriggered") {
      const tp = Number(o.trigger_price);
      // A sell TP triggers above, a sell SL below (and mirrored for buys).
      const above = (o.type === "take_profit") === (o.side === "sell");
      if (above ? mk >= tp : mk <= tp) {
        o.status = "queued";
        execute(a, o);
        // one-cancels-other for attached brackets
        if (o.parent_order_id && (o.status as string) === "filled")
          for (const s of a.orders)
            if (s !== o && s.parent_order_id === o.parent_order_id && s.status === "untriggered") {
              s.status = "canceled"; s.reason = "system_canceled";
            }
      }
    }
  }
}

// ---------- HTTP ----------
type Err = { status: number; code: string; msg: string; extra?: Record<string, unknown> };
const E = (status: number, code: string, msg: string, extra?: Record<string, unknown>): Err => ({ status, code, msg, extra });

function weightOf(method: string, path: string) {
  if (method === "GET" && (path === "/v1/tickers" || path === "/v1/instruments")) return 2;
  if (method === "GET") return 1;
  return path === "/v1/orders/batch" ? 5 : 2;
}

function send(res: ServerResponse, status: number, body: unknown, a?: Acct, reqId = randomUUID()) {
  const h: Record<string, string> = { "content-type": "application/json", "x-request-id": reqId };
  if (a) {
    const now = Date.now();
    const used = a.spent.reduce((s, x) => s + x.w, 0);
    h["x-ratelimit-limit"] = String(WEIGHT_LIMIT);
    h["x-ratelimit-remaining"] = String(Math.max(0, WEIGHT_LIMIT - used));
    const last = a.spent.at(-1)?.t ?? now;
    h["x-ratelimit-reset"] = String(Math.ceil((last + 60_000) / 1000));
  }
  res.writeHead(status, h).end(JSON.stringify(body));
}

function newOrder(body: any, parent?: Order, kind?: "take_profit" | "stop_loss"): Order {
  const isChild = !!parent;
  return {
    order_id: randomUUID(),
    client_order_id: isChild ? null : body.client_order_id ?? null,
    parent_order_id: parent?.order_id ?? null,
    symbol: (parent?.symbol ?? body.symbol).toUpperCase(),
    side: isChild ? (parent!.side === "buy" ? "sell" : "buy") : body.side,
    size: isChild ? null : body.size,
    reduce_only: isChild || kind ? true : !!body.reduce_only,
    max_slippage: body.max_slippage ?? null,
    created_at: Date.now(),
    type: kind ?? body.type,
    status: isChild ? "queued" : body.type === "market" ? "queued" : body.type === "limit" ? "open" : "untriggered",
    ...(body.type === "limit" && !isChild ? { price: body.price, trigger_by: body.trigger_by } : {}),
    ...(isChild || body.type === "take_profit" || body.type === "stop_loss"
      ? { trigger_price: body.trigger_price, trigger_by: body.trigger_by ?? "mark" } : {}),
    reason: null,
  };
}

function placeOrder(a: Acct, b: any) {
  const fields: { field: string; message: string }[] = [];
  if (!["market", "limit", "take_profit", "stop_loss"].includes(b?.type)) fields.push({ field: "type", message: "invalid" });
  if (!["buy", "sell"].includes(b?.side)) fields.push({ field: "side", message: "invalid" });
  if (typeof b?.size !== "string" || !/^\d+(\.\d{1,12})?$/.test(b.size)) fields.push({ field: "size", message: "decimal string required" });
  if (!("max_slippage" in (b ?? {}))) fields.push({ field: "max_slippage", message: "required" });
  if (b?.type === "market" && b.max_slippage === null) fields.push({ field: "max_slippage", message: "required for market" });
  if (b?.type === "limit" && typeof b.price !== "string") fields.push({ field: "price", message: "required" });
  if (b?.type !== "market" && !b?.trigger_by) fields.push({ field: "trigger_by", message: "required" });
  if (fields.length) throw E(422, "validation_failed", "request validation failed", { error_fields: fields });
  const m = markets.get(String(b.symbol).toUpperCase());
  if (!m) throw E(422, "unknown_symbol", `unknown symbol ${b.symbol}`);
  if (b.client_order_id) {
    if (!/^[A-Za-z0-9_:-]{1,36}$/.test(b.client_order_id)) throw E(422, "validation_failed", "bad client_order_id", { error_fields: [{ field: "client_order_id", message: "invalid" }] });
    const dup = a.orders.find((o) => o.client_order_id === b.client_order_id);
    if (dup) throw E(409, "duplicate_client_order_id", "client_order_id already used", { order: dup });
  }
  const step = Number(m.inst.size_step);
  const units = Number(b.size) / step;
  if (Math.abs(units - Math.round(units)) > 1e-9) throw E(422, "invalid_size_increment", `size must be a multiple of ${m.inst.size_step}`);
  for (const px of [b.price, b.trigger_price, b.take_profit?.trigger_price, b.stop_loss?.trigger_price].filter(Boolean))
    if (Number(roundPrice(px, m.inst.price_precision)) !== Number(px))
      throw E(422, "invalid_price_increment", `price ${px} too precise`);
  const ref = b.type === "limit" ? Number(b.price) : mark(m);
  if (Number(b.size) * ref < Number(m.inst.min_notional)) throw E(422, "below_min_notional", `notional below ${m.inst.min_notional}`);
  if (b.type === "take_profit" || b.type === "stop_loss") {
    const pos = a.positions.get(m.inst.symbol)?.size ?? 0;
    if (!pos) throw E(422, "no_position_to_reduce", "no position to reduce");
  }
  const parent = newOrder(b);
  const placed = [parent];
  if (b.take_profit) placed.push(newOrder(b.take_profit, parent, "take_profit"));
  if (b.stop_loss) placed.push(newOrder(b.stop_loss, parent, "stop_loss"));
  a.orders.unshift(...placed.slice().reverse());
  if (parent.type === "market") setTimeout(() => execute(a, parent), 250);
  else if (parent.type === "limit") setTimeout(() => processTriggers(a), 50);
  return placed;
}

function cancel(a: Acct, o: Order) {
  if (o.status === "open" || o.status === "untriggered") {
    o.status = "canceled"; o.reason = "user_canceled";
    for (const c of a.orders) if (c.parent_order_id === o.order_id && (c.status === "queued" || c.status === "untriggered")) {
      c.status = "canceled"; c.reason = "parent_canceled";
    }
  } else if (o.status === "queued") throw E(409, "order_queued", "order is executing", { order: o });
  else if (o.status === "filled") throw E(409, "order_filled", "order already filled", { order: o });
  else if (o.status === "rejected") throw E(409, "order_rejected", "order was rejected", { order: o });
  return o;
}

function paginate<T extends { created_at: number }>(rows: T[], q: URLSearchParams) {
  const limit = Math.min(500, Math.max(1, Number(q.get("limit") ?? 100)));
  const start = q.get("start") ? Number(q.get("start")) : -Infinity;
  const end = q.get("end") ? Number(q.get("end")) : Infinity;
  const sym = q.get("symbol")?.toUpperCase();
  const all = rows.filter((r: any) => r.created_at >= start && r.created_at <= end && (!sym || r.symbol === sym));
  const off = q.get("cursor") ? Number(Buffer.from(q.get("cursor")!, "base64url").toString()) : 0;
  const page = all.slice(off, off + limit);
  const out: any = { results: page };
  if (off + limit < all.length) out.next = Buffer.from(String(off + limit)).toString("base64url");
  if (off > 0) out.prev = Buffer.from(String(Math.max(0, off - limit))).toString("base64url");
  return out;
}

function route(a: Acct, method: string, url: URL, body: any): [number, unknown] {
  const p = url.pathname, q = url.searchParams;
  const sym = (s: string) => {
    const m = markets.get(decodeURIComponent(s).toUpperCase());
    if (!m) throw E(422, "unknown_symbol", `unknown symbol ${s}`);
    return m;
  };
  const tickerOf = (m: Mkt): Ticker => ({ symbol: m.inst.symbol, mark_price: fmt(m, mark(m)), index_price: fmt(m, m.index), updated_at: m.t });
  let r: RegExpMatchArray | null;
  if (method === "GET") {
    if (p === "/v1/status") return [200, { status: "ok" }];
    if (p === "/v1/instruments") return [200, { results: [...markets.values()].map((m) => m.inst) }];
    if ((r = p.match(/^\/v1\/instruments\/([^/]+)$/))) return [200, sym(r[1]).inst];
    if (p === "/v1/tickers") return [200, { results: [...markets.values()].map(tickerOf) }];
    if ((r = p.match(/^\/v1\/tickers\/([^/]+)$/))) return [200, tickerOf(sym(r[1]))];
    if (p === "/v1/account") return [200, accountView(a)];
    if (p === "/v1/positions")
      return [200, { results: [...a.positions.entries()].filter(([, x]) => x.size !== 0).map(([s]) => positionJson(a, s)) }];
    if ((r = p.match(/^\/v1\/positions\/([^/]+)$/))) return [200, positionJson(a, sym(r[1]).inst.symbol)];
    if (p === "/v1/orders") {
      if (q.get("client_order_id")) return [200, { results: a.orders.filter((o) => o.client_order_id === q.get("client_order_id")) }];
      const s = q.get("symbol")?.toUpperCase();
      return [200, { results: a.orders.filter((o) => ["queued", "open", "untriggered"].includes(o.status) && (!s || o.symbol === s)) }];
    }
    if (p === "/v1/orders/history") return [200, paginate(a.orders, q)];
    if ((r = p.match(/^\/v1\/orders\/([^/]+)$/))) {
      const o = a.orders.find((x) => x.order_id === r![1]);
      if (!o) throw E(404, "order_not_found", "order not found");
      return [200, o];
    }
    if (p === "/v1/fills") return [200, paginate(a.fills, q)];
  }
  if (method === "POST" && p === "/v1/orders") return [202, { placed: placeOrder(a, body) }];
  if (method === "DELETE" && p === "/v1/orders") {
    const id = q.get("order_id"), cid = q.get("client_order_id");
    if (!!id === !!cid) throw E(400, "invalid_query", "supply exactly one of order_id or client_order_id");
    const o = a.orders.find((x) => (id ? x.order_id === id : x.client_order_id === cid));
    if (!o) throw E(404, "order_not_found", "order not found");
    if (o.status === "canceled") return [200, o];
    return [200, cancel(a, o)];
  }
  if (method === "DELETE" && p === "/v1/orders/batch") {
    const all = q.get("all") === "true", s = q.get("symbol")?.toUpperCase();
    if (all === !!s) throw E(400, "invalid_query", "supply exactly one of all=true or symbol");
    const canceled = a.orders.filter((o) => (o.status === "open" || o.status === "untriggered") && (all || o.symbol === s));
    canceled.forEach((o) => cancel(a, o));
    return [200, { canceled }];
  }
  if (["GET", "POST", "DELETE"].includes(method)) throw E(404, "not_found", "no such route");
  throw E(405, "method_not_allowed", "method not allowed");
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url ?? "/", "http://mock");
  const method = (req.method ?? "GET").toUpperCase();
  const reqId = randomUUID();
  const fail = (e: Err, a?: Acct) =>
    send(res, e.status, { error_code: e.code, error_message: e.msg, request_id: reqId, ...(e.extra ?? {}) }, a, reqId);

  const key = req.headers["x-variational-key"] as string | undefined;
  const ts = req.headers["x-request-timestamp-ms"] as string | undefined;
  const sig = req.headers["x-variational-signature"] as string | undefined;
  if (!key || !ts || !sig) return fail(E(401, "missing_credentials", "x-variational-key, x-request-timestamp-ms, and x-variational-signature are all required"));
  if (!/^0x[0-9a-fA-F]{64}$/.test(key) || !/^\d+$/.test(ts) || !/^0x[0-9a-fA-F]{128}$/.test(sig))
    return fail(E(401, "malformed_credentials", "malformed credentials"));
  const now = Date.now(), skew = Number(ts) - now;
  if (skew < -5000 || skew > 1000) return fail(E(401, "timestamp_out_of_window", "timestamp out of window", { server_time_ms: now }));
  const canonical = canonicalString({ environment: ENV, key, timestampMs: ts, method, pathAndQuery: req.url ?? "/", body: raw });
  if (!verifySignature(key, canonical, sig)) return fail(E(401, "invalid_signature", "signature does not match"));
  const a = acct(key);

  a.spent = a.spent.filter((x) => now - x.t < 60_000);
  const w = weightOf(method, url.pathname);
  const used = a.spent.reduce((s, x) => s + x.w, 0);
  if (a.bannedUntil > now) return fail(E(429, "banned", "temporarily banned for repeated rate-limit violations", { retry_after_ms: a.bannedUntil - now }), a);
  if (used + w > WEIGHT_LIMIT) {
    // Omni's strike system: warnings for strikes 1-4, then escalating bans.
    a.strikes++;
    const ban = [0, 0, 0, 0, 0, 15, 30, 60, 300, 3600, 10800][a.strikes] ?? 86400;
    if (ban) a.bannedUntil = now + ban * 1000;
    console.error(`[mock] 429 strike ${a.strikes} for ${key.slice(0, 10)}…${ban ? ` → ${ban}s ban` : ""}`);
    const retry = a.spent[0].t + 60_000 - now;
    return fail(E(429, "rate_limited", "rate limit exceeded", { retry_after_ms: retry }), a);
  }
  a.spent.push({ t: now, w });
  if (method !== "GET") {
    if (a.sigs.has(sig)) return fail(E(401, "replayed_request", "signature already used"), a);
    a.sigs.add(sig);
  }

  let body: any;
  if (raw.length) {
    if (!String(req.headers["content-type"] ?? "").includes("application/json")) return fail(E(400, "invalid_body", "content-type must be application/json"), a);
    try { body = JSON.parse(raw.toString()); } catch { return fail(E(400, "invalid_body", "invalid JSON"), a); }
  }
  try {
    const [status, out] = route(a, method, url, body);
    send(res, status, out, a, reqId);
  } catch (e: any) {
    if (e && typeof e.code === "string" && typeof e.status === "number") return fail(e, a);
    console.error(e);
    fail(E(500, "internal_error", "internal error"), a);
  }
});

export function start(port = PORT) {
  return new Promise<typeof server>((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("mock/server.js")) {
  start().then(() =>
    console.error(`omni mock exchange on http://localhost:${PORT} (env "${ENV}", ${WEIGHT_LIMIT} weight/min). Any key works; each key gets ${START_COLLATERAL} USDC.`),
  );
}
