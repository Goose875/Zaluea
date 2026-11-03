"""Setup library v2 = the 9 setups from rmultiple.py + 12 new ones. Each returns (long_signal, short_signal) at bar close."""
import numpy as np, pandas as pd
from common import ema, sma, rsi, atr
from rmultiple import setups as setups_v1

def supertrend_dir(d, n=10, k=3.0):
    a = atr(d, n); hl2 = (d.High + d.Low) / 2
    ub = (hl2 + k * a).values; lb = (hl2 - k * a).values; c = d.Close.values
    fu, fl = ub.copy(), lb.copy(); dirn = np.ones(len(c))
    for i in range(1, len(c)):
        fu[i] = ub[i] if (ub[i] < fu[i-1] or c[i-1] > fu[i-1]) else fu[i-1]
        fl[i] = lb[i] if (lb[i] > fl[i-1] or c[i-1] < fl[i-1]) else fl[i-1]
        dirn[i] = 1 if c[i] > fu[i-1] else (-1 if c[i] < fl[i-1] else dirn[i-1])
    return pd.Series(dirn, index=d.index)

def adx(d, n=14):
    up = d.High.diff(); dn = -d.Low.diff()
    pdm = pd.Series(np.where((up > dn) & (up > 0), up, 0.0), index=d.index)
    ndm = pd.Series(np.where((dn > up) & (dn > 0), dn, 0.0), index=d.index)
    a = atr(d, n)
    pdi = 100 * pdm.ewm(alpha=1/n, adjust=False).mean() / a; ndi = 100 * ndm.ewm(alpha=1/n, adjust=False).mean() / a
    return (100 * (pdi - ndi).abs() / (pdi + ndi)).ewm(alpha=1/n, adjust=False).mean(), pdi, ndi

def setups(d):
    S = {k: (pd.Series(L, index=d.index), pd.Series(Sh, index=d.index)) for k, (L, Sh) in setups_v1(d).items()}
    s = pd.Series(d.sess.values, index=d.index)
    upT = (d.ema20 > d.ema50) & (d.ema50 > d.ema50.shift(5)); dnT = (d.ema20 < d.ema50) & (d.ema50 < d.ema50.shift(5))
    cross_up = lambda x, y: (x > y) & (x.shift() <= y.shift())
    # 1 Keltner breakout
    ku, kl = d.ema20 + 2 * d.atr, d.ema20 - 2 * d.atr
    S["Keltner breakout"] = (cross_up(d.Close, ku), cross_up(kl, d.Close))
    # 2 Supertrend flip
    st = supertrend_dir(d); S["Supertrend flip"] = ((st == 1) & (st.shift() == -1), (st == -1) & (st.shift() == 1))
    # 3 MACD cross with trend
    mc = ema(d.Close, 12) - ema(d.Close, 26); sg = ema(mc, 9)
    S["MACD cross with trend"] = (cross_up(mc, sg) & (d.Close > d.ema50) & (mc < 0), cross_up(sg, mc) & (d.Close < d.ema50) & (mc > 0))
    # 4 ADX pullback to EMA20
    ax, pdi, ndi = adx(d)
    S["ADX>25 pullback to EMA20"] = ((ax > 25) & (pdi > ndi) & (d.Low <= d.ema20) & (d.Close > d.ema20),
                                     (ax > 25) & (ndi > pdi) & (d.High >= d.ema20) & (d.Close < d.ema20))
    # 5 Heikin-Ashi flip with trend
    hc = (d.Open + d.High + d.Low + d.Close) / 4; hov = hc.values.copy(); ov = d.Open.values; cv = d.Close.values
    hov[0] = (ov[0] + cv[0]) / 2
    for i in range(1, len(hov)): hov[i] = (hov[i-1] + hc.values[i-1]) / 2
    green = hc > pd.Series(hov, index=d.index)
    S["Heikin-Ashi flip with trend"] = (green & ~green.shift(fill_value=False) & upT, ~green & green.shift(fill_value=False) & dnT)
    # 6 3-bar pullback in trend
    lh = (d.High < d.High.shift()) ; hl_ = (d.Low > d.Low.shift())
    lh3 = lh.shift() & lh.shift(2) & lh.shift(3); hl3 = hl_.shift() & hl_.shift(2) & hl_.shift(3)
    S["3-bar pullback then break"] = (upT & lh3 & (d.Close > d.High.shift()), dnT & hl3 & (d.Close < d.Low.shift()))
    # 7 Squeeze breakout (BB inside Keltner >= 5 bars)
    mid = sma(d.Close, 20); sd = d.Close.rolling(20).std()
    sq = ((mid + 2 * sd) < (d.ema20 + 1.5 * d.atr)) & ((mid - 2 * sd) > (d.ema20 - 1.5 * d.atr))
    was_sq = sq.shift().rolling(5).min() == 1
    S["Squeeze breakout"] = (was_sq & ~sq & (d.Close > mid + 2 * sd), was_sq & ~sq & (d.Close < mid - 2 * sd))
    # 8 NR7 breakout
    rng = d.High - d.Low; nr7 = (rng == rng.rolling(7).min()).shift(fill_value=False)
    S["NR7 breakout"] = (nr7 & (d.Close > d.High.shift()), nr7 & (d.Close < d.Low.shift()))
    # 9 RSI14 50-cross with trend
    r14 = rsi(d.Close, 14)
    S["RSI14 50-cross with trend"] = (cross_up(r14, pd.Series(50.0, index=d.index)) & upT, cross_up(pd.Series(50.0, index=d.index), r14) & dnT)
    # 10 VWAP cross with trend
    S["VWAP cross with trend"] = (cross_up(d.Close, d.vwap) & upT, cross_up(d.vwap, d.Close) & dnT)
    # 11 Opening drive continuation: OR closes in top/bottom 25% of its range -> signal on last OR bar
    last_or = d.after_or & ~d.after_or.shift(fill_value=False)
    orpos = (d.Close.shift() - d.orl) / (d.orh - d.orl).replace(0, np.nan)
    S["Opening drive continuation"] = (last_or & (orpos > 0.75), last_or & (orpos < 0.25))
    # 12 Engulfing at EMA20 in trend
    bull_eng = (d.Close > d.Open) & (d.Close.shift() < d.Open.shift()) & (d.Close > d.Open.shift()) & (d.Open <= d.Close.shift())
    bear_eng = (d.Close < d.Open) & (d.Close.shift() > d.Open.shift()) & (d.Close < d.Open.shift()) & (d.Open >= d.Close.shift())
    S["Engulfing at EMA20 in trend"] = (bull_eng & upT & (d.Low <= d.ema20 + 0.25 * d.atr), bear_eng & dnT & (d.High >= d.ema20 - 0.25 * d.atr))
    return {k: (L.fillna(False).values.astype(bool), Sh.fillna(False).values.astype(bool)) for k, (L, Sh) in S.items()}
