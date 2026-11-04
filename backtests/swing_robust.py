"""Robustness checks for the daily swing candidates before rebuilding them:
 1. year-by-year R, 2005-2026     2. the same rule on all three markets     3. indicator periods scaled 0.8x-1.2x
Each candidate uses its family's most typical passing management variant (chosen on 2005-2019 only)."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd, warnings
warnings.filterwarnings("ignore")
from common import SPECS, ema, sma, atr
import mega, mt5nt, mt5ext
from keel_trades_engine import sim2_trades
from mt5nt import cross_up, turn_up, turn_dn, daily_frame

def rules(d, name, k=1.0):
    """Candidate signal rules with every period scaled by k (k = 1 is the original)."""
    c, o, h, l = d.Close, d.Open, d.High, d.Low; P = lambda n: max(2, int(round(n * k)))
    if name == "NQ MACD signal cross":
        m = ema(c, P(12)) - ema(c, P(26)); s = ema(m, P(9)); return cross_up(m, s), cross_up(s, m)
    if name == "ES MACD zero cross":
        m = ema(c, P(12)) - ema(c, P(26)); return cross_up(m, 0 * m), cross_up(0 * m, m)
    if name == "GC TEMA failed breakout":
        e = ema(c, P(12)); t = 3 * e - 3 * ema(e, P(12)) + ema(ema(e, P(12)), P(12)); r_, f_ = t > t.shift(), t < t.shift()
        return (o > t) & (c < t) & r_, (o < t) & (c > t) & f_
    if name == "GC Fractal breakout":
        n = P(2)
        fu = pd.Series(True, index=d.index); fd = pd.Series(True, index=d.index)
        for j in range(1, n + 1): fu &= (h.shift(n) > h.shift(n + j)) & (h.shift(n) > h.shift(n - j)); fd &= (l.shift(n) < l.shift(n + j)) & (l.shift(n) < l.shift(n - j))
        lu = h.shift(n).where(fu).ffill(); ld = l.shift(n).where(fd).ffill(); return cross_up(c, lu), cross_up(ld, c)
    if name == "NQ outside bar reversal":
        return (h > h.shift()) & (l < l.shift()) & (c > h.shift()), (h > h.shift()) & (l < l.shift()) & (c < l.shift())
    if name == "NQ three white soldiers":
        return ((c > o) & (c.shift() > o.shift()) & (c.shift(2) > o.shift(2)) & (c > c.shift()) & (c.shift() > c.shift(2)),
                (c < o) & (c.shift() < o.shift()) & (c.shift(2) < o.shift(2)) & (c < c.shift()) & (c.shift() < c.shift(2)))
    if name == "GC VIDYA cross":
        v = mt5ext.vidya(c, P(14), P(9)); return cross_up(c, v), cross_up(v, c)
    raise KeyError(name)

TRIG = {"NQ MACD signal cross": ("NQ", "MT5 MACD: signal cross", "long", ("none", "with", "any", "any"), "mt5nt"),
        "ES MACD zero cross": ("ES", "MT5 MACD: zero cross", "both", ("none", "none", "high", "any"), "mt5nt"),
        "GC TEMA failed breakout": ("GC", "MT5 TEMA(12): failed breakout", "long", ("none", "none", "any", "any"), "mt5nt"),
        "GC Fractal breakout": ("GC", "BW Fractal breakout", "both", ("with", "with", "low", "any"), "mt5ext"),
        "NQ outside bar reversal": ("NQ", "Candle: outside bar reversal", "long", ("none", "with", "any", "any"), "mt5ext"),
        "NQ three white soldiers": ("NQ", "Candle: three white soldiers / black crows", "long", ("none", "none", "any", "any"), "mt5ext"),
        "GC VIDYA cross": ("GC", "VIDYA(14): price crosses", "long", ("none", "none", "low", "any"), "mt5ext")}

def mgmt_for(name):
    sym, trig, dr, f, pre = TRIG[name]; P = pd.read_csv(f"results/{pre}_daily_pass.csv.gz")
    m = P[(P.symbol == sym) & (P.trigger == trig) & (P.dir == dr) & (P.regime == f[0]) & (P.trend == f[1]) & (P.vol == f[2])]
    m = m.assign(sc=m[["TR_avg", "VA_avg"]].min(axis=1)); rep = m.iloc[(m.sc - m.sc.median()).abs().argsort().iloc[0]]
    return mt5nt.MD[int(rep.mgmt)]

DATA = {s: daily_frame(s) for s in ("NQ", "ES", "GC")}
FILT = {s: {f[0]: (f[1], f[2]) for f in mega.filters(DATA[s], s) if f[0][3] == "any"} for s in DATA}
def trades(name, sym, k=1.0):
    d = DATA[sym]; _, _, dr, f, _ = TRIG[name]; L0, S0 = rules(d, name, k); lm, sm_ = FILT[sym][f]
    L = np.nan_to_num(L0.values.astype(float)).astype(bool) & lm; S = np.nan_to_num(S0.values.astype(float)).astype(bool) & sm_
    if dr == "long": S = np.zeros_like(S)
    em, sm, kk, be, tr, tm = mgmt_for(name); sp = SPECS[sym]; nan = np.full(len(d), np.nan); out = np.zeros((len(d), 8))
    n = sim2_trades(d.Open.values.astype(float), d.High.values.astype(float), d.Low.values.astype(float), d.Close.values.astype(float), d.atr.values.astype(float),
                    d.sess_id.values.astype(np.int64), L, S, nan, nan, nan, int(em), int(sm), kk, int(be), int(tr), int(tm), 0, 0, sp["tick"], float(sp["mult"]), sp["comm"], out, 1)
    t = pd.DataFrame(out[:n], columns=["i", "side", "stop_pts", "tp_pts", "pts", "R", "bars", "mfe"]); t["year"] = d.index[t.i.astype(int)].year; return t

def summ(t): return dict(n=len(t), avgR=t.R.mean() if len(t) else np.nan, win=(t.pts > 0).mean() if len(t) else np.nan,
                          pf=(t.R[t.R > 0].sum() / -t.R[t.R < 0].sum()) if (t.R < 0).any() else np.nan)
EM = {0: "market", 1: "confirm-close", 2: "limit 50%"}; SM = {0: "signal-bar stop", 1: "1xATR stop", 2: "5-bar swing stop"}
rows, years = [], {}
for name, (sym, *_r) in TRIG.items():
    em, sm, kk, be, tr, tm = mgmt_for(name)
    mg = f"{EM[int(em)]}, {SM[int(sm)]}, {'target %gR' % kk if kk else 'no target'}{', BE +1R' if be else ''}{', ATR trail' if tr else ''}, time stop {int(tm)}d"
    base = trades(name, sym); yr = base.groupby("year").R.sum().reindex(range(2005, 2027), fill_value=0); years[name] = yr
    other = {s: summ(trades(name, s)) for s in DATA if s != sym}
    neigh = [summ(trades(name, sym, k))["avgR"] for k in (0.8, 0.9, 1.1, 1.2)]
    pre, post = base[base.year < 2020], base[base.year >= 2020]
    rows.append(dict(candidate=name, mgmt=mg, trades=len(base), avgR_all=base.R.mean(), avgR_2005_19=pre.R.mean(), avgR_2020_26=post.R.mean(),
                     pos_years=f"{(yr > 0).sum()}/{(yr != 0).sum()}", worst_year=yr.min(),
                     **{f"other_{s}": f"{v['avgR']:+.2f}R n{v['n']}" for s, v in other.items()},
                     neigh_min=np.nanmin(neigh), neigh_max=np.nanmax(neigh)))
R = pd.DataFrame(rows); R.to_csv("results/swing_robust.csv", index=False)
pd.set_option("display.width", 340); pd.set_option("display.max_colwidth", 80)
print(R.drop(columns=["mgmt"]).round(3).to_string(index=False)); print()
for r in rows: print(f"{r['candidate']:26s} {r['mgmt']}")
print("\nR per year:"); print(pd.DataFrame(years).T.round(1).to_string())
