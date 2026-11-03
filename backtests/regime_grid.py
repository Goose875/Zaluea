"""Round 3 of v2: all setups (21 + NR variants) with an optional DAILY REGIME FILTER
(long only if yesterday's daily close > daily SMA50, short only if below), reduced management grid, 3-way split.
Then a mechanical, test-blind PLATEAU-ENSEMBLE selection: per market, the family with the highest TRAIN+VALID pass rate,
traded as an equal-weight ensemble of ALL its passing parameter sets (e.g. one micro contract each)."""
import numpy as np, pandas as pd, itertools, sys
from engine2 import engine2, ENTRY, STOPM, TRAIL
from rmultiple import prep_1h
from grid2 import seg_stats, SPLIT, cols
from setups2 import setups
from nr_family import nr_setups
from common import SPECS, load, sma

TARGETS = [0.0, 2.0, 3.0, 5.0]; BES = [0.0, 1.0]; TRAILS = [(0, 0.0), (1, 1.0), (2, 0.0), (4, 1.0)]

def regime(d, sym):
    dd = load(f"{sym}_cont_1d.csv"); up = (dd.Close > sma(dd.Close, 50)).shift(1)   # known before today's session
    up.index = up.index.date
    return pd.Series(d.sess.map(up).astype("boolean").fillna(False).to_numpy(dtype=bool), index=d.index)

def run(store_trades=False):
    rows = []; trades = {}
    for sym in ("NQ", "ES", "GC"):
        d, _, _ = prep_1h(sym); sp = SPECS[sym]; up = regime(d, sym).values
        cuts = np.array([(d.index <= pd.Timestamp(x + " 23:59", tz="America/New_York")).sum() for x in SPLIT])
        arrs = (d.Open.values, d.High.values, d.Low.values, d.Close.values, d.atr.values.astype(float), d.sess_id.values.astype(np.int64))
        allS = setups(d); allS.update({k: v for k, v in nr_setups(d).items() if k != "NR7"})
        for name, (L0, S0) in allS.items():
            for filt in ("none", "daily SMA50 regime"):
                L = L0 & up if filt != "none" else L0; S = S0 & ~up if filt != "none" else S0
                for dr in ("both", "long"):
                    S_ = S if dr == "both" else np.zeros_like(S)
                    if L.sum() + S_.sum() < 30: continue
                    for em, sm, k, be, (tr, ta) in itertools.product(range(5), range(3), TARGETS, BES, TRAILS):
                        r = engine2(*arrs, L, S_, em, sm, k, be, tr, ta, sp["tick"], float(sp["mult"]), sp["comm"])
                        segs = np.searchsorted(cuts, r[:, 0], side="right")
                        row = ["1h", sym, name + ("" if filt == "none" else " | REGIME"), dr, ENTRY[em], STOPM[sm], k, be, TRAIL[tr], ta]
                        for s_i in range(3): row += list(seg_stats(r[segs == s_i]))
                        rows.append(row)
        print(sym, "done", file=sys.stderr)
    return pd.DataFrame(rows, columns=cols(3, ["TR", "VA", "TE"]))

if __name__ == "__main__":
    df = run(); df.to_csv("results/regime_grid_1h.csv.gz", index=False, compression="gzip")
    ok = (df.TR_n >= 50) & (df.VA_n >= 35) & (df.TR_avgR >= 0.10) & (df.VA_avgR >= 0.10) & (df.TR_pf >= 1.2) & (df.VA_pf >= 1.2)
    df["pass"] = ok
    fam = df.groupby(["symbol", "setup", "dir"]).agg(combos=("pass", "size"), passed=("pass", "sum"))
    fam["plateau"] = fam.passed / fam.combos
    pd.set_option("display.width", 300); pd.set_option("display.max_rows", 200)
    print("selection-skill check (TEST avgR of passing combos): with REGIME vs without")
    rg = df.setup.str.contains("REGIME")
    for sym in ("NQ", "ES", "GC"):
        for lab, m in (("no filter", ~rg), ("REGIME", rg)):
            x = df[(df.symbol == sym) & m & df["pass"]]
            print(f"  {sym} {lab:9s}: passing={len(x):5d} median TE avgR={x.TE_avgR.median():+.3f}  %pos={(x.TE_avgR>0).mean():.0%}")
    out = []
    for sym in ("NQ", "ES", "GC"):
        top = fam.loc[sym]; top = top[top.passed >= 15].sort_values("plateau", ascending=False).head(5)
        for (setup, dr), fr in top.iterrows():
            x = df[(df.symbol == sym) & (df.setup == setup) & (df.dir == dr) & df["pass"]]
            out.append(dict(symbol=sym, family=setup, dir=dr, plateau=fr.plateau, members=len(x),
                            TR_avgR=x.TR_avgR.mean(), VA_avgR=x.VA_avgR.mean(), TE_avgR=x.TE_avgR.mean(),
                            TE_pnl_per_member=x.TE_pnl.mean(), TE_members_pos=(x.TE_pnl > 0).mean(), TE_trades=x.TE_n.mean()))
    o = pd.DataFrame(out); o.to_csv("results/ensemble_families.csv", index=False)
    print("\nTop-5 families per market by TRAIN+VALID plateau, traded as an ensemble of all passing members (TEST shown last):")
    print(o.round(3).to_string())
