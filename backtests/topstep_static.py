"""Topstep 50K Static: which mix of our profitable NQ / GC strategies passes fastest and most often, and how long until payouts.

Combine (from Topstep's 50K Static rules): $4,000 target, $2,000 STATIC max loss (floor $48,000), $1,000 daily loss limit that
  flattens you for the day, 55% consistency (best day <= 55% of total profit when passing), max 40 micros (MGC <= 25).
Express Funded Account after passing: balance starts at $0, max loss -$2,000 static until the first payout, then $0 for good;
  same $1,000 daily loss limit. Standard payout path: 5 winning days of >= $150 since the last payout, then request
  50% of the balance (capped; cap $2,000 per Topstep's general payout page, a review says $8,000 for Static - both shown), 90% split,
  balance reduced by the payout. We measure trading days to the 1st and 2nd payout and the cash received in the first 60 trading days.
Strategies: K1, K3, K4 (NQ); K5, K6, K7 (GC); GC Fractal flat-daily; GC PO3 1h rejection block (B2)  - Jun 2024 to Nov 2026.
  The 15-minute PO3 strategies only have 10 weeks of data and are reported separately.
Netting: one position per market at a time (first signal wins). Sizing in micros: floor(risk / (stop x $/pt)), at least 1.
Every combination of strategies x risk per trade is tested; a new Combine starts on every trading day.
    SCRATCH=<dir> python3 topstep_static.py -> results/topstep_static_*.csv"""
import itertools, numpy as np, pandas as pd, warnings, sys
warnings.filterwarnings("ignore")
from portfolio_all import k_trades, fractal_trades, po3_trades, MM, NY

tday = lambda x: (x + pd.Timedelta(hours=6)).date()

def daily_series(T, risk, days):
    """Closed P/L per trading day for a set of trades, with netting, micro caps and the hard $1,000 daily loss limit."""
    T = T.sort_values("entry_t"); busy = {"NQ": None, "GC": None}; out = {}; open_ex = []
    mm = T.sym.map(MM).values; n = np.maximum(1, np.floor(risk / (T.stop_pts.values * mm))); n = np.minimum(n, np.where(T.sym.values == "GC", 25, 40))
    usd = n * (T.pts.values * mm - 1.5)
    for k, r in enumerate(T.itertuples()):
        if busy[r.sym] is not None and r.entry_t < busy[r.sym]: continue
        dd_ = tday(r.entry_t); cur = out.get(dd_, 0.0)
        if cur <= -1000: continue
        busy[r.sym] = r.exit_t; xd = tday(r.exit_t); out[xd] = max(out.get(xd, 0.0) + usd[k], -1000.0)
    return np.array([out.get(x, 0.0) for x in days])

def combine(pnl, s):
    bal = best = 0.0
    for j in range(s, len(pnl)):
        v = pnl[j]; bal += v; best = max(best, v)
        if bal <= -2000: return "fail", j
        if bal >= 4000 and best <= 0.55 * bal: return "pass", j
    return "open", len(pnl)

def xfa(pnl, s, cap, horizon=60):
    """From day s: returns (days to 1st payout or None, days to 2nd payout or None, cash received within horizon days (after split), blown?)."""
    bal, floor, wins, paid, got, first, second = 0.0, -2000.0, 0, 0, 0.0, None, None
    for j in range(s, min(len(pnl), s + horizon)):
        v = pnl[j]; bal += v; wins += v >= 150
        if bal <= floor: return first, second, got, True
        if wins >= 5 and bal > 0:
            amt = min(0.5 * bal, cap)
            if amt >= 125:
                bal -= amt; got += 0.9 * amt; paid += 1; wins = 0; floor = 0.0
                if paid == 1: first = j - s + 1
                elif paid == 2: second = j - s + 1
    return first, second, got, False

def evaluate(pnl, cap):
    starts = range(0, len(pnl) - 20); rows = []
    for s in starts:
        res, j = combine(pnl, s)
        if res == "open": continue
        r = dict(res=res, days=j - s + 1)
        if res == "pass" and j + 61 <= len(pnl):
            f, sc, got, blown = xfa(pnl, j + 1, cap); r.update(first=f, second=sc, cash60=got, blown=blown)
        rows.append(r)
    o = pd.DataFrame(rows)
    if not len(o): return {}
    p = o[o.res == "pass"]; x = p.dropna(subset=["cash60"]) if "cash60" in p else p.iloc[0:0]
    return dict(finished=len(o), pass_pct=len(p) / len(o), median_days_to_pass=p.days.median() if len(p) else np.nan,
                pass_within_20d=((o.res == "pass") & (o.days <= 20)).mean(),
                xfa_first_payout_pct=x["first"].notna().mean() if len(x) else np.nan,
                median_days_pass_to_1st_payout=x["first"].median() if len(x) else np.nan,
                xfa_blown_before_payout_pct=(x.blown & x["first"].isna()).mean() if len(x) else np.nan,
                median_cash_first60d=x.cash60.median() if len(x) else np.nan)

if __name__ == "__main__":
    K = k_trades(); FR = fractal_trades(); B2 = po3_trades("GC", "1h", "RB", "4h EMA20", "below open", "none", "candle close", "GC PO3 1h RB")
    ALL = pd.concat([K, FR[FR.entry_t >= K.entry_t.min()], B2]); names = sorted(ALL.strategy.unique())
    days = sorted({tday(x) for x in pd.concat([ALL.entry_t, ALL.exit_t])})
    rows = []
    for k in range(1, len(names) + 1):
        for combo in itertools.combinations(names, k):
            T = ALL[ALL.strategy.isin(combo)]
            for risk in (150, 250, 350, 500):
                pnl = daily_series(T, risk, days)
                for cap in (2000, 8000):
                    e = evaluate(pnl, cap)
                    if e: rows.append(dict(strategies=" + ".join(combo), n_strats=k, risk=risk, payout_cap=cap, trades_per_week=len(T) / (len(days) / 5), **e))
        print(f"{k}-strategy combos done", file=sys.stderr, flush=True)
    R = pd.DataFrame(rows); R.to_csv("results/topstep_static_combos.csv", index=False)
    R["score"] = R.pass_pct * R.xfa_first_payout_pct          # chance of reaching a first payout from a fresh Combine
    pd.set_option("display.width", 320); pd.set_option("display.max_colwidth", 70)
    cols = ["strategies", "risk", "pass_pct", "median_days_to_pass", "pass_within_20d", "xfa_first_payout_pct", "median_days_pass_to_1st_payout", "xfa_blown_before_payout_pct", "median_cash_first60d", "score"]
    for cap in (2000, 8000):
        S = R[R.payout_cap == cap]
        print(f"\n=== payout cap ${cap:,}: most likely to reach a payout ==="); print(S.sort_values(["score", "median_days_to_pass"], ascending=[False, True]).head(12)[cols].round(2).to_string(index=False))
        print(f"\n=== payout cap ${cap:,}: fastest pass among combos passing >= 80% ==="); print(S[S.pass_pct >= 0.8].sort_values("median_days_to_pass").head(8)[cols].round(2).to_string(index=False))
    R[R.payout_cap == 2000].sort_values("score", ascending=False).head(40).to_csv("results/topstep_static_best.csv", index=False)
