"""Fixed diversified basket (no stream cherry-picking) for the 150k evaluation; only shared risk/TP/BE/trail are tuned on TUNE.
Basket: NQ NR7+EMA20/50 trend | NQ overnight long + daily regime | NQ opening drive + daily regime | GC NR7 breakout | GC overnight long + daily regime."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd, itertools
from run_eval150 import trades, evaluate, combine
BASKET = [("NQ", "nr", "NR7 + EMA20/50 trend", "both", 4, 2), ("NQ", "new", "Overnight long + daily regime", "both", 0, 1),
          ("NQ", "new", "Opening drive + daily regime", "both", 0, 1), ("GC", "s2", "NR7 breakout", "both", 0, 1),
          ("GC", "new", "Overnight long + daily regime", "both", 0, 1)]
rows = []; store = {}
for risk, tp, be, trl in itertools.product((500.0, 750.0, 1000.0, 1500.0), (2500.0, 4000.0, 1e9), (0, 1), (0, 1)):
    ta, tr = (2 * risk, risk) if trl else (0.0, 0.0)
    T = combine([trades(*s, risk, tp, risk if be else 0.0, ta, tr) for s in BASKET]); store[(risk, tp, be, trl)] = T
    e30 = evaluate(T, 30); e0 = evaluate(T, 0)
    rows.append(dict(risk=risk, TP=("none" if tp > 1e8 else tp), BE=be, trail=trl, trades_month=len(T) / 29.0, avg=T.pnl.mean(),
                     **{f"30d_{k}": v for k, v in e30.items()}, **{f"unl_{k}": v for k, v in e0.items()}))
df = pd.DataFrame(rows); df.to_csv("results/eval150_basket.csv", index=False)
pd.set_option("display.width", 340)
df["s30"] = df["30d_TUNE_pass%"] - df["30d_TUNE_fail%"]; df["sunl"] = df["unl_TUNE_pass%"] - df["unl_TUNE_fail%"]
print(df.sort_values("s30", ascending=False).head(8).drop(columns=["s30", "sunl"]).round(2).to_string(index=False))
for lab, col in (("best for 30-day pass (TUNE)", "s30"), ("best for eventual pass (TUNE)", "sunl")):
    b = df.sort_values(col, ascending=False).iloc[0]; T = store[(b.risk, 1e9 if b.TP == "none" else b.TP, b.BE, b.trail)]
    print(f"\n### {lab}: risk ${b.risk:,.0f}, TP {b.TP}, BE {'1R' if b.BE else 'off'}, trail {'2R/1R' if b.trail else 'off'} | {len(T)/29:.1f} trades/month, avg ${T.pnl.mean():.0f}")
    for md in (30, 60, 90, 0):
        for dd in (4500.0, 3000.0):
            e = evaluate(T, md, dd)
            print(f"   {('no limit' if md == 0 else f'{md} days'):9s} DD ${dd:,.0f}: TUNE pass {e['TUNE_pass%']:.0%} fail {e['TUNE_fail%']:.0%} | TEST pass {e['TEST_pass%']:.0%} fail {e['TEST_fail%']:.0%} (median {e['TEST_days']} days)")
