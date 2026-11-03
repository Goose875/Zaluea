"""Shared contract specs, indicators and metrics."""
import numpy as np, pandas as pd, os

DATA = os.path.join(os.path.dirname(__file__), "data")
CUTOFF = "2026-11-02"  # last complete session (Nov 3 2026 is still trading)

# multiplier ($/pt), tick size, slippage ticks per side, commission $ per side
SPECS = {
    "NQ": dict(mult=20, tick=0.25, slip=1, comm=2.50, name="E-mini Nasdaq-100"),
    "ES": dict(mult=50, tick=0.25, slip=1, comm=2.50, name="E-mini S&P 500"),
    "GC": dict(mult=100, tick=0.10, slip=1, comm=2.50, name="Gold (COMEX)"),
}

def cost_pts(sym):
    s = SPECS[sym]
    return s["slip"] * s["tick"] + s["comm"] / s["mult"]  # points per side

def load(name, tz=False):
    d = pd.read_csv(os.path.join(DATA, name), index_col=0)
    d.index = pd.to_datetime(d.index, utc=tz)
    if tz:
        d.index = d.index.tz_convert("America/New_York")
    return d

# ---------------- indicators ----------------
def sma(s, n): return s.rolling(n).mean()
def ema(s, n): return s.ewm(span=n, adjust=False).mean()

def rsi(s, n):
    d = s.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn.replace(0, np.nan))

def atr(df, n):
    pc = df.Close.shift()
    tr = pd.concat([df.High - df.Low, (df.High - pc).abs(), (df.Low - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()

def hold(entry_long, exit_long, entry_short=None, exit_short=None, index=None):
    """Stateful position from entry/exit boolean series -> +1/0/-1."""
    el = entry_long.values; xl = exit_long.values
    es = entry_short.values if entry_short is not None else np.zeros(len(el), bool)
    xs = exit_short.values if exit_short is not None else np.zeros(len(el), bool)
    pos = np.zeros(len(el)); p = 0
    for i in range(len(el)):
        if p == 1 and (xl[i] or es[i]): p = 0
        elif p == -1 and (xs[i] or el[i]): p = 0
        if p == 0:
            if el[i]: p = 1
            elif es[i]: p = -1
        pos[i] = p
    return pd.Series(pos, index=entry_long.index)

# ---------------- metrics ----------------
def trade_stats(pnl_by_trade):
    t = np.asarray(pnl_by_trade, float)
    if len(t) == 0:
        return dict(trades=0, win_rate=np.nan, profit_factor=np.nan, avg_trade=np.nan)
    g, l = t[t > 0].sum(), -t[t < 0].sum()
    return dict(trades=len(t), win_rate=(t > 0).mean(), profit_factor=(g / l if l > 0 else np.inf),
                avg_trade=t.mean())

def perf(ret, periods_per_year=252):
    """ret: per-period fractional returns on 1x notional."""
    ret = ret.fillna(0)
    eq = (1 + ret).cumprod()
    yrs = len(ret) / periods_per_year
    cagr = eq.iloc[-1] ** (1 / yrs) - 1 if yrs > 0 and eq.iloc[-1] > 0 else np.nan
    vol = ret.std() * np.sqrt(periods_per_year)
    sharpe = ret.mean() / ret.std() * np.sqrt(periods_per_year) if ret.std() > 0 else np.nan
    dd = (eq / eq.cummax() - 1).min()
    return dict(total_ret=eq.iloc[-1] - 1, cagr=cagr, vol=vol, sharpe=sharpe, max_dd=dd,
                calmar=(cagr / -dd if dd < 0 else np.nan))
