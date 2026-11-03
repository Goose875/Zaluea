import { Trade } from './sim';

/** Spec section 8: trades / win % / avg R / PF per period, and TEST $ for one mini. */
export const EXPECTED: Record<string, { train: number[]; valid: number[]; test: number[]; testUsd: number }> = {
  K1: { train: [53, 43, 0.27, 1.67], valid: [42, 57, 0.38, 2.71], test: [77, 47, 0.12, 1.60], testUsd: 33482 },
  K2: { train: [61, 46, 0.27, 1.44], valid: [50, 60, 0.32, 1.54], test: [68, 49, 0.23, 1.72], testUsd: 42404 },
  K3: { train: [70, 46, 0.57, 2.64], valid: [59, 54, 0.13, 1.21], test: [78, 46, 0.19, 1.50], testUsd: 32996 },
  K4: { train: [56, 41, 0.32, 1.46], valid: [44, 41, 0.22, 1.37], test: [56, 38, 0.13, 1.20], testUsd: 8996 },
  K5: { train: [50, 50, 0.45, 1.95], valid: [46, 46, 0.22, 1.70], test: [41, 49, 0.19, 1.30], testUsd: 14035 },
  K6: { train: [50, 28, 0.54, 1.42], valid: [42, 24, 0.36, 1.66], test: [45, 31, 0.47, 1.76], testUsd: 69365 },
  K7: { train: [52, 42, 0.26, 1.56], valid: [44, 41, 0.28, 1.99], test: [64, 38, 0.12, 1.28], testUsd: 20793 }
};
// Periods by the New York date of the entry bar.
export const PERIODS = [
  { key: 'train', label: 'TRAIN Jun 2024 \u2013 Mar 2025', from: '2024-06-01', to: '2025-03-31' },
  { key: 'valid', label: 'VALID Apr \u2013 Nov 2025', from: '2025-04-01', to: '2025-11-30' },
  { key: 'test', label: 'TEST Dec 2025 \u2013 Nov 2026', from: '2025-12-01', to: '2026-11-30' }
] as const;

export interface Stats { trades: number; win: number; avgR: number; pf: number | null; usd: number }
export function stats(ts: Trade[]): Stats {
  const w = ts.filter(t => t.pnl > 0), gw = w.reduce((a, t) => a + t.pnl, 0), gl = -ts.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  return { trades: ts.length, win: ts.length ? (100 * w.length) / ts.length : 0, avgR: ts.length ? ts.reduce((a, t) => a + t.r, 0) / ts.length : 0, pf: gl > 0 ? gw / gl : null, usd: ts.reduce((a, t) => a + t.pnl, 0) };
}

export interface Row { id: string; period: string; got: Stats; want: number[]; countOff: number; flags: string[]; covered: boolean }
/** Compares each strategy and period with the spec. Flags trade counts more than 10% off, and average R that is off by more than 0.10R or flips sign. */
export function compare(trades: Trade[], dataFrom: number, dataTo: number, wallOf: (u: number) => number): Row[] {
  const rows: Row[] = [];
  for (const id of Object.keys(EXPECTED)) for (const P of PERIODS) {
    const from = Date.parse(P.from + 'T00:00:00Z'), to = Date.parse(P.to + 'T23:59:59Z');
    const ts = trades.filter(t => t.id === id && wallOf(t.entryUtc) >= from && wallOf(t.entryUtc) <= to);
    const got = stats(ts), want = (EXPECTED[id] as any)[P.key] as number[];
    const covered = wallOf(dataFrom) <= from + 7 * 86_400_000 && wallOf(dataTo) >= to - 7 * 86_400_000;
    const countOff = want[0] ? (got.trades - want[0]) / want[0] : 0, flags: string[] = [];
    if (covered) {
      if (Math.abs(countOff) > 0.10) flags.push(`trade count ${countOff > 0 ? '+' : ''}${Math.round(countOff * 100)}%`);
      if (got.trades && (Math.abs(got.avgR - want[2]) > 0.10 || Math.sign(got.avgR) !== Math.sign(want[2]))) flags.push(`avg R ${got.avgR.toFixed(2)} vs ${want[2].toFixed(2)}`);
    }
    rows.push({ id, period: P.key, got, want, countOff, flags, covered });
  }
  return rows;
}
