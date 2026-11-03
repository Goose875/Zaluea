"""Multi-strategy evaluation account, 30-day limit, $1k DLL (soft & hard), $2k static DD, $4k target, 55% consistency.
Streams (micros, sized to the same $ risk per trade): NQ NR7+EMA trend, GC NR7 breakout, ES ICT turtle soup, NQ ICT FVG trend.
Overlapping positions: each trade's worst open P&L includes the worst open P&L of all trades open at the same time.
Tuned on starts Jun 2024 - Sep 2025, reported on untouched starts Dec 2025 - Oct 2026."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd, itertools
from propeval import run_evals
import run_eval as R
from run_eval_portfolio import trades
STREAMS = {"NQ-NR7trend": ("NQ", "NR7 + EMA20/50 trend", "both", "nr", 4, 2), "GC-NR7": ("GC", "NR7 breakout", "both", "s2", 0, 1),
           "ES-turtle": ("ES", "ICT turtle soup PDH/PDL", "both", "ict", 4, 3), "NQ-FVG": ("NQ", "ICT FVG trend (no P/D filter)", "both", "ict", 4, 1)}
SETS = [("NQ-NR7trend",), ("NQ-NR7trend", "GC-NR7"), ("NQ-NR7trend", "GC-NR7", "ES-turtle"), ("NQ-NR7trend", "GC-NR7", "ES-turtle", "NQ-FVG")]

def combine(frames):
    t = pd.concat(frames, ignore_index=True).sort_values("t_out").reset_index(drop=True)
    tin, tout, mae = t.t_in.values, t.t_out.values, t.mae.values; adj = mae.copy()
    for i in range(len(t)):
        ov = (tin < tout[i]) & (tout > tin[i]); ov[i] = False; adj[i] += np.minimum(mae[ov], 0).sum()
    t["mae"] = adj; return t

def evaluate(t, max_days, dll, hard):
    t = t.sort_values(["exit_day", "entry_day"]).reset_index(drop=True); out = {}
    days = np.unique(np.r_[R.data("NQ", "nr")[2]])
    for lab, (a, b) in (("TUNE", ("2024-06-12", "2025-09-30")), ("TEST", ("2025-12-01", "2026-10-02"))):
        st = days[(days >= pd.Timestamp(a).toordinal()) & (days <= pd.Timestamp(b).toordinal())].astype(np.int64)
        o = run_evals(st, t.entry_day.values.astype(np.int64), t.exit_day.values.astype(np.int64), t.pnl.values, t.mae.values, max_days, 2000.0, 4000.0, 0.55, dll, hard)
        p, f = (o[:, 0] == 1).sum(), (o[:, 0] == -1).sum()
        out.update({f"{lab}_n": len(st), f"{lab}_pass": p, f"{lab}_fail": f, f"{lab}_fail_DLL": int(((o[:, 0] == -1) & (o[:, 4] == 2)).sum()),
                    f"{lab}_timeout": len(st) - p - f, f"{lab}_pass%": p / len(st), f"{lab}_fail%": f / len(st),
                    f"{lab}_days": np.median(o[o[:, 0] == 1, 1]) if p else np.nan})
    return out

if __name__ == "__main__":
    cache = {}
    rows = []
    for risk, tp, be in itertools.product((250.0, 375.0, 500.0, 625.0, 750.0), (1000.0, 1500.0, 2000.0, 2500.0, 3000.0), (0.0, 500.0, 750.0)):
        fr = {}
        for name, (sym, st, dr, kind, em, sm) in STREAMS.items():
            k = (name, risk, tp, be)
            if k not in cache: cache[k] = trades(sym, st, dr, kind, em, sm, risk, tp, be).assign(stream=name)
            fr[name] = cache[k]
        for sset in SETS:
            t = combine([fr[s] for s in sset])
            for dll_mode in ("none", "soft", "hard"):
                dll = 0.0 if dll_mode == "none" else 1000.0
                rows.append(dict(streams=" + ".join(sset), risk=risk, TP=tp, BE=be, DLL=dll_mode, trades_per_month=len(t) / 29.0,
                                 **evaluate(t, 30, dll, dll_mode == "hard")))
    df = pd.DataFrame(rows); df.to_csv("results/eval_multi_30d.csv", index=False)
    df["score"] = df["TUNE_pass%"] - df["TUNE_fail%"]
    pd.set_option("display.width", 340); pd.set_option("display.max_colwidth", 60)
    c = ["streams", "risk", "TP", "BE", "trades_per_month", "TUNE_pass%", "TUNE_fail%", "TEST_n", "TEST_pass", "TEST_fail", "TEST_fail_DLL", "TEST_timeout", "TEST_pass%", "TEST_fail%", "TEST_days"]
    for mode in ("none", "soft", "hard"):
        x = df[df.DLL == mode]
        print(f"\n######## DLL={mode}: best config per stream-set, chosen on TUNE (pass% - fail%) ########")
        print(x.sort_values("score", ascending=False).groupby("streams").head(1)[c].round(2).to_string(index=False))
        print(f"  best by TUNE pass% only:"); print(x.sort_values("TUNE_pass%", ascending=False).groupby("streams").head(1)[c].round(2).to_string(index=False))
