import numpy as np
from numba import njit

@njit(cache=True)
def sim2_trades(o, h, l, c, a, sess, L, S, lim_px, stp_px, tgt_px, em, sm, k, be, trail, tmax, cut1, cut2, tick, mult, comm, out, hold=0):
    m = 0
    n = len(o); i = 0
    while i < n - 2:
        side = 1 if L[i] else (-1 if S[i] else 0)
        if side == 0 or not (a[i] > 0): i += 1; continue
        if (em == 3 and not np.isfinite(lim_px[i])) or (sm == 3 and not np.isfinite(stp_px[i])) or (k < 0 and not np.isfinite(tgt_px[i])):
            i += 1; continue
        fill = -1; e = 0.0
        if em == 0:
            if sess[i + 1] == sess[i]: fill = i + 1; e = o[i + 1] + side * tick
        elif em == 1:
            j = i + 1
            if j + 1 < n and sess[j + 1] == sess[i] and ((side == 1 and c[j] > h[i]) or (side == -1 and c[j] < l[i])):
                fill = j + 1; e = o[j + 1] + side * tick
        else:
            px = (h[i] + l[i]) / 2 if em == 2 else lim_px[i]
            px = np.round(px / tick) * tick
            for j in range(i + 1, min(i + (4 if em == 2 else 7), n)):
                if sess[j] != sess[i]: break
                if side == 1 and o[j] <= px: fill = j; e = o[j]; break
                if side == 1 and l[j] <= px - tick: fill = j; e = px; break
                if side == -1 and o[j] >= px: fill = j; e = o[j]; break
                if side == -1 and h[j] >= px + tick: fill = j; e = px; break
        if fill < 0: i += 1; continue
        if sm == 0: stp = l[i] - tick if side == 1 else h[i] + tick
        elif sm == 1: stp = e - side * a[i]
        elif sm == 2:
            lo = l[i]; hi = h[i]
            for q in range(max(0, i - 4), i + 1):
                lo = min(lo, l[q]); hi = max(hi, h[q])
            stp = lo - tick if side == 1 else hi + tick
        else: stp = stp_px[i]
        risk = (e - stp) * side
        if risk <= 0: i += 1; continue
        if risk < 4 * tick: risk = 4 * tick
        stp = e - side * risk
        if k > 0: tgt = np.round((e + side * k * risk) / tick) * tick
        elif k < 0:
            tgt = tgt_px[i]
            if (tgt - e) * side <= 2 * tick: i += 1; continue
        else: tgt = 1e18 if side == 1 else -1e18
        best = e; j = fill; ex = 0.0
        while True:
            hs = (l[j] <= stp) if side == 1 else (h[j] >= stp)
            if hs:
                if j > fill: ex = (min(stp, o[j]) if side == 1 else max(stp, o[j])) - side * tick
                else: ex = stp - side * tick
                break
            can_t = (j > fill) or (em == 0 or em == 1)
            if can_t and ((h[j] >= tgt + tick) if side == 1 else (l[j] <= tgt - tick)): ex = tgt; break
            if j + 1 >= n or (hold == 0 and sess[j + 1] != sess[j]): ex = c[j] - side * tick; break
            if tmax > 0 and j - fill + 1 >= tmax: ex = c[j] - side * tick; break
            best = max(best, h[j]) if side == 1 else min(best, l[j])
            prog = (best - e) * side / risk
            if be == 1 and prog >= 1.0:
                bs = e + side * tick
                stp = max(stp, bs) if side == 1 else min(stp, bs)
            if trail == 1 and prog >= 1.0:
                cand = best - side * 1.5 * a[j]
                stp = max(stp, cand) if side == 1 else min(stp, cand)
            j += 1
        pnl = side * (ex - e) * mult - 2 * comm; R = pnl / (risk * mult)
        tdist = abs(tgt - e) if k != 0 else np.nan
        out[m, 0] = i; out[m, 1] = side; out[m, 2] = risk; out[m, 3] = tdist; out[m, 4] = side * (ex - e); out[m, 5] = R; out[m, 6] = j - fill + 1; out[m, 7] = (best - e) * side
        m += 1
        i = j + 1
    return m

