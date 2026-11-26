#!/usr/bin/env node
// Starts the panel and the Cloudflare Tunnel connector together:  npm run web:remote
// Reads .env.tunnel (from npm run tunnel:setup) and the connector token from .tunnel-token (or the
// TUNNEL_TOKEN env var). Ctrl-C stops both; the panel stops its bots gracefully as usual.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(ROOT, ".env.tunnel");
if (!existsSync(envFile)) {
  console.error("No .env.tunnel yet. Run:  npm run tunnel:setup -- --host desk.example.com --email you@example.com");
  process.exit(2);
}
const env = { ...process.env };
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
for (const k of ["WEB_PUBLIC_HOST", "CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"])
  if (!env[k]) { console.error(`.env.tunnel is missing ${k}: re-run npm run tunnel:setup`); process.exit(2); }

const tokenFile = join(ROOT, ".tunnel-token");
const tunnelToken = process.env.TUNNEL_TOKEN ?? (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "");
if (!tunnelToken) { console.error("No tunnel token: run npm run tunnel:setup (or set TUNNEL_TOKEN)."); process.exit(2); }
if (spawnSync("cloudflared", ["--version"], { stdio: "ignore" }).error) {
  console.error("cloudflared isn't installed. See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
  process.exit(2);
}

const panel = spawn(process.execPath, [join(ROOT, "dist", "web", "server.js")], { env, stdio: "inherit" });
// The token goes in the environment, not the command line, so it doesn't show up in process lists.
const tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "run"], { env: { ...env, TUNNEL_TOKEN: tunnelToken }, stdio: ["ignore", "ignore", "pipe"] });
tunnel.stderr.on("data", (d) => {
  const s = d.toString();
  if (/Registered tunnel connection|ERR|error/i.test(s)) process.stderr.write(`[tunnel] ${s}`);
});
console.log(`[tunnel] connecting https://${env.WEB_PUBLIC_HOST} → panel (Cloudflare Access login required)`);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  tunnel.kill("SIGTERM");
  panel.kill("SIGINT");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
panel.on("exit", (c) => { tunnel.kill("SIGTERM"); process.exit(c ?? 0); });
tunnel.on("exit", (c) => { if (!stopping) console.error(`[tunnel] cloudflared exited (${c}); the panel keeps running locally at http://127.0.0.1:${env.WEB_PORT ?? 8790}`); });
