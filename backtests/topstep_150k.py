"""Topstep 150K Combine: $9,000 target, $4,500 max loss trailing end-of-day (stops trailing once it reaches the starting balance),
$3,000 daily loss limit (flattened and done for the day), 50% consistency, max 15 minis = 150 micros. A new Combine every trading day."""
import sys, itertools, numpy as np, pandas as pd
sys.path.insert(0, '.')
from topstep_static import tday
from portfolio_all import k_trades, fractal_trades, po3_trades, MM
TARGET, MLL, DLL, CONS, CAP = 9000, 4500, 3000, float(sys.argv[1]) if len(sys.argv) > 1 else 0.50, 150

def daily(T, risk, days):
    T = T.sort_values("entry_t"); busy = {"NQ": None, "GC": None}; out = {}
    mm = T.sym.map(MM).values; n = np.minimum(np.maximum(1, np.floor(risk / (T.stop_pts.values * mm))), CAP)
    usd = n * (T.pts.values * mm - 1.5)
    for k, r in enumerate(T.itertuples()):
        if busy[r.sym] is not None and r.entry_t < busy[r.sym]: continue
        if out.get(tday(r.entry_t), 0.0) <= -DLL: continue
        busy[r.sym] = r.exit_t; xd = tday(r.exit_t); out[xd] = max(out.get(xd, 0.0) + usd[k], -DLL)
    return np.array([out.get(x, 0.0) for x in days])

def combine(p, s):
    bal = best = 0.0; floor = -MLL
    for j in range(s, len(p)):
        v = p[j]; bal += v; best = max(best, v)
        if bal <= floor: return "fail", j
        if bal >= TARGET and best <= CONS * bal: return "pass", j
        floor = min(0.0, max(floor, bal - MLL))         # trails the end-of-day high, never above the starting balance
    return "open", len(p)

def stats(p, days):
    rows = [(r, j - s + 1) for s in range(len(p) - 20) for r, j in [combine(p, s)] if r != "open"]
    o = pd.DataFrame(rows, columns=["res", "d"]); ps = o[o.res == "pass"].d; fl = o[o.res == "fail"].d
    if not len(o): return None
    return dict(n=len(o), pass_pct=len(ps) / len(o), min=ps.min() if len(ps) else np.nan, p25=ps.quantile(.25) if len(ps) else np.nan,
                med=ps.median() if len(ps) else np.nan, p75=ps.quantile(.75) if len(ps) else np.nan, p90=ps.quantile(.9) if len(ps) else np.nan,
                longest=ps.max() if len(ps) else np.nan, within30=((o.res == "pass") & (o.d <= 30)).mean(), fail_med=fl.median() if len(fl) else np.nan)

K = k_trades(); FR = fractal_trades(); B2 = po3_trades("GC", "1h", "RB", "4h EMA20", "below open", "none", "candle close", "GC PO3 1h RB")
ALL = pd.concat([K, FR[FR.entry_t >= K.entry_t.min()], B2]); days = sorted({tday(x) for x in pd.concat([ALL.entry_t, ALL.exit_t])})
NAME = {"GC Fractal (flat daily)": "K8", "GC PO3 1h RB": "K9"}; names = sorted(ALL.strategy.unique())
rows = []
for k in range(1, len(names) + 1):
    for combo in itertools.combinations(names, k):
        T = ALL[ALL.strategy.isin(combo)]
        for risk in (500, 750, 1000, 1250, 1500):
            st = stats(daily(T, risk, days), days)
            if st: rows.append(dict(mix=" + ".join(NAME.get(x, x) for x in combo), risk=risk, **st))
R = pd.DataFrame(rows); R.to_csv(sys.argv[2] if len(sys.argv) > 2 else "results/topstep_150k_combos.csv", index=False)
R["key"] = R.mix.map(lambda s: " + ".join(sorted(s.split(" + "))))
pd.set_option("display.width", 250); pd.set_option("display.max_colwidth", 60)
print(f"consistency {CONS:.0%}; {len(names)} strategies; trading days {days[0]} .. {days[-1]}")
c = ["mix", "risk", "pass_pct", "within30", "min", "p25", "med", "p75", "p90", "longest", "fail_med"]
for m in ["K8 + K9 + K1 + K3 + K4 + K6 + K7", "K8 + K9 + K3 + K4 + K5 + K6 + K7", "K1 + K4 + K7"]:
    print(R[R.key == " + ".join(sorted(m.split(" + ")))][c].round(3).to_string(index=False)); print()
print("=== best pass rate per risk ===")
print(R.sort_values(["pass_pct", "med"], ascending=[False, True]).groupby("risk").head(3).sort_values(["risk", "pass_pct"], ascending=[True, False])[c].round(3).to_string(index=False))
print("\n=== fastest median with pass >= 80% ===")
print(R[R.pass_pct >= 0.8].sort_values(["med", "pass_pct"], ascending=[True, False]).head(8)[c].round(3).to_string(index=False))
