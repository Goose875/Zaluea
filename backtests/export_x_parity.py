"""Exports the research trades for Keel's K8, K9, P1-P3 so scripts/parity-x.js can check Keel's engine trade for trade."""
import numpy as np, pandas as pd, warnings; warnings.filterwarnings("ignore")
from portfolio_all import po3_trades, fractal_trades
from precise import load_1m, simulate
import po3
from common import SPECS
OUT = "results/parity_x"
def raw(sym, tf, model, bias, edge, tgt, hold):
    d, _ = load_1m(sym, tf); d = d.copy(); d["i"] = np.arange(len(d)); d["t"] = d.index; d, C, T = po3.build(d, "15min" if tf != "1h" else "60min")
    od = po3.orders_for(d, C, T, model, bias, edge, SPECS[sym]["tick"])
    if tf == "1h":
        cap = d["day"].map(d[d["mod"] == 900].groupby("day").i.last()); c_ = cap.values[od.i.clip(upper=len(d) - 1).values]
        od["end"] = np.where(np.isnan(c_), od.end, np.minimum(od.end, np.nan_to_num(c_, nan=1e18))).astype(np.int64)
    tg = {"none": 0 * od.stop, "3R": 3 * od.stop}[tgt].values
    t = simulate(d, sym, od, od.stop.values, tg, 0.0, 99)
    return pd.DataFrame(dict(fill_utc=[int(x.timestamp() * 1000) for x in d.index[t.fb.astype(int)]], side=t.side.astype(int), fill=t.fill, exit=t.exit, pnl=t.pnl.round(4)))
for nm, args in (("K9", ("GC", "1h", "RB", "4h EMA20", "below open", "none", "candle close")), ("P1", ("GC", "5m", "FVG CE", "none", "below open", "none", "candle close")),
                 ("P2", ("GC", "5m", "RB", "vs 18:00 open", "below open", "3R", "candle close")), ("P3", ("NQ", "5m", "FVG CE", "none", "below open", "none", "candle close"))):
    t = raw(*args); t.to_csv(f"{OUT}/{nm}.csv", index=False); print(nm, len(t))
import mt5nt
d = mt5nt.daily_frame("GC"); d[["Open", "High", "Low", "Close"]].assign(Volume=0).to_csv(f"{OUT}/GC_daily_frame.csv")
F = fractal_trades(); F.assign(day=F.exit_t.dt.date.astype(str), pnl_mini=0).to_csv(f"{OUT}/K8.csv", index=False); print("K8", len(F))
