"""LucidPro 50K evaluation: which mix of our NQ / GC strategies passes fastest and most often.
Rules (per third-party summaries of Lucid's rules, Oct 2026 - confirm on Lucid's site):
  $3,000 profit target; $2,000 max loss, END-OF-DAY trailing (floor = highest end-of-day balance - $2,000);
  daily loss limit $1,200 when switched on (day stops, account not failed); no consistency rule in the evaluation;
  no time limit; 4 minis / 40 micros. Same strategies, sizing and netting as topstep_static.py; a new evaluation every trading day.
    SCRATCH=<dir> python3 lucid_pro.py -> results/lucid_pro_combos.csv, results/lucid_pro_oos.csv"""
import itertools, numpy as np, pandas as pd, warnings, sys
warnings.filterwarnings("ignore")
from portfolio_all import k_trades, fractal_trades, po3_trades, MM
from topstep_static import tday

def daily_series(T, risk, days, dll):
    T = T.sort_values("entry_t"); busy = {"NQ": None, "GC": None}; out = {}
    mm = T.sym.map(MM).values; n = np.maximum(1, np.floor(risk / (T.stop_pts.values * mm))); n = np.minimum(n, 40)
    usd = n * (T.pts.values * mm - 1.5)
    for k, r in enumerate(T.itertuples()):
        if busy[r.sym] is not None and r.entry_t < busy[r.sym]: continue
        if dll and out.get(tday(r.entry_t), 0.0) <= -dll: continue
        busy[r.sym] = r.exit_t; xd = tday(r.exit_t); v = out.get(xd, 0.0) + usd[k]; out[xd] = max(v, -dll) if dll else v
    return np.array([out.get(x, 0.0) for x in days])

def evaluate(pnl, horizon=None):
    rows = []
    for s in range(0, len(pnl) - 20):
        bal = peak = 0.0; res = "open"; j = s
        for j in range(s, len(pnl) if horizon is None else min(len(pnl), s + horizon)):
            bal += pnl[j]
            if bal <= peak - 2000: res = "fail"; break
            if bal >= 3000: res = "pass"; break
            peak = max(peak, bal)
        if res != "open": rows.append((res, j - s + 1))
    o = pd.DataFrame(rows, columns=["res", "days"])
    if not len(o): return {}
    p = o[o.res == "pass"]
    return dict(finished=len(o), pass_pct=len(p) / len(o), median_days_to_pass=p.days.median() if len(p) else np.nan,
                pass_within_10d=((o.res == "pass") & (o.days <= 10)).mean(), pass_within_20d=((o.res == "pass") & (o.days <= 20)).mean())

if __name__ == "__main__":
    K = k_trades(); FR = fractal_trades(); B2 = po3_trades("GC", "1h", "RB", "4h EMA20", "below open", "none", "candle close", "GC PO3 1h RB")
    ALL = pd.concat([K, FR[FR.entry_t >= K.entry_t.min()], B2]); ALL["strategy"] = ALL.strategy.replace({"GC Fractal (flat daily)": "K8", "GC PO3 1h RB": "K9"})
    names = sorted(ALL.strategy.unique()); days = sorted({tday(x) for x in pd.concat([ALL.entry_t, ALL.exit_t])})
    cut = [i for i, d in enumerate(days) if str(d) >= "2025-12-01"][0]
    rows = []
    for k in range(1, len(names) + 1):
        for combo in itertools.combinations(names, k):
            T = ALL[ALL.strategy.isin(combo)]
            for risk in (250, 350, 500, 750):
                for dll in (1200, 0):
                    pnl = daily_series(T, risk, days, dll)
                    full, oos = evaluate(pnl), evaluate(pnl[cut:])
                    if full and oos:
                        rows.append(dict(strategies=" + ".join(combo), n=k, risk=risk, dll="on $1,200" if dll else "off", **full,
                                         **{"oos_" + a: b for a, b in oos.items()}))
        print(f"{k}-strategy combos done", file=sys.stderr, flush=True)
    R = pd.DataFrame(rows); R.to_csv("results/lucid_pro_combos.csv", index=False)
    R["score"] = R[["pass_pct", "oos_pass_pct"]].min(axis=1)
    pd.set_option("display.width", 300); pd.set_option("display.max_colwidth", 60)
    c = ["strategies", "risk", "dll", "pass_pct", "median_days_to_pass", "pass_within_10d", "oos_pass_pct", "oos_median_days_to_pass", "oos_pass_within_10d"]
    for dll in ("on $1,200", "off"):
        S = R[R.dll == dll]
        print(f"\n=== DLL {dll}: safest (pass rate on all data and on the last year) ==="); print(S.sort_values(["score", "oos_median_days_to_pass"], ascending=[False, True]).head(10)[c].round(2).to_string(index=False))
        print(f"\n=== DLL {dll}: fastest among those passing >= 85% in both ==="); print(S[(S.pass_pct >= .85) & (S.oos_pass_pct >= .85)].sort_values("oos_median_days_to_pass").head(10)[c].round(2).to_string(index=False))
    rec = R[(R.strategies == "K1 + K3 + K4 + K5 + K6 + K7")]
    print("\n=== the Topstep recommended mix on Lucid ==="); print(rec[c].round(2).to_string(index=False))
    R.sort_values("score", ascending=False).head(60).to_csv("results/lucid_pro_best.csv", index=False)
