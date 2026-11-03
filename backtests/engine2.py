"""Engine v2: entry models x initial stop x target (R multiple or none) x breakeven x trailing stop.

Trade management is updated only AFTER each bar closes (no intrabar look-ahead):
  * Breakeven: once the best price since entry reaches +be_R x R, stop moves to entry +1 tick (covers slippage)
  * Trailing stops (all start after the same activation threshold trail_act_R x R, 0 = immediately):
      1 = ATR chandelier 1.5 x ATR from best price      2 = ATR chandelier 3 x ATR
      3 = 2-bar low/high trail                          4 = 5-bar low/high trail
  * stop only ever tightens
Fills: see rmultiple.py (market/stop entries +1 tick, limit entries need 1-tick trade-through, stop exit -1 tick,
target limit needs trade-through, stop beats target in the same bar, target cannot fill on a limit/stop entry's fill bar,
flat at session end, $2.50/side commission, minimum risk 4 ticks)."""
import numpy as np
from numba import njit

ENTRY = ["Market next open", "Stop above signal bar", "Limit @ signal-bar 50%", "Limit @ close-0.5ATR", "Confirm close beyond bar"]
STOPM = ["Signal-bar extreme", "1.0 x ATR", "5-bar swing"]
TRAIL = ["None", "ATR trail 1.5x", "ATR trail 3x", "2-bar trail", "5-bar trail"]

@njit(cache=True)
def engine2(o, h, l, c, a, sess, sigL, sigS, emodel, smodel, k, be_R, trail, trail_act_R, tick, mult, comm):
    n = len(o); res = np.zeros((n, 6)); m = 0; i = 0
    while i < n - 2:
        side = 1 if sigL[i] else (-1 if sigS[i] else 0)
        if side == 0 or not np.isfinite(a[i]) or a[i] <= 0: i += 1; continue
        fill = -1; e = 0.0
        if emodel == 0:
            if sess[i + 1] == sess[i]: fill = i + 1; e = o[i + 1] + side * tick
        elif emodel == 1:
            trig = h[i] + tick if side == 1 else l[i] - tick
            for j in range(i + 1, min(i + 4, n)):
                if sess[j] != sess[i]: break
                if side == 1 and o[j] >= trig: fill = j; e = o[j] + tick; break
                if side == 1 and h[j] >= trig: fill = j; e = trig + tick; break
                if side == -1 and o[j] <= trig: fill = j; e = o[j] - tick; break
                if side == -1 and l[j] <= trig: fill = j; e = trig - tick; break
        elif emodel == 2 or emodel == 3:
            px = (h[i] + l[i]) / 2 if emodel == 2 else c[i] - side * 0.5 * a[i]
            px = np.round(px / tick) * tick
            for j in range(i + 1, min(i + 4, n)):
                if sess[j] != sess[i]: break
                if side == 1 and o[j] <= px: fill = j; e = o[j]; break
                if side == 1 and l[j] <= px - tick: fill = j; e = px; break
                if side == -1 and o[j] >= px: fill = j; e = o[j]; break
                if side == -1 and h[j] >= px + tick: fill = j; e = px; break
        else:
            j = i + 1
            if j + 1 < n and sess[j + 1] == sess[i] and ((side == 1 and c[j] > h[i]) or (side == -1 and c[j] < l[i])):
                fill = j + 1; e = o[j + 1] + side * tick
        if fill < 0: i += 1; continue
        if smodel == 0: stp = l[i] - tick if side == 1 else h[i] + tick
        elif smodel == 1: stp = e - side * a[i]
        else:
            lo = l[i]; hi = h[i]
            for q in range(max(0, i - 4), i + 1):
                lo = min(lo, l[q]); hi = max(hi, h[q])
            stp = lo - tick if side == 1 else hi + tick
        risk = (e - stp) * side
        if risk < 4 * tick: risk = 4 * tick
        stp = e - side * risk
        tgt = np.round((e + side * k * risk) / tick) * tick if k > 0 else (1e18 if side == 1 else -1e18)
        best = e; j = fill; ex = 0.0; reason = 0
        while True:
            hs = (l[j] <= stp) if side == 1 else (h[j] >= stp)
            if hs:
                if j > fill: ex = (min(stp, o[j]) if side == 1 else max(stp, o[j])) - side * tick
                else: ex = stp - side * tick
                reason = 1; break
            can_t = (j > fill) or emodel == 0 or emodel == 4
            ht = ((h[j] >= tgt + tick) if side == 1 else (l[j] <= tgt - tick)) and can_t
            if ht: ex = tgt; reason = 2; break
            if j + 1 >= n or sess[j + 1] != sess[j]: ex = c[j] - side * tick; reason = 3; break
            # ---- end-of-bar management ----
            best = max(best, h[j]) if side == 1 else min(best, l[j])
            prog = (best - e) * side / risk
            if be_R > 0 and prog >= be_R:
                bs = e + side * tick
                stp = max(stp, bs) if side == 1 else min(stp, bs)
            if trail > 0 and prog >= trail_act_R:
                if trail == 1 or trail == 2:
                    mlt = 1.5 if trail == 1 else 3.0
                    cand = best - side * mlt * a[j]
                else:
                    nb = 2 if trail == 3 else 5
                    lo = l[j]; hi = h[j]
                    for q in range(max(fill, j - nb + 1), j + 1):
                        lo = min(lo, l[q]); hi = max(hi, h[q])
                    cand = lo - tick if side == 1 else hi + tick
                stp = max(stp, cand) if side == 1 else min(stp, cand)
            j += 1
        pnl = side * (ex - e) * mult - 2 * comm
        res[m, 0] = i; res[m, 1] = side; res[m, 2] = pnl; res[m, 3] = pnl / (risk * mult); res[m, 4] = j - fill + 1; res[m, 5] = reason
        m += 1; i = j + 1
    return res[:m]
