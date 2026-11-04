"""Own intraday strategies for the precise 1-minute engine. Each returns orders: i (first live 1-min bar), side, type, px, exp.
type: 0 market (next open), 1 limit at px, 2 stop at px. Levels are exact prices; nothing peeks at a bar that hasn't closed."""
import numpy as np, pandas as pd

def day_levels(d):
    """Per 1-minute row: RTH open price, prior-day RTH high/low/close, overnight (18:00-09:29) high/low, RTH VWAP and its st.dev."""
    g = d.groupby("day", sort=False); idx = np.arange(len(d)); L = pd.DataFrame(index=d.index)
    rth = d[d.rth]; rg = rth.groupby("day")
    D = pd.DataFrame({"rh": rg.High.max(), "rl": rg.Low.min(), "rc": rg.Close.last(), "ro": rg.Open.first()})
    D[["pdh", "pdl", "pdc"]] = D[["rh", "rl", "rc"]].shift(); D["atr"] = (D.rh - D.rl).rolling(10, min_periods=3).mean().shift()
    for k in ("pdh", "pdl", "pdc", "ro", "atr"): L[k] = d["day"].map(D[k]).values
    on = d[(~d.rth) & (d["mod"] < 570) | (d["mod"] >= 1080)]
    O = on.groupby("day").agg(onh=("High", "max"), onl=("Low", "min"))
    L["onh"] = d["day"].map(O.onh).values; L["onl"] = d["day"].map(O.onl).values
    tp = (d.High + d.Low + d.Close) / 3; v = d.Volume.replace(0, 1).where(d.rth, 0).astype(float)
    cv = v.groupby(d["day"]).cumsum(); L["vwap"] = (tp * v).groupby(d["day"]).cumsum() / cv.replace(0, np.nan)
    L["vsd"] = np.sqrt(((tp - L.vwap) ** 2 * v).groupby(d["day"]).cumsum() / cv.replace(0, np.nan))
    return L

def orders(rows):
    o = pd.DataFrame(rows, columns=["i", "side", "type", "px", "exp"]) if rows else pd.DataFrame(columns=["i", "side", "type", "px", "exp"])
    return o.astype({"i": np.int64, "side": np.int64, "type": np.int64, "px": float, "exp": np.int64}).reset_index(drop=True)

def first_in_day(mask, d):
    """Indices where mask is true for the first time each trading day."""
    m = np.asarray(mask, bool); cs = pd.Series(m.astype(int)).groupby(d["day"].values).cumsum().values
    return np.where(m & (cs == 1))[0]

def resample(d, rule):
    r = d[["Open", "High", "Low", "Close", "Volume"]].resample(rule, label="right", closed="left").agg({"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"}).dropna()
    return r

def to_1m(d, htf, col):
    """Value of an HTF column known at each 1-min bar (HTF bar labelled by its close time; usable from that minute on)."""
    s = htf[col]; return s.reindex(d.index.union(s.index)).ffill().reindex(d.index).values

def strategies(d, sym, tick):
    L = day_levels(d); n = len(d); o, h, l, c, mod = (d[x].values for x in ("Open", "High", "Low", "Close", "mod")); rth = d.rth.values
    S = {}
    # --- Opening-range breakout / fade (first N minutes of RTH) ---
    for N in (5, 15, 30, 60):
        inor = rth & (mod < 570 + N)
        orh = pd.Series(np.where(inor, h, np.nan)).groupby(d["day"].values).cummax().groupby(d["day"].values).ffill().values
        orl = pd.Series(np.where(inor, l, np.nan)).groupby(d["day"].values).cummin().groupby(d["day"].values).ffill().values
        start = np.where(rth & (mod == 570 + N))[0]
        S[f"ORB {N}m breakout (stop orders)"] = orders([(i, 1, 2, orh[i] + tick, 150) for i in start] + [(i, -1, 2, orl[i] - tick, 150) for i in start])
        brk_up = rth & (mod >= 570 + N) & (mod < 720) & (c > orh); brk_dn = rth & (mod >= 570 + N) & (mod < 720) & (c < orl)
        back_in_up = pd.Series(brk_up).groupby(d["day"].values).cummax().values & (c < orh) & rth & (mod < 750)
        back_in_dn = pd.Series(brk_dn).groupby(d["day"].values).cummax().values & (c > orl) & rth & (mod < 750)
        S[f"ORB {N}m failed break fade"] = orders([(i + 1, -1, 0, 0, 1) for i in first_in_day(back_in_up, d)] + [(i + 1, 1, 0, 0, 1) for i in first_in_day(back_in_dn, d)])
        S[f"ORB {N}m retest limit"] = orders([(i + 1, 1, 1, orh[i], 120) for i in first_in_day(brk_up, d)] + [(i + 1, -1, 1, orl[i], 120) for i in first_in_day(brk_dn, d)])
    # --- Prior-day and overnight high / low ---
    for nm, hi, lo in (("prior-day", L.pdh.values, L.pdl.values), ("overnight", L.onh.values, L.onl.values)):
        live = rth & (mod < 900)
        up = live & (c > hi); dn = live & (c < lo)
        S[f"{nm} high/low breakout close"] = orders([(i + 1, 1, 0, 0, 1) for i in first_in_day(up, d)] + [(i + 1, -1, 0, 0, 1) for i in first_in_day(dn, d)])
        swept_h = pd.Series(live & (h > hi)).groupby(d["day"].values).cummax().values; swept_l = pd.Series(live & (l < lo)).groupby(d["day"].values).cummax().values
        S[f"{nm} sweep + reclaim fade"] = orders([(i + 1, -1, 0, 0, 1) for i in first_in_day(swept_h & live & (c < hi), d)] + [(i + 1, 1, 0, 0, 1) for i in first_in_day(swept_l & live & (c > lo), d)])
        op = rth & (mod == 570)
        S[f"{nm} level limit fade (first touch)"] = orders([(i, -1, 1, hi[i], 330) for i in np.where(op & (o < hi))[0]] + [(i, 1, 1, lo[i], 330) for i in np.where(op & (o > lo))[0]])
    # --- Initial balance (9:30-10:30) breakout ---
    inib = rth & (mod < 630)
    ibh = pd.Series(np.where(inib, h, np.nan)).groupby(d["day"].values).cummax().groupby(d["day"].values).ffill().values
    ibl = pd.Series(np.where(inib, l, np.nan)).groupby(d["day"].values).cummin().groupby(d["day"].values).ffill().values
    st = np.where(rth & (mod == 630))[0]
    S["IB breakout (stop orders)"] = orders([(i, 1, 2, ibh[i] + tick, 300) for i in st] + [(i, -1, 2, ibl[i] - tick, 300) for i in st])
    # --- VWAP ---
    vw, sd = L.vwap.values, L.vsd.values; m5 = resample(d, "5min"); v5 = pd.Series(vw, index=d.index).resample("5min", label="right", closed="left").last()
    above = (m5.Close > v5.reindex(m5.index)).rolling(6).sum() == 6; below = (m5.Close < v5.reindex(m5.index)).rolling(6).sum() == 6
    ab, bl = to_1m(d, pd.DataFrame({"a": above.astype(float)}), "a") == 1, to_1m(d, pd.DataFrame({"b": below.astype(float)}), "b") == 1
    win = rth & (mod >= 600) & (mod < 900)
    S["VWAP pullback in trend (limit at VWAP)"] = orders([(i + 1, 1, 1, vw[i], 60) for i in first_in_day(win & ab, d)] + [(i + 1, -1, 1, vw[i], 60) for i in first_in_day(win & bl, d)])
    for k in (2.0, 2.5):
        S[f"VWAP {k} sd band fade"] = orders([(i + 1, -1, 0, 0, 1) for i in first_in_day(win & (c > vw + k * sd) & (sd > 0), d)] + [(i + 1, 1, 0, 0, 1) for i in first_in_day(win & (c < vw - k * sd) & (sd > 0), d)])
    # --- Gap ---
    op = np.where(rth & (mod == 570))[0]; gap = (o - L.pdc.values) / L.atr.values
    S["Gap fade (>0.3 day ATR) at open"] = orders([(i + 1, -int(np.sign(gap[i])), 0, 0, 1) for i in op if abs(gap[i]) > 0.3])
    S["Gap go (>0.3 day ATR) at open"] = orders([(i + 1, int(np.sign(gap[i])), 0, 0, 1) for i in op if abs(gap[i]) > 0.3])
    # --- Fair value gaps on 5m / 15m with 1h EMA20 trend, limit at the gap's near edge ---
    h1 = resample(d, "60min"); h1["e"] = h1.Close.ewm(span=20, adjust=False).mean(); h1["up"] = (h1.e > h1.e.shift()).astype(float)
    up1 = to_1m(d, h1, "up")
    for tf in ("5min", "15min"):
        x = resample(d, tf); bull = x.Low > x.High.shift(2); bear = x.High < x.Low.shift(2)
        F = pd.DataFrame({"bt": np.where(bull, x.Low, np.nan), "st": np.where(bear, x.High, np.nan)}, index=x.index)
        pos = d.index.searchsorted(F.index); rows = []
        for j, (t, r) in enumerate(F.iterrows()):
            i = pos[j]
            if i >= n or not rth[i] or mod[i] >= 900: continue
            if r.bt == r.bt and up1[i] == 1: rows.append((i, 1, 1, r.bt, 60))
            if r.st == r.st and up1[i] == 0: rows.append((i, -1, 1, r.st, 60))
        S[f"{tf} FVG retrace with 1h trend"] = orders(rows)
    # --- 1m EMA pullback in 15m trend ---
    m15 = resample(d, "15min"); m15["e"] = m15.Close.ewm(span=20, adjust=False).mean(); m15["up"] = np.sign(m15.Close - m15.e)
    t15 = to_1m(d, m15, "up"); e9 = pd.Series(c).ewm(span=9, adjust=False).mean().values; e21 = pd.Series(c).ewm(span=21, adjust=False).mean().values
    pbL = win & (t15 > 0) & (e9 > e21) & (l <= e21) & (c > e21); pbS = win & (t15 < 0) & (e9 < e21) & (h >= e21) & (c < e21)
    S["1m EMA21 pullback in 15m trend"] = orders([(i + 1, 1, 0, 0, 1) for i in np.where(pbL)[0]] + [(i + 1, -1, 0, 0, 1) for i in np.where(pbS)[0]])
    # --- Round numbers (NQ 100, ES 25, GC 10): limit fade at the next round level from the open ---
    step = 100 if tick == 0.25 and c.mean() > 10000 else (25 if tick == 0.25 else 10)
    rows = []
    for i in op:
        up_lv = np.ceil(o[i] / step) * step; dn_lv = np.floor(o[i] / step) * step
        if up_lv - o[i] > 2 * tick: rows.append((i, -1, 1, up_lv, 300))
        if o[i] - dn_lv > 2 * tick: rows.append((i, 1, 1, dn_lv, 300))
    S["Round-number limit fade"] = orders(rows)
    # --- London (03:00-08:00 ET) range: breakout in NY ---
    ldn = (mod >= 180) & (mod < 480)
    lh = pd.Series(np.where(ldn, h, np.nan)).groupby(d["day"].values).transform("max").values
    ll = pd.Series(np.where(ldn, l, np.nan)).groupby(d["day"].values).transform("min").values
    st8 = np.where(mod == 570)[0]
    S["London range breakout in NY (stop orders)"] = orders([(i, 1, 2, lh[i] + tick, 240) for i in st8 if lh[i] == lh[i] and o[i] < lh[i]] + [(i, -1, 2, ll[i] - tick, 240) for i in st8 if ll[i] == ll[i] and o[i] > ll[i]])
    return S

def random_orders(d, nL, nS, seed):
    """Market orders at random RTH minutes (10:00-15:00), one per day at most, as a luck control."""
    rng = np.random.default_rng(seed); cand = np.where(d.rth.values & (d["mod"].values >= 600) & (d["mod"].values < 900))[0]
    pick = rng.choice(cand, min(len(cand), nL + nS), replace=False); side = np.r_[np.ones(nL), -np.ones(nS)][: len(pick)]; rng.shuffle(side)
    return orders([(i, int(s), 0, 0, 1) for i, s in zip(pick, side)])
