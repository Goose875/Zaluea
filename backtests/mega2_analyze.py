"""Analyze the 500M search. Everything used for SELECTION comes from TRAIN+VALID; TEST is reported after selection.
1. Luck test by trigger category (ZONE / static LEVEL / SETUP / RANDOM): pass rates and TEST hold-up of passers.
2. Robust families = signal variants (trigger+dir+filters) where >= 20% of eligible management variants pass.
   Ranked by plateau (TRAIN+VALID only). The random-control families give the 'luck ceiling' for plateau.
3. Winning-model candidates: families whose plateau beats the best RANDOM family plateau in the same market."""
import numpy as np, pandas as pd, os
pd.set_option("display.width", 360); pd.set_option("display.max_colwidth", 40); pd.set_option("display.max_rows", 200)
cat = lambda t: t.split()[0]
tot = 0; S, FAM = [], []
for sym in ("NQ", "ES", "GC"):
    if not os.path.exists(f"results/mega2_{sym}_variants.csv.gz"): continue
    tot += int(open(f"results/mega2_{sym}_count.txt").read())
    V = pd.read_csv(f"results/mega2_{sym}_variants.csv.gz"); P = pd.read_csv(f"results/mega2_{sym}_pass.csv.gz")
    V["cat"] = V.trigger.map(cat); P["cat"] = P.trigger.map(cat)
    for c, g in V.groupby("cat"):
        p = P[P.cat == c]
        S.append(dict(symbol=sym, category=c, eligible=int(g.eligible.sum()), passed=int(g.passed.sum()), pass_rate=g.passed.sum() / max(1, g.eligible.sum()),
                      TE_med_passers=p.TE_avg.median(), TE_pos_passers=(p.TE_avg > 0).mean(), TE_med_all=g.elig_TE_med.median()))
    V["plateau"] = V.passed / V.eligible
    rnd_best = V[(V.cat == "RANDOM") & (V.eligible >= 100)].plateau.max()
    f = V[(V.eligible >= 100) & (V.plateau >= 0.2) & (V.cat != "RANDOM")].copy(); f["symbol"] = sym; f["beats_random_ceiling"] = f.plateau > rnd_best
    f["random_ceiling"] = rnd_best; FAM.append(f)
S = pd.DataFrame(S); F = pd.concat(FAM) if FAM else pd.DataFrame()
print(f"TOTAL STRATEGIES SIMULATED: {tot:,}\n")
print("=== 1. Luck test by trigger category (pass = TRAIN & VALID avgR >= 0.15, PF >= 1.3, n >= 50/30) ===")
print(S.round(3).to_string(index=False))
if len(F):
    F.to_csv("results/mega2_families.csv", index=False)
    print("\n=== 2. Robust families (>=20% of >=100 eligible mgmt variants pass) ===")
    print(F.groupby(["symbol", "cat"]).size().unstack(fill_value=0).to_string())
    print("\nrandom-control plateau ceiling per market:", F.groupby("symbol").random_ceiling.first().round(3).to_dict())
    W = F[F.beats_random_ceiling].sort_values("plateau", ascending=False)
    print(f"\n=== 3. Families beating the RANDOM plateau ceiling: {len(W)} ===")
    c = ["symbol", "trigger", "dir", "regime", "trend", "vol", "window", "pd", "dow", "eligible", "plateau", "pass_TR_med", "pass_VA_med", "pass_TE_med", "pass_TE_pos"]
    print(W.groupby("symbol").head(15)[c].round(3).to_string(index=False))
    for sym, g in W.groupby("symbol"):
        print(f"  {sym}: {len(g)} families; their TEST: median {g.pass_TE_med.median():+.3f}R, share of families with positive TEST median {(g.pass_TE_med > 0).mean():.0%}")
