"""What happens to a $100 live XAUUSD (spot gold CFD) account? Hourly gold data Jun 2024 - Nov 2026 (COMEX futures as a proxy
for spot: same intraday moves). Broker model: 0.01 lot = 1 oz, so $1 move = $1 per 0.01 lot; spread + slippage $0.40 per oz
round trip (stops get another $0.10); leverage 1:500 (margin ~$8 per 0.01 lot); all trades closed by 17:00 ET (no swap).
An account is "busted" when it can no longer cover one more minimum-size stop (equity below the trade's $ risk at 0.01 lot)
or equity <= $10. "Doubled" = equity reaches $200. Every account start date from Jun 2024 to Aug 2026 is simulated."""
import numpy as np, pandas as pd, warnings
warnings.filterwarnings("ignore")
from common import ema, atr

d = pd.read_csv("data/GC_cont_1h.csv", index_col=0); d.index = pd.to_datetime(d.index, utc=True).tz_convert("America/New_York")
d = d[~d.index.duplicated()].sort_index(); d["hr"] = d.index.hour; d["day"] = (d.index + pd.Timedelta(hours=6)).date
d["atr"] = atr(d, 14); d["e20"] = ema(d.Close, 20); d["e50"] = ema(d.Close, 50)
D = d.groupby("day").agg(h=("High", "max"), l=("Low", "min"), o=("Open", "first"), c=("Close", "last")); D["datr"] = (D.h - D.l).rolling(14).mean()
for k in ("h", "l"): d["p" + k] = d["day"].map(D[k].shift())
d["pdatr"] = d["day"].map(D.datr.shift())
asia = d[(d.hr >= 18) | (d.hr < 3)].groupby("day").agg(ah=("High", "max"), al=("Low", "min")); d["ah"] = d["day"].map(asia.ah); d["al"] = d["day"].map(asia.al)
SPREAD, SLIP = 0.40, 0.10
o, h, l, c, hr, a = (d[x].values for x in ("Open", "High", "Low", "Close", "hr", "atr")); day = pd.factorize(d["day"])[0]; N = len(d)

def signals(name, rng=None):
    """List of (bar index the order is live, side, type 0 market / 2 stop, price, stop $ distance, target R). One trade per day max."""
    S = []
    for i in range(60, N - 1):
        if name == "Prior-day high/low breakout" and hr[i] == 3:
            S += [(i, 1, 2, d.ph.iat[i], a[i], 2), (i, -1, 2, d.pl.iat[i], a[i], 2)]
        elif name == "London breakout of Asia range" and hr[i] == 3:
            S += [(i, 1, 2, d.ah.iat[i], a[i], 2), (i, -1, 2, d.al.iat[i], a[i], 2)]
        elif name == "1h EMA20/50 trend pullback" and 3 <= hr[i] <= 14:
            if d.e20.iat[i] > d.e50.iat[i] and l[i] <= d.e20.iat[i] < c[i]: S.append((i + 1, 1, 0, 0, a[i], 2))
            if d.e20.iat[i] < d.e50.iat[i] and h[i] >= d.e20.iat[i] > c[i]: S.append((i + 1, -1, 0, 0, a[i], 2))
        elif name == "NY open momentum (10:00, direction of 9:00 bar)" and hr[i] == 9:
            S.append((i + 1, 1 if c[i] > o[i] else -1, 0, 0, a[i], 2))
        elif name == "Fractal breakout, day trade (best flat-daily GC)" and hr[i] == 18:
            pass
        elif name == "Buy every day at 10:00 (gold-bull baseline)" and hr[i] == 9:
            S.append((i + 1, 1, 0, 0, a[i], 2))
        elif name == "RANDOM side, random hour (luck control)" and 3 <= hr[i] <= 14 and rng.random() < 1 / 12:
            S.append((i + 1, 1 if rng.random() < 0.5 else -1, 0, 0, a[i], 2))
    return S

def trades(S):
    """Fill on hourly bars: market = next open + half spread; stop entry = level (or open if gapped) + half spread;
    stop and target both inside one bar -> stop first; on the entry bar only the stop counts; close at 17:00 ET. P/L per 1 oz."""
    out, busy, done_day = [], -1, -1
    for i, side, typ, px, sd, k in sorted(S, key=lambda x: x[0]):
        if i <= busy or i >= N or day[i] == done_day or not sd > 0: continue
        fb = -1
        for j in range(i, N):
            if day[j] != day[i] or hr[j] == 16: break
            if typ == 0: e = o[j]; fb = j; break
            if side == 1 and h[j] >= px: e = max(px, o[j]); fb = j; break
            if side == -1 and l[j] <= px: e = min(px, o[j]); fb = j; break
        if fb < 0: continue
        stp, tgt = e - side * sd, e + side * k * sd; ex = None
        for j in range(fb, N):
            if day[j] != day[fb] or hr[j] == 17: ex = c[j - 1]; break
            if (side == 1 and l[j] <= stp) or (side == -1 and h[j] >= stp): ex = (stp if j == fb else (min(stp, o[j]) if side == 1 else max(stp, o[j]))) - side * SLIP; break
            if j > fb and ((side == 1 and h[j] >= tgt) or (side == -1 and l[j] <= tgt)): ex = tgt; break
        if ex is None: break
        out.append((fb, j, side, side * (ex - e) - SPREAD, sd)); busy, done_day = j, day[fb]
    return pd.DataFrame(out, columns=["fb", "eb", "side", "pnl_oz", "risk_oz"])

def accounts(t, sizing):
    """Run a $100 account from every start date. sizing: '0.01 lot fixed' or x = 0.0x lot per $100 of equity (compounding)."""
    dd = pd.to_datetime(pd.Series(d["day"].values)); starts = np.unique(day[(d.index >= "2024-07-01") & (d.index < "2026-08-01")])
    tday, pnl, risk, eb = day[t.fb.values.astype(int)], t.pnl_oz.values, t.risk_oz.values, t.eb.values.astype(int); first = {s: np.argmax(day == s) for s in starts}; res = []
    for s in starts:
        eq, out, last = 100.0, None, None
        for k in np.where(tday >= s)[0]:
            lots = 1 if sizing == "0.01 lot fixed" else max(1, int(eq / 100 * sizing))
            if eq - risk[k] <= 0 or eq <= 10: out = "busted"; last = k; break
            eq += lots * pnl[k]; last = k
            if eq >= 200: out = "doubled"; break
            if eq <= 10: out = "busted"; break
        days = (dd[eb[last]] - dd[first[s]]).days if out else np.nan
        res.append((out or "neither (ran out of data)", days, eq))
    return pd.DataFrame(res, columns=["outcome", "days", "end_eq"])

NAMES = ["Prior-day high/low breakout", "London breakout of Asia range", "1h EMA20/50 trend pullback", "NY open momentum (10:00, direction of 9:00 bar)",
         "Buy every day at 10:00 (gold-bull baseline)", "RANDOM side, random hour (luck control)"]
rows = []
for nm in NAMES:
    t = trades(signals(nm, np.random.default_rng(1)))
    for sz in ("0.01 lot fixed", 2, 5):
        A = accounts(t, sz); dbl, bst = A[A.outcome == "doubled"], A[A.outcome == "busted"]
        rows.append(dict(strategy=nm, sizing=sz if isinstance(sz, str) else f"0.0{sz} lot per $100 (compounding)", trades=len(t), win=(t.pnl_oz > 0).mean(),
                         avg_pnl_per_oz=t.pnl_oz.mean(), avg_risk_per_oz=t.risk_oz.mean(), avgR=(t.pnl_oz / t.risk_oz).mean(),
                         pct_doubled=len(dbl) / len(A), median_days_to_double=dbl.days.median(), pct_busted=len(bst) / len(A), median_days_to_bust=bst.days.median(),
                         longs_avg=t[t.side > 0].pnl_oz.mean(), shorts_avg=t[t.side < 0].pnl_oz.mean()))
R = pd.DataFrame(rows); R.to_csv("results/xau100.csv", index=False)
pd.set_option("display.width", 300); pd.set_option("display.max_colwidth", 50); print(R.round(2).to_string(index=False))
