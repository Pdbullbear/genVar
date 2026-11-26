# omni-kit

A TypeScript toolkit for the **Variational Omni API**, which is in early access on testnet. It contains four parts:

| Part | What it is | Run |
|---|---|---|
| **SDK** (`src/sdk`) | Ed25519 request signing, a typed client for all 16 endpoints, rate-budget tracking, exact price/size rounding, and idempotent order placement | `import { OmniClient } from "omni-kit"` |
| **MCP server** (`src/mcp`) | Lets Claude read and trade your account in plain English, using a two-step preview → confirm flow | `omni-mcp` |
| **Dashboard** (`src/tui`) | Live terminal view: mark vs index basis, sparklines, account health, positions, orders, fills, a weight gauge, and a trading command line | `omni-dash` |
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
