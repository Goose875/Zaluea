"""Massive grid v2 on hourly continuous futures with a 3-way split.
  TRAIN : 2024-06-12 .. 2025-03-31     (selection)
  VALID : 2025-04-01 .. 2025-11-30     (must also be profitable here)
  TEST  : 2025-12-01 .. 2026-11-02     (never used for selection; reported once at the end)
Grid per setup & market: 5 entries x 3 stops x 7 targets (none,1,1.5,2,3,4,5R) x 3 breakeven (off,0.5R,1R)
                         x 9 trailing configs x 2 directions (both / long-only) = 5,670 combos."""
import numpy as np, pandas as pd, itertools, sys, time
from engine2 import engine2, ENTRY, STOPM, TRAIL
from rmultiple import prep_1h, prep_5m
from setups2 import setups
from common import SPECS

TARGETS = [0.0, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0]
BES = [0.0, 0.5, 1.0]
TRAILS = [(0, 0.0)] + [(t, act) for t in (1, 2, 3, 4) for act in (0.0, 1.0)]
DIRS = ["both", "long"]
SPLIT = ("2025-03-31", "2025-11-30")

def seg_stats(r):
    n = len(r)
    if n == 0: return (0, np.nan, np.nan, 0.0, np.nan)
    p = r[:, 2]; g = p[p > 0].sum(); ls = -p[p < 0].sum()
    return (n, (p > 0).mean(), r[:, 3].mean(), p.sum(), g / ls if ls > 0 else 99.0)

def run_market(sym, d, cuts, label):
    sp = SPECS[sym]; arrs = (d.Open.values, d.High.values, d.Low.values, d.Close.values, d.atr.values.astype(float), d.sess_id.values.astype(np.int64))
    rows = []
    for name, (L, S) in setups(d).items():
        if L.sum() + S.sum() < 30: continue
        for dr in DIRS:
            S_ = S if dr == "both" else np.zeros_like(S)
            for em, sm, k, be, (tr, ta) in itertools.product(range(5), range(3), TARGETS, BES, TRAILS):
                if k == 0 and tr == 0: pass  # exit only by stop/BE or session end - still valid
                r = engine2(*arrs, L, S_, em, sm, k, be, tr, ta, sp["tick"], float(sp["mult"]), sp["comm"])
                segs = np.searchsorted(cuts, r[:, 0], side="right") if len(r) else np.array([])
                row = [label, sym, name, dr, ENTRY[em], STOPM[sm], k, be, TRAIL[tr], ta]
                for s_i in range(len(cuts) + 1):
                    row += list(seg_stats(r[segs == s_i]))
                rows.append(row)
    return rows

def cols(nseg, names):
    c = ["data", "symbol", "setup", "dir", "entry", "stop", "R", "BE", "trail", "trail_act"]
    for s in names[:nseg]: c += [f"{s}_n", f"{s}_win", f"{s}_avgR", f"{s}_pnl", f"{s}_pf"]
    return c

if __name__ == "__main__":
    t0 = time.time(); rows = []
    for sym in ("NQ", "ES", "GC"):
        d, _, _ = prep_1h(sym)
        cuts = np.array([(d.index <= pd.Timestamp(x + " 23:59", tz="America/New_York")).sum() for x in SPLIT])
        rows += run_market(sym, d, cuts, "1h"); print(sym, "1h done", round(time.time() - t0), "s", file=sys.stderr)
    df = pd.DataFrame(rows, columns=cols(3, ["TR", "VA", "TE"]))
    df.to_csv("results/grid2_1h.csv.gz", index=False, compression="gzip"); print(len(df), "combos")
