export type Side = 'buy' | 'sell';

export interface Order {
  symbol: string; side: Side; qty: number;
  /** 'stop' = stop-market order that triggers at `price`; 'limit' rests at `price`;
   *  'stoplimit' = triggers at `trigger`, then works as a limit at `price` (never fills worse than `price`). */
  type: 'market' | 'limit' | 'stop' | 'stoplimit'; price?: number; trigger?: number;
  stopLoss?: number; takeProfit?: number;
  /** True when a person placed this order by hand (the exchange's manual / automated order tag). Default: automated. */
  manual?: boolean;
}
/** A working (unfilled) order at the broker. */
export interface WorkingOrder { id: string; symbol: string; side: Side; qty: number; type: 'market' | 'limit' | 'stop' | 'stoplimit' | 'other'; price: number | null; trigger?: number | null }
export type HistUnit = 'min1' | 'min5' | 'min15' | 'hour' | 'hour4' | 'day';
export interface HistBar { t: number; o: number; h: number; l: number; c: number; v: number }
export interface Position { symbol: string; qty: number; avgPrice: number; pnl?: number }
export interface DayResult { date: string; pnl: number }
/** What a broker can tell us about the account itself. */
export interface AccountInfo { name: string; size: number; startBalance: number; balance: number; maxLoss: number; floor?: number; days: DayResult[] }

export interface Quote { symbol: string; price: number; ts: number }
export interface Signal { symbol: string; side: Side; qty: number; source: 'strategy' | 'tradingview'; strategyId?: string; from?: string; tp?: number; sl?: number }

/** Every broker or prop firm implements this one interface. */
export interface BrokerAdapter {
  readonly id: string;
  readonly name: string;
  /** Credentials are passed in from the main process only. Never log them. */
  connect(creds: Record<string, string>): Promise<void>;
  disconnect(): Promise<void>;
  placeOrder(o: Order): Promise<string>;
  closeAll(): Promise<void>;
  getPositions(): Promise<Position[]>;
  getDailyPnL(): Promise<number>;
  /** Optional: today's P&L split into closed and open, plus open positions with their P&L. */
  getPnLBreakdown?(): Promise<{ realized: number; unrealized: number; positions: Position[] }>;
  onQuote(cb: (q: Quote) => void): void;
  /** Optional: account name, balance and recent daily results. */
  getAccount?(): Promise<AccountInfo | null>;
  /** Optional: recent bars for a market (for warming up strategies and the chart). */
  getBars?(symbol: string, seconds: number, count: number): Promise<{ t: number; o: number; h: number; l: number; c: number }[]>;
  /** Start live prices for these symbols (if the broker has a price feed). */
  subscribe?(symbols: string[]): Promise<void>;
  /** Optional: completed history bars (t = bar open time, ms UTC) for the front-month contract, oldest first. */
  getHistory?(symbol: string, unit: HistUnit, count: number, partial?: boolean): Promise<HistBar[]>;
  /** Optional: working orders, and changing / cancelling one. Needed for broker-side stops (K system live mode). */
  getOpenOrders?(): Promise<WorkingOrder[]>;
  modifyOrder?(id: string, change: { price: number }): Promise<void>;
  cancelOrder?(id: string): Promise<void>;
  /** Optional: two orders where the first fill cancels the other, held by the broker's servers (Rithmic). Returns both order ids. */
  placeOco?(a: Order, b: Order): Promise<[string, string]>;
  /** Optional: called as soon as the broker reports a fill (so stops go in within a fraction of a second, not at the next check). */
  onFill?(cb: () => void): void;
  /** Optional: last traded price Keel has seen for a symbol. */
  lastPrice?(symbol: string): number | undefined;
}

export interface Strategy {
  id: string; name: string;
  onQuote(q: Quote): Signal | Signal[] | null;
  /** Set when a strategy stops itself (for example a Pine script error). */
  error?: string;
  /** Optional: past bars to get ready before live prices arrive. */
  warmup?(bars: { t: number; o: number; h: number; l: number; c: number }[]): void;
  /** Called when Keel closes the strategy's position for it (take profit, stop loss, or a blocked entry). */
  reset?(): void;
}
