import { HistBar, HistUnit } from '../core/types';

/** Length of one bar of each unit. */
export const UNIT_MS: Record<HistUnit, number> = { min1: 60e3, min5: 3e5, min15: 9e5, hour: 36e5, hour4: 144e5, day: 864e5 };

/** One market and bar size on one login: the completed bars Keel already has. */
export interface HistEntry { bars: HistBar[]; at: number; full: number; keep: number; busy: Promise<void> | null }

/** Bars asked for again within this long (another account, the same check) come from memory. */
const FRESH_MS = 10_000;
/** A full download now and then, so a correction the broker made to an older bar is picked up too. */
const FULL_EVERY = 12 * 3600_000;

/**
 * Completed history bars, kept per login and topped up instead of downloaded again. Every Keel account on the same login
 * shares them, and each later request only downloads the bars since the newest one held (plus the last two again, in case
 * a bar changed right after it closed). The chart's request for the bar still forming does not come through here.
 *  - fetchAll(n): the last n completed bars, oldest first.
 *  - fetchFrom(from, n): completed bars that start at `from` or later, oldest first (at most n).
 */
export async function cachedHistory(map: Map<string, HistEntry>, key: string, unit: HistUnit, count: number,
  fetchAll: (n: number) => Promise<HistBar[]>, fetchFrom: (from: number, n: number) => Promise<HistBar[]>): Promise<HistBar[]> {
  let e = map.get(key);
  if (!e) { e = { bars: [], at: 0, full: 0, keep: 0, busy: null }; map.set(key, e); }
  while (e.busy) await e.busy.catch(() => {});             // the same bars are on their way for another account: wait for them
  if (e.keep >= count && Date.now() - e.at < FRESH_MS) return e.bars.slice(-count);
  const entry = e, job = (async () => {
    const now = Date.now(), ms = UNIT_MS[unit], want = Math.max(count, entry.keep);
    const last = entry.bars[entry.bars.length - 1], from = last ? last.t - 2 * ms : 0;
    const gap = last ? Math.ceil((now - from) / ms) + 3 : Infinity;
    if (last && entry.keep >= count && now - entry.full < FULL_EVERY && gap <= want) {
      const fresh = (await fetchFrom(from, Math.min(20_000, gap))).filter(b => b.t >= from);
      // nothing new (a weekend, the session break): keep what is held; a short answer never drops older bars
      if (fresh.length) entry.bars = [...entry.bars.filter(b => b.t < fresh[0].t), ...fresh].slice(-want);
    } else {
      entry.bars = (await fetchAll(want)).slice(-want); entry.full = now;
    }
    entry.keep = want; entry.at = Date.now();
  })();
  entry.busy = job;
  try { await job; } finally { if (entry.busy === job) entry.busy = null; }
  return entry.bars.slice(-count);
}
