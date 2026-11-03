"""Engine v4: dollar-based risk/target.
mode 0  FIXED BRACKET on 1 standard contract: stop = stop_usd / mult points, target = tgt_usd / mult points
mode 1  MICRO SIZING: strategy's own stop (smodel or per-signal stop); n = floor(risk_max_usd / (stop_pts x micro_mult))
        micros (skip trade if n == 0); target placed so that n micros make tgt_usd
Entry models 0-4 as engine2; emodel 5 = per-signal limit/stop arrays (ICT setups: lim NaN = market next open).
Breakeven: once open profit >= be_usd (0 = off), stop -> entry +1 tick.
Same conservative fills: market +1 tick; limit needs 1-tick trade-through; stop -1 tick; target needs trade-through;
stop first if both in a bar; target can't fill on a limit/stop entry's fill bar; flat at session end; mgmt at bar close.
Output columns: i, side, pnl_usd, risk_usd, bars, reason, qty"""
import numpy as np
from numba import njit

@njit(cache=True)
def engine4(o, h, l, c, a, sess, sigL, sigS, lim_a, stp_a, emodel, smodel, mode, stop_usd, risk_max_usd, tgt_usd, be_usd,
            tick, mult, comm, micro_mult, micro_comm):
    n = len(o); res = np.zeros((n, 7)); m = 0; i = 0
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
        elif emodel == 2 or emodel == 5:
            px = (h[i] + l[i]) / 2 if emodel == 2 else lim_a[i]
            if emodel == 5 and not np.isfinite(px):
                if sess[i + 1] == sess[i]: fill = i + 1; e = o[i + 1] + side * tick
            else:
                px = np.round(px / tick) * tick
                for j in range(i + 1, min(i + 13, n) if emodel == 5 else min(i + 4, n)):
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
        # ---- stop / size / target ----
        if mode == 0:
            qty = 1.0; pm = mult; cm = comm
            dist = max(tick, np.round(stop_usd / mult / tick) * tick)
            stp = e - side * dist
        else:
            if smodel == 0: stp = l[i] - tick if side == 1 else h[i] + tick
            elif smodel == 1: stp = e - side * a[i]
            elif smodel == 2:
                lo = l[i]; hi = h[i]
                for q in range(max(0, i - 4), i + 1):
                    lo = min(lo, l[q]); hi = max(hi, h[q])
                stp = lo - tick if side == 1 else hi + tick
            else: stp = stp_a[i]
            dist = (e - stp) * side
            if not np.isfinite(dist) or dist < 4 * tick: dist = 4 * tick
            stp = e - side * dist
            qty = np.floor(risk_max_usd / (dist * micro_mult))
            if qty < 1: i += 1; continue
            pm = micro_mult * qty; cm = micro_comm * qty
        risk_usd = dist * pm
        tdist = max(tick, np.round(tgt_usd / pm / tick) * tick)
        tgt = e + side * tdist
        j = fill; ex = 0.0; reason = 0; best = e; can_lim = (emodel == 0 or emodel == 4 or (emodel == 5 and not np.isfinite(lim_a[i])))
        while True:
            hs = (l[j] <= stp) if side == 1 else (h[j] >= stp)
            if hs:
                if j > fill: ex = (min(stp, o[j]) if side == 1 else max(stp, o[j])) - side * tick
                else: ex = stp - side * tick
                reason = 1; break
            ht = ((h[j] >= tgt + tick) if side == 1 else (l[j] <= tgt - tick)) and (j > fill or can_lim)
            if ht: ex = tgt; reason = 2; break
            if j + 1 >= n or sess[j + 1] != sess[j]: ex = c[j] - side * tick; reason = 3; break
            best = max(best, h[j]) if side == 1 else min(best, l[j])
            if be_usd > 0 and (best - e) * side * pm >= be_usd:
                bs = e + side * tick
                stp = max(stp, bs) if side == 1 else min(stp, bs)
            j += 1
        pnl = side * (ex - e) * pm - 2 * cm
        res[m, 0] = i; res[m, 1] = side; res[m, 2] = pnl; res[m, 3] = risk_usd; res[m, 4] = j - fill + 1; res[m, 5] = reason; res[m, 6] = qty
        m += 1; i = j + 1
    return res[:m]
