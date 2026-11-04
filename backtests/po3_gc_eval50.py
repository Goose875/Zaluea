"""GC futures 15-minute PO3 (rejection block + FVG midpoint, all 56 versions each) on a 50K static evaluation:
  $4,000 profit target, $2,000 STATIC drawdown (fail at $48,000), soft $1,000 daily loss limit (no more trades that day once
  the day is down $1,000), 55% consistency (best day must be <= 55% of total profit; if not, keep trading until it is).
Sizing in MGC micros ($10/pt, $0.75/side): contracts = floor(risk / (stop x $10)), at least 1. Risk $250 / $500 / $750 per trade.
An account is started on every trading day; outcome = pass / fail / not finished (data ran out).
    python3 po3_gc_eval50.py -> results/po3_gc_eval50.csv"""
import itertools, numpy as np, pandas as pd, warnings
warnings.filterwarnings("ignore")
from common import SPECS
from precise import load_1m, simulate
import po3
TICK = SPECS["GC"]["tick"]
d, _ = load_1m("GC", "5m"); d = d.copy(); d["i"] = np.arange(len(d)); d["t"] = d.index; CTX = po3.build(d, "15min")

def trades(model, bias, edge, tgt, hold):
    dd, C, T = CTX; od = po3.orders_for(dd, C, T, model, bias, edge, TICK)
    if hold == "16:09 flat": od["end"] = -1
    tg = {"none": 0 * od.stop, "3R": 3 * od.stop, "2R": 2 * od.stop, "prev 4h extreme": od.prevext.where(od.prevext > od.stop * 0.5, 2 * od.stop)}[tgt].values
    t = simulate(dd, "GC", od, od.stop.values, tg, 0.0, 99)
    t["pts"] = (t.pnl + 5.0) / 100.0; t["stop_pts"] = ((t.pnl / t.R) / 100.0).where(t.R != 0, od.stop.mean()); return t

def mgc_pnl(t, risk):
    n = np.maximum(1, np.floor(risk / (t.stop_pts * 10.0))); return n * (t.pts * 10.0 - 1.5)

def evaluate(t, risk, target=4000.0, dd=2000.0, dll=1000.0, cons=0.55):
    t = t.sort_values("time").assign(usd=mgc_pnl(t, risk)); days = sorted(d["day"].unique()); out = []
    for s in days[:-1]:
        bal, best, nd, res = 0.0, 0.0, 0, "not finished"
        for dday in [x for x in days if x >= s]:
            nd += 1; g = t[t.day == dday]; day_pnl = 0.0
            for u in g.usd:
                if day_pnl <= -dll: break                          # soft DLL: done for the day
                day_pnl += u
                if bal + day_pnl <= -dd: break                     # static floor
            bal += day_pnl; best = max(best, day_pnl)
            if bal <= -dd: res = "fail"; break
            if bal >= target and best <= cons * bal: res = "pass"; break
        out.append((res, nd))
    o = pd.DataFrame(out, columns=["res", "days"]); fin = o[o.res != "not finished"]
    return dict(starts=len(o), finished=len(fin), pass_pct_of_finished=(fin.res == "pass").mean() if len(fin) else np.nan,
                fail_pct_of_finished=(fin.res == "fail").mean() if len(fin) else np.nan, median_days_to_pass=o[o.res == "pass"].days.median(),
                fastest=o[o.res == "pass"].days.min(), pass_within_30d=((o.res == "pass") & (o.days <= 30)).sum() / len(o))

rows = []
for model, bias, edge, (tgt, hold) in itertools.product(("RB", "FVG CE"), ("none", "prev 4h colour", "4h EMA20", "vs 18:00 open"), ("below open", "swept prev 4h extreme"),
                                                        [(a, b) for a in ("2R", "3R", "prev 4h extreme", "none") for b in ("candle close", "16:09 flat") if not (a == "none" and b == "16:09 flat")]):
    t = trades(model, bias, edge, tgt, hold)
    if len(t) < 10: continue
    for risk in (250, 500, 750):
        rows.append(dict(entry=model, bias=bias, manipulation=edge, target=tgt, exit=hold, trades=len(t), avgR=t.R.mean(), risk=risk, **evaluate(t, risk)))
R = pd.DataFrame(rows); R.to_csv("results/po3_gc_eval50.csv", index=False)
pd.set_option("display.width", 300)
print(R.groupby(["entry", "risk"]).agg(versions=("avgR", "size"), median_pass=("pass_pct_of_finished", "median"), median_fail=("fail_pct_of_finished", "median"),
                                       median_days=("median_days_to_pass", "median"), median_pass_30d=("pass_within_30d", "median")).round(2).to_string())
A1 = R[(R.entry == "RB") & (R.bias == "vs 18:00 open") & (R.manipulation == "below open") & (R.target == "3R") & (R.exit == "candle close")]
print("\nA1 (the version that passed every check):"); print(A1.drop(columns=["entry", "bias", "manipulation", "target", "exit"]).round(2).to_string(index=False))
print("\nTop 10 by pass rate (>= 30 trades):"); print(R[R.trades >= 30].sort_values(["pass_pct_of_finished", "median_days_to_pass"], ascending=[False, True]).head(10).round(2).to_string(index=False))
