"""Search for a 70% pass-rate evaluation configuration.
Rules: $50k, static $2k DD (incl. open loss), $4k target, 55% consistency, SOFT $1k DLL (liquidate & stop for the day), 30 calendar days.
Trade rules: $500 stop, $2,000 target, optional breakeven and $-trailing.
Sizing variants: (F) fixed $500 bracket on q contracts (1 std, or q micros -> stop = 500/(q*micro$) pts)
                 (M) strategy's own stop, micros sized so risk <= $500
TUNE starts Jun 2024 - Sep 2025, TEST starts Dec 2025 - Oct 2026 (untouched)."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd, itertools, sys
from engine6 import engine6
from propeval import run_evals
import run_eval as R
from common import SPECS
QTY = {"NQ": [("1 NQ", 20.0, 2.5), ("4 MNQ", 8.0, 3.0), ("10 MNQ", 20.0, 7.5)],
       "ES": [("1 ES", 50.0, 2.5), ("4 MES", 20.0, 3.0), ("10 MES", 50.0, 7.5)],
       "GC": [("1 GC", 100.0, 2.5), ("2 MGC", 20.0, 1.5), ("5 MGC", 50.0, 3.75)]}
BE = [0.0, 500.0, 1000.0]; TRAIL = [(0.0, 0.0), (1000.0, 500.0), (1000.0, 750.0), (1500.0, 750.0), (750.0, 500.0)]
TUNE = ("2024-06-12", "2025-09-30"); TEST = ("2025-12-01", "2026-10-02")

def run_one(d, L, S, lim, stp, em, sm, mode, mult, comm, sym, be, ta, tr):
    sp = SPECS[sym]
    return engine6(d.Open.values, d.High.values, d.Low.values, d.Close.values, d.atr.values.astype(float), d.sess_id.values.astype(np.int64),
                   L, S, lim, stp, em, sm, mode, 500.0, 500.0, 2000.0, be, sp["tick"], mult, comm, R.MICRO[sym], 0.75, ta, tr)

def to_trades(r, d, day):
    return pd.DataFrame(dict(t_in=d.index[np.minimum(r[:, 0].astype(int) + 1, len(d) - 1)], t_out=d.index[r[:, 8].astype(int)],
                             entry_day=day[r[:, 0].astype(int)], exit_day=day[r[:, 8].astype(int)], pnl=r[:, 2], mae=r[:, 7]))

def evaluate(t, days):
    t = t.sort_values(["exit_day", "entry_day"]).reset_index(drop=True); out = {}
    for lab, (a, b) in (("TUNE", TUNE), ("TEST", TEST)):
        st = days[(days >= pd.Timestamp(a).toordinal()) & (days <= pd.Timestamp(b).toordinal())].astype(np.int64)
        o = run_evals(st, t.entry_day.values.astype(np.int64), t.exit_day.values.astype(np.int64), t.pnl.values, t.mae.values, 30, 2000.0, 4000.0, 0.55, 1000.0, False)
        p, f = (o[:, 0] == 1).sum(), (o[:, 0] == -1).sum()
        out.update({f"{lab}_pass%": p / len(st), f"{lab}_fail%": f / len(st), f"{lab}_n": len(st)})
    return out

if __name__ == "__main__":
    rows = []
    for sym in ("NQ", "ES", "GC"):
        for kind in ("s2", "nr", "ict"):
            d, S_, day = R.data(sym, kind); days = np.unique(day); sp = SPECS[sym]
            if kind == "nr": S_ = {k: v for k, v in S_.items() if k != "NR7"}
            for name, (L, Sh, lim, stp) in S_.items():
                for dr in ("both", "long"):
                    Sx = Sh if dr == "both" else np.zeros_like(Sh)
                    if L.sum() + Sx.sum() < 30: continue
                    ents = [5, 4] if kind == "ict" else [0, 4]
                    sizings = [("F", q, m, c, 0) for q, m, c in QTY[sym]] + [("M", "micros≤$500", R.MICRO[sym], 0.75, 3 if kind == "ict" else 1)]
                    for em, (sz, qlab, mult, comm, sm), be, (ta, tr) in itertools.product(ents, sizings, BE, TRAIL):
                        mode = 0 if sz == "F" else 1
                        r = run_one(d, L, Sx, lim, stp, em, sm, mode, mult, comm, sym, be, ta, tr)
                        if len(r) < 20: continue
                        t = to_trades(r, d, day)
                        rows.append(dict(symbol=sym, setup=name, dir=dr, entry=R.EN[em], size=qlab, BE=be, trail_act=ta, trail=tr,
                                         trades_per_month=len(t) / 29.0, win=(t.pnl > 0).mean(), hitTP=(r[:, 5] == 2).mean(), **evaluate(t, days)))
            print(sym, kind, len(rows), file=sys.stderr)
    df = pd.DataFrame(rows); df.to_csv("results/eval70_single.csv", index=False)
    pd.set_option("display.width", 330); pd.set_option("display.max_colwidth", 34)
    df["score"] = df["TUNE_pass%"] - df["TUNE_fail%"]
    print(df.sort_values("score", ascending=False).head(25).round(3).to_string(index=False))
    print("\nmax TEST pass% of any single config:", df["TEST_pass%"].max().round(3))
