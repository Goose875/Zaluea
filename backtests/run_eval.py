"""(MAX_DAYS env: evaluation time limit in calendar days, default 90; 0 = unlimited)
Tune strategies for a $50k static-drawdown evaluation ($2k DD, $4k target, 55% consistency).
Evaluations start on every trading day. TUNE on starts Jun 12 2024 - Sep 30 2025; REPORT on starts Dec 1 2025 - Oct 2 2026."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd, itertools, sys
from engine5 import engine5
from propeval import run_evals
from rmultiple import prep_1h
from nr_family import nr_setups
from setups2 import setups
import ict
from common import SPECS
MICRO = {"NQ": 2.0, "ES": 5.0, "GC": 10.0}
CAPS = [250.0, 375.0, 500.0, 625.0, 750.0]; TPS = [1000.0, 1500.0, 2000.0, 2500.0, 3000.0]; BES = [0.0, 500.0, 750.0]
TUNE = ("2024-06-12", "2025-09-30"); TEST = ("2025-12-01", (pd.Timestamp("2026-11-02") - pd.Timedelta(days=int(os.environ.get("MAX_DAYS", "90")) or 30)).strftime("%Y-%m-%d"))
STRATS = [("NQ", "NR7 + EMA20/50 trend", "both", "nr"), ("NQ", "NR7 + EMA20/50 trend", "long", "nr"), ("NQ", "NR10", "long", "nr"),
          ("NQ", "ICT FVG trend (no P/D filter)", "both", "ict"),
          ("GC", "ICT FVG trend (no P/D filter)", "both", "ict"), ("GC", "NR7 breakout", "both", "s2"), ("GC", "Donchian 20 breakout", "long", "s2"),
          ("ES", "ICT turtle soup PDH/PDL", "both", "ict"), ("ES", "ICT FVG trend (no P/D filter)", "long", "ict")]
EN = {0: "market", 4: "confirm-close", 5: "ICT limit"}; SMN = {1: "1xATR", 2: "5-bar swing", 3: "ICT stop"}

_cache = {}
def data(sym, kind):
    key = (sym, kind)
    if key not in _cache:
        if kind == "ict":
            d = ict.prep(sym, "1h"); S = {k: (v[0] > 0, v[0] < 0, v[1], v[2]) for k, v in ict.all_setups(d, "1h", SPECS[sym]["tick"]).items()}
            day = np.array([pd.Timestamp(x).toordinal() for x in d.key])
        else:
            d, _, _ = prep_1h(sym); nan = np.full(len(d), np.nan)
            src = nr_setups(d) if kind == "nr" else setups(d)
            S = {k: (L, Sh, nan, nan) for k, (L, Sh) in src.items()}
            day = np.array([pd.Timestamp(x).toordinal() for x in d.sess])
        _cache[key] = (d, S, day)
    return _cache[key]

def trades_for(sym, setup, dr, kind, mode, em, sm, risk, tp, be):
    d, S, day = data(sym, kind); L, Sh, lim, stp = S[setup]; sp = SPECS[sym]
    if dr == "long": Sh = np.zeros_like(Sh)
    r = engine5(d.Open.values, d.High.values, d.Low.values, d.Close.values, d.atr.values.astype(float), d.sess_id.values.astype(np.int64),
                L, Sh, lim, stp, em, sm, mode, risk, risk, tp, be, sp["tick"], float(sp["mult"]), sp["comm"], MICRO[sym], 0.75)
    return pd.DataFrame(dict(entry_day=day[r[:, 0].astype(int)], exit_day=day[r[:, 8].astype(int)], pnl=r[:, 2], mae=r[:, 7], qty=r[:, 6], risk=r[:, 3]))

MAX_DAYS = int(os.environ.get("MAX_DAYS", "90"))
DLL = float(os.environ.get("DLL", "0")); DLL_HARD = os.environ.get("DLL_MODE", "soft") == "hard"
TAG = f"{MAX_DAYS}d" + (f"_dll{int(DLL)}{'hard' if DLL_HARD else 'soft'}" if DLL > 0 else "")
def eval_trades(t, all_days):
    t = t.sort_values(["exit_day", "entry_day"]).reset_index(drop=True)
    res = {}
    for lab, (a, b) in (("TUNE", TUNE), ("TEST", TEST)):
        st = np.array([x for x in all_days if pd.Timestamp(a).toordinal() <= x <= pd.Timestamp(b).toordinal()], dtype=np.int64)
        o = run_evals(st, t.entry_day.values.astype(np.int64), t.exit_day.values.astype(np.int64), t.pnl.values, t.mae.values, MAX_DAYS, 2000.0, 4000.0, 0.55, DLL, DLL_HARD)
        p, f, op = (o[:, 0] == 1).sum(), (o[:, 0] == -1).sum(), (o[:, 0] == 0).sum()
        res[f"{lab}_fail_by_DLL"] = int(((o[:, 0] == -1) & (o[:, 4] == 2)).sum())
        res.update({f"{lab}_starts": len(st), f"{lab}_pass": p, f"{lab}_fail": f, f"{lab}_open": op,
                    f"{lab}_passrate": p / (p + f) if p + f else np.nan,
                    f"{lab}_days_to_pass": np.median(o[o[:, 0] == 1, 1]) if p else np.nan,
                    f"{lab}_days_to_fail": np.median(o[o[:, 0] == -1, 1]) if f else np.nan})
    return res

if __name__ == "__main__":
    rows = []
    for sym, setup, dr, kind in STRATS:
        d, S, day = data(sym, kind); all_days = np.unique(day)
        ict_ = kind == "ict"
        cfgs = [(1, em, sm, cap, tp, be) for em in ([5, 4] if ict_ else [4, 0]) for sm in ([3, 1] if ict_ else [1, 2]) for cap in CAPS for tp in TPS for be in BES]
        cfgs += [(0, em, 0, cap, tp, be) for em in ([5, 4] if ict_ else [4, 0]) for cap in CAPS for tp in TPS for be in BES]
        for mode, em, sm, cap, tp, be in cfgs:
            t = trades_for(sym, setup, dr, kind, mode, em, sm, cap, tp, be)
            rows.append(dict(symbol=sym, setup=setup, dir=dr, sizing="micros" if mode else "1 std contract", entry=EN[em],
                             stop=SMN[sm] if mode else f"${cap:.0f} fixed", risk=cap, TP=tp, BE=be, trades=len(t), avg_qty=t.qty.mean(), **eval_trades(t, all_days)))
        print(sym, setup, dr, "done", len(rows), file=sys.stderr)
    df = pd.DataFrame(rows); df.to_csv(f"results/eval_grid_{TAG}.csv", index=False); print(len(df), "configs")
