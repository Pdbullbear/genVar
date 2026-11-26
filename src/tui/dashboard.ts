#!/usr/bin/env node
// Live terminal dashboard for Omni: markets with mark/index basis and sparklines, account,
// positions, orders, fills, a rate-budget gauge, and a command line for trading.
//
// The poller measures how much weight each refresh cycle really costs (from X-RateLimit-Remaining)
// and spaces cycles so the dashboard uses at most ~70% of the 60/min budget, leaving room for orders.
import {
  OmniClient, OmniError, checkOrder, dec, newClientOrderId, roundPrice,
  type Account, type Fill, type Instrument, type Order, type PlaceOrder, type Position, type Ticker,
} from "../sdk/index.js";

const client = new OmniClient();
const TARGET_SHARE = Number(process.env.DASH_BUDGET_SHARE ?? 0.7);

// ---------- state ----------
const S = {
  insts: [] as Instrument[],
  tickers: [] as Ticker[],
  hist: new Map<string, number[]>(),
  first: new Map<string, number>(),
  account: null as Account | null,
  positions: [] as Position[],
  orders: [] as Order[],
  fills: [] as Fill[],
  apiStatus: "?" as string,
  lastRefresh: 0,
  cycleCost: 5,
  intervalMs: 5000,
  log: [] as string[],
  input: "",
  confirm: null as null | { order: PlaceOrder; text: string },
};
const log = (m: string) => {
  S.log.unshift(`${new Date().toLocaleTimeString()}  ${m}`);
  S.log.length = Math.min(S.log.length, 4);
};

// ---------- formatting ----------
const ESC = "\x1b[";
const c = {
  dim: (s: string) => `${ESC}2m${s}${ESC}0m`,
  bold: (s: string) => `${ESC}1m${s}${ESC}0m`,
  green: (s: string) => `${ESC}32m${s}${ESC}0m`,
  red: (s: string) => `${ESC}31m${s}${ESC}0m`,
  yellow: (s: string) => `${ESC}33m${s}${ESC}0m`,
  cyan: (s: string) => `${ESC}36m${s}${ESC}0m`,
  inv: (s: string) => `${ESC}7m${s}${ESC}0m`,
};
const visLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (s: string, n: number, right = false) => {
  const fill = " ".repeat(Math.max(0, n - visLen(s)));
  return right ? fill + s : s + fill;
};
const signed = (v: number, digits = 2, suffix = "") => {
  const s = (v >= 0 ? "+" : "") + v.toFixed(digits) + suffix;
  return v > 0 ? c.green(s) : v < 0 ? c.red(s) : s;
};
const num = (s: string | null | undefined, d = 2) =>
  s == null ? "-" : Number(s).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: Math.min(d, 2) });
const pxFmt = (s: string | null | undefined) => (s == null ? "-" : Number(s) < 1 ? Number(s).toPrecision(5) : num(s, 2));
const BARS = "▁▂▃▄▅▆▇█";
function spark(xs: number[], w = 24) {
  const v = xs.slice(-w);
  if (v.length < 2) return c.dim("·".repeat(w));
  const lo = Math.min(...v), hi = Math.max(...v);
  const out = v.map((x) => BARS[hi === lo ? 3 : Math.round(((x - lo) / (hi - lo)) * 7)]).join("");
  return (v.at(-1)! >= v[0] ? c.green : c.red)(pad(out, w));
}

// ---------- render ----------
function render() {
  const W = process.stdout.columns || 100;
  const L: string[] = [];
  const b = client.budget;
  const used = b.limit && b.remaining !== null ? b.limit - b.remaining : 0;
  const gaugeW = 20;
  const filled = b.limit ? Math.round((used / b.limit) * gaugeW) : 0;
  const gauge = (used / (b.limit ?? 60) > 0.8 ? c.red : used / (b.limit ?? 60) > 0.5 ? c.yellow : c.green)("█".repeat(filled)) + c.dim("░".repeat(gaugeW - filled));
  const env = client.environment === "prod" ? c.red(" MAINNET ") : c.inv(` ${client.environment.toUpperCase()} `);
  L.push(`${c.bold(" VARIATIONAL OMNI ")}${env}  api:${S.apiStatus === "ok" ? c.green("ok") : c.yellow(S.apiStatus)}  key ${c.dim(client.publicKey.slice(0, 10) + "…")}  ` +
    `weight ${gauge} ${b.remaining ?? "?"}/${b.limit ?? "?"}  ${c.dim(`cycle≈${S.cycleCost}w every ${(S.intervalMs / 1000).toFixed(1)}s`)}`);
  L.push(c.dim("─".repeat(W)));

  // markets
  L.push(c.bold(pad("MARKET", 11) + pad("MARK", 13, true) + pad("INDEX", 13, true) + pad("BASIS", 10, true) + pad("SESSION", 10, true) + "  " + "TREND"));
  for (const t of S.tickers) {
    const m = Number(t.mark_price), i = Number(t.index_price);
    const basis = t.mark_price && t.index_price ? ((m - i) / i) * 1e4 : NaN;
    const f = S.first.get(t.symbol);
    const chg = f ? ((m - f) / f) * 100 : 0;
    const inst = S.insts.find((x) => x.symbol === t.symbol);
    const st = inst?.status && inst.status !== "open" ? c.yellow(` ${inst.status}`) : inst?.close_only ? c.yellow(" close-only") : "";
    L.push(pad(t.symbol, 11) + pad(pxFmt(t.mark_price), 13, true) + pad(c.dim(pxFmt(t.index_price)), 13, true) +
      pad(Number.isFinite(basis) ? signed(basis, 1, "bp") : "-", 10, true) + pad(signed(chg, 2, "%"), 10, true) + "  " + spark(S.hist.get(t.symbol) ?? []) + st);
  }
  L.push("");

  // account
  const a = S.account;
  if (a) {
    const eq = Number(a.equity), mm = Number(a.maintenance_margin);
    const health = mm > 0 ? eq / mm : Infinity;
    L.push(c.bold("ACCOUNT ") + `equity ${c.bold(num(a.equity))}  uPnL ${signed(Number(a.unrealized_pnl))}  available ${num(a.cross.available)}  ` +
      `IM ${num(a.initial_margin)}  MM ${num(a.maintenance_margin)}  health ${health === Infinity ? c.green("∞") : (health < 1.5 ? c.red : health < 3 ? c.yellow : c.green)(health.toFixed(2) + "x")}`);
  }
  L.push("");
  L.push(c.bold(pad("POSITION", 11) + pad("SIZE", 12, true) + pad("ENTRY", 12, true) + pad("MARK", 12, true) + pad("uPnL", 12, true) + pad("LIQ", 12, true) + pad("LEV", 6, true)));
  if (!S.positions.length) L.push(c.dim("  no open positions"));
  for (const p of S.positions) {
    const sz = Number(p.size);
    L.push(pad(p.symbol, 11) + pad((sz > 0 ? c.green : c.red)(p.size), 12, true) + pad(pxFmt(p.entry_price), 12, true) + pad(pxFmt(p.mark_price), 12, true) +
      pad(signed(Number(p.unrealized_pnl)), 12, true) + pad(c.yellow(pxFmt(p.liquidation_price)), 12, true) + pad((p.leverage ?? "-") + "x", 6, true));
  }
  L.push("");
  L.push(c.bold(pad("ORDER", 11) + pad("TYPE", 13) + pad("SIDE", 6) + pad("SIZE", 11, true) + pad("PRICE", 12, true) + "  " + pad("STATUS", 12) + "ID"));
  if (!S.orders.length) L.push(c.dim("  no pending orders"));
  for (const o of S.orders.slice(0, 8)) {
    L.push(pad(o.symbol ?? "?", 11) + pad(o.type + (o.parent_order_id ? " ↳" : ""), 13) + pad(o.side === "buy" ? c.green("buy") : c.red("sell"), 6) +
      pad(o.size ?? "pos", 11, true) + pad(pxFmt(o.price ?? o.trigger_price), 12, true) + "  " + pad(o.status, 12) + c.dim(o.order_id.slice(0, 8)));
  }
  L.push("");
  L.push(c.bold("RECENT FILLS"));
  if (!S.fills.length) L.push(c.dim("  none yet"));
  for (const f of S.fills.slice(0, 4))
    L.push(`  ${c.dim(new Date(f.created_at).toLocaleTimeString())} ${pad(f.symbol ?? "?", 10)} ${f.side === "buy" ? c.green("buy ") : c.red("sell")} ${f.size} @ ${pxFmt(f.price)} ${f.type !== "trade" ? c.yellow(f.type) : ""}`);
  L.push(c.dim("─".repeat(W)));
  for (const l of S.log) L.push(c.dim(l));
  L.push(c.dim("buy|sell SYM SIZE|$USD [@PRICE] [tp X|X%] [sl X|X%]   close SYM   cancel ID|SYM|all   q quit"));
  L.push(S.confirm ? c.yellow(`${S.confirm.text}  send? [y/N] `) : `${c.cyan("›")} ${S.input}${c.inv(" ")}`);

  process.stdout.write(`${ESC}H${L.map((l) => l + `${ESC}K`).join("\n")}${ESC}J`);
}

// ---------- polling ----------
let cycleN = 0;
async function refresh() {
  const before = client.budget.remaining;
  try {
    if (!S.insts.length || cycleN % 30 === 0) {
      S.insts = await client.instruments();
      S.apiStatus = (await client.status()).status;
    }
    const [tickers, account, positions, orders] = await Promise.all([client.tickers(), client.account(), client.positions(), client.openOrders()]);
    S.tickers = tickers; S.account = account; S.positions = positions.filter((p) => Number(p.size) !== 0); S.orders = orders;
    if (cycleN % 3 === 0) S.fills = (await client.fills({ limit: 5 })).results;
    for (const t of tickers) {
      if (!t.mark_price) continue;
      const h = S.hist.get(t.symbol) ?? [];
      h.push(Number(t.mark_price));
      if (h.length > 120) h.shift();
      S.hist.set(t.symbol, h);
      if (!S.first.has(t.symbol)) S.first.set(t.symbol, Number(t.mark_price));
    }
    S.lastRefresh = Date.now();
  } catch (e) {
    log(c.red(`refresh: ${(e as Error).message}`));
  }
  const after = client.budget.remaining;
  if (before !== null && after !== null && cycleN > 0 && cycleN % 30 !== 0 && before - after > 0)
    S.cycleCost = Math.round(0.7 * S.cycleCost + 0.3 * (before - after)); // EWMA of measured weight
  const limit = client.budget.limit ?? 60;
  S.intervalMs = Math.max(2000, ((S.cycleCost * 60) / (limit * TARGET_SHARE)) * 1000);
  if (after !== null && after < limit * 0.2) S.intervalMs *= 2; // back off when low
  cycleN++;
  render();
  setTimeout(refresh, S.intervalMs);
}

// ---------- commands ----------
function sym(s: string) {
  const u = s.toUpperCase();
  return u.includes("-") ? u : `${u}-PERP`;
}

function parseOrder(tokens: string[]): { order: PlaceOrder; text: string } {
  const [sideRaw, symRaw, sizeRaw, ...rest] = tokens;
  const side = sideRaw === "buy" || sideRaw === "long" ? "buy" : "sell";
  if (!symRaw || !sizeRaw) throw new Error("usage: buy BTC 0.01 [@95000] [tp 2%] [sl 1%]");
  const symbol = sym(symRaw);
  const inst = S.insts.find((i) => i.symbol === symbol);
  const tk = S.tickers.find((t) => t.symbol === symbol);
  if (!inst || !tk?.mark_price) throw new Error(`unknown or unpriced symbol ${symbol}`);
  let limit: string | undefined, tp: string | undefined, sl: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const r = rest[i];
    if (r.startsWith("@")) limit = r.slice(1);
    else if (r === "tp") tp = rest[++i];
    else if (r === "sl") sl = rest[++i];
  }
  const ref = Number(limit ?? tk.mark_price);
  const size = sizeRaw.startsWith("$") ? dec(Number(sizeRaw.slice(1)) / ref) : sizeRaw;
  const chk = checkOrder(inst, { side, size, price: limit, refPrice: tk.mark_price });
  if (chk.problems.length) throw new Error(chk.problems.join("; "));
  const leg = (v: string | undefined, kind: "tp" | "sl") => {
    if (!v) return undefined;
    const dir = (side === "buy" ? 1 : -1) * (kind === "tp" ? 1 : -1);
    const px = v.endsWith("%") ? ref * (1 + (dir * Number(v.slice(0, -1))) / 100) : Number(v);
    return { trigger_price: roundPrice(dec(px), inst.price_precision), trigger_by: "mark" as const, max_slippage: null };
  };
  const take_profit = leg(tp, "tp"), stop_loss = leg(sl, "sl");
  const base = { symbol, side, size: chk.size, client_order_id: newClientOrderId("dash") } as const;
  const order: PlaceOrder = limit
    ? { ...base, type: "limit", price: chk.price!, trigger_by: "mark", max_slippage: "0.005", ...(take_profit && { take_profit }), ...(stop_loss && { stop_loss }) }
    : { ...base, type: "market", max_slippage: "0.005", ...(take_profit && { take_profit }), ...(stop_loss && { stop_loss }) };
  const text = `${side.toUpperCase()} ${chk.size} ${symbol} ${limit ? "@ " + chk.price : "at market"} (≈${num(chk.notional)} USDC)` +
    (take_profit ? ` tp ${take_profit.trigger_price}` : "") + (stop_loss ? ` sl ${stop_loss.trigger_price}` : "");
  return { order, text };
}

async function run(line: string) {
  const t = line.trim().split(/\s+/).filter(Boolean);
  if (!t.length) return;
  const cmd = t[0].toLowerCase();
  try {
    if (cmd === "q" || cmd === "quit" || cmd === "exit") return quit();
    if (["buy", "sell", "long", "short"].includes(cmd)) {
      S.confirm = parseOrder([cmd, ...t.slice(1)]);
      if (client.environment === "prod" && process.env.OMNI_ALLOW_PROD !== "1") {
        S.confirm = null;
        throw new Error("mainnet orders disabled (set OMNI_ALLOW_PROD=1)");
      }
    } else if (cmd === "close") {
      const symbol = sym(t[1] ?? "");
      const p = S.positions.find((x) => x.symbol === symbol);
      if (!p) throw new Error(`no ${symbol} position`);
      const sz = Number(p.size);
      S.confirm = {
        order: { type: "market", symbol, side: sz > 0 ? "sell" : "buy", size: p.size.replace("-", ""), max_slippage: "0.01", reduce_only: true, client_order_id: newClientOrderId("dash") },
        text: `CLOSE ${p.size} ${symbol} at market (reduce-only)`,
      };
    } else if (cmd === "cancel") {
      const arg = t[1];
      if (!arg) throw new Error("cancel ID|SYM|all");
      if (arg === "all") log(`canceled ${(await client.cancelAll()).length} orders`);
      else {
        const o = S.orders.find((x) => x.order_id.startsWith(arg));
        if (o) { await client.cancelOrder({ order_id: o.order_id }); log(`canceled ${o.order_id.slice(0, 8)}`); }
        else log(`canceled ${(await client.cancelAll(sym(arg))).length} ${sym(arg)} orders`);
      }
    } else throw new Error(`unknown command ${cmd}`);
  } catch (e) {
    log(c.red(e instanceof OmniError ? `${e.code}: ${e.body.error_message}` : (e as Error).message));
  }
}

async function send(order: PlaceOrder) {
  try {
    const placed = await client.placeOrder(order);
    log(`placed ${placed.map((o) => `${o.type}:${o.order_id.slice(0, 8)}`).join(" + ")}`);
    if (placed[0].type === "market") {
      const o = await client.waitForOrder(placed[0].order_id);
      log(o.status === "filled" ? c.green(`filled ${o.size} ${o.symbol} @ ${o.fill_price}`) : c.yellow(`${o.status}${o.reason ? " (" + o.reason + ")" : ""}`));
    }
  } catch (e) {
    log(c.red(e instanceof OmniError ? `${e.code}: ${e.body.error_message}` : (e as Error).message));
  }
  render();
}

// ---------- terminal ----------
function quit() {
  process.stdout.write(`${ESC}?25h${ESC}?1049l`);
  process.exit(0);
}

process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
process.on("SIGINT", quit);
process.stdout.on("resize", render);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (k: string) => {
  if (k === "\u0003") return quit();
  if (S.confirm) {
    const pend = S.confirm;
    S.confirm = null;
    if (k.toLowerCase() === "y") { log(`sending ${pend.text}`); void send(pend.order); }
    else log("cancelled");
    return render();
  }
  for (const ch of k) {
    if (ch === "\r" || ch === "\n") { const line = S.input; S.input = ""; void run(line).then(render); }
    else if (ch === "\u007f" || ch === "\b") S.input = S.input.slice(0, -1);
    else if (ch >= " " && !k.startsWith("\x1b")) S.input += ch;
  }
  render();
});

log(`connected to ${client.baseUrl}`);
render();
void refresh();
