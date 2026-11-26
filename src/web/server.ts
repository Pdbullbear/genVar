#!/usr/bin/env node
// Local web control panel for omni-kit: run and monitor the delta-neutral bots from the browser.
//
//   npm run web            → prints  http://127.0.0.1:8790/?t=<token>
//
// Security: listens on 127.0.0.1 only; every API call must carry the random token printed at startup
// (so other websites open in your browser can't drive it); the API key never leaves this process.
// Bots run as child processes of this server: stopping the server with Ctrl-C stops them gracefully
// (an open DN position stays on, hedged, and resumes the next time its bot starts).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OmniClient, OmniError, type Ticker } from "../sdk/index.js";
import { discoverPairs, carryBpsPerDay, pairFunding, type Pair } from "../bot/dn/core.js";
import { fetchStats } from "../sdk/stats.js";
import { cookie, createAccessVerifier } from "./access.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const RUNNER = join(ROOT, "dist", "bot", "dn", "runner.js");
const PORT = Number(process.env.WEB_PORT ?? 8790);
// The panel token is kept in .web-token so links and the browser cookie survive restarts.
const TOKEN_FILE = join(ROOT, ".web-token");
const TOKEN = process.env.WEB_TOKEN ?? (() => {
  try { const t = readFileSync(TOKEN_FILE, "utf8").trim(); if (/^[0-9a-f]{32,}$/.test(t)) return t; } catch { /* create below */ }
  const t = randomBytes(24).toString("hex");
  writeFileSync(TOKEN_FILE, t + "\n", { mode: 0o600 });
  return t;
})();

// ---------- remote access through a Cloudflare Tunnel ----------
// WEB_PUBLIC_HOST is the tunnel's hostname (e.g. desk.example.com). Requests for it must carry a valid
// Cloudflare Access token (CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD); without that config they're refused.
const PUBLIC_HOST = (process.env.WEB_PUBLIC_HOST ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "") || null;
const verifyAccess = process.env.CF_ACCESS_TEAM_DOMAIN && process.env.CF_ACCESS_AUD
  ? createAccessVerifier({ teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN, aud: process.env.CF_ACCESS_AUD })
  : null;
const client = new OmniClient({ reserve: 10 });

// ---------- cached exchange data (shared 60 weight/min with the bots, so keep it frugal) ----------
type Cached<T> = { at: number; data: T | null; err?: string; inflight?: Promise<void> };
function cached<T>(ttlMs: number, load: () => Promise<T>) {
  const c: Cached<T> = { at: 0, data: null };
  // Never blocks an HTTP response: returns the latest snapshot and refreshes in the background.
  // (The panel's client waits for rate-limit weight rather than risk a 429, which can take a while
  // when bots are busy on the same key.)
  return async (force = false) => {
    if ((force || Date.now() - c.at > ttlMs) && !c.inflight) {
      c.inflight = load()
        .then((d) => { c.data = d; c.err = undefined; })
        .catch((e) => { c.err = e instanceof OmniError ? `${e.code}: ${e.body.error_message}` : String(e?.message ?? e); })
        .finally(() => { c.at = Date.now(); c.inflight = undefined; });
      // Give a fast first load a moment to land in this response.
      if (!c.data) await Promise.race([c.inflight, new Promise((r) => setTimeout(r, 1500))]);
    }
    return { data: c.data, err: c.err, at: c.at, loading: !!c.inflight };
  };
}
const account = cached(20_000, async () => {
  const [acct, positions] = await Promise.all([client.account(), client.positions()]);
  return { account: acct, positions: positions.filter((p) => Number(p.size) !== 0) };
});
const instruments = cached(300_000, () => client.instruments());
const tickers = cached(30_000, () => client.tickers());
// Leverage per market, cached for 5 minutes (two weight per lookup).
const levCache = new Map<string, { at: number; v: { perp: number | null; swap: number | null } }>();
async function leverageFor(perp: string, swap: string) {
  const k = `${perp}|${swap}`, c = levCache.get(k);
  if (c && Date.now() - c.at < 300_000) return c.v;
  const [pp, ps] = [await client.position(perp), await client.position(swap)];
  const v = { perp: Number(pp.leverage) || null, swap: Number(ps.leverage) || null };
  levCache.set(k, { at: Date.now(), v });
  return v;
}
// Public stats feed (funding + quoted spreads): separate rate limit, costs no trading weight.
const stats = cached(60_000, () => fetchStats());
async function pairs() {
  const [i, t] = [await instruments(), await tickers()];
  const tk = new Map<string, Ticker>((t.data ?? []).map((x) => [x.symbol, x]));
  const st = await stats();
  const list = discoverPairs(i.data ?? []).map((p: Pair) => {
    const pm = Number(tk.get(p.perp.symbol)?.mark_price), sm = Number(tk.get(p.swap.symbol)?.mark_price);
    const f = st.data ? pairFunding(st.data, p.perp.symbol, p.swap.symbol) : null;
    return {
      funding: f && {
        perpAnnual: f.perpAnnual, swapLongPays: f.swapLongPays, swapShortReceives: f.swapShortReceives, carryAnnual: f.carryAnnual,
        best: f.best, roundTripBps: f.roundTripBps, spreadEstimated: f.spreadEstimated, curveCarry: f.curveCarry, nextPerpAt: f.nextPerpAt, nextSwapAt: f.nextSwapAt,
        // Breakeven in days for each direction, at the quoted spreads.
        breakevenDays: Object.fromEntries((["long_perp", "short_perp"] as const).map((d) => [d, f.carryAnnual[d] > 0 ? Math.ceil(f.roundTripBps / (f.carryAnnual[d] * 1e4 / 365)) : null])),
      },
      key: p.key, perp: p.perp.symbol, swap: p.swap.symbol, perpMark: pm || null, swapMark: sm || null,
      gapBps: pm && sm ? +((Math.log(pm / sm)) * 1e4).toFixed(2) : null,
      swapStatus: p.swap.status, nextClose: p.swap.next_close_at, nextOpen: p.swap.next_open_at,
    };
  });
  return { pairs: list, err: i.err ?? t.err, fundingErr: st.err, fundingAt: st.at, at: t.at };
}

// ---------- bots ----------
interface Bot {
  pair: string; live: boolean; cfg: any; args: string[]; proc: ChildProcess | null; startedAt: number; exitedAt?: number;
  exitCode?: number | null; log: string[]; status: any; series: { t: number; dev: number; pnl: number | null }[];
  /** You want it running: only your Stop clears this. A bot that exits while wanted is restarted. */
  wanted: boolean; restarts: number; restartAt?: number; restartTimer?: NodeJS.Timeout; fatal?: string;
}
const bots = new Map<string, Bot>(); // key: PAIR or PAIR-dry

// Which bots you want running survives panel restarts: they come back when the panel starts.
const REGISTRY = join(ROOT, "web-bots.json");
function saveRegistry() {
  const list = [...bots.entries()].map(([key, b]) => ({ key, cfg: b.cfg, wanted: b.wanted }));
  try { writeFileSync(REGISTRY, JSON.stringify(list, null, 2)); } catch { /* ignore */ }
}
let panelStopping = false;

function botKey(pair: string, live: boolean) { return live ? pair : `${pair}-dry`; }

function startBot(cfg: any) {
  const pair = String(cfg.pair ?? "").toUpperCase();
  if (!/^[A-Z0-9]{1,15}$/.test(pair)) throw new Error("bad pair");
  const live = !!cfg.live;
  const key = botKey(pair, live);
  const existing = bots.get(key);
  if (existing?.proc) throw new Error(`${key} bot is already running`);
  if (existing?.restartTimer) clearTimeout(existing.restartTimer);
  const num = (k: string, v: unknown) => {
    if (v === undefined || v === null || v === "") return [];
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
    return [`--${k}=${n}`];
  };
  const mode = cfg.mode === "carry" ? "carry" : "stat";
  const args = [RUNNER, "run", "--pair", pair, "--mode", mode, "--status-json",
    ...(mode === "carry" ? ["--dir", cfg.dir === "short_perp" ? "short_perp" : "long_perp"] : []),
    ...num("notional-usd", cfg.notionalUsd), ...num("perp-funding", cfg.perpFunding),
    ...num("swap-long-funding", cfg.swapLongFunding), ...num("swap-short-funding", cfg.swapShortFunding),
    ...num("hold-hours", cfg.holdHours), ...num("max-hold-hours", cfg.maxHoldHours),
    ...num("stop-loss-usd", cfg.stopLossUsd), ...num("entry-z", cfg.entryZ), ...num("exit-z", cfg.exitZ),
    ...num("round-trip-bps", cfg.roundTripBps), ...num("poll", cfg.poll),
    ...(cfg.autoFunding ? ["--auto-funding"] : []), ...num("margin-usd", cfg.marginUsd), ...num("exit-if-negative-carry-hours", cfg.exitIfNegativeCarryHours),
    ...(live ? ["--live"] : [])];
  const proc = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const bot: Bot = {
    pair, live, cfg, args: args.slice(1), proc, startedAt: Date.now(), log: existing?.log.slice(-40) ?? [],
    status: existing?.status ?? null, series: existing?.series ?? [], wanted: true, restarts: existing?.restarts ?? 0,
  };
  bots.set(key, bot);
  saveRegistry();
  const onLine = (line: string) => {
    if (!line.trim()) return;
    if (line.startsWith("@@")) {
      try {
        bot.status = JSON.parse(line.slice(2));
        bot.series.push({ t: bot.status.t, dev: bot.status.devBps, pnl: bot.status.trade?.pnl ?? null });
        if (bot.series.length > 720) bot.series.shift();
      } catch { /* ignore */ }
      return;
    }
    bot.log.push(line);
    if (bot.log.length > 300) bot.log.shift();
  };
  let buf = "";
  const feed = (d: Buffer) => { buf += d.toString(); const parts = buf.split("\n"); buf = parts.pop()!; parts.forEach(onLine); };
  proc.stdout!.on("data", feed);
  proc.stderr!.on("data", feed);
  proc.on("exit", (code, signal) => {
    bot.proc = null; bot.exitedAt = Date.now(); bot.exitCode = code;
    onLine(`— bot exited (${code ?? signal}) —`);
    if (panelStopping || !bot.wanted) return;
    if (code === 2) {
      // Config error (bad pair, mismatched legs, …): restarting can't fix it.
      bot.wanted = false;
      bot.fatal = bot.log.filter((l) => !l.startsWith("—")).slice(-1)[0] ?? "configuration error";
      saveRegistry();
      return;
    }
    // You didn't stop it, so bring it back. Back off if it keeps dying; reset after a healthy run.
    if (Date.now() - bot.startedAt > 10 * 60_000) bot.restarts = 0;
    const delay = Math.min(300, 5 * 2 ** bot.restarts) * 1000;
    bot.restarts++;
    bot.restartAt = Date.now() + delay;
    onLine(`— restarting in ${delay / 1000}s (restart #${bot.restarts}) —`);
    bot.restartTimer = setTimeout(() => {
      bot.restartAt = undefined;
      if (bot.wanted && !bot.proc && !panelStopping) try { startBot(bot.cfg); } catch (e) { onLine(`— restart failed: ${(e as Error).message} —`); }
    }, delay);
  });
  return key;
}

function stopBot(key: string) {
  const b = bots.get(key);
  if (!b) throw new Error(`unknown bot ${key}`);
  b.wanted = false; // only you can stop a bot
  if (b.restartTimer) clearTimeout(b.restartTimer);
  b.restartAt = undefined;
  saveRegistry();
  b.proc?.kill("SIGINT"); // graceful: finishes the cycle, saves state, leaves a hedged position on
}

function sendCmd(key: string, cmd: "exit" | "resume" | "forget-trade") {
  const b = bots.get(key);
  if (!b?.proc) throw new Error(`${key} is not running: start it first`);
  writeFileSync(stateFile(b.pair, b.live).replace(/\.json$/, ".cmd"), cmd);
}

function stateFile(pair: string, live: boolean) { return join(ROOT, `dn-${pair}${live ? "" : "-dry"}.json`); }

function requestExit(key: string) {
  const b = bots.get(key);
  if (!b?.proc) throw new Error(`${key} is not running: start it, then exit (the bot closes both legs together)`);
  writeFileSync(stateFile(b.pair, b.live).replace(/\.json$/, ".cmd"), "exit");
}

/** State files on disk, including ones from bots that aren't running (e.g. started from a terminal). */
function savedStates() {
  return readdirSync(ROOT).filter((f) => /^dn-[A-Z0-9]+(-dry)?\.json$/.test(f)).map((f) => {
    try {
      const s = JSON.parse(readFileSync(join(ROOT, f), "utf8"));
      const m = f.match(/^dn-([A-Z0-9]+)(-dry)?\.json$/)!;
      return { file: f, pair: m[1], live: !m[2], trade: s.trade, realizedUsd: s.realizedUsd, trades: s.trades, samples: s.stats?.n ?? 0 };
    } catch { return null; }
  }).filter(Boolean);
}

/**
 * Cost per million volume (CPM), from every fill the bot has logged for this pair (all runs).
 *   volume       Σ |size × price| over fills
 *   execCost     Σ slippage vs the mark at the time × notional: the spread actually paid
 *   execCPM      execCost / volume × 1,000,000
 *   netCPM       −(realized + unrealized price PnL + funding) / volume × 1,000,000 (negative: you earned)
 */
function cpmStats(pair: string, live: boolean, status: any) {
  const f = stateFile(pair, live).replace(/\.json$/, ".jsonl");
  let volume = 0, execCost = 0, fills = 0;
  if (existsSync(f)) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.includes('"fill"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.type !== "fill") continue;
        const notional = Math.abs(Number(e.size) * Number(e.price));
        if (!Number.isFinite(notional)) continue;
        volume += notional;
        execCost += (Number(e.slippageBps) / 1e4) * notional;
        fills++;
      } catch { /* skip */ }
    }
  }
  const realized = Number(status?.realizedUsd ?? 0), unrealized = Number(status?.trade?.pnl ?? 0);
  // Funding: banked from closed trades, plus the open trade's so far.
  const funding = Number(status?.fundingClosedUsd ?? 0) + (status?.funding ? Number(status.funding.perp) + Number(status.funding.swap) : 0);
  const net = realized + unrealized + funding;
  return {
    fills, volumeUsd: volume, execCostUsd: execCost, netPnlUsd: net,
    execCpm: volume ? (execCost / volume) * 1e6 : null,
    netCpm: volume ? (-net / volume) * 1e6 : null,
  };
}

function recentEvents(pair: string, live: boolean, n = 50) {
  const f = stateFile(pair, live).replace(/\.json$/, ".jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").trim().split("\n").slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ---------- scan jobs ----------
// ---------- close all positions ----------
// 1. Every live bot holding a trade gets "exit": it closes both legs together and pauses entries.
// 2. Once the bots are flat, anything else on the account is closed with reduce-only market orders.
// 3. Symbols a bot still owns (e.g. its swap market is closed) are left alone and reported: closing
//    one leg on its own would leave the other unhedged.
interface CloseStep { at: number; text: string; level: "info" | "ok" | "warn" | "err" }
type CloseJob = { running: boolean; startedAt: number; finishedAt?: number; steps: CloseStep[] };
let closeAll: CloseJob | null = null;
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runCloseAll() {
  const job: CloseJob = { running: true, startedAt: Date.now(), steps: [] };
  closeAll = job;
  const step = (text: string, level: CloseStep["level"] = "info") => job.steps.push({ at: Date.now(), text, level });
  try {
    // ---- 1. bot-managed positions ----
    const holding = [...bots.entries()].filter(([, b]) => b.live && b.proc && b.status?.trade);
    for (const [key, b] of holding) {
      writeFileSync(stateFile(b.pair, b.live).replace(/\.json$/, ".cmd"), "exit");
      step(`${key}: asked the bot to close both legs`);
    }
    const deadline = Date.now() + 4 * 60_000;
    // Wait for the bots, but not for ones whose swap market is closed: they can't exit until it reopens.
    const canStillClose = ([, b]: [string, Bot]) => b.proc && b.status?.trade && (!b.status.swapStatus || b.status.swapStatus === "open");
    while (holding.some(canStillClose) && Date.now() < deadline) await sleepMs(2000);
    const stuck = holding.filter(([, b]) => b.proc && b.status?.trade);
    for (const [key] of holding) if (!stuck.find(([k]) => k === key)) step(`${key}: bot closed both legs (entries now paused)`, "ok");
    for (const [key, b] of stuck)
      step(`${key}: the bot hasn't been able to close yet${b.status?.swapStatus && b.status.swapStatus !== "open" ? ` (${b.pair} swap market is ${b.status.swapStatus})` : ""}. It keeps trying; its legs are left alone here so you stay hedged.`, "warn");

    // Symbols still owned by a running bot with an open trade are not ours to touch.
    const owned = new Set<string>();
    for (const [, b] of bots) if (b.proc && b.status?.trade) { owned.add(b.status.perp); owned.add(b.status.swap); }

    // ---- 2. everything else ----
    const positions = (await client.positions()).filter((p) => Number(p.size) !== 0);
    const rest = positions.filter((p) => !owned.has(p.symbol));
    if (!rest.length && positions.length) step("no other positions to close", "ok");
    for (const p of rest) {
      const size = Math.abs(Number(p.size));
      const side = Number(p.size) > 0 ? "sell" : "buy";
      try {
        const [o] = await client.placeOrder({ type: "market", symbol: p.symbol, side, size: String(size), max_slippage: "0.02", reduce_only: true });
        const f = o.status === "queued" ? await client.waitForOrder(o.order_id, { timeoutMs: 20_000, intervalMs: 700 }) : o;
        if (f.status === "filled") step(`${p.symbol}: closed ${p.size} at ${f.fill_price}`, "ok");
        else step(`${p.symbol}: order ${f.status}${f.reason ? ` (${f.reason})` : ""}`, "err");
      } catch (e) {
        step(`${p.symbol}: ${e instanceof OmniError ? `${e.code}: ${e.body.error_message}` : (e as Error).message}`, "err");
      }
    }
    // ---- 3. final check ----
    const left = (await client.positions()).filter((p) => Number(p.size) !== 0);
    if (!left.length) step("done: the account has no open positions", "ok");
    else step(`still open: ${left.map((p) => `${p.symbol} ${p.size}${owned.has(p.symbol) ? " (bot exit pending)" : ""}`).join(", ")}`, "warn");
  } catch (e) {
    step(`stopped: ${e instanceof OmniError ? `${e.code}: ${e.body.error_message}` : (e as Error).message}`, "err");
  } finally {
    job.running = false;
    job.finishedAt = Date.now();
    await account(true); // refresh the positions table
  }
}

let scan: { running: boolean; startedAt: number; minutes: number; result: any; err?: string; proc?: ChildProcess } | null = null;
function startScan(minutes: number) {
  if (scan?.running) throw new Error("a scan is already running");
  const m = Math.min(10, Math.max(0.5, minutes || 2));
  const proc = spawn(process.execPath, [RUNNER, "scan", "--json", `--minutes=${m}`], { cwd: ROOT, env: process.env });
  let out = "", err = "";
  scan = { running: true, startedAt: Date.now(), minutes: m, result: null, proc };
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (err += d));
  proc.on("exit", () => {
    const i = out.indexOf("\n[");
    try { scan!.result = JSON.parse(out.slice(i + 1)); } catch { scan!.err = (err || out).slice(-500); }
    scan!.running = false;
  });
}

// ---------- HTTP ----------
function authed(req: IncomingMessage, url: URL) {
  const got = String(req.headers["x-token"] || url.searchParams.get("t") || cookie(req.headers.cookie, "omni_t") || "");
  const a = Buffer.from(got), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
const json = (res: ServerResponse, code: number, body: unknown) =>
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));

async function body(req: IncomingMessage) {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 20_000) throw new Error("body too large"); }
  return s ? JSON.parse(s) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  // Block DNS-rebinding: only answer requests addressed to this machine, or to the tunnel's hostname.
  const host = String(req.headers.host ?? "").toLowerCase();
  const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
  const remote = !!PUBLIC_HOST && host === PUBLIC_HOST;
  if (!local && !remote) return json(res, 403, { error: "bad host" });
  if (remote) {
    // Fail closed: a public hostname without Access verification configured is never served.
    if (!verifyAccess) return json(res, 403, { error: "remote access isn't configured (set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD)" });
    try {
      await verifyAccess(String(req.headers["cf-access-jwt-assertion"] ?? "") || cookie(req.headers.cookie, "CF_Authorization"));
    } catch (e) {
      return json(res, 403, { error: `Cloudflare Access check failed: ${(e as Error).message}` });
    }
  }
  try {
    if (req.method === "GET" && url.pathname === "/") {
      if (!authed(req, url)) return res.writeHead(401, { "content-type": "text/plain" }).end("Open the link printed in the terminal (it includes ?t=…).");
      // Remember the token in an HttpOnly, same-site cookie so a bookmark without ?t= keeps working.
      const secure = remote || req.headers["x-forwarded-proto"] === "https";
      return res.writeHead(200, {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "set-cookie": `omni_t=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? "; Secure" : ""}`,
        "referrer-policy": "no-referrer", "x-frame-options": "DENY", "x-content-type-options": "nosniff",
      }).end(readFileSync(join(ROOT, "src", "web", "index.html"), "utf8"));
    }
    if (!url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });
    if (!authed(req, url)) return json(res, 401, { error: "missing or wrong token" });
    // State-changing calls must come from our own page (no cross-site form posts).
    if (req.method === "POST" && req.headers["content-type"] !== "application/json") return json(res, 415, { error: "json only" });

    const p = url.pathname;
    if (req.method === "GET" && p === "/api/overview") {
      const a = await account();
      return json(res, 200, {
        env: client.environment, baseUrl: client.baseUrl, key: client.publicKey.slice(0, 10) + "…",
        account: a.data?.account ?? null, positions: a.data?.positions ?? [], err: a.err, at: a.at,
        weight: client.budget.remaining, limit: client.budget.limit,
      });
    }
    if (req.method === "GET" && p === "/api/pairs") return json(res, 200, await pairs());
    if (req.method === "GET" && p === "/api/leverage") {
      // Leverage configured in the Omni app for each leg (the API can't change it), for the margin preview.
      const key = String(url.searchParams.get("pair") ?? "").toUpperCase();
      const pr = discoverPairs((await instruments()).data ?? []).find((x) => x.key === key);
      if (!pr) throw new Error(`unknown pair ${key}`);
      // A running bot on this pair already knows its leverage; otherwise look it up, but never hang the
      // page waiting for rate-limit weight (the bots have priority): answer "pending" and let it retry.
      const known = [...bots.values()].find((b) => b.pair === key && b.status?.leverage?.perp && b.status?.leverage?.swap)?.status.leverage;
      const lev = known ?? await Promise.race([leverageFor(pr.perp.symbol, pr.swap.symbol), new Promise<null>((r) => setTimeout(() => r(null), 3000))]);
      const a = await account();
      return json(res, 200, { ...(lev ?? { perp: null, swap: null }), pending: !lev, available: a.data ? Number(a.data.account.cross.available) : null });
    }
    if (req.method === "GET" && p === "/api/bots") {
      const list = [...bots.entries()].map(([key, b]) => ({
        key, pair: b.pair, live: b.live, cfg: b.cfg, wanted: b.wanted, restarts: b.restarts, restartAt: b.restartAt ?? null, fatal: b.fatal ?? null, running: !!b.proc, startedAt: b.startedAt, exitedAt: b.exitedAt, exitCode: b.exitCode,
        args: b.args.slice(2).join(" "), status: b.status, cpm: cpmStats(b.pair, b.live, b.status), series: b.series, log: b.log.slice(-80), events: recentEvents(b.pair, b.live, 40),
      }));
      return json(res, 200, { bots: list, saved: savedStates() });
    }
    if (req.method === "POST" && p === "/api/bots/start") return json(res, 200, { key: startBot(await body(req)) });
    if (req.method === "POST" && p === "/api/bots/restart") {
      const b = bots.get(String((await body(req)).key));
      if (!b) throw new Error("unknown bot");
      return json(res, 200, { key: startBot(b.cfg) });
    }
    if (req.method === "POST" && p === "/api/bots/stop") return (stopBot(String((await body(req)).key)), json(res, 200, { ok: true }));
    if (req.method === "POST" && p === "/api/bots/exit") return (requestExit(String((await body(req)).key)), json(res, 200, { ok: true }));
    if (req.method === "POST" && p === "/api/bots/resume") return (sendCmd(String((await body(req)).key), "resume"), json(res, 200, { ok: true }));
    if (req.method === "POST" && p === "/api/close-all") {
      if ((await body(req)).confirm !== true) throw new Error("confirmation required");
      if (closeAll?.running) throw new Error("already closing positions");
      void runCloseAll();
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && p === "/api/close-all") return json(res, 200, closeAll);
    if (req.method === "POST" && p === "/api/bots/forget-trade") return (sendCmd(String((await body(req)).key), "forget-trade"), json(res, 200, { ok: true }));
    if (req.method === "POST" && p === "/api/bots/forget") {
      const k = String((await body(req)).key);
      if (bots.get(k)?.proc || bots.get(k)?.wanted) throw new Error("stop it first");
      bots.delete(k);
      saveRegistry();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/api/carry") {
      // Carry calculator: rates as the app shows them (APR %), converted to the bot's units.
      const b = await body(req);
      const f = { perpPct8h: Number(b.perpApr) / 365 / 3, swapLongPctDay: Number(b.swapLongPayApr) / 360, swapShortPctDay: -Number(b.swapShortReceiveApr) / 360 };
      const apr = { long_perp: -Number(b.perpApr) + Number(b.swapShortReceiveApr), short_perp: Number(b.perpApr) - Number(b.swapLongPayApr) };
      const day = { long_perp: (apr.long_perp * 100) / 365, short_perp: (apr.short_perp * 100) / 365 };
      void carryBpsPerDay;
      return json(res, 200, { ...f, bpsPerDay: day, aprPct: apr });
    }
    if (req.method === "POST" && p === "/api/scan") return (startScan(Number((await body(req)).minutes)), json(res, 200, { ok: true }));
    if (req.method === "GET" && p === "/api/scan") return json(res, 200, scan ? { ...scan, proc: undefined } : null);
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 400, { error: (e as Error).message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  if (existsSync(REGISTRY)) {
    try {
      for (const r of JSON.parse(readFileSync(REGISTRY, "utf8"))) {
        if (r.wanted) { try { startBot(r.cfg); console.log(`resumed bot ${r.key}`); } catch (e) { console.log(`couldn't resume ${r.key}: ${(e as Error).message}`); } }
      }
    } catch { /* ignore a corrupt registry */ }
  }
  console.log(`omni-kit panel (${client.environment}, key ${client.publicKey.slice(0, 10)}…)`);
  console.log(`\n  open:  http://127.0.0.1:${PORT}/?t=${TOKEN}\n`);
  if (PUBLIC_HOST) console.log(verifyAccess
    ? `  remote: https://${PUBLIC_HOST}/?t=${TOKEN}  (Cloudflare Access login required)\n`
    : `  remote: ${PUBLIC_HOST} is REFUSED until CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are set\n`);
  console.log("Ctrl-C stops the panel and its bots (open DN positions stay on, hedged).");
});
const shutdown = () => {
  panelStopping = true; // bots stop with the panel but stay "wanted", so they resume on the next start
  for (const b of bots.values()) b.proc?.kill("SIGINT");
  scan?.proc?.kill("SIGINT");
  setTimeout(() => process.exit(0), 4000).unref();
  if (![...bots.values()].some((b) => b.proc)) process.exit(0);
  let left = [...bots.values()].filter((b) => b.proc).length;
  for (const b of bots.values()) b.proc?.on("exit", () => { if (--left <= 0) process.exit(0); });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
