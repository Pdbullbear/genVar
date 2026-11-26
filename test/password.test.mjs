import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword, verifyPassword, LoginLimiter, Sessions } from "../dist/web/password.js";

test("scrypt hash verifies only the right password", () => {
  const h = hashPassword("correct horse battery");
  assert.match(h, /^scrypt\$/);
  assert.ok(!h.includes("correct horse"));
  assert.equal(verifyPassword("correct horse battery", h), true);
  assert.equal(verifyPassword("correct horse batterY", h), false);
  assert.notEqual(hashPassword("correct horse battery"), h, "salted");
});

test("limiter locks an address after 5 failures and everyone after 20", () => {
  const l = new LoginLimiter();
  for (let i = 0; i < 5; i++) { assert.equal(l.check("a", 1000), null); l.fail("a", 1000); }
  assert.ok(l.check("a", 1000) > 0);
  assert.equal(l.check("b", 1000), null);
  assert.equal(l.check("a", 1000 + 16 * 60_000), null, "per-address lock expires");
  const g = new LoginLimiter();
  for (let i = 0; i < 20; i++) g.fail(`ip${i}`, 5000);
  assert.ok(g.check("fresh", 5000) > 0, "global breaker");
});

test("sessions expire and can be destroyed", () => {
  const s = new Sessions(1000);
  const { id } = s.create(0);
  assert.equal(s.valid(id, 500), true);
  assert.equal(s.valid(id, 1500), false);
  const b = s.create(2000).id; s.destroy(b);
  assert.equal(s.valid(b, 2001), false);
  assert.equal(s.valid(null), false);
});

test("panel: remote password login flow end to end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-"));
  const pwFile = join(dir, "pw"); writeFileSync(pwFile, hashPassword("tunnel passphrase 42"));
  const HOST = "abc-def.trycloudflare.com", PORT = "8799";
  const srv = spawn(process.execPath, ["dist/web/server.js"], { env: { ...process.env, WEB_PORT: PORT, WEB_PUBLIC_HOST: HOST, WEB_AUTH: "password", WEB_PASSWORD_FILE: pwFile,
    OMNI_PRIVATE_KEY: "0x" + "91".repeat(32), OMNI_BASE_URL: "http://127.0.0.1:1", WEB_TOKEN: "f".repeat(48) }, stdio: "ignore" });
  const base = `http://127.0.0.1:${PORT}`;
  // node:http rather than fetch: fetch silently drops a custom Host header.
  const req = (path, { method = "GET", body, cookie, ip = "1.1.1.1", host = HOST } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path, method,
      headers: { host, "cf-connecting-ip": ip, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } : {}) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({
        status: res.statusCode, text: async () => d, headers: { get: (k) => { const v = res.headers[k.toLowerCase()]; return Array.isArray(v) ? v.join(", ") : v ?? null; } } })); });
    r.on("error", reject); if (body) r.write(body); r.end();
  });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + "/api/x"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const login = await req("/");
    assert.equal(login.status, 200); assert.match(await login.text(), /Log in to the desk/);
    assert.equal((await req("/api/bots")).status, 401, "API needs a session");
    assert.equal((await req("/?t=" + "f".repeat(48))).status, 200, "token alone just shows login");
    assert.match(await (await req("/?t=" + "f".repeat(48))).text(), /Log in to the desk/);
    assert.equal((await req("/login", { method: "POST", body: "password=nope" })).status, 401);
    for (let i = 0; i < 4; i++) await req("/login", { method: "POST", body: "password=nope" });
    assert.equal((await req("/login", { method: "POST", body: "password=tunnel+passphrase+42" })).status, 429, "locked out after 5 failures, even with the right password");
    const ok = await req("/login", { method: "POST", body: "password=tunnel+passphrase+42", ip: "2.2.2.2" });
    assert.equal(ok.status, 303);
    const sc = ok.headers.get("set-cookie");
    assert.match(sc, /omni_s=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict/);
    const cookie = sc.split(";")[0];
    const home = await req("/", { cookie, ip: "2.2.2.2" });
    assert.equal(home.status, 200); assert.match(await home.text(), /One desk for/);
    assert.equal((await req("/api/bots", { cookie })).status, 200);
    assert.equal((await req("/logout", { method: "POST", cookie })).status, 303);
    assert.equal((await req("/api/bots", { cookie })).status, 401, "logged out");
    assert.equal((await req("/", { host: "evil.example" })).status, 403);
  } finally { srv.kill("SIGINT"); }
});
