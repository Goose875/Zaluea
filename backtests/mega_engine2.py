"""Kernel v2 for the 500M search: like mega_engine but with level-aware management.
Entry em: 0 market next open | 1 confirm-close | 2 limit @ signal-bar 50% | 3 LIMIT AT LEVEL (lim_px[i], 6-bar expiry)
Stop  sm: 0 signal bar | 1 1xATR | 2 5-bar swing | 3 BEYOND ZONE (stp_px[i])
Target k: >0 k x R | 0 none | -1 NEXT LEVEL (tgt_px[i]; skipped if not ahead of entry)
BE (+1R -> entry+1 tick), 1.5xATR trail after +1R, time stop (0 = none, else bars). Same conservative fills as before; flat at session end.
Returns per segment: n, sum_R, wins, gross_profit, gross_loss, sum_R^2."""
import numpy as np
from numba import njit, prange

@njit(cache=True)
def sim2(o, h, l, c, a, sess, L, S, lim_px, stp_px, tgt_px, em, sm, k, be, trail, tmax, cut1, cut2, tick, mult, comm, out):
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
            if j + 1 >= n or sess[j + 1] != sess[j]: ex = c[j] - side * tick; break
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
        seg = 0 if i < cut1 else (1 if i < cut2 else 2)
        out[seg, 0] += 1; out[seg, 1] += R; out[seg, 5] += R * R
        if pnl > 0: out[seg, 2] += 1; out[seg, 3] += pnl
        else: out[seg, 4] -= pnl
        i = j + 1

@njit(parallel=True, cache=True)
def run_block2(o, h, l, c, a, sess, Lm, Sm, lim_px, stp_px, tgt_px, M, cut1, cut2, tick, mult, comm):
    nv = Lm.shape[0]; ng = M.shape[0]; res = np.zeros((nv, ng, 3, 6), np.float32)
    for t in prange(nv * ng):
        v = t // ng; g = t % ng
        out = np.zeros((3, 6))
        sim2(o, h, l, c, a, sess, Lm[v], Sm[v], lim_px, stp_px, tgt_px, int(M[g, 0]), int(M[g, 1]), M[g, 2], int(M[g, 3]), int(M[g, 4]), int(M[g, 5]),
             cut1, cut2, tick, mult, comm, out)
        for s_ in range(3):
            for f in range(6): res[v, g, s_, f] = out[s_, f]
    return res
