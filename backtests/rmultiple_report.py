"""Pick the best setup+entry+stop per market using IN-SAMPLE only (mean avgR across all R targets, min trade count),
then print its full 1R..5R curve in-sample and out-of-sample, plus the entry-model comparison for that setup."""
import pandas as pd, numpy as np
pd.set_option("display.width", 250); pd.set_option("display.max_rows", 300)
MIN_N = {"5m": 20, "1h": 80}
picks = []
for tf in ("1h", "5m"):
    df = pd.read_csv(f"results/rmultiple_{tf}.csv")
    for sym in ("NQ", "ES", "GC"):
        f = df[(df.symbol == sym)]
        g = f.groupby(["setup", "entry", "stop"]).agg(IS_n=("IS_n", "min"), IS_meanR=("IS_avgR", "mean"),
                                                      IS_allpos=("IS_avgR", lambda x: (x > 0).mean()))
        g = g[(g.IS_n >= MIN_N[tf]) & (g.IS_allpos >= 0.8)].sort_values("IS_meanR", ascending=False)
        if g.empty: print(f"\n{tf} {sym}: no combo positive across >=80% of R targets in-sample"); continue
        (setup, entry, stop) = g.index[0]
        curve = f[(f.setup == setup) & (f.entry == entry) & (f.stop == stop)].set_index("R")
        print(f"\n===== {tf} {sym}: BEST = {setup} | entry: {entry} | stop: {stop} =====")
        print(curve[["IS_n", "IS_win", "IS_avgR", "IS_pnl", "IS_pf", "OOS_n", "OOS_win", "OOS_avgR", "OOS_pnl", "OOS_pf", "OOS_maxdd"]].round(3).to_string())
        em = f[(f.setup == setup) & (f.stop == stop)].groupby("entry")[["IS_n", "IS_win", "IS_avgR", "OOS_n", "OOS_win", "OOS_avgR", "OOS_pnl"]].mean()
        print(f"-- entry models for this setup/stop (averaged over 1R..5R) --"); print(em.round(3).to_string())
        print("-- runner-up combos (IS) --"); print(g.head(4).round(3).to_string())
        for R, row in curve.iterrows():
            picks.append(dict(tf=tf, symbol=sym, setup=setup, entry=entry, stop=stop, R=R, **row[[c for c in curve.columns if c.startswith(("IS_", "OOS_"))]].to_dict()))
pd.DataFrame(picks).to_csv("results/rmultiple_best.csv", index=False)
