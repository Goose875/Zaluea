"""Final candidate: 5-minute 'Trend-Pullback Scalper' (RSI(2) dip inside an intraday trend), Dec-2026 contracts.
Long when: close > session VWAP, EMA20 > EMA50, EMA50 rising vs 5 bars ago, RSI(2) < 10  (short = mirror).
Entry next bar open. Fixed tick target/stop, time stop 8 bars (40 min), flat at session end. Regular hours only."""
import pandas as pd, numpy as np
from scalping import prep, S_trend_rsi2, SPLITS, SPECS, stats
from common import SPECS as SP
import scalping

PARAMS = {"NQ": (109, 327, 8), "GC": (43, 171, 8), "ES": (30, 20, 8)}  # ES = its best IS set, shown for completeness

def sim_detail(d, L, S, sym, T, Sx, tmax):
    t = scalping.simulate(d, L, S, sym, T, Sx, tmax)
    sp = SP[sym]; tv = sp["tick"] * sp["mult"]
    t["exit"] = np.where(t.pnl >= T * tv - 2 * sp["comm"] - 1e-6, "target", np.where(t.pnl <= -Sx * tv - 2 * sp["comm"] + 1e-6, "stop", "time/EOD"))
    return t

rows = []
for sym, (T, Sx, tm) in PARAMS.items():
    d = prep(sym, "5m"); _, ise, oss = SPLITS["5m"]
    for lab, dd in (("IS", d[:ise]), ("OOS", d[oss:]), ("ALL", d)):
        L, S = S_trend_rsi2(dd, 10); t = sim_detail(dd, L, S, sym, T, Sx, tm); s = stats(t)
        sp = SP[sym]; tv = sp["tick"] * sp["mult"]
        rows.append(dict(symbol=sym, sample=lab, period=f"{dd.index[0].date()}..{dd.index[-1].date()}", sessions=dd.date.nunique(),
                         target=f"{T}t=${T*tv:,.0f}", stop=f"{Sx}t=${Sx*tv:,.0f}", trades=s["trades"], win_rate=s["win"],
                         net_pnl=s["pnl"], pf=s["pf"], avg_win=t.pnl[t.pnl > 0].mean(), avg_loss=t.pnl[t.pnl < 0].mean(),
                         max_dd=s["maxdd"], pct_target=(t.exit == "target").mean(), pct_stop=(t.exit == "stop").mean(),
                         pct_time=(t.exit == "time/EOD").mean(), longs=(t.side == 1).sum(), shorts=(t.side == -1).sum()))
        if lab == "ALL": t.to_csv(f"results/final_trades_{sym}.csv", index=False)
r = pd.DataFrame(rows); r.to_csv("results/scalping_final.csv", index=False)
pd.set_option("display.width", 300); print(r.round(2).to_string())
