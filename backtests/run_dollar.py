"""Dollar-target research: TP $1,500-3,000, risk $500-750 per trade.
 A) FIXED bracket, 1 standard contract (NQ $20/pt, ES $50/pt, GC $100/pt)
 B) MICRO sizing (MNQ $2/pt, MES $5/pt, MGC $10/pt, $0.75/side commission): strategy stop, qty = floor(risk_cap / stop$)
All setups: 21 (setups2) + NR variants + ICT setups. Data: continuous front month (NQ1!/ES1!/GC1!).
1h: TRAIN to 2025-03-31, VALID to 2025-11-30, TEST to 2026-11-02 | 5m: IS to 2026-10-09, OOS to 2026-11-02."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd, itertools, sys
from engine4 import engine4
from rmultiple import prep_1h, prep_5m
from setups2 import setups
from nr_family import nr_setups
import ict
from common import SPECS
MICRO = {"NQ": 2.0, "ES": 5.0, "GC": 10.0}
STOPS = [500.0, 625.0, 750.0]; TPS = [1500.0, 2000.0, 2500.0, 3000.0]; BES = [0.0, 750.0]; CAPS = [625.0, 750.0]
EN = {0: "Market next open", 2: "Limit @ signal-bar 50%", 4: "Confirm close beyond bar", 5: "ICT native entry"}
SM = {0: "Signal-bar extreme", 1: "1.0 x ATR", 2: "5-bar swing", 3: "ICT native stop"}
CUTS = {"1h": ["2025-03-31", "2025-11-30"], "5m": ["2026-10-09"]}; SEG = {"1h": ["TR", "VA", "TE"], "5m": ["IS", "OOS"]}

def stats(r):
    if len(r) == 0: return dict(n=0, win=np.nan, avg=np.nan, pnl=0.0, pf=np.nan, dd=0.0, risk=np.nan, qty=np.nan)
    p = r[:, 2]; g, ls = p[p > 0].sum(), -p[p < 0].sum(); eq = np.cumsum(p)
    return dict(n=len(p), win=(p > 0).mean(), avg=p.mean(), pnl=p.sum(), pf=g / ls if ls > 0 else 99.0,
                dd=(eq - np.maximum.accumulate(eq)).min(), risk=r[:, 3].mean(), qty=r[:, 6].mean())

def run_family(rows, tf, sym, d, sigs, ict_mode):
    sp = SPECS[sym]; cuts = np.array([(d.index <= pd.Timestamp(x + " 23:59", tz="America/New_York")).sum() for x in CUTS[tf]])
    arrs = (d.Open.values, d.High.values, d.Low.values, d.Close.values, d.atr.values.astype(float), d.sess_id.values.astype(np.int64))
    for name, (L, S, lim, stp) in sigs.items():
        for dr in ("both", "long"):
            S_ = S if dr == "both" else np.zeros_like(S)
            if L.sum() + S_.sum() < 20: continue
            ents = [5, 0, 4] if ict_mode else [0, 2, 4]
            cfgs = [(0, em, 0, s, 0.0, tp, be) for em in ([5, 0] if ict_mode else [0, 4]) for s in STOPS for tp in TPS for be in BES]
            cfgs += [(1, em, sm, 0.0, cap, tp, be) for em in ents for sm in ([3, 1] if ict_mode else [0, 1, 2]) for cap in CAPS for tp in TPS for be in BES]
            for mode, em, sm, s_usd, cap, tp, be in cfgs:
                r = engine4(*arrs, L, S_, lim, stp, em, sm, mode, s_usd, cap, tp, be, sp["tick"], float(sp["mult"]), sp["comm"], MICRO[sym], 0.75)
                seg = np.searchsorted(cuts, r[:, 0], side="right")
                row = dict(tf=tf, symbol=sym, setup=name, dir=dr, sizing="A fixed $ bracket, 1 contract" if mode == 0 else "B micros sized to risk",
                           entry=EN[em], stop=(f"${s_usd:.0f} fixed" if mode == 0 else SM[sm]), risk_cap=(s_usd if mode == 0 else cap), TP=tp, BE=be)
                for si, sn in enumerate(SEG[tf]):
                    for kk, v in stats(r[seg == si]).items(): row[f"{sn}_{kk}"] = v
                rows.append(row)

if __name__ == "__main__":
    rows = []
    for tf in ("1h", "5m"):
        for sym in ("NQ", "ES", "GC"):
            d, _, _ = (prep_1h if tf == "1h" else prep_5m)(sym)
            S1 = setups(d); S1.update({k: v for k, v in nr_setups(d).items() if k != "NR7"})
            nan = np.full(len(d), np.nan)
            run_family(rows, tf, sym, d, {k: (L, S, nan, nan) for k, (L, S) in S1.items()}, False)
            di = ict.prep(sym, tf); sigs = {}
            for k, (side, lim, stp, tgt) in ict.all_setups(di, tf, SPECS[sym]["tick"]).items():
                sigs[k] = (side > 0, side < 0, lim, stp)
            run_family(rows, tf, sym, di, sigs, True)
            print(tf, sym, len(rows), file=sys.stderr)
    df = pd.DataFrame(rows); df.to_csv("results/dollar_grid.csv.gz", index=False, compression="gzip"); print(len(df), "combos")
