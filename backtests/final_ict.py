"""Lock in the ICT 'FVG trend' strategy using TEST-BLIND selection, then report every period on both timeframes.
Choice of management = modal settings among 1h GC variants that passed TRAIN+VALID (none of TEST is used)."""
import numpy as np, pandas as pd
from engine3 import engine3
from ict import prep, fvg_trend
from common import SPECS
df = pd.read_csv("results/ict_grid.csv.gz"); h = df[(df.tf == "1h")]
ok = (h.TR_n >= 40) & (h.VA_n >= 25) & (h.TR_avgR >= 0.10) & (h.VA_avgR >= 0.10) & (h.TR_pf >= 1.2) & (h.VA_pf >= 1.2)
mem = h[ok & (h.symbol == "GC") & (h.setup == "ICT FVG trend (no P/D filter)") & (h.dir == "both")]
print("GC passing variants:", len(mem)); print(mem[["target", "BE", "trail", "TR_avgR", "VA_avgR"]].to_string())
mode = {c: mem[c].mode().iloc[0] for c in ["target", "BE", "trail"]}; print("modal:", mode)
TG = {"liquidity target": (1, 0.0), "no target": (0, 0.0)}; TG.update({f"{k:g}R": (0, k) for k in (1, 2, 3, 5)})
TR = {"none": 0, "ATR 1.5x after +1R": 1, "5-bar after +1R": 2}
use_t, k = TG[mode["target"]]; be = float(mode["BE"]); tr = TR[mode["trail"]]
PER = {"1h": {"TRAIN": ("2024-06-01", "2025-03-31"), "VALID": ("2025-04-01", "2025-11-30"), "TEST": ("2025-12-01", "2026-11-02"),
              "Z26 front window": ("2026-09-14", "2026-11-02")},
       "5m": {"IS Aug25-Oct9": ("2026-08-25", "2026-10-09"), "OOS Oct10-Nov2": ("2026-10-10", "2026-11-02")}}
rows = []
for sym in ("GC", "NQ", "ES"):
    for tf in ("1h", "5m"):
        d = prep(sym, tf); sp = SPECS[sym]; side, lim, stp, tgt = fvg_trend(d, tf, False, sp["tick"])
        r = engine3(d.Open.values, d.High.values, d.Low.values, d.Close.values, d.atr.values.astype(float), d.sess_id.values.astype(np.int64),
                    side, lim, stp, tgt, k, bool(use_t), be, tr, 1.0, 12 if tf == "5m" else 6, sp["tick"], float(sp["mult"]), sp["comm"])
        t = pd.DataFrame(r, columns=["i", "side", "pnl", "R", "bars", "reason"]); t["time"] = d.index[t.i.astype(int)]
        if sym == "GC": t.to_csv(f"results/final_ict_gc_{tf}_trades.csv", index=False)
        for p, (a, b) in PER[tf].items():
            x = t[(t.time >= pd.Timestamp(a, tz="America/New_York")) & (t.time < pd.Timestamp(b, tz="America/New_York") + pd.Timedelta(days=1))]
            pn = x.pnl; eq = pn.cumsum(); g, ls = pn[pn > 0].sum(), -pn[pn < 0].sum()
            rows.append(dict(symbol=sym, tf=tf, period=p, trades=len(x), win=(pn > 0).mean(), avgR=x.R.mean(), pnl=pn.sum(),
                             pf=g / ls if ls else np.nan, maxdd=(eq - eq.cummax()).min() if len(x) else 0, longs=(x.side > 0).sum(), shorts=(x.side < 0).sum()))
R = pd.DataFrame(rows); R.to_csv("results/final_ict.csv", index=False); pd.set_option("display.width", 250); print(R.round(3).to_string())
