"""Flat-daily versions of the daily swing winners (for accounts that must be flat every day, e.g. Topstep).
Signal at the daily close (same rules as swing_robust.py) -> enter at the next session's open (+1 tick) -> exit at the stop or
target if that session's range reaches it (stop first if both), otherwise at that session's close (-1 tick). No overnight hold.
Management grid: stop = signal bar / 1xATR / 0.5xATR ; target = 1R / 2R / 3R / none (session close). Costs as everywhere."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd, itertools, warnings
warnings.filterwarnings("ignore")
from common import SPECS
from swing_robust import rules, TRIG, DATA, FILT, trades as swing_trades

def flat_trades(name, sym, stop_model, k):
    d = DATA[sym]; _, _, dr, f, _ = TRIG[name]; L0, S0 = rules(d, name); lm, sm_ = FILT[sym][f]
    L = np.nan_to_num(L0.values.astype(float)).astype(bool) & lm; S = np.nan_to_num(S0.values.astype(float)).astype(bool) & sm_
    if dr == "long": S = np.zeros_like(S)
    o, h, l, c, a = (d[x].values.astype(float) for x in ("Open", "High", "Low", "Close", "atr")); sp = SPECS[sym]; T, M, fee = sp["tick"], sp["mult"], sp["comm"]
    out = []
    for i in np.where(L | S)[0]:
        j = i + 1
        if j >= len(o) or not a[i] > 0: continue
        side = 1 if L[i] else -1; e = o[j] + side * T
        stp = (l[i] - T if side == 1 else h[i] + T) if stop_model == "signal bar" else e - side * a[i] * (1.0 if stop_model == "1xATR" else 0.5)
        risk = (e - stp) * side
        if risk <= 0: continue
        risk = max(risk, 4 * T); stp = e - side * risk; tgt = e + side * k * risk if k else None
        if (l[j] <= stp) if side == 1 else (h[j] >= stp): ex = (min(stp, o[j]) if side == 1 else max(stp, o[j])) - side * T
        elif tgt is not None and ((h[j] >= tgt + T) if side == 1 else (l[j] <= tgt - T)): ex = tgt
        else: ex = c[j] - side * T
        pnl = side * (ex - e) * M - 2 * fee; out.append((d.index[i].year, pnl / (risk * M)))
    return pd.DataFrame(out, columns=["year", "R"])

rows = []
for name in ("GC TEMA failed breakout", "NQ outside bar reversal", "GC VIDYA cross", "ES MACD zero cross", "GC Fractal breakout"):
    sym = TRIG[name][0]; sw = swing_trades(name, sym)
    best = None
    for sm, k in itertools.product(("signal bar", "1xATR", "0.5xATR"), (1, 2, 3, 0)):
        t = flat_trades(name, sym, sm, k); tr, va, te = t[t.year <= 2014], t[(t.year >= 2015) & (t.year <= 2019)], t[t.year >= 2020]
        r = dict(candidate=name, stop=sm, target=f"{k}R" if k else "session close", trades=len(t), avgR_all=t.R.mean(), TRAIN=tr.R.mean(), VALID=va.R.mean(), TEST=te.R.mean(),
                 pos_years=f"{(t.groupby('year').R.sum() > 0).sum()}/{t.year.nunique()}")
        sc = min(r["TRAIN"], r["VALID"])            # pick the flat version on 2005-2019 only
        if best is None or sc > best[0]: best = (sc, r)
    b = best[1]; b.update(swing_avgR_all=sw.R.mean(), swing_TEST=sw[sw.year >= 2020].R.mean()); rows.append(b)
R = pd.DataFrame(rows); R.to_csv("results/swing_flat.csv", index=False)
pd.set_option("display.width", 300); print(R.round(3).to_string(index=False))
