"""GC futures, 15-minute PO3: the two families where 89% of versions were profitable (rejection block, FVG midpoint), all 56
versions each (4 biases x 2 manipulation rules x 7 target/exit combos). Per version:
  - avg R, double costs, weeks positive
  - level control: the same orders at random limit prices between the stop and the last close (20 runs)
  - direction control: the same orders flipped to the opposite direction
  - precision check: 5-minute fills vs 1-minute fills on the 4 weeks where both exist
Then a Topstep 50K and 150K evaluation for the family's typical version (every start day).
    python3 po3_gc_family.py -> results/po3_gc_family.csv, results/po3_gc_family_eval.csv"""
import itertools, numpy as np, pandas as pd, warnings
warnings.filterwarnings("ignore")
from common import SPECS
from precise import load_1m, simulate
import po3
SYM = "GC"; sp = SPECS[SYM]; TICK = sp["tick"]

def prep(tf):
    d, src = load_1m(SYM, tf); d = d.copy(); d["i"] = np.arange(len(d)); d["t"] = d.index; return po3.build(d, "15min")
D5, D1 = prep("5m"), prep("1m")

def orders(ctx, model, bias, edge, hold, tgt, start=None):
    d, C, T = ctx; od = po3.orders_for(d, C, T, model, bias, edge, TICK)
    if start is not None: od = od[d.index[od.i.clip(upper=len(d) - 1)] >= start].reset_index(drop=True)
    if hold == "16:09 flat": od["end"] = -1
    tg = {"none": 0 * od.stop, "3R": 3 * od.stop, "2R": 2 * od.stop, "prev 4h extreme": od.prevext.where(od.prevext > od.stop * 0.5, 2 * od.stop)}[tgt].values
    return od, tg

def sim(ctx, od, tg): return simulate(ctx[0], SYM, od, od.stop.values, tg, 0.0, 99)

rows, keep = [], {}
start1 = D1[0].index[0] + pd.Timedelta(days=1)
for model, bias, edge, (tgt, hold) in itertools.product(("RB", "FVG CE"), ("none", "prev 4h colour", "4h EMA20", "vs 18:00 open"), ("below open", "swept prev 4h extreme"),
                                                        [(t, h) for t in ("2R", "3R", "prev 4h extreme", "none") for h in ("candle close", "16:09 flat") if not (t == "none" and h == "16:09 flat")]):
    od, tg = orders(D5, model, bias, edge, hold, tgt)
    if len(od) < 10: continue
    t = sim(D5, od, tg)
    if len(t) < 10: continue
    risk = (t.pnl / t.R).abs(); dc = ((t.pnl - 2 * 2.5 - 2 * TICK * sp["mult"]) / risk).mean()
    wk = t.groupby(t.time.dt.tz_localize(None).dt.to_period("W")).R.sum()
    fl = sim(D5, od.assign(side=-od.side, type=0, px=0.0), tg).R.mean()
    d = D5[0]; c_sig = d.Close.values[od.i.values - 1]; stop_lvl = np.where(od.side > 0, od.px - od.stop, od.px + od.stop); lv = []
    for s in range(20):
        u = np.random.default_rng(s).uniform(0, 1, len(od)); o = od.copy(); o["px"] = stop_lvl + od.side * u * np.abs(c_sig - stop_lvl)
        o["stop"] = np.abs(o.px - stop_lvl).clip(lower=2 * TICK); tg2 = tg / od.stop.values * o.stop.values; lv.append(sim(D5, o, tg2).R.mean())
    # precision: same version on the 4 weeks covered by 1-minute bars, 5m fills vs 1m fills
    a5 = t[t.time >= start1]; o1, tg1 = orders(D1, model, bias, edge, hold, tgt, start1); a1 = sim(D1, o1, tg1)
    rows.append(dict(entry=model, bias=bias, manipulation=edge, target=tgt, exit=hold, n=len(t), win=(t.pnl > 0).mean(), avgR=t.R.mean(), usd_per_trade_1GC=t.pnl.mean(),
                     double_costs_avgR=dc, weeks_pos=f"{(wk > 0).sum()}/{len(wk)}", flipped_avgR=fl, level_ctl_median=np.nanmedian(lv), beats_levels=np.nanmean(np.array(lv) < t.R.mean()),
                     last4w_5m_avgR=a5.R.mean(), last4w_1m_avgR=a1.R.mean(), last4w_n5=len(a5), last4w_n1=len(a1), avg_stop_pts=od.stop.mean()))
    keep[(model, bias, edge, tgt, hold)] = t
F = pd.DataFrame(rows); F.to_csv("results/po3_gc_family.csv", index=False)
pd.set_option("display.width", 320); pd.set_option("display.max_rows", 200)
print(F.drop(columns=["usd_per_trade_1GC"]).round(2).to_string(index=False)); print()
S = F.groupby("entry").agg(versions=("avgR", "size"), profitable=("avgR", lambda s: (s > 0).mean()), profitable_double_costs=("double_costs_avgR", lambda s: (s > 0).mean()),
                           flipped_losing=("flipped_avgR", lambda s: (s < 0).mean()), beat_levels_90=("beats_levels", lambda s: (s >= 0.9).mean()),
                           median_avgR=("avgR", "median"), median_1m_vs_5m=("last4w_1m_avgR", "median"), median_5m_last4w=("last4w_5m_avgR", "median"))
print(S.round(2).to_string())

# Topstep evals for each family's median version: 50K ($3k target, $2k trailing) and 150K ($9k, $4.5k), risk $500 / $750 per trade (MGC)
def evals(t, risk, target, dd):
    days = sorted(t.day.unique()); out = []
    for s in days:
        bal = peak = 0.0; res = "not finished (data ran out)"; nd = 0
        for _, g in t[t.day >= s].groupby("day", sort=True):
            nd += 1; bal += (g.R * risk).sum()
            if bal >= target: res = "pass"; break
            if bal <= peak - dd: res = "fail"; break
            peak = max(peak, bal)
        out.append((res, nd))
    o = pd.DataFrame(out, columns=["res", "days"]); fin = o[o.res != "not finished (data ran out)"]
    return dict(starts=len(o), finished=len(fin), pass_of_finished=(fin.res == "pass").mean() if len(fin) else np.nan, median_days_to_pass=o[o.res == "pass"].days.median())
E = []
for m, g in F.groupby("entry"):
    rep = g.iloc[(g.avgR - g.avgR.median()).abs().argsort().iloc[0]]; t = keep[(rep.entry, rep.bias, rep.manipulation, rep.target, rep.exit)]
    for acct, risk, tgt_, dd in (("50K", 500, 3000, 2000), ("150K", 750, 9000, 4500)):
        E.append(dict(entry=m, version=f"{rep.bias} / {rep.manipulation} / {rep.target} / {rep.exit}", account=acct, risk=risk, **evals(t, risk, tgt_, dd)))
E = pd.DataFrame(E); E.to_csv("results/po3_gc_family_eval.csv", index=False); print(); print(E.round(2).to_string(index=False))
