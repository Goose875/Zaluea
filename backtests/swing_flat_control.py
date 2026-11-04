"""Luck control for swing_flat.py: the chosen flat-daily version vs 200 random-entry runs on the same market, same direction
mix, same filter days, same trade count and same stop/target. Reports where the real result ranks (percentile) per period."""
import numpy as np, pandas as pd
import swing_flat as sf
from swing_robust import rules, TRIG, DATA, FILT

R = pd.read_csv("results/swing_flat.csv"); rows = []
for _, r in R.iterrows():
    name, sym = r.candidate, TRIG[r.candidate][0]; d = DATA[sym]; _, _, dr, f, _ = TRIG[name]
    L0, S0 = rules(d, name); lm, smk = FILT[sym][f]
    L = np.nan_to_num(L0.values.astype(float)).astype(bool) & lm; S = np.nan_to_num(S0.values.astype(float)).astype(bool) & smk
    if dr == "long": S = np.zeros_like(S)
    k = 0 if r.target == "session close" else int(r.target[0])
    real = sf.flat_trades(name, sym, r.stop, k)
    nL, nS = L.sum(), S.sum(); poolL, poolS = np.where(lm)[0], np.where(smk)[0]; rng = np.random.default_rng(7)
    orig = rules
    res = {"all": [], "TEST": []}
    for _ in range(200):
        RL = np.zeros(len(d), bool); RS = np.zeros(len(d), bool)
        RL[rng.choice(poolL, min(nL, len(poolL)), replace=False)] = True
        if nS: RS[rng.choice(poolS, min(nS, len(poolS)), replace=False)] = True; RS &= ~RL
        sf.rules = lambda d_, n_, k_=1.0, a=RL, b=RS: (pd.Series(a, index=d_.index), pd.Series(b, index=d_.index))
        t = sf.flat_trades(name, sym, r.stop, k); res["all"].append(t.R.mean()); res["TEST"].append(t[t.year >= 2020].R.mean())
    sf.rules = orig
    ra, rt = real.R.mean(), real[real.year >= 2020].R.mean()
    rows.append(dict(candidate=name, version=f"{r.stop} stop, {r.target}", real_all=ra, random_all_median=np.median(res["all"]), pct_all=(np.array(res["all"]) < ra).mean(),
                     real_TEST=rt, random_TEST_median=np.median(res["TEST"]), pct_TEST=(np.array(res["TEST"]) < rt).mean()))
O = pd.DataFrame(rows); O.to_csv("results/swing_flat_control.csv", index=False)
pd.set_option("display.width", 300); print(O.round(3).to_string(index=False))
