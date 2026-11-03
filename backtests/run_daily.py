"""Run every daily strategy on NQ / ES / GC continuous front-month futures.
Execution: signal at close t -> filled at OPEN of t+1. Costs: 1 tick slippage + $2.50 commission per side."""
import numpy as np, pandas as pd, sys
from common import SPECS, cost_pts, load, perf, trade_stats, CUTOFF
from daily_strategies import STRATEGIES

PERIODS = {"Full 2010-2026": ("2010-01-01", CUTOFF), "2010-2019": ("2010-01-01", "2019-12-31"),
           "2020-2026": ("2020-01-01", CUTOFF), "Last 12m": ("2025-11-03", CUTOFF),
           "Z26 front (Sep14-Nov2 2026)": ("2026-09-14", CUTOFF)}

def simulate(d, out, sym):
    """Return per-day frame with ret (fraction of notional) and usd (P&L for 1 contract), plus trade list ($)."""
    mult, cp = SPECS[sym]["mult"], cost_pts(sym)
    if isinstance(out, dict) and "custom" in out:
        c = out["custom"].reindex(d.index).fillna({"pts": 0, "side": 0})
        traded = c.side != 0
        pts = c.pts - 2 * cp * traded
        ret = (pts / c.entry).where(traded, 0.0).fillna(0)
        return pd.DataFrame(dict(ret=ret, usd=pts * mult, pos=c.side)), list((pts * mult)[traded])
    if isinstance(out, dict):
        on, day = out["on"].reindex(d.index).fillna(0), out["day"].reindex(d.index).fillna(0)
    else:
        s = out.reindex(d.index).fillna(0)
        on, day = s.shift(2).fillna(0), s.shift(1).fillna(0)
    # interleave segments: ON(t) [C_{t-1}->O_t], DAY(t) [O_t->C_t]
    pc = d.Close.shift()
    seg_pos = np.column_stack([on.values, day.values]).ravel()
    seg_pts = np.column_stack([(d.Open - pc).fillna(0).values, (d.Close - d.Open).values]).ravel()
    seg_px = np.column_stack([d.Open.values, d.Close.values]).ravel()   # price where the change at segment start happens
    seg_start_px = np.column_stack([pc.bfill().values, d.Open.values]).ravel()
    dpos = np.abs(np.diff(np.r_[0, seg_pos]))
    seg_pnl = seg_pos * seg_pts - dpos * cp            # points
    seg_ret = seg_pos * seg_pts / seg_start_px - dpos * cp / seg_start_px
    n = len(d)
    ret = pd.Series(seg_ret.reshape(n, 2).sum(1), index=d.index)
    usd = pd.Series(seg_pnl.reshape(n, 2).sum(1) * mult, index=d.index)
    # trades: runs of constant non-zero position (exit cost charged to the trade)
    trades, cur, acc = [], 0, 0.0
    for p, pnl in zip(seg_pos, seg_pos * seg_pts):
        if p != cur:
            if cur != 0: trades.append(acc - cp * abs(cur))
            acc = -cp * abs(p) if p != 0 else 0.0; cur = p
        acc += pnl
    if cur != 0: trades.append(acc)
    return pd.DataFrame(dict(ret=ret, usd=usd, pos=day)), [t * mult for t in trades]

def run():
    rows = []
    for sym in ["NQ", "ES", "GC"]:
        d = load(f"{sym}_cont_1d.csv").loc[:CUTOFF]
        d = d[(d.High >= d.Low) & (d.Open > 0)]
        for name, fn in STRATEGIES.items():
            res, trades = simulate(d, fn(d), sym)
            for pname, (a, b) in PERIODS.items():
                r = res.loc[a:b]
                if pname.startswith("Full"):
                    tr = trade_stats(trades)  # trade stats over whole sample (includes 2005-09 warmup trades)
                else:
                    tr = {}
                p = perf(r.ret)
                rows.append(dict(symbol=sym, strategy=name, period=pname, **p, usd_pnl_1lot=r.usd.sum(),
                                 exposure=(r.pos != 0).mean(), **tr))
        print(sym, "done", file=sys.stderr)
    df = pd.DataFrame(rows)
    df.to_csv("results/daily_results.csv", index=False)
    return df

if __name__ == "__main__":
    import os; os.makedirs("results", exist_ok=True)
    df = run()
    pd.set_option("display.width", 250); pd.set_option("display.max_rows", 500)
    for sym in ["NQ", "ES", "GC"]:
        f = df[(df.symbol == sym) & (df.period == "Full 2010-2026")].set_index("strategy")
        f = f.join(df[(df.symbol == sym) & (df.period == "2010-2019")].set_index("strategy")[["sharpe"]].rename(columns={"sharpe": "sh_10_19"}))
        f = f.join(df[(df.symbol == sym) & (df.period == "2020-2026")].set_index("strategy")[["sharpe"]].rename(columns={"sharpe": "sh_20_26"}))
        f = f.join(df[(df.symbol == sym) & (df.period == "Last 12m")].set_index("strategy")[["total_ret"]].rename(columns={"total_ret": "ret_12m"}))
        f = f.join(df[(df.symbol == sym) & (df.period.str.startswith("Z26"))].set_index("strategy")[["total_ret", "usd_pnl_1lot"]].rename(columns={"total_ret": "ret_Z26", "usd_pnl_1lot": "usd_Z26"}))
        print(f"\n===== {sym} =====")
        print(f[["cagr", "sharpe", "max_dd", "sh_10_19", "sh_20_26", "ret_12m", "ret_Z26", "usd_Z26", "usd_pnl_1lot", "trades", "win_rate", "profit_factor", "exposure"]]
              .sort_values("sharpe", ascending=False).round(3).to_string())
