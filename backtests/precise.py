"""Precise 1-minute execution engine (Topstep-style day trading) + data loading.

Every order is simulated on 1-minute bars at an exact price:
  market  -> next 1-minute open + 1 tick slippage
  limit   -> fills only if price trades 1 tick THROUGH the limit (touch is not enough); gaps fill at the open
  stop    -> fills at the stop price + 1 tick (or the open + 1 tick if price gapped past it)
Brackets are attached at the fill price, like Keel's broker-side orders: stop = fill -/+ stop_pts, target = fill +/- tgt_pts.
  - on the fill minute only the stop can be hit (we don't know if the target came before the fill)
  - if the stop and the target are both inside one later minute, the stop is assumed first
  - target limit needs a 1-tick trade-through; stop exits get 1 tick slippage
  - optional break-even: after +be_r x risk, the stop moves to entry + 1 tick from the next minute
  - no new entries from 15:55 ET; anything open is closed at the close of the 16:09 ET minute (Topstep: flat by 3:10 PM CT)
Commission $2.50 per side per mini (Topstep's is lower; this is conservative). One position at a time per strategy."""
import os, numpy as np, pandas as pd
from numba import njit
from common import SPECS
HERE = os.path.dirname(os.path.abspath(__file__))
LAST_ENTRY, FLAT_AT = 15 * 60 + 55, 16 * 60 + 9          # minutes after midnight ET

def load_1m(sym, tf="1m"):
    """Topstep 1-minute bars if downloaded (fetch_topstep.py), else the short Yahoo 1-minute file. Returns (frame, source)."""
    f = os.path.join(HERE, "data", "topstep", f"{sym}_1m.csv.gz")
    if os.path.exists(f) and tf == "1m":
        d = pd.read_csv(f, parse_dates=["t"]).rename(columns={"t": "Datetime", "o": "Open", "h": "High", "l": "Low", "c": "Close", "v": "Volume"})
        d = d.set_index(pd.DatetimeIndex(d.Datetime).tz_convert("America/New_York")).drop(columns=["Datetime"]); src = "Topstep"
    else:
        d = pd.read_csv(os.path.join(HERE, "data", f"{sym}_cont_{tf}.csv"), index_col=0)
        d.index = pd.to_datetime(d.index, utc=True).tz_convert("America/New_York"); src = {"1m": "Yahoo 1m (4 weeks)", "5m": "Yahoo 5m (10 weeks)", "1h": "Yahoo 1h (2024-06 on)"}[tf]
    d = d[~d.index.duplicated()].sort_index()
    d["mod"] = d.index.hour * 60 + d.index.minute
    d["day"] = (d.index + pd.Timedelta(hours=6)).date               # trading day starts 18:00 ET
    d["rth"] = (d["mod"] >= 570) & (d["mod"] < 960)
    return d, src

@njit(cache=True)
def run(o, h, l, c, mod, day, s_i, s_side, s_type, s_px, s_exp, s_stop, s_tgt, be_r, tick, mult, fee, max_per_day, out, s_end, s_grp):
    """s_* : orders sorted by s_i (first 1-minute bar the order is live). Returns number of trades written to out
    (cols: order#, fill bar, exit bar, side, fill px, exit px, pnl $, R, exit reason 0 stop / 1 target / 2 flat / 3 BE)."""
    n, k, nt, busy_until = len(o), 0, 0, -1
    last_day, cnt, last_grp = -1, 0, -1
    while k < len(s_i):
        i0 = s_i[k]
        if i0 <= busy_until or i0 >= n: k += 1; continue
        if day[i0] != last_day: last_day, cnt = day[i0], 0
        if cnt >= max_per_day or (s_grp[k] >= 0 and s_grp[k] == last_grp): k += 1; continue
        side, typ, px = s_side[k], s_type[k], s_px[k]
        fill, fb = np.nan, -1
        j = i0
        while j < n and j <= i0 + s_exp[k] and day[j] == day[i0] and not (mod[j] >= LAST_ENTRY and mod[j] < 1080):
            if typ == 0: fill = o[j] + side * tick; fb = j; break
            if typ == 1:
                if side == 1 and l[j] <= px - tick: fill = min(px, o[j]); fb = j; break
                if side == -1 and h[j] >= px + tick: fill = max(px, o[j]); fb = j; break
            if typ == 2:
                if side == 1 and h[j] >= px: fill = max(px, o[j]) + tick; fb = j; break
                if side == -1 and l[j] <= px: fill = min(px, o[j]) - tick; fb = j; break
            j += 1
        if fb < 0: k += 1; continue
        risk = s_stop[k]; stp = fill - side * risk; tgt = fill + side * s_tgt[k] if s_tgt[k] > 0 else np.nan
        be_done, reason, ex, eb = False, 2, np.nan, -1
        j = fb
        while j < n:
            if day[j] != day[fb] or (mod[j] > FLAT_AT and mod[j] < 1080) or (s_end[k] >= 0 and j > s_end[k]):   # session / candle over: flat at previous close
                ex = c[j - 1] - side * tick; eb = j - 1; reason = 2; break
            if (side == 1 and l[j] <= stp) or (side == -1 and h[j] >= stp):
                gap = o[j] if j > fb else stp
                ex = (min(stp, gap) if side == 1 else max(stp, gap)) - side * tick; eb = j; reason = 3 if be_done else 0; break
            if j > fb and tgt == tgt and ((side == 1 and h[j] >= tgt + tick) or (side == -1 and l[j] <= tgt - tick)):
                ex = tgt; eb = j; reason = 1; break
            if mod[j] == FLAT_AT: ex = c[j] - side * tick; eb = j; reason = 2; break
            if be_r > 0 and not be_done and j > fb and (h[j] - fill if side == 1 else fill - l[j]) >= be_r * risk:
                stp = fill + side * tick; be_done = True
            j += 1
        if eb < 0: break
        pnl = side * (ex - fill) * mult - 2 * fee
        out[nt, 0], out[nt, 1], out[nt, 2], out[nt, 3], out[nt, 4], out[nt, 5] = k, fb, eb, side, fill, ex
        out[nt, 6], out[nt, 7], out[nt, 8] = pnl, pnl / (risk * mult), reason
        nt += 1; cnt += 1; busy_until = eb; last_grp = s_grp[k]; k += 1
    return nt

def simulate(d, sym, orders, stop_pts, tgt_pts, be_r=0.0, max_per_day=1):
    """(optional order columns: end = last bar index the trade may be held to its close, grp = at most one trade per group id)"""
    """orders: DataFrame with i (1-min bar the order goes live), side (+1/-1), type (0 market/1 limit/2 stop), px, exp (minutes live).
    stop_pts / tgt_pts: scalars or per-order arrays (points). tgt 0 = no target (exit at stop or 16:09)."""
    sp = SPECS[sym]; o = orders.sort_values("i", kind="stable").reset_index(drop=True); m = len(o)
    st = np.broadcast_to(np.asarray(stop_pts, float), (m,)).copy() if np.ndim(stop_pts) == 0 else np.asarray(stop_pts, float)[orders.sort_values("i", kind="stable").index]
    tg = np.broadcast_to(np.asarray(tgt_pts, float), (m,)).copy() if np.ndim(tgt_pts) == 0 else np.asarray(tgt_pts, float)[orders.sort_values("i", kind="stable").index]
    st = np.maximum(np.round(st / sp["tick"]) * sp["tick"], 2 * sp["tick"]); tg = np.round(tg / sp["tick"]) * sp["tick"]
    out = np.zeros((max(m, 1), 9))
    dcode = pd.factorize(d["day"])[0].astype(np.int64)
    nt = run(d.Open.values.astype(float), d.High.values.astype(float), d.Low.values.astype(float), d.Close.values.astype(float), d["mod"].values.astype(np.int64),
             dcode, o.i.values.astype(np.int64), o.side.values.astype(np.int64), o.type.values.astype(np.int64), o.px.values.astype(float),
             o.exp.values.astype(np.int64), st, tg, float(be_r), sp["tick"], float(sp["mult"]), sp["comm"], int(max_per_day), out,
             (o["end"] if "end" in o else pd.Series(-1, index=o.index)).values.astype(np.int64), (o["grp"] if "grp" in o else pd.Series(-1, index=o.index)).values.astype(np.int64))
    t = pd.DataFrame(out[:nt], columns=["k", "fb", "eb", "side", "fill", "exit", "pnl", "R", "why"])
    t["time"] = d.index[t.fb.astype(int)]; t["day"] = d["day"].values[t.fb.astype(int)]; return t
