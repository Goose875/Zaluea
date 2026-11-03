"""Round 4: (a) robustness of the round-2 winners (neighbouring parameters, OOS);
(b) partial gap-fill scalp: at the regular-session open, fade the overnight gap targeting only `frac` of it."""
import numpy as np, pandas as pd, itertools
from scalping import prep, simulate, stats, S_trend_rsi2, SPLITS, SPECS

def neighbours(sym, tf, T0, S0, tm0, rsi_lo=10):
    d = prep(sym, tf); _, ise, oss = SPLITS[tf]; rows = []
    for T, Sx, tm in itertools.product([round(T0 * k) for k in (0.75, 1, 1.25)], [round(S0 * k) for k in (0.75, 1, 1.25)], (tm0 // 2, tm0)):
        for lab, dd in (("IS", d[:ise]), ("OOS", d[oss:])):
            L, S = S_trend_rsi2(dd, rsi_lo); t = simulate(dd, L, S, sym, T, Sx, tm); s = stats(t)
            rows.append(dict(T=T, S=Sx, tm=tm, sample=lab, trades=s["trades"], win=s["win"], pnl=s["pnl"]))
    r = pd.DataFrame(rows).pivot_table(index=["T", "S", "tm"], columns="sample", values=["win", "pnl", "trades"])
    return r

def gap_scalp(sym, tf, frac, stop_mult, min_gap):
    """Prior RTH close -> today's RTH open gap. Enter at open fading the gap; target = frac*gap toward prior close;
    stop = stop_mult*gap beyond the open; exit at 60 min otherwise."""
    d = prep(sym, tf); sp = SPECS[sym]; tick, mult, comm = sp["tick"], sp["mult"], sp["comm"]
    out = []; prev_close = None
    for day, g in d.groupby("date"):
        if prev_close is not None and len(g) > 12:
            o = g.Open.iloc[0]; gap = o - prev_close
            if abs(gap) / prev_close >= min_gap:
                side = -np.sign(gap); entry = o + side * tick
                tgt = entry + side * max(tick, frac * abs(gap)); stp = entry - side * stop_mult * abs(gap)
                limit = g.index[0] + pd.Timedelta(minutes=60); ex = None
                for ts, b in g.iterrows():
                    hs = (b.Low <= stp) if side == 1 else (b.High >= stp)
                    ht = (b.High >= tgt + tick) if side == 1 else (b.Low <= tgt - tick)
                    if hs: ex = stp - side * tick; break
                    if ht: ex = tgt; break
                    if ts >= limit: ex = b.Close - side * tick; break
                out.append((day, side, side * (ex - entry) * mult - 2 * comm))
        prev_close = g.Close.iloc[-1]
    return pd.DataFrame(out, columns=["date", "side", "pnl"])

if __name__ == "__main__":
    pd.set_option("display.width", 250)
    print("=== Robustness: NQ 5m trend-pullback RSI(2)<10, round-2 params tgt 109t / stop 327t / 8 bars ===")
    print(neighbours("NQ", "5m", 109, 327, 8).round(2).to_string())
    print("\n=== Robustness: GC 5m trend-pullback RSI(2)<10, round-2 params tgt 43t / stop 171t / 8 bars ===")
    print(neighbours("GC", "5m", 43, 171, 8).round(2).to_string())
    print("\n=== Partial gap-fill scalp (5m, Sep/Aug -> Nov 2; IS = before Oct 15) ===")
    rows = []
    for sym in ("NQ", "ES", "GC"):
        for frac, sm, mg in itertools.product((0.25, 0.5), (1.0, 2.0), (0.001, 0.003)):
            t = gap_scalp(sym, "5m", frac, sm, mg); t["date"] = pd.to_datetime(t.date)
            a, b = t[t.date <= SPLITS["5m"][1]], t[t.date >= SPLITS["5m"][2]]
            sa, sb = stats(a), stats(b)
            rows.append(dict(sym=sym, frac=frac, stop_x_gap=sm, min_gap=mg, IS_n=sa["trades"], IS_win=sa["win"], IS_pnl=sa["pnl"],
                             OOS_n=sb["trades"], OOS_win=sb["win"], OOS_pnl=sb["pnl"]))
    g = pd.DataFrame(rows); print(g.round(2).to_string()); g.to_csv("results/scalping_v4_gap.csv", index=False)
