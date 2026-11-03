"""Scalping research on the Dec-2026 contracts (1-minute bars, regular session only).
Walk-forward protocol: parameters are chosen on the IN-SAMPLE window only, then judged on the untouched
OUT-OF-SAMPLE window. Pass = OOS win rate > 60% AND OOS net P&L > 0 after costs.
Fill model (conservative):
  * entry: market at next bar open + 1 tick slippage
  * target: limit, fills only if price trades 1 tick THROUGH it (no slippage)
  * stop: market, stop price (or bar open if gapped through) - 1 tick slippage
  * same bar touches target and stop -> stop assumed first
  * time stop: exit at bar close - 1 tick; flat at session end
  * commission $2.50 per side"""
import numpy as np, pandas as pd, itertools, sys
from common import SPECS, load, ema, rsi, atr

SESS = {"NQ": (570, 960), "ES": (570, 960), "GC": (500, 810)}   # minutes after midnight ET
END = "2026-11-03"
SPLITS = {"1m": ("2026-10-06", "2026-10-21", "2026-10-22"),   # start, IS end, OOS start
          "5m": ("2026-09-14", "2026-10-14", "2026-10-15")}
GC_START = {"5m": "2026-08-27"}
IS_END = SPLITS["1m"][1]; OOS_START = SPLITS["1m"][2]

def prep(sym, tf="1m"):
    d = load(f"{sym}Z26_{tf}.csv", tz=True)
    start = GC_START.get(tf, SPLITS[tf][0]) if sym == "GC" else SPLITS[tf][0]
    d = d[(d.index >= start) & (d.index < END)]
    m = d.index.hour * 60 + d.index.minute
    o0, c0 = SESS[sym]
    d = d[(m >= o0) & (m < c0)].copy()
    d["date"] = d.index.date
    d["mins"] = d.index.hour * 60 + d.index.minute
    tp = (d.High + d.Low + d.Close) / 3
    d["vwap"] = (tp * d.Volume).groupby(d.date).cumsum() / d.Volume.groupby(d.date).cumsum().replace(0, np.nan)
    dev = d.Close - d.vwap
    d["vsd"] = dev.groupby(d.date).transform(lambda x: x.expanding(20).std())
    d["z"] = dev / d.vsd
    for n in (9, 20, 50): d[f"ema{n}"] = ema(d.Close, n)
    d["rsi2"] = rsi(d.Close, 2); d["rsi7"] = rsi(d.Close, 7)
    d["atr"] = atr(d, 14)
    d["volavg"] = d.Volume.rolling(30).mean()
    d["new_day"] = d.date != pd.Series(d.date, index=d.index).shift()
    return d

# ------------------------- my scalping setups -------------------------
def S_vwap_snap(d, k=2.0):
    """Fade a stretched move away from VWAP once a reversal bar prints."""
    L = (d.z < -k) & (d.Close > d.Open) & (d.Close > d.Close.shift())
    S = (d.z > k) & (d.Close < d.Open) & (d.Close < d.Close.shift())
    return L, S

def S_trend_rsi2(d, lo=10):
    """With-trend pullback: price above VWAP & rising EMA50, RSI(2) dips -> buy (mirror for shorts)."""
    up = (d.Close > d.vwap) & (d.ema20 > d.ema50) & (d.ema50 > d.ema50.shift(5))
    dn = (d.Close < d.vwap) & (d.ema20 < d.ema50) & (d.ema50 < d.ema50.shift(5))
    return up & (d.rsi2 < lo), dn & (d.rsi2 > 100 - lo)

def S_sweep_reclaim(d, n=15):
    """Liquidity sweep: bar takes out the prior n-bar low but closes back above it (failed breakdown)."""
    pl = d.Low.rolling(n).min().shift(); ph = d.High.rolling(n).max().shift()
    L = (d.Low < pl) & (d.Close > pl) & (d.Close > d.Open)
    S = (d.High > ph) & (d.Close < ph) & (d.Close < d.Open)
    return L, S

def S_exhaustion(d, n=4):
    """n straight closes in one direction + range/volume spike -> fade."""
    dn = (d.Close < d.Close.shift()).astype(int); up = (d.Close > d.Close.shift()).astype(int)
    spike = ((d.High - d.Low) > 1.5 * d.atr) & (d.Volume > 1.5 * d.volavg)
    return (dn.rolling(n).sum() == n) & spike, (up.rolling(n).sum() == n) & spike

def S_trend_sweep(d, n=10):
    """Sweep & reclaim, but only in the direction of the session trend (VWAP + EMA50)."""
    L, S = S_sweep_reclaim(d, n)
    return L & (d.Close > d.vwap) & (d.ema20 > d.ema50), S & (d.Close < d.vwap) & (d.ema20 < d.ema50)

def S_vwap_snap_trend(d, k=1.5):
    """Stretch fade only when it is a pullback against the bigger trend (EMA50 slope)."""
    L, S = S_vwap_snap(d, k)
    return L & (d.ema50 > d.ema50.shift(30)), S & (d.ema50 < d.ema50.shift(30))

def S_momo_burst(d):
    """Momentum burst: wide-range bar (>2x ATR) closing in its top/bottom 20% on 2x volume -> continuation."""
    rng = d.High - d.Low; pos = (d.Close - d.Low) / rng.replace(0, np.nan)
    big = (rng > 2 * d.atr.shift()) & (d.Volume > 2 * d.volavg.shift())
    return big & (pos > 0.8), big & (pos < 0.2)

def S_orb_pullback(d, n=15):
    """Opening-range break, then buy the first pullback that holds the OR high (mirror short)."""
    first = d.mins < d.groupby("date").mins.transform("min") + n
    orh = d.High.where(first).groupby(d.date).transform("max"); orl = d.Low.where(first).groupby(d.date).transform("min")
    broke_up = (d.Close > orh).groupby(d.date).cummax() & ~first; broke_dn = (d.Close < orl).groupby(d.date).cummax() & ~first
    L = broke_up & (d.Low <= orh + 0.25 * d.atr) & (d.Close > orh) & (d.Close > d.Open)
    S = broke_dn & (d.High >= orl - 0.25 * d.atr) & (d.Close < orl) & (d.Close < d.Open)
    return L, S

def S_vwap_first_touch(d):
    """Trend day: price held one side of VWAP for 30+ bars, first touch back to VWAP -> trade with trend."""
    above = (d.Low > d.vwap).astype(int); below = (d.High < d.vwap).astype(int)
    a30 = above.shift().rolling(30).min() == 1; b30 = below.shift().rolling(30).min() == 1
    return a30 & (d.Low <= d.vwap) & (d.Close > d.vwap), b30 & (d.High >= d.vwap) & (d.Close < d.vwap)

def S_inside_trend(d):
    """Inside bar inside a trend (EMA9>EMA20>EMA50): enter on close above the mother bar high."""
    inside = (d.High.shift() < d.High.shift(2)) & (d.Low.shift() > d.Low.shift(2))
    up = (d.ema9 > d.ema20) & (d.ema20 > d.ema50); dn = (d.ema9 < d.ema20) & (d.ema20 < d.ema50)
    return inside & up & (d.Close > d.High.shift(2)), inside & dn & (d.Close < d.Low.shift(2))

def S_double_stretch(d):
    """Extreme stretch: >2.5σ from VWAP AND RSI(7) extreme AND stall bar (range < ATR) -> fade."""
    stall = (d.High - d.Low) < d.atr
    return (d.z < -2.5) & (d.rsi7 < 20) & stall, (d.z > 2.5) & (d.rsi7 > 80) & stall

def morning(fn, mins=120):
    def g(d):
        L, S = fn(d); m = d.mins < d.groupby("date").mins.transform("min") + mins
        return L & m, S & m
    return g

SETUPS = {
    "VWAP 2σ snap-back": lambda d: S_vwap_snap(d, 2.0),
    "VWAP 2.5σ snap-back": lambda d: S_vwap_snap(d, 2.5),
    "VWAP 1.5σ snap-back w/ trend": lambda d: S_vwap_snap_trend(d, 1.5),
    "Trend pullback RSI(2)<10": lambda d: S_trend_rsi2(d, 10),
    "Trend pullback RSI(2)<5": lambda d: S_trend_rsi2(d, 5),
    "Sweep & reclaim 15-bar": lambda d: S_sweep_reclaim(d, 15),
    "Sweep & reclaim 30-bar": lambda d: S_sweep_reclaim(d, 30),
    "With-trend sweep & reclaim 10-bar": lambda d: S_trend_sweep(d, 10),
    "Exhaustion fade (4 bars + spike)": lambda d: S_exhaustion(d, 4),
    "Momentum burst continuation": S_momo_burst,
    "ORB-15 pullback hold": S_orb_pullback,
    "VWAP first touch on trend day": S_vwap_first_touch,
    "Inside-bar break in trend": S_inside_trend,
    "Double-stretch fade (VWAP+RSI+stall)": S_double_stretch,
    "MORNING Trend pullback RSI(2)<10": morning(lambda d: S_trend_rsi2(d, 10)),
    "MORNING Sweep & reclaim 15-bar": morning(lambda d: S_sweep_reclaim(d, 15)),
    "MORNING VWAP 2σ snap-back": morning(lambda d: S_vwap_snap(d, 2.0)),
    "MORNING Momentum burst": morning(S_momo_burst),
}

# ------------------------- execution engine -------------------------
def simulate(d, L, S, sym, tgt_t, stp_t, tmax):
    sp = SPECS[sym]; tick, mult, comm = sp["tick"], sp["mult"], sp["comm"]
    o, h, l, c = d.Open.values, d.High.values, d.Low.values, d.Close.values
    Lv, Sv = L.fillna(False).values, S.fillna(False).values
    date = d.date.values; n = len(d); out = []; i = 0
    while i < n - 1:
        side = 1 if Lv[i] else (-1 if Sv[i] else 0)
        if side == 0 or date[i + 1] != date[i]: i += 1; continue
        j = i + 1; entry = o[j] + side * tick
        tgt = entry + side * tgt_t * tick; stp = entry - side * stp_t * tick
        exitp = None
        while True:
            hit_s = (l[j] <= stp) if side == 1 else (h[j] >= stp)
            hit_t = (h[j] >= tgt + tick) if side == 1 else (l[j] <= tgt - tick)
            if hit_s:
                px = min(stp, o[j]) if side == 1 else max(stp, o[j]); exitp = px - side * tick; break
            if hit_t: exitp = tgt; break
            last_bar = (j + 1 >= n) or date[j + 1] != date[j]
            if j - i >= tmax or last_bar: exitp = c[j] - side * tick; break
            j += 1
        pnl = side * (exitp - entry) * mult - 2 * comm
        out.append((d.index[i + 1], side, pnl, j - i))
        i = j + 1   # can re-enter after the exit bar
    return pd.DataFrame(out, columns=["time", "side", "pnl", "bars"])

def stats(t):
    if len(t) == 0: return dict(trades=0, win=np.nan, pnl=0.0, pf=np.nan, exp=np.nan, maxdd=0.0)
    g, ls = t.pnl[t.pnl > 0].sum(), -t.pnl[t.pnl < 0].sum(); eq = t.pnl.cumsum()
    return dict(trades=len(t), win=(t.pnl > 0).mean(), pnl=t.pnl.sum(), pf=g / ls if ls else np.inf,
                exp=t.pnl.mean(), maxdd=(eq - eq.cummax()).min())

def grid(sym, d, is_end):
    R = (d.High - d.Low)[: is_end].median()          # typical 1-min bar range (in-sample)
    tick = SPECS[sym]["tick"]
    tg = sorted({max(1, round(x * R / tick)) for x in (0.5, 0.75, 1.0, 1.5, 2.0)})
    st = sorted({max(1, round(x * R / tick)) for x in (1.0, 1.5, 2.0, 3.0)})
    return tg, st, (5, 10, 20)

def run(setups=SETUPS, syms=("NQ", "ES", "GC"), tf="1m", verbose=True, min_trades=25):
    rows = []; _, is_end, oos_start = SPLITS[tf]
    for sym in syms:
        d = prep(sym, tf); tg, st, tm = grid(sym, d, is_end)
        if tf == "5m": tm = (2, 4, 8)
        isd, oosd = d[:is_end], d[oos_start:]
        for name, fn in setups.items():
            Lf, Sf = fn(d)
            best = None
            for T, Sx, tmax in itertools.product(tg, st, tm):
                t_is = simulate(isd, Lf[isd.index], Sf[isd.index], sym, T, Sx, tmax); s = stats(t_is)
                if s["trades"] < min_trades or not (s["win"] > 0.60) or s["pnl"] <= 0: continue
                if best is None or s["exp"] > best[0]["exp"]: best = (s, (T, Sx, tmax))
            if best is None:
                rows.append(dict(tf=tf, symbol=sym, setup=name, params="no IS combo >60% win & profitable")); continue
            s_is, (T, Sx, tmax) = best
            s_oos = stats(simulate(oosd, Lf[oosd.index], Sf[oosd.index], sym, T, Sx, tmax))
            rows.append(dict(tf=tf, symbol=sym, setup=name, params=f"tgt {T}t / stop {Sx}t / {tmax}m",
                             **{f"IS_{k}": v for k, v in s_is.items()}, **{f"OOS_{k}": v for k, v in s_oos.items()},
                             PASS=bool(s_oos["win"] > 0.60 and s_oos["pnl"] > 0)))
            if verbose: print(sym, name, rows[-1]["params"], "IS win %.2f $%.0f | OOS win %.2f $%.0f n=%d" %
                              (s_is["win"], s_is["pnl"], s_oos["win"], s_oos["pnl"], s_oos["trades"]), file=sys.stderr)
    return pd.DataFrame(rows)

if __name__ == "__main__":
    tf = sys.argv[1] if len(sys.argv) > 1 else "1m"
    df = run(tf=tf, min_trades=25 if tf == "1m" else 20); df.to_csv(f"results/scalping_{tf}.csv", index=False)
    pd.set_option("display.width", 250); pd.set_option("display.max_rows", 200)
    df = df[df.IS_trades.notna()] if "IS_trades" in df else df
    print(df[["tf", "symbol", "setup", "params", "IS_trades", "IS_win", "IS_pnl", "OOS_trades", "OOS_win", "OOS_pnl", "OOS_pf", "PASS"]].round(2).to_string())
