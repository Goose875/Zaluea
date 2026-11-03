"""Download and cache price data (Yahoo Finance via yfinance)."""
import yfinance as yf, pandas as pd, os
OUT = os.path.join(os.path.dirname(__file__), "data")
JOBS = [  # (ticker, interval, period/start)
    ("NQ=F", "1d", "2005-01-01"), ("ES=F", "1d", "2005-01-01"), ("GC=F", "1d", "2005-01-01"),
    ("NQ=F", "1h", "730d"), ("ES=F", "1h", "730d"), ("GC=F", "1h", "730d"),
    ("NQZ26.CME", "5m", "60d"), ("ESZ26.CME", "5m", "60d"), ("GCZ26.CMX", "5m", "60d"),
    ("NQZ26.CME", "1d", "max"), ("ESZ26.CME", "1d", "max"), ("GCZ26.CMX", "1d", "max"),
]
for t, iv, p in JOBS:
    kw = dict(start=p) if p[0].isdigit() and "-" in p else dict(period=p)
    d = yf.download(t, interval=iv, progress=False, auto_adjust=False, **kw)
    d.columns = d.columns.get_level_values(0)
    d = d[["Open", "High", "Low", "Close", "Volume"]].dropna()
    if iv != "1d":
        d.index = d.index.tz_convert("America/New_York")
    fn = f"{t.split('.')[0].replace('=F','_cont')}_{iv}.csv"
    d.to_csv(os.path.join(OUT, fn)); print(fn, len(d), d.index.min(), d.index.max())
