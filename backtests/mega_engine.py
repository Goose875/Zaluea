"""Allocation-free, parallel strategy-statistics kernel for the mega search (same fill model as engine2).
For every (signal variant v, management variant g) it returns per segment (TRAIN/VALID/TEST):
  n, sum_R, wins, gross_profit_$, gross_loss_$, sum_R^2
Management: entry (0 market, 1 confirm-close, 2 limit @ signal-bar 50%), stop (0 signal bar, 1 1xATR, 2 5-bar swing),
            target k R (0 = none), breakeven at +1R (0/1), trail 1.5xATR after +1R (0/1). Flat at session end."""
import numpy as np
from numba import njit, prange

@njit(cache=True)
def sim_stats(o, h, l, c, a, sess, L, S, em, sm, k, be, trail, cut1, cut2, tick, mult, comm, out):
    n = len(o); i = 0
    while i < n - 2:
        side = 1 if L[i] else (-1 if S[i] else 0)
        if side == 0 or not (a[i] > 0): i += 1; continue
        fill = -1; e = 0.0
        if em == 0:
            if sess[i + 1] == sess[i]: fill = i + 1; e = o[i + 1] + side * tick
        elif em == 1:
            j = i + 1
            if j + 1 < n and sess[j + 1] == sess[i] and ((side == 1 and c[j] > h[i]) or (side == -1 and c[j] < l[i])):
                fill = j + 1; e = o[j + 1] + side * tick
        else:
            px = np.round(((h[i] + l[i]) / 2) / tick) * tick
            for j in range(i + 1, min(i + 4, n)):
                if sess[j] != sess[i]: break
                if side == 1 and o[j] <= px: fill = j; e = o[j]; break
                if side == 1 and l[j] <= px - tick: fill = j; e = px; break
                if side == -1 and o[j] >= px: fill = j; e = o[j]; break
                if side == -1 and h[j] >= px + tick: fill = j; e = px; break
        if fill < 0: i += 1; continue
        if sm == 0: stp = l[i] - tick if side == 1 else h[i] + tick
        elif sm == 1: stp = e - side * a[i]
        else:
            lo = l[i]; hi = h[i]
            for q in range(max(0, i - 4), i + 1):
                lo = min(lo, l[q]); hi = max(hi, h[q])
            stp = lo - tick if side == 1 else hi + tick
        risk = (e - stp) * side
        if risk < 4 * tick: risk = 4 * tick
        stp = e - side * risk
        tgt = np.round((e + side * k * risk) / tick) * tick if k > 0 else (1e18 if side == 1 else -1e18)
        best = e; j = fill; ex = 0.0
        while True:
            hs = (l[j] <= stp) if side == 1 else (h[j] >= stp)
            if hs:
                if j > fill: ex = (min(stp, o[j]) if side == 1 else max(stp, o[j])) - side * tick
                else: ex = stp - side * tick
                break
            can_t = (j > fill) or em != 2
            if can_t and ((h[j] >= tgt + tick) if side == 1 else (l[j] <= tgt - tick)): ex = tgt; break
            if j + 1 >= n or sess[j + 1] != sess[j]: ex = c[j] - side * tick; break
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
def run_block(o, h, l, c, a, sess, Lm, Sm, M, cut1, cut2, tick, mult, comm):
    """Lm/Sm: (n_var, n_bars) bool; M: (n_mgmt, 5) [em, sm, k, be, trail] -> out (n_var, n_mgmt, 3, 6) float32"""
    nv = Lm.shape[0]; ng = M.shape[0]; res = np.zeros((nv, ng, 3, 6), np.float32)
    for t in prange(nv * ng):
        v = t // ng; g = t % ng
        out = np.zeros((3, 6))
        sim_stats(o, h, l, c, a, sess, Lm[v], Sm[v], int(M[g, 0]), int(M[g, 1]), M[g, 2], int(M[g, 3]), int(M[g, 4]), cut1, cut2, tick, mult, comm, out)
        for s_ in range(3):
            for f in range(6): res[v, g, s_, f] = out[s_, f]
    return res
