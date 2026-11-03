"""Greedy multi-stream portfolio for the 30-day / soft-$1k-DLL evaluation (70% pass target).
Pool = top single configs by TUNE (pass% - fail%) with >= 3 trades/month, max 3 per (symbol, setup).
Rules inside the account: one open position per market at a time (later overlapping signals in the same market are skipped);
positions in different markets may overlap - their worst open losses are summed (conservative) for DD and DLL."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd, sys
import run_eval as R
from run_eval70 import run_one, to_trades, evaluate, QTY
from propeval import run_evals
from common import SPECS
EN_INV = {v: k for k, v in R.EN.items()}
df = pd.read_csv("results/eval70_single.csv"); df["score"] = df["TUNE_pass%"] - df["TUNE_fail%"]
pool = df[df.trades_per_month >= 3].sort_values("score", ascending=False).groupby(["symbol", "setup"]).head(3).head(40).reset_index(drop=True)

def build(row):
    kind = "ict" if (row.setup.startswith("ICT") or row.setup.startswith("Levels")) else ("nr" if row.setup in R.data(row.symbol, "nr")[1] and row.setup != "NR7" else "s2")
    d, S_, day = R.data(row.symbol, kind); L, Sh, lim, stp = S_[row.setup]
    if row.dir == "long": Sh = np.zeros_like(Sh)
    if row.size == "micros≤$500": mode, mult, comm, sm = 1, R.MICRO[row.symbol], 0.75, (3 if kind == "ict" else 1)
    else: mode, sm = 0, 0; _, mult, comm = [q for q in QTY[row.symbol] if q[0] == row.size][0]
    r = run_one(d, L, Sh, lim, stp, EN_INV[row.entry], sm, mode, mult, comm, row.symbol, row.BE, row.trail_act, row.trail)
    return to_trades(r, d, day).assign(sym=row.symbol)

def combine(frames):
    t = pd.concat(frames, ignore_index=True).sort_values("t_in").reset_index(drop=True)
    keep = np.ones(len(t), bool); busy = {}
    for i, r in t.iterrows():                      # one position per market at a time
        if r.sym in busy and r.t_in < busy[r.sym]: keep[i] = False; continue
        busy[r.sym] = r.t_out
    t = t[keep].sort_values("t_out").reset_index(drop=True)
    tin, tout, mae, sym = t.t_in.values, t.t_out.values, t.mae.values, t.sym.values; adj = mae.copy()
    for i in range(len(t)):
        ov = (tin < tout[i]) & (tout > tin[i]) & (sym != sym[i]); adj[i] += np.minimum(mae[ov], 0).sum()
    t["mae"] = adj; return t

days = np.unique(R.data("NQ", "nr")[2])
trades = [build(r) for r in pool.itertuples()]
chosen = []; cur = None; best_score = -1; log = []
for step in range(6):
    cand = []
    for j in range(len(pool)):
        if j in chosen: continue
        t = combine([trades[k] for k in chosen + [j]]); e = evaluate(t, days)
        cand.append((e["TUNE_pass%"] - e["TUNE_fail%"], j, e, len(t)))
    sc, j, e, n = max(cand, key=lambda x: x[0])
    if sc <= best_score: break
    best_score = sc; chosen.append(j)
    p = pool.iloc[j]
    log.append(dict(step=step + 1, added=f"{p.symbol} {p.setup} ({p.dir}) | {p.entry} | {p['size']} | BE {p.BE:g} | trail {p.trail_act:g}/{p.trail:g}",
                    trades_per_month=n / 29.0, **e))
    print(log[-1], file=sys.stderr)
L = pd.DataFrame(log); L.to_csv("results/eval70_portfolio.csv", index=False)
pd.set_option("display.width", 330); pd.set_option("display.max_colwidth", 110)
print(L.round(3).to_string(index=False))
