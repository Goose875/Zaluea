"""Run every precise strategy (own + NinjaTrader ports) on 1-minute data for NQ, ES, GC with a management grid,
walk-forward split by trading day (first 60% TRAIN, next 20% VALID, last 20% TEST) and random-entry luck controls.
    python3 precise_run.py            -> results/precise_variants.csv.gz, results/precise_best.csv"""
import sys, itertools, numpy as np, pandas as pd, warnings
warnings.filterwarnings("ignore")
from common import SPECS
from precise import load_1m, simulate
import precise_strats
try: import precise_nt          # NinjaTrader User App Share ports (optional)
except ImportError: precise_nt = None

USD_STOPS = (250, 500, 750)              # risk per mini contract, in dollars
TGT_R, BE, PER_DAY = (1, 1.5, 2, 3, 0), (0, 1), (1, 2)

def split(t, days):
    a, b = days[int(len(days) * 0.6)], days[int(len(days) * 0.8)]
    return t[t.day < a], t[(t.day >= a) & (t.day < b)], t[t.day >= b]

def stats(t, pre=""):
    if not len(t): return {f"{pre}n": 0, f"{pre}avgR": np.nan}
    return {f"{pre}n": len(t), f"{pre}avgR": t.R.mean()}

def main(syms):
    rows, best = [], []
    for sym in syms:
        d, src = load_1m(sym); sp = SPECS[sym]; days = sorted(d["day"].unique())
        S = precise_strats.strategies(d, sym, sp["tick"])
        if precise_nt: S.update(precise_nt.strategies(d, sym, sp["tick"]))
        print(f"{sym}: {src}, {len(days)} days, {len(S)} strategies", flush=True)
        for name, od in S.items():
            if not len(od): continue
            for usd, tr, be, pd_ in itertools.product(USD_STOPS, TGT_R, BE, PER_DAY):
                stop = usd / sp["mult"]; t = simulate(d, sym, od, stop, tr * stop, be, pd_)
                a, b, c = split(t, days)
                r = dict(symbol=sym, data=src, strategy=name, stop_usd=usd, stop_pts=stop, target=f"{tr}R" if tr else "none (16:09)", be=be, per_day=pd_,
                         n=len(t), avgR=t.R.mean() if len(t) else np.nan, win=(t.pnl > 0).mean() if len(t) else np.nan,
                         usd_per_trade=t.pnl.mean() if len(t) else np.nan, **stats(a, "TR_"), **stats(b, "VA_"), **stats(c, "TE_"))
                rows.append(r)
        V = pd.DataFrame([r for r in rows if r["symbol"] == sym])
        # pick each strategy's management on TRAIN+VALID only, then look at TEST, and compare with random entries
        V["sc"] = V[["TR_avgR", "VA_avgR"]].min(axis=1).where((V.TR_n >= 15) & (V.VA_n >= 5))
        for name, g in V.groupby("strategy"):
            if g.sc.isna().all(): continue
            r = g.loc[g.sc.idxmax()].to_dict(); od = S[name]
            t = simulate(d, sym, od, r["stop_pts"], (0 if r["target"].startswith("none") else float(r["target"][:-1])) * r["stop_pts"], r["be"], r["per_day"])
            _, _, te = split(t, days); nL, nS = int((te.side > 0).sum()), int((te.side < 0).sum()); rnd = []
            dte = d[d["day"] >= days[int(len(days) * 0.8)]]; off = len(d) - len(dte)
            for s in range(100):
                ro = precise_strats.random_orders(dte, nL, nS, s); ro["i"] += off
                rt = simulate(d, sym, ro, r["stop_pts"], (0 if r["target"].startswith("none") else float(r["target"][:-1])) * r["stop_pts"], r["be"], 1)
                rnd.append(rt.R.mean() if len(rt) else np.nan)
            r["TE_random_median"] = np.nanmedian(rnd); r["TE_beats_random_pct"] = np.nanmean(np.array(rnd) < r["TE_avgR"]) if r["TE_n"] else np.nan
            r["plateau"] = (g.sc > 0).mean(); best.append(r)
    pd.DataFrame(rows).to_csv("results/precise_variants.csv.gz", index=False)
    B = pd.DataFrame(best).drop(columns=["sc"]).sort_values("TE_avgR", ascending=False); B.to_csv("results/precise_best.csv", index=False)
    pd.set_option("display.width", 320); pd.set_option("display.max_rows", 400)
    print(B[["symbol", "strategy", "stop_usd", "target", "be", "per_day", "n", "win", "TR_avgR", "VA_avgR", "TE_n", "TE_avgR", "TE_random_median", "TE_beats_random_pct", "plateau"]].round(3).to_string(index=False))

if __name__ == "__main__":
    main(sys.argv[1:] or ["NQ", "ES", "GC"])
