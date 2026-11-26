// Delta-neutral swap ⇄ perp arbitrage on Omni: pure logic (pairing, spread statistics, signals).
//
// Some underlyings trade on Omni as both a perpetual (24/7, crypto-style funding, cross margin) and a
// swap (TradFi liquidity, trading hours, SOFR-style funding, isolated margin only). Holding equal USD
// notional long one and short the other is delta-neutral: the underlying's moves cancel, leaving
//   1. the perp/swap price spread, which mean-reverts (they track the same asset), and
//   2. the funding difference between the two legs.
// The API exposes mark prices but not funding rates, so the spread is measured live while funding is
// configured from what the app shows, and checked afterwards against the positions' cum_funding.
import type { Instrument } from "../../sdk/index.js";

export type Kind = "perp" | "swap";

/** Swap products sometimes use a different code from the perp on the same underlying. */
export const ALIASES: Record<string, string> = {
  USOIL: "CL", WTI: "CL", UKOIL: "BZ", BRENT: "BZ", COPP: "COPPER", NTGAS: "NATGAS",
  GOLD: "XAU", SILVER: "XAG", SPX: "US500",
};
export const canonical = (u: string) => {
  const k = u.toUpperCase().replace(/[-_/ ]?(USD|USDC|PERP|SWAP)$/, "");
  return ALIASES[k] ?? k;
};

/**
 * Swaps are isolated-only and keep a trading schedule; perps are 24/7. Symbols are checked first
 * so an explicit "-PERP" / "-SWAP" suffix always wins over the heuristics.
 */
export function kindOf(i: Instrument): Kind {
  const s = i.symbol.toUpperCase();
  if (s.endsWith("-PERP")) return "perp";
  if (s.endsWith("-SWAP") || s.includes("SWAP")) return "swap";
  const isolatedOnly = i.margin_modes?.length === 1 && i.margin_modes[0] === "isolated";
  if (isolatedOnly || i.next_close_at != null) return "swap";
  return "perp";
}

export interface Pair {
  key: string;
  perp: Instrument;
  swap: Instrument;
}

export function discoverPairs(insts: Instrument[]): Pair[] {
  const by = new Map<string, { perp?: Instrument; swap?: Instrument }>();
  for (const i of insts) {
    const key = canonical(i.underlying || i.symbol);
    const slot = by.get(key) ?? {};
    const k = kindOf(i);
    // Prefer an instrument that isn't delisting if there are duplicates.
    if (!slot[k] || (slot[k]!.scheduled_delist_at && !i.scheduled_delist_at)) slot[k] = i;
    by.set(key, slot);
  }
  return [...by.entries()]
    .filter(([, v]) => v.perp && v.swap)
    .map(([key, v]) => ({ key, perp: v.perp!, swap: v.swap! }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * EWMA mean and variance of the log price ratio ln(perp / swap). Using the log ratio means pairs
 * whose legs trade at different price levels (an ETF-basket perp vs an index swap) work the same way.
 */
export class SpreadStats {
  // Exponentially weighted sums (S0 = Σw, S1 = Σw·x, S2 = Σw·x²) give an unbiased weighted mean from the
  // first sample on, unlike a plain EWMA whose first sample lingers for hours with a long half-life.
  // x is stored relative to the first observation to keep precision when the log ratio is far from 0.
  private S0 = 0;
  private S1 = 0;
  private S2 = 0;
  private offset: number | null = null;
  n = 0;
  lastT = 0;
  constructor(public halfLifeSec = 3600) {}

  get mean(): number | null {
    return this.offset === null || this.S0 === 0 ? null : this.offset + this.S1 / this.S0;
  }
  get variance(): number {
    if (this.S0 === 0) return 0;
    const m = this.S1 / this.S0;
    return Math.max(0, this.S2 / this.S0 - m * m);
  }

  update(logRatio: number, tMs: number) {
    if (this.offset === null) this.offset = logRatio;
    const dt = this.n ? Math.max(0, (tMs - this.lastT) / 1000) : 0;
    const decay = Math.pow(0.5, dt / this.halfLifeSec);
    const x = logRatio - this.offset;
    this.S0 = this.S0 * decay + 1;
    this.S1 = this.S1 * decay + x;
    this.S2 = this.S2 * decay + x * x;
    this.n++;
    this.lastT = tMs;
  }

  /** Deviation from the mean in bps (positive: perp rich vs swap). */
  devBps(logRatio: number) {
    const m = this.mean;
    return m === null ? 0 : (logRatio - m) * 1e4;
  }
  stdBps() {
    return Math.sqrt(this.variance) * 1e4;
  }
  z(logRatio: number) {
    const s = this.stdBps();
    return s > 0 ? this.devBps(logRatio) / s : 0;
  }
  toJSON() {
    return { S0: this.S0, S1: this.S1, S2: this.S2, offset: this.offset, n: this.n, lastT: this.lastT, halfLifeSec: this.halfLifeSec };
  }
  static from(j: any, halfLifeSec: number) {
    const s = new SpreadStats(halfLifeSec);
    if (j && typeof j.S0 === "number") Object.assign(s, { S0: j.S0, S1: j.S1, S2: j.S2, offset: j.offset, n: j.n, lastT: j.lastT });
    return s;
  }
}

/** Direction of a delta-neutral position, named by the perp leg. */
export type Dir = "short_perp" | "long_perp";

export interface Funding {
  /** Expected perp funding, % per 8h, as shown in the app. Positive: longs pay shorts. */
  perpPct8h: number;
  /** Swap daily funding for a long and for a short, % per day. Positive: that side pays. */
  swapLongPctDay: number;
  swapShortPctDay: number;
}

/** Expected carry of a DN position in bps per day of notional (positive = you earn). */
export function carryBpsPerDay(dir: Dir, f: Funding) {
  const perpDay = f.perpPct8h * 3 * 100; // bps/day paid by perp longs
  if (dir === "short_perp") return perpDay - f.swapLongPctDay * 100; // short perp receives, long swap pays its rate
  return -perpDay - f.swapShortPctDay * 100;
}

export interface SignalParams {
  entryZ: number;
  exitZ: number;
  /** Estimated cost to enter and exit both legs (four fills), in bps of one leg's notional. */
  roundTripBps: number;
  /** Extra edge required on top of costs. */
  minEdgeBps: number;
  /** Expected holding time used to value carry, in hours. */
  holdHours: number;
  minSamples: number;
}

export interface Signal {
  action: "enter" | "exit" | "hold" | "wait";
  dir?: Dir;
  reason: string;
  devBps: number;
  z: number;
  edgeBps: number;
}

/**
 * Entry when the spread is stretched both statistically (|z| ≥ entryZ) and economically: the expected
 * reversion (|dev|) plus expected carry over the hold must clear round-trip costs plus a margin.
 * Exit when the spread has reverted (|z| ≤ exitZ) or has flipped past the mean.
 */
export function signal(stats: SpreadStats, logRatio: number, p: SignalParams, f: Funding, open: Dir | null): Signal {
  const devBps = stats.devBps(logRatio), z = stats.z(logRatio);
  if (stats.n < p.minSamples) return { action: "wait", reason: `warming up ${stats.n}/${p.minSamples}`, devBps, z, edgeBps: 0 };
  if (open) {
    const reverted = Math.abs(z) <= p.exitZ || (open === "short_perp" ? devBps <= 0 : devBps >= 0);
    return reverted
      ? { action: "exit", dir: open, reason: `spread reverted (z ${z.toFixed(2)})`, devBps, z, edgeBps: 0 }
      : { action: "hold", dir: open, reason: `holding, z ${z.toFixed(2)}`, devBps, z, edgeBps: 0 };
  }
  const dir: Dir = devBps > 0 ? "short_perp" : "long_perp"; // sell the rich leg, buy the cheap one
  const carry = (carryBpsPerDay(dir, f) * p.holdHours) / 24;
  const edgeBps = Math.abs(devBps) + carry - p.roundTripBps;
  if (Math.abs(z) < p.entryZ) return { action: "hold", reason: `|z| ${Math.abs(z).toFixed(2)} < ${p.entryZ}`, devBps, z, edgeBps };
  if (edgeBps < p.minEdgeBps)
    return { action: "hold", reason: `edge ${edgeBps.toFixed(1)}bp < ${p.minEdgeBps}bp after ${p.roundTripBps}bp costs`, devBps, z, edgeBps };
  return { action: "enter", dir, reason: `z ${z.toFixed(2)}, dev ${devBps.toFixed(1)}bp, edge ${edgeBps.toFixed(1)}bp`, devBps, z, edgeBps };
}
