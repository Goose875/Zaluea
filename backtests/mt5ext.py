"""MQL5 CodeBase strategy families not covered by earlier searches (catalogue of 1,713 MT5 experts, see MT5NT.md):
Bill Williams Alligator / Fractals, ZigZag-Fibonacci retracements, candlestick patterns, volume (OBV, MFI, volume-spike),
Hull / VIDYA / T3 averages, z-score mean reversion, linear-regression slope, and popular CodeBase combos
(MACD + EMA200, RSI + EMA200, ADX + DI cross, Alligator + Fractal). Same runs and splits as mt5nt.py."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd, sys, warnings
warnings.filterwarnings("ignore")
from common import ema, sma, rsi, atr
import mt5nt
from mt5nt import cross_up, turn_up, turn_dn

def smma(x, n): return x.ewm(alpha=1 / n, adjust=False).mean()
def wma(x, n): w = np.arange(1, n + 1); return x.rolling(n).apply(lambda v: np.dot(v, w) / w.sum(), raw=True)
def hull(x, n=20): return wma(2 * wma(x, n // 2) - wma(x, n), int(np.sqrt(n)))
def vidya(c, n=14, k=9):
    cmo_up = c.diff().clip(lower=0).rolling(k).sum(); cmo_dn = (-c.diff().clip(upper=0)).rolling(k).sum()
    cmo = ((cmo_up - cmo_dn) / (cmo_up + cmo_dn).replace(0, np.nan)).abs().fillna(0).values; a = 2 / (n + 1); out = np.full(len(c), np.nan); v = c.values
    for i in range(1, len(v)): out[i] = v[i] if np.isnan(out[i - 1]) else out[i - 1] + a * cmo[i] * (v[i] - out[i - 1])
    return pd.Series(out, index=c.index)
def t3(c, n=8, v=0.7):
    e1 = ema(c, n); e2 = ema(e1, n); e3 = ema(e2, n); e4 = ema(e3, n); e5 = ema(e4, n); e6 = ema(e5, n)
    a = v; c1, c2, c3, c4 = -a ** 3, 3 * a ** 2 + 3 * a ** 3, -6 * a ** 2 - 3 * a - 3 * a ** 3, 1 + 3 * a + a ** 3 + 3 * a ** 2
    return c1 * e6 + c2 * e5 + c3 * e4 + c4 * e3

def ext_triggers(d, sym, n_random=20):
    c, o, h, l, v = d.Close, d.Open, d.High, d.Low, d.Volume.astype(float)
    F = lambda: pd.Series(False, index=d.index); T = {}
    mp = (h + l) / 2; jaw = smma(mp, 13).shift(8); teeth = smma(mp, 8).shift(5); lips = smma(mp, 5).shift(3)
    up_m = (lips > teeth) & (teeth > jaw); dn_m = (lips < teeth) & (teeth < jaw)
    T["BW Alligator: mouth opens"] = (up_m & ~up_m.shift(fill_value=False), dn_m & ~dn_m.shift(fill_value=False))
    # Fractals (2 bars each side), usable 2 bars later; breakout of the last confirmed fractal
    fu = (h.shift(2) > h.shift(3)) & (h.shift(2) > h.shift(4)) & (h.shift(2) > h.shift(1)) & (h.shift(2) > h)
    fd = (l.shift(2) < l.shift(3)) & (l.shift(2) < l.shift(4)) & (l.shift(2) < l.shift(1)) & (l.shift(2) < l)
    lastU = h.shift(2).where(fu).ffill(); lastD = l.shift(2).where(fd).ffill()
    fbu = cross_up(c, lastU); fbd = cross_up(lastD, c)
    T["BW Fractal breakout"] = (fbu, fbd)
    T["BW Fractal breakout + Alligator (above teeth)"] = (fbu & (c > teeth) & up_m, fbd & (c < teeth) & dn_m)
    # ZigZag-like swings (ATR-threshold), Fibonacci 61.8% retracement touch in the swing's direction
    a14 = atr(d, 14).values; cc = c.values; n = len(cc); piv = np.full(n, np.nan); kind = np.zeros(n); last = cc[0]; trend = 0; ext = cc[0]; ext_i = 0
    lastH = np.full(n, np.nan); lastL = np.full(n, np.nan); H_, L_ = np.nan, np.nan
    for i in range(1, n):
        thr = 3 * a14[i] if a14[i] == a14[i] else 0
        if trend >= 0:
            if cc[i] > ext: ext, ext_i = cc[i], i
            elif ext - cc[i] > thr and thr > 0: H_ = ext; trend = -1; ext, ext_i = cc[i], i
        if trend < 0:
            if cc[i] < ext: ext, ext_i = cc[i], i
            elif cc[i] - ext > thr and thr > 0: L_ = ext; trend = 1; ext, ext_i = cc[i], i
        lastH[i], lastL[i], kind[i] = H_, L_, trend
    lh, ll_ = pd.Series(lastH, index=d.index), pd.Series(lastL, index=d.index); tr_ = pd.Series(kind, index=d.index)
    fib_up = ll_ + 0.382 * (lh - ll_); fib_dn = lh - 0.382 * (lh - ll_)        # 61.8% retracement of the last up / down leg
    T["ZigZag Fibonacci 61.8% retracement"] = ((tr_ > 0) & (l <= fib_up) & (c > fib_up) & (lh > ll_), (tr_ < 0) & (h >= fib_dn) & (c < fib_dn) & (lh > ll_))
    # Candlesticks
    body = (c - o).abs(); rng = (h - l).replace(0, np.nan); lower = np.minimum(o, c) - l; upper = h - np.maximum(o, c)
    low20 = l.rolling(20).min(); high20 = h.rolling(20).max()
    T["Candle: hammer / shooting star at 20-bar extreme"] = ((lower > 2 * body) & (upper < body) & (l <= low20), (upper > 2 * body) & (lower < body) & (h >= high20))
    T["Candle: pin bar (66% wick) at 20-bar extreme"] = ((lower / rng > 0.66) & (l <= low20), (upper / rng > 0.66) & (h >= high20))
    T["Candle: harami"] = ((c.shift() < o.shift()) & (c > o) & (o > c.shift()) & (c < o.shift()), (c.shift() > o.shift()) & (c < o) & (o < c.shift()) & (c > o.shift()))
    T["Candle: morning / evening star"] = ((c.shift(2) < o.shift(2)) & (body.shift() < 0.3 * body.shift(2)) & (c > o) & (c > (o.shift(2) + c.shift(2)) / 2),
                                          (c.shift(2) > o.shift(2)) & (body.shift() < 0.3 * body.shift(2)) & (c < o) & (c < (o.shift(2) + c.shift(2)) / 2))
    T["Candle: three white soldiers / black crows"] = ((c > o) & (c.shift() > o.shift()) & (c.shift(2) > o.shift(2)) & (c > c.shift()) & (c.shift() > c.shift(2)),
                                                      (c < o) & (c.shift() < o.shift()) & (c.shift(2) < o.shift(2)) & (c < c.shift()) & (c.shift() < c.shift(2)))
    T["Candle: outside bar reversal"] = ((h > h.shift()) & (l < l.shift()) & (c > h.shift()), (h > h.shift()) & (l < l.shift()) & (c < l.shift()))
    T["Candle: doji after 3-bar move"] = ((body / rng < 0.1) & (c.shift() < c.shift(4)), (body / rng < 0.1) & (c.shift() > c.shift(4)))
    # Volume
    obv = (np.sign(c.diff()).fillna(0) * v).cumsum(); T["Volume: OBV crosses its SMA(20)"] = (cross_up(obv, sma(obv, 20)), cross_up(sma(obv, 20), obv))
    tp = (h + l + c) / 3; mf = tp * v; pos = mf.where(tp > tp.shift(), 0).rolling(14).sum(); neg = mf.where(tp < tp.shift(), 0).rolling(14).sum()
    mfi = 100 - 100 / (1 + pos / neg.replace(0, np.nan)); T["Volume: MFI reverse beyond 20/80"] = (turn_up(mfi) & (mfi < 20), turn_dn(mfi) & (mfi > 80))
    va = v.rolling(20).mean(); T["Volume: spike breakout (2x avg)"] = ((v > 2 * va) & (c > h.shift()), (v > 2 * va) & (c < l.shift()))
    # Other averages
    hm = hull(c); T["Hull MA(20): slope turns"] = (turn_up(hm), turn_dn(hm))
    vd = vidya(c); T["VIDYA(14): price crosses"] = (cross_up(c, vd), cross_up(vd, c))
    t3s = t3(c); T["T3(8): slope turns"] = (turn_up(t3s), turn_dn(t3s))
    # Statistical
    z = (c - sma(c, 20)) / c.rolling(20).std(); T["Z-score(20) beyond +-2: revert"] = (cross_up(z, -2 + 0 * z), cross_up(2 + 0 * z, z))
    slope = c.rolling(20).apply(lambda y: np.polyfit(np.arange(len(y)), y, 1)[0], raw=True); T["Linear regression slope(20) turns"] = (cross_up(slope, 0 * slope), cross_up(0 * slope, slope))
    # Popular CodeBase combos
    m = ema(c, 12) - ema(c, 26); sg = ema(m, 9); e200 = ema(c, 200); r = rsi(c, 14)
    T["Combo: MACD cross below zero + EMA200 trend"] = (cross_up(m, sg) & (m < 0) & (c > e200), cross_up(sg, m) & (m > 0) & (c < e200))
    T["Combo: RSI(14) < 30 + EMA200 trend"] = (cross_up(r, 30 + 0 * r) & (c > e200), cross_up(70 + 0 * r, r) & (c < e200))
    up_ = h.diff(); dn_ = -l.diff(); a = atr(d, 14)
    pdi = 100 * pd.Series(np.where((up_ > dn_) & (up_ > 0), up_, 0.0), index=d.index).ewm(alpha=1 / 14, adjust=False).mean() / a
    ndi = 100 * pd.Series(np.where((dn_ > up_) & (dn_ > 0), dn_, 0.0), index=d.index).ewm(alpha=1 / 14, adjust=False).mean() / a
    adx = (100 * (pdi - ndi).abs() / (pdi + ndi)).ewm(alpha=1 / 14, adjust=False).mean()
    T["Combo: DI cross with ADX > 20"] = (cross_up(pdi, ndi) & (adx > 20), cross_up(ndi, pdi) & (adx > 20))
    rng_ = np.random.default_rng(abs(hash(sym + "ext")) % 2**32)
    for i in range(n_random):
        p = rng_.uniform(0.01, 0.05); x = rng_.random(len(d)); T[f"RANDOM #{i:02d}"] = (pd.Series(x < p / 2, index=d.index), pd.Series((x >= p / 2) & (x < p), index=d.index))
    return {k: (np.nan_to_num(np.asarray(v_[0], float)).astype(bool), np.nan_to_num(np.asarray(v_[1], float)).astype(bool)) for k, v_ in T.items()}

if __name__ == "__main__":
    mt5nt.triggers = ext_triggers                     # reuse the runner with the new trigger set
    import builtins
    orig_open = builtins.open
    def renamed(path, *a, **k):                       # write results under mt5ext_* instead of mt5nt_*
        return orig_open(path.replace("results/mt5nt_", "results/mt5ext_") if isinstance(path, str) else path, *a, **k)
    builtins.open = renamed
    _to_csv = pd.DataFrame.to_csv
    pd.DataFrame.to_csv = lambda self, path, *a, **k: _to_csv(self, path.replace("results/mt5nt_", "results/mt5ext_") if isinstance(path, str) else path, *a, **k)
    for tf in sys.argv[1:] or ["daily", "1h"]: mt5nt.run(tf)
