// Runs scripts/cloudflare-setup.mjs against a fake Cloudflare API and checks what it creates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, cpSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakeCloudflare() {
  const s = { tunnels: [], dns: [], apps: [], policies: {}, ingress: null, calls: [] };
  const ok = (res, result) => res.end(JSON.stringify({ success: true, result }));
  const srv = createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const b = body ? JSON.parse(body) : null, u = new URL(req.url, "http://x"), p = u.pathname, m = req.method;
    s.calls.push(`${m} ${p}`);
    res.setHeader("content-type", "application/json");
    let r;
    if (m === "GET" && p === "/accounts") return ok(res, [{ id: "acc1", name: "Me" }]);
    if (m === "GET" && p === "/zones") return ok(res, u.searchParams.get("name") === "mydesk.dev" ? [{ id: "z1", name: "mydesk.dev" }] : []);
    if (m === "GET" && p === "/accounts/acc1/cfd_tunnel") return ok(res, s.tunnels.filter((t) => t.name === u.searchParams.get("name")));
    if (m === "POST" && p === "/accounts/acc1/cfd_tunnel") { const t = { id: "tun1", name: b.name }; s.tunnels.push(t); return ok(res, t); }
    if (m === "PUT" && (r = p.match(/^\/accounts\/acc1\/cfd_tunnel\/(\w+)\/configurations$/))) { s.ingress = b.config.ingress; return ok(res, {}); }
    if (m === "GET" && p === "/accounts/acc1/cfd_tunnel/tun1/token") return ok(res, "SECRET-TUNNEL-TOKEN");
    if (m === "GET" && p === "/zones/z1/dns_records") return ok(res, s.dns.filter((d) => d.name === u.searchParams.get("name")));
    if (m === "POST" && p === "/zones/z1/dns_records") { s.dns.push({ id: "d1", ...b }); return ok(res, {}); }
    if (m === "PUT" && p === "/zones/z1/dns_records/d1") { s.dns[0] = { id: "d1", ...b }; return ok(res, {}); }
    if (m === "GET" && p === "/accounts/acc1/access/organizations") return ok(res, { auth_domain: "myteam.cloudflareaccess.com" });
    if (m === "GET" && p === "/accounts/acc1/access/apps") return ok(res, s.apps);
    if (m === "POST" && p === "/accounts/acc1/access/apps") { const a = { id: "app1", aud: "AUD-xyz", ...b }; s.apps.push(a); s.policies.app1 = []; return ok(res, a); }
    if (m === "GET" && p === "/accounts/acc1/access/apps/app1/policies") return ok(res, s.policies.app1);
    if (m === "POST" && p === "/accounts/acc1/access/apps/app1/policies") { s.policies.app1.push({ id: "pol1", ...b }); return ok(res, {}); }
    if (m === "PUT" && p === "/accounts/acc1/access/apps/app1/policies/pol1") { s.policies.app1[0] = { id: "pol1", ...b }; return ok(res, {}); }
    res.statusCode = 404; res.end(JSON.stringify({ success: false, errors: [{ code: 404, message: `fake: no route ${m} ${p}` }] }));
  });
  return { s, srv };
}

test("cloudflare-setup creates tunnel, DNS and Access, and is idempotent", async () => {
  const { s, srv } = fakeCloudflare();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "cfsetup-"));
  cpSync("scripts", join(dir, "scripts"), { recursive: true });
  const run = () => new Promise((resolve) => execFile(process.execPath, [join(dir, "scripts/cloudflare-setup.mjs"), "--host", "desk.mydesk.dev", "--email", "me@example.com"],
    { env: { ...process.env, CF_API_BASE: `http://127.0.0.1:${srv.address().port}`, CLOUDFLARE_API_TOKEN: "x" } }, (err, out, errOut) => resolve({ err, out, errOut })));
  try {
    const r1 = await run();
    assert.equal(r1.err, null, r1.errOut);
    assert.deepEqual(s.ingress, [{ hostname: "desk.mydesk.dev", service: "http://127.0.0.1:8790" }, { service: "http_status:404" }]);
    assert.equal(s.dns[0].content, "tun1.cfargotunnel.com");
    assert.equal(s.dns[0].proxied, true);
    assert.deepEqual(s.policies.app1[0].include, [{ email: { email: "me@example.com" } }]);
    assert.equal(s.policies.app1[0].decision, "allow");
    assert.match(readFileSync(join(dir, ".env.tunnel"), "utf8"), /WEB_PUBLIC_HOST=desk\.mydesk\.dev\nCF_ACCESS_TEAM_DOMAIN=myteam\.cloudflareaccess\.com\nCF_ACCESS_AUD=AUD-xyz/);
    assert.equal(readFileSync(join(dir, ".tunnel-token"), "utf8").trim(), "SECRET-TUNNEL-TOKEN");
    assert.equal(statSync(join(dir, ".tunnel-token")).mode & 0o777, 0o600);
    // Second run reuses everything instead of creating duplicates.
    const r2 = await run();
    assert.equal(r2.err, null, r2.errOut);
    assert.equal(s.tunnels.length, 1); assert.equal(s.dns.length, 1); assert.equal(s.apps.length, 1); assert.equal(s.policies.app1.length, 1);
    assert.match(r2.out, /tunnel: omni-desk \(existing\)/);
  } finally { srv.close(); }
});
