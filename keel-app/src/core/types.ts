export type Side = 'buy' | 'sell';

export interface Order {
  symbol: string; side: Side; qty: number;
  type: 'market' | 'limit'; price?: number;
  stopLoss?: number; takeProfit?: number;
}
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
