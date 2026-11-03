"""ICT concepts + public 'key level' (Rocket-Scooter-style) setups, coded as explicit, look-ahead-free rules.
Times are New York. Globex day = 18:00 -> 17:00 (key = date of the 17:00 close).

Definitions (all known at the signal bar's close):
  PDH/PDL     prior Globex-day high/low              ONH/ONL  overnight 18:00-09:30 high/low (valid from 09:30)
  Asia H/L    20:00-00:00 range (valid from 00:00)   London H/L 02:00-05:00 range (valid from 05:00)
  swing high/low   2-left/2-right pivot, usable only 2 bars after the pivot (confirmation delay)
  FVG (bullish)    low[i] > high[i-2] and displacement candle i-1 body > 1 x ATR (bearish = mirror)
  sweep        price trades beyond a liquidity level (it 'takes' the resting stops)
  MSS          after a sweep of a high, a close below the most recent confirmed swing low (mirror for lows)
  kill zones   London 02:00-05:00, New York AM 09:30-11:30 (bar start time)
  value area   prior regular-session volume profile: POC + 70% of volume around it (VAH/VAL)"""
import numpy as np, pandas as pd
from common import load, atr, ema

def prep(sym, tf):
    if tf == "5m":
        d = load(f"{sym}_cont_5m.csv", tz=True); d = d[d.index < "2026-11-03"].copy()
    else:
        d = load(f"{sym}_cont_1h.csv", tz=True); d = d[d.index < "2026-11-03"].copy()
    d["key"] = (d.index + pd.Timedelta(hours=6)).date
    d["mins"] = d.index.hour * 60 + d.index.minute
    d["atr"] = atr(d, 14); d["ema50"] = ema(d.Close, 50)
    d["sess_id"] = pd.factorize(d.key)[0]
    m = d.mins.values; key = d.key
    def rng(mask, valid):
        hh = d.High.where(mask).groupby(key).transform("max"); ll = d.Low.where(mask).groupby(key).transform("min")
        return hh.where(valid), ll.where(valid)
    is_asia = (m >= 1200) & (m < 1440); is_lon = (m >= 120) & (m < 300)
    is_on = (m >= 1080) | (m < 570); rth = (m >= 570) & (m < 960)
    after = lambda t: pd.Series((m >= t) & (m < 1020), index=d.index)
    d["asia_h"], d["asia_l"] = rng(pd.Series(is_asia, index=d.index), after(0))
    d["lon_h"], d["lon_l"] = rng(pd.Series(is_lon, index=d.index), after(300))
    d["on_h"], d["on_l"] = rng(pd.Series(is_on, index=d.index), after(570))
    dayh = d.High.groupby(key).max(); dayl = d.Low.groupby(key).min()
    d["pdh"] = key.map(dayh.shift()); d["pdl"] = key.map(dayl.shift())
    d["pd_mid"] = (d.pdh + d.pdl) / 2
    # rth open (5m only is exact)
    ro = d.Open.where(pd.Series(m == 570, index=d.index)).groupby(key).transform("max")
    d["rth_open"] = ro.where(pd.Series(m >= 570, index=d.index))
    # prior-day value area from RTH volume profile
    vah, val, poc = {}, {}, {}
    for k_, g in d[pd.Series(rth, index=d.index)].groupby("key"):
        tp = ((g.High + g.Low + g.Close) / 3).values; v = g.Volume.values.astype(float)
        if v.sum() <= 0 or len(g) < 3: continue
        bins = np.linspace(g.Low.min(), g.High.max(), 41); idx = np.clip(np.digitize(tp, bins) - 1, 0, 39)
        hist = np.bincount(idx, weights=v, minlength=40); p = hist.argmax(); lo = hi = p; tot = hist[p]
        while tot < 0.7 * hist.sum():
            up = hist[hi + 1] if hi < 39 else -1; dn = hist[lo - 1] if lo > 0 else -1
            if up >= dn: hi += 1; tot += up
            else: lo -= 1; tot += dn
        vah[k_], val[k_], poc[k_] = bins[hi + 1], bins[lo], (bins[p] + bins[p + 1]) / 2
    ks = sorted(vah); prev = {ks[i]: ks[i - 1] for i in range(1, len(ks))}
    d["pvah"] = d.key.map(lambda k_: vah.get(prev.get(k_), np.nan)); d["pval"] = d.key.map(lambda k_: val.get(prev.get(k_), np.nan))
    d["ppoc"] = d.key.map(lambda k_: poc.get(prev.get(k_), np.nan))
    # confirmed swings
    h, l = d.High.values, d.Low.values; n = len(d); sh = np.full(n, np.nan); sl = np.full(n, np.nan); lsh = np.nan; lsl = np.nan
    for i in range(4, n):
        p = i - 2
        if h[p] > max(h[p-2], h[p-1]) and h[p] >= max(h[p+1], h[p+2]): lsh = h[p]
        if l[p] < min(l[p-2], l[p-1]) and l[p] <= min(l[p+1], l[p+2]): lsl = l[p]
        sh[i] = lsh; sl[i] = lsl
    d["swing_h"] = sh; d["swing_l"] = sl
    a = d.atr.values; o, c = d.Open.values, d.Close.values
    body = np.r_[np.nan, (c - o)[:-1]]                       # body of candle i-1
    h2 = np.r_[np.nan, np.nan, h[:-2]]; l2 = np.r_[np.nan, np.nan, l[:-2]]
    d["bull_fvg"] = (l > h2) & (body > a); d["bear_fvg"] = (h < l2) & (-body > a)
    d["fvg_lo"] = np.where(d.bull_fvg, h2, np.where(d.bear_fvg, h, np.nan))
    d["fvg_hi"] = np.where(d.bull_fvg, l, np.where(d.bear_fvg, l2, np.nan))
    return d

def killzone(m, tf):
    return ((m >= 120) & (m < 300)) | ((m >= 570) & (m < 690)) if tf == "5m" else ((m >= 120) & (m < 300)) | ((m >= 540) & (m < 720))

def empty(n): return np.zeros(n), np.full(n, np.nan), np.full(n, np.nan), np.full(n, np.nan)

# ------------------------------------------------------------------ ICT setups
def sweep_mss(d, tf, levels=("pdh", "asia_h", "lon_h", "on_h"), entry="fvg_ce", window=None, kz=True, tick=0.25):
    """ICT 2022 model: sweep of buy-side (sell-side) liquidity -> MSS -> entry on the displacement FVG
    (entry = 'fvg_ce' consequent encroachment 50% of FVG, 'fvg_edge' first touch, 'ote' 70.5% retracement, 'market')."""
    n = len(d); side, lim, stp, tgt = empty(n)
    h, l, c = d.High.values, d.Low.values, d.Close.values; m = d.mins.values; key = d.key.values
    window = window or (12 if tf == "5m" else 6)
    lv_hi = np.column_stack([d[x].values for x in levels]); lv_lo = np.column_stack([d[x.replace("_h", "_l").replace("pdh", "pdl")].values for x in levels])
    bull, bear = d.bull_fvg.values, d.bear_fvg.values; flo, fhi = d.fvg_lo.values, d.fvg_hi.values
    swl, swh = d.swing_l.values, d.swing_h.values; kzm = killzone(m, tf)
    used = set()
    for i in range(3, n):
        if kz and not kzm[i]: continue
        for s_, LV, OPP in ((-1, lv_hi, lv_lo), (1, lv_lo, lv_hi)):
            for li in range(LV.shape[1]):
                lvl = LV[i, li]
                if not np.isfinite(lvl) or (key[i], s_, li) in used: continue
                swept = (h[i] > lvl and h[i-1] <= lvl) if s_ == -1 else (l[i] < lvl and l[i-1] >= lvl)
                if not swept: continue
                ext = h[i] if s_ == -1 else l[i]; ref = swl[i] if s_ == -1 else swh[i]
                for j in range(i, min(i + window, n)):
                    if key[j] != key[i]: break
                    ext = max(ext, h[j]) if s_ == -1 else min(ext, l[j])
                    if (s_ == -1 and c[j] < ref) or (s_ == 1 and c[j] > ref):    # MSS
                        fv = -1
                        for q in range(j, i, -1):
                            if (s_ == -1 and bear[q]) or (s_ == 1 and bull[q]): fv = q; break
                        if entry in ("fvg_ce", "fvg_edge") and fv < 0: break
                        side[j] = s_; stp[j] = ext + (-s_) * tick
                        tgt[j] = OPP[j, li] if np.isfinite(OPP[j, li]) else np.nan
                        if entry == "fvg_ce": lim[j] = (flo[fv] + fhi[fv]) / 2
                        elif entry == "fvg_edge": lim[j] = fhi[fv] if s_ == 1 else flo[fv]
                        elif entry == "ote":
                            leg_ext = min(l[i:j+1]) if s_ == -1 else max(h[i:j+1])
                            lim[j] = leg_ext + 0.705 * (ext - leg_ext)
                        used.add((key[i], s_, li)); break
                break
    return side, lim, stp, tgt

def silver_bullet(d, tf, start=600, end=660, tick=0.25, hi_lv="on_h", lo_lv="on_l", bias_from=510):
    """ICT Silver Bullet: in the 10:00-11:00 window, the first FVG that forms in the direction AWAY from liquidity
    already swept this morning (overnight high/low or RTH-open range) -> limit at the FVG edge, stop beyond the
    displacement leg, target = opposite liquidity (overnight low/high)."""
    n = len(d); side, lim, stp, tgt = empty(n)
    h, l = d.High.values, d.Low.values; m = d.mins.values; key = d.key.values
    onh, onl = d[hi_lv].values, d[lo_lv].values; bull, bear = d.bull_fvg.values, d.bear_fvg.values; flo, fhi = d.fvg_lo.values, d.fvg_hi.values
    done = set(); bias = {}
    for i in range(3, n):
        if bias_from <= m[i] < end and np.isfinite(onh[i]):
            if h[i] > onh[i]: bias[key[i]] = -1
            if l[i] < onl[i]: bias[key[i]] = 1
        if not (start <= m[i] < end) or key[i] in done: continue
        b = bias.get(key[i], 0)
        if b == 1 and bull[i]:
            side[i] = 1; lim[i] = fhi[i]; stp[i] = min(l[i-2], l[i-1]) - tick; tgt[i] = onh[i]; done.add(key[i])
        elif b == -1 and bear[i]:
            side[i] = -1; lim[i] = flo[i]; stp[i] = max(h[i-2], h[i-1]) + tick; tgt[i] = onl[i]; done.add(key[i])
    return side, lim, stp, tgt

def judas_swing(d, tf, tick=0.25):
    """NY-open Judas swing: between 09:30 and 10:30 price runs through the overnight high (low) then closes back
    below (above) the RTH open -> enter at market, stop beyond the Judas extreme, target overnight low (high)."""
    n = len(d); side, lim, stp, tgt = empty(n)
    h, l, c = d.High.values, d.Low.values, d.Close.values; m = d.mins.values; key = d.key.values
    onh, onl, ro = d.on_h.values, d.on_l.values, d.rth_open.values; st = {}
    for i in range(n):
        if not (570 <= m[i] < 630) or not np.isfinite(ro[i]): continue
        s = st.setdefault(key[i], {"hi": -np.inf, "lo": np.inf, "done": False})
        s["hi"] = max(s["hi"], h[i]); s["lo"] = min(s["lo"], l[i])
        if s["done"]: continue
        if s["hi"] > onh[i] and c[i] < ro[i]:
            side[i] = -1; stp[i] = s["hi"] + tick; tgt[i] = onl[i]; s["done"] = True
        elif s["lo"] < onl[i] and c[i] > ro[i]:
            side[i] = 1; stp[i] = s["lo"] - tick; tgt[i] = onh[i]; s["done"] = True
    return side, lim, stp, tgt

def asia_sweep(d, tf, tick=0.25):
    """London session (02:00-05:00) raids the Asian range high (low) and closes back inside -> fade toward the other side."""
    n = len(d); side, lim, stp, tgt = empty(n)
    h, l, c = d.High.values, d.Low.values, d.Close.values; m = d.mins.values; key = d.key.values
    ah, al = d.asia_h.values, d.asia_l.values; done = set(); ext = {}
    for i in range(n):
        if not (120 <= m[i] < 300) or not np.isfinite(ah[i]) or key[i] in done: continue
        e = ext.setdefault(key[i], [-np.inf, np.inf]); e[0] = max(e[0], h[i]); e[1] = min(e[1], l[i])
        if e[0] > ah[i] and c[i] < ah[i] and h[i] >= ah[i]:
            side[i] = -1; stp[i] = e[0] + tick; tgt[i] = al[i]; done.add(key[i])
        elif e[1] < al[i] and c[i] > al[i] and l[i] <= al[i]:
            side[i] = 1; stp[i] = e[1] - tick; tgt[i] = ah[i]; done.add(key[i])
    return side, lim, stp, tgt

def turtle_soup(d, tf, tick=0.25):
    """ICT turtle soup on prior-day high/low: a bar trades through PDH (PDL) and closes back inside -> fade."""
    n = len(d); side, lim, stp, tgt = empty(n)
    h, l, c = d.High.values, d.Low.values, d.Close.values; key = d.key.values; pdh, pdl = d.pdh.values, d.pdl.values; done = set()
    for i in range(n):
        if not np.isfinite(pdh[i]): continue
        if (key[i], -1) not in done and h[i] > pdh[i] and c[i] < pdh[i]:
            side[i] = -1; stp[i] = h[i] + tick; tgt[i] = d.pd_mid.values[i]; done.add((key[i], -1))
        elif (key[i], 1) not in done and l[i] < pdl[i] and c[i] > pdl[i]:
            side[i] = 1; stp[i] = l[i] - tick; tgt[i] = d.pd_mid.values[i]; done.add((key[i], 1))
    return side, lim, stp, tgt

def fvg_trend(d, tf, pd_filter=True, tick=0.25):
    """FVG continuation in trend during kill zones: bullish FVG while close > EMA50 (and in 'discount' = below prior-day
    midpoint when pd_filter) -> limit at FVG top edge, stop below FVG candle-1 low."""
    n = len(d); side, lim, stp, tgt = empty(n)
    l, h, c = d.Low.values, d.High.values, d.Close.values; m = d.mins.values; e50 = d.ema50.values; mid = d.pd_mid.values
    bull, bear = d.bull_fvg.values, d.bear_fvg.values; flo, fhi = d.fvg_lo.values, d.fvg_hi.values; kzm = killzone(m, tf)
    for i in range(3, n):
        if not kzm[i]: continue
        if bull[i] and c[i] > e50[i] and (not pd_filter or c[i] < mid[i]):
            side[i] = 1; lim[i] = fhi[i]; stp[i] = l[i-2] - tick
        elif bear[i] and c[i] < e50[i] and (not pd_filter or c[i] > mid[i]):
            side[i] = -1; lim[i] = flo[i]; stp[i] = h[i-2] + tick
    return side, lim, stp, tgt

# ------------------------------------------------------------------ public key-level setups (Rocket-Scooter-style)
def eighty_rule(d, tf, tick=0.25):
    """Market Profile 80% rule: RTH opens outside the prior value area, then price is accepted back inside it for
    1 hour (12 x 5m or 1 x 1h closes) -> trade to the other side of the value area. Stop beyond the session extreme."""
    n = len(d); side, lim, stp, tgt = empty(n)
    c, h, l = d.Close.values, d.High.values, d.Low.values; m = d.mins.values; key = d.key.values
    vah, val, ro = d.pvah.values, d.pval.values, d.rth_open.values if tf == "5m" else d.Open.where(d.mins == 540).groupby(d.key).transform("max").values
    need = 12 if tf == "5m" else 1; st = {}
    for i in range(n):
        if not ((570 if tf == "5m" else 540) <= m[i] < 900) or not np.isfinite(vah[i]) or not np.isfinite(ro[i]): continue
        s = st.setdefault(key[i], {"in": 0, "hi": -np.inf, "lo": np.inf, "done": False}); s["hi"] = max(s["hi"], h[i]); s["lo"] = min(s["lo"], l[i])
        if s["done"]: continue
        inside = val[i] < c[i] < vah[i]; s["in"] = s["in"] + 1 if inside else 0
        if s["in"] >= need:
            if ro[i] > vah[i]: side[i] = -1; stp[i] = s["hi"] + tick; tgt[i] = val[i]
            elif ro[i] < val[i]: side[i] = 1; stp[i] = s["lo"] - tick; tgt[i] = vah[i]
            s["done"] = True
    return side, lim, stp, tgt

def level_break_retest(d, tf, tick=0.25):
    """Key-level break & retest: close above prior-day high (or overnight high), later a pullback touches the level
    and closes back above it -> long; stop 0.5 ATR below the level; target R-based (mirror for shorts)."""
    n = len(d); side, lim, stp, tgt = empty(n)
    c, h, l, a = d.Close.values, d.High.values, d.Low.values, d.atr.values; key = d.key.values
    LV = [("pdh", "pdl"), ("on_h", "on_l")]; state = {}
    for i in range(1, n):
        for hi_n, lo_n in LV:
            H, Lo = d[hi_n].values[i], d[lo_n].values[i]
            if not np.isfinite(H): continue
            s = state.setdefault((key[i], hi_n), {"up": False, "dn": False, "done": False})
            if s["done"]: continue
            if s["up"] and l[i] <= H and c[i] > H: side[i] = 1; stp[i] = H - 0.5 * a[i]; s["done"] = True; continue
            if s["dn"] and h[i] >= Lo and c[i] < Lo: side[i] = -1; stp[i] = Lo + 0.5 * a[i]; s["done"] = True; continue
            if c[i] > H and c[i-1] <= H: s["up"] = True
            if c[i] < Lo and c[i-1] >= Lo: s["dn"] = True
    return side, lim, stp, tgt

def level_fade(d, tf, tick=0.25):
    """First touch of the overnight high/low or prior-day high/low during RTH -> fade with a limit at the level,
    stop 0.5 ATR beyond, target the prior-day POC (Rocket-Scooter-style 'trade from levels')."""
    n = len(d); side, lim, stp, tgt = empty(n)
    h, l, a = d.High.values, d.Low.values, d.atr.values; m = d.mins.values; key = d.key.values; poc = d.ppoc.values; done = set()
    for i in range(1, n):
        if not ((570 if tf == "5m" else 540) <= m[i] < 900): continue
        for hi_n, lo_n in (("on_h", "on_l"), ("pdh", "pdl")):
            H, Lo = d[hi_n].values[i], d[lo_n].values[i]
            if not np.isfinite(H): continue
            if (key[i], hi_n, -1) not in done and h[i] < H and H - h[i] < 0.5 * a[i]:
                side[i] = -1; lim[i] = H; stp[i] = H + 0.5 * a[i]; tgt[i] = poc[i]; done.add((key[i], hi_n, -1)); break
            if (key[i], hi_n, 1) not in done and l[i] > Lo and l[i] - Lo < 0.5 * a[i]:
                side[i] = 1; lim[i] = Lo; stp[i] = Lo - 0.5 * a[i]; tgt[i] = poc[i]; done.add((key[i], hi_n, 1)); break
    return side, lim, stp, tgt

def all_setups(d, tf, tick):
    S = {
        "ICT sweep+MSS, FVG 50% (CE) entry": sweep_mss(d, tf, entry="fvg_ce", tick=tick),
        "ICT sweep+MSS, FVG edge entry": sweep_mss(d, tf, entry="fvg_edge", tick=tick),
        "ICT sweep+MSS, OTE 70.5% entry": sweep_mss(d, tf, entry="ote", tick=tick),
        "ICT sweep+MSS, market entry": sweep_mss(d, tf, entry="market", tick=tick),
        "ICT sweep+MSS any time, CE entry": sweep_mss(d, tf, entry="fvg_ce", kz=False, tick=tick),
        "ICT Asian-range sweep (London)": asia_sweep(d, tf, tick),
        "ICT turtle soup PDH/PDL": turtle_soup(d, tf, tick),
        "ICT FVG trend + premium/discount": fvg_trend(d, tf, True, tick),
        "ICT FVG trend (no P/D filter)": fvg_trend(d, tf, False, tick),
        "Levels: 80% value-area rule": eighty_rule(d, tf, tick),
        "Levels: PDH/ONH break & retest": level_break_retest(d, tf, tick),
        "Levels: ON/PD high-low fade to POC": level_fade(d, tf, tick),
    }
    if tf == "5m":
        S["ICT Silver Bullet 10-11am"] = silver_bullet(d, tf, 600, 660, tick)
        S["ICT Silver Bullet 3-4am (London)"] = silver_bullet(d, tf, 180, 240, tick, "asia_h", "asia_l", 0)
        S["ICT Silver Bullet 2-3pm (PM)"] = silver_bullet(d, tf, 840, 900, tick)
        S["ICT Judas swing NY open"] = judas_swing(d, tf, tick)
    return S
