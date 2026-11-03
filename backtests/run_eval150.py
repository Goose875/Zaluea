"""150k evaluation search: $9k target, soft $3k DLL, static max drawdown $4.5k (also checked at $3k), 55% consistency.
Goal: highest pass rate in the shortest time -> primary score = pass% - fail% within 30 days (TUNE starts only).
Streams: new frequency setups (overnight hold, opening drive) + best families from earlier rounds, all on micros sized to $ risk.
TUNE starts Jun 2024 - Sep 2025, TEST starts Dec 2025 - Oct 2026 (untouched)."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd, itertools, sys
from engine7 import engine7
from propeval import run_evals
import run_eval as R
from setups_new import new_setups, TIME_EXIT
from common import SPECS
RULES = dict(dd=4500.0, target=9000.0, consist=0.55, dll=3000.0)
TUNE = ("2024-06-12", "2025-09-30"); TEST = ("2025-12-01", "2026-10-02")
RISK = [500.0, 750.0, 1000.0, 1500.0]; TP = [1500.0, 2500.0, 4000.0, 1e9]
STREAMS = [(s, "new", n, "both", 0, sm) for s in ("NQ", "ES", "GC") for n in ("Overnight long", "Overnight long + daily regime",
           "Overnight long/short by daily regime", "Opening drive", "Opening drive + daily regime") for sm in (1, 2)]
STREAMS += [("NQ", "nr", "NR7 + EMA20/50 trend", "both", 4, 2), ("NQ", "nr", "NR7 + above/below EMA200", "both", 0, 1),
            ("GC", "s2", "NR7 breakout", "both", 0, 1), ("GC", "nr", "NR10", "long", 0, 1), ("NQ", "ict", "ICT FVG trend (no P/D filter)", "both", 4, 1),
            ("ES", "ict", "ICT turtle soup PDH/PDL", "both", 4, 3), ("GC", "s2", "RSI14 50-cross with trend", "long", 4, 1)]
_new = {}
def get(sym, kind):
    if kind != "new": return R.data(sym, kind)
    if sym not in _new:
        d, _, day = R.data(sym, "nr"); nan = np.full(len(d), np.nan)
        _new[sym] = (d, {k: (L, S, nan, nan) for k, (L, S) in new_setups(d, sym).items()}, day)
    return _new[sym]

def trades(sym, kind, setup, dr, em, sm, risk, tp, be, ta, tr):
    d, S_, day = get(sym, kind); L, Sh, lim, stp = S_[setup]; sp = SPECS[sym]
    if dr == "long": Sh = np.zeros_like(Sh)
    r = engine7(d.Open.values, d.High.values, d.Low.values, d.Close.values, d.atr.values.astype(float), d.sess_id.values.astype(np.int64),
                L, Sh, lim, stp, em, sm, 1, risk, risk, tp, be, sp["tick"], float(sp["mult"]), sp["comm"], R.MICRO[sym], 0.75, ta, tr,
                TIME_EXIT.get(setup, 0))
    return pd.DataFrame(dict(t_in=d.index[np.minimum(r[:, 0].astype(int) + 1, len(d) - 1)], t_out=d.index[r[:, 8].astype(int)],
                             entry_day=day[r[:, 0].astype(int)], exit_day=day[r[:, 8].astype(int)], pnl=r[:, 2], mae=r[:, 7], sym=sym))

DAYS = None
def evaluate(t, max_days=30, dd=None):
    global DAYS
    if DAYS is None: DAYS = np.unique(R.data("NQ", "nr")[2])
    t = t.sort_values(["exit_day", "entry_day"]).reset_index(drop=True); out = {}
    for lab, (a, b) in (("TUNE", TUNE), ("TEST", TEST)):
        st = DAYS[(DAYS >= pd.Timestamp(a).toordinal()) & (DAYS <= pd.Timestamp(b).toordinal())].astype(np.int64)
        o = run_evals(st, t.entry_day.values.astype(np.int64), t.exit_day.values.astype(np.int64), t.pnl.values, t.mae.values, max_days,
                      dd or RULES["dd"], RULES["target"], RULES["consist"], RULES["dll"], False)
        p, f = (o[:, 0] == 1).sum(), (o[:, 0] == -1).sum()
        out.update({f"{lab}_pass%": p / len(st), f"{lab}_fail%": f / len(st), f"{lab}_days": np.median(o[o[:, 0] == 1, 1]) if p else np.nan})
    return out

def combine(frames):
    t = pd.concat(frames, ignore_index=True).sort_values("t_in").reset_index(drop=True)
    keep = np.ones(len(t), bool); busy = {}
    for i, (s, a, b) in enumerate(zip(t.sym.values, t.t_in.values, t.t_out.values)):
        if s in busy and a < busy[s]: keep[i] = False; continue
        busy[s] = b
    t = t[keep].sort_values("t_out").reset_index(drop=True)
    tin, tout, mae, sym = t.t_in.values, t.t_out.values, t.mae.values, t.sym.values; adj = mae.copy()
    for i in range(len(t)):
        ov = (tin < tout[i]) & (tout > tin[i]) & (sym != sym[i]); adj[i] += np.minimum(mae[ov], 0).sum()
    t["mae"] = adj; return t

if __name__ == "__main__":
    rows, cache = [], {}
    for (sym, kind, setup, dr, em, sm) in STREAMS:
        for risk, tp, be, trl in itertools.product(RISK, TP, (0, 1), (0, 1)):
            ta, tr = (2 * risk, risk) if trl else (0.0, 0.0)
            t = trades(sym, kind, setup, dr, em, sm, risk, tp, risk if be else 0.0, ta, tr)
            if len(t) < 30: continue
            k = len(rows); cache[k] = t
            rows.append(dict(id=k, symbol=sym, setup=setup, dir=dr, entry=R.EN[em], stop=R.SMN.get(sm, "signal bar"), risk=risk,
                             TP=("none" if tp > 1e8 else f"${tp:,.0f}"), BE=("at +1R" if be else "off"), trail=("2R act, 1R trail" if trl else "off"),
                             trades_month=len(t) / 29.0, win=(t.pnl > 0).mean(), avg=t.pnl.mean(), **evaluate(t)))
        print(sym, setup, len(rows), file=sys.stderr)
    df = pd.DataFrame(rows); df["score"] = df["TUNE_pass%"] - df["TUNE_fail%"]; df.to_csv("results/eval150_single.csv", index=False)
    pd.set_option("display.width", 340); pd.set_option("display.max_colwidth", 40)
    c = ["symbol", "setup", "dir", "stop", "risk", "TP", "BE", "trail", "trades_month", "win", "avg", "TUNE_pass%", "TUNE_fail%", "TUNE_days", "TEST_pass%", "TEST_fail%", "TEST_days"]
    print("=== top single streams by TUNE score (30-day window) ==="); print(df.sort_values("score", ascending=False).head(20)[c].round(2).to_string(index=False))
    # ---- greedy portfolio on TUNE ----
    pool = df[df.trades_month >= 2].sort_values("score", ascending=False).groupby(["symbol", "setup"]).head(2).head(40)
    chosen, best, log = [], -9, []
    for step in range(6):
        cand = []
        for k in pool.id:
            if k in chosen: continue
            e = evaluate(combine([cache[x] for x in chosen + [k]])); cand.append((e["TUNE_pass%"] - e["TUNE_fail%"], k, e))
        sc, k, e = max(cand, key=lambda x: x[0])
        if sc <= best + 0.005: break
        best = sc; chosen.append(k); r = df.loc[k]
        log.append(dict(step=step + 1, added=f"{r.symbol} {r.setup} ({r.dir}) | {r.stop} | risk ${r.risk:,.0f} | TP {r.TP} | BE {r.BE} | trail {r.trail}", **e))
    L = pd.DataFrame(log); L.to_csv("results/eval150_portfolio.csv", index=False)
    pd.set_option("display.max_colwidth", 120); print("\n=== greedy portfolio (chosen on TUNE, 30-day window) ==="); print(L.round(2).to_string(index=False))
    T = combine([cache[x] for x in chosen]); T.to_csv("results/eval150_portfolio_trades.csv", index=False)
    print("\nFinal portfolio trades/month:", round(len(T) / 29.0, 1))
    for lab, md, dd in (("30 days, DD $4.5k", 30, 4500.0), ("no time limit, DD $4.5k", 0, 4500.0), ("30 days, DD $3k", 30, 3000.0), ("no time limit, DD $3k", 0, 3000.0)):
        print(f"  {lab:24s}", {k: round(v, 3) for k, v in evaluate(T, md, dd).items()})
