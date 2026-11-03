"""Aggressive end of dynamic sizing: speed vs failure frontier (tuned on TUNE, shown on TEST)."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd, itertools
from eval150_dyn import BASKET, ev
from run_eval150 import trades, combine
rows = []
for be, tp in itertools.product((0, 1), (2500.0, 4000.0, 1e9)):
    T = combine([trades(*s, 500.0, tp, 500.0 if be else 0.0, 0.0, 0.0) for s in BASKET])
    for frac, rmax, rmin, taper in itertools.product((1/12, 1/10, 1/8, 1/6, 1/5, 1/4, 1/3), (750.0, 1000.0, 1500.0, 2000.0, 3000.0), (150.0, 300.0), (0.0, 0.25, 0.5)):
        for md in (30, 45, 60):
            rows.append(dict(BE=be, TP=("none" if tp > 1e8 else tp), frac=round(frac, 3), rmax=rmax, rmin=rmin, taper=taper, window=md,
                             **ev(T, md, 4500.0, 500.0, frac, rmin, rmax, taper)))
df = pd.DataFrame(rows); df.to_csv("results/eval150_dyn2.csv", index=False)
pd.set_option("display.width", 300)
for md in (30, 45, 60):
    x = df[df.window == md]
    print(f"\n=== {md}-day window: best TUNE pass rate subject to TUNE fail <= 5% / 10% / 20% ===")
    for cap in (0.05, 0.10, 0.20):
        y = x[x.TUNE_fail <= cap].sort_values(["TUNE_pass", "TUNE_fail"], ascending=[False, True]).head(1)
        print(f"  fail<= {cap:.0%}:", y.round(3).to_string(index=False, header=(cap == 0.05)))
