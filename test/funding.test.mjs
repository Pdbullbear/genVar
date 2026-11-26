import { test } from "node:test";
import assert from "node:assert/strict";
import { swapFunding, perpFunding } from "../dist/sdk/stats.js";
import { pairFunding } from "../dist/bot/dn/core.js";

const swap = (ticker, last, next, spread = "2") => ({ ticker, contract_type: "swap", base_spread_bps: spread, mark_price: "1",
  funding: { last: last && { annualized_long_rate: last[0], annualized_short_rate: last[1] }, next: next && { annualized_long_rate: next[0], annualized_short_rate: next[1] }, interval_seconds: 86400, next_timestamp: 1 } });
const perp = (ticker, annual, spread = "3") => ({ ticker, contract_type: "perpetual", base_spread_bps: spread, mark_price: "1",
  funding: { last: { annualized_rate: annual, interval_rate: "0" }, next: { annualized_rate: annual, interval_rate: "0" }, interval_seconds: 14400, next_timestamp: 1 } });

test("a tripled weekend payment doesn't inflate swap carry", () => {
  // Real feed values for XAU-SWAP: last = tripled Wednesday payment, next = a regular day.
  const f = swapFunding(swap("XAU-SWAP", ["0.1714", "0.07713"], ["0.05791", "0.02588"]));
  assert.equal(f.longPays, 0.05791);
  assert.equal(f.shortReceives, 0.02588);
  const g = swapFunding(swap("XAU-SWAP", ["0.05791", "0.02588"], ["0.1714", "0.07713"]));
  assert.equal(g.longPays, 0.05791);
  assert.equal(g.nextIsMultiDay, true);
});

test("perp funding: positive means longs pay", () => {
  assert.equal(perpFunding(perp("XAU-PERP", "0.04809")).annual, 0.04809);
});

test("carry for both directions matches the app's numbers (XAG)", () => {
  const f = pairFunding({ listings: [perp("XAG-PERP", "0", "6.37"), swap("XAG-SWAP", null, ["0.05658", "0.02323"], "5.2")] }, "XAG-PERP", "XAG-SWAP");
  assert.ok(Math.abs(f.carryAnnual.long_perp - 0.02323) < 1e-12);
  assert.ok(Math.abs(f.carryAnnual.short_perp - -0.05658) < 1e-12);
  assert.equal(f.best, "long_perp");
  assert.ok(Math.abs(f.roundTripBps - 11.57) < 0.01);
});

test("futures-roll swaps are flagged and never picked as best", () => {
  const f = pairFunding({ listings: [perp("CL-PERP", "0"), swap("USOIL-SWAP", null, ["-0.2051", "-0.2051"])] }, "CL-PERP", "USOIL-SWAP");
  assert.ok(f.carryAnnual.short_perp > 0.2);
  assert.equal(f.curveCarry, true);
  assert.equal(f.best, null);
});

test("a leg with no live quote gets a conservative cost, never NaN", () => {
  const closed = { ...swap("US500-SWAP", null, ["0.05", "0.03"]), base_spread_bps: null };
  const f = pairFunding({ listings: [perp("US500-PERP", "0.02", "3.8"), closed] }, "US500-PERP", "US500-SWAP");
  assert.ok(Number.isFinite(f.roundTripBps));
  assert.equal(f.roundTripBps, 13.8);
  assert.equal(f.spreadEstimated, true);
});
