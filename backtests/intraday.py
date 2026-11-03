"""Intraday strategies.
  * Hourly bars, continuous front month, Jun-2024 -> Nov-2026 (~2.4 years)
  * 5-minute bars on the ACTUAL Dec-2026 contracts (NQZ26, ESZ26, GCZ26) while they were the front month
Model: a strategy returns `held` (position during bar t, P&L = held_t * (C_t - C_{t-1})) and optionally
per-bar point overrides for stop/target exits. Costs: 1 tick + $2.50 per side, on every position change."""
import numpy as np, pandas as pd
from common import SPECS, cost_pts, load, perf, trade_stats, sma, ema, rsi, atr, hold

SESS = {"NQ": ((9, 30), (16, 0)), "ES": ((9, 30), (16, 0)), "GC": ((8, 20), (13, 30))}
Z26_START = {"NQ": "2026-09-14", "ES": "2026-09-14", "GC": "2026-08-27"}  # when Z26 was the front/most-active month

def minutes(idx): return idx.hour * 60 + idx.minute

def evaluate(d, held, sym, override=None):
    mult, cp = SPECS[sym]["mult"], cost_pts(sym)
    held = held.reindex(d.index).fillna(0)
    dc = d.Close.diff().fillna(0)
    pts = held * dc
    if override is not None:
        ov = override.reindex(d.index)
        pts = ov.where(ov.notna(), pts)
    chg = held.diff().abs().fillna(held.abs())
    pts = pts - chg * cp
    usd = pts * mult
    day = d.index.date
    daily_usd = usd.groupby(day).sum()
    notional = (d.Close * mult).groupby(day).first()
    p = perf(daily_usd / notional)
    # trades = runs of constant non-zero held
    run_id = (held != held.shift()).cumsum()
    g = pd.DataFrame(dict(h=held, usd=usd, rid=run_id))
    # exit cost belongs to the bar where held changes -> attribute it to the previous run
    exit_cost = (chg * cp * mult)
    g["usd_adj"] = g.usd + exit_cost - exit_cost.shift(-1).fillna(0) * (held != 0)
    tr = g[g.h != 0].groupby("rid").usd_adj.sum()
    eq = daily_usd.cumsum()
    return dict(**p, usd_pnl_1lot=usd.sum(), max_dd_usd=(eq - eq.cummax()).min(),
                **trade_stats(tr.values), days=len(daily_usd))

# ----------------------------- HOURLY (continuous) -----------------------------
def hourly_strategies(d, sym):
    (oh, om), (ch, cm) = SESS[sym]
    h = d.index.hour
    start = oh if sym == "GC" else 9     # hourly bars start on the hour
    end = 13 if sym == "GC" else 16
    day_sess = pd.Series(((h >= start) & (h < end)).astype(float), index=d.index)
    S = {}
    S["Overnight session only (long)"] = 1 - day_sess
    S["Day session only (long)"] = day_sess
    S["Buy & hold 24h (benchmark)"] = pd.Series(1.0, index=d.index)
    sig = lambda s: s.shift(1).fillna(0)
    S["EMA 20/50 L/S (1h)"] = sig(np.sign(ema(d.Close, 20) - ema(d.Close, 50)))
    S["EMA 9/21 L/S (1h)"] = sig(np.sign(ema(d.Close, 9) - ema(d.Close, 21)))
    m = ema(d.Close, 12) - ema(d.Close, 26); S["MACD 12/26/9 L/S (1h)"] = sig(np.sign(m - ema(m, 9)))
    r = rsi(d.Close, 14); S["RSI14 30/70 fade L/S (1h)"] = sig(hold(r < 30, r > 50, r > 70, r < 50))
    mid = sma(d.Close, 20); sd = d.Close.rolling(20).std()
    S["Bollinger 20/2 fade L/S (1h)"] = sig(hold(d.Close < mid - 2*sd, d.Close > mid, d.Close > mid + 2*sd, d.Close < mid))
    hi = d.High.rolling(20).max().shift(); lo = d.Low.rolling(20).min().shift()
    S["Donchian 20/10 breakout L/S (1h)"] = sig(hold(d.Close > hi, d.Close < d.Low.rolling(10).min().shift(),
                                                     d.Close < lo, d.Close > d.High.rolling(10).max().shift()))
    r2 = rsi(d.Close, 2); s200 = sma(d.Close, 200)
    S["RSI(2) pullback in uptrend (1h)"] = sig(hold((d.Close > s200) & (r2 < 10), d.Close > sma(d.Close, 5)))
    # Intraday momentum (Gao-Han-Li-Zhou 2018): first-period return predicts last-hour return
    dates = pd.Series(d.index.date, index=d.index)
    first_end = start + 1
    ref_close = d.Close[h == end - 1].groupby(dates[h == end - 1]).last()           # session close (close of last session bar)
    early = d.Open[h == first_end].groupby(dates[h == first_end]).first()           # price ~1 hour into session
    prev = ref_close.shift(1).reindex(early.index)
    direction = np.sign(early / prev - 1).dropna()
    last_bar = (h == end - 1)
    S["Intraday momentum: last hour follows 1st hour"] = (dates.map(direction).fillna(0) * last_bar).astype(float)
    return {k: (v, None) for k, v in S.items()}

# ----------------------------- 5-MINUTE (Z26 contracts) -----------------------------
def five_min_strategies(d, sym):
    (oh, om), (ch, cm) = SESS[sym]
    mins = minutes(d.index); o0, c0 = oh*60+om, ch*60+cm
    rth = pd.Series((mins >= o0) & (mins < c0), index=d.index)
    dates = pd.Series(d.index.date, index=d.index)
    last_rth = rth & (mins == c0 - 5)
    S = {}
    # session-based holds (using bar-close fills)
    in_rth_held = pd.Series(((mins > o0 - 5) & (mins <= c0 - 5)), index=d.index).astype(float)
    # held during bar t means C_{t-1}->C_t; RTH = bars starting o0 .. c0-5 (enter at close of bar before open)
    S["RTH session hold (long)"] = (rth).astype(float)
    S["Overnight hold, RTH close->open (long)"] = (~rth).astype(float)
    S["Buy & hold (benchmark)"] = pd.Series(1.0, index=d.index)
    def eod_flat(sigl):  # signal at bar close -> held next bar, only while inside RTH, flat at session end
        h = sigl.where(rth, 0).shift(1).fillna(0)
        return h.where(rth, 0)
    S["EMA 9/21 L/S RTH (5m)"] = eod_flat(np.sign(ema(d.Close, 9) - ema(d.Close, 21)))
    # VWAP (RTH, resets daily)
    tp = (d.High + d.Low + d.Close) / 3
    pv = (tp * d.Volume).where(rth, 0).groupby(dates).cumsum(); vv = d.Volume.where(rth, 0).groupby(dates).cumsum()
    vwap = pv / vv.replace(0, np.nan)
    after_30 = rth & (mins >= o0 + 30)
    S["VWAP trend: long above / short below (5m)"] = eod_flat(np.sign(d.Close - vwap).where(after_30, 0))
    dev = (d.Close - vwap); sdv = dev.where(rth).groupby(dates).transform(lambda x: x.expanding().std())
    z = dev / sdv
    S["VWAP 2-sigma reversion to VWAP (5m)"] = eod_flat(hold((z < -2) & after_30, z > 0, (z > 2) & after_30, z < 0))
    r = rsi(d.Close, 14)
    S["RSI14 30/70 fade, exit 50 (5m)"] = eod_flat(hold((r < 30) & after_30, r > 50, (r > 70) & after_30, r < 50))
    mid = sma(d.Close, 20); sd = d.Close.rolling(20).std()
    S["Bollinger 20/2 fade, exit mid (5m)"] = eod_flat(hold((d.Close < mid-2*sd) & after_30, d.Close > mid, (d.Close > mid+2*sd) & after_30, d.Close < mid))
    out = {k: (v, None) for k, v in S.items()}
    # ---- loop-based strategies with stops ----
    for n in (1, 3, 6):
        out[f"Opening Range Breakout {5*n}m, stop=other side, exit EOD"] = orb(d, rth, mins, o0, n, sym)
    out["ORB 15m, 2R target, stop=other side"] = orb(d, rth, mins, o0, 3, sym, target_r=2)
    out["Gap fade to prior close (stop 1x gap)"] = gap_trade(d, rth, mins, o0, sym, fade=True)
    out["Gap-and-go (follow gap, exit EOD)"] = gap_trade(d, rth, mins, o0, sym, fade=False)
    out["First 30m direction -> hold to close"] = first_n_follow(d, rth, mins, o0, 6)
    out["Last 30m follows open->10:00 return (Gao)"] = last_half_hour(d, rth, mins, o0, c0)
    return out

def _iter_days(d, rth):
    dd = d[rth.values]
    for day, g in dd.groupby(dd.index.date):
        yield day, g

def orb(d, rth, mins, o0, nbars, sym, target_r=None):
    held = pd.Series(0.0, index=d.index); ov = pd.Series(np.nan, index=d.index)
    for day, g in _iter_days(d, rth):
        if len(g) < nbars + 2: continue
        hi, lo = g.High.iloc[:nbars].max(), g.Low.iloc[:nbars].min(); R = hi - lo
        pos = 0; stop = tgt = None
        for i in range(nbars, len(g)):
            ts = g.index[i]; b = g.iloc[i]
            if pos == 0:
                if b.Close > hi: pos, stop = 1, lo; tgt = b.Close + target_r * R if target_r else None; held.iloc[d.index.get_loc(ts)+1:d.index.get_loc(g.index[-1])+1] = 1; entry_i = i
                elif b.Close < lo: pos, stop = -1, hi; tgt = b.Close - target_r * R if target_r else None; held.iloc[d.index.get_loc(ts)+1:d.index.get_loc(g.index[-1])+1] = -1; entry_i = i
                if pos: continue
            else:
                prevc = g.Close.iloc[i-1]; loc = d.index.get_loc(ts)
                hit_stop = (b.Low <= stop) if pos == 1 else (b.High >= stop)
                hit_tgt = tgt is not None and ((b.High >= tgt) if pos == 1 else (b.Low <= tgt))
                if hit_stop or hit_tgt:
                    px = stop if hit_stop else tgt   # stop assumed first if both (conservative)
                    if hit_stop: px = min(stop, b.Open) if pos == 1 else max(stop, b.Open)
                    ov.iloc[loc] = pos * (px - prevc)
                    held.iloc[loc+1:d.index.get_loc(g.index[-1])+1] = 0
                    break
    return held, ov

def gap_trade(d, rth, mins, o0, sym, fade=True, min_gap=0.002):
    held = pd.Series(0.0, index=d.index); ov = pd.Series(np.nan, index=d.index)
    prev_close = None
    for day, g in _iter_days(d, rth):
        if prev_close is not None and len(g) > 3:
            o = g.Open.iloc[0]; gap = o / prev_close - 1
            if abs(gap) >= min_gap:
                pos = -np.sign(gap) if fade else np.sign(gap)
                tgt = prev_close if fade else None
                stop = o + np.sign(gap) * abs(o - prev_close) if fade else prev_close
                i0 = d.index.get_loc(g.index[0]); iend = d.index.get_loc(g.index[-1])
                held.iloc[i0:iend+1] = pos
                # first bar: entry at open, not at prior bar close
                ov.iloc[i0] = pos * (g.Close.iloc[0] - o)
                for i in range(len(g)):
                    b = g.iloc[i]; loc = i0 + i
                    ref = o if i == 0 else g.Close.iloc[i-1]
                    hs = (b.Low <= stop) if pos == 1 else (b.High >= stop)
                    ht = tgt is not None and ((b.High >= tgt) if pos == 1 else (b.Low <= tgt))
                    if hs or ht:
                        px = stop if hs else tgt
                        ov.iloc[loc] = pos * (px - ref); held.iloc[loc+1:iend+1] = 0; break
        prev_close = g.Close.iloc[-1]
    return held, ov

def first_n_follow(d, rth, mins, o0, n):
    held = pd.Series(0.0, index=d.index)
    for day, g in _iter_days(d, rth):
        if len(g) <= n: continue
        s = np.sign(g.Close.iloc[n-1] - g.Open.iloc[0])
        held.loc[g.index[n:]] = s
    return held, None

def last_half_hour(d, rth, mins, o0, c0):
    held = pd.Series(0.0, index=d.index); prev_close = None
    for day, g in _iter_days(d, rth):
        m = minutes(g.index)
        if prev_close is not None and len(g) > 10:
            early = g.Close[m == o0 + 25]
            if len(early):
                s = np.sign(early.iloc[0] / prev_close - 1)
                held.loc[g.index[m >= c0 - 30]] = s
        prev_close = g.Close.iloc[-1]
    return held, None

def run():
    rows = []
    for sym in ["NQ", "ES", "GC"]:
        d = load(f"{sym}_cont_1h.csv", tz=True)
        d = d[d.index < "2026-11-03"]
        for name, (held, ov) in hourly_strategies(d, sym).items():
            rows.append(dict(set="1h continuous Jun2024-Nov2026", symbol=sym, strategy=name, **evaluate(d, held, sym, ov)))
        d5 = load(f"{sym}Z26_5m.csv", tz=True)
        d5 = d5[(d5.index >= Z26_START[sym]) & (d5.index < "2026-11-03")]
        for name, (held, ov) in five_min_strategies(d5, sym).items():
            rows.append(dict(set=f"5m {sym}Z26 contract", symbol=sym, strategy=name, **evaluate(d5, held, sym, ov)))
        print(sym, "done")
    df = pd.DataFrame(rows); df.to_csv("results/intraday_results.csv", index=False)
    return df

if __name__ == "__main__":
    df = run()
    pd.set_option("display.width", 250); pd.set_option("display.max_rows", 500)
    for (st, sym), f in df.groupby(["set", "symbol"], sort=False):
        print(f"\n===== {st} | {sym} | {f.days.iloc[0]} sessions =====")
        print(f.set_index("strategy")[["usd_pnl_1lot", "max_dd_usd", "sharpe", "total_ret", "trades", "win_rate", "profit_factor", "avg_trade"]]
              .sort_values("usd_pnl_1lot", ascending=False).round(2).to_string())
