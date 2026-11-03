"""Run ICT + key-level setups through engine3 with a management grid.
5m (continuous front month, Aug 25 - Nov 2 2026, ~50 sessions): IS = to Oct 9, OOS = Oct 10 - Nov 2
1h (continuous, Jun 2024 - Nov 2026): TRAIN / VALID / TEST as in grid2 (Mar 2025 / Nov 2025 cuts)
Selection uses IS (5m) or TRAIN+VALID (1h) only."""
import numpy as np, pandas as pd, itertools, sys
from engine3 import engine3
from ict import prep, all_setups
from common import SPECS
MGMT = [(tg, k, be, tr) for tg, k in [(1, 0.0), (0, 1.0), (0, 2.0), (0, 3.0), (0, 5.0), (0, 0.0)] for be in (0.0, 1.0) for tr in (0, 1, 2)]
TGT_NAME = lambda tg, k: "liquidity target" if tg else (f"{k:g}R" if k else "no target")
TR_NAME = {0: "none", 1: "ATR 1.5x after +1R", 2: "5-bar after +1R"}
CUTS = {"5m": ["2026-10-09"], "1h": ["2025-03-31", "2025-11-30"]}

def stats(r):
    if len(r) == 0: return dict(n=0, win=np.nan, avgR=np.nan, pnl=0.0, pf=np.nan)
    p = r[:, 2]; g, ls = p[p > 0].sum(), -p[p < 0].sum()
    return dict(n=len(p), win=(p > 0).mean(), avgR=r[:, 3].mean(), pnl=p.sum(), pf=g / ls if ls > 0 else 99.0)

rows = []
for tf in ("5m", "1h"):
    segn = ["IS", "OOS"] if tf == "5m" else ["TR", "VA", "TE"]
    for sym in ("NQ", "ES", "GC"):
        d = prep(sym, tf); sp = SPECS[sym]
        cuts = np.array([(d.index <= pd.Timestamp(x + " 23:59", tz="America/New_York")).sum() for x in CUTS[tf]])
        arrs = (d.Open.values, d.High.values, d.Low.values, d.Close.values, d.atr.values.astype(float), d.sess_id.values.astype(np.int64))
        for name, (side, lim, stp, tgt) in all_setups(d, tf, sp["tick"]).items():
            for dr in ("both", "long"):
                sd = side if dr == "both" else np.where(side > 0, side, 0.0)
                for tg, k, be, tr in MGMT:
                    r = engine3(*arrs, sd, lim, stp, tgt, k, bool(tg), be, tr, 1.0, 12 if tf == "5m" else 6, sp["tick"], float(sp["mult"]), sp["comm"])
                    seg = np.searchsorted(cuts, r[:, 0], side="right")
                    row = dict(tf=tf, symbol=sym, setup=name, dir=dr, target=TGT_NAME(tg, k), BE=be, trail=TR_NAME[tr])
                    for si, sn in enumerate(segn):
                        for kk, v in stats(r[seg == si]).items(): row[f"{sn}_{kk}"] = v
                    rows.append(row)
        print(tf, sym, "done", file=sys.stderr)
df = pd.DataFrame(rows); df.to_csv("results/ict_grid.csv.gz", index=False, compression="gzip"); print(len(df), "combos")
