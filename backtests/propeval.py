"""Prop-firm evaluation simulator (numba).
Rules: start $50,000; FAIL if equity (incl. worst open loss during a trade, from bar highs/lows) <= $48,000 (static DD);
PASS at end of a day when profit >= $4,000 AND best single day <= 55% of total profit (consistency).
An evaluation is started on EVERY trading day; trades taken from that day on; stops trading at pass/fail; 'open' if data ends."""
import numpy as np
from numba import njit

@njit(cache=True)
def run_evals(start_days, t_entry_day, t_exit_day, t_pnl, t_mae, max_days, dd=2000.0, target=4000.0, consist=0.55):
    """returns per start: status (1 pass, -1 fail, 0 open/timeout), days used, trades used, final profit.
    max_days > 0: evaluation stops (status 0 = timeout) once a trade would exit more than max_days calendar days after the start"""
    S = len(start_days); out = np.zeros((S, 4)); nT = len(t_pnl)
    for si in range(S):
        s = start_days[si]; bal = 0.0; best_day = 0.0; day_pnl = 0.0; cur_day = -1; status = 0; ntr = 0; last_day = s
        k = 0
        while k < nT and t_entry_day[k] < s: k += 1
        while k < nT:
            d = t_exit_day[k]
            if cur_day != -1 and d != cur_day:          # close previous day -> consistency/target check
                if day_pnl > best_day: best_day = day_pnl
                if bal >= target and best_day <= consist * bal: status = 1; last_day = cur_day; break
                day_pnl = 0.0
            cur_day = d
            if max_days > 0 and d - s + 1 > max_days: break
            if bal + t_mae[k] <= -dd: status = -1; last_day = d; ntr += 1; break
            bal += t_pnl[k]; day_pnl += t_pnl[k]; ntr += 1; last_day = d
            if bal <= -dd: status = -1; break
            k += 1
        if status == 0 and cur_day != -1 and (max_days == 0 or cur_day - s + 1 <= max_days):
            if day_pnl > best_day: best_day = day_pnl
            if bal >= target and best_day <= consist * bal and k >= nT: status = 1
        out[si, 0] = status; out[si, 1] = last_day - s + 1; out[si, 2] = ntr; out[si, 3] = bal
    return out
