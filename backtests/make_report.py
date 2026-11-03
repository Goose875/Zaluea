import pandas as pd, numpy as np
d = pd.read_csv("results/daily_results.csv"); i = pd.read_csv("results/intraday_results.csv")
def pct(x): return "" if pd.isna(x) else f"{x*100:.1f}%"
def num(x, n=2): return "" if pd.isna(x) else f"{x:.{n}f}"
def usd(x): return "" if pd.isna(x) else f"${x:,.0f}"
out = []
for sym in ["NQ", "ES", "GC"]:
    f = d[(d.symbol == sym)]
    full = f[f.period == "Full 2010-2026"].set_index("strategy")
    t = pd.DataFrame({
        "CAGR": full.cagr.map(pct), "Sharpe": full.sharpe.map(num), "Max DD": full.max_dd.map(pct),
        "Sharpe 10-19": f[f.period == "2010-2019"].set_index("strategy").sharpe.map(num),
        "Sharpe 20-26": f[f.period == "2020-2026"].set_index("strategy").sharpe.map(num),
        "Last 12m": f[f.period == "Last 12m"].set_index("strategy").total_ret.map(pct),
        "Z26 period $/lot": f[f.period.str.startswith("Z26")].set_index("strategy").usd_pnl_1lot.map(usd),
        "Trades": full.trades.map(lambda x: f"{x:.0f}"), "Win %": full.win_rate.map(pct),
        "PF": full.profit_factor.map(num), "_s": full.sharpe})
    t = t.sort_values("_s", ascending=False).drop(columns="_s")
    out.append((f"daily_{sym}", t.to_markdown()))
for (st, sym), f in i.groupby(["set", "symbol"], sort=False):
    t = f.set_index("strategy")
    t = pd.DataFrame({"P&L $/1 lot": t.usd_pnl_1lot.map(usd), "Max DD $": t.max_dd_usd.map(usd), "Sharpe": t.sharpe.map(num),
                      "Trades": t.trades.map(lambda x: f"{x:.0f}"), "Win %": t.win_rate.map(pct), "PF": t.profit_factor.map(num),
                      "Avg trade $": t.avg_trade.map(usd), "_s": t.usd_pnl_1lot}).sort_values("_s", ascending=False).drop(columns="_s")
    out.append((f"{st}|{sym}|{f.days.iloc[0]}", t.to_markdown()))
import pickle; pickle.dump(out, open("results/_tables.pkl", "wb"))
for k, v in out: print("\n###", k); print(v)
