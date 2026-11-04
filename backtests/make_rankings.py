"""Builds keel-app/src/ksys/rankings.json (Keel's Rankings page) from the Topstep 50K Static results."""
import json, numpy as np, pandas as pd
ID = {"GC Fractal (flat daily)": "K8", "GC PO3 1h RB": "K9"}
ren = lambda s: " + ".join(ID.get(x, x) for x in s.split(" + "))
R = pd.read_csv("results/topstep_static_combos.csv"); R = R[R.payout_cap == 2000].copy(); R["strategies"] = R.strategies.map(ren)
R["score"] = R.pass_pct * R.xfa_first_payout_pct
O = pd.read_csv("results/topstep_static_oos.csv"); O["strategies"] = O.strategies.map(ren)
O = O.rename(columns={"pass_pct": "oos_pass_pct", "median_days_to_pass": "oos_days_to_pass", "xfa_first_payout_pct": "oos_payout_pct"})[["strategies", "risk", "oos_pass_pct", "oos_days_to_pass", "oos_payout_pct"]]
R = R.merge(O, on=["strategies", "risk"], how="left")
cols = ["strategies", "n_strats", "risk", "pass_pct", "median_days_to_pass", "pass_within_20d", "xfa_first_payout_pct", "median_days_pass_to_1st_payout",
        "xfa_blown_before_payout_pct", "median_cash_first60d", "trades_per_week", "score", "oos_pass_pct", "oos_days_to_pass", "oos_payout_pct"]
singles = R[R.n_strats == 1][cols]
M = R[R.n_strats > 1]
mixes = pd.concat([M.sort_values(["score", "median_days_to_pass"], ascending=[False, True]).groupby("risk").head(40),
                   M.sort_values("median_days_to_pass").query("pass_pct >= 0.8").groupby("risk").head(10),
                   M[M.strategies == "K1 + K3 + K4 + K5 + K6 + K7"]]).drop_duplicates(["strategies", "risk"])[cols]
E5 = pd.read_csv("results/po3_gc_eval50.csv")
pick = {"P1": ("FVG CE", "none", "below open", "none", "candle close"), "P2": ("RB", "vs 18:00 open", "below open", "3R", "candle close")}
paper = []
for pid, (m, b, e, t, x) in pick.items():
    for _, r in E5[(E5.entry == m) & (E5.bias == b) & (E5.manipulation == e) & (E5.target == t) & (E5.exit == x)].iterrows():
        paper.append(dict(strategies=pid, risk=int(r.risk), pass_pct=r.pass_pct_of_finished, median_days_to_pass=r.median_days_to_pass, note="10 weeks of data, no payout test"))
def clean(df): return [{k: (None if (isinstance(v, float) and np.isnan(v)) else (round(v, 4) if isinstance(v, float) else v)) for k, v in row.items()} for row in df.to_dict("records")]
out = dict(source="Topstep 50K Static simulation: $4k target, $2k static drawdown, $1k daily loss limit, 55% consistency; funded: 5 days of $150+, 50% of balance up to $2,000, 90% split. Hourly data Jun 2024 - Nov 2026; a new Combine every trading day. oos = Combines started Dec 2025 or later (after K1-K7 were chosen).",
           recommended=dict(strategies="K1 + K3 + K4 + K5 + K6 + K7", risk=350), singles=clean(singles), mixes=clean(mixes), paper=paper)
json.dump(out, open("../keel-app/src/ksys/rankings.json", "w"), indent=0); print(len(singles), len(mixes), len(paper))
