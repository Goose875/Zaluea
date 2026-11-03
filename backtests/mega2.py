"""500M+ strategy search (1h, continuous NQ1!/ES1!/GC1!).
TRIGGERS: 45 zone triggers (9 zone types re-marked at every open x 5 entry models) + 111 static-level triggers + 37 setups + 20 RANDOM controls
DIRECTION: both / long / short
FILTERS (1,080): daily regime (with/none/against) x hourly trend (with/none) x volatility (low/high/any) x time window (5)
                 x premium/discount vs prior-week range (with/none) x day of week (any/Mon/Tue/Wed/Thu/Fri)
MANAGEMENT: zone triggers 448 = entry(market/confirm/limit50/LIMIT AT LEVEL) x stop(signal bar/1ATR/5-bar/BEYOND ZONE)
            x target(1,1.5,2,3,5R/none/NEXT LEVEL) x BE x trail x time stop(none/3/6 bars) = 1,344 ; other triggers 648 = 3 entries x 3 stops x 6 targets x BE x trail x time stop
Splits TRAIN<=2025-03-31, VALID<=2025-11-30, TEST to 2026-11-02. Only TRAIN+VALID used to pass/select.
Outputs (streaming): passing strategies (sparse) + per-signal-variant summary."""
import os; os.environ["SRC"] = "cont"
import numpy as np, pandas as pd, itertools, time, sys, warnings
warnings.filterwarnings("ignore")
from mega_engine2 import run_block2
import mega, levels2
from common import SPECS, load
SPLIT = ("2025-03-31", "2025-11-30")
HOLD = int(os.environ.get("HOLD", "0")); TAG = "_hold" if HOLD else ""
TSTOPS = (6, 12, 24, 48, 96) if HOLD else (0, 3, 6)   # swing run: always time-capped (bars)
MZ = np.array([[em, sm, k, be, tr, tm] for em in (0, 1, 2, 3) for sm in (0, 1, 2, 3) for k in (1.0, 1.5, 2.0, 3.0, 5.0, 0.0, -1.0) for be in (0, 1) for tr in (0, 1) for tm in TSTOPS], float)
MB = np.array([[em, sm, k, be, tr, tm] for em in (0, 1, 2) for sm in (0, 1, 2) for k in (1.0, 1.5, 2.0, 3.0, 5.0, 0.0) for be in (0, 1) for tr in (0, 1) for tm in TSTOPS], float)
PASS = dict(n0=50, n1=30, avg=0.15, pf=1.3)

def filters(d, sym):
    base = mega.filters(d, sym)                                    # 90 = regime x trend x vol x window
    dow = d.index.dayofweek.values; hr = d.index.hour.values
    tdow = np.where(hr >= 18, (dow + 1) % 7, dow)                  # Globex day of week
    wk = (d.index + pd.Timedelta(hours=6)).to_period("W-FRI")
    g = pd.DataFrame(dict(H=d.High.values, L=d.Low.values, w=wk.astype(str))).groupby("w").agg(H=("H", "max"), L=("L", "min"))
    mid = ((g.H + g.L) / 2).shift(); pmid = pd.Series(wk.astype(str)).map(mid).values
    disc = d.Close.values < pmid; prem = d.Close.values > pmid
    out = []
    for (key, lm, sm_) in base:
        for pdf in ("none", "with"):
            l2, s2 = (lm, sm_) if pdf == "none" else (lm & disc, sm_ & prem)
            for dw in ("any", 0, 1, 2, 3, 4):
                if dw == "any": out.append((key + (pdf, "any"), l2, s2))
                else: m_ = tdow == dw; out.append((key + (pdf, ["Mon", "Tue", "Wed", "Thu", "Fri"][dw]), l2 & m_, s2 & m_))
    return out

def summarize(res, metas, sink_pass, sink_var, is_zone):
    n = res[..., 0]; avg = np.where(n > 0, res[..., 1] / np.maximum(n, 1), np.nan)
    pf = np.where(res[..., 4] > 0, res[..., 3] / np.maximum(res[..., 4], 1e-9), 99.0)
    ok = (n[..., 0] >= PASS["n0"]) & (n[..., 1] >= PASS["n1"]) & (avg[..., 0] >= PASS["avg"]) & (avg[..., 1] >= PASS["avg"]) & (pf[..., 0] >= PASS["pf"]) & (pf[..., 1] >= PASS["pf"])
    elig = (n[..., 0] >= PASS["n0"]) & (n[..., 1] >= PASS["n1"])
    for v in range(res.shape[0]):
        e = int(elig[v].sum());
        if e == 0: continue
        p = np.where(ok[v])[0]
        sink_var.append(metas[v] + (e, len(p), float(np.nanmedian(avg[v, p, 2])) if len(p) else np.nan,
                                    float((avg[v, p, 2] > 0).mean()) if len(p) else np.nan, float(np.nanmedian(avg[v, elig[v], 2])),
                                    float(np.nanmedian(avg[v, p, 0])) if len(p) else np.nan, float(np.nanmedian(avg[v, p, 1])) if len(p) else np.nan))
        for g in p:
            sink_pass.append(metas[v] + (int(g), int(is_zone), float(n[v, g, 0]), float(avg[v, g, 0]), float(pf[v, g, 0]), float(n[v, g, 1]), float(avg[v, g, 1]),
                                         float(pf[v, g, 1]), float(n[v, g, 2]), float(avg[v, g, 2]), float(pf[v, g, 2])))

if __name__ == "__main__":
    syms = sys.argv[1:] or ["NQ", "ES", "GC"]
    for sym in syms:
        t0 = time.time(); d, Lv = mega.levels(sym); sp = SPECS[sym]
        T, A_ab, A_be = levels2.build(d); Z = levels2.zone_triggers(d, T, A_ab, A_be)
        old = mega.triggers(sym, d, Lv)                                  # 111 static levels + 37 setups + 20 random
        F = filters(d, sym); nan = np.full(len(d), np.nan)
        cuts = [int((d.index <= pd.Timestamp(x + " 23:59", tz="America/New_York")).sum()) for x in SPLIT]
        arrs = (d.Open.values, d.High.values, d.Low.values, d.Close.values, d.atr.values.astype(float), d.sess_id.values.astype(np.int64))
        jobs = [(k, v[0], v[1], v[2], v[3], v[4], True) for k, v in Z.items()] + [(k, L, S, nan, nan, nan, False) for k, (L, S) in old.items()]
        sink_pass, sink_var = [], []; total = 0
        for jn, (tname, L0, S0, lim, stp, tgt, isz) in enumerate(jobs):
            M = MZ if isz else MB
            for dr in ("both", "long", "short"):
                L1 = L0 if dr != "short" else np.zeros_like(L0); S1 = S0 if dr != "long" else np.zeros_like(S0)
                Lm, Sm, metas = [], [], []
                for (key, lm, sm_) in F:
                    Lx, Sx = L1 & lm, S1 & sm_
                    if Lx.sum() + Sx.sum() < 40: continue
                    Lm.append(Lx); Sm.append(Sx); metas.append((tname, dr) + key)
                if not Lm: continue
                for c0 in range(0, len(Lm), 300):
                    res = run_block2(*arrs, np.array(Lm[c0:c0 + 300]), np.array(Sm[c0:c0 + 300]), lim, stp, tgt, M, cuts[0], cuts[1], sp["tick"], float(sp["mult"]), sp["comm"], HOLD)
                    total += res.shape[0] * res.shape[1]
                    summarize(res, metas[c0:c0 + 300], sink_pass, sink_var, isz)
            if jn % 20 == 0: print(f"{sym} trigger {jn}/{len(jobs)} strategies so far {total:,} ({time.time()-t0:.0f}s)", flush=True)
        cols = ["trigger", "dir", "regime", "trend", "vol", "window", "pd", "dow"]
        pd.DataFrame(sink_var, columns=cols + ["eligible", "passed", "pass_TE_med", "pass_TE_pos", "elig_TE_med", "pass_TR_med", "pass_VA_med"]).to_csv(f"results/mega2{TAG}_{sym}_variants.csv.gz", index=False, compression="gzip")
        pd.DataFrame(sink_pass, columns=cols + ["mgmt", "zone_mgmt", "TR_n", "TR_avg", "TR_pf", "VA_n", "VA_avg", "VA_pf", "TE_n", "TE_avg", "TE_pf"]).to_csv(f"results/mega2{TAG}_{sym}_pass.csv.gz", index=False, compression="gzip")
        with open(f"results/mega2{TAG}_{sym}_count.txt", "w") as fh: fh.write(str(total))
        print(f"{sym} DONE: {total:,} strategies, {len(sink_pass):,} passed TRAIN+VALID, {time.time()-t0:.0f}s", flush=True)
