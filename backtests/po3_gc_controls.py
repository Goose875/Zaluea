"""Controls for po3_gc.py: (1) the same orders at random limit levels, (2) PO3 direction vs the opposite direction."""
import numpy as np, pandas as pd, warnings; warnings.filterwarnings("ignore")
import po3_gc as G, po3
from precise import simulate
for key in ("B1", "B2", "A1", "A2"):
    tf, trig, model, bias, edge, tgt, hold = G.CANDS[key]; d, C, T, cap, _ = G.ctx(tf, trig)
    od = po3.orders_for(d, C, T, model, bias, edge, G.sp["tick"]); res = []
    real = G.trades(key).R.mean()
    for s in range(50):
        rng = np.random.default_rng(s); o = od.copy()
        c_sig = d.Close.values[o.i.values - 1]; stop_lvl = np.where(o.side > 0, (o.px if model != "MSS" else c_sig) - o.stop, (o.px if model != "MSS" else c_sig) + o.stop)
        u = rng.uniform(0.0, 1.0, len(o)); newpx = stop_lvl + o.side * (u * np.abs(c_sig - stop_lvl))   # random level between the stop and the last close
        o["px"] = newpx; o["type"] = 1; o["stop"] = np.abs(newpx - stop_lvl).clip(lower=2 * G.sp["tick"])
        if tf == "1h":
            c_ = cap.values[o.i.clip(upper=len(d) - 1).values]; o["end"] = np.where(np.isnan(c_), o.end, np.minimum(o.end, np.nan_to_num(c_, nan=1e18))).astype(np.int64)
            if hold == "16:09 flat": o["end"] = pd.Series(c_).fillna(-1).astype(np.int64).values
        elif hold == "16:09 flat": o["end"] = -1
        tg = {"none": 0 * o.stop, "3R": 3 * o.stop, "2R": 2 * o.stop, "prev 4h extreme": 2 * o.stop}[tgt].values
        t = simulate(d, "GC", o, o.stop.values, tg, 0.0, 99); res.append(t.R.mean())
    res = np.array(res); print(f"{key}: real {real:+.3f}R | random-level limits: median {np.nanmedian(res):+.3f}R, 95th pct {np.nanpercentile(res,95):+.3f}R, real beats {np.nanmean(res < real):.0%}")
# Same candles and moments; limit at a random distance (0.2-1.0 x the PO3 stop) from the last close, either in the PO3 direction
# (buy below after a down-sweep) or the opposite (sell above). Same $ stop. Exit at the 4h close. Reports $ per trade, 1 GC.
for key in ("B1", "B2", "A1", "A2"):
    tf, trig, model, bias, edge, tgt, hold = G.CANDS[key]; d, C, T, cap, _ = G.ctx(tf, trig)
    od = po3.orders_for(d, C, T, model, bias, edge, G.sp["tick"]); out = {"PO3 direction": [], "opposite": []}
    for s in range(50):
        rng = np.random.default_rng(s); u = rng.uniform(0.2, 1.0, len(od)); c_sig = d.Close.values[od.i.values - 1]
        for nm, sgn in (("PO3 direction", 1), ("opposite", -1)):
            o = od.copy(); o["side"] = od.side * sgn; o["px"] = c_sig - o.side * u * od.stop * 0.5; o["type"] = 1
            if tf == "1h":
                c_ = cap.values[o.i.clip(upper=len(d) - 1).values]; o["end"] = np.where(np.isnan(c_), o.end, np.minimum(o.end, np.nan_to_num(c_, nan=1e18))).astype(np.int64)
            t = simulate(d, "GC", o, od.stop.values, 0 * od.stop.values, 0.0, 99); out[nm].append(t.pnl.mean())
    print(key, {k: f"${np.mean(v):+.0f}/trade (5-95%: {np.percentile(v,5):+.0f}..{np.percentile(v,95):+.0f})" for k, v in out.items()})
