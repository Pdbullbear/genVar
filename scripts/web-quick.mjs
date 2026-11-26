#!/usr/bin/env node
// Free remote access without a domain:  npm run web:quick
// Starts a Cloudflare quick tunnel (a random https://….trycloudflare.com address that changes on every
// restart), then starts the panel locked to that address with a password login (npm run web:password).
// Cloudflare offers quick tunnels for testing: no uptime guarantee. Ctrl-C stops both.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.WEB_PORT ?? "8790";
if (!existsSync(join(ROOT, ".web-password"))) {
  console.error("Set a panel password first:  npm run web:password");
  process.exit(2);
}
if (spawnSync("cloudflared", ["--version"], { stdio: "ignore" }).error) {
  console.error("cloudflared isn't installed. See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
  process.exit(2);
}

console.log("[tunnel] starting a Cloudflare quick tunnel…");
const tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
let panel = null, stopping = false;

const found = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no tunnel address after 60s")), 60_000);
  const scan = (d) => {
    const m = d.toString().match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/);
    if (m) { clearTimeout(timer); resolve(m[1]); }
    if (/failed|error/i.test(d.toString()) && !/Retrying|You requested/i.test(d.toString())) process.stderr.write(`[tunnel] ${d}`);
  };
  tunnel.stdout.on("data", scan);
  tunnel.stderr.on("data", scan);
  tunnel.on("exit", (c) => reject(new Error(`cloudflared exited (${c})`)));
});

const stop = () => {
  if (stopping) return;
  stopping = true;
  tunnel.kill("SIGTERM");
  panel?.kill("SIGINT");
  if (!panel) process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  const host = await found;
  // The panel only answers this exact hostname remotely, and only after a password login.
  panel = spawn(process.execPath, [join(ROOT, "dist", "web", "server.js")], {
    env: { ...process.env, WEB_PUBLIC_HOST: host, WEB_AUTH: "password" }, stdio: "inherit",
  });
  panel.on("exit", (c) => { tunnel.kill("SIGTERM"); process.exit(c ?? 0); });
  tunnel.on("exit", (c) => { if (!stopping) console.error(`[tunnel] cloudflared exited (${c}); the panel keeps running locally only`); });
  console.log(`[tunnel] ready: https://${host}  (new address each start; log in with your panel password)`);
} catch (e) {
  console.error(`[tunnel] ${e.message}`);
  tunnel.kill("SIGTERM");
  process.exit(1);
}
