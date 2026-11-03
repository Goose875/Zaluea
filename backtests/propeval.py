"""Prop-firm evaluation simulator (numba).
Rules: start $50,000; FAIL if equity (incl. worst open loss during a trade, from bar highs/lows) <= $48,000 (static DD).
PASS at end of a day when profit >= $4,000 AND best single day <= 55% of total profit (consistency).
Daily loss limit (dll > 0): day P&L incl. open loss reaching -dll ->
   dll_hard = True : account FAILS
   dll_hard = False: position liquidated at -dll for the day, no more trades that day (soft DLL)
max_days > 0: evaluation stops (status 0 = timeout) once a trade would exit > max_days calendar days after the start.
An evaluation is started on EVERY trading day; trades taken from that day on."""
import numpy as np
from numba import njit

@njit(cache=True)
def run_evals(start_days, t_entry_day, t_exit_day, t_pnl, t_mae, max_days, dd=2000.0, target=4000.0, consist=0.55, dll=0.0, dll_hard=False):
    """returns per start: status (1 pass, -1 fail, 0 open/timeout), days used, trades used, final profit, fail reason (1 DD, 2 DLL)"""
    S = len(start_days); out = np.zeros((S, 5)); nT = len(t_pnl)
    for si in range(S):
        s = start_days[si]; bal = 0.0; best_day = 0.0; day_pnl = 0.0; cur_day = -1; status = 0; ntr = 0; last_day = s
        locked_day = -1; reason = 0
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
            if d == locked_day: k += 1; continue                       # soft DLL hit earlier today
            pnl = t_pnl[k]; mae = t_mae[k]
            if bal + mae <= -dd: status = -1; reason = 1; last_day = d; ntr += 1; break
            if dll > 0 and day_pnl + mae <= -dll:
                if dll_hard: status = -1; reason = 2; last_day = d; ntr += 1; break
                pnl = -dll - day_pnl; locked_day = d                   # liquidated at the limit
            bal += pnl; day_pnl += pnl; ntr += 1; last_day = d
            if bal <= -dd: status = -1; reason = 1; break
            k += 1
        if status == 0 and cur_day != -1 and (max_days == 0 or cur_day - s + 1 <= max_days):
            if day_pnl > best_day: best_day = day_pnl
            if bal >= target and best_day <= consist * bal and k >= nT: status = 1
        out[si, 0] = status; out[si, 1] = last_day - s + 1; out[si, 2] = ntr; out[si, 3] = bal; out[si, 4] = reason
    return out
