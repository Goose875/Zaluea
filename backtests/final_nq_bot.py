"""Final NQ bot candidate: 'NR7 breakout + EMA20/50 trend' on 1h bars (long & short).
(a) ENSEMBLE: every parameter set that passed TRAIN+VALID (test-blind), equal weight (e.g. one MNQ micro each)
(b) SINGLE: the modal value of each parameter among the passing sets (one config a simple bot can run)
Outputs per-period stats incl. the window when NQZ26 was front month (Sep 14 - Nov 2 2026)."""
import numpy as np, pandas as pd
from engine2 import engine2, ENTRY, STOPM, TRAIL
from rmultiple import prep_1h
from nr_family import nr_setups
from common import SPECS

df = pd.read_csv("results/regime_grid_1h.csv.gz")
ok = (df.TR_n >= 50) & (df.VA_n >= 35) & (df.TR_avgR >= 0.10) & (df.VA_avgR >= 0.10) & (df.TR_pf >= 1.2) & (df.VA_pf >= 1.2)
mem = df[ok & (df.symbol == "NQ") & (df.setup == "NR7 + EMA20/50 trend") & (df.dir == "both")].copy()
mem["trail"] = mem.trail.fillna("None")
mode = {c: mem[c].mode().iloc[0] for c in ["entry", "stop", "R", "BE", "trail", "trail_act"]}
print("ensemble members:", len(mem)); print("modal parameters:", mode)
for c in ["entry", "stop", "R", "BE", "trail"]: print(" ", c, mem[c].value_counts().to_dict())

d, _, _ = prep_1h("NQ"); sp = SPECS["NQ"]; L, S = nr_setups(d)["NR7 + EMA20/50 trend"]
arrs = (d.Open.values, d.High.values, d.Low.values, d.Close.values, d.atr.values.astype(float), d.sess_id.values.astype(np.int64))
def trades(row):
    r = engine2(*arrs, L, S, ENTRY.index(row["entry"]), STOPM.index(row["stop"]), float(row["R"]), float(row["BE"]),
                TRAIL.index(row["trail"]), float(row["trail_act"]), sp["tick"], float(sp["mult"]), sp["comm"])
    t = pd.DataFrame(r, columns=["i", "side", "pnl", "R", "bars", "reason"]); t["time"] = d.index[t.i.astype(int)]; return t
PER = {"TRAIN Jun24-Mar25": ("2024-06-01", "2025-03-31"), "VALID Apr-Nov25": ("2025-04-01", "2025-11-30"),
       "TEST Dec25-Nov26": ("2025-12-01", "2026-11-03"), "NQZ26 front Sep14-Nov2 26": ("2026-09-14", "2026-11-03")}
def st(t, lab):
    out = []
    for p, (a, b) in PER.items():
        x = t[(t.time >= pd.Timestamp(a, tz="America/New_York")) & (t.time < pd.Timestamp(b, tz="America/New_York") + pd.Timedelta(days=1))]
        p_ = x.pnl; g, ls = p_[p_ > 0].sum(), -p_[p_ < 0].sum(); eq = p_.cumsum()
        out.append(dict(model=lab, period=p, trades=len(x), win=(p_ > 0).mean(), avgR=x.R.mean(), pnl=p_.sum(), pf=g / ls if ls else np.nan,
                        maxdd=(eq - eq.cummax()).min() if len(x) else 0, avg_win=p_[p_ > 0].mean(), avg_loss=p_[p_ < 0].mean()))
    return out
single = trades(mode); rows = st(single, "SINGLE (modal params), 1 NQ")
single.to_csv("results/final_nq_single_trades.csv", index=False)
# ensemble: daily P&L averaged across members (= 1 NQ split evenly, approx 1 MNQ each when members<=10 per NQ)
ens = []
for _, row in mem.iterrows():
    t = trades(row); t["member"] = _; ens.append(t)
E = pd.concat(ens)
for p, (a, b) in PER.items():
    x = E[(E.time >= pd.Timestamp(a, tz="America/New_York")) & (E.time < pd.Timestamp(b, tz="America/New_York") + pd.Timedelta(days=1))]
    per_mem = x.groupby("member").pnl.sum().reindex(mem.index).fillna(0)
    daily = x.groupby(x.time.dt.date).pnl.sum() / len(mem); eq = daily.cumsum()
    rows.append(dict(model=f"ENSEMBLE of {len(mem)} (avg per member = 1 NQ)", period=p, trades=len(x) / len(mem), win=(x.pnl > 0).mean(),
                     avgR=x.R.mean(), pnl=per_mem.mean(), pf=x.pnl[x.pnl > 0].sum() / -x.pnl[x.pnl < 0].sum(),
                     maxdd=(eq - eq.cummax()).min(), avg_win=np.nan, avg_loss=np.nan, members_profitable=(per_mem > 0).mean()))
R = pd.DataFrame(rows); R.to_csv("results/final_nq_bot.csv", index=False)
pd.set_option("display.width", 300); print(R.round(3).to_string())
print("\nexit reasons (single):", single.reason.map({1: "stop/BE/trail", 2: "target", 3: "session end"}).value_counts(normalize=True).round(2).to_dict())
