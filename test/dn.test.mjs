import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, kindOf, discoverPairs, SpreadStats, carryBpsPerDay, signal } from "../dist/bot/dn/core.js";

const inst = (symbol, underlying, extra = {}) => ({ symbol, underlying, margin_modes: ["cross", "isolated"], next_close_at: null, ...extra });

test("classifies swaps (isolated-only or scheduled) vs perps", () => {
  assert.equal(kindOf(inst("XAU-PERP", "XAU")), "perp");
  assert.equal(kindOf(inst("XAU", "XAU", { margin_modes: ["isolated"] })), "swap");
  assert.equal(kindOf(inst("US500", "US500", { next_close_at: 1 })), "swap");
  assert.equal(kindOf(inst("XAU-SWAP", "XAU")), "swap");
});

test("pairs by underlying, including aliased codes", () => {
  assert.equal(canonical("USOIL"), "CL");
  assert.equal(canonical("COPP"), "COPPER");
  const pairs = discoverPairs([
    inst("XAU-PERP", "XAU"), inst("XAU", "XAU", { margin_modes: ["isolated"] }),
    inst("CL-PERP", "CL"), inst("USOIL", "USOIL", { margin_modes: ["isolated"] }),
    inst("BTC-PERP", "BTC"),
  ]);
  assert.deepEqual(pairs.map((p) => [p.key, p.perp.symbol, p.swap.symbol]), [["CL", "CL-PERP", "USOIL"], ["XAU", "XAU-PERP", "XAU"]]);
});

test("SPX-PERP (a token) is not paired with the US500 swap; US500-PERP is preferred", () => {
  const pairs = discoverPairs([
    inst("SPX-PERP", "SPX"), inst("US500-SWAP", "US500", { margin_modes: ["isolated"] }),
  ]);
  assert.equal(pairs.length, 0);
  const p2 = discoverPairs([
    inst("SPX6900-PERP", "US500"), inst("US500-PERP", "US500"), inst("US500-SWAP", "US500", { margin_modes: ["isolated"] }),
  ]);
  assert.equal(p2[0].perp.symbol, "US500-PERP");
});

test("spread stats work on log ratio, so different price levels are fine", () => {
  const s = new SpreadStats(60);
  for (let i = 0; i < 200; i++) s.update(Math.log(690 / 6900) + (i % 2 ? 1 : -1) * 0.001, i * 1000);
  assert.ok(Math.abs(s.devBps(Math.log(690 / 6900))) < 1.5);
  assert.ok(s.stdBps() > 8 && s.stdBps() < 12, `std ${s.stdBps()}`);
});

test("carry: short perp earns positive perp funding and pays the swap long rate", () => {
  const f = { perpPct8h: 0.01, swapLongPctDay: 0.012, swapShortPctDay: -0.005 };
  assert.ok(Math.abs(carryBpsPerDay("short_perp", f) - 1.8) < 1e-9); // 3×1bp − 1.2bp
  assert.ok(Math.abs(carryBpsPerDay("long_perp", f) - -2.5) < 1e-9); // −3bp + 0.5bp
});

const P = { entryZ: 2, exitZ: 0.5, roundTripBps: 20, minEdgeBps: 5, holdHours: 4, minSamples: 10 };
const F0 = { perpPct8h: 0, swapLongPctDay: 0, swapShortPctDay: 0 };
function stats(stdBps) {
  const s = new SpreadStats(600);
  for (let i = 0; i < 400; i++) s.update((i % 2 ? 1 : -1) * stdBps / 1e4, i * 1000);
  return s;
}

test("enters short perp when perp is rich and the edge beats costs", () => {
  const sig = signal(stats(10), 30 / 1e4, P, F0, null);
  assert.equal(sig.action, "enter");
  assert.equal(sig.dir, "short_perp");
});

test("a stretched but small spread is rejected on costs", () => {
  const sig = signal(stats(5), -15 / 1e4, P, F0, null); // z ≈ −3 but 15bp < 20bp costs
  assert.equal(sig.action, "hold");
  assert.match(sig.reason, /costs/);
});

test("exits on reversion or when the spread flips through the mean", () => {
  assert.equal(signal(stats(10), 2 / 1e4, P, F0, "short_perp").action, "exit");
  assert.equal(signal(stats(10), -12 / 1e4, P, F0, "short_perp").action, "exit");
  assert.equal(signal(stats(10), 15 / 1e4, P, F0, "short_perp").action, "hold");
});

test("waits until enough samples", () => {
  const s = new SpreadStats(60);
  s.update(0, 0);
  assert.equal(signal(s, 0.01, P, F0, null).action, "wait");
});
