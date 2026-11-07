"""The common trading-bot styles, tested the same way as Keel's K strategies.

Data: Yahoo continuous futures, hourly NQ / GC / ES Jun 2024 - Nov 2026 (1-minute: last 4 weeks only, used for scalping).
Rules for every style (prop-firm day trading, like Keel):
  * a signal on a bar's close enters at the NEXT bar's open; 1 tick slippage on entries, stops and market exits
  * if a bar touches both the stop and the target, the stop is assumed to come first
  * commission $5 per mini round trip ($1.50 per micro in the prop-account test)
  * no entries from 15:00 ET; anything open is closed at 16:00 ET (Topstep: flat by 3:10 PM CT); no trading 16:00-18:00
Settings are chosen on TUNE (trades entered before Dec 2025) and judged on TEST (Dec 2025 - Nov 2026), never the reverse.
Each style's chosen version is then run through the Topstep 50K Static Combine (topstep_static.py rules), alone and
added to Keel's best $500 mix (K8 + K9 + K1 + K3 + K4 + K6 + K7).

Not testable with price bars, and why (see BOT_STYLES.md): spatial / triangular arbitrage (needs several venues' prices
at the same instant), market making (needs the order book and queue position). LLM-driven trading cannot be backtested
honestly: the model has read about these very prices. A walk-forward machine-learning model is tested instead.
    SCRATCH=<dir> python3 bot_styles.py   -> results/bot_styles_*.csv, console summary"""
import os, sys, itertools, numpy as np, pandas as pd, warnings
warnings.filterwarnings("ignore")
from common import SPECS
HERE = os.path.dirname(os.path.abspath(__file__)); NY = "America/New_York"
CUT = pd.Timestamp("2025-12-01", tz=NY)
MICRO = {"NQ": 2.0, "GC": 10.0, "ES": 5.0}                      # $ per point for one micro

def load(sym, tf="1h"):
    d = pd.read_csv(os.path.join(HERE, "data", f"{sym}_cont_{tf}.csv"), index_col=0)
    d.index = pd.to_datetime(d.index, utc=True).tz_convert(NY); d = d[~d.index.duplicated()].sort_index()
    d = d.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]].astype(float)
    d["mod"] = d.index.hour * 60 + d.index.minute; d["day"] = (d.index + pd.Timedelta(hours=6)).date
    return d

# ---------- indicators ----------
def ema(x, n): return x.ewm(span=n, adjust=False).mean()
def atr(d, n=14):
    pc = d.close.shift(); tr = pd.concat([d.high - d.low, (d.high - pc).abs(), (d.low - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()
def rsi(x, n):
    g = x.diff().clip(lower=0).ewm(alpha=1 / n, adjust=False).mean(); l = (-x.diff().clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + g / l.replace(0, np.nan))

# ---------- one generic bar simulator ----------
def simulate(d, sym, side, stop_d, tgt_r=None, exit_long=None, exit_short=None, max_hold=10**9, barlen=60, flat=16 * 60, label=""):
    """side[i] = +1 / -1 on bar i's close -> enter at bar i+1's open. stop_d[i] = stop distance in points.
    tgt_r: target in multiples of the stop (None = no target). exit_*[i]: leave at bar i+1's open."""
    o, h, l, c, mod = d.open.values, d.high.values, d.low.values, d.close.values, d["mod"].values
    tick, n = SPECS[sym]["tick"], len(d); idx = d.index
    no_entry = lambda m: m >= flat - barlen and m < 18 * 60            # entry bar starts too late, or market break
    ends_flat = lambda m: m + barlen >= flat and m < flat               # this bar's close is the flat-by time
    side = np.asarray(side); stop_d = np.asarray(stop_d, float)
    el = np.zeros(n, bool) if exit_long is None else np.asarray(exit_long, bool); es = np.zeros(n, bool) if exit_short is None else np.asarray(exit_short, bool)
    out, i = [], 0
    while i < n - 1:
        s = side[i]
        if s == 0 or not np.isfinite(stop_d[i]) or stop_d[i] <= 0 or no_entry(mod[i + 1]) or (idx[i + 1] - idx[i]) > pd.Timedelta(minutes=barlen * 3): i += 1; continue
        j = i + 1; e = o[j] + s * tick; sd = stop_d[i]; sp = e - s * sd; tp = None if tgt_r is None else e + s * tgt_r * sd
        x = why = None
        while j < n:
            if j > i + 1 and (o[j] - sp) * s <= 0: x, why = o[j] - s * tick, "stop"; break          # gapped through the stop
            if (l[j] - sp if s > 0 else sp - h[j]) <= 0: x, why = sp - s * tick, "stop"; break
            if tp is not None and (h[j] - tp if s > 0 else tp - l[j]) > 0: x, why = tp, "target"; break
            if ends_flat(mod[j]) or j + 1 >= n or (j + 1 < n and idx[j + 1] - idx[j] > pd.Timedelta(hours=3)): x, why = c[j] - s * tick, "flat"; break
            if j - i >= max_hold or (s > 0 and el[j]) or (s < 0 and es[j]):
                x, why = o[j + 1] - s * tick, "exit"; j += 1; break
            j += 1
        pts = s * (x - e); M = SPECS[sym]["mult"]
        out.append(dict(strategy=label, sym=sym, entry_t=idx[i + 1], exit_t=idx[min(j, n - 1)] + pd.Timedelta(minutes=barlen), side=s, entry=e, exit=x,
                        pts=pts, stop_pts=sd, R=(pts * M - 5.0) / (sd * M), usd_mini=pts * M - 5.0, why=why))
        i = j                                                            # the next signal can come from the exit bar
    return pd.DataFrame(out)

# ---------- the styles ----------
def trend(d, sym, kind, a, b, k_stop, tgt):
    A = atr(d); c = d.close
    if kind == "ema":
        f, s = ema(c, a), ema(c, b); up = (f > s) & (f.shift() <= s.shift()); dn = (f < s) & (f.shift() >= s.shift())
        return simulate(d, sym, np.where(up, 1, np.where(dn, -1, 0)), k_stop * A, tgt, exit_long=f < s, exit_short=f > s, label=f"EMA {a}/{b} cross, stop {k_stop} ATR" + (f", target {tgt}R" if tgt else ""))
    if kind == "macd":
        m = ema(c, 12) - ema(c, 26); sg = ema(m, 9); up = (m > sg) & (m.shift() <= sg.shift()) & (m > 0); dn = (m < sg) & (m.shift() >= sg.shift()) & (m < 0)
        return simulate(d, sym, np.where(up, 1, np.where(dn, -1, 0)), k_stop * A, tgt, exit_long=m < sg, exit_short=m > sg, label=f"MACD 12/26/9 cross with the trend, stop {k_stop} ATR" + (f", target {tgt}R" if tgt else ""))
    if kind == "donchian":
        hi, lo = d.high.rolling(a).max().shift(), d.low.rolling(a).min().shift(); xh, xl = d.high.rolling(b).max().shift(), d.low.rolling(b).min().shift()
        return simulate(d, sym, np.where(c > hi, 1, np.where(c < lo, -1, 0)), k_stop * A, tgt, exit_long=c < xl, exit_short=c > xh, label=f"Donchian {a}-bar breakout ({b}-bar exit), stop {k_stop} ATR" + (f", target {tgt}R" if tgt else ""))

def meanrev(d, sym, kind, a, b, k_stop, hold):
    A = atr(d); c = d.close
    if kind == "rsi2":
        r = rsi(c, 2); trend_ = c.rolling(200).mean()
        return simulate(d, sym, np.where((r < a) & (c > trend_), 1, np.where((r > 100 - a) & (c < trend_), -1, 0)), k_stop * A, None,
                        exit_long=r > 50, exit_short=r < 50, max_hold=hold, label=f"RSI(2) < {a} / > {100 - a} with the 200-bar trend, exit RSI 50, stop {k_stop} ATR")
    if kind == "rsi14":
        r = rsi(c, 14); up = (r > a) & (r.shift() <= a); dn = (r < 100 - a) & (r.shift() >= 100 - a)
        return simulate(d, sym, np.where(up, 1, np.where(dn, -1, 0)), k_stop * A, None, exit_long=r > 50, exit_short=r < 50, max_hold=hold,
                        label=f"RSI(14) back above {a} / below {100 - a}, exit RSI 50, stop {k_stop} ATR")
    if kind == "bb":
        m = c.rolling(20).mean(); sd = c.rolling(20).std(); lo, hi = m - b * sd, m + b * sd
        return simulate(d, sym, np.where(c < lo, 1, np.where(c > hi, -1, 0)), k_stop * A, None, exit_long=c >= m, exit_short=c <= m, max_hold=hold,
                        label=f"Bollinger 20/{b}: close outside the band, exit at the middle, stop {k_stop} ATR")

def grid(d, sym, spacing, levels, start_h=10, barlen=60, flat=16 * 60):
    """Neutral grid each day: anchor = open of the start_h bar; buy limits every `spacing` x daily ATR below, sell limits above,
    each closed one level back toward the anchor. Past `levels` levels that side is stopped out for the day. Price path inside a
    bar: open -> low -> high -> close on up bars, open -> high -> low -> close on down bars."""
    D = d.groupby("day").agg(h=("high", "max"), l=("low", "min"), c=("close", "last")); datr = (D.h - D.l).rolling(14).mean().shift()
    tick, M = SPECS[sym]["tick"], SPECS[sym]["mult"]; out = []
    for day, g in d.groupby("day"):
        if day not in datr.index or not np.isfinite(datr[day]): continue
        g = g[(g["mod"] >= start_h * 60) & (g["mod"] < flat)]
        if len(g) < 2: continue
        sp = max(tick, round(spacing * datr[day] / tick) * tick); A = g.open.iloc[0]
        units = []; dead = {1: False, -1: False}                         # unit = [side, level k, entry px, entry time]
        def walk(a, b, t):
            if b == a: return
            up = b > a; lo, hi = min(a, b), max(a, b)
            ks = range(-levels - 1, levels + 2)
            pts = sorted([A + k * sp for k in ks if lo < A + k * sp <= hi] if up else [A + k * sp for k in ks if lo <= A + k * sp < hi], reverse=not up)
            for p in pts:
                k = round((p - A) / sp)
                # targets: longs close one level above their entry (on the way up), shorts one level below (on the way down)
                for u in list(units):
                    if (u[0] > 0 and up and k == u[1] + 1) or (u[0] < 0 and not up and k == u[1] - 1):
                        out.append((u, p, t, "target")); units.remove(u)
                # stops: beyond the outermost level, that side is closed for the day
                if not up and k == -levels - 1 and not dead[1]:
                    for u in [u for u in units if u[0] > 0]: out.append((u, p - tick, t, "stop")); units.remove(u)
                    dead[1] = True
                if up and k == levels + 1 and not dead[-1]:
                    for u in [u for u in units if u[0] < 0]: out.append((u, p + tick, t, "stop")); units.remove(u)
                    dead[-1] = True
                # entries
                if not up and -levels <= k <= -1 and not dead[1] and not any(u[0] > 0 and u[1] == k for u in units): units.append([1, k, p, t])
                if up and 1 <= k <= levels and not dead[-1] and not any(u[0] < 0 and u[1] == k for u in units): units.append([-1, k, p, t])
        for t, r in g.iterrows():
            path = [r.open, r.low, r.high, r.close] if r.close >= r.open else [r.open, r.high, r.low, r.close]
            for a, b in zip(path, path[1:]): walk(a, b, t)
        last = g.close.iloc[-1]; tl = g.index[-1]
        for u in units: out.append((u, last - u[0] * tick, tl, "flat"))
    rows = []
    for (s, k, e, te), x, tx, why in out:
        pts = s * (x - e); risk_pts = (levels + 1 - abs(k)) * 1.0           # distance (in grid steps) to that side's stop
        rows.append(dict(entry_t=te, exit_t=tx + pd.Timedelta(minutes=barlen), side=s, entry=e, exit=x, pts=pts, steps_to_stop=risk_pts, why=why))
    T = pd.DataFrame(rows)
    if not len(T): return T
    # each unit's stop distance in points = its steps to the stop x that day's spacing
    T["day"] = (T.entry_t + pd.Timedelta(hours=6)).dt.date; spd = {day: max(tick, round(spacing * datr[day] / tick) * tick) for day in T.day.unique()}
    T["stop_pts"] = T.steps_to_stop * T.day.map(spd); T["R"] = (T.pts * M - 5) / (T.stop_pts * M); T["usd_mini"] = T.pts * M - 5
    T["strategy"] = f"Grid every {spacing} daily ATR, {levels} levels a side, {start_h}:00-16:00"; T["sym"] = sym
    return T.drop(columns=["steps_to_stop", "day"])

# ---------- machine learning, walk forward ----------
def ml(d, sym, thr, hold=4):
    """Gradient-boosted trees predict whether price moves +1 ATR before -1 ATR within `hold` hours. Retrained every month on all
    earlier data only (labels that would need future bars are dropped). Trades when P(up) >= thr (long) or <= 1 - thr (short)."""
    from sklearn.ensemble import HistGradientBoostingClassifier
    c = d.close; A = atr(d); X = pd.DataFrame(index=d.index)
    for k in (1, 3, 6, 24): X[f"r{k}"] = c.pct_change(k)
    X["rsi14"] = rsi(c, 14); X["rsi2"] = rsi(c, 2); X["e20"] = (c - ema(c, 20)) / A; X["e50"] = (c - ema(c, 50)) / A; X["e200"] = (c - ema(c, 200)) / A
    X["atr_ratio"] = A / A.rolling(100).mean(); X["hour"] = d.index.hour; X["dow"] = d.index.dayofweek
    X["vol_z"] = (d.volume - d.volume.rolling(50).mean()) / d.volume.rolling(50).std(); X["range"] = (d.high - d.low) / A
    X = X.replace([np.inf, -np.inf], np.nan)
    # label: +1 ATR before -1 ATR within `hold` bars (from the next open)
    o, h, l = d.open.values, d.high.values, d.low.values; y = np.full(len(d), np.nan)
    for i in range(len(d) - hold - 1):
        e, a = o[i + 1], A.values[i]
        for j in range(i + 1, i + 1 + hold):
            if l[j] <= e - a: y[i] = 0; break
            if h[j] >= e + a: y[i] = 1; break
    months = pd.period_range(d.index[0].strftime("%Y-%m"), d.index[-1].strftime("%Y-%m"), freq="M"); p = pd.Series(np.nan, index=d.index)
    ok = X.notna().all(axis=1).values
    for mth in months[6:]:
        start = pd.Timestamp(mth.start_time).tz_localize(NY); end = pd.Timestamp(mth.end_time).tz_localize(NY)
        tr = (d.index < start - pd.Timedelta(hours=hold + 2)) & ok & ~np.isnan(y); te = (d.index >= start) & (d.index <= end) & ok
        if tr.sum() < 2000 or te.sum() == 0: continue
        m = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=80, random_state=0).fit(X[tr], y[tr])
        p[te] = m.predict_proba(X[te])[:, 1]
    sig = np.where(p >= thr, 1, np.where(p <= 1 - thr, -1, 0))
    return simulate(d, sym, sig, A.values, 1.0, max_hold=hold, label=f"ML walk-forward (gradient boosting), trade at P >= {thr}")

# ---------- scoring ----------
def score(T, part=None):
    if T is None or not len(T): return dict(trades=0)
    if part == "tune": T = T[T.entry_t < CUT]
    if part == "test": T = T[T.entry_t >= CUT]
    if not len(T): return dict(trades=0)
    R = T.R.values; eq = np.cumsum(R); dd = (np.maximum.accumulate(np.r_[0, eq]) - np.r_[0, eq]).max()
    gw, gl = R[R > 0].sum(), -R[R < 0].sum()
    return dict(trades=len(T), win=(R > 0).mean(), avg_R=R.mean(), pf=gw / gl if gl else np.inf, total_R=R.sum(), max_dd_R=dd,
                usd_per_trade_1mini=T.usd_mini.mean())

def tday(x): return (x + pd.Timedelta(hours=6)).date()
def daily_series(T, risk, days):
    """Same as topstep_static.daily_series (netting, micro caps, hard $1,000 daily loss limit), for any of NQ / GC / ES."""
    T = T.sort_values("entry_t"); busy = {}; out = {}
    mm = T.sym.map(MICRO).values; n = np.maximum(1, np.floor(risk / (T.stop_pts.values * mm))); n = np.minimum(n, np.where(T.sym.values == "GC", 25, 40))
    usd = n * (T.pts.values * mm - 1.5)
    for k, r in enumerate(T.itertuples()):
        if busy.get(r.sym) is not None and r.entry_t < busy[r.sym]: continue
        dd_ = tday(r.entry_t)
        if out.get(dd_, 0.0) <= -1000: continue
        busy[r.sym] = r.exit_t; xd = tday(r.exit_t); out[xd] = max(out.get(xd, 0.0) + usd[k], -1000.0)
    return np.array([out.get(x, 0.0) for x in days])

if __name__ == "__main__":
    pd.set_option("display.width", 260); pd.set_option("display.max_colwidth", 80)
    bars = {s: load(s) for s in ("NQ", "GC", "ES")}
    runs = []
    for sym, d in bars.items():
        for kind, (a, b) in [("ema", (9, 21)), ("ema", (20, 50)), ("ema", (50, 200)), ("macd", (0, 0)), ("donchian", (20, 10)), ("donchian", (55, 20))]:
            for k_stop, tgt in itertools.product((2.0, 3.0), (None, 2.0)):
                runs.append(("Trend following", sym, trend(d, sym, kind, a, b, k_stop, tgt)))
        for kind, a, b in [("rsi2", 10, 0), ("rsi2", 5, 0), ("rsi14", 30, 0), ("bb", 0, 2.0), ("bb", 0, 2.5)]:
            for k_stop, hold in itertools.product((1.5, 2.5), (5, 10)):
                runs.append(("Mean reversion", sym, meanrev(d, sym, kind, a, b, k_stop, hold)))
        for spacing, levels in itertools.product((0.05, 0.1, 0.2), (3, 5)):
            runs.append(("Grid trading", sym, grid(d, sym, spacing, levels)))
        for thr in (0.55, 0.6):
            runs.append(("Machine learning", sym, ml(d, sym, thr)))
        print(f"{sym} done", file=sys.stderr, flush=True)
    rows = []
    for fam, sym, T in runs:
        if not len(T): continue
        rows.append(dict(family=fam, sym=sym, strategy=T.strategy.iloc[0], **{f"tune_{k}": v for k, v in score(T, "tune").items()}, **{f"test_{k}": v for k, v in score(T, "test").items()}))
    S = pd.DataFrame(rows); S.to_csv(os.path.join(HERE, "results", "bot_styles_all.csv"), index=False)

    # ---- scalping: 1-minute bars, last 4 weeks only (too short to tune and test separately) ----
    sc = []
    for sym in ("NQ", "GC", "ES"):
        m = load(sym, "1m"); c = m.close; A = atr(m, 14); rth = (m["mod"] >= 9 * 60 + 35) & (m["mod"] < 15 * 60 + 50)
        e9, e21 = ema(c, 9), ema(c, 21)
        pull = rth & (e9 > e21) & (m.low <= e9) & (c > e9); pulls = rth & (e9 < e21) & (m.high >= e9) & (c < e9)
        vw = (c * m.volume).groupby(m.day).cumsum() / m.volume.groupby(m.day).cumsum(); dev = (c - vw).groupby(m.day).transform(lambda x: x.expanding().std())
        orh = m.high.where((m["mod"] >= 570) & (m["mod"] < 575)).groupby(m.day).transform("max"); orl = m.low.where((m["mod"] >= 570) & (m["mod"] < 575)).groupby(m.day).transform("min")
        first = rth & (m["mod"] < 11 * 60)
        for label, side, sd, tgt in [
            ("Scalp: 1m EMA 9/21 pullback, stop 1.5 ATR, target 1R", np.where(pull, 1, np.where(pulls, -1, 0)), 1.5 * A, 1.0),
            ("Scalp: 1m EMA 9/21 pullback, stop 1.5 ATR, target 2R", np.where(pull, 1, np.where(pulls, -1, 0)), 1.5 * A, 2.0),
            ("Scalp: fade 2 sigma from VWAP, stop 1 ATR, target 1R", np.where(rth & (c < vw - 2 * dev), 1, np.where(rth & (c > vw + 2 * dev), -1, 0)), 1.0 * A, 1.0),
            ("Scalp: 5-minute opening range breakout, target 1R", np.where(first & (c > orh) & (c.shift() <= orh), 1, np.where(first & (c < orl) & (c.shift() >= orl), -1, 0)), (orh - orl).clip(lower=SPECS[sym]["tick"] * 4), 1.0)]:
            T = simulate(m, sym, side, sd, tgt, barlen=1, flat=15 * 60 + 56, label=label)
            sc.append(dict(sym=sym, strategy=label, **score(T), cost_share_of_avg_risk=(5.0 + 2 * SPECS[sym]["tick"] * SPECS[sym]["mult"]) / (T.stop_pts.mean() * SPECS[sym]["mult"]) if len(T) else np.nan))
    SC = pd.DataFrame(sc); SC.to_csv(os.path.join(HERE, "results", "bot_styles_scalping.csv"), index=False)

    # ---- dollar-cost averaging: buy 1 micro every Monday at 10:00 ET and hold everything to the end ----
    dca = []
    for sym, d in bars.items():
        buys = d[(d.index.dayofweek == 0) & (d["mod"] == 600)].open; last = d.close.iloc[-1]; mm = MICRO[sym]
        held = pd.Series(1.0, index=buys.index).reindex(d.index, fill_value=0).cumsum(); cost = (buys * mm).reindex(d.index, fill_value=0).cumsum()
        val = held * d.close * mm - cost - held * 1.5 / 2; peak = val.cummax()
        dca.append(dict(sym=sym, buys=len(buys), micros_held=int(held.iloc[-1]), profit=val.iloc[-1], worst_drawdown=(peak - val).max(),
                        avg_price=(buys.mean()), last=last, margin_like_exposure=held.iloc[-1] * last * mm))
    DCA = pd.DataFrame(dca); DCA.to_csv(os.path.join(HERE, "results", "bot_styles_dca.csv"), index=False)

    # ---- pick each family's best version on TUNE (per market), then look at TEST ----
    best = (S[S.tune_trades >= 40].sort_values("tune_avg_R", ascending=False).groupby(["family", "sym"]).head(1).sort_values(["family", "sym"]))
    cols = ["family", "sym", "strategy", "tune_trades", "tune_avg_R", "tune_pf", "test_trades", "test_win", "test_avg_R", "test_pf", "test_total_R", "test_max_dd_R", "test_usd_per_trade_1mini"]
    print("\n=== each style's best version on the TUNING period, and how it then did on the untouched TEST period ===")
    print(best[cols].round(3).to_string(index=False))
    rob = S[S.tune_trades >= 40].groupby("family").apply(lambda g: pd.Series(dict(versions=len(g), positive_in_test=(g.test_avg_R > 0).mean(), median_test_avg_R=g.test_avg_R.median(),
                                                                                    positive_in_both=((g.test_avg_R > 0) & (g.tune_avg_R > 0)).mean())))
    print("\n=== robustness: share of ALL versions tried that made money (a real edge shows up in most versions, not one) ===")
    print(rob.round(3).to_string())
    print("\n=== scalping on 1-minute bars (4 weeks: Oct 6 - Nov 2 2026; too short to trust either way) ===")
    print(SC[["sym", "strategy", "trades", "win", "avg_R", "pf", "total_R", "usd_per_trade_1mini", "cost_share_of_avg_risk"]].round(3).to_string(index=False))
    print("\n=== dollar-cost averaging: 1 micro every Monday, held to Nov 3 2026 ===")
    print(DCA.round(0).to_string(index=False))

    # ---- prop account: each style's best version alone, and added to Keel's best $500 mix ----
    sys.path.insert(0, HERE)
    from topstep_static import evaluate
    from portfolio_all import k_trades, fractal_trades, po3_trades
    K = k_trades(); FR = fractal_trades(); B2 = po3_trades("GC", "1h", "RB", "4h EMA20", "below open", "none", "candle close", "GC PO3 1h RB")
    KEEL = pd.concat([K[K.strategy.isin(["K1", "K3", "K4", "K6", "K7"])], FR[FR.entry_t >= K.entry_t.min()], B2])
    tests = {}
    for fam in best.family.unique():
        pick = best[(best.family == fam) & (best.test_trades > 0)]
        if not len(pick): continue
        T = pd.concat([next(t for f, s, t in runs if f == fam and s == r.sym and len(t) and t.strategy.iloc[0] == r.strategy) for r in pick.itertuples()])
        tests[fam] = T[["strategy", "sym", "entry_t", "exit_t", "pts", "stop_pts"]]
    days = sorted({tday(x) for x in pd.concat([KEEL.entry_t, KEEL.exit_t])})
    prop = []
    for name, T in [("Keel best mix (K8 + K9 + K1 + K3 + K4 + K6 + K7)", KEEL)] + [(f"{f} alone", T) for f, T in tests.items()] + [(f"Keel best mix + {f}", pd.concat([KEEL, T])) for f, T in tests.items()]:
        T = T[T.entry_t.map(tday) >= days[0]]
        for risk in (350, 500):
            e = evaluate(daily_series(T, risk, days), 2000)
            prop.append(dict(account=name, risk=risk, **{k: e.get(k) for k in ("pass_pct", "median_days_to_pass", "pass_within_20d", "xfa_first_payout_pct", "median_cash_first60d")}))
    P = pd.DataFrame(prop); P.to_csv(os.path.join(HERE, "results", "bot_styles_topstep50k.csv"), index=False)
    print("\n=== Topstep 50K Static Combine (same rules as Compare mixes), each style's best versions on NQ/GC/ES ===")
    print(P.round(3).to_string(index=False))
