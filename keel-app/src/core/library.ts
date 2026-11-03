/** Keel's starter strategies. Simple examples for testing, not proven to make money. */
export const LIBRARY = [
  { key: 'keels-special', title: "Keel's Special", blurb: 'Trades with the bigger trend. Waits for a break of structure, a pullback to the middle of that move, and a second break, then enters with the stop under the pullback and a 2R target.',
    cfg: { type: 'keels_special', name: "Keel's Special", symbol: 'MNQ', qty: 1, takeProfit: 0, stopLoss: 0, ltf: 60, htfMult: 15, fastEma: 20, slowEma: 50, swing: 2, retrace: 50, rr: 2, timeout: 30, buffer: 2 } },
  { key: 'quick-cross', title: 'Quick trend cross', blurb: 'Buys when a fast average crosses above a slow one, and exits when it crosses back.',
    cfg: { type: 'ma_cross', name: 'Quick trend cross', symbol: 'MNQ', qty: 1, fast: 5, slow: 20, ma: 'ema', takeProfit: 20, stopLoss: 10 } },
  { key: 'steady-trend', title: 'Steady trend', blurb: 'A slower average cross that trades less often and rides longer moves.',
    cfg: { type: 'ma_cross', name: 'Steady trend', symbol: 'MES', qty: 1, fast: 20, slow: 60, ma: 'sma', takeProfit: 12, stopLoss: 6 } },
  { key: 'rsi-bounce', title: 'RSI bounce', blurb: 'Buys after a sharp dip (RSI under 30) and exits once price recovers (RSI over 70).',
    cfg: { type: 'rsi', name: 'RSI bounce', symbol: 'MES', qty: 1, period: 14, low: 30, high: 70, takeProfit: 0, stopLoss: 8 } },
  { key: 'range-breakout', title: 'Range breakout', blurb: 'Buys when price breaks above its recent high and exits when it falls below its recent low.',
    cfg: { type: 'breakout', name: 'Range breakout', symbol: 'MNQ', qty: 1, lookback: 30, takeProfit: 25, stopLoss: 12 } }
] as const;
