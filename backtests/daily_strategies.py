"""Daily-bar strategy library. Each returns either
   - a pd.Series signal (+1/0/-1) decided at the CLOSE of bar t, filled at the next OPEN, or
   - dict(on=..., day=...) explicit position for the overnight (prev close->open) and day (open->close) segment, or
   - dict(custom=DataFrame[ret, pts, trade]) for intraday stop-entry day trades (exit at close)."""
import numpy as np, pandas as pd
from common import sma, ema, rsi, atr, hold

def buy_hold(d): return pd.Series(1.0, index=d.index)

def sma_cross_long(f, s):
    def st(d): return (sma(d.Close, f) > sma(d.Close, s)).astype(float)
    return st
def sma_cross_ls(f, s):
    def st(d): return np.sign(sma(d.Close, f) - sma(d.Close, s)).fillna(0)
    return st
def ema_cross_ls(f, s):
    def st(d): return np.sign(ema(d.Close, f) - ema(d.Close, s))
    return st

def above_sma(n):
    def st(d): return (d.Close > sma(d.Close, n)).astype(float)
    return st

def macd_ls(d):
    m = ema(d.Close, 12) - ema(d.Close, 26)
    return np.sign(m - ema(m, 9))

def macd_long_zero(d):  # MACD cross, long only, only when MACD line > 0
    m = ema(d.Close, 12) - ema(d.Close, 26)
    return ((m > ema(m, 9)) & (m > 0)).astype(float)

def rsi14_classic(d):  # buy oversold <30, sell overbought >70 (long only)
    r = rsi(d.Close, 14)
    return hold(r < 30, r > 70)

def rsi14_ls(d):
    r = rsi(d.Close, 14)
    return hold(r < 30, r > 70, r > 70, r < 30)

def connors_rsi2(d):  # Larry Connors: above 200SMA, RSI2<10 buy; exit close > 5SMA
    r = rsi(d.Close, 2); s200 = sma(d.Close, 200); s5 = sma(d.Close, 5)
    return hold((d.Close > s200) & (r < 10), d.Close > s5)

def connors_rsi2_ls(d):
    r = rsi(d.Close, 2); s200 = sma(d.Close, 200); s5 = sma(d.Close, 5)
    return hold((d.Close > s200) & (r < 10), d.Close > s5, (d.Close < s200) & (r > 90), d.Close < s5)

def boll_revert(d):  # buy close below lower band, exit at middle band
    m = sma(d.Close, 20); sd = d.Close.rolling(20).std()
    return hold(d.Close < m - 2 * sd, d.Close > m)

def boll_breakout_ls(d):
    m = sma(d.Close, 20); sd = d.Close.rolling(20).std()
    return hold(d.Close > m + 2 * sd, d.Close < m, d.Close < m - 2 * sd, d.Close > m)

def donchian(n_in, n_out):  # Turtle Trading systems
    def st(d):
        hi = d.High.rolling(n_in).max().shift(); lo = d.Low.rolling(n_in).min().shift()
        xhi = d.High.rolling(n_out).max().shift(); xlo = d.Low.rolling(n_out).min().shift()
        return hold(d.Close > hi, d.Close < xlo, d.Close < lo, d.Close > xhi)
    return st

def keltner_ls(d):
    m = ema(d.Close, 20); a = atr(d, 10)
    return hold(d.Close > m + 2 * a, d.Close < m, d.Close < m - 2 * a, d.Close > m)

def supertrend(n=10, k=3):
    def st(d):
        a = atr(d, n); hl2 = (d.High + d.Low) / 2
        ub = (hl2 + k * a).values; lb = (hl2 - k * a).values; c = d.Close.values
        fu, fl = ub.copy(), lb.copy(); dirn = np.ones(len(c))
        for i in range(1, len(c)):
            fu[i] = ub[i] if (ub[i] < fu[i-1] or c[i-1] > fu[i-1]) else fu[i-1]
            fl[i] = lb[i] if (lb[i] > fl[i-1] or c[i-1] < fl[i-1]) else fl[i-1]
            dirn[i] = 1 if c[i] > fu[i-1] else (-1 if c[i] < fl[i-1] else dirn[i-1])
        return pd.Series(dirn, index=d.index)
    return st

def tsmom(n=252):  # time-series momentum (Moskowitz/Ooi/Pedersen)
    def st(d): return np.sign(d.Close / d.Close.shift(n) - 1).fillna(0)
    return st

def ibs(d):  # internal bar strength mean reversion
    x = (d.Close - d.Low) / (d.High - d.Low).replace(0, np.nan)
    return hold(x < 0.2, x > 0.8)

def three_down(d):
    dn = d.Close < d.Close.shift()
    return hold(dn & dn.shift(1, fill_value=False) & dn.shift(2, fill_value=False), d.Close > d.Close.shift())

def turn_of_month(d):  # long from close of 2nd-to-last day -> close of 3rd trading day of new month
    idx = d.index; m = idx.to_period("M")
    rank = pd.Series(1, index=idx).groupby(m).cumsum()
    rev = pd.Series(1, index=idx)[::-1].groupby(m[::-1]).cumsum()[::-1]
    # signal at close t means held next day; hold on last day (rev==1) and days 1..3
    return ((rev == 2) | (rev == 1) | (rank <= 2)).astype(float)

def overnight(d): return dict(on=pd.Series(1.0, index=d.index), day=pd.Series(0.0, index=d.index))
def intraday(d):  return dict(on=pd.Series(0.0, index=d.index), day=pd.Series(1.0, index=d.index))

def stochastic_ls(d):
    k = 100 * (d.Close - d.Low.rolling(14).min()) / (d.High.rolling(14).max() - d.Low.rolling(14).min())
    k = k.rolling(3).mean(); dd = k.rolling(3).mean()
    up = (k > dd) & (k.shift() <= dd.shift()) & (k < 20)
    dn = (k < dd) & (k.shift() >= dd.shift()) & (k > 80)
    return hold(up, dn, dn, up)

def adx_di(d, n=14):
    up = d.High.diff(); dn = -d.Low.diff()
    pdm = pd.Series(np.where((up > dn) & (up > 0), up, 0), index=d.index)
    ndm = pd.Series(np.where((dn > up) & (dn > 0), dn, 0), index=d.index)
    a = atr(d, n)
    pdi = 100 * pdm.ewm(alpha=1/n, adjust=False).mean() / a
    ndi = 100 * ndm.ewm(alpha=1/n, adjust=False).mean() / a
    dx = 100 * (pdi - ndi).abs() / (pdi + ndi)
    adx = dx.ewm(alpha=1/n, adjust=False).mean()
    return np.sign(pdi - ndi) * (adx > 25)

def psar(d, step=0.02, mx=0.2):
    h, l = d.High.values, d.Low.values; n = len(h)
    pos = np.ones(n); sar = l[0]; ep = h[0]; af = step; up = True
    for i in range(1, n):
        sar = sar + af * (ep - sar)
        if up:
            sar = min(sar, l[i-1], l[i-2] if i > 1 else l[i-1])
            if l[i] < sar: up, sar, ep, af = False, ep, l[i], step
            elif h[i] > ep: ep, af = h[i], min(af + step, mx)
        else:
            sar = max(sar, h[i-1], h[i-2] if i > 1 else h[i-1])
            if h[i] > sar: up, sar, ep, af = True, ep, h[i], step
            elif l[i] < ep: ep, af = l[i], min(af + step, mx)
        pos[i] = 1 if up else -1
    return pd.Series(pos, index=d.index)

def ichimoku(d):
    t = (d.High.rolling(9).max() + d.Low.rolling(9).min()) / 2
    k = (d.High.rolling(26).max() + d.Low.rolling(26).min()) / 2
    sa = ((t + k) / 2).shift(26); sb = ((d.High.rolling(52).max() + d.Low.rolling(52).min()) / 2).shift(26)
    top = np.maximum(sa, sb); bot = np.minimum(sa, sb)
    return pd.Series(np.where((d.Close > top) & (t > k), 1, np.where((d.Close < bot) & (t < k), -1, 0)), index=d.index)

def heikin_ashi(d):
    hc = (d.Open + d.High + d.Low + d.Close) / 4
    o = d.Open.values; c = hc.values; hov = hc.values.copy()
    hov[0] = (o[0] + d.Close.values[0]) / 2
    for i in range(1, len(hov)): hov[i] = (hov[i-1] + c[i-1]) / 2
    return np.sign(hc - pd.Series(hov, index=d.index))

def dual_ma_vol_target(d):  # 50/200 trend, sized to 15% annual vol (cap 2x)
    s = (sma(d.Close, 50) > sma(d.Close, 200)).astype(float)
    v = d.Close.pct_change().rolling(20).std() * np.sqrt(252)
    return (s * (0.15 / v).clip(upper=2)).fillna(0)

# ---------- intraday-entry day trades (stop entry, exit at close) ----------
def _daytrade(d, long_lvl=None, short_lvl=None):
    """Stop entry at long_lvl / short_lvl (or at the open if it gaps through), exit at the close.
    Daily bars can't tell which level traded first when BOTH are touched, so on those days we
    book the WORSE of the two possible trades (no look-ahead benefit)."""
    o, h, l, c = d.Open, d.High, d.Low, d.Close
    idx = d.index; nan = pd.Series(np.nan, index=idx)
    lh = (h >= long_lvl) if long_lvl is not None else pd.Series(False, index=idx)
    sh = (l <= short_lvl) if short_lvl is not None else pd.Series(False, index=idx)
    le = np.maximum(o, long_lvl) if long_lvl is not None else nan
    se = np.minimum(o, short_lvl) if short_lvl is not None else nan
    lp = (c - le).where(lh); sp = (se - c).where(sh)
    both = lh & sh
    use_long = lh & (~both | (lp <= sp))
    use_short = sh & ~use_long
    pts = pd.Series(0.0, index=idx).mask(use_long, lp).mask(use_short, sp)
    side = pd.Series(0.0, index=idx).mask(use_long, 1.0).mask(use_short, -1.0)
    entry = le.where(use_long, se)
    return dict(custom=pd.DataFrame(dict(pts=pts, side=side, entry=entry)))

def williams_vol_breakout(k=0.6, ls=True):
    def st(d):
        rng = (d.High - d.Low).shift()
        return _daytrade(d, d.Open + k * rng, (d.Open - k * rng) if ls else None)
    return st

def nr7_breakout(d):
    rng = d.High - d.Low; nr7 = (rng == rng.rolling(7).min()).shift(fill_value=False)
    lv = d.High.shift().where(nr7); sv = d.Low.shift().where(nr7)
    return _daytrade(d, lv, sv)

def gap_fade(d):  # fade opening gaps > 0.3%, target previous close, else exit at close
    pc = d.Close.shift(); gap = d.Open / pc - 1
    pts = pd.Series(0.0, index=d.index); side = pd.Series(0.0, index=d.index)
    up = gap > 0.003; dn = gap < -0.003
    pts[up] = np.where(d.Low[up] <= pc[up], d.Open[up] - pc[up], d.Open[up] - d.Close[up]); side[up] = -1
    pts[dn] = np.where(d.High[dn] >= pc[dn], pc[dn] - d.Open[dn], d.Close[dn] - d.Open[dn]); side[dn] = 1
    return dict(custom=pd.DataFrame(dict(pts=pts, side=side, entry=d.Open)))

STRATEGIES = {
    "Buy & Hold (benchmark)": buy_hold,
    "Golden Cross SMA 50/200 (long)": sma_cross_long(50, 200),
    "SMA 50/200 long/short": sma_cross_ls(50, 200),
    "SMA 20/50 (long)": sma_cross_long(20, 50),
    "EMA 9/21 long/short": ema_cross_ls(9, 21),
    "Price > SMA200 trend filter": above_sma(200),
    "Price > SMA50 trend filter": above_sma(50),
    "MACD 12/26/9 long/short": macd_ls,
    "MACD cross above zero (long)": macd_long_zero,
    "RSI14 30/70 (long)": rsi14_classic,
    "RSI14 30/70 long/short": rsi14_ls,
    "Connors RSI(2) (long)": connors_rsi2,
    "Connors RSI(2) long/short": connors_rsi2_ls,
    "Bollinger 20/2 mean-reversion (long)": boll_revert,
    "Bollinger 20/2 breakout L/S": boll_breakout_ls,
    "Turtle S1 Donchian 20/10 L/S": donchian(20, 10),
    "Turtle S2 Donchian 55/20 L/S": donchian(55, 20),
    "Keltner 20/2xATR breakout L/S": keltner_ls,
    "Supertrend 10/3 L/S": supertrend(10, 3),
    "12-month TS momentum L/S": tsmom(252),
    "3-month TS momentum L/S": tsmom(63),
    "IBS <0.2 / >0.8 (long)": ibs,
    "3 down days, exit up close (long)": three_down,
    "Turn of month (long)": turn_of_month,
    "Stochastic 14/3/3 cross L/S": stochastic_ls,
    "ADX>25 + DI direction L/S": adx_di,
    "Parabolic SAR L/S": psar,
    "Ichimoku cloud L/S": ichimoku,
    "Heikin-Ashi color L/S": heikin_ashi,
    "Golden Cross + 15% vol target": dual_ma_vol_target,
    "L. Williams vol breakout 0.6 L/S (day)": williams_vol_breakout(0.6, True),
    "L. Williams vol breakout 0.6 long (day)": williams_vol_breakout(0.6, False),
    "NR7 breakout (day)": nr7_breakout,
}
