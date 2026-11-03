"""Test-blind final configs for the $500-750 risk / $1,500-3,000 TP brief (1h, continuous front month).
For each market x sizing method: the family with the highest TRAIN+VALID pass share (>=10 passing variants),
traded with the MODAL parameters of its passing variants. TEST is only reported."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd
from engine4 import engine4
from rmultiple import prep_1h
from setups2 import setups
from nr_family import nr_setups
import ict
from common import SPECS
from run_dollar import MICRO, EN, SM
df = pd.read_csv("results/dollar_grid.csv.gz"); h = df[df.tf == "1h"].copy()
h["pass"] = (h.TR_n >= 40) & (h.VA_n >= 25) & (h.TR_avg > 0) & (h.VA_avg > 0) & (h.TR_pf >= 1.2) & (h.VA_pf >= 1.2)
fam = h.groupby(["symbol", "sizing", "setup", "dir"]).agg(combos=("pass", "size"), passed=("pass", "sum")); fam["plateau"] = fam.passed / fam.combos
PER = {"TRAIN": ("2024-06-01", "2025-03-31"), "VALID": ("2025-04-01", "2025-11-30"), "TEST": ("2025-12-01", "2026-11-02"), "Z26 front window": ("2026-09-14", "2026-11-02")}
EN_INV = {v: k for k, v in EN.items()}; SM_INV = {v: k for k, v in SM.items()}
rows = []
for sym in ("NQ", "ES", "GC"):
    d, _, _ = prep_1h(sym); di = ict.prep(sym, "1h"); sp = SPECS[sym]
    for sizing in ("A fixed $ bracket, 1 contract", "B micros sized to risk"):
        f = fam.loc[(sym, sizing)]; f = f[f.passed >= 10].sort_values("plateau", ascending=False)
        if f.empty: continue
        setup, dr = f.index[0]
        mem = h[(h.symbol == sym) & (h.sizing == sizing) & (h.setup == setup) & (h.dir == dr) & h["pass"]]
        mode = {c: mem[c].mode().iloc[0] for c in ["entry", "stop", "risk_cap", "TP", "BE"]}
        is_ict = setup.startswith("ICT") or setup.startswith("Levels")
        if is_ict:
            side, lim, stp, _ = ict.all_setups(di, "1h", sp["tick"])[setup]; dd = di; L, S = side > 0, side < 0
        else:
            allS = setups(d); allS.update(nr_setups(d)); L, S = allS[setup]; dd = d; lim = stp = np.full(len(d), np.nan)
        if dr == "long": S = np.zeros_like(S)
        m_ = 0 if sizing.startswith("A") else 1
        sm = 0 if m_ == 0 else SM_INV[mode["stop"]]
        r = engine4(dd.Open.values, dd.High.values, dd.Low.values, dd.Close.values, dd.atr.values.astype(float), dd.sess_id.values.astype(np.int64),
                    L, S, lim, stp, EN_INV[mode["entry"]], sm, m_, float(mode["risk_cap"]), float(mode["risk_cap"]), float(mode["TP"]), float(mode["BE"]),
                    sp["tick"], float(sp["mult"]), sp["comm"], MICRO[sym], 0.75)
        t = pd.DataFrame(r, columns=["i", "side", "pnl", "risk", "bars", "reason", "qty"]); t["time"] = dd.index[t.i.astype(int)]
        t.to_csv(f"results/final_dollar_{sym}_{m_}.csv", index=False)
        cfg = f"{setup} ({dr}) | entry={mode['entry']} | stop={mode['stop']} | risk cap ${mode['risk_cap']:.0f} | TP ${mode['TP']:.0f} | BE {'off' if mode['BE']==0 else 'at +$750'}"
        for p, (a, b) in PER.items():
            x = t[(t.time >= pd.Timestamp(a, tz="America/New_York")) & (t.time < pd.Timestamp(b, tz="America/New_York") + pd.Timedelta(days=1))]
            pn = x.pnl; eq = pn.cumsum()
            rows.append(dict(symbol=sym, sizing=sizing, config=cfg, plateau=round(f.plateau.iloc[0], 2), members=len(mem),
                             members_TE_profitable=(mem.TE_pnl > 0).mean(), period=p, trades=len(x), win=(pn > 0).mean(), avg_trade=pn.mean(),
                             pnl=pn.sum(), pf=pn[pn > 0].sum() / -pn[pn < 0].sum() if (pn < 0).any() else np.nan,
                             maxdd=(eq - eq.cummax()).min() if len(x) else 0, avg_risk=x.risk.mean(), avg_qty=x.qty.mean(),
                             hit_TP=(x.reason == 2).mean(), hit_SL=(x.reason == 1).mean()))
R = pd.DataFrame(rows); R.to_csv("results/final_dollar.csv", index=False)
pd.set_option("display.width", 330); pd.set_option("display.max_colwidth", 200)
for (sym, sz), g in R.groupby(["symbol", "sizing"], sort=False):
    print(f"\n### {sym} | {sz}\n  {g.config.iloc[0]}\n  family pass-share {g.plateau.iloc[0]}, {g.members.iloc[0]} passing variants, {g.members_TE_profitable.iloc[0]:.0%} of them profitable in TEST")
    print(g[["period", "trades", "win", "avg_trade", "pnl", "pf", "maxdd", "avg_risk", "avg_qty", "hit_TP", "hit_SL"]].round(2).to_string(index=False))
