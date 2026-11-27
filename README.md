# omni-kit

A TypeScript toolkit for the **Variational Omni API**, which is in early access on testnet. It contains four parts:

| Part | What it is | Run |
|---|---|---|
| **SDK** (`src/sdk`) | Ed25519 request signing, a typed client for all 16 endpoints, rate-budget tracking, exact price/size rounding, and idempotent order placement | `import { OmniClient } from "omni-kit"` |
| **MCP server** (`src/mcp`) | Lets Claude read and trade your account in plain English, using a two-step preview → confirm flow | `omni-mcp` |
| **Dashboard** (`src/tui`) | Live terminal view: mark vs index basis, sparklines, account health, positions, orders, fills, a weight gauge, and a trading command line | `omni-dash` |
| **Web panel** (`src/web`) | Browser control panel: start/stop delta-neutral bots, exit positions, funding-carry calculator, live PnL/spread charts, pairs, positions, scans | `omni-web` |
| **Delta-neutral bot** (`src/bot/dn`) | Swap ⇄ perp arbitrage on the same underlying: finds pairs, trades the spread (or harvests funding) with both legs executed as one unit | `omni-dn` |
| **Grid bot** (`src/bot`) | An example strategy: a ladder of limit orders with an inventory cap, re-quote cooldown, recentering and clean shutdown. Dry run by default | `omni-grid` |
| **Mock exchange** (`src/mock`) | A local, spec-shaped Omni for development and paper trading. It verifies real signatures and enforces the rate limit | `omni-mock` |

## Setup

```bash
npm install && npm run build
```

Create an API key in the Omni **testnet** web app and save the private key (a 32-byte hex seed). Give it the `trade` scope if you want to place orders.

```bash
export OMNI_PRIVATE_KEY=0x...        # never commit this
```

To try everything without a key, start the mock and point the tools at it. Any key works against the mock, and each key starts with 10,000 USDC:

```bash
npm run mock &
export OMNI_BASE_URL=http://localhost:8787 OMNI_PRIVATE_KEY=0x$(openssl rand -hex 32)
```

## MCP server (Claude Code / Claude Desktop)

```bash
claude mcp add omni -e OMNI_PRIVATE_KEY=0x... -e OMNI_MAX_NOTIONAL=500 -- node /path/to/omni-kit/dist/mcp/server.js
```

Or in `claude_desktop_config.json`:

```json
{ "mcpServers": { "omni": {
  "command": "node", "args": ["/path/to/omni-kit/dist/mcp/server.js"],
  "env": { "OMNI_PRIVATE_KEY": "0x...", "OMNI_MAX_NOTIONAL": "500" } } } }
```

Then ask things like:
- *"What's the basis on BTC and ETH right now?"*
- *"Long $300 of ETH with a 3% take-profit and a 1.5% stop."*
- *"Close half my SOL position."* / *"Cancel everything."*

**Tools:** `omni_markets`, `omni_account`, `omni_orders`, `omni_fills`, `omni_preview_order`, `omni_place_order`, `omni_close_position`, `omni_cancel`, `omni_rate_budget`.

**Safety:** `omni_preview_order` rounds the order to the market's rules and checks it against the guardrails. It returns a single-use `confirm_token` that expires after 120 seconds. `omni_place_order` accepts only that token, so the order sent is exactly the order you approved. These environment variables control the guardrails:

| Variable | Effect |
|---|---|
| `OMNI_MAX_NOTIONAL` | Per-order cap in USDC. Defaults to 1000. Reduce-only orders are exempt. |
| `OMNI_READ_ONLY=1` | Turns off all order placement. |
| `OMNI_ALLOW_PROD=1` | Must be set before any order can go to mainnet. |

## Dashboard

```bash
npm run dash
```

```
buy eth $400 tp 1.5% sl 1%     market buy of $400 with a bracket (percentages are from entry)
buy btc 0.002 @90000           limit order
sell doge 300                  market short
close sol                      reduce-only market close
cancel 4a64 | cancel btc | cancel all
q                              quit
```

Each order asks for confirmation (`y`) before it is sent. The poller measures what a refresh cycle really costs, using `X-RateLimit-Remaining`. It then spaces cycles so the dashboard uses at most about 70% of the budget, leaving room for orders. Set `DASH_BUDGET_SHARE` to change that share.

## Web panel

```bash
npm run web
```

The terminal prints a link like `http://127.0.0.1:8790/?t=…`. Open it in your browser.

- **Start a bot:**
  1. Pick a pair.
  2. Paste the funding rates the Omni app shows, as annual %. The carry calculator shows what each
     direction earns and its break-even, and selects the better direction.
  3. Choose a dry run or live, then click Start.
- **Monitor:** each bot card shows its position, the PnL of both legs, funding received, realized PnL,
  fill slippage, the swap market's hours, liquidation prices, live charts and the log.
  The header shows the API weight left.
- **Act:**
  - **Stop** is the only thing that stops a bot. An open position stays on, hedged; Start again resumes it.
  - **Exit position** closes both legs together. If rate-limit weight is short, the exit waits and
    retries. Afterwards the bot keeps running, flat, with new entries paused.
  - **Resume entries** lets a paused bot trade again.
- **Pairs, positions and scans** are on the same page.
- **Close all positions** (on the positions card, asks for confirmation):
  1. Every live bot holding a trade closes both of its legs together, then stays running with new
     entries paused, so nothing re-opens.
  2. Every other position on the account is closed with a reduce-only market order (up to 2% slippage).
  3. A bot leg that can't close yet (e.g. its swap market is shut) is left alone so you stay hedged;
     the bot keeps trying.

  A live report shows each step and ends with a check that the account is flat.
- **Cost per $1M traded (CPM):** shown per bot and in the top row, for live bots only. It's computed
  from every fill the bot has logged for that pair, across all runs.
  - **Execution CPM** is the spread and slippage paid: each fill's distance from the mark price at
    that moment, per $1,000,000 traded.
  - **Net CPM** is everything (price PnL, open-position PnL and funding) per $1,000,000 traded.
    Negative means you earned while trading.
  - Dry runs log paper fills too, so you can estimate CPM before going live.
- **Size by margin:** choose "Margin per trade" and enter the USD margin both legs should use together.
  The API can't set leverage, so the panel reads the leverage set for each market in the Omni app and
  previews the position size: notional per leg = margin ÷ (1/perp leverage + 1/swap leverage).
  The bot re-checks this at entry. If a leg's leverage is unknown, it assumes 1x, giving the smallest
  position. It won't enter if the margin exceeds what's available. Each bot card shows the margin
  in use and the leverage per leg. The CLI equivalent is `--margin-usd`.

Safety:
- The panel listens on 127.0.0.1 only.
- Every call needs the token from the link, so other websites can't drive it.
- The API key stays in the panel's process and never reaches the browser.

The panel and its bots share your key's 60 weight per minute. The bots get priority, so the account
numbers can take a few seconds to appear.

**Bots only stop when you press Stop:**
- **Crashes:** if a bot process dies for any other reason, the panel restarts it after 5s, then 10s,
  20s and so on, up to 5 minutes. It resumes any open trade after checking it against the exchange.
- **Panel restarts:** the bots you left running are saved in `web-bots.json` and come back when the
  panel starts again. Keep the panel itself running, e.g. in `tmux`. Ctrl-C stops the panel and its
  bots, leaving any open position on, hedged.
- **Exits:** after a manual or safety exit (stop loss, liquidation distance, max hold, swap closing),
  the bot keeps running but pauses new entries, so it can't walk straight back into the same loss.
  Press **Resume entries** to trade again. A stat bot's normal spread-reversion exits don't pause it.
- **Problems the bot can't fix:** exchange unreachable at startup, or positions that don't match the
  saved trade. The bot keeps running in a visible *waiting* state and rechecks every 30s. For a
  mismatch, fix the positions on Omni and press **Forget saved trade**; entries stay paused afterwards.
- **Configuration errors** (an unknown pair, legs that aren't the same asset) are the only case the
  panel doesn't retry, because retrying can't fix them. The card shows the error.

## Reach the panel from anywhere (Cloudflare Tunnel + Access)

The bots keep running on your machine. A Cloudflare Tunnel gives the panel a private HTTPS address
such as `https://desk.yourdomain.com`, and Cloudflare Access puts an email login in front of it.
The panel also checks Access's signed login token on every remote request. If the remote-access
settings are missing, it refuses remote requests, so a misconfigured tunnel can't expose it.

**You need:**
- a domain on your Cloudflare account;
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) installed;
- Zero Trust enabled once at one.dash.cloudflare.com (free plan; pick a team name);
- an API token (My Profile › API Tokens › Create Token › Custom) with:
  - Account › Cloudflare Tunnel › Edit
  - Account › Access: Apps and Policies › Edit
  - Account › Access: Organizations, Identity Providers, and Groups › Read
  - Account › Account Settings › Read
  - Zone › Zone › Read and Zone › DNS › Edit (for your domain)

**Then, once:**
```bash
CLOUDFLARE_API_TOKEN=… npm run tunnel:setup -- --host desk.yourdomain.com --email you@example.com
```
It creates (or reuses) the tunnel, routes the hostname to the panel, and adds an Access login that
only your email passes (a one-time code by email). It writes `.env.tunnel` and the tunnel's secret
token to `.tunnel-token`; both are git-ignored. You can re-run it safely.

**Every time:**
```bash
npm run web:remote
```
This starts the panel and the tunnel together; Ctrl-C stops both.
- Open the `remote:` link it prints, and log in with your email.
- After the first visit, the panel remembers its token in a secure cookie, so a bookmark works
  (e.g. on your phone).
- The panel token is kept in `.web-token`. Delete that file to rotate the token.

## Reach the panel without a domain (free Cloudflare quick tunnel)

No domain or Cloudflare account setup is needed, only
[`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

```bash
npm run web:password   # once: set a password (12+ characters; typing isn't shown)
npm run web:quick      # starts the quick tunnel and the panel; Ctrl-C stops both
```
- It prints `READY: https://<random-words>.trycloudflare.com` once the tunnel is connected and the
  address resolves on public DNS (this takes 10–60 seconds). Open that link and log in with your
  password. The address changes every time you start it.
- It uses `--protocol http2` (plain HTTPS on port 443), which gets through most firewalls; set
  `TUNNEL_PROTOCOL=quic` to use QUIC. If the tunnel can't connect, the launcher says so, shows
  `cloudflared`'s last messages, and saves the full output to `.tunnel.log`.
- The panel only answers that exact address remotely, and only after a password login.
- The password is stored only as a salted scrypt hash in `.web-password`.
- Sessions last 12 hours, held in a secure, same-site-only cookie. There's a "Log out" button.
- Brute-force protection: 5 wrong passwords from one address lock it out for 15 minutes; 20 failures
  in an hour lock remote login for an hour. Local access at `127.0.0.1` keeps working throughout.

Quick tunnels are offered by Cloudflare for testing, with no uptime guarantee. For a stable address
with Cloudflare's email-code login in front, use the domain setup above.

## Delta-neutral swap ⇄ perp bot

Several underlyings (gold, silver, platinum, palladium, US500, and oil, copper and natural gas under
different codes) trade on Omni both as a **perp** and as a **swap**:

| | Perp | Swap |
|---|---|---|
| Hours | 24/7 | Trading hours, closed weekends |
| Funding | Crypto-style, variable (paid every 1–8h) | TradFi financing (SOFR-like), daily, different long/short rates |
| Margin | Cross or isolated | Isolated only |

The bot holds equal USD notional long on one and short on the other. Moves in the underlying cancel out,
which leaves two things to earn:
- **Spread reversion** (`--mode stat`): the perp/swap price ratio wanders around its average. The bot sells
  the rich leg and buys the cheap one when the spread is stretched, then exits when it comes back.
- **Funding carry** (`--mode carry`): the bot holds one direction to collect the funding difference between
  the legs.

### 1. Scan first

```bash
npm run dn -- scan --minutes 5
```

The scan lists every perp/swap pair on your account and shows how each instrument was classified.
It then samples prices and ranks the pairs by how far the spread swings compared with the cost of
four fills. **Run this on testnet before anything else:** the API docs don't show how swaps are named,
so if a pair is missing, add its code to `ALIASES` in `src/bot/dn/core.ts`.

### 2. Dry run, then live

```bash
npm run dn -- run --pair XAU                                   # paper fills against real prices
npm run dn -- run --pair XAU --live --notional-usd 500         # trades
npm run dn -- run --pair XAU --mode carry --dir short_perp \
  --perp-funding 0.01 --swap-long-funding 0.012 --live         # funding carry
```

**Funding rates are pulled automatically** with `--auto-funding` (the web panel turns it on by
default). They come from Omni's public stats feed, `GET /metadata/v2/stats`, which publishes the same
numbers the app shows. It needs no key and costs no API weight. The documented host is mainnet's;
testnet mirrors its rates, which I checked against the testnet app. Set `OMNI_STATS_URL` to use
another feed.

With auto funding, the bot:
- refreshes the rates every 15 minutes;
- takes the round-trip cost from the quoted bid/ask spreads;
- in carry mode, only enters while carry for the chosen direction is positive;
- with `--exit-if-negative-carry-hours N`, exits (and pauses entries) once carry has stayed negative
  for N hours. Fractions work: `0.5` means 30 minutes. The panel takes hours and minutes. The timer
  starts at the first 15-minute rate check that shows negative carry and resets if a later check
  shows it positive again. `0` means never: the bot only warns.

The rates need two corrections:
- **Weekend payments.** Swap payments that cover a weekend are published at about 3× the daily rate,
  so the bot normalises them to a regular day.
- **Futures-roll swaps.** For futures-referenced swaps (oil, copper, gas, cocoa, VIX, dollar index),
  the funding just offsets the index rolling along the futures curve. A hedged position gives it back
  through the price, so it isn't real carry: the bot flags these and won't enter them.

You can still pass `--perp-funding` / `--swap-long-funding` / `--swap-short-funding` by hand.
Afterwards, check the positions' `cum_funding`; the bot prints it while a position is open.

### How it stays safe

- **Paired execution.** Both legs are sent back to back (about 3ms apart against the mock) and confirmed
  together. If one leg fails, it is retried. If it still fails, the leg that filled is unwound, so the bot
  never stays one-sided.
- **Weight reserved for trading.** The bot won't start a pair unless the rate budget covers both legs
  and the fill checks. When flat, polling only spends weight above that reserve.
- **Swap hours.** The bot only enters while the swap is open and not close to its close. In stat mode
  it exits before the swap closes. If the swap is closed when an exit is due, it keeps both legs on
  (still hedged) rather than closing only the perp.
- **Clean statistics.** The spread statistics are updated only while the swap is open and its price is
  fresh, so a closed market's frozen price can't skew them.
- **Per-cycle risk checks while open:**
  - each leg's distance to liquidation;
  - hedge drift, fixed by topping up the perp leg;
  - a stop-loss on the combined legs' PnL;
  - a maximum holding time.
- **State survives restarts.** State lives in `dn-<PAIR>.json`. Ctrl-C leaves an open position on, since
  it is hedged, and the next run resumes managing it. If the exchange positions don't match the state
  file, the bot refuses to trade until you fix it.

### Key flags

| Flag | Default | Meaning |
|---|---|---|
| `--notional-usd` | 500 | Size of each leg |
| `--entry-z` / `--exit-z` | 2 / 0.5 | Enter when \|z\| ≥ entry; exit when ≤ exit or the spread crosses its mean |
| `--round-trip-bps` | 24 | Estimated cost of four fills. Measure it: each fill's slippage is logged in `dn-<PAIR>.jsonl` |
| `--min-edge-bps` | 5 | Required edge after costs (and expected carry) |
| `--half-life-min` / `--min-samples` | 60 / 30 | Memory of the spread average, and the warm-up before trading |
| `--stop-loss-usd` / `--max-hold-hours` | 25 / 24 | Exit limits |
| `--min-liq-dist-pct` / `--max-drift-pct` | 15 / 5 | Liquidation-distance exit and hedge rebalance trigger |
| `--flat-before-close-min` | 15 | Stat mode: exit this long before the swap closes, and don't enter within twice that |
| `--poll` | 10 | Seconds between checks |

Caveats:
- The swap leg is isolated-margin only. A big move can stress it while the gain sits on the perp leg.
  Keep notional modest and watch the liquidation-distance exits.
- The mock's spread dynamics are made up. Whether real perp/swap spreads swing enough to beat costs is
  exactly what `scan` is for.

The market-making bot that preceded this is parked on the `parked/market-maker` branch.

## Grid bot

```bash
npm run grid -- --symbol BTC --levels 3 --spacing 0.3 --order-usd 50 --max-pos-usd 300            # dry run
npm run grid -- --symbol BTC --levels 3 --spacing 0.3 --order-usd 50 --max-pos-usd 300 --live     # trades
```

- The bot keeps limit buys below the mark and limit sells above it, nearest levels first.
- The inventory cap counts the open position **and** resting orders, so several fills in one cycle can't overshoot it.
- A level that just filled isn't re-quoted until price moves a full step away, which stops churn.
- When price leaves the ladder, the bot recenters and cancels only its own orders (tagged `grid:<run>:…` in `client_order_id`).
- When weight drops low, it defers new orders and lengthens its interval.
- On Ctrl-C it finishes the current cycle, then cancels its resting orders. The position is left open.

## SDK

```ts
import { OmniClient, checkOrder, roundPrice } from "omni-kit";

const omni = new OmniClient();                        // reads OMNI_PRIVATE_KEY / OMNI_ENV / OMNI_BASE_URL
const btc = await omni.instrument("BTC-PERP");
const { mark_price } = await omni.ticker("BTC-PERP");

const chk = checkOrder(btc, { side: "buy", size: "0.01", refPrice: mark_price! });
if (chk.problems.length) throw new Error(chk.problems.join("; "));

const [parent, sl] = await omni.placeOrder({
  type: "market", symbol: "BTC-PERP", side: "buy", size: chk.size, max_slippage: "0.005",
  stop_loss: { trigger_price: roundPrice(Number(mark_price) * 0.98, btc.price_precision), trigger_by: "mark", max_slippage: null },
});
const final = await omni.waitForOrder(parent.order_id);   // 202 means accepted, not filled
console.log(final.status, final.fill_price, omni.budget);
```

What the client handles for you:
- **Signing:** builds the 7-line canonical string, signs it with Ed25519 through `node:crypto` (no crypto dependencies), and signs exactly the body bytes it sends.
- **Clock skew:** learns from `server_time_ms` on `timestamp_out_of_window` and re-signs.
- **Retries:** honours `retry_after_ms` on `rate_limited` and `overloaded`. Retries `unknown_key` a few times, because new keys take a few seconds to become usable. Every retry is re-signed, since `trade` endpoints reject replayed signatures.
- **Idempotent orders:** a `client_order_id` is always set. On `outcome_unknown` or a network error, the client looks the order up instead of sending it again blindly. `duplicate_client_order_id` resolves to the existing order.
- **Rate budget:** tracks `X-RateLimit-*` headers. Requests are serialised so the accounting stays accurate. Pass `reserve` to keep weight free.
- **Precision:** `roundPrice` implements `price_precision` (decimal and significant-figure rules), and `roundSize` implements `size_step`. Both use BigInt fixed point, so there is no float drift.

## Tests

```bash
npm test
```

The tests cover the official signing test vector from the docs, the precision rules, a client round trip against the mock, signature rejection, and a full MCP session over stdio: preview, bracket order, single-use token, close, cancel and guardrails.

## Notes and caveats

- Base URLs: testnet `https://api.omni.testnet.variational.io`, which is signed with the environment name `testnet`. Mainnet is "coming soon" and is signed with `prod`.
- Every endpoint, including market data, needs a signed request.
- The limit is 60 weight per minute on a sliding window. `/v1/status` measured 1 weight on testnet. The docs say most endpoints cost 1–5 weight.
- There is no WebSocket API yet. Variational says one is coming after early access, along with higher limits.
- Expect breaking changes while the API is in early access.
- The mock's weights, fill model, OLP spread and margin math are simplified guesses. Treat the real testnet as the source of truth.
