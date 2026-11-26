#!/usr/bin/env node
// One-time Cloudflare setup for reaching the panel remotely:
//   npm run tunnel:setup -- --host desk.example.com --email you@example.com
//
// Creates (or reuses) everything, idempotently:
//   1. a Cloudflare Tunnel "omni-desk" whose ingress sends desk.example.com → http://127.0.0.1:8790
//   2. a proxied DNS CNAME desk.example.com → <tunnel>.cfargotunnel.com
//   3. a Cloudflare Access application on desk.example.com with an "allow" policy for your email only
// and writes:
//   .env.tunnel     WEB_PUBLIC_HOST, CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD (not secret)
//   .tunnel-token   the tunnel's connector token (secret; 0600; git-ignored) unless --no-token
//
// Needs CLOUDFLARE_API_TOKEN with: Account › Cloudflare Tunnel › Edit, Account › Access: Apps and
// Policies › Edit, Account › Access: Organizations, Identity Providers, and Groups › Read,
// Account › Account Settings › Read, Zone › Zone › Read and Zone › DNS › Edit (for your domain).
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values: a } = parseArgs({
  options: {
    host: { type: "string" },
    email: { type: "string", multiple: true },
    tunnel: { type: "string", default: "omni-desk" },
    port: { type: "string", default: "8790" },
    account: { type: "string" },
    "no-token": { type: "boolean", default: false },
  },
});
const host = (a.host ?? "").toLowerCase();
const emails = a.email ?? [];
if (/(^|\.)(yourdomain|example)\.com$/.test(host) || emails.some((e) => /[<>]/.test(e))) {
  console.error(`✗ "${host}" / ${emails.join(", ")} look like the placeholders from the instructions.\n` +
    "  Use a hostname on a domain that's on your Cloudflare account (e.g. desk.<your domain>) and your real email.");
  process.exit(2);
}
if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || !emails.length) {
  console.error("usage: npm run tunnel:setup -- --host desk.example.com --email you@example.com [--email other@…]");
  process.exit(2);
}
// In a cloud session the proxy injects the real token, so any placeholder works there.
const TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "proxy-injected";

async function cf(method, path, body) {
  const r = await fetch(`${process.env.CF_API_BASE ?? "https://api.cloudflare.com/client/v4"}${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) {
    const msg = (j.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${r.status}`;
    throw new Error(`${method} ${path} → ${msg}`);
  }
  return j.result;
}
const step = (m) => console.log(`• ${m}`);

async function main() {
  // ---- account and zone ----
  // A token without Account Settings › Read can't list accounts; --account <id> skips the lookup.
  const accounts = await cf("GET", "/accounts?per_page=50");
  const isId = (s) => /^[0-9a-f]{32}$/.test(s ?? "");
  if (!accounts.length && !isId(a.account))
    throw new Error("the API token can't see any account. Either give it Account › Account Settings › Read, or pass " +
      "--account <Account ID> (shown on the right of your domain's Overview page in the Cloudflare dashboard).");
  const account = accounts.length
    ? (a.account ? accounts.find((x) => x.id === a.account || x.name === a.account) : accounts[0])
    : { id: a.account, name: a.account };
  if (!account) throw new Error(`account ${a.account} not found`);
  step(`account: ${account.name}`);

  let zone = null;
  const labels = host.split(".");
  for (let i = 1; i < labels.length - 1 && !zone; i++) {
    const name = labels.slice(i).join(".");
    const z = await cf("GET", `/zones?name=${encodeURIComponent(name)}&account.id=${account.id}`);
    if (z.length) zone = z[0];
  }
  if (!zone) throw new Error(`no Cloudflare zone for ${host}: add the domain to Cloudflare (or give the token Zone › Zone › Read)`);
  step(`zone: ${zone.name}`);

  // ---- tunnel ----
  const existing = await cf("GET", `/accounts/${account.id}/cfd_tunnel?name=${encodeURIComponent(a.tunnel)}&is_deleted=false`);
  const tunnel = existing[0] ?? (await cf("POST", `/accounts/${account.id}/cfd_tunnel`, { name: a.tunnel, config_src: "cloudflare" }));
  step(`tunnel: ${a.tunnel} (${existing[0] ? "existing" : "created"})`);
  await cf("PUT", `/accounts/${account.id}/cfd_tunnel/${tunnel.id}/configurations`, {
    config: { ingress: [{ hostname: host, service: `http://127.0.0.1:${a.port}` }, { service: "http_status:404" }] },
  });
  step(`ingress: https://${host} → http://127.0.0.1:${a.port}`);

  // ---- DNS ----
  const target = `${tunnel.id}.cfargotunnel.com`;
  const recs = await cf("GET", `/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}`);
  const rec = { type: "CNAME", name: host, content: target, proxied: true, comment: "omni-kit panel tunnel" };
  if (recs.length) {
    if (recs[0].type !== "CNAME") throw new Error(`${host} already has a ${recs[0].type} record: remove it or pick another --host`);
    await cf("PUT", `/zones/${zone.id}/dns_records/${recs[0].id}`, rec);
    step(`DNS: updated ${host} → ${target}`);
  } else {
    await cf("POST", `/zones/${zone.id}/dns_records`, rec);
    step(`DNS: created ${host} → ${target}`);
  }

  // ---- Access ----
  let org;
  try {
    org = await cf("GET", `/accounts/${account.id}/access/organizations`);
  } catch (e) {
    throw new Error(`Cloudflare Zero Trust isn't set up on this account yet (or the token can't read it). ` +
      `Open one.dash.cloudflare.com once, pick a team name and the Free plan, then re-run. (${e.message})`);
  }
  const teamDomain = org.auth_domain;
  step(`Zero Trust team: ${teamDomain}`);
  const apps = await cf("GET", `/accounts/${account.id}/access/apps?per_page=100`);
  let app = apps.find((x) => x.domain === host);
  if (!app) {
    app = await cf("POST", `/accounts/${account.id}/access/apps`, {
      name: "omni-kit desk", domain: host, type: "self_hosted", session_duration: "24h",
      app_launcher_visible: false, auto_redirect_to_identity: false,
    });
    step("Access application: created");
  } else step("Access application: existing");
  const policies = await cf("GET", `/accounts/${account.id}/access/apps/${app.id}/policies`);
  const policy = { name: "omni-kit owner", decision: "allow", include: emails.map((email) => ({ email: { email } })), precedence: 1 };
  const mine = policies.find((p) => p.name === policy.name);
  if (mine) await cf("PUT", `/accounts/${account.id}/access/apps/${app.id}/policies/${mine.id}`, policy);
  else await cf("POST", `/accounts/${account.id}/access/apps/${app.id}/policies`, policy);
  step(`Access policy: only ${emails.join(", ")} can log in (one-time code by email)`);

  // ---- local files ----
  writeFileSync(join(ROOT, ".env.tunnel"),
    `# written by npm run tunnel:setup\nWEB_PUBLIC_HOST=${host}\nCF_ACCESS_TEAM_DOMAIN=${teamDomain}\nCF_ACCESS_AUD=${app.aud}\n`);
  step("wrote .env.tunnel");
  if (!a["no-token"]) {
    const t = await cf("GET", `/accounts/${account.id}/cfd_tunnel/${tunnel.id}/token`);
    writeFileSync(join(ROOT, ".tunnel-token"), `${t}\n`, { mode: 0o600 });
    step("wrote .tunnel-token (secret, git-ignored)");
  } else step("skipped the tunnel token (--no-token): copy it from Zero Trust › Networks › Tunnels › omni-desk");
  console.log(`\nDone. Start everything with:  npm run web:remote\nThen open https://${host} and log in with your email.`);
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
});
