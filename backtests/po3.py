"""ICT Power of Three (PO3) on 4-hour candles with lower-timeframe entries (FVG, rejection block, inverse FVG, MSS).

4h candles (ET): 18:00, 22:00, 02:00, 06:00, 10:00, 14:00.  For a bullish candle (bearish is the mirror):
  accumulation/manipulation: price trades below the candle's open (by >= 0.1 x 4h ATR) or sweeps the previous 4h low
  entry (on the trigger timeframe, after the manipulation low, within the candle's first 3 hours):
    FVG  - first bullish fair value gap formed off the low -> limit at the gap's top edge or its midpoint (CE)
    IFVG - a bearish FVG from the drop is closed through to the upside (inversion) -> market next bar
    RB   - rejection block: the bar that made the low has a lower wick >= 50% of its range; after a close above that bar's high
           -> limit at its body bottom
    MSS  - market structure shift: close above the highest high of the 3 bars before the low -> market next bar
  stop: 1 tick beyond the manipulation low.  targets: 2R, 3R, the previous 4h candle's high, or none (hold to the candle close)
  exit: target / stop / the 4h candle's close (or flat by 16:09 ET, Topstep).  One trade per 4h candle.
  bias filters: none (both sides), previous 4h candle's colour, 4h EMA20, price vs the 18:00 session open.
Runs: (A) 15-minute triggers on 5-minute execution bars (Yahoo, 10 weeks) or on Topstep 1-minute bars when downloaded
      (B) a coarse 2.4-year check: 1-hour triggers on 1-hour bars (not the real 15-minute model; only to see if the idea holds over time)
    python3 po3.py   -> results/po3_variants.csv, results/po3_best.csv"""
import itertools, numpy as np, pandas as pd, warnings, os
warnings.filterwarnings("ignore")
from common import SPECS
from precise import load_1m, simulate
import precise_strats

def build(d, tf_trig):
    """Per-trigger-bar table with 4h-candle context."""
    blk = ((d.index.hour - 18) % 24) // 4; d = d.assign(c4=pd.factorize(pd.Series(list(zip(d["day"], blk))))[0])
    C = d.groupby("c4").agg(o=("Open", "first"), h=("High", "max"), l=("Low", "min"), c=("Close", "last"), i0=("i", "first"), i1=("i", "last"), t0=("t", "first"))
    C["atr"] = (C.h - C.l).rolling(14, min_periods=5).mean().shift(); C["ph"], C["pl"] = C.h.shift(), C.l.shift(); C["pbull"] = (C.c > C.o).shift()
    C["ema"] = C.c.ewm(span=20, adjust=False).mean().shift(); C["pc"] = C.c.shift()
    so = d.groupby("day").Open.first(); C["sess_open"] = d.groupby("c4")["day"].first().map(so)
    # 4h candles start on the hour, so clock-aligned 15m / 60m bins never straddle two candles
    T = d.resample(tf_trig, label="left", closed="left").agg({"Open": "first", "High": "max", "Low": "min", "Close": "last", "i": "last", "c4": "first"}).dropna()
    return d, C, T

def orders_for(d, C, T, model, bias, edge, tick, thr=0.1, window_h=3.0, hours=None, sides=(1, -1)):
    rows = []
    for k, g in T.groupby("c4"):
        if k not in C.index: continue
        cd = C.loc[k]
        if not cd.atr > 0: continue
        if hours is not None and cd.t0.hour not in hours: continue
        o_ = cd.o; hi, lo, cl, op, ii = g.High.values, g.Low.values, g.Close.values, g.Open.values, g.i.values.astype(int)
        cut = cd.t0 + pd.Timedelta(hours=window_h); live_end = int(d.i.values[min(len(d) - 1, d.index.searchsorted(cut))])
        for side in sides:
            if bias == "prev 4h colour" and (cd.pbull != (side == 1)): continue
            if bias == "4h EMA20" and ((cd.pc > cd.ema) != (side == 1)): continue
            if bias == "vs 18:00 open" and ((o_ > cd.sess_open) != (side == 1)): continue
            x = (lambda v: v) if side == 1 else (lambda v: -v)          # mirror shorts into longs
            H, L, Cl, Op = (x(hi), x(lo), x(cl), x(op)) if side == 1 else (x(lo), x(hi), x(cl), x(op))
            O, PL = x(o_), (x(cd.pl) if side == 1 else x(cd.ph))
            ext = np.minimum.accumulate(L)                                   # running manipulation low (mirrored)
            for n in range(len(g)):
                if g.index[n] >= cut: break
                manip = (ext[n] < O - thr * cd.atr) if edge == "below open" else (ext[n] < PL)
                if not manip: continue
                lb = int(np.argmin(L[: n + 1]))                              # bar of the manipulation low
                if lb == n and model != "RB": continue
                stop_lvl = ext[n] - tick; px, typ = None, None
                if model in ("FVG top", "FVG CE") and n - 2 >= lb and L[n] > H[n - 2]:
                    px = L[n] if model == "FVG top" else (L[n] + H[n - 2]) / 2; typ = 1
                elif model == "IFVG":
                    gaps = [(L[j - 2], H[j]) for j in range(2, lb + 1) if H[j] < L[j - 2]]   # bearish (mirrored) gaps on the way down
                    if gaps and Cl[n] > max(top for top, _ in gaps) and (n == 0 or Cl[n - 1] <= max(top for top, _ in gaps)): px, typ = None, 0
                    else: continue
                elif model == "RB" and n > lb:
                    rng_ = H[lb] - L[lb]; wick = min(Op[lb], Cl[lb]) - L[lb]
                    if rng_ > 0 and wick / rng_ >= 0.5 and Cl[n] > H[lb] and Cl[n - 1] <= H[lb]: px = min(Op[lb], Cl[lb]); typ = 1
                    else: continue
                elif model == "MSS" and lb >= 3:
                    lvl = H[lb - 3: lb].max()
                    if Cl[n] > lvl and Cl[n - 1] <= lvl: typ = 0
                    else: continue
                else: continue
                entry_ref = px if typ == 1 else Cl[n]
                dist = entry_ref - stop_lvl
                if not (2 * tick <= dist <= 1.5 * cd.atr): break
                ph = (x(cd.ph) if side == 1 else x(cd.pl)) - entry_ref
                rows.append(dict(i=ii[n] + 1, side=side, type=typ, px=(x(px) if px is not None else 0.0), exp=max(1, live_end - ii[n] - 1),
                                 end=int(cd.i1), grp=int(k), stop=dist, prevext=ph))
                break
    o = pd.DataFrame(rows)
    return o.sort_values("i", kind="stable").reset_index(drop=True) if len(o) else o

def run(label, sym, d, tf_trig, rows):
    d = d.copy(); d["i"] = np.arange(len(d)); d["t"] = d.index; sp = SPECS[sym]
    if label.startswith("B"):                                                    # 1h bars: be flat by 16:00 -> last bar 15:00
        pass
    d, C, T = build(d, tf_trig)
    if label.startswith("B"):
        last15 = d[d["mod"] == 900].groupby("day").i.last(); cap = d["day"].map(last15)
    for model, bias, edge in itertools.product(("FVG top", "FVG CE", "IFVG", "RB", "MSS"), ("none", "prev 4h colour", "4h EMA20", "vs 18:00 open"), ("below open", "swept prev 4h extreme")):
        od = orders_for(d, C, T, model, bias, edge, sp["tick"])
        if not len(od): continue
        if label.startswith("B"):
            c_ = cap.values[od.i.clip(upper=len(d) - 1).values]; od["end"] = np.where(np.isnan(c_), od.end, np.minimum(od.end, np.nan_to_num(c_, nan=1e18))).astype(np.int64)
        for tgt, hold in itertools.product(("2R", "3R", "prev 4h extreme", "none"), ("candle close", "16:09 flat")):
            if tgt == "none" and hold == "16:09 flat": continue
            o2 = od.copy()
            if hold == "16:09 flat": o2["end"] = -1 if not label.startswith("B") else pd.Series(cap.values[o2.i.clip(upper=len(d) - 1).values]).fillna(-1).astype(np.int64).values
            tg = {"2R": 2 * o2.stop, "3R": 3 * o2.stop, "prev 4h extreme": o2.prevext.where(o2.prevext > o2.stop * 0.5, 2 * o2.stop), "none": 0 * o2.stop}[tgt].values
            t = simulate(d, sym, o2, o2.stop.values, tg, 0.0, 99)
            if not len(t): continue
            days = sorted(d["day"].unique()); half = days[len(days) // 2]
            rows.append(dict(run=label, symbol=sym, entry=model, bias=bias, manipulation=edge, target=tgt, exit=hold, n=len(t), win=(t.pnl > 0).mean(),
                             avgR=t.R.mean(), usd_per_trade=t.pnl.mean(), H1_avgR=t[t.day < half].R.mean(), H2_avgR=t[t.day >= half].R.mean(),
                             pf=t.pnl[t.pnl > 0].sum() / max(1e-9, -t.pnl[t.pnl < 0].sum()), longs=(t.side > 0).sum(), shorts=(t.side < 0).sum(),
                             avg_stop_pts=o2.stop.mean()))
    return d

def random_control(label, sym, d, n, stop_pts, seed):
    """Random market entries (same count, same average stop, 2R) as a luck baseline."""
    ro = precise_strats.random_orders(d, max(1, n // 2), n - n // 2, seed); t = simulate(d, sym, ro, stop_pts, 2 * stop_pts, 0.0, 1); return t.R.mean()

if __name__ == "__main__":
    rows = []
    for sym in ("NQ", "ES", "GC"):
        top = os.path.exists(f"data/topstep/{sym}_1m.csv.gz")
        dA, srcA = load_1m(sym, "1m" if top else "5m"); run(f"A 15m triggers ({srcA})", sym, dA, "15min", rows)
        dB, srcB = load_1m(sym, "1h"); run(f"B coarse 1h triggers ({srcB})", sym, dB, "60min", rows)
        print(sym, "done", flush=True)
    V = pd.DataFrame(rows); V.to_csv("results/po3_variants.csv", index=False)
    # random controls for each run/symbol at the typical stop size
    ctl = []
    for (lab, sym), g in V.groupby(["run", "symbol"]):
        d, _ = load_1m(sym, "1h" if lab.startswith("B") else ("1m" if os.path.exists(f"data/topstep/{sym}_1m.csv.gz") else "5m"))
        st = g.avg_stop_pts.median(); n = int(g.n.median()); r = [random_control(lab, sym, d, n, st, s) for s in range(100)]
        ctl.append(dict(run=lab, symbol=sym, random_avgR_median=np.nanmedian(r), random_avgR_p95=np.nanpercentile(r, 95)))
    K = pd.DataFrame(ctl); V = V.merge(K, on=["run", "symbol"]); V["beats_random_p95"] = V.avgR > V.random_avgR_p95
    V.to_csv("results/po3_variants.csv", index=False)
    S = V.groupby(["run", "symbol", "entry"]).agg(variants=("avgR", "size"), share_positive=("avgR", lambda s: (s > 0).mean()), share_beat_p95=("beats_random_p95", "mean"),
                                                   median_avgR=("avgR", "median"), best_avgR=("avgR", "max"), median_trades=("n", "median")).reset_index()
    S.to_csv("results/po3_summary.csv", index=False)
    pd.set_option("display.width", 300); pd.set_option("display.max_rows", 200); print(S.round(3).to_string(index=False)); print(K.round(3).to_string(index=False))
    B = V[V.n >= 30].sort_values("avgR", ascending=False).head(25); B.to_csv("results/po3_best.csv", index=False)
    print(B[["run", "symbol", "entry", "bias", "manipulation", "target", "exit", "n", "win", "avgR", "H1_avgR", "H2_avgR", "pf", "random_avgR_p95"]].round(3).to_string(index=False))
