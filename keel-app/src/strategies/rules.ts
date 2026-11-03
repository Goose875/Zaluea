import { Quote, Signal, Strategy } from '../core/types';
import { checkPine, PineRunner, TICK, Bar } from '../pine/run';
import { buildSpecial, SpecialConfig } from './special';

/** Strategies are plain data. No user code is ever executed. */
/** takeProfit and stopLoss are in points from the entry price. 0 = off. */
interface Base { name: string; symbol: string; qty: number; takeProfit: number; stopLoss: number }
export type StrategyConfig =
  | (Base & { type: 'ma_cross'; fast: number; slow: number; ma: 'sma' | 'ema' })
  | (Base & { type: 'rsi'; period: number; low: number; high: number })
  | (Base & { type: 'breakout'; lookback: number })
  | (Base & { type: 'tradingview' })
  | (Base & { type: 'pine'; timeframe: number; script: string })
  | SpecialConfig;

export const TIMEFRAMES = [15, 30, 60, 300, 900, 3600];   // seconds

const SYM = /^[A-Z0-9._-]{1,12}$/;

export function parseStrategy(raw: any): StrategyConfig {
  if (!raw || typeof raw !== 'object') throw new Error('That strategy is not valid.');
  const type = raw.type === 'sma_cross' ? 'ma_cross' : raw.type;
  const name = String(raw.name ?? '').trim();
  if (!name || name.length > 60) throw new Error('Give the strategy a name (up to 60 characters).');
  const symbol = String(raw.symbol ?? '').trim().toUpperCase();
  if (!SYM.test(symbol)) throw new Error('Enter a market like MNQ or ES.');
  const int = (v: unknown, lo: number, hi: number, what: string) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what} must be a whole number from ${lo} to ${hi}.`);
    return v;
  };
  const qty = int(raw.qty, 1, 100, 'Contracts');
  const pts = (v: unknown, what: string) => {
    if (v === undefined || v === null || v === '') return 0;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10000) throw new Error(`${what} must be a number of points from 0 to 10,000.`);
    return Math.round(v * 100) / 100;
  };
  const b = { name, symbol, qty, takeProfit: pts(raw.takeProfit, 'Take profit'), stopLoss: pts(raw.stopLoss, 'Stop loss') };
  switch (type) {
    case 'ma_cross': {
      const fast = int(raw.fast, 2, 200, 'Fast length'), slow = int(raw.slow, 3, 500, 'Slow length');
      if (slow <= fast) throw new Error('The slow length must be bigger than the fast length.');
      return { type, ...b, fast, slow, ma: raw.ma === 'ema' ? 'ema' : 'sma' };
    }
    case 'rsi': {
      const period = int(raw.period, 2, 100, 'RSI length'), low = int(raw.low, 1, 99, 'Buy level'), high = int(raw.high, 1, 99, 'Exit level');
      if (high <= low) throw new Error('The exit level must be above the buy level.');
      return { type, ...b, period, low, high };
    }
    case 'breakout': return { type, ...b, lookback: int(raw.lookback, 5, 500, 'Lookback') };
    case 'tradingview': return { type, ...b };
    case 'keels_special': {
      const ltf = raw.ltf; if (![15, 30, 60, 120, 300].includes(ltf)) throw new Error('Pick an entry bar size.');
      const n = (v: unknown, lo: number, hi: number, what: string) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${what} must be from ${lo} to ${hi}.`); return v; };
      const fastEma = int(raw.fastEma, 2, 200, 'Fast EMA'), slowEma = int(raw.slowEma, 3, 400, 'Slow EMA');
      if (slowEma <= fastEma) throw new Error('The slow EMA must be longer than the fast EMA.');
      return { type, ...b, ltf, htfMult: int(raw.htfMult, 2, 240, 'Bias bars'), fastEma, slowEma, swing: int(raw.swing, 1, 10, 'Swing size'),
        retrace: n(raw.retrace, 10, 90, 'Pullback %'), rr: n(raw.rr, 0.5, 10, 'Reward to risk'), timeout: int(raw.timeout, 3, 500, 'Wait'), buffer: int(raw.buffer, 0, 100, 'Stop buffer') };
    }
    case 'pine': {
      if (!TIMEFRAMES.includes(raw.timeframe)) throw new Error('Pick a bar size.');
      const script = String(raw.script ?? '');
      const chk = checkPine(script);
      if (!chk.ok) throw new Error(chk.error);
      return { type, ...b, timeframe: raw.timeframe, script };
    }
    default: throw new Error('Unknown strategy type.');
  }
}

/**
 * Turns a config into a running strategy. All built-in strategies are long or flat:
 * they buy to enter and sell the same size to exit. TradingView strategies have no
 * code here: TradingView decides and sends alerts.
 */
export function buildStrategy(cfg: StrategyConfig, id = cfg.name): Strategy | null {
  if (cfg.type === 'tradingview') return null;
  if (cfg.type === 'pine') return pineStrategy(cfg, id);
  if (cfg.type === 'keels_special') return buildSpecial(cfg, id);
  let inPos = false;
  const buy = (): Signal => { inPos = true; return { symbol: cfg.symbol, side: 'buy', qty: cfg.qty, source: 'strategy', from: cfg.name, strategyId: id }; };
  const sell = (): Signal => { inPos = false; return { symbol: cfg.symbol, side: 'sell', qty: cfg.qty, source: 'strategy', from: cfg.name, strategyId: id }; };
  const reset = () => { inPos = false; };
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

  if (cfg.type === 'ma_cross') {
    const prices: number[] = []; let fastV = 0, slowV = 0, n = 0, prev = 0;
    const kF = 2 / (cfg.fast + 1), kS = 2 / (cfg.slow + 1);
    return { id, name: cfg.name, reset, onQuote(q: Quote) {
      if (q.symbol !== cfg.symbol) return null;
      n++;
      if (cfg.ma === 'ema') { fastV = n === 1 ? q.price : fastV + kF * (q.price - fastV); slowV = n === 1 ? q.price : slowV + kS * (q.price - slowV); }
      else { prices.push(q.price); if (prices.length > cfg.slow) prices.shift(); if (prices.length < cfg.slow) return null; fastV = avg(prices.slice(-cfg.fast)); slowV = avg(prices); }
      if (n < cfg.slow) return null;
      const diff = fastV - slowV; let sig: Signal | null = null;
      if (prev <= 0 && diff > 0 && !inPos) sig = buy();
      else if (prev >= 0 && diff < 0 && inPos) sig = sell();
      prev = diff; return sig;
    } };
  }

  if (cfg.type === 'rsi') {
    const p: number[] = [];
    return { id, name: cfg.name, reset, onQuote(q: Quote) {
      if (q.symbol !== cfg.symbol) return null;
      p.push(q.price); if (p.length > cfg.period + 1) p.shift();
      if (p.length < cfg.period + 1) return null;
      let up = 0, down = 0;
      for (let i = 1; i < p.length; i++) { const d = p[i] - p[i - 1]; if (d > 0) up += d; else down -= d; }
      const rsi = down === 0 ? 100 : 100 - 100 / (1 + up / down);
      if (!inPos && rsi < cfg.low) return buy();
      if (inPos && rsi > cfg.high) return sell();
      return null;
    } };
  }

  // breakout
  const h: number[] = [];
  return { id, name: cfg.name, reset, onQuote(q: Quote) {
    if (q.symbol !== cfg.symbol) return null;
    let sig: Signal | null = null;
    if (h.length >= cfg.lookback) {
      const hi = Math.max(...h), lo = Math.min(...h);
      if (!inPos && q.price > hi) sig = buy(); else if (inPos && q.price < lo) sig = sell();
    }
    h.push(q.price); if (h.length > cfg.lookback) h.shift();
    return sig;
  } };
}

export function describe(cfg: StrategyConfig): string {
  const exits = [cfg.takeProfit ? `TP ${cfg.takeProfit}` : '', cfg.stopLoss ? `SL ${cfg.stopLoss}` : ''].filter(Boolean).join(' / ');
  const size = `${cfg.symbol} \u00b7 ${cfg.qty} contract${cfg.qty === 1 ? '' : 's'}` + (exits ? ` \u00b7 ${exits} pts` : '');
  switch (cfg.type) {
    case 'ma_cross': return `${cfg.ma.toUpperCase()} ${cfg.fast}/${cfg.slow} cross \u00b7 ${size}`;
    case 'rsi': return `RSI ${cfg.period}: buy under ${cfg.low}, exit over ${cfg.high} \u00b7 ${size}`;
    case 'breakout': return `Breakout of the last ${cfg.lookback} prices \u00b7 ${size}`;
    case 'tradingview': return `Follows your TradingView alerts \u00b7 ${size}`;
    case 'pine': return `Pine Script on ${tfLabel(cfg.timeframe)} bars \u00b7 ${size}`;
    case 'keels_special': return `${tfLabel(cfg.ltf)} entries, ${tfLabel(cfg.ltf * cfg.htfMult)} bias, ${cfg.rr}R target \u00b7 ${size}`;
  }
}

export const tfLabel = (sec: number) => (sec < 60 ? `${sec}s` : sec < 3600 ? `${sec / 60}m` : `${sec / 3600}h`);

/** Builds bars from live prices and runs the script when each bar closes. */
function pineStrategy(cfg: Extract<StrategyConfig, { type: 'pine' }>, id: string): Strategy {
  const chk = checkPine(cfg.script);
  if (!chk.ok) throw new Error(chk.error);
  const vm = new PineRunner(chk.program, { symbol: cfg.symbol, mintick: TICK[cfg.symbol] ?? 0.25, timeframe: tfLabel(cfg.timeframe) });
  let bar: Bar | null = null, bucket = -1, broken = false;
  const sig = (side: 'buy' | 'sell'): Signal => ({ symbol: cfg.symbol, side, qty: cfg.qty, source: 'strategy', from: cfg.name, strategyId: id });
  const api: Strategy = {
    id, name: cfg.name,
    reset() { vm.reset(); },
    onQuote(q: Quote) {
      if (q.symbol !== cfg.symbol || broken) return null;
      const out: Signal[] = [];
      const posBefore = vm.pos;
      if (vm.exitHit(q.price)) out.push(sig(posBefore > 0 ? 'sell' : 'buy'));   // strategy.exit levels, between bars
      const b = Math.floor(q.ts / (cfg.timeframe * 1000));
      if (bar && b !== bucket) {
        try {
          for (const it of vm.onBar(bar)) {
            if (it.k === 'close') out.push(sig((it.was ?? 0) > 0 ? 'sell' : 'buy'));
            else out.push(sig(it.dir === 'long' ? 'buy' : 'sell'));
          }
        } catch (e) { broken = true; api.error = (e as Error).message; return null; }
        bar = null;
      }
      if (!bar) { bar = { t: b * cfg.timeframe * 1000, o: q.price, h: q.price, l: q.price, c: q.price }; bucket = b; }
      else { bar.h = Math.max(bar.h, q.price); bar.l = Math.min(bar.l, q.price); bar.c = q.price; }
      return out.length ? out : null;
    }
  };
  return api;
}
