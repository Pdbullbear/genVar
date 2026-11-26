import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, VolEstimator, planQuotes, diffQuotes } from "../dist/bot/mm/strategy.js";

const P = { ...DEFAULTS, minHalfSpreadBps: 10, skewBps: 10, maxPosUsd: 500, orderUsd: 100, levels: 1, requoteBps: 3 };
const bps = (px, fair) => ((px - fair) / fair) * 1e4;

test("flat inventory quotes symmetric around fair at the minimum spread", () => {
  const { quotes } = planQuotes(P, { fair: 100, sigma: null, posUsd: 0 });
  const b = quotes.find((q) => q.side === "buy"), s = quotes.find((q) => q.side === "sell");
  assert.ok(Math.abs(bps(b.price, 100) + 10) < 1e-9 && Math.abs(bps(s.price, 100) - 10) < 1e-9);
});

test("volatility widens the spread", () => {
  const sigma = 0.0005; // 5bp per √s → 1.5×5×√30 ≈ 41bp
  const { halfSpreadBps } = planQuotes(P, { fair: 100, sigma, posUsd: 0 });
  assert.ok(halfSpreadBps > 40 && halfSpreadBps < 42);
});

test("long inventory skews quotes down but never through fair", () => {
  const { quotes } = planQuotes({ ...P, skewBps: 50 }, { fair: 100, sigma: null, posUsd: 400 });
  const s = quotes.find((q) => q.side === "sell"), b = quotes.find((q) => q.side === "buy");
  assert.ok(bps(s.price, 100) >= 5 - 1e-9, "ask keeps half the min edge");
  assert.ok(bps(b.price, 100) < -10, "bid pushed further away");
});

test("at the cap only a reduce-only reducing quote remains", () => {
  const { quotes } = planQuotes(P, { fair: 100, sigma: null, posUsd: 600 });
  assert.deepEqual(quotes.map((q) => [q.side, q.reduceOnly]), [["sell", true]]);
});

test("bid size never takes inventory past the cap", () => {
  const { quotes } = planQuotes(P, { fair: 100, sigma: null, posUsd: 460 });
  const b = quotes.find((q) => q.side === "buy");
  assert.equal(b, undefined, "only 40$ room, below half an order → no bid");
  const { quotes: q2 } = planQuotes(P, { fair: 100, sigma: null, posUsd: 420 });
  assert.equal(q2.find((q) => q.side === "buy").usd, 80);
});

test("cooldown pauses one side", () => {
  const { quotes } = planQuotes(P, { fair: 100, sigma: null, posUsd: 0, paused: { buy: true } });
  assert.deepEqual(quotes.map((q) => q.side), ["sell"]);
});

test("diff keeps quotes inside the requote band and replaces the rest", () => {
  const want = planQuotes(P, { fair: 100, sigma: null, posUsd: 0 }).quotes;
  const live = [
    { order_id: "a", side: "buy", level: 0, price: 99.91 },  // 1bp from desired 99.90 → keep
    { order_id: "b", side: "sell", level: 0, price: 100.2 }, // 10bp off → replace
  ];
  const d = diffQuotes(P, live, want, 100);
  assert.deepEqual(d.keep.map((x) => x.order_id), ["a"]);
  assert.deepEqual(d.cancel.map((x) => x.order_id), ["b"]);
  assert.deepEqual(d.place.map((x) => x.side), ["sell"]);
});

test("vol estimator recovers a known per-second volatility", () => {
  const v = new VolEstimator(30);
  let p = 100, t = 0;
  const sigma = 0.0004;
  for (let i = 0; i < 4000; i++) {
    t += 2000; // 2s polls
    const z = Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());
    p *= Math.exp(sigma * Math.sqrt(2) * z);
    v.update(p, t);
  }
  assert.ok(Math.abs(v.sigma() / sigma - 1) < 0.35, `got ${v.sigma()}`);
});
