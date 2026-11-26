// Ed25519 request signing for the Variational Omni API, using only node:crypto.
// Spec: https://docs.variational.io/api-documentation/authentication
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

export const SCHEME = "variational-omni-api/v1";

// DER prefixes that wrap a raw 32-byte Ed25519 seed / public key for node:crypto.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Parses a 32-byte hex seed, with or without a `0x` prefix. */
export function parseSeed(hex: string): Buffer {
  const clean = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error("Private key must be 32 bytes of hex (64 hex characters, optional 0x prefix)");
  }
  return Buffer.from(clean, "hex");
}

export function privateKeyObject(seed: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

/** `0x` + lowercase hex of the raw 32-byte public key: the value of `x-variational-key`. */
export function publicKeyHex(seed: Uint8Array): string {
  const der = createPublicKey(privateKeyObject(seed)).export({ format: "der", type: "spki" });
  return "0x" + der.subarray(der.length - 32).toString("hex");
}

export function sha256Hex(body: Uint8Array | string): string {
  return createHash("sha256").update(body).digest("hex");
}

export interface CanonicalInput {
  environment: string; // "testnet" | "prod"
  key: string;
  timestampMs: number | string;
  method: string;
  pathAndQuery: string; // exactly as sent, including /v1
  body: Uint8Array | string;
}

export function canonicalString(i: CanonicalInput): string {
  return [
    SCHEME,
    i.environment,
    i.key,
    String(i.timestampMs),
    i.method.toUpperCase(),
    i.pathAndQuery,
    sha256Hex(i.body),
  ].join("\n");
}

export type SignedHeaders = {
  "x-variational-key": string;
  "x-request-timestamp-ms": string;
  "x-variational-signature": string;
};

export class Signer {
  readonly publicKey: string;
  private readonly key: KeyObject;

  constructor(seed: Uint8Array | string, readonly environment: string) {
    const s = typeof seed === "string" ? parseSeed(seed) : Buffer.from(seed);
    this.key = privateKeyObject(s);
    this.publicKey = publicKeyHex(s);
  }

  sign(method: string, pathAndQuery: string, body: Uint8Array | string, timestampMs: number): SignedHeaders {
    const canonical = canonicalString({
      environment: this.environment,
      key: this.publicKey,
      timestampMs,
      method,
      pathAndQuery,
      body,
    });
    const sig = sign(null, Buffer.from(canonical), this.key);
    return {
      "x-variational-key": this.publicKey,
      "x-request-timestamp-ms": String(timestampMs),
      "x-variational-signature": "0x" + sig.toString("hex"),
    };
  }
}

/** Server-side verification (used by the mock exchange and the tests). */
export function verifySignature(publicKey: string, canonical: string, signatureHex: string): boolean {
  try {
    const raw = Buffer.from(publicKey.replace(/^0x/, ""), "hex");
    const sig = Buffer.from(signatureHex.replace(/^0x/, ""), "hex");
    if (raw.length !== 32 || sig.length !== 64) return false;
    const pub = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(canonical), pub, sig);
  } catch {
    return false;
  }
}
