#!/usr/bin/env node
// Omni market maker: quotes a bid and an ask around the mark, skews them by inventory, widens with
// volatility, and stays within 60 weight/min by only replacing quotes that moved.
//
//   omni-mm --symbol HYPE                       # dry run: real prices, paper fills, no orders sent
//   omni-mm --symbol HYPE --live                # trades
//
// See README "Market maker" for every flag. Ctrl-C cancels this run's quotes (and, with
// --flatten-on-exit, closes the position) before exiting.
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { OmniClient, OmniError, checkOrder, dec, roundPrice, type Instrument, type Order } from "../../sdk/index.js";
import { DEFAULTS, VolEstimator, diffQuotes, planQuotes, type LiveQuote, type MMParams, type Quote } from "./strategy.js";

const { values: a } = parseArgs({
  options: {
    symbol: { type: "string", default: "BTC" },
    "order-usd": { type: "string", default: String(DEFAULTS.orderUsd) },
    "max-pos-usd": { type: "string", default: String(DEFAULTS.maxPosUsd) },
    "min-spread-bps": { type: "string", default: String(DEFAULTS.minHalfSpreadBps) },
    "vol-mult": { type: "string", default: String(DEFAULTS.volMult) },
    horizon: { type: "string", default: String(DEFAULTS.horizonSec) },
    "skew-bps": { type: "string", default: String(DEFAULTS.skewBps) },
    levels: { type: "string", default: String(DEFAULTS.levels) },
    "level-step-bps": { type: "string", default: String(DEFAULTS.levelStepBps) },
    "requote-bps": { type: "string", default: String(DEFAULTS.requoteBps) },
    poll: { type: "string", default: "4" },
    cooldown: { type: "string", default: "20" },
    "max-loss-usd": { type: "string", default: "50" },
    "max-move-bps": { type: "string", default: "150" },
    "stale-sec": { type: "string", default: "20" },
    "warmup": { type: "string", default: "5" },
    "budget-share": { type: "string", default: "0.65" },
    "trigger-by": { type: "string", default: "quote" },
    live: { type: "boolean", default: false },
    "flatten-on-exit": { type: "boolean", default: false },
    "cancel-stale": { type: "boolean", default: true },
    log: { type: "string" },
  },
});

const symbol = a.symbol!.toUpperCase().includes("-") ? a.symbol!.toUpperCase() : `${a.symbol!.toUpperCase()}-PERP`;
const P: MMParams = {
  orderUsd: +a["order-usd"]!, maxPosUsd: +a["max-pos-usd"]!, minHalfSpreadBps: +a["min-spread-bps"]!,
  volMult: +a["vol-mult"]!, horizonSec: +a.horizon!, skewBps: +a["skew-bps"]!, levels: +a.levels!,
  levelStepBps: +a["level-step-bps"]!, requoteBps: +a["requote-bps"]!,
};
const POLL = +a.poll! * 1000, COOLDOWN = +a.cooldown! * 1000, MAX_LOSS = +a["max-loss-usd"]!;
const MAX_MOVE = +a["max-move-bps"]!, STALE = +a["stale-sec"]! * 1000, WARMUP = +a.warmup!;
const SHARE = +a["budget-share"]!, LIVE = a.live!, TRIGGER = a["trigger-by"] === "mark" ? "mark" : "quote";
const RUN = randomBytes(3).toString("hex");
const PLACE_FLOOR = 15; // weight kept free for cancels before any new quote is sent
const TAG = `mm:${RUN}:`;
const LOG = a.log ?? `mm-${symbol}-${RUN}.jsonl`;

const client = new OmniClient({ reserve: 4 });
if (LIVE && client.environment === "prod" && process.env.OMNI_ALLOW_PROD !== "1") {
  console.error("Refusing to run live on mainnet without OMNI_ALLOW_PROD=1");
  process.exit(1);
}

// ---------- state ----------
const vol = new VolEstimator(120);
type Live = LiveQuote & { cid: string; size: number };
const live = new Map<string, Live>(); // order_id -> quote
const seenFills = new Set<string>();
const cooldownUntil = { buy: 0, sell: 0 };
let instCache: { at: number; inst: Instrument } | null = null;
let pos = 0; // base units, from the exchange (live) or paper fills (dry)
let cash = 0; // USD from this run's fills; pnl = cash + pos×fair − startValue
let startPos = 0;
let startEquity: number | null = null, equity: number | null = null;
let stats = { cycles: 0, buys: 0, sells: 0, volUsd: 0, placed: 0, canceled: 0, pulls: 0, errors: 0 };
let pulled: string | null = null;
let intervalMs = POLL;
let seq = 0;
let stopping = false;
const t0 = Date.now();

const ts = () => new Date().toISOString().slice(11, 19);
const say = (m: string) => console.log(`${ts()} ${LIVE ? "" : "[dry] "}${m}`);
const ev = (type: string, data: Record<string, unknown> = {}) => {
  try { appendFileSync(LOG, JSON.stringify({ t: Date.now(), run: RUN, type, ...data }) + "\n"); } catch { /* ignore */ }
};
const sideSign = (s: "buy" | "sell") => (s === "buy" ? 1 : -1);
// Session PnL from this run's fills only (a position you already held isn't the bot's doing).
const pnlNow = (fair: number) => cash + (pos - startPos) * fair;

async function instrument() {
  if (!instCache || Date.now() - instCache.at > 60_000) instCache = { at: Date.now(), inst: await client.instrument(symbol) };
  return instCache.inst;
}

function recordFill(side: "buy" | "sell", size: number, price: number, cid: string | null, paper = false) {
  pos += sideSign(side) * size;
  cash -= sideSign(side) * size * price;
  stats[side === "buy" ? "buys" : "sells"]++;
  stats.volUsd += size * price;
  cooldownUntil[side] = Date.now() + COOLDOWN;
  say(`${paper ? "PAPER " : ""}FILL ${side} ${size} @ ${price}  → pos ${+pos.toFixed(8)}`);
  ev("fill", { side, size, price, cid, paper, pos });
}

async function cancelQuote(q: Live, why: string) {
  live.delete(q.order_id);
  stats.canceled++;
  ev("cancel", { side: q.side, level: q.level, price: q.price, why });
  if (!LIVE) return;
  try {
    await client.cancelOrder({ order_id: q.order_id });
  } catch (e) {
    // order_filled / order_queued: it executed; the fill shows up next cycle.
    if (!(e instanceof OmniError && ["order_filled", "order_queued", "order_rejected", "order_not_found"].includes(e.code))) throw e;
  }
}

async function pullAll(why: string) {
  if (pulled !== why) { say(`pulling quotes: ${why}`); ev("pull", { why }); stats.pulls++; }
  pulled = why;
  for (const q of [...live.values()]) await cancelQuote(q, why);
}

async function placeQuote(inst: Instrument, q: Quote, fair: number) {
  const px = roundPrice(dec(q.price), inst.price_precision, q.side === "buy" ? "down" : "up");
  const chk = checkOrder(inst, { side: q.side, size: dec(q.usd / Number(px)), price: px, refPrice: String(fair), reduceOnly: q.reduceOnly });
  if (chk.problems.length) { ev("skip", { side: q.side, problems: chk.problems }); return; }
  const cid = `${TAG}${q.side[0]}${q.level}:${(++seq).toString(36)}`;
  let order_id = `paper-${cid}`;
  if (LIVE) {
    const [o] = await client.placeOrder({
      type: "limit", symbol, side: q.side, size: chk.size, price: chk.price!, trigger_by: TRIGGER,
      max_slippage: null, reduce_only: q.reduceOnly, client_order_id: cid,
    });
    if (o.status !== "open" && o.status !== "queued") { ev("place_result", { cid, status: o.status, reason: o.reason }); return; }
    order_id = o.order_id;
  }
  live.set(order_id, { order_id, cid, side: q.side, level: q.level, price: Number(chk.price), size: Number(chk.size) });
  stats.placed++;
  ev("place", { side: q.side, level: q.level, price: chk.price, size: chk.size, reduceOnly: q.reduceOnly });
}

async function syncFills(open: Order[]) {
  // A quote we think is live but isn't on the book anymore either filled, was rejected, or was cancelled.
  const openIds = new Set(open.map((o) => o.order_id));
  const vanished = [...live.values()].filter((q) => !openIds.has(q.order_id));
  if (!vanished.length) return false;
  const fills = (await client.fills({ symbol, limit: 25 })).results.filter((f) => f.client_order_id?.startsWith(TAG)).reverse();
  for (const f of fills) {
    if (seenFills.has(f.trade_id)) continue;
    seenFills.add(f.trade_id);
    recordFill(f.side, Number(f.size), Number(f.price), f.client_order_id);
  }
  for (const q of vanished) live.delete(q.order_id);
  return true;
}

function paperFills(fair: number) {
  // Approximation for dry runs: a quote fills when the mark trades through it.
  for (const q of [...live.values()]) {
    if ((q.side === "buy" && fair <= q.price) || (q.side === "sell" && fair >= q.price)) {
      live.delete(q.order_id);
      recordFill(q.side, q.size, q.price, q.cid, true);
    }
  }
}

async function cycle() {
  const inst = await instrument();
  const t = await client.ticker(symbol);
  const fair = Number(t.mark_price);
  if (!t.mark_price || !(fair > 0)) return pullAll("no mark price");
  vol.update(fair, t.updated_at ?? Date.now());

  let needPosition = stats.cycles % 15 === 0;
  if (LIVE) {
    const open = (await client.openOrders({ symbol })).filter((o) => o.client_order_id?.startsWith(TAG));
    if (await syncFills(open)) needPosition = true;
    // Adopt anything on the book we don't know about (e.g. after a timeout during placement).
    for (const o of open) if (!live.has(o.order_id) && o.price)
      live.set(o.order_id, { order_id: o.order_id, cid: o.client_order_id!, side: o.side, level: Number(o.client_order_id!.split(":")[2]?.slice(1) ?? 0), price: Number(o.price), size: Number(o.size) });
    if (needPosition) pos = Number((await client.position(symbol)).size);
    if (stats.cycles % 15 === 0) {
      equity = Number((await client.account()).equity);
      if (startEquity === null) startEquity = equity;
    }
  } else paperFills(fair);

  const posUsd = pos * fair;
  const pnl = pnlNow(fair);
  const lossNow = LIVE && startEquity !== null && equity !== null ? equity - startEquity : pnl;
  const move = vol.moveBps(60);

  // ---------- circuit breakers ----------
  if (lossNow < -MAX_LOSS) {
    await pullAll(`loss limit hit (${lossNow.toFixed(2)} USD)`);
    say("stopping: loss limit");
    return shutdown(1);
  }
  if (t.updated_at && Date.now() - t.updated_at > STALE) return pullAll(`stale price (${((Date.now() - t.updated_at) / 1000).toFixed(0)}s old)`);
  if (inst.status && inst.status !== "open") return pullAll(`market ${inst.status}`);
  if (move !== null && move > MAX_MOVE) return pullAll(`volatility ${move.toFixed(0)}bp/min > ${MAX_MOVE}`);
  if (vol.samples < WARMUP) {
    say(`warming up volatility (${vol.samples}/${WARMUP}) mark ${fair}`);
    return;
  }
  if (pulled) { say(`resuming (${pulled} cleared)`); ev("resume", { was: pulled }); pulled = null; }

  // ---------- quote ----------
  const now = Date.now();
  const plan = planQuotes(P, {
    fair, sigma: vol.sigma(), posUsd,
    paused: { buy: now < cooldownUntil.buy, sell: now < cooldownUntil.sell },
  });
  if (inst.close_only) plan.quotes = plan.quotes.filter((q) => (q.side === "sell" ? pos > 0 : pos < 0)).map((q) => ({ ...q, reduceOnly: true }));
  const d = diffQuotes(P, [...live.values()], plan.quotes, fair);

  // Cancels first: a stale quote is the dangerous one.
  for (const q of d.cancel) { if (stopping) return; await cancelQuote(q as Live, "requote"); }
  for (const q of d.place) {
    if (stopping) return;
    const est = client.estimatedRemaining();
    // New quotes need headroom; cancels never wait on this, because a stale quote is the risk.
    if (LIVE && est !== null && est < client.expectedCost("POST", "/v1/orders") + PLACE_FLOOR) { ev("defer", { est }); break; }
    try { await placeQuote(inst, q, fair); }
    catch (e) { say(`place ${q.side} failed: ${e instanceof OmniError ? `${e.code} ${e.body.error_message}` : (e as Error).message}`); ev("error", { op: "place", msg: String(e) }); }
  }

  const bid = [...live.values()].filter((q) => q.side === "buy").sort((x, y) => y.price - x.price)[0];
  const ask = [...live.values()].filter((q) => q.side === "sell").sort((x, y) => x.price - y.price)[0];
  const fmtQ = (q?: LiveQuote) => (q ? `${q.price} (${(((q.price - fair) / fair) * 1e4).toFixed(1)}bp)` : "—");
  say(`mark ${fair} | bid ${fmtQ(bid)} ask ${fmtQ(ask)} | half-spread ${plan.halfSpreadBps.toFixed(1)}bp σ1m ${move?.toFixed(0)}bp | ` +
    `pos ${+pos.toFixed(6)} (${posUsd.toFixed(0)}$, inv ${(plan.inventory * 100).toFixed(0)}%) | pnl ${pnl.toFixed(2)}$ | ` +
    `w ${client.budget.remaining}/${client.budget.limit} every ${(intervalMs / 1000).toFixed(1)}s${client.rateLimitHits ? ` 429s:${client.rateLimitHits}` : ""}`);
  if (stats.cycles % 15 === 0) ev("status", { fair, pos, posUsd, pnl, equity, halfSpreadBps: plan.halfSpreadBps, move, stats, costs: Object.fromEntries(client.costs) });

  // ---------- pacing: feedback on remaining weight ----------
  // Keep at least (1 − budget-share) of the window free: back off fast when below it, relax slowly above.
  const rem = client.estimatedRemaining(), limit = client.budget.limit ?? 60;
  if (LIVE && rem !== null) {
    if (rem < limit * (1 - SHARE) + PLACE_FLOOR / 2) intervalMs = Math.min(30_000, intervalMs * 1.5);
    else if (rem > limit * 0.6) intervalMs = Math.max(POLL, intervalMs / 1.2);
  }
}

let current: Promise<unknown> = Promise.resolve();
async function loop() {
  while (!stopping) {
    current = cycle().then(
      () => { stats.errors = 0; },
      (e) => {
        stats.errors++;
        say(`error: ${e instanceof OmniError ? `${e.code} ${e.body.error_message}` : (e as Error).message}`);
        ev("error", { msg: String(e) });
        if (e instanceof OmniError && e.code === "banned") return shutdown(1);
      },
    );
    await current;
    stats.cycles++;
    if (stats.errors >= 5) {
      await pullAll("5 consecutive errors").catch(() => undefined);
      await new Promise((r) => setTimeout(r, 60_000));
      stats.errors = 0;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = stopping = true;
  await current.catch(() => undefined);
  say("shutting down: cancelling quotes…");
  if (LIVE) {
    const open = (await client.openOrders({ symbol }).catch(() => [] as Order[])).filter((o) => o.client_order_id?.startsWith(TAG));
    for (const o of open) await client.cancelOrder({ order_id: o.order_id }).catch(() => undefined);
    say(`cancelled ${open.length} resting quote(s)`);
    if (a["flatten-on-exit"]) {
      const p = Number((await client.position(symbol)).size);
      if (p) {
        await client.placeOrder({ type: "market", symbol, side: p > 0 ? "sell" : "buy", size: String(Math.abs(p)), max_slippage: "0.01", reduce_only: true })
          .then(() => say(`flattened ${p}`)).catch((e) => say(`flatten failed: ${(e as Error).message}`));
      }
    }
  }
  const mins = (Date.now() - t0) / 60000;
  const fair = (await client.ticker(symbol).catch(() => null))?.mark_price;
  const summary = {
    minutes: +mins.toFixed(1), fills: stats.buys + stats.sells, buys: stats.buys, sells: stats.sells,
    volumeUsd: +stats.volUsd.toFixed(2), pnlUsd: fair ? +pnlNow(Number(fair)).toFixed(2) : null,
    equityChange: startEquity !== null && equity !== null ? +(equity - startEquity).toFixed(2) : null,
    position: +pos.toFixed(8), quotesPlaced: stats.placed, quotesCancelled: stats.canceled, pulls: stats.pulls,
    rateLimitHits: client.rateLimitHits, learnedCosts: Object.fromEntries(client.costs),
  };
  ev("summary", summary);
  console.log(JSON.stringify(summary, null, 2));
  say(`event log: ${LOG}`);
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

// ---------- start ----------
say(`market maker ${symbol} on ${client.environment} · run ${RUN} · ${P.orderUsd}$/quote × ${P.levels} level(s) · ` +
  `min half-spread ${P.minHalfSpreadBps}bp · cap ±${P.maxPosUsd}$ · loss limit ${MAX_LOSS}$${LIVE ? "" : " · DRY RUN (paper fills; --live to trade)"}`);
try {
  const inst = await instrument();
  if (inst.close_only) say(`${symbol} is close-only: will only reduce`);
  if (LIVE) {
    pos = startPos = Number((await client.position(symbol)).size);
    if (a["cancel-stale"]) {
      const stale = (await client.openOrders({ symbol })).filter((o) => o.client_order_id?.startsWith("mm:"));
      for (const o of stale) await client.cancelOrder({ order_id: o.order_id }).catch(() => undefined);
      if (stale.length) say(`cancelled ${stale.length} leftover quote(s) from earlier runs`);
    }
    if (pos) say(`starting with an existing position of ${pos}; it counts toward the inventory cap`);
  }
} catch (e) {
  console.error(`startup failed: ${(e as Error).message}`);
  process.exit(1);
}
ev("start", { symbol, params: P, live: LIVE, env: client.environment });
void loop();
