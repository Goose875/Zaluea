"""NQ + GC in ONE evaluation account (micros). Overlapping positions are handled conservatively: each trade's worst
open P&L is increased by the worst open P&L of every other trade open at the same time.
Grid chosen on TUNE starts (90-day limit), reported on untouched TEST starts (90-day limit and unlimited)."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd, itertools
from engine5 import engine5
from propeval import run_evals
import run_eval as R
from common import SPECS

def trades(sym, setup, dr, kind, em, sm, risk, tp, be):
    d, S, day = R.data(sym, kind); L, Sh, lim, stp = S[setup]; sp = SPECS[sym]
    if dr == "long": Sh = np.zeros_like(Sh)
    r = engine5(d.Open.values, d.High.values, d.Low.values, d.Close.values, d.atr.values.astype(float), d.sess_id.values.astype(np.int64),
                L, Sh, lim, stp, em, sm, 1, risk, risk, tp, be, sp["tick"], float(sp["mult"]), sp["comm"], R.MICRO[sym], 0.75)
    ix = d.index
    return pd.DataFrame(dict(t_in=ix[r[:, 0].astype(int) + 1], t_out=ix[r[:, 8].astype(int)], entry_day=day[r[:, 0].astype(int)],
                             exit_day=day[r[:, 8].astype(int)], pnl=r[:, 2], mae=r[:, 7], sym=sym))

def combine(a, b):
    t = pd.concat([a, b], ignore_index=True).sort_values("t_out").reset_index(drop=True)
    tin = t.t_in.values; tout = t.t_out.values; mae = t.mae.values; adj = mae.copy()
    for i in range(len(t)):
        ov = (tin < tout[i]) & (tout > tin[i]); ov[i] = False
        adj[i] += np.minimum(mae[ov], 0).sum()
    t["mae"] = adj; return t

def evaluate(t, max_days):
    t = t.sort_values(["exit_day", "entry_day"]).reset_index(drop=True); out = {}
    days = np.unique(np.r_[R.data("NQ", "nr")[2], R.data("GC", "s2")[2]])
    for lab, (a, b) in (("TUNE", R.TUNE), ("TEST", ("2025-12-01", "2026-08-03"))):
        st = days[(days >= pd.Timestamp(a).toordinal()) & (days <= pd.Timestamp(b).toordinal())].astype(np.int64)
        o = run_evals(st, t.entry_day.values.astype(np.int64), t.exit_day.values.astype(np.int64), t.pnl.values, t.mae.values, max_days)
        p, f = (o[:, 0] == 1).sum(), (o[:, 0] == -1).sum()
        out.update({f"{lab}_starts": len(st), f"{lab}_pass": p, f"{lab}_fail": f, f"{lab}_open": len(st) - p - f,
                    f"{lab}_pass%": p / len(st), f"{lab}_fail%": f / len(st), f"{lab}_days_to_pass": np.median(o[o[:, 0] == 1, 1]) if p else np.nan})
    return out

if __name__ == "__main__":
    rows = []
    NQ = [(em, sm, risk, tp, be) for em in (4, 0) for sm in (1, 2) for risk in (250.0, 375.0, 500.0) for tp in (1500.0, 2000.0, 2500.0) for be in (0.0, 750.0)]
    GC = [(em, 1, risk, tp, be) for em in (4, 0) for risk in (250.0, 375.0) for tp in (1500.0, 2000.0, 2500.0) for be in (0.0, 500.0)]
    nq_cache = {c: trades("NQ", "NR7 + EMA20/50 trend", "both", "nr", *c) for c in NQ}
    gc_cache = {c: trades("GC", "NR7 breakout", "both", "s2", *c) for c in GC}
    for cn, cg in itertools.product(NQ, GC):
        t = combine(nq_cache[cn], gc_cache[cg])
        rows.append(dict(NQ_entry=R.EN[cn[0]], NQ_stop=R.SMN[cn[1]], NQ_risk=cn[2], NQ_TP=cn[3], NQ_BE=cn[4],
                         GC_entry=R.EN[cg[0]], GC_risk=cg[2], GC_TP=cg[3], GC_BE=cg[4], trades=len(t), **evaluate(t, 90)))
    df = pd.DataFrame(rows); df.to_csv("results/eval_portfolio_90d.csv", index=False)
    pd.set_option("display.width", 330)
    b = df.sort_values(["TUNE_pass%", "TUNE_fail%"], ascending=[False, True]).head(8)
    print("Top portfolio configs by TUNE 90-day pass rate (TEST = untouched):"); print(b.round(2).to_string(index=False))
    best = b.iloc[0]
    cn = (4 if best.NQ_entry == "confirm-close" else 0, 1 if best.NQ_stop == "1xATR" else 2, best.NQ_risk, best.NQ_TP, best.NQ_BE)
    cg = (4 if best.GC_entry == "confirm-close" else 0, 1, best.GC_risk, best.GC_TP, best.GC_BE)
    t = combine(nq_cache[cn], gc_cache[cg]); t.to_csv("results/eval_portfolio_best_trades.csv", index=False)
    print("\nChosen portfolio, NO time limit:", {k: (round(v, 2) if isinstance(v, float) else v) for k, v in evaluate(t, 0).items()})
