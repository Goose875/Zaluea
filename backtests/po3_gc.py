"""Deeper tests of the gold (GC) PO3 setups found in po3.py. The candidates are fixed up front (no re-optimising):
  B1  1h model, 2.4 years: FVG midpoint (CE), bias = previous 4h candle colour, manipulation below the open, exit at the 4h close
  B2  1h model, 2.4 years: rejection block, bias = 4h EMA20, manipulation below the open, exit at the 4h close
  A1  15m model, 10 weeks: rejection block, bias = vs 18:00 open, manipulation below the open, 3R target, exit at the 4h close
  A2  15m model, 10 weeks: FVG CE, no bias, manipulation below the open, target previous 4h extreme, flat by 16:09
Tests: each 4h candle on its own, longs vs shorts, by quarter, manipulation threshold and entry window changes, double costs,
same orders with the direction flipped (does the PO3 direction matter?), and a Topstep 150K evaluation from every start day.
    python3 po3_gc.py  -> results/po3_gc_*.csv"""
import numpy as np, pandas as pd, warnings
warnings.filterwarnings("ignore")
from common import SPECS
from precise import load_1m, simulate
import po3

SYM = "GC"; sp = SPECS[SYM]
CANDS = {"B1": ("1h", "60min", "FVG CE", "prev 4h colour", "below open", "none", "candle close"),
         "B2": ("1h", "60min", "RB", "4h EMA20", "below open", "none", "candle close"),
         "A1": ("5m", "15min", "RB", "vs 18:00 open", "below open", "3R", "candle close"),
         "A2": ("5m", "15min", "FVG CE", "none", "below open", "prev 4h extreme", "16:09 flat")}
DATA = {}
def ctx(tf, trig):
    if tf not in DATA:
        d, src = load_1m(SYM, tf); d = d.copy(); d["i"] = np.arange(len(d)); d["t"] = d.index; d, C, T = po3.build(d, trig)
        cap = d["day"].map(d[d["mod"] == 900].groupby("day").i.last()) if tf == "1h" else None
        DATA[tf] = (d, C, T, cap, src)
    return DATA[tf]

def trades(key, flip=False, extra_cost=0.0, **kw):
    tf, trig, model, bias, edge, tgt, hold = CANDS[key]; d, C, T, cap, _ = ctx(tf, trig)
    od = po3.orders_for(d, C, T, model, bias, edge, sp["tick"], **kw)
    if not len(od): return pd.DataFrame(columns=["R", "pnl", "side", "day", "time"])
    if tf == "1h":                                            # 1h bars: flat by 16:00
        c_ = cap.values[od.i.clip(upper=len(d) - 1).values]; od["end"] = np.where(np.isnan(c_), od.end, np.minimum(od.end, np.nan_to_num(c_, nan=1e18))).astype(np.int64)
        if hold == "16:09 flat": od["end"] = pd.Series(c_).fillna(-1).astype(np.int64).values
    elif hold == "16:09 flat": od["end"] = -1
    tg = {"none": 0 * od.stop, "3R": 3 * od.stop, "2R": 2 * od.stop, "prev 4h extreme": od.prevext.where(od.prevext > od.stop * 0.5, 2 * od.stop)}[tgt].values
    if flip:                                                   # same moment, opposite direction, market entry, same stop / target size
        od = od.assign(side=-od.side, type=0, px=0.0)
    t = simulate(d, SYM, od, od.stop.values, tg, 0.0, 99)
    if extra_cost:
        risk_usd = t.pnl / t.R.replace(0, np.nan); t["pnl"] = t.pnl - extra_cost; t["R"] = t.pnl / risk_usd
    t["hour"] = t.time.dt.hour; return t

def summ(t, **k):
    return dict(**k, n=len(t), win=(t.pnl > 0).mean() if len(t) else np.nan, avgR=t.R.mean() if len(t) else np.nan,
                pf=t.pnl[t.pnl > 0].sum() / max(1e-9, -t.pnl[t.pnl < 0].sum()) if len(t) else np.nan, totalR=t.R.sum() if len(t) else 0)

rows = []
for key in CANDS:
    base = trades(key); rows.append(summ(base, cand=key, test="base"))
    rows.append(summ(trades(key, extra_cost=2 * 2.5 + 2 * sp["tick"] * sp["mult"]), cand=key, test="double costs (+$25 per trade)"))
    rows.append(summ(trades(key, flip=True), cand=key, test="direction flipped (control)"))
    for s, nm in ((1, "longs only"), (-1, "shorts only")): rows.append(summ(base[base.side == s], cand=key, test=nm))
    for hr in (18, 22, 2, 6, 10, 14): rows.append(summ(base[base.time.apply(lambda x: ((x.hour - 18) % 24) // 4 * 4 + 18) % 24 == hr], cand=key, test=f"4h candle {hr:02d}:00"))
    for th in (0.05, 0.2, 0.3): rows.append(summ(trades(key, thr=th), cand=key, test=f"manipulation >= {th} ATR"))
    for w in ((2.0, 3.5) if key.startswith("B") else (2.0, 2.5, 3.5)): rows.append(summ(trades(key, window_h=w), cand=key, test=f"entry window {w}h"))
    if key.startswith("B"):
        q = base.time.dt.tz_localize(None).dt.to_period("Q")
        for p, g in base.groupby(q): rows.append(summ(g, cand=key, test=f"quarter {p}"))
R = pd.DataFrame(rows); R.to_csv("results/po3_gc_tests.csv", index=False)
pd.set_option("display.width", 250); pd.set_option("display.max_rows", 300); print(R.round(3).to_string(index=False))

# Topstep 150K evaluation: $9,000 target, $4,500 trailing drawdown (end of day), $750 risk per trade (MGC micros: $10/pt)
def evals(t, risk=750.0):
    t = t.sort_values("time"); days = sorted(t.day.unique()); out = []
    for s in days[: max(1, len(days) - 20)]:
        sub = t[t.day >= s]; bal, peak, res, nd = 0.0, 0.0, "neither", 0
        for dday, g in sub.groupby("day", sort=True):
            nd += 1; bal += (g.R * risk).sum()
            if bal >= 9000: res = "pass"; break
            if bal <= peak - 4500: res = "fail"; break
            peak = max(peak, bal)
        out.append((res, nd))
    o = pd.DataFrame(out, columns=["res", "days"]); return dict(pass_pct=(o.res == "pass").mean(), fail_pct=(o.res == "fail").mean(),
                                                                 median_trading_days_to_pass=o[o.res == "pass"].days.median(), starts=len(o))
E = pd.DataFrame([dict(cand=k, **evals(trades(k))) for k in ("B1", "B2")]); E.to_csv("results/po3_gc_eval150.csv", index=False); print(); print(E.round(3).to_string(index=False))
print({k: ctx(v[0], v[1])[4] for k, v in CANDS.items()})
