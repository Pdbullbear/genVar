#!/usr/bin/env node
// Grid bot example for Omni. It keeps a ladder of limit buys below the mark and limit sells above it,
// so it buys dips and sells rips as price oscillates. Inventory is capped, the grid recenters when
// price leaves the range, and it cancels its own orders on exit.
//
//   omni-grid --symbol BTC --levels 3 --spacing 0.3 --order-usd 50 --max-pos-usd 300        # dry run
//   omni-grid --symbol BTC ... --live                                                         # sends orders
//
// Budget: each cycle costs about 3 weight (ticker, orders, position) plus about 2 per new order.
// The default 10s interval uses about 18 weight/min, comfortably inside 60.
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { OmniClient, OmniError, checkOrder, dec, roundPrice, type Instrument, type Order } from "../sdk/index.js";

const { values: a } = parseArgs({
  options: {
    symbol: { type: "string", default: "BTC" },
    levels: { type: "string", default: "3" },
    spacing: { type: "string", default: "0.3" }, // % between levels
    "order-usd": { type: "string", default: "50" },
    "max-pos-usd": { type: "string", default: "300" },
    interval: { type: "string", default: "10" }, // seconds
    live: { type: "boolean", default: false },
    "keep-orders": { type: "boolean", default: false },
  },
});

const symbol = a.symbol!.toUpperCase().includes("-") ? a.symbol!.toUpperCase() : `${a.symbol!.toUpperCase()}-PERP`;
const LEVELS = Number(a.levels), SPACING = Number(a.spacing) / 100, ORDER_USD = Number(a["order-usd"]);
const MAX_POS_USD = Number(a["max-pos-usd"]), INTERVAL = Number(a.interval) * 1000, LIVE = a.live!;
const RUN = randomBytes(3).toString("hex");
let seq = 0;

const client = new OmniClient();
if (LIVE && client.environment === "prod" && process.env.OMNI_ALLOW_PROD !== "1") {
  console.error("Refusing to run live on mainnet without OMNI_ALLOW_PROD=1");
  process.exit(1);
}

const ts = () => new Date().toISOString().slice(11, 19);
const say = (m: string) => console.log(`${ts()} ${LIVE ? "" : "[dry] "}${m}`);

let center: number | null = null;
let instCache: { at: number; inst: Instrument } | null = null;
const levelOf = new Map<string, string>(); // client_order_id -> level price
const refill = new Map<string, number>(); // "side@price" -> fill price, for the re-quote cooldown
const RESERVE = 15; // weight to keep free for cancels and manual trading
let stopping = false;
const seenFills = new Set<string>();

async function cycle() {
  if (!instCache || Date.now() - instCache.at > 60_000) instCache = { at: Date.now(), inst: await client.instrument(symbol) };
  const inst = instCache.inst;
  const t = await client.ticker(symbol);
  if (!t.mark_price) return say("no price yet");
  const mark = Number(t.mark_price);
  if (inst.status && inst.status !== "open") return say(`market ${inst.status}; waiting`);

  // Fills first, so a level that filled since the last cycle is in cooldown before we re-quote.
  const [fillPage, orders, pos] = await Promise.all([
    client.fills({ symbol, limit: 20 }), client.openOrders({ symbol }), client.position(symbol),
  ]);
  for (const f of fillPage.results.filter((f) => f.client_order_id?.startsWith(`grid:${RUN}`)).reverse()) {
    if (seenFills.has(f.trade_id)) continue;
    seenFills.add(f.trade_id);
    const lvl = levelOf.get(f.client_order_id!) ?? f.price;
    refill.set(`${f.side}@${Number(lvl)}`, Number(f.price));
    say(`FILL ${f.side} ${f.size} @ ${f.price}`);
  }
  const mine = orders.filter((o) => o.client_order_id?.startsWith(`grid:${RUN}`));
  const posUsd = Number(pos.size) * mark;

  // Recenter when price escapes the ladder by one more step.
  const edge = SPACING * (LEVELS + 1);
  if (center === null || Math.abs(mark / center - 1) > edge) {
    if (center !== null) say(`price ${mark} left the range around ${center.toFixed(2)}; recentering`);
    center = mark;
    if (LIVE) for (const o of mine) await client.cancelOrder({ order_id: o.order_id }).catch(() => undefined);
    mine.length = 0;
    refill.clear();
  }

  // Inventory cap counts the position plus resting orders, so several fills in one cycle can't overshoot.
  const resting = (side: "buy" | "sell") =>
    mine.filter((o) => o.side === side).reduce((s, o) => s + Number(o.size) * Number(o.price), 0);
  let buyRoom = MAX_POS_USD - posUsd - resting("buy");
  let sellRoom = MAX_POS_USD + posUsd - resting("sell");
  const cooled = (side: string, px: string) => {
    const f = refill.get(`${side}@${Number(px)}`);
    return f === undefined || Math.abs(mark / f - 1) >= SPACING; // re-quote only after a full step away
  };
  const onBook = (side: string, px: string) => mine.some((o) => o.side === side && Number(o.price) === Number(px));

  // Desired ladder, nearest levels first. Passive levels only.
  const want: { side: "buy" | "sell"; price: string; k: number }[] = [];
  for (let k = 1; k <= LEVELS; k++) {
    const buy = roundPrice(dec(center * (1 - k * SPACING)), inst.price_precision, "down");
    const sell = roundPrice(dec(center * (1 + k * SPACING)), inst.price_precision, "up");
    if (Number(buy) < mark && (onBook("buy", buy) || (cooled("buy", buy) && buyRoom >= ORDER_USD))) {
      want.push({ side: "buy", price: buy, k });
      if (!onBook("buy", buy)) buyRoom -= ORDER_USD;
    }
    if (Number(sell) > mark && (onBook("sell", sell) || (cooled("sell", sell) && sellRoom >= ORDER_USD))) {
      want.push({ side: "sell", price: sell, k });
      if (!onBook("sell", sell)) sellRoom -= ORDER_USD;
    }
  }

  const stale = mine.filter((o) => !want.some((w) => w.side === o.side && Number(w.price) === Number(o.price)));
  for (const o of stale) {
    if (stopping) return;
    say(`cancel ${o.side} @ ${o.price}`);
    if (LIVE) await client.cancelOrder({ order_id: o.order_id }).catch((e) => say(`cancel failed: ${(e as Error).message}`));
  }
  let placed = 0;
  for (const w of want.filter((x) => !onBook(x.side, x.price))) {
    if (stopping) return;
    if (LIVE && (client.budget.remaining ?? 60) < RESERVE) { say(`weight low (${client.budget.remaining}); deferring new orders`); break; }
    const chk = checkOrder(inst, { side: w.side, size: dec(ORDER_USD / Number(w.price)), price: w.price, refPrice: t.mark_price });
    if (chk.problems.length) { say(`skip ${w.side} L${w.k}: ${chk.problems.join("; ")}`); continue; }
    say(`place ${w.side} ${chk.size} @ ${chk.price} (L${w.k})`);
    if (!LIVE) continue;
    const cid = `grid:${RUN}:${w.side[0]}${w.k}:${++seq}`;
    levelOf.set(cid, chk.price!);
    try {
      await client.placeOrder({ type: "limit", symbol, side: w.side, size: chk.size, price: chk.price!, trigger_by: "mark", max_slippage: null, client_order_id: cid });
      placed++;
    } catch (e) {
      say(`place failed: ${e instanceof OmniError ? e.code : (e as Error).message}`);
    }
  }

  say(`mark ${mark} | pos ${pos.size} (${posUsd.toFixed(0)} USD) | uPnL ${Number(pos.unrealized_pnl).toFixed(2)} | rPnL ${Number(pos.realized_pnl).toFixed(2)} | ` +
    `${mine.length - stale.length + placed} live orders | weight ${client.budget.remaining}/${client.budget.limit}`);
}

let current: Promise<void> = Promise.resolve();
async function loop() {
  while (!stopping) {
    current = cycle().catch((e) => say(`error: ${(e as Error).message}`));
    await current;
    // Stretch the interval when the budget runs low (the window slides, so half the reset is enough).
    const b = client.budget;
    const extra = b.remaining !== null && b.remaining < RESERVE * 2 && b.resetAt ? Math.max(0, (b.resetAt - Date.now()) / 2) : 0;
    await new Promise((r) => setTimeout(r, INTERVAL + extra));
  }
}

process.on("SIGINT", async () => {
  if (stopping) process.exit(1);
  stopping = true;
  await current; // let an in-flight cycle finish so nothing is placed after we cancel
  if (LIVE && !a["keep-orders"]) {
    say("stopping: canceling grid orders…");
    const open = (await client.openOrders({ symbol }).catch(() => [] as Order[])).filter((o) => o.client_order_id?.startsWith(`grid:${RUN}`));
    for (const o of open) await client.cancelOrder({ order_id: o.order_id }).catch(() => undefined);
    say(`canceled ${open.length} resting grid orders. Position is left open: close it from the dashboard or MCP if you want flat.`);
  }
  process.exit(0);
});

say(`grid ${symbol} on ${client.environment}: ${LEVELS} levels × ${(SPACING * 100).toFixed(2)}%, ${ORDER_USD} USD/order, cap ±${MAX_POS_USD} USD, run ${RUN}${LIVE ? "" : " (dry run; pass --live to trade)"}`);
void loop();
