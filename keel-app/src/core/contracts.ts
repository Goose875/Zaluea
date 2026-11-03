/** Dollars per point and tick size for common futures. */
export const MULT: Record<string, number> = { ES: 50, NQ: 20, MES: 5, MNQ: 2, YM: 5, MYM: 0.5, RTY: 50, M2K: 5, CL: 1000, MCL: 100, GC: 100, MGC: 10 };
export const TICK: Record<string, number> = { ES: 0.25, MES: 0.25, NQ: 0.25, MNQ: 0.25, YM: 1, MYM: 1, RTY: 0.1, M2K: 0.1, CL: 0.01, MCL: 0.01, GC: 0.1, MGC: 0.1 };
export const mult = (s: string) => MULT[s] ?? 1;
export const tick = (s: string) => TICK[s] ?? 0.25;
