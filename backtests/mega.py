"""MEGA SEARCH (1h bars, continuous NQ1!/ES1!/GC1!, Jun 2024 - Nov 2026).
TRIGGERS  = 37 price levels x 3 interactions (break / reject / retest)  +  37 existing setups  +  20 RANDOM controls
DIRECTION = both / long only / short only
FILTERS   = daily SMA50 regime (with/none/against) x hourly EMA20/50 trend (with/none) x volatility (low/high/any) x window (Asia/London/NY AM/NY PM/any)
MGMT      = entry (market/confirm/limit50) x stop (signal bar/1ATR/5-bar) x target (1R/2R/3R/none) x BE(+1R on/off) x trail(1.5ATR after 1R on/off)
Splits: TRAIN to 2025-03-31, VALID to 2025-11-30, TEST to 2026-11-02 (TEST never used for selection)."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd, itertools, time, sys
from mega_engine import run_block
from rmultiple import prep_1h
from setups2 import setups as setups_v2
from nr_family import nr_setups
from setups_new import new_setups
import ict
from common import SPECS, load, sma, ema
ROUND = {"NQ": 250.0, "ES": 50.0, "GC": 25.0}
SPLIT = ("2025-03-31", "2025-11-30")
M = np.array([[em, sm, k, be, tr] for em in (0, 1, 2) for sm in (0, 1, 2) for k in (1.0, 2.0, 3.0, 0.0) for be in (0, 1) for tr in (0, 1)], float)

def levels(sym):
    d = prep_1h(sym)[0]; di = ict.prep(sym, "1h")
    assert (d.index == di.index).all()
    s = pd.Series(d.sess.values, index=d.index); h = d.index.hour.values
    day = d.groupby("sess").agg(H=("High", "max"), L=("Low", "min"), C=("Close", "last"))
    prev = day.shift(); P = (prev.H + prev.L + prev.C) / 3; rng = prev.H - prev.L
    mp = lambda x: s.map(x).values
    Lv = {"prior-day high": di.pdh.values, "prior-day low": di.pdl.values, "prior-day close": mp(prev.C), "prior-day mid": di.pd_mid.values,
          "pivot P": mp(P), "pivot R1": mp(2 * P - prev.L), "pivot S1": mp(2 * P - prev.H), "pivot R2": mp(P + rng), "pivot S2": mp(P - rng),
          "camarilla H3": mp(prev.C + 1.1 * rng / 4), "camarilla L3": mp(prev.C - 1.1 * rng / 4),
          "camarilla H4": mp(prev.C + 1.1 * rng / 2), "camarilla L4": mp(prev.C - 1.1 * rng / 2)}
    dd = load(f"{sym}_cont_1d.csv"); wk = dd.index.to_period("W"); mo = dd.index.to_period("M")
    wh = dd.High.groupby(wk).max().shift(); wl = dd.Low.groupby(wk).min().shift()
    mh = dd.High.groupby(mo).max().shift(); ml = dd.Low.groupby(mo).min().shift()
    sd = pd.to_datetime(pd.Series(d.sess.values))
    Lv["prior-week high"] = sd.dt.to_period("W").map(wh).values.astype(float); Lv["prior-week low"] = sd.dt.to_period("W").map(wl).values.astype(float)
    Lv["prior-month high"] = sd.dt.to_period("M").map(mh).values.astype(float); Lv["prior-month low"] = sd.dt.to_period("M").map(ml).values.astype(float)
    for k_ in ("asia_h", "asia_l", "lon_h", "lon_l", "on_h", "on_l"): Lv[{"asia_h": "Asia high", "asia_l": "Asia low", "lon_h": "London high",
            "lon_l": "London low", "on_h": "overnight high", "on_l": "overnight low"}[k_]] = di[k_].values
    Lv["prior VAH"], Lv["prior VAL"], Lv["prior POC"] = di.pvah.values, di.pval.values, di.ppoc.values
    ib = pd.Series(h == 9, index=d.index)
    ibh = d.High.where(ib).groupby(s).transform("max").where(pd.Series(h >= 10, index=d.index) & pd.Series(h < 17, index=d.index))
    ibl = d.Low.where(ib).groupby(s).transform("min").where(pd.Series(h >= 10, index=d.index) & pd.Series(h < 17, index=d.index))
    Lv["IB high"], Lv["IB low"] = ibh.values, ibl.values
    Lv["IB 1x ext up"], Lv["IB 1x ext down"] = (ibh + (ibh - ibl)).values, (ibl - (ibh - ibl)).values
    dev = d.Close - d.vwap; sdv = dev.groupby(s).transform(lambda x: x.expanding(3).std())
    Lv["session VWAP"] = d.vwap.values
    for m_, nm in ((1, "1σ"), (2, "2σ")): Lv[f"VWAP +{nm}"], Lv[f"VWAP -{nm}"] = (d.vwap + m_ * sdv).values, (d.vwap - m_ * sdv).values
    pc = d.Close.shift(); st = ROUND[sym]
    Lv["round number above"] = (np.ceil(pc / st) * st).values; Lv["round number below"] = (np.floor(pc / st) * st).values
    return d, Lv

def interactions(d, X):
    c, hh, ll = d.Close.values, d.High.values, d.Low.values; cp = np.r_[np.nan, c[:-1]]; ok = np.isfinite(X) & np.isfinite(np.r_[np.nan, X[:-1]])
    Xp = np.r_[np.nan, X[:-1]]
    bu = ok & (c > X) & (cp <= Xp); bd = ok & (c < X) & (cp >= Xp)
    rs = ok & (ll < X) & (c > X) & (cp > Xp); rr = ok & (hh > X) & (c < X) & (cp < Xp)
    rb_u = pd.Series(bu).rolling(6, min_periods=1).max().shift(1).fillna(0).values.astype(bool)
    rb_d = pd.Series(bd).rolling(6, min_periods=1).max().shift(1).fillna(0).values.astype(bool)
    return {"break": (bu, bd), "reject": (rs, rr), "retest": (rb_u & (ll <= X) & (c > X), rb_d & (hh >= X) & (c < X))}

def triggers(sym, d, Lv, n_random=20):
    T = {}
    for nm, X in Lv.items():
        for it, (L, S) in interactions(d, X.astype(float)).items(): T[f"LEVEL {nm} {it}"] = (L, S)
    for src in (setups_v2(d), {k: v for k, v in nr_setups(d).items() if k != "NR7"}, new_setups(d, sym)):
        for k_, (L, S) in src.items(): T[f"SETUP {k_}"] = (np.asarray(L, bool), np.asarray(S, bool))
    rng = np.random.default_rng(hash(sym) % 2**32)
    for r in range(n_random):
        p = rng.uniform(0.01, 0.05); x = rng.random(len(d)); T[f"RANDOM #{r:02d}"] = (x < p / 2, (x >= p / 2) & (x < p))
    return T

def filters(d, sym):
    h = d.index.hour.values
    dd = load(f"{sym}_cont_1d.csv"); up = (dd.Close > sma(dd.Close, 50)).shift(1); up.index = up.index.date
    reg = d.sess.map(up).astype("boolean").fillna(False).to_numpy(dtype=bool)
    tr = (d.ema20 > d.ema50).values
    a100 = d.atr.rolling(100).mean().values; volhi = d.atr.values > a100
    win = {"any": np.ones(len(d), bool), "Asia 18-02": (h >= 18) | (h < 2), "London 02-08": (h >= 2) & (h < 8),
           "NY AM 08-12": (h >= 8) & (h < 12), "NY PM 12-17": (h >= 12) & (h < 17)}
    F = []
    for rg, tf, vl, wn in itertools.product(("none", "with", "against"), ("none", "with"), ("any", "low", "high"), win):
        lm = win[wn].copy(); sm_ = win[wn].copy()
        if rg == "with": lm &= reg; sm_ &= ~reg
        if rg == "against": lm &= ~reg; sm_ &= reg
        if tf == "with": lm &= tr; sm_ &= ~tr
        if vl == "low": lm &= ~volhi; sm_ &= ~volhi
        if vl == "high": lm &= volhi; sm_ &= volhi
        F.append(((rg, tf, vl, wn), lm, sm_))
    return F

if __name__ == "__main__":
    t0 = time.time(); total = 0
    for sym in ("NQ", "ES", "GC"):
        d, Lv = levels(sym); sp = SPECS[sym]; T = triggers(sym, d, Lv); F = filters(d, sym)
        cuts = [int((d.index <= pd.Timestamp(x + " 23:59", tz="America/New_York")).sum()) for x in SPLIT]
        arrs = (d.Open.values, d.High.values, d.Low.values, d.Close.values, d.atr.values.astype(float), d.sess_id.values.astype(np.int64))
        meta, chunks = [], []
        for tname, (L0, S0) in T.items():
            for dr in ("both", "long", "short"):
                L1 = L0 if dr != "short" else np.zeros_like(L0); S1 = S0 if dr != "long" else np.zeros_like(S0)
                Lm, Sm, mm = [], [], []
                for (key, lm, sm_) in F:
                    Lx, Sx = L1 & lm, S1 & sm_
                    if Lx.sum() + Sx.sum() < 40: continue
                    Lm.append(Lx); Sm.append(Sx); mm.append((tname, dr) + key)
                if not Lm: continue
                res = run_block(*arrs, np.array(Lm), np.array(Sm), M, cuts[0], cuts[1], sp["tick"], float(sp["mult"]), sp["comm"])
                chunks.append(res); meta += mm; total += res.shape[0] * res.shape[1]
        R = np.concatenate(chunks); np.save(f"results/mega_{sym}.npy", R)
        pd.DataFrame(meta, columns=["trigger", "dir", "regime", "trend", "vol", "window"]).to_csv(f"results/mega_{sym}_meta.csv", index=False)
        print(f"{sym}: {R.shape[0]:,} signal variants x {R.shape[1]} mgmt = {R.shape[0]*R.shape[1]:,} strategies  ({time.time()-t0:.0f}s)", flush=True)
    np.save("results/mega_M.npy", M); print(f"TOTAL strategies simulated: {total:,}")
