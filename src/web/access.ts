// Verifies Cloudflare Access login tokens (the Cf-Access-Jwt-Assertion header Cloudflare adds to every
// request it lets through to the origin). Checking it here as well as at Cloudflare means a tunnel that
// is ever misconfigured without an Access policy still can't reach the panel.
// Docs: https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
import { createPublicKey, verify, type KeyObject } from "node:crypto";

export interface AccessConfig {
  /** Your Zero Trust team domain, e.g. "myteam.cloudflareaccess.com". */
  teamDomain: string;
  /** The Access application's Audience (AUD) tag. */
  aud: string;
  /** Override for tests; defaults to fetching https://<teamDomain>/cdn-cgi/access/certs. */
  fetchJwks?: () => Promise<{ keys: any[] }>;
}

export interface AccessIdentity { email: string | null; sub: string | null; exp: number }

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function createAccessVerifier(cfg: AccessConfig) {
  const team = cfg.teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const issuer = `https://${team}`;
  const fetchJwks = cfg.fetchJwks ?? (async () => {
    const r = await fetch(`${issuer}/cdn-cgi/access/certs`);
    if (!r.ok) throw new Error(`Access certs HTTP ${r.status}`);
    return (await r.json()) as { keys: any[] };
  });
  let keys = new Map<string, KeyObject>();
  let loadedAt = 0;

  async function keyFor(kid: string) {
    // Cloudflare rotates signing keys; refresh hourly, or at once when an unknown kid shows up.
    if (!keys.has(kid) || Date.now() - loadedAt > 3600_000) {
      if (Date.now() - loadedAt < 10_000 && !keys.has(kid)) throw new Error("unknown signing key");
      const jwks = await fetchJwks();
      keys = new Map(jwks.keys.filter((k) => k.kid && k.kty === "RSA").map((k) => [k.kid, createPublicKey({ key: k, format: "jwk" })]));
      loadedAt = Date.now();
    }
    const k = keys.get(kid);
    if (!k) throw new Error("unknown signing key");
    return k;
  }

  return async function verifyAccess(token: string | undefined | null): Promise<AccessIdentity> {
    if (!token) throw new Error("missing Cloudflare Access token");
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("malformed token");
    let header: any, payload: any;
    try {
      header = JSON.parse(b64url(parts[0]).toString("utf8"));
      payload = JSON.parse(b64url(parts[1]).toString("utf8"));
    } catch {
      throw new Error("malformed token");
    }
    if (header.alg !== "RS256") throw new Error(`unexpected alg ${header.alg}`);
    const key = await keyFor(String(header.kid ?? ""));
    const ok = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, b64url(parts[2]));
    if (!ok) throw new Error("bad signature");
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp < now - 30) throw new Error("token expired");
    if (typeof payload.nbf === "number" && payload.nbf > now + 30) throw new Error("token not yet valid");
    const auds: string[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(cfg.aud)) throw new Error("token is for a different application");
    if (payload.iss !== issuer) throw new Error("token from a different team");
    return { email: payload.email ?? null, sub: payload.sub ?? null, exp: payload.exp };
  };
}

/** Reads one cookie from a Cookie header. */
export function cookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
