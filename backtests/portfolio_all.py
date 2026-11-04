"""Every profitable NQ / GC strategy so far, run together on one 50K static evaluation account.
Rules: $4,000 target, $2,000 static drawdown, soft $1,000 daily loss limit (no new trades once the day's closed P/L is <= -$1,000),
55% consistency (best day <= 55% of total profit at the time of passing), flat daily.
Strategies (all Topstep-compatible, flat by ~16:00 ET):
  K1, K3, K4 (NQ) and K5, K6, K7 (GC)   Keel's own engine, flat-by 16 (scripts/parity.js; K2 excluded: breakeven when flat daily)
  GC PO3 15m FVG midpoint / GC PO3 15m rejection block / NQ PO3 15m FVG midpoint   (5-minute data: last 10 weeks only)
  GC PO3 1h rejection block (B2)                    (stand-in for PO3 over 2.4 years)
  GC Fractal breakout, flat-daily version           (daily bars)
Sizing in micros (MNQ $2/pt, MGC $10/pt, $0.75/side): contracts = floor(risk / (stop pts x $/pt)), at least 1.
Netting: one position per market at a time (a trade is skipped if that market already has an open trade), like Keel.
Windows: (1) last 10 weeks with everything, (2) Jun 2024 - Nov 2026 without the 15-minute PO3 ones. A new account starts every trading day.
    python3 portfolio_all.py   (needs ../keel-app built: npx tsc -p . && node scripts/copy.js)"""
import os, subprocess, numpy as np, pandas as pd, warnings
warnings.filterwarnings("ignore")
from common import SPECS
from precise import load_1m, simulate
import po3, mega, mt5nt
from mt5nt import cross_up
NY = "America/New_York"; MM = {"NQ": 2.0, "GC": 10.0}; HERE = os.path.dirname(os.path.abspath(__file__))
SCR = os.environ.get("SCRATCH", "/tmp")

def k_trades():
    out = os.path.join(SCR, "k_flat16.csv")
    subprocess.run(["node", "scripts/parity.js", os.path.join(HERE, "data/NQ_cont_1h.csv"), os.path.join(HERE, "data/GC_cont_1h.csv"), out],
                   cwd=os.path.join(HERE, "..", "keel-app"), env={**os.environ, "FLAT_BY": "16"}, check=True, capture_output=True)
    k = pd.read_csv(out); k = k[k.id != "K2"]
    k["sym"] = np.where(k.id.isin(["K1", "K2", "K3", "K4"]), "NQ", "GC")
    k["entry_t"] = pd.to_datetime(k.entry_utc, unit="ms", utc=True).dt.tz_convert(NY); k["exit_t"] = pd.to_datetime(k.exit_utc, unit="ms", utc=True).dt.tz_convert(NY)
    return pd.DataFrame(dict(strategy=k.id, sym=k.sym, entry_t=k.entry_t, exit_t=k.exit_t, pts=k.points, stop_pts=k.risk_pts))

def po3_trades(sym, tf, model, bias, edge, tgt, hold, label):
    d, _ = load_1m(sym, tf); d = d.copy(); d["i"] = np.arange(len(d)); d["t"] = d.index; d, C, T = po3.build(d, "15min" if tf != "1h" else "60min")
    od = po3.orders_for(d, C, T, model, bias, edge, SPECS[sym]["tick"])
    if tf == "1h":
        cap = d["day"].map(d[d["mod"] == 900].groupby("day").i.last()); c_ = cap.values[od.i.clip(upper=len(d) - 1).values]
        od["end"] = np.where(np.isnan(c_), od.end, np.minimum(od.end, np.nan_to_num(c_, nan=1e18))).astype(np.int64)
    if hold == "16:09 flat": od["end"] = -1
    tg = {"none": 0 * od.stop, "3R": 3 * od.stop}[tgt].values
    t = simulate(d, sym, od, od.stop.values, tg, 0.0, 99); M = SPECS[sym]["mult"]
    return pd.DataFrame(dict(strategy=label, sym=sym, entry_t=d.index[t.fb.astype(int)], exit_t=d.index[t.eb.astype(int)] + (d.index[1] - d.index[0]),
                             pts=t.side * (t.exit - t.fill), stop_pts=((t.pnl / t.R) / M).values))

def fractal_trades():
    d = mt5nt.daily_frame("GC"); c, h, l = d.Close, d.High, d.Low; n = 2
    fu = pd.Series(True, index=d.index); fd = pd.Series(True, index=d.index)
    for j in range(1, n + 1): fu &= (h.shift(n) > h.shift(n + j)) & (h.shift(n) > h.shift(n - j)); fd &= (l.shift(n) < l.shift(n + j)) & (l.shift(n) < l.shift(n - j))
    lu = h.shift(n).where(fu).ffill(); ld = l.shift(n).where(fd).ffill()
    F = {f[0]: (f[1], f[2]) for f in mega.filters(d, "GC") if f[0][3] == "any"}; lm, sm = F[("with", "with", "low", "any")]
    L = np.nan_to_num(cross_up(c, lu).values.astype(float)).astype(bool) & lm; S = np.nan_to_num(cross_up(ld, c).values.astype(float)).astype(bool) & sm
    o, hh, ll, cc, a = (d[x].values.astype(float) for x in ("Open", "High", "Low", "Close", "atr")); T = SPECS["GC"]["tick"]; rows = []
    for i in np.where(L | S)[0]:
        j = i + 1
        if j >= len(o) or not a[i] > 0: continue
        side = 1 if L[i] else -1; e = o[j] + side * T; risk = max(0.5 * a[i], 4 * T); stp = e - side * risk; tgt = e + side * 3 * risk
        if (ll[j] <= stp) if side == 1 else (hh[j] >= stp): ex = (min(stp, o[j]) if side == 1 else max(stp, o[j])) - side * T
        elif (hh[j] >= tgt + T) if side == 1 else (ll[j] <= tgt - T): ex = tgt
        else: ex = cc[j] - side * T
        day = pd.Timestamp(d.index[j]).tz_localize(None) if pd.Timestamp(d.index[j]).tz is None else pd.Timestamp(d.index[j]).tz_convert(None)
        day = pd.Timestamp(day.date())
        rows.append(dict(strategy="GC Fractal (flat daily)", sym="GC", entry_t=(day - pd.Timedelta(hours=6)).tz_localize(NY), exit_t=(day + pd.Timedelta(hours=16)).tz_localize(NY),
                         pts=side * (ex - e), stop_pts=risk))
    return pd.DataFrame(rows)

def size(t, risk):
    mm = t.sym.map(MM); n = np.maximum(1, np.floor(risk / (t.stop_pts * mm))); return n * (t.pts * mm - 1.5), n

def run_account(t, risk, start, target=4000.0, dd=2000.0, dll=1000.0, cons=0.55):
    """Trades in entry order; skip if that market is busy or the day's closed P/L <= -DLL. P/L counted on the exit's trading day."""
    t = t[t.entry_t >= start].sort_values("entry_t"); busy = {"NQ": None, "GC": None}; taken = []
    closed = {}                                                       # trading day -> closed P/L so far (by exit time)
    tday = lambda x: (x + pd.Timedelta(hours=6)).date()
    for r in t.itertuples():
        if busy[r.sym] is not None and r.entry_t < busy[r.sym]: continue
        dday = tday(r.entry_t); day_closed = sum(p for (ex, p) in taken if tday(ex) == dday and ex <= r.entry_t)
        if day_closed <= -dll: continue
        taken.append((r.exit_t, r.usd)); busy[r.sym] = r.exit_t
    if not taken: return "not finished", 0, 0
    P = pd.DataFrame(taken, columns=["exit_t", "usd"]); P["day"] = P.exit_t.apply(tday); daily = P.groupby("day").usd.sum().sort_index()
    all_days = sorted(set(pd.Series(t.entry_t.apply(tday)).tolist() + daily.index.tolist())); bal = best = 0.0; nd = 0
    for dday in all_days:
        nd += 1; v = daily.get(dday, 0.0); bal += v; best = max(best, v)
        if bal <= -dd: return "fail", nd, len(P)
        if bal >= target and best <= cons * bal: return "pass", nd, len(P)
    return "not finished", nd, len(P)

def study(T, label, risks=(150, 250, 500)):
    rows = []; days = sorted(T.entry_t.apply(lambda x: (x + pd.Timedelta(hours=6)).date()).unique())
    for risk in risks:
        T = T.assign(usd=size(T, risk)[0]); res = [run_account(T, risk, pd.Timestamp(str(s)).tz_localize(NY) - pd.Timedelta(hours=6)) for s in days[:-5]]
        o = pd.DataFrame(res, columns=["res", "days", "trades"]); fin = o[o.res != "not finished"]
        rows.append(dict(window=label, risk=risk, starts=len(o), finished=len(fin), pass_pct=(fin.res == "pass").mean(), fail_pct=(fin.res == "fail").mean(),
                         median_days_to_pass=o[o.res == "pass"].days.median(), fastest=o[o.res == "pass"].days.min(), pass_within_30d_of_all=((o.res == "pass") & (o.days <= 30)).mean()))
    return rows

if __name__ == "__main__":
    K = k_trades(); FR = fractal_trades(); B2 = po3_trades("GC", "1h", "RB", "4h EMA20", "below open", "none", "candle close", "GC PO3 1h RB (B2)")
    P15 = pd.concat([po3_trades("GC", "5m", "FVG CE", "none", "below open", "none", "candle close", "GC PO3 15m FVG"),
                     po3_trades("GC", "5m", "RB", "vs 18:00 open", "below open", "3R", "candle close", "GC PO3 15m RB"),
                     po3_trades("NQ", "5m", "FVG CE", "none", "below open", "none", "candle close", "NQ PO3 15m FVG")])
    w10 = P15.entry_t.min()
    ALL10 = pd.concat([K[K.entry_t >= w10], FR[FR.entry_t >= w10], P15]); ALL24 = pd.concat([K, FR[FR.entry_t >= K.entry_t.min()], B2])
    # per-strategy contribution in each window ($250 risk)
    for nm, T in (("last 10 weeks", ALL10), ("Jun 2024 - Nov 2026", ALL24)):
        u, n = size(T, 250); x = T.assign(usd=u).groupby("strategy").agg(trades=("usd", "size"), usd=("usd", "sum"), win=("usd", lambda s: (s > 0).mean()))
        print(f"\n{nm} - each strategy alone at $250 risk (before netting / DLL):"); print(x.round(2).to_string())
    R = pd.DataFrame(study(ALL10, "last 10 weeks (all strategies)") + study(ALL24, "Jun 2024 - Nov 2026 (no 15m PO3)") + study(K, "K1/K3-K7 only, Jun 2024 - Nov 2026"))
    R.to_csv("results/portfolio_all_eval50.csv", index=False); pd.set_option("display.width", 250); print(); print(R.round(2).to_string(index=False))
