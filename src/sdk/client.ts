// Typed REST client for the Variational Omni API.
import { randomBytes } from "node:crypto";
import { Signer } from "./signing.js";
import type {
  Account, ApiStatus, ErrorBody, Fill, Instrument, Order, Page, PlaceOrder, Position, Ticker,
} from "./types.js";

export const ENVIRONMENTS = {
  testnet: "https://api.omni.testnet.variational.io",
  prod: "https://api.omni.variational.io",
} as const;

export class OmniError extends Error {
  constructor(readonly status: number, readonly body: ErrorBody) {
    super(`${status} ${body.error_code}: ${body.error_message}`);
    this.name = "OmniError";
  }
  get code() {
    return this.body.error_code;
  }
}

export interface RateBudget {
  limit: number | null;
  remaining: number | null;
  resetAt: number | null; // unix ms when the full budget is back
  updatedAt: number;
}

export interface OmniClientOptions {
  /** 32-byte Ed25519 seed (hex). Defaults to env OMNI_PRIVATE_KEY. */
  privateKey?: string;
  /** "testnet" (default) or "prod". Defaults to env OMNI_ENV. */
  environment?: "testnet" | "prod" | string;
  /** Override base URL (e.g. the local mock: http://localhost:8787). Defaults to env OMNI_BASE_URL. */
  baseUrl?: string;
  /** Keep this many weight units in reserve; requests wait for the window rather than dip below it. */
  reserve?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
  /** Called after every response with the latest budget. */
  onBudget?: (b: RateBudget) => void;
  /** Called on every request: method, path, status, ms. */
  onRequest?: (info: { method: string; path: string; status: number; ms: number }) => void;
}

type Query = Record<string, string | number | boolean | undefined | null>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function newClientOrderId(prefix = "omnikit"): string {
  // ≤36 chars of [A-Za-z0-9_:-], never reused per account.
  const id = `${prefix}:${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
  return id.slice(0, 36);
}

export class OmniClient {
  readonly baseUrl: string;
  readonly environment: string;
  readonly signer: Signer;
  budget: RateBudget = { limit: null, remaining: null, resetAt: null, updatedAt: 0 };
  /** serverTime - localTime, learned from timestamp errors and Date headers. */
  clockOffsetMs = 0;

  private readonly fetchImpl: typeof fetch;
  private readonly opts: OmniClientOptions;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: OmniClientOptions = {}) {
    this.opts = opts;
    const env = opts.environment ?? process.env.OMNI_ENV ?? "testnet";
    this.environment = env;
    this.baseUrl = (opts.baseUrl ?? process.env.OMNI_BASE_URL ?? ENVIRONMENTS[env as keyof typeof ENVIRONMENTS])
      ?.replace(/\/$/, "");
    if (!this.baseUrl) throw new Error(`Unknown environment ${env}; pass baseUrl`);
    const pk = opts.privateKey ?? process.env.OMNI_PRIVATE_KEY;
    if (!pk) throw new Error("Missing API private key: set OMNI_PRIVATE_KEY (32-byte hex seed from Omni → API keys)");
    this.signer = new Signer(pk, env);
    this.fetchImpl = opts.fetch ?? fetch;
  }

  get publicKey() {
    return this.signer.publicKey;
  }

  // ---------- Market data ----------
  status() {
    return this.get<{ status: ApiStatus }>("/v1/status");
  }
  instruments() {
    return this.get<Page<Instrument>>("/v1/instruments").then((p) => p.results);
  }
  instrument(symbol: string) {
    return this.get<Instrument>(`/v1/instruments/${encodeURIComponent(symbol)}`);
  }
  tickers() {
    return this.get<Page<Ticker>>("/v1/tickers").then((p) => p.results);
  }
  ticker(symbol: string) {
    return this.get<Ticker>(`/v1/tickers/${encodeURIComponent(symbol)}`);
  }

  // ---------- Account ----------
  account() {
    return this.get<Account>("/v1/account");
  }
  positions() {
    return this.get<Page<Position>>("/v1/positions").then((p) => p.results);
  }
  position(symbol: string) {
    return this.get<Position>(`/v1/positions/${encodeURIComponent(symbol)}`);
  }

  // ---------- Orders ----------
  /** Pending orders (queued/open/untriggered). */
  openOrders(filter: { symbol?: string } = {}) {
    return this.get<Page<Order>>("/v1/orders", filter).then((p) => p.results);
  }
  /** One order by client_order_id, in any status (null if unknown). */
  orderByClientId(clientOrderId: string) {
    return this.get<Page<Order>>("/v1/orders", { client_order_id: clientOrderId }).then((p) => p.results[0] ?? null);
  }
  order(orderId: string) {
    return this.get<Order>(`/v1/orders/${encodeURIComponent(orderId)}`);
  }
  orderHistory(q: { symbol?: string; start?: number; end?: number; limit?: number; cursor?: string } = {}) {
    return this.get<Page<Order>>("/v1/orders/history", q);
  }
  fills(q: { symbol?: string; start?: number; end?: number; limit?: number; cursor?: string } = {}) {
    return this.get<Page<Fill>>("/v1/fills", q);
  }

  /**
   * Places an order. Adds a client_order_id if missing so retries are idempotent:
   * on `outcome_unknown` / network failure the order is looked up instead of re-sent blindly,
   * and `duplicate_client_order_id` resolves to the existing order.
   */
  async placeOrder(order: PlaceOrder): Promise<Order[]> {
    const body = { ...order, client_order_id: order.client_order_id ?? newClientOrderId() };
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.request<{ placed: Order[] }>("POST", "/v1/orders", undefined, body);
        return res.placed;
      } catch (e) {
        if (e instanceof OmniError && e.code === "duplicate_client_order_id" && e.body.order) return [e.body.order];
        const uncertain = !(e instanceof OmniError) || e.code === "outcome_unknown";
        if (!uncertain || attempt >= 2) throw e;
        await sleep(500 * (attempt + 1));
        const existing = await this.orderByClientId(body.client_order_id).catch(() => null);
        if (existing) return [existing];
      }
    }
  }

  cancelOrder(id: { order_id: string } | { client_order_id: string }) {
    return this.request<Order>("DELETE", "/v1/orders", id);
  }
  /** Cancels every pending order, or every pending order on one symbol. */
  cancelAll(symbol?: string) {
    return this.request<{ canceled: Order[] }>("DELETE", "/v1/orders/batch", symbol ? { symbol } : { all: true })
      .then((r) => r.canceled);
  }

  /** Polls an order until it leaves `queued` (or the timeout passes). */
  async waitForOrder(orderId: string, { timeoutMs = 15000, intervalMs = 1500 } = {}): Promise<Order> {
    const deadline = Date.now() + timeoutMs;
    let o = await this.order(orderId);
    while (o.status === "queued" && Date.now() < deadline) {
      await sleep(intervalMs);
      o = await this.order(orderId);
    }
    return o;
  }

  /** Iterates a paginated endpoint (fills / order history), newest first. */
  async *paginate<T>(fetchPage: (cursor?: string) => Promise<Page<T>>, maxPages = Infinity): AsyncGenerator<T> {
    let cursor: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const page = await fetchPage(cursor);
      yield* page.results;
      if (!page.next) return;
      cursor = page.next;
    }
  }

  // ---------- Transport ----------
  get<T>(path: string, query?: Query) {
    return this.request<T>("GET", path, query);
  }

  /** Requests are serialised so rate-budget accounting stays accurate under concurrency. */
  request<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
    const run = () => this.send<T>(method, path, query, body);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async waitForBudget() {
    const b = this.budget;
    const reserve = this.opts.reserve ?? 0;
    if (b.remaining === null || b.resetAt === null) return;
    if (b.remaining > reserve) return;
    const wait = b.resetAt - Date.now();
    if (wait > 0) await sleep(Math.min(wait, 60_000));
    // The window slides, so assume weight came back; the next response corrects us.
    this.budget = { ...b, remaining: b.limit };
  }

  private async send<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
    let qs = "";
    if (query) {
      const parts = Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
      if (parts.length) qs = "?" + parts.join("&");
    }
    const pathAndQuery = path + qs;
    const bodyStr = body === undefined ? "" : JSON.stringify(body);
    const maxRetries = this.opts.maxRetries ?? 3;
    let unknownKeyRetries = 0;

    for (let attempt = 0; ; attempt++) {
      await this.waitForBudget();
      const ts = Date.now() + this.clockOffsetMs;
      const headers: Record<string, string> = { ...this.signer.sign(method, pathAndQuery, bodyStr, ts) };
      if (bodyStr) headers["content-type"] = "application/json";
      const t0 = Date.now();
      const res = await this.fetchImpl(this.baseUrl + pathAndQuery, {
        method,
        headers,
        body: bodyStr || undefined,
      });
      this.readBudget(res.headers);
      this.opts.onRequest?.({ method, path: pathAndQuery, status: res.status, ms: Date.now() - t0 });
      const text = await res.text();
      let json: any = undefined;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        /* non-JSON */
      }
      if (res.ok) return json as T;

      const err: ErrorBody =
        json && typeof json.error_code === "string"
          ? json
          : { error_code: `http_${res.status}`, error_message: text.slice(0, 300) || res.statusText };
      if (err.server_time_ms) this.clockOffsetMs = err.server_time_ms - Date.now();

      const retryable =
        err.error_code === "timestamp_out_of_window" ||
        err.error_code === "rate_limited" ||
        err.error_code === "overloaded" ||
        err.error_code === "service_unavailable" ||
        (err.error_code === "unknown_key" && unknownKeyRetries++ < 3); // new keys take a few seconds
      if (!retryable || attempt >= maxRetries) throw new OmniError(res.status, err);
      await sleep(err.retry_after_ms ?? (err.error_code === "unknown_key" ? 2000 : 250));
    }
  }

  private readBudget(h: Headers) {
    const limit = h.get("x-ratelimit-limit");
    const remaining = h.get("x-ratelimit-remaining");
    const reset = h.get("x-ratelimit-reset");
    if (limit === null && remaining === null) return;
    this.budget = {
      limit: limit !== null ? Number(limit) : this.budget.limit,
      remaining: remaining !== null ? Number(remaining) : this.budget.remaining,
      resetAt: reset !== null ? Number(reset) * 1000 : this.budget.resetAt,
      updatedAt: Date.now(),
    };
    this.opts.onBudget?.(this.budget);
  }
}
