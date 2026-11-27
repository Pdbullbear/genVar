#!/usr/bin/env node
// Free remote access without a domain:  npm run web:quick
// Starts a Cloudflare quick tunnel (a random https://….trycloudflare.com address that changes on every
// restart), then starts the panel locked to that address with a password login (npm run web:password).
// The address is only announced once Cloudflare has registered the connection AND it resolves on public
// DNS, so the link works when you open it. cloudflared's full output goes to .tunnel.log.
// Cloudflare offers quick tunnels for testing: no uptime guarantee. Ctrl-C stops both.
//
// Options (env): TUNNEL_PROTOCOL=http2|quic|auto (default http2: plain HTTPS on port 443, which works
// behind most firewalls; QUIC needs outbound UDP 7844), WEB_PORT (default 8790).
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { Resolver } from "node:dns/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.WEB_PORT ?? "8790";
const PROTOCOL = process.env.TUNNEL_PROTOCOL ?? "http2";
const CONNECT_TIMEOUT_MS = Number(process.env.TUNNEL_CONNECT_TIMEOUT_MS ?? 60_000);
const DNS_TIMEOUT_MS = Number(process.env.TUNNEL_DNS_TIMEOUT_MS ?? 90_000);

if (!existsSync(join(ROOT, ".web-password"))) {
  console.error("Set a panel password first:  npm run web:password");
  process.exit(2);
}
if (spawnSync("cloudflared", ["--version"], { stdio: "ignore" }).error) {
  console.error("cloudflared isn't installed. See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
  process.exit(2);
}

const logPath = join(ROOT, ".tunnel.log");
const log = createWriteStream(logPath, { flags: "w" });
const recent = []; // last lines, shown if something goes wrong
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`[tunnel] starting a Cloudflare quick tunnel (protocol ${PROTOCOL})…`);
const tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--protocol", PROTOCOL, "--url", `http://127.0.0.1:${PORT}`],
  { stdio: ["ignore", "pipe", "pipe"] });
let panel = null, stopping = false, host = null, registered = false;
let onHost, onRegistered;
const hostP = new Promise((r) => (onHost = r));
const registeredP = new Promise((r) => (onRegistered = r));

const scan = (d) => {
  const s = d.toString();
  log.write(s);
  for (const line of s.split("\n")) if (line.trim()) { recent.push(line); if (recent.length > 15) recent.shift(); }
  const m = s.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/);
  if (m && !host) { host = m[1]; onHost(host); }
  if (/Registered tunnel connection/i.test(s) && !registered) { registered = true; onRegistered(); }
};
tunnel.stdout.on("data", scan);
tunnel.stderr.on("data", scan);
const tunnelExit = new Promise((r) => tunnel.on("exit", r));

const fail = (why) => {
  console.error(`\n[tunnel] ${why}`);
  if (recent.length) console.error("[tunnel] last cloudflared output:\n  " + recent.slice(-8).join("\n  "));
  console.error(`[tunnel] full log: ${logPath}`);
  if (PROTOCOL !== "quic") console.error("[tunnel] if your network blocks the connection, try another network (e.g. phone hotspot) to confirm.");
  else console.error("[tunnel] QUIC needs outbound UDP 7844; retry with: TUNNEL_PROTOCOL=http2 npm run web:quick");
  tunnel.kill("SIGTERM");
  panel?.kill("SIGINT");
  process.exit(1);
};

const stop = () => {
  if (stopping) return;
  stopping = true;
  tunnel.kill("SIGTERM");
  panel?.kill("SIGINT");
  if (!panel) process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

/** Waits until the hostname resolves on Cloudflare's public resolver (not the local cache). */
async function waitForDns(name) {
  const r = new Resolver();
  r.setServers(["1.1.1.1", "1.0.0.1"]);
  const deadline = Date.now() + DNS_TIMEOUT_MS;
  while (Date.now() < deadline && !stopping) {
    try { if ((await r.resolve4(name)).length) return true; } catch { /* not yet */ }
    await sleep(2000);
  }
  return false;
}

const race = (p, ms, what) => Promise.race([p, tunnelExit.then((c) => { throw new Error(`cloudflared exited (${c}) ${what}`); }),
  sleep(ms).then(() => { throw new Error(`timed out ${what}`); })]);

try {
  await race(hostP, CONNECT_TIMEOUT_MS, "before Cloudflare assigned an address");
  // Start the panel right away so it's ready to answer; it only accepts this exact hostname.
  panel = spawn(process.execPath, [join(ROOT, "dist", "web", "server.js")], {
    env: { ...process.env, WEB_PUBLIC_HOST: host, WEB_AUTH: "password", WEB_QUIET_REMOTE: "1" }, stdio: "inherit",
  });
  panel.on("exit", (c) => { tunnel.kill("SIGTERM"); process.exit(c ?? 0); });
  console.log(`[tunnel] address assigned: ${host} — waiting for the connection…`);
  await race(registeredP, CONNECT_TIMEOUT_MS, "while connecting to Cloudflare (the network may block it)");
  console.log("[tunnel] connected to Cloudflare — waiting for the address to appear in public DNS…");
  const dnsOk = await waitForDns(host);
  console.log(dnsOk
    ? `\n[tunnel] READY: https://${host}\n         (new address each start; log in with your panel password)\n`
    : `\n[tunnel] connected, but ${host} doesn't resolve on public DNS yet. Try https://${host} in a minute;\n` +
      `         if your browser says "DNS address could not be found", your network's DNS may block trycloudflare.com.\n`);
  tunnelExit.then((c) => { if (!stopping) console.error(`[tunnel] cloudflared exited (${c}); the panel keeps running locally only. See ${logPath}`); });
} catch (e) {
  fail(e.message);
}
