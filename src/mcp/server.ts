#!/usr/bin/env node
// MCP server: lets Claude read and trade an Omni account in plain English.
//
// Safety model: placing an order takes two steps. `omni_preview_order` validates and rounds
// the order, then returns a short-lived token. `omni_place_order` only accepts that token,
// so the exact previewed order is what gets sent, and the model has to show it to you first.
// Guardrails come from env vars: OMNI_READ_ONLY=1, OMNI_MAX_NOTIONAL (default 1000 USDC),
// and OMNI_ALLOW_PROD=1, which is required before anything is placed on mainnet.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  OmniClient, OmniError, checkOrder, cmp, dec, newClientOrderId, roundPrice,
  type ChildOrder, type Instrument, type PlaceOrder,
} from "../sdk/index.js";

const client = new OmniClient();
const READ_ONLY = process.env.OMNI_READ_ONLY === "1";
const MAX_NOTIONAL = process.env.OMNI_MAX_NOTIONAL ?? "1000";
const PROD_BLOCKED = client.environment === "prod" && process.env.OMNI_ALLOW_PROD !== "1";

let instCache: { at: number; list: Instrument[] } | null = null;
async function instruments(): Promise<Instrument[]> {
  if (!instCache || Date.now() - instCache.at > 60_000) instCache = { at: Date.now(), list: await client.instruments() };
  return instCache.list;
}
async function instrument(symbol: string): Promise<Instrument> {
  const s = normSymbol(symbol);
  const i = (await instruments()).find((x) => x.symbol === s);
  if (!i) throw new Error(`Unknown symbol ${symbol}. Use omni_markets to list symbols.`);
  return i;
}
/** "btc" / "BTC" / "btc-perp" -> "BTC-PERP" */
function normSymbol(s: string) {
  const u = s.trim().toUpperCase();
  return u.includes("-") ? u : `${u}-PERP`;
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({
  isError: true,
  content: [{
    type: "text" as const,
    text: e instanceof OmniError ? JSON.stringify({ error: e.code, message: e.body.error_message, fields: e.body.error_fields }, null, 2)
      : String((e as Error)?.message ?? e),
  }],
});
const wrap = <A>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try {
    return ok(await fn(a));
  } catch (e) {
    return fail(e);
  }
};
const budget = () => ({
  weight_remaining: client.budget.remaining,
  weight_limit: client.budget.limit,
  full_reset_at: client.budget.resetAt ? new Date(client.budget.resetAt).toISOString() : null,
});

const server = new McpServer({ name: "variational-omni", version: "0.1.0" });

server.registerTool("omni_markets", {
  title: "List markets",
  description: "List Omni perpetual markets with mark price, index price, mark-vs-index basis in bps, status, minimum notional and size step. Costs about 2-4 of the 60 weight/min budget.",
  inputSchema: { symbols: z.array(z.string()).optional().describe("Filter, e.g. ['BTC','ETH']") },
}, wrap(async ({ symbols }: { symbols?: string[] }) => {
  const [insts, tickers] = await Promise.all([instruments(), client.tickers()]);
  const want = symbols?.map(normSymbol);
  return {
    environment: client.environment,
    markets: tickers.filter((t) => !want || want.includes(t.symbol)).map((t) => {
      const i = insts.find((x) => x.symbol === t.symbol);
      const basisBps = t.mark_price && t.index_price
        ? +(((Number(t.mark_price) - Number(t.index_price)) / Number(t.index_price)) * 1e4).toFixed(2) : null;
      return {
        symbol: t.symbol, mark: t.mark_price, index: t.index_price, basis_bps: basisBps,
        status: i?.status, close_only: i?.close_only, min_notional: i?.min_notional, size_step: i?.size_step,
        updated: t.updated_at ? new Date(t.updated_at).toISOString() : null,
      };
    }),
    ...budget(),
  };
}));

server.registerTool("omni_account", {
  title: "Account & positions",
  description: "Account equity, unrealized PnL, margin usage and every open position, with entry, mark, liquidation price and leverage.",
  inputSchema: {},
}, wrap(async () => {
  const [account, positions] = await Promise.all([client.account(), client.positions()]);
  return { environment: client.environment, account, positions, ...budget() };
}));

server.registerTool("omni_orders", {
  title: "Open orders",
  description: "List pending orders (queued, open limit, untriggered TP/SL). Pass order_id or client_order_id to look up a single order in any status.",
  inputSchema: {
    symbol: z.string().optional(),
    order_id: z.string().optional(),
    client_order_id: z.string().optional(),
  },
}, wrap(async (a: { symbol?: string; order_id?: string; client_order_id?: string }) => {
  if (a.order_id) return client.order(a.order_id);
  if (a.client_order_id) return (await client.orderByClientId(a.client_order_id)) ?? { found: false };
  return { orders: await client.openOrders({ symbol: a.symbol && normSymbol(a.symbol) }), ...budget() };
}));

server.registerTool("omni_fills", {
  title: "Recent fills",
  description: "Recent trades (fills), newest first, including liquidations.",
  inputSchema: { symbol: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) },
}, wrap(async (a: { symbol?: string; limit: number }) =>
  (await client.fills({ symbol: a.symbol && normSymbol(a.symbol), limit: a.limit })).results));

// ---------- Two-step order placement ----------
interface Pending { order: PlaceOrder; summary: unknown; expires: number }
const pending = new Map<string, Pending>();

const bracket = z.object({
  price: z.string().optional().describe("Absolute trigger price in USDC"),
  percent: z.number().optional().describe("Distance from entry/reference price in %, e.g. 2 for 2%"),
}).optional();

server.registerTool("omni_preview_order", {
  title: "Preview order",
  description:
    "Validate an order against the market's rules and guardrails WITHOUT sending it. Rounds price and size, computes notional, " +
    "and returns a confirm_token valid for 120s. Show the preview to the user and get explicit approval before calling omni_place_order. " +
    "Give exactly one of size (base units) or notional_usd. take_profit/stop_loss accept a price or percent from entry.",
  inputSchema: {
    symbol: z.string().describe("e.g. BTC or BTC-PERP"),
    side: z.enum(["buy", "sell"]),
    type: z.enum(["market", "limit", "take_profit", "stop_loss"]).default("market"),
    size: z.string().optional(),
    notional_usd: z.number().positive().optional(),
    price: z.string().optional().describe("Limit price (limit) or trigger price (take_profit / stop_loss)"),
    max_slippage_pct: z.number().min(0).max(10).default(0.5).describe("Max slippage vs mark, in %"),
    reduce_only: z.boolean().default(false),
    take_profit: bracket,
    stop_loss: bracket,
  },
}, wrap(async (a: {
  symbol: string; side: "buy" | "sell"; type: "market" | "limit" | "take_profit" | "stop_loss";
  size?: string; notional_usd?: number; price?: string; max_slippage_pct: number; reduce_only: boolean;
  take_profit?: { price?: string; percent?: number }; stop_loss?: { price?: string; percent?: number };
}) => {
  const inst = await instrument(a.symbol);
  const t = await client.ticker(inst.symbol);
  if (!t.mark_price) throw new Error(`${inst.symbol} has no price yet`);
  if ((a.size === undefined) === (a.notional_usd === undefined)) throw new Error("Give exactly one of size or notional_usd");
  if (a.type !== "market" && !a.price) throw new Error(`${a.type} orders need price`);
  const ref = a.type === "limit" ? a.price! : t.mark_price;
  const rawSize = a.size ?? dec(a.notional_usd! / Number(ref));
  const reduce = a.reduce_only || a.type === "take_profit" || a.type === "stop_loss";
  const chk = checkOrder(inst, { side: a.side, size: rawSize, price: a.type === "limit" ? a.price : undefined, refPrice: t.mark_price, reduceOnly: reduce });
  const problems = [...chk.problems];
  if (!reduce && cmp(chk.notional, MAX_NOTIONAL) > 0) problems.push(`notional ${chk.notional} exceeds OMNI_MAX_NOTIONAL ${MAX_NOTIONAL}`);
  if (READ_ONLY) problems.push("server is in read-only mode (OMNI_READ_ONLY=1)");
  if (PROD_BLOCKED) problems.push("mainnet trading is disabled; set OMNI_ALLOW_PROD=1 to enable");

  const slip = dec(a.max_slippage_pct / 100);
  const entry = Number(chk.price ?? t.mark_price);
  const child = (b: { price?: string; percent?: number } | undefined, kind: "tp" | "sl"): ChildOrder | undefined => {
    if (!b) return undefined;
    // Long: TP above, SL below. Short: mirrored.
    const dir = (a.side === "buy" ? 1 : -1) * (kind === "tp" ? 1 : -1);
    const px = b.price ?? String(entry * (1 + (dir * (b.percent ?? NaN)) / 100));
    if (!Number.isFinite(Number(px))) throw new Error(`${kind} needs price or percent`);
    const rounded = roundPrice(px, inst.price_precision);
    if ((Number(rounded) - entry) * dir <= 0) problems.push(`${kind === "tp" ? "take-profit" : "stop-loss"} ${rounded} is on the wrong side of entry ${entry}`);
    return { trigger_price: rounded, trigger_by: "mark", max_slippage: null };
  };
  const tp = child(a.take_profit, "tp"), sl = child(a.stop_loss, "sl");
  if ((tp || sl) && (a.type === "take_profit" || a.type === "stop_loss")) problems.push("brackets only attach to market/limit orders");

  const base = { symbol: inst.symbol, side: a.side, size: chk.size, client_order_id: newClientOrderId("mcp") };
  let order: PlaceOrder;
  if (a.type === "market") order = { ...base, type: "market", max_slippage: slip, reduce_only: a.reduce_only, take_profit: tp, stop_loss: sl };
  else if (a.type === "limit") order = { ...base, type: "limit", price: chk.price!, trigger_by: "mark", max_slippage: slip, reduce_only: a.reduce_only, take_profit: tp, stop_loss: sl };
  else order = { ...base, type: a.type, trigger_price: roundPrice(a.price!, inst.price_precision), trigger_by: "mark", max_slippage: slip };
  for (const k of ["take_profit", "stop_loss"] as const) if ((order as any)[k] === undefined) delete (order as any)[k];

  const summary = {
    environment: client.environment,
    order,
    mark_price: t.mark_price,
    index_price: t.index_price,
    notional_usdc: chk.notional,
    est_initial_margin_note: "depends on your configured leverage for this market",
  };
  if (problems.length) return { ok: false, problems, ...summary };
  const token = randomBytes(6).toString("hex");
  pending.set(token, { order, summary, expires: Date.now() + 120_000 });
  return { ok: true, confirm_token: token, expires_in_s: 120, ...summary };
}));

server.registerTool("omni_place_order", {
  title: "Place previewed order",
  description: "Send an order previously validated by omni_preview_order. Call this ONLY after the user explicitly approves that preview. Waits briefly and returns the final status.",
  inputSchema: { confirm_token: z.string() },
  annotations: { destructiveHint: true },
}, wrap(async ({ confirm_token }: { confirm_token: string }) => {
  const p = pending.get(confirm_token);
  if (!p || p.expires < Date.now()) throw new Error("Unknown or expired confirm_token; preview the order again");
  pending.delete(confirm_token);
  const placed = await client.placeOrder(p.order);
  const parent = placed[0].type === "market" ? await client.waitForOrder(placed[0].order_id, { timeoutMs: 8000 }) : placed[0];
  return { parent, attached: placed.slice(1), ...budget() };
}));

server.registerTool("omni_cancel", {
  title: "Cancel orders",
  description: "Cancel one order (order_id or client_order_id), all orders on a symbol, or every pending order (all=true).",
  inputSchema: {
    order_id: z.string().optional(),
    client_order_id: z.string().optional(),
    symbol: z.string().optional(),
    all: z.boolean().optional(),
  },
  annotations: { destructiveHint: true },
}, wrap(async (a: { order_id?: string; client_order_id?: string; symbol?: string; all?: boolean }) => {
  if (a.order_id) return client.cancelOrder({ order_id: a.order_id });
  if (a.client_order_id) return client.cancelOrder({ client_order_id: a.client_order_id });
  if (a.symbol) return { canceled: await client.cancelAll(normSymbol(a.symbol)) };
  if (a.all) return { canceled: await client.cancelAll() };
  throw new Error("Specify order_id, client_order_id, symbol, or all=true");
}));

server.registerTool("omni_close_position", {
  title: "Preview closing a position",
  description: "Build a reduce-only market order that closes all (or a percentage) of a position. Returns a preview with confirm_token; place it with omni_place_order after approval.",
  inputSchema: { symbol: z.string(), percent: z.number().min(1).max(100).default(100), max_slippage_pct: z.number().default(1) },
}, wrap(async (a: { symbol: string; percent: number; max_slippage_pct: number }) => {
  const inst = await instrument(a.symbol);
  const pos = await client.position(inst.symbol);
  const size = Number(pos.size);
  if (!size) throw new Error(`No open ${inst.symbol} position`);
  const chk = checkOrder(inst, { side: size > 0 ? "sell" : "buy", size: dec(Math.abs(size) * a.percent / 100), refPrice: pos.mark_price ?? "0", reduceOnly: true });
  const order: PlaceOrder = {
    type: "market", symbol: inst.symbol, side: size > 0 ? "sell" : "buy", size: chk.size,
    max_slippage: dec(a.max_slippage_pct / 100), reduce_only: true, client_order_id: newClientOrderId("mcp"),
  };
  const token = randomBytes(6).toString("hex");
  const summary = { environment: client.environment, order, position: pos };
  if (READ_ONLY || PROD_BLOCKED) return { ok: false, problems: [READ_ONLY ? "read-only mode" : "mainnet disabled"], ...summary };
  pending.set(token, { order, summary, expires: Date.now() + 120_000 });
  return { ok: true, confirm_token: token, ...summary, notes: chk.problems };
}));

server.registerTool("omni_rate_budget", {
  title: "Rate-limit budget",
  description: "Remaining API weight in the 60s sliding window (60 weight/min during early access).",
  inputSchema: {},
}, wrap(async () => ({ public_key: client.publicKey, environment: client.environment, base_url: client.baseUrl, ...budget() })));

await server.connect(new StdioServerTransport());
console.error(`variational-omni MCP ready (${client.environment}, key ${client.publicKey.slice(0, 10)}…, max notional ${MAX_NOTIONAL}${READ_ONLY ? ", read-only" : ""})`);
