"""Tune dynamic sizing for the 150k evaluation on the v1 basket (EVAL150.md). Tuned on TUNE starts, reported on TEST."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd, itertools
from propeval_dyn import run_evals_dyn
from run_eval150 import trades, combine
import run_eval as R
BASKET = [("NQ", "nr", "NR7 + EMA20/50 trend", "both", 4, 2), ("NQ", "new", "Overnight long + daily regime", "both", 0, 1),
          ("NQ", "new", "Opening drive + daily regime", "both", 0, 1), ("GC", "s2", "NR7 breakout", "both", 0, 1),
          ("GC", "new", "Overnight long + daily regime", "both", 0, 1)]
DAYS = np.unique(R.data("NQ", "nr")[2])
WIN = {"TUNE": ("2024-06-12", "2025-09-30"), "TEST": ("2025-12-01", "2026-10-02")}
def ev(T, md, dd, base, frac, rmin, rmax, taper):
    T = T.sort_values(["exit_day", "entry_day"]); out = {}
    for lab, (a, b) in WIN.items():
        st = DAYS[(DAYS >= pd.Timestamp(a).toordinal()) & (DAYS <= pd.Timestamp(b).toordinal())].astype(np.int64)
        o = run_evals_dyn(st, T.entry_day.values.astype(np.int64), T.exit_day.values.astype(np.int64), T.pnl.values, T.mae.values,
                          md, dd, 9000.0, 0.55, 3000.0, base, frac, rmin, rmax, taper)
        p, f = (o[:, 0] == 1).mean(), (o[:, 0] == -1).mean()
        out[f"{lab}_pass"] = p; out[f"{lab}_fail"] = f; out[f"{lab}_days"] = np.median(o[o[:, 0] == 1, 1]) if (o[:, 0] == 1).any() else np.nan
    return out
rows = []
BASE = 500.0
for be, tp in itertools.product((0, 1), (4000.0, 1e9)):
    T = combine([trades(*s, BASE, tp, BASE if be else 0.0, 0.0, 0.0) for s in BASKET])
    for frac, rmax, taper in itertools.product((0.0, 1/16, 1/12, 1/10, 1/8, 1/6), (500.0, 750.0, 1000.0, 1500.0), (0.0, 0.25, 0.5)):
        if frac == 0 and (rmax != 500.0 or taper > 0): continue
        for md in (30, 60, 0):
            rows.append(dict(BE=be, TP=("none" if tp > 1e8 else tp), frac=frac, rmax=rmax, taper=taper, window=md or "none",
                             **ev(T, md, 4500.0, BASE, frac, 150.0, rmax, taper)))
df = pd.DataFrame(rows); df.to_csv("results/eval150_dyn.csv", index=False)
pd.set_option("display.width", 300)
for md in (30, 60, "none"):
    x = df[df.window == md].copy(); x["score"] = x.TUNE_pass - x.TUNE_fail
    print(f"\n=== window {md} days: top by TUNE (pass-fail) | fixed-size baseline rows have frac=0 ===")
    print(pd.concat([x.sort_values("score", ascending=False).head(6), x[x.frac == 0]]).round(2).to_string(index=False))
