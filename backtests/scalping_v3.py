"""Round 3: one universal 'Trend Pullback Scalper' rule-set, ATR-based exits, parameters chosen ONCE on the pooled
in-sample data of all three markets (both timeframes), then judged out-of-sample market by market.

Rules (long; short is the mirror):
  trend   : close > session VWAP, EMA20 > EMA50, EMA50 rising over 5 bars, and (variant) higher-TF trend EMA(5x) rising
  trigger : RSI(2) < rsi_lo   (a short, sharp pullback)
  hold    : close still above EMA50 (pullback, not reversal)
  exits   : target = tgt_atr x ATR(14), stop = stp_atr x ATR(14), time stop, flat at session end
Fill model identical to scalping.py (next-bar-open entry +1 tick, target must trade through, stop -1 tick, $2.50/side)."""
import numpy as np, pandas as pd, itertools
from scalping import prep, stats, SPLITS, SPECS
from common import ema

def signals(d, rsi_lo, htf, tf):
    up = (d.Close > d.vwap) & (d.ema20 > d.ema50) & (d.ema50 > d.ema50.shift(5)) & (d.Close > d.ema50)
    dn = (d.Close < d.vwap) & (d.ema20 < d.ema50) & (d.ema50 < d.ema50.shift(5)) & (d.Close < d.ema50)
    if htf:
        e = ema(d.Close, 250 if tf == "1m" else 100)
        up &= e > e.shift(10); dn &= e < e.shift(10)
    return up & (d.rsi2 < rsi_lo), dn & (d.rsi2 > 100 - rsi_lo)

def simulate(d, L, S, sym, tgt_atr, stp_atr, tmax):
    sp = SPECS[sym]; tick, mult, comm = sp["tick"], sp["mult"], sp["comm"]
    o, h, l, c, a = d.Open.values, d.High.values, d.Low.values, d.Close.values, d.atr.values
    Lv, Sv = L.fillna(False).values, S.fillna(False).values; date = d.date.values; n = len(d); out = []; i = 0
    rnd = lambda x: max(1, int(round(x / tick))) * tick
    while i < n - 1:
        side = 1 if Lv[i] else (-1 if Sv[i] else 0)
        if side == 0 or date[i + 1] != date[i] or not np.isfinite(a[i]): i += 1; continue
        j = i + 1; entry = o[j] + side * tick
        tgt = entry + side * rnd(tgt_atr * a[i]); stp = entry - side * rnd(stp_atr * a[i])
        while True:
            hs = (l[j] <= stp) if side == 1 else (h[j] >= stp)
            ht = (h[j] >= tgt + tick) if side == 1 else (l[j] <= tgt - tick)
            if hs: ex = (min(stp, o[j]) if side == 1 else max(stp, o[j])) - side * tick; break
            if ht: ex = tgt; break
            if j - i >= tmax or j + 1 >= n or date[j + 1] != date[j]: ex = c[j] - side * tick; break
            j += 1
        out.append((d.index[i + 1], side, side * (ex - entry) * mult - 2 * comm, j - i))
        i = j + 1
    return pd.DataFrame(out, columns=["time", "side", "pnl", "bars"])

GRID = dict(rsi_lo=(5, 10, 15), htf=(False, True), tgt_atr=(0.5, 0.75, 1.0, 1.5), stp_atr=(1.0, 1.5, 2.0, 3.0))
TMAX = {"1m": 15, "5m": 6}

def main():
    data = {(tf, s): prep(s, tf) for tf in ("1m", "5m") for s in ("NQ", "ES", "GC")}
    res = []
    for rsi_lo, htf, ta, sa in itertools.product(*GRID.values()):
        win_n = tot = pnl_pct = 0; parts = {}
        for (tf, s), d in data.items():
            _, ise, _ = SPLITS[tf]; dd = d[:ise]; L, S = signals(dd, rsi_lo, htf, tf)
            t = simulate(dd, L, S, s, ta, sa, TMAX[tf]); parts[(tf, s)] = t
            win_n += (t.pnl > 0).sum(); tot += len(t)
            notional = dd.Close.median() * SPECS[s]["mult"]; pnl_pct += t.pnl.sum() / notional  # market-neutral weighting
        res.append(dict(rsi_lo=rsi_lo, htf=htf, tgt_atr=ta, stp_atr=sa, IS_trades=tot, IS_win=win_n / max(tot, 1), IS_ret=pnl_pct,
                        IS_markets_profitable=sum(p.pnl.sum() > 0 for p in parts.values())))
    r = pd.DataFrame(res)
    cand = r[(r.IS_win > 0.60) & (r.IS_ret > 0) & (r.IS_trades >= 150)].sort_values(["IS_markets_profitable", "IS_ret"], ascending=False)
    print("In-sample candidates (pooled, all 6 market/timeframe combos):"); print(cand.head(10).round(3).to_string())
    best = cand.iloc[0]; print("\nCHOSEN:", best.to_dict())
    rows = []
    for (tf, s), d in data.items():
        _, ise, oss = SPLITS[tf]
        for lab, dd in (("IS", d[:ise]), ("OOS", d[oss:])):
            L, S = signals(dd, best.rsi_lo, best.htf, tf)
            t = simulate(dd, L, S, s, best.tgt_atr, best.stp_atr, TMAX[tf])
            rows.append(dict(tf=tf, symbol=s, sample=lab, sessions=dd.date.nunique(), **stats(t),
                             avg_win=t.pnl[t.pnl > 0].mean(), avg_loss=t.pnl[t.pnl < 0].mean()))
            t.assign(tf=tf, symbol=s, sample=lab).to_csv(f"results/v3_trades_{tf}_{s}_{lab}.csv", index=False)
    out = pd.DataFrame(rows); out.to_csv("results/scalping_v3.csv", index=False)
    pd.set_option("display.width", 250); print(out.round(2).to_string())
    o = out[out["sample"] == "OOS"]
    print("\nOOS pooled: trades %d, win %.1f%%, net $%.0f" % (o.trades.sum(), 100 * (o.win * o.trades).sum() / o.trades.sum(), o.pnl.sum()))

if __name__ == "__main__":
    main()
