import { Position, Signal } from './types';
import { sizeClass } from './accounts';

export interface RiskLimits {
  maxDailyLoss: number;        // positive number, e.g. 500
  maxQtyPerOrder: number;
  maxOpenPositions: number;
  allowedSymbols: string[];    // empty = none allowed
  maxMini?: number;            // from the account's rules, 0 or missing = no cap
  maxMicro?: number;
}

/** Every signal passes through here before it can reach a broker. */
export class RiskGuard {
  halted = false;
  constructor(readonly limits: RiskLimits) {}

  check(s: Signal, ctx: { dailyPnL: number; openPositions: number; positions?: Position[] }): { ok: boolean; reason?: string } {
    if (this.halted) return { ok: false, reason: 'Trading is halted.' };
    if (ctx.dailyPnL <= -Math.abs(this.limits.maxDailyLoss)) {
      this.halted = true;
      return { ok: false, reason: 'Daily loss limit reached. Trading halted.' };
    }
    if (!Number.isFinite(s.qty) || s.qty <= 0) return { ok: false, reason: 'Invalid quantity.' };
    if (s.qty > this.limits.maxQtyPerOrder) return { ok: false, reason: 'Quantity is above your per-order limit.' };
    if (ctx.openPositions >= this.limits.maxOpenPositions) return { ok: false, reason: 'Open position limit reached.' };
    if (!this.limits.allowedSymbols.includes(s.symbol)) return { ok: false, reason: `${s.symbol} is not on your allowed list.` };
    const cls = sizeClass(s.symbol), cap = cls === 'mini' ? this.limits.maxMini : cls === 'micro' ? this.limits.maxMicro : 0;
    if (cap) {
      const cur = ctx.positions?.find(p => p.symbol === s.symbol)?.qty ?? 0, after = cur + (s.side === 'buy' ? s.qty : -s.qty);
      if (Math.abs(after) > Math.abs(cur) && Math.abs(after) > cap) return { ok: false, reason: `That would be ${Math.abs(after)} ${cls} contracts. This account allows ${cap}.` };
    }
    return { ok: true };
  }

  halt() { this.halted = true; }
}

export const DEFAULT_RISK: RiskLimits = { maxDailyLoss: 500, maxQtyPerOrder: 2, maxOpenPositions: 2, allowedSymbols: ['ES', 'NQ', 'MES', 'MNQ'] };

/** Checks limits typed into the app. Throws a message the user can read. */
export function parseRisk(x: any): RiskLimits {
  const int = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  if (!x || typeof x.maxDailyLoss !== 'number' || !(x.maxDailyLoss >= 1 && x.maxDailyLoss <= 1_000_000)) throw new Error('Daily loss limit must be between 1 and 1,000,000.');
  if (!int(x.maxQtyPerOrder, 1, 1000)) throw new Error('Max contracts per order must be a whole number from 1 to 1000.');
  if (!int(x.maxOpenPositions, 1, 100)) throw new Error('Max open positions must be a whole number from 1 to 100.');
  const syms = Array.isArray(x.allowedSymbols) ? x.allowedSymbols.map((v: unknown) => String(v).trim().toUpperCase()).filter(Boolean) : [];
  if (!syms.length || syms.length > 20 || !syms.every((v: string) => /^[A-Z0-9._-]{1,12}$/.test(v))) throw new Error('Enter 1 to 20 symbols, like ES, NQ.');
  return { maxDailyLoss: x.maxDailyLoss, maxQtyPerOrder: x.maxQtyPerOrder, maxOpenPositions: x.maxOpenPositions, allowedSymbols: [...new Set<string>(syms)] };
}
