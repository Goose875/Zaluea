"""Engine v3: per-signal entry / stop / target PRICES (for ICT & level-based setups) + R targets, breakeven, trailing.
Signal arrays (index = bar where the signal is known, at its close):
  side[i]  +1/-1/0      lim[i]  limit price (NaN = market at next open)
  stp[i]   stop price   tgt[i]  target price (NaN = use k x R; k=0 -> no target)
Same conservative fills as engine2: market +1 tick; limit fills only on 1-tick trade-through (or at open if gapped
through); stop -1 tick; target needs trade-through; no target on a limit fill bar; stop first if both; flat at session end;
management updated at bar close only. Limit orders expire after `expiry` bars. A bar that trades through both the
limit and the stop FILLS and is then stopped on that same bar (worst case). Min risk 4 ticks."""
import numpy as np
from numba import njit

@njit(cache=True)
def engine3(o, h, l, c, a, sess, side_a, lim_a, stp_a, tgt_a, k, use_tgt, be_R, trail, trail_act_R, expiry, tick, mult, comm):
    n = len(o); res = np.zeros((n, 6)); m = 0; i = 0
    while i < n - 2:
        side = int(side_a[i])
        if side == 0 or not np.isfinite(stp_a[i]): i += 1; continue
        fill = -1; e = 0.0; lim = lim_a[i]
        if not np.isfinite(lim):
            if sess[i + 1] == sess[i]: fill = i + 1; e = o[i + 1] + side * tick
        else:
            for j in range(i + 1, min(i + 1 + expiry, n)):
                if sess[j] != sess[i]: break
                if side == 1 and o[j] <= lim: fill = j; e = o[j]; break
                if side == 1 and l[j] <= lim - tick: fill = j; e = lim; break
                if side == -1 and o[j] >= lim: fill = j; e = o[j]; break
                if side == -1 and h[j] >= lim + tick: fill = j; e = lim; break
        if fill < 0: i += 1; continue
        stp = stp_a[i]
        risk = (e - stp) * side
        if risk < 4 * tick:
            if risk <= 0: i += 1; continue
            risk = 4 * tick; stp = e - side * risk
        if use_tgt and np.isfinite(tgt_a[i]) and (tgt_a[i] - e) * side > 0: tgt = tgt_a[i]
        elif k > 0: tgt = np.round((e + side * k * risk) / tick) * tick
        else: tgt = 1e18 if side == 1 else -1e18
        best = e; j = fill; ex = 0.0; reason = 0
        while True:
            hs = (l[j] <= stp) if side == 1 else (h[j] >= stp)
            if hs:
                if j > fill: ex = (min(stp, o[j]) if side == 1 else max(stp, o[j])) - side * tick
                else: ex = stp - side * tick
                reason = 1; break
            can_t = (j > fill) or not np.isfinite(lim)
            ht = ((h[j] >= tgt + tick) if side == 1 else (l[j] <= tgt - tick)) and can_t
            if ht: ex = tgt; reason = 2; break
            if j + 1 >= n or sess[j + 1] != sess[j]: ex = c[j] - side * tick; reason = 3; break
            best = max(best, h[j]) if side == 1 else min(best, l[j])
            prog = (best - e) * side / risk
            if be_R > 0 and prog >= be_R:
                bs = e + side * tick
                stp = max(stp, bs) if side == 1 else min(stp, bs)
            if trail > 0 and prog >= trail_act_R:
                if trail == 1: cand = best - side * 1.5 * a[j]
                else:
                    lo = l[j]; hi = h[j]
                    for q in range(max(fill, j - 4), j + 1):
                        lo = min(lo, l[q]); hi = max(hi, h[q])
                    cand = lo - tick if side == 1 else hi + tick
                stp = max(stp, cand) if side == 1 else min(stp, cand)
            j += 1
        pnl = side * (ex - e) * mult - 2 * comm
        res[m, 0] = i; res[m, 1] = side; res[m, 2] = pnl; res[m, 3] = pnl / (risk * mult); res[m, 4] = j - fill + 1; res[m, 5] = reason
        m += 1; i = j + 1
    return res[:m]
