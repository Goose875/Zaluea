import SPEC from './keel_strategies.json';
import { Series } from './series';

export type Dir = 'long' | 'short';
export interface KStrategy {
  id: string; name: string; symbol: string; direction: 'both' | 'long' | 'short';
  trigger: { type: 'level_break' | 'level_retest' | 'narrow_range_break'; level?: string; lookback?: number; require_ema20_vs_ema50?: boolean };
  filters: { daily_regime: string; hourly_trend: string; volatility: string; window: string; premium_discount: string; day_of_week: string };
  entry: 'market_next_open' | 'confirm_close'; stop: 'atr_1x' | 'signal_bar' | 'swing_5bar';
  target_R: number | null; breakeven_at_R: number | null; trail: string | null; time_stop_bars: number | null; flat_at_session_end: boolean;
}
export const STRATEGIES = (SPEC as any).strategies as KStrategy[];
export const INSTRUMENTS = (SPEC as any).instruments as Record<string, { micro: string; tick: number; usd_per_point_mini: number; usd_per_point_micro: number }>;
export const PRIORITY: Record<string, string[]> = { NQ: ['K3', 'K2', 'K1', 'K4'], GC: ['K6', 'K7', 'K5'] };

export interface Trade {
  id: string; sym: string; dir: Dir; signalUtc: number; entryUtc: number; exitUtc: number; entry: number; exit: number;
  stop0: number; target: number | null; qty: number; riskPts: number; points: number; pnl: number; r: number; why: string; bars: number;
}
export interface OpenPos { id: string; sym: string; dir: Dir; entryUtc: number; entry: number; stop: number; target: number | null; qty: number; riskPts: number; held: number }
export interface Pending { id: string; sym: string; dir: Dir; kind: 'confirm' | 'entry'; signalUtc: number }

export interface SimOptions {
  sizing: 'mini1' | 'fixed' | 'cushion';      // mini1 = 1 mini contract (validation, matches spec section 8)
  riskUsd: number; divisor: number; startEquity: number; maxLoss: number;
  netting: 'independent' | 'priority'; capMult: number | null;   // null = no cap
  feePerSide: number;                          // per contract per side
  pause: { on: boolean; window: number; below: number; countFrom: number; resumed: Record<string, number> };
  enabled: Record<string, boolean>;
}
export const VALIDATION: SimOptions = { sizing: 'mini1', riskUsd: 300, divisor: 12, startEquity: 50000, maxLoss: 2000, netting: 'independent', capMult: null, feePerSide: 2.5,
  pause: { on: false, window: 30, below: -0.2, countFrom: 0, resumed: {} }, enabled: {} };

// ---------- signals (spec sections 3 and 4) ----------
const lvl = (X: Series, name: string): number[] =>
  name === 'prior_day_POC' ? X.poc : name === 'prior_day_VAL' ? X.val : name === 'session_VWAP_plus_1sigma' ? X.band1 : (() => { throw new Error('Unknown level ' + name); })();

function breakAt(X: Series, L: number[], i: number, dir: Dir) {
  if (i < 1) return false;
  const c = X.bars[i].c, cp = X.bars[i - 1].c;
  return dir === 'long' ? c > L[i] && cp <= L[i - 1] : c < L[i] && cp >= L[i - 1];
}
function trigger(S: KStrategy, X: Series, i: number, dir: Dir): boolean {
  const b = X.bars[i], t = S.trigger;
  if (t.type === 'level_break') return breakAt(X, lvl(X, t.level!), i, dir);
  if (t.type === 'level_retest') {
    const L = lvl(X, t.level!); let broke = false;
    for (let j = Math.max(1, i - 6); j <= i - 1; j++) if (breakAt(X, L, j, dir)) { broke = true; break; }
    return broke && (dir === 'short' ? b.h >= L[i] && b.c < L[i] : b.l <= L[i] && b.c > L[i]);
  }
  if (i < 1) return false;
  const nr = t.lookback === 4 ? X.nr4 : X.nr7, p = X.bars[i - 1];
  if (!nr[i - 1]) return false;
  if (t.require_ema20_vs_ema50 && !(dir === 'long' ? X.ema20[i] > X.ema50[i] : X.ema20[i] < X.ema50[i])) return false;
  return dir === 'long' ? b.c > p.h : b.c < p.l;
}
function filters(S: KStrategy, X: Series, i: number, dir: Dir): boolean {
  const f = S.filters, b = X.bars[i], up = X.regimeUp[i];
  if (f.daily_regime !== 'none' && !X.regimeKnown[i]) return false;   // never guess the daily regime
  if (f.daily_regime === 'with' && (dir === 'long' ? !up : up)) return false;
  if (f.daily_regime === 'against' && (dir === 'long' ? up : !up)) return false;
  if (f.hourly_trend === 'with' && !(dir === 'long' ? X.ema20[i] > X.ema50[i] : X.ema20[i] < X.ema50[i])) return false;
  const high = X.atr[i] > X.atrSma[i];
  if (f.volatility === 'high' && !high) return false;
  if (f.volatility === 'low' && high) return false;
  if (f.window === 'ASIA_18_02' && !(b.hour >= 18 || b.hour < 2)) return false;
  if (f.window === 'NY_AM_08_12' && !(b.hour >= 8 && b.hour < 12)) return false;
  if (f.premium_discount === 'with' && !(dir === 'long' ? b.c < X.weekMid[i] : b.c > X.weekMid[i])) return false;
  return true;
}
export function signal(S: KStrategy, X: Series, i: number): Dir | null {
  for (const d of (S.direction === 'both' ? ['long', 'short'] : [S.direction]) as Dir[]) if (trigger(S, X, i, d) && filters(S, X, i, d)) return d;
  return null;
}

// ---------- simulation (spec section 5 and 6) ----------
interface SState { S: KStrategy; X: Series; mode: 'flat' | 'confirm' | 'entry' | 'open'; dir: Dir; sig: number; due: number; lastExit: number; pos: any | null; trades: Trade[]; paused: boolean; pausedUtc: number | null }
export interface SimResult {
  trades: Trade[]; open: OpenPos[]; pending: Pending[]; skipped: { id: string; utc: number; why: string }[];
  paused: Record<string, number | null>; equity: number; floor: number; riskNow: number;
}

/** Runs the strategies over both markets' bars in time order. Same code for validation, paper, and later live. */
export function simulate(series: Record<string, Series>, opt: SimOptions, only?: string[]): SimResult {
  const ids = STRATEGIES.filter(S => series[S.symbol] && (only ? only.includes(S.id) : opt.sizing === 'mini1' || opt.enabled[S.id]));
  const st = new Map<string, SState>(ids.map(S => [S.id, { S, X: series[S.symbol], mode: 'flat', dir: 'long', sig: -1, due: -1, lastExit: -1, pos: null, trades: [], paused: false, pausedUtc: null } as SState]));
  const skipped: SimResult['skipped'] = [];
  let realized = 0, eodPeak = opt.startEquity;
  const floor = () => Math.min(opt.startEquity, eodPeak - opt.maxLoss);
  const riskUsd = () => opt.sizing === 'cushion' ? Math.max(150, Math.min(750, (opt.startEquity + realized - floor()) / opt.divisor)) : opt.riskUsd;
  const ppt = (sym: string) => opt.sizing === 'mini1' ? INSTRUMENTS[sym].usd_per_point_mini : INSTRUMENTS[sym].usd_per_point_micro;
  const openRisk = () => [...st.values()].filter(s => s.mode === 'open').reduce((a, s) => a + s.pos.riskPts * ppt(s.S.symbol) * s.pos.qty, 0);

  // merged timeline
  const events: { sym: string; i: number; utc: number }[] = [];
  for (const [sym, X] of Object.entries(series)) X.bars.forEach((b, i) => events.push({ sym, i, utc: b.utc }));
  events.sort((a, b) => a.utc - b.utc || (a.sym < b.sym ? -1 : 1));

  const closeTrade = (s: SState, i: number, px: number, why: string) => {
    const p = s.pos, d = p.dir === 'long' ? 1 : -1, P = ppt(s.S.symbol);
    const points = (px - p.entry) * d, pnl = points * P * p.qty - 2 * opt.feePerSide * p.qty;
    const t: Trade = { id: s.S.id, sym: s.S.symbol, dir: p.dir, signalUtc: p.signalUtc, entryUtc: p.entryUtc, exitUtc: s.X.bars[i].utc, entry: p.entry, exit: px, stop0: p.stop0,
      target: p.target, qty: p.qty, riskPts: p.riskPts, points, pnl, r: pnl / (p.riskPts * P * p.qty), why, bars: p.held };
    s.trades.push(t); realized += pnl; s.mode = 'flat'; s.pos = null; s.lastExit = i;
    if (opt.pause.on && !s.paused) {
      const since = Math.max(opt.pause.countFrom, opt.pause.resumed[s.S.id] ?? 0);
      const recent = s.trades.filter(x => x.entryUtc >= since).slice(-opt.pause.window);
      if (recent.length >= opt.pause.window && recent.reduce((a, x) => a + x.r, 0) / recent.length < opt.pause.below) { s.paused = true; s.pausedUtc = t.exitUtc; }
    }
  };

  for (const ev of events) {
    const X = series[ev.sym], i = ev.i, b = X.bars[i], T = X.tick;
    const here = (PRIORITY[ev.sym] || []).map(id => st.get(id)).filter((s): s is SState => !!s);
    // 1. entries due at this bar's open (priority order)
    for (const s of here) {
      if (s.mode !== 'entry' || s.due !== i) continue;
      s.mode = 'flat';
      if (s.paused) { skipped.push({ id: s.S.id, utc: b.utc, why: 'paused' }); continue; }
      const d = s.dir === 'long' ? 1 : -1, E = b.o + d * T, sb = X.bars[s.sig];
      let stop = s.S.stop === 'atr_1x' ? E - d * X.atr[s.sig]
        : s.S.stop === 'signal_bar' ? (d > 0 ? sb.l - T : sb.h + T)
        : d > 0 ? Math.min(...X.bars.slice(Math.max(0, s.sig - 4), s.sig + 1).map(x => x.l)) - T : Math.max(...X.bars.slice(Math.max(0, s.sig - 4), s.sig + 1).map(x => x.h)) + T;
      if ((E - stop) * d <= 0) { skipped.push({ id: s.S.id, utc: b.utc, why: 'price opened beyond the stop' }); continue; }
      if (Math.abs(E - stop) < 4 * T) stop = E - d * 4 * T;   // 4-tick minimum risk
      const R = Math.abs(E - stop);
      const target = s.S.target_R === null ? null : Math.round((E + d * s.S.target_R * R) / T) * T;
      const risk = riskUsd(), qty = opt.sizing === 'mini1' ? 1 : Math.floor(risk / (R * ppt(s.S.symbol)));
      if (qty < 1) { skipped.push({ id: s.S.id, utc: b.utc, why: 'stop too wide for the risk' }); continue; }
      if (opt.netting === 'priority' && here.some(o => o !== s && o.mode === 'open')) { skipped.push({ id: s.S.id, utc: b.utc, why: 'another strategy holds this market' }); continue; }
      if (opt.capMult !== null && openRisk() + R * ppt(s.S.symbol) * qty > opt.capMult * risk) { skipped.push({ id: s.S.id, utc: b.utc, why: 'total open risk cap' }); continue; }
      s.mode = 'open';
      s.pos = { dir: s.dir, entry: E, stop, stop0: stop, target, R, riskPts: R, qty, best: E, held: 0, fill: i, entryUtc: b.utc, signalUtc: X.bars[s.sig].utc };
    }
    // 2. open positions: gaps, then stop/target inside the bar (stop counts first), then bar-close rules
    for (const s of here) {
      if (s.mode !== 'open') continue;
      const p = s.pos, long = p.dir === 'long';
      if (p.fill < i) {
        if (long ? b.o <= p.stop : b.o >= p.stop) { closeTrade(s, i, long ? b.o - T : b.o + T, 'stop'); continue; }
        // Gap through the target: counted at the target price (conservative, as in the research backtest).
        if (p.target !== null && (long ? b.o >= p.target + T : b.o <= p.target - T)) { closeTrade(s, i, p.target, 'target'); continue; }
      }
      if (long ? b.l <= p.stop : b.h >= p.stop) { closeTrade(s, i, long ? p.stop - T : p.stop + T, 'stop'); continue; }
      if (p.target !== null && (long ? b.h >= p.target + T : b.l <= p.target - T)) { closeTrade(s, i, p.target, 'target'); continue; }
      p.held++;
      if (s.S.time_stop_bars && p.held >= s.S.time_stop_bars) { closeTrade(s, i, long ? b.c - T : b.c + T, 'time'); continue; }
      if (s.S.flat_at_session_end && X.lastOfSession[i]) { closeTrade(s, i, long ? b.c - T : b.c + T, 'session end'); continue; }
      p.best = long ? Math.max(p.best, b.h) : Math.min(p.best, b.l);
      const gain = long ? p.best - p.entry : p.entry - p.best;
      if (s.S.breakeven_at_R !== null && gain >= s.S.breakeven_at_R * p.R) p.stop = long ? Math.max(p.stop, p.entry + T) : Math.min(p.stop, p.entry - T);
      if (s.S.trail === 'atr_1_5x_after_1R' && gain >= p.R) p.stop = long ? Math.max(p.stop, p.best - 1.5 * X.atr[i]) : Math.min(p.stop, p.best + 1.5 * X.atr[i]);
    }
    // 3. confirmations, then new signals at this bar's close
    for (const s of here) {
      if (s.mode === 'confirm' && s.due === i) {
        const sb = X.bars[s.sig], ok = s.dir === 'long' ? b.c > sb.h : b.c < sb.l, nx = X.bars[i + 1];
        if (ok && (!nx || nx.sess === sb.sess)) { s.mode = 'entry'; s.due = i + 1; continue; }
        // Not confirmed: this bar can start a new signal itself (as in the research backtest).
        s.mode = 'flat'; s.lastExit = i - 1;
      }
      if (s.mode !== 'flat' || i <= s.lastExit || s.paused) continue;
      const d = signal(s.S, X, i); if (!d) continue;
      const nx = X.bars[i + 1];
      if (nx && nx.sess !== b.sess) continue;   // next bar is in another session: skip
      if (!nx && b.hour === 16) continue;        // live: the session is over
      s.dir = d; s.sig = i;
      if (s.S.entry === 'market_next_open') { s.mode = 'entry'; s.due = i + 1; } else { s.mode = 'confirm'; s.due = i + 1; }
    }
    if (X.lastOfSession[i]) eodPeak = Math.max(eodPeak, opt.startEquity + realized);
  }

  const open: OpenPos[] = [], pending: Pending[] = [];
  for (const s of st.values()) {
    if (s.mode === 'open') open.push({ id: s.S.id, sym: s.S.symbol, dir: s.pos.dir, entryUtc: s.pos.entryUtc, entry: s.pos.entry, stop: s.pos.stop, target: s.pos.target, qty: s.pos.qty, riskPts: s.pos.riskPts, held: s.pos.held });
    if (s.mode === 'confirm' || s.mode === 'entry') pending.push({ id: s.S.id, sym: s.S.symbol, dir: s.dir, kind: s.mode, signalUtc: s.X.bars[s.sig].utc });
  }
  return { trades: [...st.values()].flatMap(s => s.trades).sort((a, b) => a.entryUtc - b.entryUtc), open, pending, skipped,
    paused: Object.fromEntries([...st.values()].map(s => [s.S.id, s.pausedUtc])), equity: opt.startEquity + realized, floor: floor(), riskNow: riskUsd() };
}
