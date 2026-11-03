"""Mechanical, test-blind selection over BOTH grids (grid2 + nr_family). Only TRAIN/VALID columns are used to choose.
  1. family = (setup, direction); plateau = share of its combos passing TR & VA filters
  2. top families by plateau (min 20 passing combos)
  3. inside a family, pick combo maximizing min(TR_avgR, VA_avgR)
TEST columns are only printed afterwards."""
import pandas as pd, numpy as np
pd.set_option("display.width", 320); pd.set_option("display.max_rows", 100); pd.set_option("display.max_colwidth", 28)
a = pd.read_csv("results/grid2_1h.csv.gz"); b = pd.read_csv("results/nr_family_1h.csv.gz")
b = b[~b.setup.isin(["NR7"])]   # identical to grid2's 'NR7 breakout'
df = pd.concat([a, b], ignore_index=True)
ok = (df.TR_n >= 50) & (df.VA_n >= 35) & (df.TR_avgR >= 0.10) & (df.VA_avgR >= 0.10) & (df.TR_pf >= 1.2) & (df.VA_pf >= 1.2)
df["pass"] = ok; df["score"] = df[["TR_avgR", "VA_avgR"]].min(axis=1)
fam = df.groupby(["symbol", "setup", "dir"]).agg(combos=("pass", "size"), passed=("pass", "sum"))
fam["plateau"] = fam.passed / fam.combos
fam = fam[fam.passed >= 20].sort_values(["plateau"], ascending=False)
picks = []
for sym in ("NQ", "ES", "GC"):
    top = fam.loc[sym].head(3)
    print(f"\n===== {sym}: top families by TRAIN+VALID plateau =====")
    for (setup, dr), fr in top.iterrows():
        cand = df[(df.symbol == sym) & (df.setup == setup) & (df.dir == dr) & df["pass"]].sort_values("score", ascending=False).iloc[0]
        picks.append(cand)
        print(f"  [{fr.plateau:.1%} of {fr.combos} pass] {setup} ({dr}) -> entry={cand.entry} | stop={cand.stop} | R={cand.R:g} | BE={cand.BE:g} | trail={cand.trail} act={cand.trail_act:g}")
        print(f"      TRAIN n={cand.TR_n:.0f} win={cand.TR_win:.0%} avgR={cand.TR_avgR:+.3f} pf={cand.TR_pf:.2f} ${cand.TR_pnl:,.0f} | "
              f"VALID n={cand.VA_n:.0f} win={cand.VA_win:.0%} avgR={cand.VA_avgR:+.3f} pf={cand.VA_pf:.2f} ${cand.VA_pnl:,.0f} | "
              f"TEST n={cand.TE_n:.0f} win={cand.TE_win:.0%} avgR={cand.TE_avgR:+.3f} pf={cand.TE_pf:.2f} ${cand.TE_pnl:,.0f}")
pd.DataFrame(picks).to_csv("results/final_picks_v2.csv", index=False)
