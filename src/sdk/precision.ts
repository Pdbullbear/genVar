// Exact decimal helpers for Omni's order rules (price_precision, size_step, min_notional).
// Uses BigInt fixed-point so "0.1" + "0.2" style float drift never reaches a signed order.
import type { Instrument, PricePrecision } from "./types.js";

export type Rounding = "down" | "up" | "nearest";

function splitDec(s: string): { neg: boolean; int: string; frac: string } {
  const str = String(s).trim();
  if (!/^-?\d+(\.\d+)?$/.test(str)) throw new Error(`Not a plain decimal: ${s}`);
  const neg = str.startsWith("-");
  const [int, frac = ""] = str.replace("-", "").split(".");
  return { neg, int: int.replace(/^0+(?=\d)/, ""), frac };
}

/** Decimal string -> BigInt scaled by 10^scale, rounding per mode. */
export function toScaled(s: string, scale: number, mode: Rounding = "nearest"): bigint {
  const { neg, int, frac } = splitDec(s);
  const kept = (frac + "0".repeat(scale)).slice(0, scale);
  const rest = frac.slice(scale);
  let v = BigInt(int + kept || "0");
  const restNonZero = /[1-9]/.test(rest);
  const absMode = neg ? (mode === "up" ? "down" : mode === "down" ? "up" : mode) : mode;
  if (restNonZero) {
    if (absMode === "up") v += 1n;
    else if (absMode === "nearest" && Number(rest[0]) >= 5) v += 1n;
  }
  return neg ? -v : v;
}

export function fromScaled(v: bigint, scale: number): string {
  const neg = v < 0n;
  let digits = (neg ? -v : v).toString().padStart(scale + 1, "0");
  const int = digits.slice(0, digits.length - scale);
  const frac = scale ? digits.slice(digits.length - scale).replace(/0+$/, "") : "";
  return (neg && (int !== "0" || frac) ? "-" : "") + int + (frac ? "." + frac : "");
}

/** Normalises a number or string into a plain decimal string (no exponent). */
export function dec(x: number | string): string {
  if (typeof x === "string") return fromScaled(toScaled(x, 12), 12);
  if (!Number.isFinite(x)) throw new Error(`Not finite: ${x}`);
  return fromScaled(toScaled(x.toFixed(12), 12), 12);
}

/** How many decimal places a price may carry under the instrument's rules. */
export function allowedPriceDecimals(price: string, pp: PricePrecision): number {
  const { int, frac } = splitDec(price);
  if (int === "0") {
    // Below 1: max_decimal_only_figures significant digits; leading zeros don't count.
    const leadingZeros = (frac.match(/^0*/)?.[0].length ?? 0);
    return leadingZeros + pp.max_decimal_only_figures;
  }
  return Math.max(pp.min_decimal_figures, pp.max_significant_figures - int.length);
}

/** Rounds a price to the precision Omni accepts. Use "down" for buys and "up" for sells to stay passive. */
export function roundPrice(price: number | string, pp: PricePrecision, mode: Rounding = "nearest"): string {
  const p = dec(price);
  if (p.startsWith("-")) throw new Error("Price must be positive");
  // Two passes: rounding can carry into a new integer digit (e.g. 9.999 -> 10.00).
  let d = allowedPriceDecimals(p, pp);
  let out = fromScaled(toScaled(p, d, mode), d);
  const d2 = allowedPriceDecimals(out === "0" ? p : out, pp);
  if (d2 < d) out = fromScaled(toScaled(p, d2, mode), d2);
  return out;
}

function scaleOf(s: string): number {
  return splitDec(s).frac.length;
}

/** Rounds a size down (by default) to a multiple of size_step. */
export function roundSize(size: number | string, step: string, mode: Rounding = "down"): string {
  const S = 12;
  const stepU = toScaled(step, S);
  if (stepU <= 0n) throw new Error(`Bad size_step ${step}`);
  const sizeU = toScaled(dec(size), S, "down");
  let q = sizeU / stepU;
  const r = sizeU % stepU;
  if (r !== 0n && (mode === "up" || (mode === "nearest" && r * 2n >= stepU))) q += 1n;
  return fromScaled(q * stepU, S);
}

export function mul(a: string, b: string): string {
  const sa = scaleOf(dec(a)), sb = scaleOf(dec(b));
  return fromScaled(toScaled(a, sa) * toScaled(b, sb), sa + sb);
}

export function cmp(a: string, b: string): number {
  const x = toScaled(a, 12), y = toScaled(b, 12);
  return x === y ? 0 : x < y ? -1 : 1;
}

export interface PreparedOrderCheck {
  price?: string;
  size: string;
  notional: string;
  problems: string[];
}

/**
 * Applies an instrument's rules to a proposed size/price: rounds both and reports
 * anything the API would reject (below_min_notional, close_only, market closed, ...).
 */
export function checkOrder(
  inst: Instrument,
  opts: { side: "buy" | "sell"; size: number | string; price?: number | string; refPrice: string; reduceOnly?: boolean },
): PreparedOrderCheck {
  const problems: string[] = [];
  const price =
    opts.price !== undefined
      ? roundPrice(opts.price, inst.price_precision, opts.side === "buy" ? "down" : "up")
      : undefined;
  let size = dec(opts.size);
  if (inst.size_step) size = roundSize(size, inst.size_step, "down");
  else problems.push("instrument has no size_step yet (no price available)");
  if (cmp(size, "0") <= 0) problems.push(`size rounds to 0 with size_step ${inst.size_step}`);
  const notional = mul(size, price ?? opts.refPrice);
  if (cmp(notional, inst.min_notional) < 0)
    problems.push(`notional ${notional} USDC is below min_notional ${inst.min_notional}`);
  if (inst.close_only && !opts.reduceOnly) problems.push(`${inst.symbol} is close-only: use reduce_only`);
  if (inst.status && inst.status !== "open") problems.push(`${inst.symbol} market status is ${inst.status}`);
  return { price, size, notional, problems };
}
