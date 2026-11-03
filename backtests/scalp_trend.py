"""Trend-following micro-scalping with a daily profit goal.
Data: continuous front month, regular hours (NQ/ES 09:30-16:00, GC 08:20-13:30).
  1m: Oct 6 - Nov 2 2026 (20 sessions)  -> TUNE first 12 sessions, TEST last 8
  5m: Aug 25 - Nov 2 2026 (49 sessions) -> TUNE to Oct 9, TEST Oct 10 - Nov 2
Trade: fixed $ bracket (target $100-300, stop 0.5-2x target) on 1 standard or N micro contracts, time stop, flat at session end.
Daily rules: stop trading for the day once day P&L >= +$1,500 (goal) or <= -daily_stop.
Fills: market entry next bar open +1 tick; target needs 1-tick trade-through; stop -1 tick; stop wins ties; $2.50/std or $0.75/micro per side."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd, itertools, sys
from engine8 import engine8
from rmultiple import finish
from common import load, ema, SPECS
SESS = {"NQ": (570, 960), "ES": (570, 960), "GC": (500, 810)}
SIZES = {"NQ": [("1 NQ", 20.0, 2.5), ("2 MNQ", 4.0, 1.5), ("5 MNQ", 10.0, 3.75), ("10 MNQ", 20.0, 7.5)],
         "ES": [("1 ES", 50.0, 2.5), ("4 MES", 20.0, 3.0), ("10 MES", 50.0, 7.5)],
         "GC": [("1 GC", 100.0, 2.5), ("5 MGC", 50.0, 3.75), ("10 MGC", 100.0, 7.5)]}
SPLIT = {"1m": "2026-10-21", "5m": "2026-10-09"}

def prep(sym, tf):
    d = load(f"{sym}_cont_{tf}.csv", tz=True); d = d[d.index < "2026-11-03"]
    m = d.index.hour * 60 + d.index.minute; o0, c0 = SESS[sym]
    d = d[(m >= o0) & (m < c0)].copy(); d["sess"] = d.index.date
    d = finish(d, or_bars=15 if tf == "1m" else 3)
    span = 75 if tf == "5m" else 300                 # ~ 6h / 5h of bars -> higher-timeframe trend
    d["htf"] = ema(d.Close, span); return d

def setups(d):
    up = (d.Close > d.vwap) & (d.ema20 > d.ema50); dn = (d.Close < d.vwap) & (d.ema20 < d.ema50)
    hup = d.htf > d.htf.shift(10); hdn = d.htf < d.htf.shift(10)
    S = {}
    S["EMA9 pullback"] = (up & (d.Low <= d.ema9) & (d.Close > d.ema9) & (d.Close > d.Open), dn & (d.High >= d.ema9) & (d.Close < d.ema9) & (d.Close < d.Open))
    S["RSI(2) dip"] = (up & (d.rsi2 < 10), dn & (d.rsi2 > 90))
    pb_up = d.Close.shift() < d.Open.shift(); pb_dn = d.Close.shift() > d.Open.shift()
    S["1-bar pullback break"] = (up & pb_up & (d.Close > d.High.shift()), dn & pb_dn & (d.Close < d.Low.shift()))
    S["VWAP bounce"] = (up & (d.Low <= d.vwap + 0.25 * d.atr) & (d.Close > d.Open), dn & (d.High >= d.vwap - 0.25 * d.atr) & (d.Close < d.Open))
    hh = d.High.rolling(10).max().shift(); ll = d.Low.rolling(10).min().shift()
    S["10-bar micro breakout"] = (up & (d.Close > hh), dn & (d.Close < ll))
    out = {}
    for k, (L, Sh) in S.items():
        out[k] = (L.fillna(False).values, Sh.fillna(False).values)
        out[k + " + HTF trend"] = ((L & hup).fillna(False).values, (Sh & hdn).fillna(False).values)
    return out

def daily(t, goal, dstop):
    """apply daily goal / daily stop: trades taken in order; stop for the day once day P&L >= goal or <= -dstop"""
    rows = []
    for day, g in t.groupby("day", sort=True):
        cum = 0.0; n = 0
        for p in g.pnl.values:
            cum += p; n += 1
            if cum >= goal or cum <= -dstop: break
        rows.append((day, cum, n))
    return pd.DataFrame(rows, columns=["day", "pnl", "trades"])

def run(tf):
    rows = []
    for sym in ("NQ", "ES", "GC"):
        d = prep(sym, tf); sp = SPECS[sym]; nan = np.full(len(d), np.nan); days = np.array(d.sess)
        cut = pd.Timestamp(SPLIT[tf]).date()
        arrs = (d.Open.values, d.High.values, d.Low.values, d.Close.values, d.atr.values.astype(float), d.sess_id.values.astype(np.int64))
        for name, (L, S) in setups(d).items():
            for (sz, mult, comm), tp, sl_x, tmax, em in itertools.product(SIZES[sym], (100.0, 150.0, 200.0, 300.0), (0.5, 1.0, 1.5, 2.0),
                                                                          ((5, 10, 20) if tf == "1m" else (2, 4, 8)), (0, 4)):
                r = engine8(*arrs, L, S, nan, nan, em, 0, 0, tp * sl_x, tp * sl_x, tp, 0.0, sp["tick"], mult, comm, 2.0, 0.75, 0.0, 0.0, tmax, 0)
                if len(r) < 20: continue
                t = pd.DataFrame(dict(day=days[r[:, 0].astype(int)], pnl=r[:, 2]))
                for dstop in (500.0, 1000.0):
                    D = daily(t, 1500.0, dstop)
                    a, b = D[D.day <= cut], D[D.day > cut]
                    row = dict(tf=tf, symbol=sym, setup=name, entry=("market" if em == 0 else "confirm"), size=sz, TP=tp, SL=tp * sl_x, time_stop=tmax,
                               daily_stop=dstop, trades_day=t.groupby("day").size().mean(), win=(t.pnl > 0).mean())
                    for lab, x in (("TUNE", a), ("TEST", b)):
                        row.update({f"{lab}_days": len(x), f"{lab}_avg_day": x.pnl.mean(), f"{lab}_goal%": (x.pnl >= 1500).mean(),
                                    f"{lab}_red%": (x.pnl < 0).mean(), f"{lab}_worst": x.pnl.min(), f"{lab}_total": x.pnl.sum()})
                    rows.append(row)
        print(tf, sym, len(rows), file=sys.stderr)
    return pd.DataFrame(rows)

if __name__ == "__main__":
    df = pd.concat([run("1m"), run("5m")], ignore_index=True); df.to_csv("results/scalp_trend.csv", index=False)
    pd.set_option("display.width", 340); pd.set_option("display.max_colwidth", 30)
    print("configs:", len(df))
    c = ["tf", "symbol", "setup", "entry", "size", "TP", "SL", "time_stop", "daily_stop", "trades_day", "win", "TUNE_avg_day", "TUNE_goal%", "TUNE_red%",
         "TEST_days", "TEST_avg_day", "TEST_goal%", "TEST_red%", "TEST_worst"]
    for tf in ("1m", "5m"):
        x = df[df.tf == tf]
        print(f"\n=== {tf}: median over all configs -> TUNE avg day {x.TUNE_avg_day.median():.0f}, TEST avg day {x.TEST_avg_day.median():.0f};"
              f" % configs with positive TEST avg day: {(x.TEST_avg_day > 0).mean():.0%} ===")
        print("top 12 by TUNE avg day (TEST shown after):")
        print(x.sort_values("TUNE_avg_day", ascending=False).head(12)[c].round(2).to_string(index=False))
        top = x.sort_values("TUNE_avg_day", ascending=False).head(200)
        print(f"  top-200 by TUNE -> TEST avg day median {top.TEST_avg_day.median():.0f}, positive {(top.TEST_avg_day > 0).mean():.0%}, days hitting $1,500 in TEST: {top['TEST_goal%'].median():.0%}")
