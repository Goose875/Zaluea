"""Out-of-sample check for topstep_static.py: only Combines started after the K strategies' selection period (Dec 2025 on)."""
import os, pandas as pd, warnings; warnings.filterwarnings("ignore")
import topstep_static as ts
from portfolio_all import k_trades, fractal_trades, po3_trades
K = k_trades(); FR = fractal_trades(); B2 = po3_trades("GC", "1h", "RB", "4h EMA20", "below open", "none", "candle close", "GC PO3 1h RB")
ALL = pd.concat([K, FR[FR.entry_t >= K.entry_t.min()], B2]); days = sorted({ts.tday(x) for x in pd.concat([ALL.entry_t, ALL.exit_t])})
cut = [i for i, d in enumerate(days) if str(d) >= "2025-12-01"][0]; rows = []
for combo in ("GC PO3 1h RB + K1 + K3 + K4 + K6 + K7", "K1 + K3 + K4 + K5 + K6 + K7", "GC Fractal (flat daily) + K1 + K3 + K4 + K5 + K6", "K1 + K3 + K4 + K6 + K7"):
    T = ALL[ALL.strategy.isin(combo.split(" + "))]
    for risk in (250, 350, 500):
        pnl = ts.daily_series(T, risk, days); e = ts.evaluate(pnl[cut:], 2000); rows.append(dict(strategies=combo, risk=risk, **e))
R = pd.DataFrame(rows); R.to_csv("results/topstep_static_oos.csv", index=False); pd.set_option("display.width", 300); print(R.round(2).to_string(index=False))
