#!/usr/bin/env node
// Delta-neutral swap ⇄ perp bot for Omni.
//
//   omni-dn scan [--minutes 3]                       find perp/swap pairs, measure their spreads, rank them
//   omni-dn run --pair XAU [--live]                  stat mode: trade the spread's mean reversion
//   omni-dn run --pair XAU --mode carry --dir short_perp --perp-funding 0.01 --swap-long-funding 0.005 [--live]
//                                                    carry mode: hold one DN direction to harvest funding
//
// Execution is leg-safe: the swap leg (the one with trading hours) always goes first; if the perp leg
// then fails, the swap leg is unwound. Safety checks run every cycle while a position is open.
import { parseArgs } from "node:util";
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { OmniClient, OmniError, checkOrder, dec, type Instrument, type Order, type Position, type Ticker } from "../../sdk/index.js";
import { SpreadStats, carryBpsPerDay, correlation, discoverPairs, kindOf, signal, type Dir, type Funding, type Pair, type SignalParams } from "./core.js";

const cmd = process.argv[2];
// Accept "--flag -0.0065" as well as "--flag=-0.0065": node's parseArgs reads a leading "-" as an option.
const argv: string[] = [];
for (const x of process.argv.slice(3)) {
  if (/^-\d|^-\.\d/.test(x) && argv.length && argv[argv.length - 1].startsWith("--") && !argv[argv.length - 1].includes("=")) argv[argv.length - 1] += `=${x}`;
  else argv.push(x);
}
const { values: a } = parseArgs({
  args: argv,
  options: {
    pair: { type: "string" },
    mode: { type: "string", default: "stat" },
    dir: { type: "string" },
    "notional-usd": { type: "string", default: "500" },
    "entry-z": { type: "string", default: "2" },
    "exit-z": { type: "string", default: "0.5" },
    "round-trip-bps": { type: "string", default: "24" },
    "min-edge-bps": { type: "string", default: "5" },
    "hold-hours": { type: "string", default: "4" },
    "half-life-min": { type: "string", default: "60" },
    "min-samples": { type: "string", default: "30" },
    "perp-funding": { type: "string", default: "0" },
    "swap-long-funding": { type: "string", default: "0" },
    "swap-short-funding": { type: "string", default: "0" },
    "max-slippage-pct": { type: "string", default: "0.5" },
    "max-drift-pct": { type: "string", default: "5" },
    "min-liq-dist-pct": { type: "string", default: "15" },
    "stop-loss-usd": { type: "string", default: "25" },
    "max-hold-hours": { type: "string", default: "24" },
    "flat-before-close-min": { type: "string", default: "15" },
    poll: { type: "string", default: "10" },
    minutes: { type: "string", default: "3" },
    every: { type: "string", default: "15" },
    state: { type: "string" },
    "status-json": { type: "boolean", default: false },
    live: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

const client = new OmniClient({ reserve: 6 });
const ts = () => new Date().toISOString().slice(11, 19);
const LIVE = a.live!;
const say = (m: string) => console.log(`${ts()} ${cmd === "run" && !LIVE ? "[dry] " : ""}${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lr = (perp: number, swap: number) => Math.log(perp / swap);
const fmtTime = (t?: number | null) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") + "Z" : "—");

// =====================================================================================
// scan
// =====================================================================================
async function scan() {
  const insts = await client.instruments();
  const pairs = discoverPairs(insts);
  const kinds = { perp: 0, swap: 0 };
  for (const i of insts) kinds[kindOf(i)]++;
  console.log(`${insts.length} instruments (${kinds.perp} classified perp, ${kinds.swap} swap) → ${pairs.length} perp/swap pair(s)`);
  if (!pairs.length) {
    const swaps = insts.filter((i) => kindOf(i) === "swap").map((i) => `${i.symbol}(${i.underlying})`);
    console.log(`swaps seen: ${swaps.join(", ") || "none"}. If a pair is missing, its underlyings may need an alias in src/bot/dn/core.ts (ALIASES).`);
    return;
  }
  const paired = new Set(pairs.map((p) => p.swap.symbol));
  const lonely = insts.filter((i) => kindOf(i) === "swap" && !paired.has(i.symbol));
  if (lonely.length)
    console.log(`swaps with no matching perp: ${lonely.map((i) => `${i.symbol} (underlying ${i.underlying})`).join(", ")}\n` +
      `  → if one of these has a perp under another name, add it to ALIASES in src/bot/dn/core.ts`);
  for (const p of pairs)
    console.log(`  ${p.key.padEnd(8)} perp ${p.perp.symbol.padEnd(14)} swap ${p.swap.symbol.padEnd(14)} swap status ${p.swap.status ?? "?"} · next close ${fmtTime(p.swap.next_close_at)} · margin ${p.swap.margin_modes.join("/")}`);

  const mins = +a.minutes!, every = +a.every! * 1000;
  const samples = Math.max(2, Math.round((mins * 60_000) / every));
  console.log(`\nsampling all tickers every ${every / 1000}s for ${mins} min (${samples} samples)…`);
  const series = new Map<string, { t: number; perp: number; swap: number }[]>();
  for (let s = 0; s < samples; s++) {
    const tk = new Map((await client.tickers()).map((t) => [t.symbol, t]));
    for (const p of pairs) {
      const pm = Number(tk.get(p.perp.symbol)?.mark_price), sm = Number(tk.get(p.swap.symbol)?.mark_price);
      if (pm > 0 && sm > 0) (series.get(p.key) ?? series.set(p.key, []).get(p.key)!).push({ t: Date.now(), perp: pm, swap: sm });
    }
    process.stdout.write(`\r  sample ${s + 1}/${samples}`);
    if (s < samples - 1) await sleep(every);
  }
  const cost = +a["round-trip-bps"]!;
  const rows = pairs.map((p) => {
    const xs = series.get(p.key) ?? [];
    const r = xs.map((x) => lr(x.perp, x.swap));
    const mean = r.reduce((s, v) => s + v, 0) / (r.length || 1);
    const sd = Math.sqrt(r.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, r.length - 1)) * 1e4;
    const last = xs.at(-1);
    const dev = r.length ? (r.at(-1)! - mean) * 1e4 : NaN;
    const maxDev = r.length ? Math.max(...r.map((v) => Math.abs(v - mean) * 1e4)) : NaN;
    // A hedge only works if the legs move together: check the correlation of their returns.
    const ret = (k: "perp" | "swap") => xs.slice(1).map((x, i) => Math.log(x[k] / xs[i][k]));
    const corr = correlation(ret("perp"), ret("swap"));
    const moved = ret("perp").some((v) => v !== 0) && ret("swap").some((v) => v !== 0);
    return {
      pair: p.key, perp: p.perp.symbol, swap: p.swap.symbol, swapStatus: p.swap.status,
      perpMark: last?.perp ?? null, swapMark: last?.swap ?? null,
      levelRatio: last ? +(last.perp / last.swap).toPrecision(6) : null,
      corr: Number.isFinite(corr) ? +corr.toFixed(2) : null,
      spreadStdBps: +sd.toFixed(2), lastDevBps: +dev.toFixed(2), maxDevBps: +maxDev.toFixed(2), samples: r.length,
      // A spread can pay only if its swings are large relative to the cost of four fills.
      verdict: !r.length ? "no prices" : p.swap.status !== "open" ? "swap closed" :
        moved && Number.isFinite(corr) && corr < 0.6 ? "NOT A HEDGE: legs don't move together" : maxDev > cost ? "tradable swings" : sd * 2 > cost / 2 ? "marginal" : "too tight for costs",
    };
  });
  rows.sort((x, y) => (y.maxDevBps || 0) - (x.maxDevBps || 0));
  console.log("\n");
  if (a.json) return console.log(JSON.stringify(rows, null, 2));
  console.log("PAIR      PERP MARK      SWAP MARK    PERP/SWAP   CORR   SPREAD σ   MAX |DEV|   NOW      VERDICT");
  for (const r of rows)
    console.log(`${r.pair.padEnd(8)} ${String(r.perpMark ?? "-").padStart(10)} ${String(r.swapMark ?? "-").padStart(14)} ${String(r.levelRatio ?? "-").padStart(11)} ${String(r.corr ?? "-").padStart(6)} ` +
      `${(r.spreadStdBps + "bp").padStart(9)} ${(r.maxDevBps + "bp").padStart(10)} ${((r.lastDevBps >= 0 ? "+" : "") + r.lastDevBps + "bp").padStart(8)}   ${r.verdict}`);
  console.log(`\nCosts assumed: ${cost}bp per round trip (4 fills; set --round-trip-bps). Funding isn't in the API: check each pair's perp and swap funding in the app.`);
  console.log(`Weight used: ${60 - (client.budget.remaining ?? 60)}/60 at the end · learned costs ${JSON.stringify(Object.fromEntries(client.costs))}`);
}

// =====================================================================================
// run
// =====================================================================================
interface Trade {
  dir: Dir;
  openedAt: number;
  usd: number;
  perp: { size: number; entry: number };
  swap: { size: number; entry: number };
  devAtEntry: number;
  carryBpsDay: number;
}
interface State { stats: any; trade: Trade | null; realizedUsd: number; trades: number }

const SP: SignalParams = {
  entryZ: +a["entry-z"]!, exitZ: +a["exit-z"]!, roundTripBps: +a["round-trip-bps"]!, minEdgeBps: +a["min-edge-bps"]!,
  holdHours: +a["hold-hours"]!, minSamples: +a["min-samples"]!,
};
const F: Funding = { perpPct8h: +a["perp-funding"]!, swapLongPctDay: +a["swap-long-funding"]!, swapShortPctDay: +a["swap-short-funding"]! };
const SLIP = dec(+a["max-slippage-pct"]! / 100);

let pair: Pair;
let state: State;
let statePath: string;
const instCache = new Map<string, { at: number; inst: Instrument }>();
async function inst(symbol: string) {
  const c = instCache.get(symbol);
  if (c && Date.now() - c.at < 60_000) return c.inst;
  const i = await client.instrument(symbol);
  instCache.set(symbol, { at: Date.now(), inst: i });
  return i;
}
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const log = (type: string, d: Record<string, unknown>) => appendFileSync(statePath.replace(/\.json$/, ".jsonl"), JSON.stringify({ t: Date.now(), type, ...d }) + "\n");

interface LegReq { symbol: string; side: "buy" | "sell"; size: string; reduceOnly: boolean; ref: number }
interface Fill { size: number; price: number }

const errMsg = (e: unknown) => (e instanceof OmniError ? `${e.code}: ${e.body.error_message}` : (e as Error).message);

/** Sends one market order (no waiting). Returns the order, or null if it was refused outright. */
async function send(l: LegReq): Promise<Order | null> {
  try {
    const [o] = await client.placeOrder({ type: "market", symbol: l.symbol, side: l.side, size: l.size, max_slippage: SLIP, reduce_only: l.reduceOnly });
    return o;
  } catch (e) {
    say(`  ${l.symbol} ${l.side} ${l.size} refused: ${errMsg(e)}`);
    return null;
  }
}

async function settle(l: LegReq, o: Order | null): Promise<Fill | null> {
  if (!o) return null;
  const f = o.status === "queued" ? await client.waitForOrder(o.order_id, { timeoutMs: 15_000, intervalMs: 500 }).catch(() => o) : o;
  if (f.status !== "filled") {
    say(`  ${l.symbol} ${l.side} ${l.size}: ${f.status}${f.reason ? ` (${f.reason})` : ""}`);
    return null;
  }
  const px = Number(f.fill_price);
  log("fill", { symbol: l.symbol, side: l.side, size: f.size, price: px, slippageBps: ((l.side === "buy" ? px - l.ref : l.ref - px) / l.ref) * 1e4 });
  return { size: Number(f.size), price: px };
}

/** Weight needed to run a two-leg trade end to end, including fill polling and one repair. */
function pairBudget() {
  return 3 * client.expectedCost("POST", "/v1/orders") + 6 * client.expectedCost("GET", "/v1/orders/:id");
}

/**
 * Executes both legs as one unit. The two orders go out back to back (milliseconds apart) and are
 * confirmed together, so the spread has almost no time to move between legs. A leg that fails is
 * retried; if it still fails, the leg that did fill is unwound so we never stay one-sided.
 * Returns both fills, or null after making sure nothing is left open.
 */
async function execPair(legs: [LegReq, LegReq]): Promise<[Fill, Fill] | null> {
  if (!LIVE) {
    // Paper fills: mark ± a quarter of the round-trip cost each.
    return legs.map((l) => ({ size: Number(l.size), price: l.ref * (1 + ((l.side === "buy" ? 1 : -1) * SP.roundTripBps) / 4 / 1e4) })) as [Fill, Fill];
  }
  const est = client.estimatedRemaining();
  if (est !== null && est < pairBudget() + 6) {
    say(`deferring: ${est} weight left, need ${pairBudget() + 6} to trade both legs without pausing between them`);
    return null;
  }
  const orders = [await send(legs[0]), await send(legs[1])];
  const fills = [await settle(legs[0], orders[0]), await settle(legs[1], orders[1])];
  for (let i = 0; i < 2; i++) {
    if (fills[i] || !fills[1 - i]) continue;
    for (let k = 0; k < 2 && !fills[i]; k++) {
      say(`  retrying ${legs[i].symbol} leg`);
      fills[i] = await settle(legs[i], await send(legs[i]));
    }
    if (!fills[i]) {
      const done = legs[1 - i], f = fills[1 - i]!;
      say(`  ${legs[i].symbol} leg failed: unwinding the ${done.symbol} leg to stay flat`);
      const u = await settle(done, await send({ ...done, side: done.side === "buy" ? "sell" : "buy", size: String(f.size), reduceOnly: !done.reduceOnly }));
      log("leg_failure", { failed: legs[i].symbol, unwound: !!u });
      if (!u) say(`!! unwind failed: ${done.symbol} is UNHEDGED (${done.side} ${f.size}), fix it manually`);
      return null;
    }
  }
  if (!fills[0] || !fills[1]) return null;
  return fills as [Fill, Fill];
}

async function enter(dir: Dir, tp: Ticker, ts_: Ticker, devBps: number) {
  const usd = +a["notional-usd"]!;
  const pm = Number(tp.mark_price), sm = Number(ts_.mark_price);
  const [pi, si] = [await inst(pair.perp.symbol), await inst(pair.swap.symbol)];
  const swapSide = dir === "short_perp" ? "buy" : "sell", perpSide = dir === "short_perp" ? "sell" : "buy";
  const sc = checkOrder(si, { side: swapSide, size: dec(usd / sm), refPrice: String(sm) });
  const pc = checkOrder(pi, { side: perpSide, size: dec(usd / pm), refPrice: String(pm) });
  if (sc.problems.length || pc.problems.length) return say(`cannot size legs: ${[...sc.problems, ...pc.problems].join("; ")}`);
  const est = client.estimatedRemaining();
  if (LIVE && est !== null && est < pairBudget() + 6) return say(`signal ${dir}, but waiting for weight (${est} < ${pairBudget() + 6})`);
  say(`ENTER ${dir}: ${swapSide} ${sc.size} ${pair.swap.symbol} (≈${sc.notional}$) + ${perpSide} ${pc.size} ${pair.perp.symbol} (≈${pc.notional}$)`);
  // Swap leg first in the pair: if its market just closed it is refused instantly and the perp unwinds.
  const r = await execPair([
    { symbol: pair.swap.symbol, side: swapSide, size: sc.size, reduceOnly: false, ref: sm },
    { symbol: pair.perp.symbol, side: perpSide, size: pc.size, reduceOnly: false, ref: pm },
  ]);
  if (!r) return say("not entered; flat");
  const [s, p] = r;
  state.trade = {
    dir, openedAt: Date.now(), usd,
    perp: { size: perpSide === "buy" ? p.size : -p.size, entry: p.price },
    swap: { size: swapSide === "buy" ? s.size : -s.size, entry: s.price },
    devAtEntry: devBps, carryBpsDay: carryBpsPerDay(dir, F),
  };
  const realised = (Math.log(p.price / s.price) - (state.stats as SpreadStats).mean!) * 1e4;
  say(`  entered at dev ${realised.toFixed(1)}bp (signal ${devBps.toFixed(1)}bp)`);
  log("enter", { trade: state.trade, devAtFill: realised });
  save();
}

function legsPnl(t: Trade, pm: number, sm: number) {
  return t.perp.size * (pm - t.perp.entry) + t.swap.size * (sm - t.swap.entry);
}

async function exit(why: string, pm: number, sm: number, swapOpen: boolean) {
  const t = state.trade!;
  // A closed swap can't trade: keep both legs on (still delta-neutral) rather than closing only the perp.
  if (!swapOpen) return say(`want to exit (${why}) but ${pair.swap.symbol} is closed; staying hedged until it reopens`);
  say(`EXIT (${why})`);
  const r = await execPair([
    { symbol: pair.swap.symbol, side: t.swap.size > 0 ? "sell" : "buy", size: String(Math.abs(t.swap.size)), reduceOnly: true, ref: sm },
    { symbol: pair.perp.symbol, side: t.perp.size > 0 ? "sell" : "buy", size: String(Math.abs(t.perp.size)), reduceOnly: true, ref: pm },
  ]);
  // On a failed exit execPair re-opens whichever leg it closed, so the hedge is intact: try again next cycle.
  if (!r) return say("exit incomplete; position still hedged, retrying next cycle");
  const [s, p] = r;
  const pnl = t.perp.size * (p.price - t.perp.entry) + t.swap.size * (s.price - t.swap.entry);
  state.realizedUsd += pnl;
  state.trades++;
  say(`closed: price PnL ${pnl.toFixed(2)}$ (funding shows in the positions' cum_funding) · session total ${state.realizedUsd.toFixed(2)}$ over ${state.trades} trade(s)`);
  log("exit", { why, pnl, heldMin: (Date.now() - t.openedAt) / 60000 });
  state.trade = null;
  save();
  // Carry mode is a single hold: after any exit, stay flat. Stat mode keeps trading after a normal
  // reversion exit, but a manual or safety exit (stop loss, liquidation distance, max hold, swap
  // closing) stops it too, so it can't walk straight back into the same loss.
  const routine = a.mode === "stat" && why.startsWith("spread reverted");
  if (!routine) {
    say(`stopping after this exit (${a.mode === "carry" ? "carry mode holds once" : "manual/safety exit"}); start the bot again to re-enter`);
    halt = true;
  }
}
let halt = false;
let exitRequested = false;

let cycleN = 0;
let lastFunding: { perp: number; swap: number; at: number } | null = null;
let lastLiq: { perp: string | null; swap: string | null } | null = null;
let carryWarned = 0;
async function cycle() {
  const [pi, si] = [await inst(pair.perp.symbol), await inst(pair.swap.symbol)];
  const [tp, tsw] = [await client.ticker(pair.perp.symbol), await client.ticker(pair.swap.symbol)];
  const pm = Number(tp.mark_price), sm = Number(tsw.mark_price);
  if (!(pm > 0 && sm > 0)) return say("waiting for prices");
  const swapOpen = !si.status || si.status === "open";
  const swapFresh = tsw.updated_at ? Date.now() - tsw.updated_at < 60_000 : true;
  const x = lr(pm, sm);
  const stats = state.stats as SpreadStats;
  // Only learn the spread while both legs are live; a closed swap's frozen price would poison the mean.
  if (swapOpen && swapFresh) stats.update(x, Date.now());
  const t = state.trade;
  const sig = signal(stats, x, SP, F, t?.dir ?? null);
  const minsToClose = si.next_close_at ? (si.next_close_at - Date.now()) / 60000 : Infinity;

  // ---------- safety while open ----------
  if (t && LIVE && cycleN % 3 === 0) {
    const [pp, ps] = [await client.position(pair.perp.symbol), await client.position(pair.swap.symbol)];
    for (const [name, pos, m] of [["perp", pp, pm], ["swap", ps, sm]] as [string, Position, number][]) {
      if (pos.liquidation_price) {
        const dist = Math.abs(m - Number(pos.liquidation_price)) / m * 100;
        if (dist < +a["min-liq-dist-pct"]!) return exit(`${name} leg ${dist.toFixed(1)}% from liquidation`, pm, sm, swapOpen);
      }
    }
    const fund = Number(pp.cum_funding) + Number(ps.cum_funding);
    lastFunding = { perp: Number(pp.cum_funding), swap: Number(ps.cum_funding), at: Date.now() };
    lastLiq = { perp: pp.liquidation_price, swap: ps.liquidation_price };
    if (cycleN % 30 === 0) say(`funding so far: perp ${pp.cum_funding}$ + swap ${ps.cum_funding}$ = ${fund.toFixed(4)}$`);
    // Hedge drift: price moves change each leg's USD exposure; top up the perp leg (24/7) to re-neutralise.
    const net = Number(pp.size) * pm + Number(ps.size) * sm, gross = Math.abs(Number(pp.size) * pm) + Math.abs(Number(ps.size) * sm);
    if (gross > 0 && (Math.abs(net) / gross) * 100 > +a["max-drift-pct"]!) {
      const adj = checkOrder(pi, { side: net > 0 ? "sell" : "buy", size: dec(Math.abs(net) / pm), refPrice: String(pm) });
      if (!adj.problems.length) {
        say(`rebalance: net delta ${net.toFixed(2)}$ → ${net > 0 ? "sell" : "buy"} ${adj.size} ${pair.perp.symbol}`);
        const f = await settle({ symbol: pair.perp.symbol, side: net > 0 ? "sell" : "buy", size: adj.size, reduceOnly: false, ref: pm },
          LIVE ? await send({ symbol: pair.perp.symbol, side: net > 0 ? "sell" : "buy", size: adj.size, reduceOnly: false, ref: pm }) : null);
        if (f) { t.perp.size += (net > 0 ? -1 : 1) * f.size; save(); }
      }
    }
  }
  // Manual exit requested (e.g. from the web panel): write "exit" into dn-<PAIR>.cmd.
  const cmdPath = statePath.replace(/\.json$/, ".cmd");
  if (existsSync(cmdPath)) {
    const c = readFileSync(cmdPath, "utf8").trim();
    unlinkSync(cmdPath);
    if (c === "exit" && t) exitRequested = true;
  }
  // Sticky: if the exit is deferred (e.g. waiting for rate-limit weight), keep trying every cycle.
  if (exitRequested && t) return exit("manual exit requested", pm, sm, swapOpen);
  if (t) {
    const pnl = legsPnl(t, pm, sm);
    if (pnl < -+a["stop-loss-usd"]!) return exit(`stop loss ${pnl.toFixed(2)}$`, pm, sm, swapOpen);
    if ((Date.now() - t.openedAt) / 3.6e6 > +a["max-hold-hours"]!) return exit("max hold time", pm, sm, swapOpen);
    if (a.mode === "stat" && minsToClose < +a["flat-before-close-min"]! && swapOpen) return exit(`swap closes in ${minsToClose.toFixed(0)} min`, pm, sm, swapOpen);
    if (a.mode === "stat" && sig.action === "exit" && swapOpen) return exit(sig.reason, pm, sm, swapOpen);
  }

  // ---------- entry ----------
  if (!t) {
    const canEnter = swapOpen && swapFresh && minsToClose > +a["flat-before-close-min"]! * 2;
    if (a.mode === "carry") {
      const dir = a.dir as Dir;
      const carry = carryBpsPerDay(dir, F);
      if (canEnter) {
        if (carry * (SP.holdHours / 24) < SP.roundTripBps && !carryWarned++) say(`note: expected carry ${carry.toFixed(1)}bp/day doesn't cover ${SP.roundTripBps}bp costs over ${SP.holdHours}h`);
        await enter(dir, tp, tsw, sig.devBps);
      }
    } else if (sig.action === "enter" && canEnter) await enter(sig.dir!, tp, tsw, sig.devBps);
  }

  const tr = state.trade;
  say(`${pair.key} perp ${pm} swap ${sm} | dev ${sig.devBps >= 0 ? "+" : ""}${sig.devBps.toFixed(1)}bp z ${sig.z.toFixed(2)} σ ${stats.stdBps().toFixed(1)}bp n${stats.n} | ` +
    (tr ? `OPEN ${tr.dir} pnl ${legsPnl(tr, pm, sm).toFixed(2)}$ ` : `${sig.reason} `) +
    `| swap ${swapOpen ? "open" : si.status}${Number.isFinite(minsToClose) ? `, closes in ${(minsToClose / 60).toFixed(1)}h` : ""} | w ${client.budget.remaining}/${client.budget.limit}`);
  if (a["status-json"]) {
    console.log("@@" + JSON.stringify({
      t: Date.now(), pair: pair.key, perp: pair.perp.symbol, swap: pair.swap.symbol, pm, sm, mode: a.mode, live: LIVE,
      devBps: +sig.devBps.toFixed(2), z: +sig.z.toFixed(3), stdBps: +stats.stdBps().toFixed(2), n: stats.n, signal: sig.reason,
      swapStatus: swapOpen ? "open" : si.status, minsToClose: Number.isFinite(minsToClose) ? Math.round(minsToClose) : null,
      trade: tr ? { ...tr, pnl: +legsPnl(tr, pm, sm).toFixed(4) } : null,
      realizedUsd: state.realizedUsd, trades: state.trades, funding: lastFunding, liq: lastLiq, exitPending: exitRequested,
      weight: client.budget.remaining, limit: client.budget.limit,
    }));
  }
  if (cycleN % 6 === 0) save();
}

async function run() {
  if (!a.pair) throw new Error("--pair is required (run `scan` to list pairs)");
  if (a.mode === "carry" && a.dir !== "short_perp" && a.dir !== "long_perp") throw new Error("carry mode needs --dir short_perp|long_perp");
  if (LIVE && client.environment === "prod" && process.env.OMNI_ALLOW_PROD !== "1") throw new Error("mainnet needs OMNI_ALLOW_PROD=1");
  const pairs = discoverPairs(await client.instruments());
  const found = pairs.find((p) => p.key === a.pair!.toUpperCase() || p.perp.symbol === a.pair!.toUpperCase() || p.swap.symbol === a.pair!.toUpperCase());
  if (!found) throw new Error(`no perp/swap pair "${a.pair}". Available: ${pairs.map((p) => p.key).join(", ") || "none"}`);
  pair = found;
  // Guard against a mis-paired hedge (e.g. a token that shares a ticker with an index).
  {
    const tk = new Map((await client.tickers()).map((t) => [t.symbol, Number(t.mark_price)]));
    const ratio = (tk.get(pair.perp.symbol) ?? NaN) / (tk.get(pair.swap.symbol) ?? NaN);
    if (!(ratio > 0.02 && ratio < 50)) throw new Error(`${pair.perp.symbol} and ${pair.swap.symbol} trade at a ${ratio.toPrecision(3)} price ratio: probably not the same asset. Run \`scan\` and check the CORR column.`);
  }
  statePath = a.state ?? `dn-${pair.key}${LIVE ? "" : "-dry"}.json`;
  const halfLife = +a["half-life-min"]! * 60;
  const saved = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
  state = { stats: SpreadStats.from(saved?.stats, halfLife), trade: saved?.trade ?? null, realizedUsd: saved?.realizedUsd ?? 0, trades: saved?.trades ?? 0 };
  say(`DN ${pair.key}: perp ${pair.perp.symbol} ⇄ swap ${pair.swap.symbol} · mode ${a.mode}${a.mode === "carry" ? ` ${a.dir}` : ""} · ${a["notional-usd"]}$/leg · ` +
    `entry |z|≥${SP.entryZ} exit |z|≤${SP.exitZ} · costs ${SP.roundTripBps}bp · state ${statePath}${LIVE ? "" : " · DRY RUN (paper fills; --live to trade)"}`);
  if (saved?.stats?.n) say(`resumed spread stats (${saved.stats.n} samples)${state.trade ? ` and an OPEN ${state.trade.dir} trade` : ""}`);
  if (state.trade && LIVE) {
    const [pp, ps] = [await client.position(pair.perp.symbol), await client.position(pair.swap.symbol)];
    say(`exchange positions: perp ${pp.size}, swap ${ps.size} (state expects perp ${state.trade.perp.size}, swap ${state.trade.swap.size})`);
    // The bot only owns what it opened. If the account holds less than that (a leg closed by hand, a
    // liquidation), managing it blindly could open an unhedged position: stop and let a human decide.
    const short = (have: number, want: number) => Math.sign(have) !== Math.sign(want) || Math.abs(have) < Math.abs(want) * 0.99;
    if (short(Number(pp.size), state.trade.perp.size) || short(Number(ps.size), state.trade.swap.size)) {
      throw new Error(`positions don't match ${statePath}: fix them on Omni, then delete the "trade" entry from that file (or the file) and restart`);
    }
  }

  let stopping = false, current: Promise<unknown> = Promise.resolve();
  const stop = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    await current;
    save();
    say(state.trade ? `stopped with an OPEN ${state.trade.dir} position: it stays on (delta-neutral). Re-run to resume managing it.` : "stopped; flat");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  for (;;) {
    if (halt) return stop();
    current = cycle().catch((e) => say(`error: ${e instanceof OmniError ? `${e.code}: ${e.body.error_message}` : (e as Error).message}`));
    await current;
    cycleN++;
    // Polling only spends weight above the trading reserve, so a two-leg trade can always go out
    // the moment a signal fires. Below it, wait for the sliding window to hand weight back.
    let wait = +a.poll! * 1000;
    const est = client.estimatedRemaining();
    if (LIVE && est !== null && est < pairBudget() + 12) wait = Math.max(wait, 3 * +a.poll! * 1000, 6000);
    await sleep(wait);
  }
}

const main = cmd === "scan" ? scan : cmd === "run" ? run : null;
if (!main) {
  console.error("usage: omni-dn scan [--minutes 3] [--every 15] [--json]\n       omni-dn run --pair XAU [--mode stat|carry] [--dir short_perp|long_perp] [--live] …  (see README)");
  process.exit(2);
}
main().catch((e) => {
  console.error(e instanceof OmniError ? `${e.code}: ${e.body.error_message}` : (e as Error).message);
  process.exit(1);
});
