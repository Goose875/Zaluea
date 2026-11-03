"""Level marking at EVERY market open (Globex 18:00 and RTH 09:00 ET) using only completed bars.
Zone types (each tracked as nearest zone ABOVE and BELOW the previous close):
  D-SR    daily swing highs/lows (2-left/2-right pivots on Globex-day bars)
  4H-SR   4-hour swing highs/lows
  LIQ     liquidity pools: equal highs / equal lows (1h pivots within 0.15 x ATR, last 5 sessions)
  D-FVG   unfilled daily fair value gaps        4H-FVG  unfilled 4h FVGs        1H-FVG  unfilled 1h FVGs
  4H-OB   4h order blocks (last opposite candle before a >1.5 x ATR displacement candle), unmitigated
  OPENS   weekly / monthly / Globex / RTH opening prices
  GAPS    new-day opening gap (prior close -> 18:00 open) and new-week opening gaps (last 4)
Entry models per zone type (long at support, short at resistance, mirrored):
  fade   price trades into the zone and closes inside/beyond it holding the far edge  (limit at near edge)
  reject wick into the zone, close back outside                                       (limit at near edge)
  sweep  trades through the far edge (liquidity grab) and closes back above/below it  (limit at far edge)
  break  closes through the far edge -> trade the break                                (limit at the broken edge = retest)
  retest price was beyond the zone within 6 bars, returns to it and rejects           (limit at near edge)
Zone stop = 0.25 x ATR beyond the far edge; 'next level' target = nearest zone of ANY type in the trade direction."""
import numpy as np, pandas as pd

def _pivots(H, L):
    n = len(H); ph = np.zeros(n, bool); pl = np.zeros(n, bool)
    for p in range(2, n - 2):
        ph[p] = H[p] > max(H[p-1], H[p-2]) and H[p] >= max(H[p+1], H[p+2])
        pl[p] = L[p] < min(L[p-1], L[p-2]) and L[p] <= min(L[p+1], L[p+2])
    return ph, pl

def _fvgs(H, L, O, C, atr, need_disp=True):
    out = []
    for t in range(2, len(H)):
        body = C[t-1] - O[t-1]
        if L[t] > H[t-2] and (not need_disp or body > atr[t-1]): out.append((t, H[t-2], L[t], 1))
        if H[t] < L[t-2] and (not need_disp or -body > atr[t-1]): out.append((t, H[t], L[t-2], -1))
    return out

def build(d):
    """d = prep_1h frame. Returns dict type -> (above_lo, above_hi, below_lo, below_hi) per bar and combined arrays."""
    n = len(d); idx = d.index; hr = idx.hour.values
    O, H, L, C = d.Open.values, d.High.values, d.Low.values, d.Close.values; atr = d.atr.values
    sid = d.sess_id.values
    snap_start = np.r_[True, (sid[1:] != sid[:-1])] | (hr == 9) & np.r_[True, hr[1:] != hr[:-1]]
    snaps = np.where(snap_start)[0]
    # ---- daily (Globex-day) bars
    g = pd.DataFrame(dict(sid=sid, O=O, H=H, L=L, C=C)).groupby("sid").agg(O=("O", "first"), H=("H", "max"), L=("L", "min"), C=("C", "last"))
    DH, DL, DO, DC = g.H.values, g.L.values, g.O.values, g.C.values
    datr = pd.Series(DH - DL).rolling(14, min_periods=3).mean().values
    dph, dpl = _pivots(DH, DL); dfvg = _fvgs(DH, DL, DO, DC, datr)
    # ---- 4h bars (aligned to 18:00)
    b4 = sid * 6 + ((hr + 6) % 24) // 4
    g4 = pd.DataFrame(dict(b=b4, O=O, H=H, L=L, C=C, i=np.arange(n))).groupby("b").agg(O=("O", "first"), H=("H", "max"), L=("L", "min"), C=("C", "last"), end=("i", "last"))
    FH, FL, FO, FC, FE = g4.H.values, g4.L.values, g4.O.values, g4.C.values, g4.end.values
    fatr = pd.Series(FH - FL).rolling(14, min_periods=3).mean().values
    fph, fpl = _pivots(FH, FL); ffvg = _fvgs(FH, FL, FO, FC, fatr)
    fob = []
    for j in range(1, len(FH)):
        body = FC[j] - FO[j]
        if abs(body) > 1.5 * fatr[j - 1] if np.isfinite(fatr[j - 1]) else False:
            for q in range(j - 1, max(j - 4, -1), -1):
                if (body > 0 and FC[q] < FO[q]) or (body < 0 and FC[q] > FO[q]):
                    fob.append((j, FL[q], FH[q], 1 if body > 0 else -1)); break
    # ---- 1h pivots & FVGs
    hph, hpl = _pivots(H, L); hfvg = _fvgs(H, L, O, C, atr)
    # ---- opens & gaps
    wk = pd.Series(idx.to_period("W-FRI")).values  # week ending Friday; Sunday 18:00 belongs to next week
    wk = pd.Series((idx + pd.Timedelta(hours=6)).to_period("W-FRI")).astype(str).values
    mo = pd.Series((idx + pd.Timedelta(hours=6)).to_period("M")).astype(str).values
    sess_first = np.r_[True, sid[1:] != sid[:-1]]
    T = {k: [np.full(n, np.nan) for _ in range(4)] for k in ("D-SR", "4H-SR", "LIQ", "D-FVG", "4H-FVG", "1H-FVG", "4H-OB", "OPENS", "GAPS")}
    ALL_lo_above = np.full(n, np.nan); ALL_hi_below = np.full(n, np.nan)
    gaps = []; last_open_w = {}; last_open_m = {}
    for si, s0 in enumerate(snaps):
        s1 = snaps[si + 1] if si + 1 < len(snaps) else n
        cur = sid[s0]; zones = {k: [] for k in T}
        # daily (sessions < cur)
        for p in range(max(0, cur - 60), cur - 2):
            if dph[p]: zones["D-SR"].append((DH[p], DH[p]))
            if dpl[p]: zones["D-SR"].append((DL[p], DL[p]))
        for (t, lo, hi, dr) in dfvg:
            if t >= cur or t < cur - 60: continue
            later = DC[t + 1:cur]
            if (dr == 1 and (later < lo).any()) or (dr == -1 and (later > hi).any()): continue
            zones["D-FVG"].append((lo, hi))
        # 4h bars completed before s0
        k4 = np.searchsorted(FE, s0, side="left")          # 4h bars with end index < s0
        for p in range(max(0, k4 - 90), k4 - 2):
            if fph[p]: zones["4H-SR"].append((FH[p], FH[p]))
            if fpl[p]: zones["4H-SR"].append((FL[p], FL[p]))
        for (t, lo, hi, dr) in ffvg:
            if t >= k4 or t < k4 - 90: continue
            later = FC[t + 1:k4]
            if (dr == 1 and (later < lo).any()) or (dr == -1 and (later > hi).any()): continue
            zones["4H-FVG"].append((lo, hi))
        for (t, lo, hi, dr) in fob:
            if t >= k4 or t < k4 - 90: continue
            later = FC[t + 1:k4]
            if (dr == 1 and (later < lo).any()) or (dr == -1 and (later > hi).any()): continue
            zones["4H-OB"].append((lo, hi))
        # 1h: pivots usable if p+2 < s0 ; last ~5 sessions = 115 bars
        lo_i = max(0, s0 - 115)
        piv_h = [H[p] for p in range(lo_i, s0 - 2) if hph[p]]; piv_l = [L[p] for p in range(lo_i, s0 - 2) if hpl[p]]
        tol = 0.15 * (atr[s0 - 1] if s0 > 0 and np.isfinite(atr[s0 - 1]) else 0)
        for arr in (sorted(piv_h), sorted(piv_l)):
            for a_, b_ in zip(arr[:-1], arr[1:]):
                if b_ - a_ <= tol: zones["LIQ"].append((min(a_, b_), max(a_, b_)))
        for (t, lo, hi, dr) in hfvg:
            if t >= s0 or t < s0 - 230: continue
            later = C[t + 1:s0]
            if (dr == 1 and (later < lo).any()) or (dr == -1 and (later > hi).any()): continue
            zones["1H-FVG"].append((lo, hi))
        # opens
        if sess_first[s0]:
            w, m_ = wk[s0], mo[s0]
            last_open_w.setdefault(w, O[s0]); last_open_m.setdefault(m_, O[s0])
            if s0 > 0: gaps.append((min(C[s0 - 1], O[s0]), max(C[s0 - 1], O[s0])))
        ops = [last_open_w.get(wk[s0]), last_open_m.get(mo[s0])]
        ss = s0
        while ss > 0 and sid[ss - 1] == cur: ss -= 1
        ops.append(O[ss])
        if hr[s0] == 9: ops.append(O[s0])
        zones["OPENS"] = [(x, x) for x in ops if x is not None and np.isfinite(x)]
        zones["GAPS"] = gaps[-5:]
        # nearest above / below previous close for each bar in this snapshot
        allz = [z for v in zones.values() for z in v]
        for i in range(s0, s1):
            pc = C[i - 1] if i > 0 else C[i]
            for k, zs in zones.items():
                ab = [z for z in zs if z[0] > pc]; be = [z for z in zs if z[1] < pc]
                if ab: z = min(ab, key=lambda z: z[0]); T[k][0][i], T[k][1][i] = z
                if be: z = max(be, key=lambda z: z[1]); T[k][2][i], T[k][3][i] = z
            ab = [z[0] for z in allz if z[0] > pc]; be = [z[1] for z in allz if z[1] < pc]
            if ab: ALL_lo_above[i] = min(ab)
            if be: ALL_hi_below[i] = max(be)
    return T, ALL_lo_above, ALL_hi_below

def zone_triggers(d, T, A_above, A_below):
    """5 entry models x 9 zone types -> dict name -> (L, S, lim_px, stp_px, tgt_px)"""
    Hh, Ll, Cc, a = d.High.values, d.Low.values, d.Close.values, d.atr.values
    mx6 = pd.Series(Cc).rolling(6, min_periods=1).max().shift(1).values; mn6 = pd.Series(Cc).rolling(6, min_periods=1).min().shift(1).values
    out = {}
    for k, (alo, ahi, blo, bhi) in T.items():
        okb = np.isfinite(blo); oka = np.isfinite(alo)
        m = {}
        # long at support (below zone) / short at resistance (above zone)
        m["fade"] = (okb & (Ll <= bhi) & (Cc > blo), oka & (Hh >= alo) & (Cc < ahi), bhi, alo, blo - 0.25 * a, ahi + 0.25 * a)
        m["reject"] = (okb & (Ll <= bhi) & (Cc > bhi), oka & (Hh >= alo) & (Cc < alo), bhi, alo, blo - 0.25 * a, ahi + 0.25 * a)
        m["sweep"] = (okb & (Ll < blo) & (Cc > blo), oka & (Hh > ahi) & (Cc < ahi), blo, ahi, blo - 0.5 * a, ahi + 0.5 * a)
        # break: close through the far edge of support -> SHORT ; through resistance -> LONG
        m["break"] = (oka & (Cc > ahi), okb & (Cc < blo), ahi, blo, alo - 0.25 * a, bhi + 0.25 * a)
        m["retest"] = (oka & (mx6 > ahi) & (Ll <= ahi) & (Cc > ahi), okb & (mn6 < blo) & (Hh >= blo) & (Cc < blo), ahi, blo, alo - 0.25 * a, bhi + 0.25 * a)
        for it, (Lg, Sh, limL, limS, stL, stS) in m.items():
            Lg = np.nan_to_num(Lg, nan=0).astype(bool); Sh = np.nan_to_num(Sh, nan=0).astype(bool) & ~Lg
            lim = np.where(Lg, limL, np.where(Sh, limS, np.nan)); stp = np.where(Lg, stL, np.where(Sh, stS, np.nan))
            tgt = np.where(Lg, A_above, np.where(Sh, A_below, np.nan))
            out[f"ZONE {k} {it}"] = (Lg, Sh, lim, stp, tgt)
    return out
