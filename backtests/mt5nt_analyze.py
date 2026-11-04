"""Verdict on the MT5 / NinjaTrader ports: luck test vs random entries, then families (trigger+direction+filters) whose
share of passing management variants beats the best random family. TEST is used only for the verdict."""
import pandas as pd, numpy as np
pd.set_option("display.width", 340); pd.set_option("display.max_colwidth", 46); pd.set_option("display.max_rows", 200)
src = lambda t: "RANDOM" if t.startswith("RANDOM") else ("MT5 EA" if t.startswith("MT5 EA") else ("NT8" if t.startswith("NT8") else "MT5 module"))
out = []
for tf in ("daily", "1h"):
    V = pd.read_csv(f"results/mt5nt_{tf}_variants.csv.gz"); P = pd.read_csv(f"results/mt5nt_{tf}_pass.csv.gz")
    V["src"] = V.trigger.map(src); P["src"] = P.trigger.map(src); V["plateau"] = V.passed / V.eligible
    print(f"\n======== {tf.upper()}  ({int(open(f'results/mt5nt_{tf}_count.txt').read()):,} strategies) ========")
    L = []
    for (s, c), g in V.groupby(["symbol", "src"]):
        p = P[(P.symbol == s) & (P.src == c)]
        L.append(dict(symbol=s, source=c, pass_rate=g.passed.sum() / max(1, g.eligible.sum()), passers=int(g.passed.sum()),
                      TEST_med_passers=p.TE_avg.median(), TEST_pos_passers=(p.TE_avg > 0).mean()))
    print("Luck test (pass = TRAIN & VALID avg >= +0.15R, PF >= 1.3):"); print(pd.DataFrame(L).round(3).to_string(index=False))
    rows = []
    for s, g in V.groupby("symbol"):
        ceil = g[(g.src == "RANDOM") & (g.eligible >= 100)].plateau.max()
        q = g[(g.src != "RANDOM") & (g.eligible >= 100) & (g.plateau > max(0.2, ceil if ceil == ceil else 0))].copy(); q["random_ceiling"] = ceil; rows.append(q)
    Q = pd.concat(rows) if rows else pd.DataFrame()
    if len(Q):
        Q["tf"] = tf; out.append(Q)
        print(f"\nFamilies beating the random ceiling: {len(Q)} -> TEST median {Q.pass_TE_med.median():+.3f}R, {(Q.pass_TE_med > 0).mean():.0%} positive")
        print(Q.groupby(["symbol", "src"]).pass_TE_med.agg(["size", "median", lambda x: (x > 0).mean()]).round(3).to_string())
        c = ["symbol", "trigger", "dir", "regime", "trend", "vol", "window", "eligible", "plateau", "random_ceiling", "pass_TR_med", "pass_VA_med", "pass_TE_med", "pass_TE_pos", "pass_TE_n"]
        print(Q.assign(score=Q.plateau * Q[["pass_TR_med", "pass_VA_med"]].min(axis=1)).sort_values("score", ascending=False)[c].head(15).round(3).to_string(index=False))
if out: pd.concat(out).to_csv("results/mt5nt_qualified.csv", index=False)
