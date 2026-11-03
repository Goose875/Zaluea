"""Round 2 of v2: variants of the compression-breakout (NR) family, with a reduced management grid, same 3-way split."""
import numpy as np, pandas as pd, itertools, sys
from engine2 import engine2, ENTRY, STOPM, TRAIL
from rmultiple import prep_1h
from grid2 import seg_stats, SPLIT, cols
from common import SPECS, ema

def nr_setups(d):
    rng = d.High - d.Low
    def nr(n): return (rng == rng.rolling(n).min())
    hrs = d.index.hour
    active = pd.Series((hrs >= 3) & (hrs < 16), index=d.index)          # London open -> US close
    upT = d.ema20 > d.ema50; dnT = d.ema20 < d.ema50
    e200 = ema(d.Close, 200)
    inside = (d.High < d.High.shift()) & (d.Low > d.Low.shift())
    out = {}
    def brk(flag):   # flag on bar t-1, break on bar t
        f = flag.shift(fill_value=False)
        return f & (d.Close > d.High.shift()), f & (d.Close < d.Low.shift())
    base = {"NR7": nr(7), "NR4": nr(4), "NR10": nr(10), "NR7+inside (NR7ID)": nr(7) & inside, "NR4+inside (NR4ID)": nr(4) & inside,
            "Inside bar": inside}
    for k, f in base.items():
        L, S = brk(f); out[k] = (L, S)
    L, S = brk(nr(7)); out["NR7 + EMA20/50 trend"] = (L & upT, S & dnT)
    out["NR7 + above/below EMA200"] = (L & (d.Close > e200), S & (d.Close < e200))
    out["NR7 active hours 03-16 ET"] = (L & active.shift(fill_value=False), S & active.shift(fill_value=False))
    out["NR7 + trend + active hours"] = (L & upT & active.shift(fill_value=False), S & dnT & active.shift(fill_value=False))
    L4, S4 = brk(nr(4)); out["NR4 + trend + active hours"] = (L4 & upT & active.shift(fill_value=False), S4 & dnT & active.shift(fill_value=False))
    out["NR7 + volume dry-up"] = (L & (d.Volume.shift() < 0.7 * d.volavg.shift()), S & (d.Volume.shift() < 0.7 * d.volavg.shift()))
    return {k: (a.fillna(False).values.astype(bool), b.fillna(False).values.astype(bool)) for k, (a, b) in out.items()}

TARGETS = [0.0, 2.0, 3.0, 4.0, 5.0]; BES = [0.0, 0.5, 1.0]
TRAILS = [(0, 0.0), (1, 1.0), (2, 0.0), (4, 0.0), (4, 1.0), (1, 0.0)]
if __name__ == "__main__":
    rows = []
    for sym in ("NQ", "ES", "GC"):
        d, _, _ = prep_1h(sym); sp = SPECS[sym]
        cuts = np.array([(d.index <= pd.Timestamp(x + " 23:59", tz="America/New_York")).sum() for x in SPLIT])
        arrs = (d.Open.values, d.High.values, d.Low.values, d.Close.values, d.atr.values.astype(float), d.sess_id.values.astype(np.int64))
        for name, (L, S) in nr_setups(d).items():
            for dr in ("both", "long"):
                S_ = S if dr == "both" else np.zeros_like(S)
                for em, sm, k, be, (tr, ta) in itertools.product(range(5), range(3), TARGETS, BES, TRAILS):
                    r = engine2(*arrs, L, S_, em, sm, k, be, tr, ta, sp["tick"], float(sp["mult"]), sp["comm"])
                    segs = np.searchsorted(cuts, r[:, 0], side="right")
                    row = ["1h", sym, name, dr, ENTRY[em], STOPM[sm], k, be, TRAIL[tr], ta]
                    for s_i in range(3): row += list(seg_stats(r[segs == s_i]))
                    rows.append(row)
        print(sym, "done", file=sys.stderr)
    df = pd.DataFrame(rows, columns=cols(3, ["TR", "VA", "TE"])); df.to_csv("results/nr_family_1h.csv.gz", index=False, compression="gzip")
    f = df[(df.TR_n >= 50) & (df.VA_n >= 35) & (df.TR_avgR >= 0.10) & (df.VA_avgR >= 0.10) & (df.TR_pf >= 1.2) & (df.VA_pf >= 1.2)]
    pd.set_option("display.width", 300); pd.set_option("display.max_rows", 200)
    allg = df.groupby(["symbol", "setup", "dir"]).agg(combos=("TE_avgR", "size"), TR_med=("TR_avgR", "median"), VA_med=("VA_avgR", "median"), TE_med=("TE_avgR", "median"))
    pg = f.groupby(["symbol", "setup", "dir"]).agg(passed=("TE_avgR", "size"), pass_TE_med=("TE_avgR", "median"), pass_TE_pos=("TE_avgR", lambda x: (x > 0).mean()))
    print(allg.join(pg).fillna({"passed": 0}).sort_values(["symbol", "passed"], ascending=[True, False]).round(3).to_string())
