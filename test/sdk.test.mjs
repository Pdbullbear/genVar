import { test } from "node:test";
import assert from "node:assert/strict";
import { Signer, publicKeyHex, parseSeed, canonicalString, roundPrice, roundSize, checkOrder, OmniClient } from "../dist/sdk/index.js";
import { start } from "../dist/mock/server.js";

test("signing matches the official test vector", () => {
  const seed = parseSeed("0x" + "33".repeat(32));
  assert.equal(publicKeyHex(seed), "0x17cb79fb2b4120f2b1ec65e4198d6e08b28e813feb01e4a400839b85e18080ce");
  const h = new Signer(seed, "test").sign("GET", "/v1/orders?limit=10&symbol=BTC-PERP", "", 1790000000123);
  assert.equal(h["x-variational-signature"], "0x9f0fd3388c95fcd9ee6e581a03a4757fbd4aeec8cb103731b98e9800e5f9e73ae9c35db7ce6d8df1918a6a3257dd308999f3c695af1670b7d21372b7bf3b600b");
});

test("price precision rules", () => {
  const pp = { min_decimal_figures: 2, max_decimal_only_figures: 5, max_significant_figures: 6 };
  assert.equal(roundPrice("95123.456", pp, "down"), "95123.45"); // min 2 decimals even above 6 sig figs
  assert.equal(roundPrice("3512.34567", pp), "3512.35");
  assert.equal(roundPrice("12.3456789", pp), "12.3457");
  assert.equal(roundPrice("0.000123456789", pp), "0.00012346");
  assert.equal(roundPrice(0.18123456, pp, "up"), "0.18124");
  assert.equal(roundPrice("9.9999999", pp), "10");
});

test("size step rounding", () => {
  assert.equal(roundSize("0.0123456", "0.00001"), "0.01234");
  assert.equal(roundSize(1.999, "0.5"), "1.5");
  assert.equal(roundSize("1.75", "0.5", "nearest"), "2");
  assert.equal(roundSize("37", "5"), "35");
});

test("checkOrder flags min notional", () => {
  const inst = { symbol: "X", price_precision: { min_decimal_figures: 2, max_decimal_only_figures: 5, max_significant_figures: 6 }, size_step: "0.001", min_notional: "10", close_only: false, status: "open" };
  const r = checkOrder(inst, { side: "buy", size: "0.0001", refPrice: "50000" });
  assert.equal(r.size, "0");
  assert.ok(r.problems.length >= 2);
});

test("client round-trips against the mock exchange", async () => {
  const srv = await start(0);
  const port = srv.address().port;
  const c = new OmniClient({ privateKey: "0x" + "42".repeat(32), baseUrl: `http://127.0.0.1:${port}` });
  try {
    assert.equal((await c.status()).status, "ok");
    const [btc] = (await c.instruments()).filter((i) => i.symbol === "BTC-PERP");
    const t = await c.ticker("BTC-PERP");
    const chk = checkOrder(btc, { side: "buy", size: "0.01", refPrice: t.mark_price });
    assert.deepEqual(chk.problems, []);
    const placed = await c.placeOrder({
      type: "market", symbol: "BTC-PERP", side: "buy", size: chk.size, max_slippage: "0.01",
      stop_loss: { trigger_price: roundPrice(Number(t.mark_price) * 0.9, btc.price_precision), trigger_by: "mark", max_slippage: null },
    });
    assert.equal(placed.length, 2);
    const filled = await c.waitForOrder(placed[0].order_id, { intervalMs: 200 });
    assert.equal(filled.status, "filled");
    const pos = await c.position("BTC-PERP");
    assert.equal(pos.size, "0.01");
    const open = await c.openOrders();
    assert.equal(open[0].status, "untriggered");
    // idempotent retry with same client id resolves to the existing order
    const again = await c.placeOrder({ type: "market", symbol: "BTC-PERP", side: "buy", size: "0.01", max_slippage: "0.01", client_order_id: placed[0].client_order_id });
    assert.equal(again[0].order_id, placed[0].order_id);
    const canceled = await c.cancelAll();
    assert.equal(canceled.length, 1); // the attached stop-loss
    const fills = await c.fills({ limit: 1 });
    assert.equal(fills.results.length, 1);
    assert.ok(c.budget.remaining !== null && c.budget.remaining < 60);
  } finally {
    srv.close();
  }
});

test("bad signature is rejected", async () => {
  const srv = await start(0);
  const port = srv.address().port;
  const c = new OmniClient({ privateKey: "0x" + "42".repeat(32), baseUrl: `http://127.0.0.1:${port}`, environment: "prod" });
  try {
    await assert.rejects(c.status(), /invalid_signature/);
  } finally { srv.close(); }
});
