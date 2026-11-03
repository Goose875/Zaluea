"""Entry-model x stop-model x R-multiple research.

For every SETUP (signal) we test 5 ENTRY MODELS, 3 STOP MODELS and targets of 1R..5R (R = entry-to-stop risk).
Walk-forward: everything is ranked on IN-SAMPLE only; OUT-OF-SAMPLE is used only to judge.
Datasets
  * 5m  : Dec-2026 contracts (NQZ26/ESZ26/GCZ26), regular hours. IS to Oct 14 2026, OOS Oct 15 - Nov 2 2026
  * 1h  : continuous front month, full Globex session. IS Jun 2024 - Sep 2025, OOS Oct 2025 - Nov 2 2026
Fill model (conservative)
  * MKT entry next open +1 tick; STOP entry trigger +1 tick (or open if gapped); LIMIT entries only fill if price
    trades 1 tick THROUGH the limit; entry orders expire after 3 bars
  * stop exit -1 tick (or bar open if gapped through); target = limit, needs 1-tick trade-through
  * on the fill bar of a stop/limit entry only the stop can be hit (target cannot) - conservative
  * if stop & target are in the same bar -> stop first; flat at session end; $2.50 commission per side
  * minimum risk 4 ticks"""
import numpy as np, pandas as pd, itertools, sys
from numba import njit
from common import SPECS, load, ema, rsi, atr, sma

ENTRY = ["Market next open", "Stop above signal bar", "Limit @ signal-bar 50%", "Limit @ close-0.5ATR", "Confirm close beyond bar"]
STOPM = ["Signal-bar extreme", "1.0 x ATR", "5-bar swing"]
RS = [1.0, 1.5, 2.0, 3.0, 4.0, 5.0]

@njit(cache=True)
def engine(o, h, l, c, a, sess, sigL, sigS, emodel, smodel, k, tick, mult, comm):
    n = len(o); res = np.zeros((n, 5)); m = 0; i = 0
    while i < n - 2:
        side = 1 if sigL[i] else (-1 if sigS[i] else 0)
        if side == 0 or not np.isfinite(a[i]) or a[i] <= 0: i += 1; continue
        # ---- entry ----
        fill = -1; e = 0.0
        if emodel == 0:
            if sess[i + 1] == sess[i]: fill = i + 1; e = o[i + 1] + side * tick
        elif emodel == 1:
            trig = h[i] + tick if side == 1 else l[i] - tick
            for j in range(i + 1, min(i + 4, n)):
                if sess[j] != sess[i]: break
                if side == 1 and o[j] >= trig: fill = j; e = o[j] + tick; break
                if side == 1 and h[j] >= trig: fill = j; e = trig + tick; break
                if side == -1 and o[j] <= trig: fill = j; e = o[j] - tick; break
                if side == -1 and l[j] <= trig: fill = j; e = trig - tick; break
        elif emodel == 2 or emodel == 3:
            px = (h[i] + l[i]) / 2 if emodel == 2 else c[i] - side * 0.5 * a[i]
            px = np.round(px / tick) * tick
            for j in range(i + 1, min(i + 4, n)):
                if sess[j] != sess[i]: break
                if side == 1 and o[j] <= px: fill = j; e = o[j]; break
                if side == 1 and l[j] <= px - tick: fill = j; e = px; break
                if side == -1 and o[j] >= px: fill = j; e = o[j]; break
                if side == -1 and h[j] >= px + tick: fill = j; e = px; break
        else:
            j = i + 1
            if j + 1 < n and sess[j + 1] == sess[i] and ((side == 1 and c[j] > h[i]) or (side == -1 and c[j] < l[i])):
                fill = j + 1; e = o[j + 1] + side * tick
        if fill < 0: i += 1; continue
        # ---- stop ----
        if smodel == 0: stp = l[i] - tick if side == 1 else h[i] + tick
        elif smodel == 1: stp = e - side * a[i]
        else:
            lo = l[i]; hi = h[i]
            for q in range(max(0, i - 4), i + 1):
                lo = min(lo, l[q]); hi = max(hi, h[q])
            stp = lo - tick if side == 1 else hi + tick
        risk = (e - stp) * side
        if risk < 4 * tick: risk = 4 * tick
        stp = e - side * risk
        tgt = np.round((e + side * k * risk) / tick) * tick
        # ---- manage ----
        j = fill; ex = 0.0
        while True:
            hs = (l[j] <= stp) if side == 1 else (h[j] >= stp)
            if hs:
                ex = (min(stp, o[j]) if (side == 1 and j > fill) else (max(stp, o[j]) if j > fill else stp)) - side * tick
                break
            can_t = (j > fill) or emodel == 0 or emodel == 4
            ht = ((h[j] >= tgt + tick) if side == 1 else (l[j] <= tgt - tick)) and can_t
            if ht: ex = tgt; break
            if j + 1 >= n or sess[j + 1] != sess[j]: ex = c[j] - side * tick; break
            j += 1
        pnl = side * (ex - e) * mult - 2 * comm
        res[m, 0] = i; res[m, 1] = side; res[m, 2] = pnl; res[m, 3] = pnl / (risk * mult); res[m, 4] = j - fill + 1
        m += 1; i = j + 1
    return res[:m]

# ----------------------------- data prep -----------------------------
def prep_5m(sym):
    d = load(f"{sym}Z26_5m.csv", tz=True)
    start = "2026-08-27" if sym == "GC" else "2026-09-14"
    d = d[(d.index >= start) & (d.index < "2026-11-03")]
    m = d.index.hour * 60 + d.index.minute; o0, c0 = (500, 810) if sym == "GC" else (570, 960)
    d = d[(m >= o0) & (m < c0)].copy(); d["sess"] = d.index.date
    return finish(d, or_bars=3), "2026-10-14", "2026-10-15"

def prep_1h(sym):
    d = load(f"{sym}_cont_1h.csv", tz=True); d = d[d.index < "2026-11-03"].copy()
    d["sess"] = (d.index + pd.Timedelta(hours=6)).date          # Globex day starts 18:00 ET
    return finish(d, or_bars=None, rth_hour=8 if sym == "GC" else 9), "2025-09-30", "2025-10-01"

def finish(d, or_bars=3, rth_hour=None):
    s = pd.Series(d.sess.values, index=d.index)
    tp = (d.High + d.Low + d.Close) / 3
    d["vwap"] = (tp * d.Volume).groupby(s).cumsum() / d.Volume.groupby(s).cumsum().replace(0, np.nan)
    d["vwap"] = d.vwap.fillna(d.Close)
    for n in (9, 20, 21, 50): d[f"ema{n}"] = ema(d.Close, n)
    d["rsi2"] = rsi(d.Close, 2); d["atr"] = atr(d, 14); d["volavg"] = d.Volume.rolling(30).mean()
    if or_bars:
        first = s.groupby(s).cumcount() < or_bars
    else:
        first = pd.Series(d.index.hour == rth_hour, index=d.index)
    d["orh"] = d.High.where(first).groupby(s).transform("max"); d["orl"] = d.Low.where(first).groupby(s).transform("min")
    d["after_or"] = (~first) & first.groupby(s).cummax()
    d["sess_id"] = pd.factorize(d.sess)[0]
    return d

# ----------------------------- setups -----------------------------
def setups(d):
    s = pd.Series(d.sess.values, index=d.index)
    upT = (d.ema20 > d.ema50) & (d.ema50 > d.ema50.shift(5)); dnT = (d.ema20 < d.ema50) & (d.ema50 < d.ema50.shift(5))
    S = {}
    S["Trend pullback RSI(2)"] = (upT & (d.Close > d.vwap) & (d.Close > d.ema50) & (d.rsi2 < 10),
                                  dnT & (d.Close < d.vwap) & (d.Close < d.ema50) & (d.rsi2 > 90))
    ub = d.after_or & (d.Close > d.orh); db = d.after_or & (d.Close < d.orl)
    S["Opening-range breakout"] = (ub & ~(ub.groupby(s).shift(fill_value=False).groupby(s).cummax()),
                                   db & ~(db.groupby(s).shift(fill_value=False).groupby(s).cummax()))
    a20 = (d.Low > d.vwap).astype(int).shift().rolling(20).min() == 1; b20 = (d.High < d.vwap).astype(int).shift().rolling(20).min() == 1
    S["VWAP first touch (trend day)"] = (a20 & (d.Low <= d.vwap) & (d.Close > d.vwap), b20 & (d.High >= d.vwap) & (d.Close < d.vwap))
    pl = d.Low.rolling(20).min().shift(); ph = d.High.rolling(20).max().shift()
    S["Liquidity sweep & reclaim"] = ((d.Low < pl) & (d.Close > pl) & (d.Close > d.Open), (d.High > ph) & (d.Close < ph) & (d.Close < d.Open))
    cu = (d.ema9 > d.ema21) & (d.ema9.shift() <= d.ema21.shift()); cd = (d.ema9 < d.ema21) & (d.ema9.shift() >= d.ema21.shift())
    S["EMA 9/21 cross with trend"] = (cu & (d.Close > d.ema50), cd & (d.Close < d.ema50))
    rng = d.High - d.Low; pos = (d.Close - d.Low) / rng.replace(0, np.nan)
    big = (rng > 2 * d.atr.shift()) & (d.Volume > 1.5 * d.volavg.shift())
    S["Momentum burst"] = (big & (pos > 0.8), big & (pos < 0.2))
    inside = (d.High.shift() < d.High.shift(2)) & (d.Low.shift() > d.Low.shift(2))
    S["Inside-bar break in trend"] = (inside & upT & (d.Close > d.High.shift(2)), inside & dnT & (d.Close < d.Low.shift(2)))
    mid = sma(d.Close, 20); sd = d.Close.rolling(20).std()
    S["Bollinger snap-back"] = ((d.Close.shift() < (mid - 2 * sd).shift()) & (d.Close > mid - 2 * sd),
                                (d.Close.shift() > (mid + 2 * sd).shift()) & (d.Close < mid + 2 * sd))
    S["Donchian 20 breakout"] = ((d.Close > ph) & (d.Close.shift() <= ph.shift()), (d.Close < pl) & (d.Close.shift() >= pl.shift()))
    return {k: (L.fillna(False).values, Sh.fillna(False).values) for k, (L, Sh) in S.items()}

def run_one(d, L, S, sym, em, sm, k):
    sp = SPECS[sym]
    return engine(d.Open.values, d.High.values, d.Low.values, d.Close.values, d.atr.values.astype(float),
                  d.sess_id.values.astype(np.int64), L, S, em, sm, k, sp["tick"], float(sp["mult"]), sp["comm"])

def summarize(r):
    if len(r) == 0: return dict(n=0, win=np.nan, avgR=np.nan, pnl=0.0, pf=np.nan, maxdd=0.0)
    p = r[:, 2]; g, ls = p[p > 0].sum(), -p[p < 0].sum(); eq = np.cumsum(p)
    return dict(n=len(p), win=(p > 0).mean(), avgR=r[:, 3].mean(), pnl=p.sum(), pf=g / ls if ls > 0 else np.inf,
                maxdd=(eq - np.maximum.accumulate(eq)).min())

def full_grid(tf):
    rows = []
    for sym in ("NQ", "ES", "GC"):
        d, ise, oss = (prep_5m if tf == "5m" else prep_1h)(sym)
        cut = int((d.index <= pd.Timestamp(ise + " 23:59", tz="America/New_York")).sum())
        sig = setups(d)
        for name, (L, S) in sig.items():
            for em, sm, k in itertools.product(range(5), range(3), RS):
                r = run_one(d, L, S, sym, em, sm, k)
                isr, oosr = r[r[:, 0] < cut], r[r[:, 0] >= cut]
                a, b = summarize(isr), summarize(oosr)
                rows.append(dict(tf=tf, symbol=sym, setup=name, entry=ENTRY[em], stop=STOPM[sm], R=k,
                                 **{f"IS_{x}": v for x, v in a.items()}, **{f"OOS_{x}": v for x, v in b.items()}))
        print(tf, sym, "done", file=sys.stderr)
    return pd.DataFrame(rows)

if __name__ == "__main__":
    import os
    os.makedirs("results", exist_ok=True)
    for tf in ("5m", "1h"):
        df = full_grid(tf); df.to_csv(f"results/rmultiple_{tf}.csv", index=False); print(tf, len(df), "combos")
