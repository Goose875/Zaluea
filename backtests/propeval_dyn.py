"""Evaluation simulator with DYNAMIC position sizing (numba). Same rules as propeval.run_evals plus:
each trade's P&L and worst open loss are scaled by f = risk_now / base_risk, where
  risk_now = clip(frac x cushion, rmin, rmax),  cushion = distance from equity to the drawdown floor (dd + profit)
  and, if taper > 0, risk_now <= taper x (target - profit)  (smaller bets when close to the target)
frac = 0 -> fixed size (f = 1). Linear scaling approximates integer micro rounding."""
import numpy as np
from numba import njit

@njit(cache=True)
def run_evals_dyn(start_days, t_entry_day, t_exit_day, t_pnl, t_mae, max_days, dd, target, consist, dll,
                  base_risk, frac, rmin, rmax, taper):
    S = len(start_days); out = np.zeros((S, 4)); nT = len(t_pnl)
    for si in range(S):
        s = start_days[si]; bal = 0.0; best_day = 0.0; day_pnl = 0.0; cur_day = -1; status = 0; last_day = s; locked = -1
        k = 0
        while k < nT and t_entry_day[k] < s: k += 1
        while k < nT:
            d = t_exit_day[k]
            if cur_day != -1 and d != cur_day:
                if day_pnl > best_day: best_day = day_pnl
                if bal >= target and best_day <= consist * bal: status = 1; last_day = cur_day; break
                day_pnl = 0.0
            cur_day = d
            if max_days > 0 and d - s + 1 > max_days: break
            if d == locked: k += 1; continue
            f = 1.0
            if frac > 0:
                r = frac * (dd + bal)
                if taper > 0: r = min(r, taper * max(target - bal, 0.0) + rmin)
                r = min(max(r, rmin), rmax); f = r / base_risk
            pnl = t_pnl[k] * f; mae = t_mae[k] * f
            if bal + mae <= -dd: status = -1; last_day = d; break
            if dll > 0 and day_pnl + mae <= -dll: pnl = -dll - day_pnl; locked = d
            bal += pnl; day_pnl += pnl; last_day = d
            if bal <= -dd: status = -1; break
            k += 1
        if status == 0 and cur_day != -1 and (max_days == 0 or cur_day - s + 1 <= max_days):
            if day_pnl > best_day: best_day = day_pnl
            if bal >= target and best_day <= consist * bal and k >= nT: status = 1
        out[si, 0] = status; out[si, 1] = last_day - s + 1; out[si, 3] = bal
    return out
