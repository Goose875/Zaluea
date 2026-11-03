"""Pick the representative (most typical passing) management for 7 chosen families and recompute their stats."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd, warnings; warnings.filterwarnings("ignore")
import mega, levels2, mega2
from mega_engine2 import run_block2
from common import SPECS
def grid(hold, zone):
    ts = (6, 12, 24, 48, 96) if hold else (0, 3, 6)
    if zone: return np.array([[em, sm, k, be, tr, tm] for em in (0, 1, 2, 3) for sm in (0, 1, 2, 3) for k in (1.0, 1.5, 2.0, 3.0, 5.0, 0.0, -1.0) for be in (0, 1) for tr in (0, 1) for tm in ts], float)
    return np.array([[em, sm, k, be, tr, tm] for em in (0, 1, 2) for sm in (0, 1, 2) for k in (1.0, 1.5, 2.0, 3.0, 5.0, 0.0) for be in (0, 1) for tr in (0, 1) for tm in ts], float)
PICKS = [  # name, sym, run, trigger, dir, regime, trend, vol, window, pd, dow, fixed_mgmt(None = representative)
 ("K1 NQ prior-day POC break", "NQ", "flat", "LEVEL prior POC break", "both", "against", "with", "any", "any", "none", "any", None),
 ("K2 NQ NR4 trend low-vol swing", "NQ", "hold", "SETUP NR4", "both", "none", "with", "low", "any", "none", "any", None),
 ("K3 NQ NR7 + EMA trend", "NQ", "flat", "SETUP NR7 + EMA20/50 trend", "both", "none", "none", "any", "any", "none", "any", [1, 1, 0.0, 0, 1, 0]),
 ("K4 NQ VWAP+1sigma retest short", "NQ", "flat", "LEVEL VWAP +1σ retest", "short", "none", "none", "low", "NY AM 08-12", "none", "any", None),
 ("K5 GC prior VAL break short", "GC", "flat", "LEVEL prior VAL break", "short", "none", "none", "high", "any", "with", "any", None),
 ("K6 GC NR7 long Asia swing", "GC", "hold", "SETUP NR7 breakout", "long", "none", "none", "low", "Asia 18-02", "none", "any", None),
 ("K7 GC prior VAL break swing", "GC", "hold", "LEVEL prior VAL break", "both", "against", "none", "high", "any", "with", "any", None)]
key = ["trigger", "dir", "regime", "trend", "vol", "window", "pd", "dow"]
rows = []; cache = {}
for name, sym, run, trig, dr, rg, tr_, vol, win, pdf, dow, fixed in PICKS:
    if sym not in cache:
        d, Lv = mega.levels(sym); T = mega.triggers(sym, d, Lv); F = {f[0]: (f[1], f[2]) for f in mega2.filters(d, sym)}; cache[sym] = (d, T, F)
    d, T, F = cache[sym]
    hold = run == "hold"
    if fixed is None:
        P = pd.read_csv(f"results/mega2{'_hold' if hold else ''}_{sym}_pass.csv.gz")
        m = P
        for k_, v in zip(key, (trig, dr, rg, tr_, vol, win, pdf, dow)): m = m[m[k_].astype(str) == v]
        m = m.assign(sc=m[["TR_avg", "VA_avg"]].min(axis=1)); rep = m.iloc[(m.sc - m.sc.median()).abs().argsort().iloc[0]]
        Mrow = grid(hold, False)[int(rep.mgmt)]; nfam = len(m)
    else:
        Mrow = np.array(fixed, float); nfam = 1
    L0, S0 = T[trig]; lm, sm_ = F[(rg, tr_, vol, win, pdf, dow)]
    L = L0 & lm if dr != "short" else np.zeros_like(L0); S = S0 & sm_ if dr != "long" else np.zeros_like(S0)
    sp = SPECS[sym]; nan = np.full(len(d), np.nan)
    cuts = [int((d.index <= pd.Timestamp(x + " 23:59", tz="America/New_York")).sum()) for x in mega2.SPLIT]
    arrs = (d.Open.values, d.High.values, d.Low.values, d.Close.values, d.atr.values.astype(float), d.sess_id.values.astype(np.int64))
    r = run_block2(*arrs, L[None], S[None], nan, nan, nan, Mrow[None], cuts[0], cuts[1], sp["tick"], float(sp["mult"]), sp["comm"], int(hold))[0, 0]
    row = dict(name=name, mgmt=Mrow.tolist(), hold=hold, passing_variants=nfam, signals=int(L.sum() + S.sum()))
    for si, lab in enumerate(("TRAIN", "VALID", "TEST")):
        n, sR, w, gp, gl, _ = r[si]; row.update({f"{lab}_n": int(n), f"{lab}_win": w / max(n, 1), f"{lab}_avgR": sR / max(n, 1), f"{lab}_pf": gp / max(gl, 1e-9), f"{lab}_usd_1lot": gp - gl})
    rows.append(row)
R = pd.DataFrame(rows); R.to_csv("results/keel_picks.csv", index=False)
pd.set_option("display.width", 320); print(R.round(3).to_string(index=False))
