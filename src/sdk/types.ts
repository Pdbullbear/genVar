// Types mirroring the Omni OpenAPI spec (v1, testnet early access).
// All decimals are strings; keep them as strings until you need arithmetic.

export type Decimal = string;
export type Side = "buy" | "sell";
export type TriggerBy = "mark" | "quote";
export type MarginMode = "cross" | "isolated";
export type MarketStatus = "open" | "closed" | "halted";
export type ApiStatus = "ok" | "cancel_only" | "maintenance";
export type OrderType = "market" | "limit" | "take_profit" | "stop_loss" | "stop_limit";
export type OrderStatus = "queued" | "open" | "untriggered" | "filled" | "rejected" | "canceled";
export type TradeType = "trade" | "settlement" | "settlement_market_delisted" | "liquidation";

export interface PricePrecision {
  min_decimal_figures: number;
  max_decimal_only_figures: number;
  max_significant_figures: number;
}

export interface Instrument {
  symbol: string;
  underlying: string;
  settlement_asset: string;
  contract_multiplier: number;
  price_precision: PricePrecision;
  size_step: Decimal | null;
  min_notional: Decimal;
  close_only: boolean;
  margin_modes: MarginMode[];
  status: MarketStatus | null;
  next_open_at?: number | null;
  next_close_at?: number | null;
  scheduled_delist_at?: number | null;
}

export interface Ticker {
  symbol: string;
  mark_price: Decimal | null;
  index_price: Decimal | null;
  updated_at: number | null;
}

export interface CrossSummary {
  balance: Decimal;
  initial_margin: Decimal;
  maintenance_margin: Decimal;
  available: Decimal;
}

export interface IsolatedSummary extends CrossSummary {
  symbol: string;
  allocated: Decimal;
}

export interface Account {
  equity: Decimal;
  unrealized_pnl: Decimal;
  initial_margin: Decimal;
  maintenance_margin: Decimal;
  cross: CrossSummary;
  isolated: IsolatedSummary[];
}

export interface Position {
  symbol: string;
  size: Decimal; // + long, - short
  entry_price: Decimal | null;
  mark_price: Decimal | null;
  unrealized_pnl: Decimal;
  realized_pnl: Decimal;
  cum_funding: Decimal;
  initial_margin: Decimal;
  maintenance_margin: Decimal;
  margin_mode: MarginMode;
  isolated_margin: Decimal | null;
  leverage: Decimal | null;
  liquidation_price: Decimal | null;
  opened_at: number | null;
  updated_at: number | null;
}

export interface Order {
  order_id: string;
  client_order_id: string | null;
  parent_order_id: string | null;
  symbol: string | null;
  side: Side;
  size: Decimal | null;
  reduce_only: boolean;
  max_slippage: Decimal | null;
  created_at: number;
  type: OrderType;
  status: OrderStatus;
  price?: Decimal;
  trigger_price?: Decimal;
  trigger_by?: TriggerBy;
  fill_price?: Decimal;
  reason?: string | null;
  detail?: { limit: string; max: Decimal; value: Decimal } | null;
}

export interface Fill {
  trade_id: string;
  order_id: string | null;
  client_order_id: string | null;
  symbol: string | null;
  type: TradeType;
  side: Side;
  size: Decimal;
  price: Decimal;
  created_at: number;
}

export interface Page<T> {
  results: T[];
  next?: string | null;
  prev?: string | null;
}

export interface ChildOrder {
  trigger_price: Decimal;
  trigger_by: TriggerBy;
  max_slippage: Decimal | null;
}

interface BaseOrder {
  symbol: string;
  side: Side;
  size: Decimal;
  client_order_id?: string;
}

export type PlaceOrder =
  | (BaseOrder & {
      type: "market";
      max_slippage: Decimal;
      reduce_only?: boolean;
      take_profit?: ChildOrder;
      stop_loss?: ChildOrder;
    })
  | (BaseOrder & {
      type: "limit";
      price: Decimal;
      trigger_by: TriggerBy;
      max_slippage: Decimal | null;
      reduce_only?: boolean;
      take_profit?: ChildOrder;
      stop_loss?: ChildOrder;
    })
  | (BaseOrder & {
      type: "take_profit" | "stop_loss";
      trigger_price: Decimal;
      trigger_by: TriggerBy;
      max_slippage: Decimal | null;
    });

export interface ErrorBody {
  error_code: string;
  error_message: string;
  error_fields?: unknown[];
  order?: Order | null;
  request_id?: string | null;
  retry_after_ms?: number | null;
  server_time_ms?: number | null;
}
