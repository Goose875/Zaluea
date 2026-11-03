"""Final verdict over the full 500M+ search (session-flat run + swing-hold run, NQ/ES/GC).
Selection uses TRAIN+VALID only:
  A) family plateau (share of eligible mgmt variants passing) above the RANDOM-control ceiling of the same market & run, >=100 eligible
  B) robustness across exit styles: the same signal family (trigger+dir+filters) qualifies in BOTH the session-flat and the swing-hold run
  C) robustness across markets: the same family qualifies in >= 2 markets
TEST (Dec 2025 - Nov 2026) is reported only for the verdict."""
import numpy as np, pandas as pd, os
pd.set_option("display.width", 360); pd.set_option("display.max_colwidth", 40); pd.set_option("display.max_rows", 200)
key = ["trigger", "dir", "regime", "trend", "vol", "window", "pd", "dow"]
tot = 0; Vs, Ps, rows = [], [], []
for tag, run in (("", "flat"), ("_hold", "hold")):
    for s in ("NQ", "ES", "GC"):
        f = f"results/mega2{tag}_{s}_variants.csv.gz"
        if not os.path.exists(f): continue
        tot += int(open(f"results/mega2{tag}_{s}_count.txt").read())
        V = pd.read_csv(f).assign(symbol=s, run=run); P = pd.read_csv(f"results/mega2{tag}_{s}_pass.csv.gz").assign(symbol=s, run=run)
        V["cat"] = V.trigger.str.split().str[0]; P["cat"] = P.trigger.str.split().str[0]; V["plateau"] = V.passed / V.eligible
        for c, g in V.groupby("cat"):
            p = P[P.cat == c]
            rows.append(dict(run=run, symbol=s, category=c, eligible=int(g.eligible.sum()), pass_rate=g.passed.sum() / max(1, g.eligible.sum()),
                             TE_med_passers=p.TE_avg.median(), TE_pos_passers=(p.TE_avg > 0).mean()))
        ceil = V[(V.cat == "RANDOM") & (V.eligible >= 100)].plateau.max()
        V["qual"] = (V.eligible >= 100) & (V.plateau > max(0.2, ceil)) & (V.cat != "RANDOM"); V["ceiling"] = ceil
        Vs.append(V)
V = pd.concat(Vs)
print(f"TOTAL STRATEGIES SIMULATED: {tot:,}\n")
L = pd.DataFrame(rows)
print("=== LUCK TEST: pass rate and TEST hold-up of passers by category ===")
print(L.pivot_table(index=["run", "symbol"], columns="category", values=["pass_rate", "TE_med_passers", "TE_pos_passers"]).round(3).to_string())
Q = V[V.qual]
print(f"\n(A) families above random ceiling: {len(Q)}  -> TEST median {Q.pass_TE_med.median():+.3f}R, positive {(Q.pass_TE_med > 0).mean():.0%}")
both = Q.groupby(key + ["symbol"]).run.nunique().reset_index(); both = both[both.run == 2]
QB = Q.merge(both[key + ["symbol"]], on=key + ["symbol"])
print(f"(B) ...and qualifying in BOTH exit styles: {len(both)} families -> TEST median {QB.pass_TE_med.median():+.3f}R, positive {(QB.pass_TE_med > 0).mean():.0%}")
mk = Q.groupby(key).symbol.nunique().reset_index(); mk = mk[mk.symbol >= 2]
QM = Q.merge(mk[key], on=key)
print(f"(C) ...qualifying in >= 2 markets: {len(mk)} families -> TEST median {QM.pass_TE_med.median():+.3f}R, positive {(QM.pass_TE_med > 0).mean():.0%}")
c = ["run", "symbol", "trigger", "dir", "regime", "trend", "vol", "window", "pd", "dow", "eligible", "plateau", "ceiling", "pass_TR_med", "pass_VA_med", "pass_TE_med", "pass_TE_pos"]
print("\n--- (B) families robust to exit style ---"); print(QB.sort_values("plateau", ascending=False)[c].round(3).to_string(index=False))
print("\n--- (C) families robust across markets ---"); print(QM.sort_values("plateau", ascending=False)[c].round(3).head(40).to_string(index=False))
Q.to_csv("results/mega2_final_qualified.csv", index=False)
