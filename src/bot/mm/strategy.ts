// Quoting math for the Omni market maker. Pure functions: no I/O, so they are easy to unit-test.
//
// Omni has no order book: a resting limit order fills, all-or-nothing, when the liquidity
// provider's (OLP's) quoted price crosses it. So "making" here means placing a bid and an ask
// around fair value and capturing the round trip when price oscillates through both. There are
// no trading fees. The risk is adverse selection: a trend fills one side and runs away from you.
// The defences are a volatility-scaled spread, inventory skew, per-side cooldown after a fill,
// and hard inventory and loss limits.

export interface MMParams {
  /** Minimum distance of each quote from fair value, in bps. Should exceed OLP's half-spread. */
  minHalfSpreadBps: number;
  /** Spread = max(min, volMult × σ × √horizon). */
  volMult: number;
  /** Expected holding horizon in seconds used to scale volatility. */
  horizonSec: number;
  /** At full inventory, shift both quotes this many bps against the position. */
  skewBps: number;
  /** Inventory cap in USD (absolute). Beyond it only the reducing side is quoted. */
  maxPosUsd: number;
  /** Notional per quote in USD. */
  orderUsd: number;
  /** Quote levels per side, and the gap between levels in bps. */
  levels: number;
  levelStepBps: number;
  /** Replace a resting quote only when the desired price moved more than this many bps. */
  requoteBps: number;
}

export const DEFAULTS: MMParams = {
  minHalfSpreadBps: 8,
  volMult: 1.5,
  horizonSec: 30,
  skewBps: 10,
  maxPosUsd: 500,
  orderUsd: 100,
  levels: 1,
  levelStepBps: 6,
  requoteBps: 3,
};

/** EWMA volatility of log returns, normalised per second so uneven poll intervals are fine. */
export class VolEstimator {
  private varPerSec: number | null = null;
  private last: { t: number; p: number } | null = null;
  samples = 0;
  constructor(private halfLifeSec = 120) {}

  update(price: number, tMs: number) {
    if (!(price > 0)) return;
    if (this.last && tMs > this.last.t) {
      const dt = (tMs - this.last.t) / 1000;
      const r = Math.log(price / this.last.p);
      const inst = (r * r) / dt;
      const alpha = 1 - Math.pow(0.5, dt / this.halfLifeSec);
      this.varPerSec = this.varPerSec === null ? inst : this.varPerSec + alpha * (inst - this.varPerSec);
      this.samples++;
    }
    if (!this.last || tMs > this.last.t) this.last = { t: tMs, p: price };
  }

  /** σ per √second as a fraction (0.0001 = 1bp), or null before the first return. */
  sigma(): number | null {
    return this.varPerSec === null ? null : Math.sqrt(this.varPerSec);
  }
  /** Expected 1-minute move in bps. */
  moveBps(seconds = 60): number | null {
    const s = this.sigma();
    return s === null ? null : s * Math.sqrt(seconds) * 1e4;
  }
}

export interface Quote {
  side: "buy" | "sell";
  level: number; // 0 = nearest
  price: number; // unrounded; round with the instrument's price_precision
  usd: number;
  reduceOnly: boolean;
}

export interface QuoteInputs {
  fair: number;
  sigma: number | null;
  posUsd: number; // signed: + long
  /** Sides currently paused (e.g. cooldown after a fill). */
  paused?: { buy?: boolean; sell?: boolean };
}

export interface QuotePlan {
  quotes: Quote[];
  halfSpreadBps: number;
  reservation: number;
  inventory: number; // -1..1
}

export function planQuotes(p: MMParams, i: QuoteInputs): QuotePlan {
  const volHalf = i.sigma === null ? 0 : p.volMult * i.sigma * Math.sqrt(p.horizonSec) * 1e4;
  const halfSpreadBps = Math.max(p.minHalfSpreadBps, volHalf);
  const inventory = Math.max(-1, Math.min(1, i.posUsd / p.maxPosUsd));
  // Long inventory pulls both quotes down: the ask becomes more likely to fill, the bid less.
  const reservation = i.fair * (1 - (inventory * p.skewBps) / 1e4);
  const quotes: Quote[] = [];
  // Never let skew push a quote through fair value: keep at least half the minimum edge.
  const floorBps = p.minHalfSpreadBps / 2;
  const longCapped = i.posUsd >= p.maxPosUsd;
  const shortCapped = i.posUsd <= -p.maxPosUsd;
  let buyRoom = p.maxPosUsd - i.posUsd;
  let sellRoom = p.maxPosUsd + i.posUsd;

  for (let k = 0; k < p.levels; k++) {
    const off = (halfSpreadBps + k * p.levelStepBps) / 1e4;
    const bid = Math.min(reservation * (1 - off), i.fair * (1 - floorBps / 1e4));
    const ask = Math.max(reservation * (1 + off), i.fair * (1 + floorBps / 1e4));

    if (!i.paused?.buy && !longCapped) {
      // When short, a bid reduces the position; size it so it can't flip us past the cap.
      const usd = Math.min(p.orderUsd, buyRoom);
      if (usd >= p.orderUsd * 0.5) {
        quotes.push({ side: "buy", level: k, price: bid, usd, reduceOnly: false });
        buyRoom -= usd;
      }
    }
    if (!i.paused?.sell && !shortCapped) {
      const usd = Math.min(p.orderUsd, sellRoom);
      if (usd >= p.orderUsd * 0.5) {
        quotes.push({ side: "sell", level: k, price: ask, usd, reduceOnly: false });
        sellRoom -= usd;
      }
    }
  }
  // At the cap, keep one reducing quote at the tightest allowed edge to work the inventory down.
  if (longCapped && !i.paused?.sell && !quotes.some((q) => q.side === "sell"))
    quotes.push({ side: "sell", level: 0, price: i.fair * (1 + floorBps / 1e4), usd: Math.min(p.orderUsd, i.posUsd), reduceOnly: true });
  if (shortCapped && !i.paused?.buy && !quotes.some((q) => q.side === "buy"))
    quotes.push({ side: "buy", level: 0, price: i.fair * (1 - floorBps / 1e4), usd: Math.min(p.orderUsd, -i.posUsd), reduceOnly: true });
  if (longCapped) for (const q of quotes) if (q.side === "sell") q.reduceOnly = true;
  if (shortCapped) for (const q of quotes) if (q.side === "buy") q.reduceOnly = true;
  return { quotes, halfSpreadBps, reservation, inventory };
}

export interface LiveQuote {
  order_id: string;
  side: "buy" | "sell";
  level: number;
  price: number;
}

/**
 * Diff resting quotes against the plan. A quote is kept when a desired quote on the same side and
 * level is within `requoteBps`; otherwise it is cancelled and the desired one placed. This hysteresis
 * is what keeps the bot inside 60 weight/min.
 */
export function diffQuotes(p: MMParams, live: LiveQuote[], want: Quote[], fair: number) {
  const keep: LiveQuote[] = [];
  const cancel: LiveQuote[] = [];
  const place: Quote[] = [];
  const matched = new Set<Quote>();
  for (const l of live) {
    const w = want.find((q) => !matched.has(q) && q.side === l.side && q.level === l.level);
    if (w && (Math.abs(w.price - l.price) / fair) * 1e4 <= p.requoteBps) {
      keep.push(l);
      matched.add(w);
    } else cancel.push(l);
  }
  for (const w of want) if (!matched.has(w)) place.push(w);
  return { keep, cancel, place };
}
