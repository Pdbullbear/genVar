// Funding rates and quoted spreads from Omni's public stats feed — the same numbers the app shows
// when you hover a market's funding rate. No API key, and it doesn't use the trading API's weight.
// Docs: https://docs.variational.io/technical-documentation/api (GET /metadata/v2/stats)
//
// The documented host is mainnet's. Testnet markets mirror mainnet prices and funding (verified
// against the testnet app), so it is the default for both; set OMNI_STATS_URL to override.

export const STATS_URL = process.env.OMNI_STATS_URL ?? "https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/v2/stats";

interface PerpRate { annualized_rate: string; interval_rate: string }
interface SwapRate { annualized_long_rate: string; annualized_short_rate: string; interval_long_rate: string; interval_short_rate: string }
export interface StatsListing {
  ticker: string;
  contract_type: "perpetual" | "swap";
  name: string;
  mark_price: string;
  base_spread_bps: string;
  funding:
    | { last: PerpRate; next: PerpRate | null; interval_seconds: number; next_timestamp: number }
    | { last: SwapRate | null; next: SwapRate | null; interval_seconds: number; next_timestamp: number | null }
    | null;
}
export interface Stats { listings: StatsListing[] }

export async function fetchStats(url = STATS_URL, fetchImpl: typeof fetch = fetch): Promise<Stats> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (res.status === 429) {
    const body: any = await res.json().catch(() => ({}));
    throw new Error(`stats feed rate-limited; retry in ${body.retry_after_seconds ?? "a few"}s`);
  }
  if (!res.ok) throw new Error(`stats feed HTTP ${res.status}`);
  return (await res.json()) as Stats;
}

export interface PerpFunding {
  kind: "perp";
  /** Annualized rate as a fraction; positive: longs pay shorts. */
  annual: number;
  intervalSec: number;
  nextAt: number | null;
}
export interface SwapFunding {
  kind: "swap";
  /** Annualized, as fractions. Positive long rate: longs pay. Positive short rate: shorts receive. */
  longPays: number;
  shortReceives: number;
  nextAt: number | null;
  /** True when the upcoming payment is a weekend/holiday one (≈3× a regular day). */
  nextIsMultiDay: boolean;
}

const num = (s: string | undefined | null) => (s === undefined || s === null ? NaN : Number(s));

export function perpFunding(l: StatsListing): PerpFunding | null {
  const f = l.funding as any;
  if (!f || l.contract_type !== "perpetual") return null;
  const r = f.next ?? f.last;
  return { kind: "perp", annual: num(r?.annualized_rate), intervalSec: f.interval_seconds, nextAt: f.next_timestamp ? f.next_timestamp * 1000 : null };
}

/**
 * Swap funding normalised to a regular trading day. Payments covering weekends or holidays are
 * published at ≈3× ("annualized" over one payment), which would make carry look three times better
 * or worse than it is, so when one published rate is ≥2× the other the smaller one is used.
 */
export function swapFunding(l: StatsListing): SwapFunding | null {
  const f = l.funding as any;
  if (!f || l.contract_type !== "swap") return null;
  const pick = (k: "annualized_long_rate" | "annualized_short_rate") => {
    const n = num(f.next?.[k]), p = num(f.last?.[k]);
    if (Number.isFinite(n) && Number.isFinite(p) && Math.abs(n) > 0 && Math.abs(p) > 0) {
      const ratio = Math.abs(n) / Math.abs(p);
      if (ratio >= 2) return p;
      if (ratio <= 0.5) return n;
    }
    return Number.isFinite(n) ? n : p;
  };
  const n = num(f.next?.annualized_long_rate), p = num(f.last?.annualized_long_rate);
  return {
    kind: "swap", longPays: pick("annualized_long_rate"), shortReceives: pick("annualized_short_rate"),
    nextAt: f.next_timestamp ? f.next_timestamp * 1000 : null,
    nextIsMultiDay: Number.isFinite(n) && Number.isFinite(p) && Math.abs(p) > 0 && Math.abs(n) / Math.abs(p) >= 2,
  };
}

export function listing(stats: Stats, symbol: string) {
  return stats.listings.find((l) => l.ticker.toUpperCase() === symbol.toUpperCase()) ?? null;
}
