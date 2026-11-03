"""New 1h setups aimed at frequency (for evaluation accounts). Session = Globex day (18:00 -> 17:00 ET).
  Overnight long          : signal on the 18:00 bar close -> long from 19:00 open, time-exit at 09:00 (14 bars)
  Overnight long + regime : same, only when yesterday's daily close > daily SMA50
  Overnight both (regime) : long if daily close > SMA50 else short
  Opening drive           : the 09:00-10:00 bar closes in its top (bottom) 25% and above (below) the overnight VWAP -> follow, hold to 17:00
  Opening drive + regime  : same, only in the direction of the daily SMA50 regime"""
import numpy as np, pandas as pd
from common import load, sma

TIME_EXIT = {"Overnight long": 14, "Overnight long + daily regime": 14, "Overnight long/short by daily regime": 14}

def regime(d, sym):
    dd = load(f"{sym}_cont_1d.csv"); up = (dd.Close > sma(dd.Close, 50)).shift(1); up.index = up.index.date
    return d.sess.map(up).astype("boolean").fillna(False).to_numpy(dtype=bool)

def new_setups(d, sym):
    h = d.index.hour.values; up = regime(d, sym)
    first = h == 18
    S = {}
    S["Overnight long"] = (first, np.zeros(len(d), bool))
    S["Overnight long + daily regime"] = (first & up, np.zeros(len(d), bool))
    S["Overnight long/short by daily regime"] = (first & up, first & ~up)
    rng = (d.High - d.Low).replace(0, np.nan); pos = ((d.Close - d.Low) / rng).values
    drive_bar = h == 9
    L = drive_bar & (pos > 0.75) & (d.Close.values > d.vwap.values); Sh = drive_bar & (pos < 0.25) & (d.Close.values < d.vwap.values)
    S["Opening drive"] = (L, Sh)
    S["Opening drive + daily regime"] = (L & up, Sh & ~up)
    return {k: (np.asarray(a, bool), np.asarray(b, bool)) for k, (a, b) in S.items()}
