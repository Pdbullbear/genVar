// Password login for remote access without Cloudflare Access (the free quick-tunnel mode).
// The password is stored only as a salted scrypt hash; sessions are random IDs in an HttpOnly,
// Secure, SameSite=Strict cookie; failed logins are rate-limited per address and globally.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 1 << 15, R = 8, P = 1, KEYLEN = 32, MAXMEM = 64 * 1024 * 1024;
export const MIN_PASSWORD_LENGTH = 12;

/** Returns "scrypt$N$r$p$salt$hash" (base64). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, n, r, p, salt, hash] = stored.trim().split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = scryptSync(String(password).normalize("NFKC"), Buffer.from(salt, "base64"), want.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Brute-force protection: per-address lockout plus a global circuit breaker. */
export class LoginLimiter {
  private perIp = new Map<string, number[]>();
  private global: number[] = [];
  private lockedUntil = 0;
  constructor(
    private perIpMax = 5, private perIpWindowMs = 15 * 60_000,
    private globalMax = 20, private globalWindowMs = 60 * 60_000, private globalLockMs = 60 * 60_000,
  ) {}

  /** Null if the attempt may proceed, otherwise how many seconds to wait. */
  check(ip: string, now = Date.now()): number | null {
    if (now < this.lockedUntil) return Math.ceil((this.lockedUntil - now) / 1000);
    const f = (this.perIp.get(ip) ?? []).filter((t) => now - t < this.perIpWindowMs);
    this.perIp.set(ip, f);
    if (f.length >= this.perIpMax) return Math.ceil((f[0] + this.perIpWindowMs - now) / 1000);
    return null;
  }
  fail(ip: string, now = Date.now()) {
    (this.perIp.get(ip) ?? this.perIp.set(ip, []).get(ip)!).push(now);
    this.global = this.global.filter((t) => now - t < this.globalWindowMs);
    this.global.push(now);
    if (this.global.length >= this.globalMax) this.lockedUntil = now + this.globalLockMs;
  }
  succeed(ip: string) {
    this.perIp.delete(ip);
  }
}

export class Sessions {
  private s = new Map<string, number>(); // id -> expiry
  constructor(private ttlMs = 12 * 3600_000) {}
  create(now = Date.now()) {
    const id = randomBytes(32).toString("base64url");
    this.s.set(id, now + this.ttlMs);
    for (const [k, exp] of this.s) if (exp < now) this.s.delete(k);
    return { id, maxAgeSec: Math.floor(this.ttlMs / 1000) };
  }
  valid(id: string | null, now = Date.now()) {
    if (!id) return false;
    const exp = this.s.get(id);
    if (!exp || exp < now) { this.s.delete(id ?? ""); return false; }
    return true;
  }
  destroy(id: string | null) {
    if (id) this.s.delete(id);
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Login page in the panel's halftone style (no external scripts). */
export function loginPage(message = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Omni DN Desk · Log in</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fragment+Mono&family=Instrument+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
:root { --bg:#0a0b0c; --panel:#0e1012; --line:rgba(255,255,255,.08); --line2:rgba(255,255,255,.16); --text:#e1e5e5; --muted:#929699; --accent:#3e8fb3; --red:#d0675b; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text); font:14px/1.5 "Instrument Sans", system-ui, sans-serif; padding:16px; }
body::before { content:""; position:fixed; inset:0; z-index:-1; background-image:radial-gradient(rgba(255,255,255,.07) 1px, transparent 1.3px); background-size:7px 7px;
  -webkit-mask-image:radial-gradient(ellipse 70% 60% at 50% 40%, #000, transparent 70%); mask-image:radial-gradient(ellipse 70% 60% at 50% 40%, #000, transparent 70%); }
form { width:100%; max-width:360px; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:28px; display:grid; gap:16px; }
.brand { display:flex; align-items:center; gap:10px; font-size:18px; font-weight:500; }
.brand i { width:14px; height:14px; background:var(--text); display:inline-block; }
h1 { margin:0; font-weight:500; font-size:30px; letter-spacing:-.02em; line-height:1.1; }
label { display:grid; gap:6px; font:11px "Fragment Mono", monospace; color:var(--muted); }
input { font:15px "Instrument Sans", sans-serif; padding:10px 12px; border-radius:4px; border:1px solid var(--line2); background:#131619; color:var(--text); }
input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(62,143,179,.14); }
button { font:500 14px "Instrument Sans", sans-serif; border-radius:999px; border:0; background:var(--text); color:var(--bg); padding:11px; cursor:pointer; }
.msg { color:var(--red); font-size:13px; min-height:1em; }
.hint { color:var(--muted); font-size:12px; }
</style></head><body>
<form method="post" action="/login" autocomplete="on">
  <div class="brand"><i></i>omni-kit</div>
  <h1>Log in to the desk.</h1>
  <label>Password <input type="password" name="password" autocomplete="current-password" required autofocus></label>
  <button type="submit">Log in</button>
  <div class="msg">${esc(message)}</div>
  <div class="hint">Set with <code>npm run web:password</code> on the machine running the panel.</div>
</form></body></html>`;
}
