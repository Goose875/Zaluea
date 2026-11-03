"""Stage 2: turn robust mega-search families into $-sized micro streams and test them in the 150k evaluation
(target $9k, soft $3k DLL, static DD $4.5k / $3k, 55% consistency). TEST-BLIND selection:
  * markets: only where REAL triggers beat RANDOM controls on TRAIN+VALID pass rate (NQ, GC; ES excluded)
  * families: top-3 distinct triggers per market by TRAIN+VALID plateau; management = modal passing variant
Compared with the previous SAFE basket (EVAL150.md)."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd, itertools
import mega
from engine8 import engine8
from run_eval150 import trades as trades_v1, evaluate, combine
import run_eval as R
from common import SPECS
M = np.load("results/mega_M.npy"); EMAP = {0: 0, 1: 4, 2: 2}
F = pd.read_csv("results/mega_families.csv"); F = F[~F.random & F.symbol.isin(["NQ", "GC"])]
picks = pd.concat([g.sort_values("plateau", ascending=False).drop_duplicates("trigger").head(3) for _, g in F.groupby("symbol")], ignore_index=True)
print("Selected families (TRAIN+VALID plateau only):"); print(picks[["symbol", "trigger", "dir", "regime", "trend", "vol", "window", "plateau", "best_mgmt"]].to_string(index=False))
_cache = {}
def sigs(sym):
    if sym not in _cache:
        d, Lv = mega.levels(sym); T = mega.triggers(sym, d, Lv); Fl = {k: (lm, sm) for k, lm, sm in mega.filters(d, sym)}
        day = np.array([pd.Timestamp(x).toordinal() for x in d.sess]); _cache[sym] = (d, T, Fl, day)
    return _cache[sym]
def stream(row, risk, be_on):
    d, T, Fl, day = sigs(row.symbol); L0, S0 = T[row.trigger]; lm, sm_ = Fl[(row.regime, row.trend, row.vol, row.window)]
    L = L0 & lm if row.dir != "short" else np.zeros_like(L0); S = S0 & sm_ if row.dir != "long" else np.zeros_like(S0)
    em, smod, k, be, tr = M[int(row.best_mgmt)]; sp = SPECS[row.symbol]; nan = np.full(len(d), np.nan)
    tp = k * risk if k > 0 else 1e9
    r = engine8(d.Open.values, d.High.values, d.Low.values, d.Close.values, d.atr.values.astype(float), d.sess_id.values.astype(np.int64),
                L, S, nan, nan, EMAP[int(em)], int(smod), 1, risk, risk, tp, risk if (be or be_on) else 0.0, sp["tick"], float(sp["mult"]), sp["comm"],
                R.MICRO[row.symbol], 0.75, 0.0, 0.0, 0, int(tr))
    return pd.DataFrame(dict(t_in=d.index[np.minimum(r[:, 0].astype(int) + 1, len(d) - 1)], t_out=d.index[r[:, 8].astype(int)],
                             entry_day=day[r[:, 0].astype(int)], exit_day=day[r[:, 8].astype(int)], pnl=r[:, 2], mae=r[:, 7], sym=row.symbol))
OLD = [("NQ", "nr", "NR7 + EMA20/50 trend", "both", 4, 2), ("NQ", "new", "Overnight long + daily regime", "both", 0, 1),
       ("NQ", "new", "Opening drive + daily regime", "both", 0, 1), ("GC", "s2", "NR7 breakout", "both", 0, 1), ("GC", "new", "Overnight long + daily regime", "both", 0, 1)]
rows = []
for risk, be in itertools.product((375.0, 500.0), (0, 1)):
    old = [trades_v1(*s, risk, 1e9, risk if be else 0.0, 0.0, 0.0) for s in OLD]
    new = [stream(r, risk, be) for r in picks.itertuples()]
    for lab, parts in (("v1 SAFE basket (5 streams)", old), ("v2 = v1 + 6 mega families", old + new), ("mega families only (6)", new)):
        T = combine(parts)
        for md in (30, 60, 90, 0):
            for dd in (4500.0, 3000.0):
                e = evaluate(T, md, dd)
                rows.append(dict(basket=lab, risk=risk, BE=be, window=("no limit" if md == 0 else f"{md}d"), DD=dd, trades_month=len(T) / 29.0, avg=T.pnl.mean(), **e))
df = pd.DataFrame(rows); df.to_csv("results/mega_basket.csv", index=False)
pd.set_option("display.width", 300)
x = df[df.DD == 4500.0]
piv = x.pivot_table(index=["basket", "risk", "BE"], columns="window", values=["TUNE_pass%", "TUNE_fail%", "TEST_pass%", "TEST_fail%"]).round(2)
print(piv[[c for c in piv.columns if c[1] in ("30d", "60d", "90d", "no limit")]].to_string())
