// End-to-end: drive the MCP server over stdio against a mock exchange.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { start } from "../dist/mock/server.js";

const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { err: !!r.isError, data: (() => { try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; } })() };
};

test("MCP: markets, preview, place with brackets, close, guardrails", async () => {
  const srv = await start(0);
  const transport = new StdioClientTransport({
    command: "node", args: ["dist/mcp/server.js"],
    env: { ...process.env, OMNI_PRIVATE_KEY: "0x" + "77".repeat(32), OMNI_BASE_URL: `http://127.0.0.1:${srv.address().port}`, OMNI_MAX_NOTIONAL: "2000" },
  });
  const c = new Client({ name: "test", version: "0" });
  await c.connect(transport);
  try {
    const tools = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes("omni_preview_order") && tools.includes("omni_place_order"));

    const m = await call(c, "omni_markets", { symbols: ["btc", "doge"] });
    assert.equal(m.data.markets.length, 2);

    const big = await call(c, "omni_preview_order", { symbol: "btc", side: "buy", notional_usd: 5000 });
    assert.equal(big.data.ok, false);
    assert.match(big.data.problems.join(), /OMNI_MAX_NOTIONAL/);

    const p = await call(c, "omni_preview_order", { symbol: "eth", side: "buy", notional_usd: 500, take_profit: { percent: 3 }, stop_loss: { percent: 1.5 } });
    assert.equal(p.data.ok, true, JSON.stringify(p.data));
    assert.ok(Number(p.data.order.take_profit.trigger_price) > Number(p.data.mark_price));
    assert.ok(Number(p.data.order.stop_loss.trigger_price) < Number(p.data.mark_price));

    const bad = await call(c, "omni_place_order", { confirm_token: "nope" });
    assert.equal(bad.err, true);

    const placed = await call(c, "omni_place_order", { confirm_token: p.data.confirm_token });
    assert.equal(placed.data.parent.status, "filled", JSON.stringify(placed.data));
    assert.equal(placed.data.attached.length, 2);
    const reuse = await call(c, "omni_place_order", { confirm_token: p.data.confirm_token });
    assert.equal(reuse.err, true, "token is single-use");

    const acct = await call(c, "omni_account");
    assert.equal(acct.data.positions[0].symbol, "ETH-PERP");

    const close = await call(c, "omni_close_position", { symbol: "ETH" });
    const closed = await call(c, "omni_place_order", { confirm_token: close.data.confirm_token });
    assert.equal(closed.data.parent.status, "filled");
    const after = await call(c, "omni_account");
    assert.equal(after.data.positions.length, 0);

    const lim = await call(c, "omni_preview_order", { symbol: "sol", side: "buy", type: "limit", price: "100", size: "1" });
    await call(c, "omni_place_order", { confirm_token: lim.data.confirm_token });
    const o = await call(c, "omni_orders", {});
    assert.equal(o.data.orders.length, 1);
    const cx = await call(c, "omni_cancel", { all: true });
    assert.ok(cx.data.canceled.length >= 1);
    const b = await call(c, "omni_rate_budget");
    console.log("budget after scenario:", b.data.weight_remaining, "/", b.data.weight_limit);
  } finally {
    await c.close();
    srv.close();
  }
});
