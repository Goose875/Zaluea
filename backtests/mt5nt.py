"""MT5 (MQL5 Wizard signal modules + sample EAs) and NinjaTrader 8 sample strategies, ported to the search engine.

Rules follow the official MQL5 docs ("market models" of each CSignal* module, analysed on the last formed bar) and the
NinjaTrader 8 built-in samples. Divergences use 2-left/2-right pivots of the oscillator, confirmed 2 bars later
(no look-ahead): bullish = oscillator pivot low higher than the previous one while price's low at those bars is lower.

Two runs:
  1h   : NQ/ES/GC continuous, Jun 2024 - Nov 2026, flat at session end (mega_engine, 144 management variants)
  daily: NQ/ES/GC continuous, 2005 - Nov 2026, swing holds with time stops (mega_engine2 hold=1, 432 variants)
Splits: 1h TRAIN<=2025-03-31, VALID<=2025-11-30, TEST to 2026-11-02 ; daily TRAIN<=2014-12-31, VALID<=2019-12-31, TEST 2020-2026.
Random-entry controls are included so we can see what luck produces."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd, itertools, sys, time, warnings
warnings.filterwarnings("ignore")
from common import SPECS, load, ema, sma, rsi, atr
import mega
from mega_engine import run_block
from mega_engine2 import run_block2
from rmultiple import prep_1h, finish

# ---------------- indicators ----------------
def kama(c, n=10, fast=2, slow=30):
    c = c.values; out = np.full(len(c), np.nan); fsc, ssc = 2 / (fast + 1), 2 / (slow + 1)
    for i in range(n, len(c)):
        er = abs(c[i] - c[i - n]) / max(np.sum(np.abs(np.diff(c[i - n:i + 1]))), 1e-12)
        sc = (er * (fsc - ssc) + ssc) ** 2
        out[i] = c[i] if np.isnan(out[i - 1]) else out[i - 1] + sc * (c[i] - out[i - 1])
    return out
def frama(d, n=14):
    h, l, c = d.High.values, d.Low.values, d.Close.values; out = np.full(len(c), np.nan); half = n // 2
    for i in range(n, len(c)):
        n1 = (h[i-n+1:i-half+1].max() - l[i-n+1:i-half+1].min()) / half; n2 = (h[i-half+1:i+1].max() - l[i-half+1:i+1].min()) / half
        n3 = (h[i-n+1:i+1].max() - l[i-n+1:i+1].min()) / n
        D = (np.log(n1 + n2) - np.log(n3)) / np.log(2) if n1 > 0 and n2 > 0 and n3 > 0 else 1.0
        a = min(max(np.exp(-4.6 * (D - 1)), 0.01), 1.0)
        out[i] = c[i] if np.isnan(out[i - 1]) else a * c[i] + (1 - a) * out[i - 1]
    return out
def stoch(d, k=14, s=3, ds=3):
    ll, hh = d.Low.rolling(k).min(), d.High.rolling(k).max()
    K = (100 * (d.Close - ll) / (hh - ll).replace(0, np.nan)).rolling(s).mean(); return K, K.rolling(ds).mean()
def cci(d, n=14):
    tp = (d.High + d.Low + d.Close) / 3; m = tp.rolling(n).mean(); md = tp.rolling(n).apply(lambda x: np.abs(x - x.mean()).mean(), raw=True)
    return (tp - m) / (0.015 * md)
def wpr(d, n=14): return -100 * (d.High.rolling(n).max() - d.Close) / (d.High.rolling(n).max() - d.Low.rolling(n).min()).replace(0, np.nan)
def demarker(d, n=14):
    up = (d.High - d.High.shift()).clip(lower=0); dn = (d.Low.shift() - d.Low).clip(lower=0)
    return up.rolling(n).mean() / (up.rolling(n).mean() + dn.rolling(n).mean()).replace(0, np.nan)
def ao(d): mp = (d.High + d.Low) / 2; return sma(mp, 5) - sma(mp, 34)
def rvi(d, n=10):
    num = ((d.Close - d.Open) + 2 * (d.Close.shift() - d.Open.shift()) + 2 * (d.Close.shift(2) - d.Open.shift(2)) + (d.Close.shift(3) - d.Open.shift(3))) / 6
    den = ((d.High - d.Low) + 2 * (d.High.shift() - d.Low.shift()) + 2 * (d.High.shift(2) - d.Low.shift(2)) + (d.High.shift(3) - d.Low.shift(3))) / 6
    r = num.rolling(n).mean() / den.rolling(n).mean().replace(0, np.nan); sig = (r + 2 * r.shift() + 2 * r.shift(2) + r.shift(3)) / 6; return r, sig
def trix(c, n=14): e3 = ema(ema(ema(c, n), n), n); return 100 * e3.pct_change()
def psar_series(d, step=0.02, mx=0.2):
    h, l = d.High.values, d.Low.values; n = len(h); out = np.full(n, np.nan); up = True; sar = l[0]; ep = h[0]; af = step
    for i in range(1, n):
        sar = sar + af * (ep - sar)
        if up:
            sar = min(sar, l[i-1], l[i-2] if i > 1 else l[i-1])
            if l[i] < sar: up, sar, ep, af = False, ep, l[i], step
            elif h[i] > ep: ep, af = h[i], min(af + step, mx)
        else:
            sar = max(sar, h[i-1], h[i-2] if i > 1 else h[i-1])
            if h[i] > sar: up, sar, ep, af = True, ep, h[i], step
            elif l[i] < ep: ep, af = l[i], min(af + step, mx)
        out[i] = sar
    return out

# ---------------- pattern helpers (MQL5 market models) ----------------
def cross_up(a, b): return (a > b) & (a.shift() <= b.shift())
def turn_up(x): return (x > x.shift()) & (x.shift() < x.shift(2))
def turn_dn(x): return (x < x.shift()) & (x.shift() > x.shift(2))
def divergences(osc, price_lo, price_hi, double=False):
    """Bullish: oscillator pivot low higher than the previous pivot low, price low at those bars lower (3 pivots for double).
    Bearish mirror. Signal on the bar the newest pivot is confirmed (pivot + 2)."""
    o = osc.values; lo = price_lo.values; hi = price_hi.values; n = len(o)
    bull = np.zeros(n, bool); bear = np.zeros(n, bool); lows, highs = [], []
    for i in range(4, n):
        p = i - 2
        if np.isfinite(o[p-2:p+3]).all():
            if o[p] < min(o[p-1], o[p-2]) and o[p] <= min(o[p+1], o[p+2]):
                lows.append(p)
                if double and len(lows) >= 3:
                    a, b, c = lows[-3:]; bull[i] = o[a] < o[b] < o[c] and lo[a] > lo[b] > lo[c]
                elif not double and len(lows) >= 2:
                    a, b = lows[-2:]; bull[i] = o[b] > o[a] and lo[b] < lo[a]
            if o[p] > max(o[p-1], o[p-2]) and o[p] >= max(o[p+1], o[p+2]):
                highs.append(p)
                if double and len(highs) >= 3:
                    a, b, c = highs[-3:]; bear[i] = o[a] > o[b] > o[c] and hi[a] < hi[b] < hi[c]
                elif not double and len(highs) >= 2:
                    a, b = highs[-2:]; bear[i] = o[b] < o[a] and hi[b] > hi[a]
    return pd.Series(bull, index=osc.index), pd.Series(bear, index=osc.index)

def ma_patterns(d, ma, name):
    ma = pd.Series(ma, index=d.index); rising = ma > ma.shift(); falling = ma < ma.shift(); o, c, l, h = d.Open, d.Close, d.Low, d.High
    return {f"MT5 {name}: crossover": ((o < ma) & (c > ma) & rising, (o > ma) & (c < ma) & falling),
            f"MT5 {name}: failed breakout": ((o > ma) & (c < ma) & rising, (o < ma) & (c > ma) & falling),
            f"MT5 {name}: formed breakout": ((l < ma) & (o > ma) & (c > ma) & rising, (h > ma) & (o < ma) & (c < ma) & falling)}

def triggers(d, sym, n_random=20):
    c, o, h, l = d.Close, d.Open, d.High, d.Low
    T = {}
    # MA family (MQL5 CSignalMA, CSignalAMA, CSignalDEMA, CSignalTEMA, CSignalFrAMA); MT5 "Moving Average" EA default period 12
    for name, ma in (("SMA(12)", sma(c, 12)), ("EMA(12)", ema(c, 12)), ("AMA(10,2,30)", kama(c)), ("DEMA(12)", 2 * ema(c, 12) - ema(ema(c, 12), 12)),
                     ("TEMA(12)", 3 * ema(c, 12) - 3 * ema(ema(c, 12), 12) + ema(ema(ema(c, 12), 12), 12)), ("FRAMA(14)", frama(d))):
        T.update(ma_patterns(d, ma, name))
    # MACD 12/26/9
    m = ema(c, 12) - ema(c, 26); sg = ema(m, 9)
    T["MT5 MACD: reverse"] = (turn_up(m), turn_dn(m)); T["MT5 MACD: signal cross"] = (cross_up(m, sg), cross_up(sg, m))
    T["MT5 MACD: zero cross"] = (cross_up(m, 0 * m), cross_up(0 * m, m))
    T["MT5 MACD: divergence"] = divergences(m, l, h); T["MT5 MACD: double divergence"] = divergences(m, l, h, True)
    # RSI 14, 30/70
    r = rsi(c, 14)
    T["MT5 RSI: reverse beyond 30/70"] = (turn_up(r) & (r < 30), turn_dn(r) & (r > 70))
    pk = r.rolling(10).max().shift(); tr = r.rolling(10).min().shift()
    T["MT5 RSI: failed swing"] = (cross_up(r, pk) & (tr < 30), cross_up(tr, r) & (pk > 70))
    T["MT5 RSI: divergence"] = divergences(r, l, h); T["MT5 RSI: double divergence"] = divergences(r, l, h, True)
    # Stochastic 14/3/3
    K, D = stoch(d)
    T["MT5 Stochastic: reversal"] = (turn_up(K), turn_dn(K)); T["MT5 Stochastic: main/signal cross"] = (cross_up(K, D), cross_up(D, K))
    T["MT5 Stochastic: divergence"] = divergences(K, l, h)
    # CCI 14 +-100
    x = cci(d); T["MT5 CCI: reverse beyond +-100"] = (turn_up(x) & (x < -100), turn_dn(x) & (x > 100)); T["MT5 CCI: divergence"] = divergences(x, l, h)
    # Williams %R 14, -80/-20
    w = wpr(d); T["MT5 WPR: reverse beyond -80/-20"] = (turn_up(w) & (w < -80), turn_dn(w) & (w > -20)); T["MT5 WPR: divergence"] = divergences(w, l, h)
    # DeMarker 14, 0.3/0.7
    dm = demarker(d); T["MT5 DeMarker: reverse beyond 0.3/0.7"] = (turn_up(dm) & (dm < 0.3), turn_dn(dm) & (dm > 0.7)); T["MT5 DeMarker: divergence"] = divergences(dm, l, h)
    # Parabolic SAR reverse
    s = pd.Series(psar_series(d), index=d.index); T["MT5 Parabolic SAR: reverse"] = ((s < c) & (s.shift() > c.shift()), (s > c) & (s.shift() < c.shift()))
    # Envelopes MA(20) +-0.5 x ATR-as-% (deviation in % of price, chosen to scale with volatility): near line / cross outer line
    mid = sma(c, 20); dev = (atr(d, 14) / c).rolling(50).mean().fillna(0.003); up_, lo_ = mid * (1 + dev), mid * (1 - dev)
    T["MT5 Envelopes: price near line (fade)"] = ((l <= lo_) & (c > lo_), (h >= up_) & (c < up_)); T["MT5 Envelopes: cross outer line"] = (cross_up(c, up_), cross_up(lo_, c))
    # Awesome / Accelerator oscillators
    a = ao(d)
    T["MT5 AO: saucer"] = ((a > a.shift()) & (a.shift() < a.shift(2)) & (a.shift(2) < a.shift(3)) & (a > 0) & (a.shift() > 0),
                           (a < a.shift()) & (a.shift() > a.shift(2)) & (a.shift(2) > a.shift(3)) & (a < 0) & (a.shift() < 0))
    T["MT5 AO: zero cross"] = (cross_up(a, 0 * a), cross_up(0 * a, a)); T["MT5 AO: divergence"] = divergences(a, l, h)
    ac = a - sma(a, 5)
    T["MT5 AC: rising 2 bars (above 0) / 3 bars"] = ((ac > ac.shift()) & (ac.shift() > ac.shift(2)) & (ac.shift(2) < ac.shift(3)) & (ac > 0),
                                                     (ac < ac.shift()) & (ac.shift() < ac.shift(2)) & (ac.shift(2) > ac.shift(3)) & (ac < 0))
    # Bulls / Bears power (EMA 13)
    e13 = ema(c, 13); bears = l - e13; bulls = h - e13
    T["MT5 Bears Power: reversal below 0"] = (turn_up(bears) & (bears < 0), pd.Series(False, index=d.index))
    T["MT5 Bulls Power: reversal above 0"] = (pd.Series(False, index=d.index), turn_dn(bulls) & (bulls > 0))
    T["MT5 Bulls+Bears Power"] = (turn_up(bears) & (bears < 0), turn_dn(bulls) & (bulls > 0))
    # RVI 10 and TRIX 14
    rv, rs = rvi(d); T["MT5 RVI: main/signal cross"] = (cross_up(rv, rs), cross_up(rs, rv))
    tx = trix(c); T["MT5 TRIX: reverse"] = (turn_up(tx), turn_dn(tx)); T["MT5 TRIX: zero cross"] = (cross_up(tx, 0 * tx), cross_up(0 * tx, tx))
    # MT5 sample EA "MACD Sample": MACD below 0 crossing above signal, |MACD| above a threshold, EMA(26) rising (mirror for shorts)
    thr = 0.3 * atr(d, 14); e26 = ema(c, 26)
    T["MT5 EA: MACD Sample"] = (cross_up(m, sg) & (m < 0) & (m.abs() > thr) & (e26 > e26.shift()), cross_up(sg, m) & (m > 0) & (m.abs() > thr) & (e26 < e26.shift()))
    # MT5 sample EA "Moving Average": MA(12) shifted 6 bars, bar opens on one side and closes on the other
    ma6 = sma(c, 12).shift(6); T["MT5 EA: Moving Average (12, shift 6)"] = ((o < ma6) & (c > ma6), (o > ma6) & (c < ma6))
    # NinjaTrader 8 samples
    f, s_ = sma(c, 10), sma(c, 25); T["NT8 SampleMACrossOver (10/25)"] = (cross_up(f, s_), cross_up(s_, f))
    f5, s50 = sma(c, 5), sma(c, 50); htf = c.rolling(4).mean(); htf2 = c.rolling(24).mean()     # higher-timeframe proxies
    T["NT8 SampleMultiTimeFrame (5/50 + HTF agree)"] = (cross_up(f5, s50) & (htf > htf.shift(4)) & (htf2 > htf2.shift(24)), cross_up(s50, f5) & (htf < htf.shift(4)) & (htf2 < htf2.shift(24)))
    rng = np.random.default_rng(abs(hash(sym)) % 2**32)
    for i in range(n_random):
        p = rng.uniform(0.01, 0.05); x = rng.random(len(d)); T[f"RANDOM #{i:02d}"] = (pd.Series(x < p / 2, index=d.index), pd.Series((x >= p / 2) & (x < p), index=d.index))
    return {k: (np.nan_to_num(np.asarray(v[0], float)).astype(bool), np.nan_to_num(np.asarray(v[1], float)).astype(bool)) for k, v in T.items()}

# ---------------- runs ----------------
M1 = np.array([[em, sm, k, be, tr] for em in (0, 1, 2) for sm in (0, 1, 2) for k in (1.0, 2.0, 3.0, 0.0) for be in (0, 1) for tr in (0, 1)], float)
MD = np.array([[em, sm, k, be, tr, tm] for em in (0, 1, 2) for sm in (0, 1, 2) for k in (1.0, 2.0, 3.0, 0.0) for be in (0, 1) for tr in (0, 1) for tm in (5, 10, 20)], float)

def daily_frame(sym):
    d = load(f"{sym}_cont_1d.csv"); d = d[(d.index >= "2005-01-01") & (d.index <= "2026-11-02")].copy()
    d = d[(d.High >= d.Low) & (d.Open > 0)]
    d.index = pd.DatetimeIndex(d.index).tz_localize("America/New_York")
    # One continuous session: daily swing trades enter at the next open and exit by stop, target, trail or time stop.
    d["sess"] = d.index.date; d["sess_id"] = np.zeros(len(d), dtype=np.int64)
    d["atr"] = atr(d, 14); d["ema20"] = ema(d.Close, 20); d["ema50"] = ema(d.Close, 50)
    return d

def run(tf):
    rows_pass, rows_var, total = [], [], 0
    for sym in ("NQ", "ES", "GC"):
        t0 = time.time(); sp = SPECS[sym]
        if tf == "1h":
            d = prep_1h(sym)[0]; split = ("2025-03-31", "2025-11-30"); F = mega.filters(d, sym); M = M1
        else:
            d = daily_frame(sym); split = ("2014-12-31", "2019-12-31"); F = [f for f in mega.filters(d, sym) if f[0][3] == "any"]; M = MD
        cuts = [int((d.index <= pd.Timestamp(x + " 23:59", tz="America/New_York")).sum()) for x in split]
        arrs = (d.Open.values.astype(float), d.High.values.astype(float), d.Low.values.astype(float), d.Close.values.astype(float), d.atr.values.astype(float), d.sess_id.values.astype(np.int64))
        nan = np.full(len(d), np.nan)
        for tname, (L0, S0) in triggers(d, sym).items():
            for dr in ("both", "long", "short"):
                L1 = L0 if dr != "short" else np.zeros_like(L0); S1 = S0 if dr != "long" else np.zeros_like(S0)
                Lm, Sm, meta = [], [], []
                for key, lm, sm_ in F:
                    Lx, Sx = L1 & lm, S1 & sm_
                    if Lx.sum() + Sx.sum() < 40: continue
                    Lm.append(Lx); Sm.append(Sx); meta.append((tname, dr) + key)
                if not Lm: continue
                Lm, Sm = np.array(Lm), np.array(Sm)
                if tf == "1h": res = run_block(*arrs, Lm, Sm, M, cuts[0], cuts[1], sp["tick"], float(sp["mult"]), sp["comm"])
                else: res = run_block2(*arrs, Lm, Sm, nan, nan, nan, M, cuts[0], cuts[1], sp["tick"], float(sp["mult"]), sp["comm"], 1)
                total += res.shape[0] * res.shape[1]
                n = res[..., 0]; avg = np.where(n > 0, res[..., 1] / np.maximum(n, 1), np.nan)
                pf = np.where(res[..., 4] > 0, res[..., 3] / np.maximum(res[..., 4], 1e-9), 99.0)
                n0, n1 = (50, 30) if tf == "1h" else (40, 20)
                elig = (n[..., 0] >= n0) & (n[..., 1] >= n1)
                ok = elig & (avg[..., 0] >= 0.15) & (avg[..., 1] >= 0.15) & (pf[..., 0] >= 1.3) & (pf[..., 1] >= 1.3)
                for v in range(res.shape[0]):
                    e = int(elig[v].sum())
                    if not e: continue
                    p = np.where(ok[v])[0]
                    rows_var.append(meta[v] + (sym, e, len(p), float(np.nanmedian(avg[v, p, 2])) if len(p) else np.nan, float((avg[v, p, 2] > 0).mean()) if len(p) else np.nan,
                                               float(np.nanmedian(avg[v, elig[v], 2])), float(np.nanmedian(avg[v, p, 0])) if len(p) else np.nan, float(np.nanmedian(avg[v, p, 1])) if len(p) else np.nan,
                                               float(np.nanmedian(n[v, p, 2])) if len(p) else np.nan))
                    for g in p: rows_pass.append(meta[v] + (sym, int(g), float(n[v, g, 0]), float(avg[v, g, 0]), float(pf[v, g, 0]), float(n[v, g, 1]), float(avg[v, g, 1]), float(pf[v, g, 1]),
                                                            float(n[v, g, 2]), float(avg[v, g, 2]), float(pf[v, g, 2])))
        print(f"{tf} {sym}: done in {time.time()-t0:.0f}s, strategies so far {total:,}", flush=True)
    cols = ["trigger", "dir", "regime", "trend", "vol", "window", "symbol"]
    pd.DataFrame(rows_var, columns=cols + ["eligible", "passed", "pass_TE_med", "pass_TE_pos", "elig_TE_med", "pass_TR_med", "pass_VA_med", "pass_TE_n"]).to_csv(f"results/mt5nt_{tf}_variants.csv.gz", index=False, compression="gzip")
    pd.DataFrame(rows_pass, columns=cols + ["mgmt", "TR_n", "TR_avg", "TR_pf", "VA_n", "VA_avg", "VA_pf", "TE_n", "TE_avg", "TE_pf"]).to_csv(f"results/mt5nt_{tf}_pass.csv.gz", index=False, compression="gzip")
    open(f"results/mt5nt_{tf}_count.txt", "w").write(str(total))
    print(f"{tf} TOTAL {total:,} strategies")

if __name__ == "__main__":
    for tf in sys.argv[1:] or ["daily", "1h"]: run(tf)
