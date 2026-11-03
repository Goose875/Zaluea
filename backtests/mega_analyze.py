"""Analyze the mega search: pass filter on TRAIN+VALID, compare with RANDOM-entry controls, measure TEST hold-up,
rank robust signal families (plateaus across management variants)."""
import numpy as np, pandas as pd
M = np.load("results/mega_M.npy")
EM = {0: "market", 1: "confirm-close", 2: "limit 50%"}; SM = {0: "signal-bar stop", 1: "1xATR stop", 2: "5-bar swing stop"}
def metrics(R):
    n = R[..., 0]; avg = np.where(n > 0, R[..., 1] / np.maximum(n, 1), np.nan)
    pf = np.where(R[..., 4] > 0, R[..., 3] / np.maximum(R[..., 4], 1e-9), np.nan); win = np.where(n > 0, R[..., 2] / np.maximum(n, 1), np.nan)
    sd = np.sqrt(np.maximum(R[..., 5] / np.maximum(n, 1) - avg ** 2, 1e-12)); t = avg / sd * np.sqrt(np.maximum(n, 1))
    return n, avg, pf, win, t
fam_rows, summary = [], []
for sym in ("NQ", "ES", "GC"):
    R = np.load(f"results/mega_{sym}.npy"); meta = pd.read_csv(f"results/mega_{sym}_meta.csv")
    n, avg, pf, win, t = metrics(R)
    ok = (n[..., 0] >= 50) & (n[..., 1] >= 30) & (avg[..., 0] >= 0.15) & (avg[..., 1] >= 0.15) & (pf[..., 0] >= 1.3) & (pf[..., 1] >= 1.3)
    rnd = meta.trigger.str.startswith("RANDOM").values[:, None] & np.ones(ok.shape, bool)
    real = ~rnd
    def share(mask): return mask.sum() / max(1, ((n[..., 0] >= 50) & (n[..., 1] >= 30) & (rnd == (mask is None))).sum())
    for lab, grp in (("REAL triggers", real), ("RANDOM controls", rnd)):
        elig = grp & (n[..., 0] >= 50) & (n[..., 1] >= 30) & (n[..., 2] >= 30)
        p = ok & elig
        summary.append(dict(symbol=sym, group=lab, strategies=int(grp.sum()), eligible=int(elig.sum()), passed=int(p.sum()),
                            pass_rate=p.sum() / max(1, elig.sum()), TEST_avgR_passed=np.nanmedian(avg[..., 2][p]) if p.any() else np.nan,
                            TEST_pos_passed=(avg[..., 2][p] > 0).mean() if p.any() else np.nan, TEST_avgR_all=np.nanmedian(avg[..., 2][elig])))
    # robust families: signal variants with many passing mgmt variants
    plate = ok.sum(1); elig_v = (n[..., 0] >= 50).sum(1)
    for v in np.where(plate >= 15)[0]:
        g = ok[v]; 
        fam_rows.append(dict(symbol=sym, **meta.iloc[v].to_dict(), plateau=int(plate[v]), of=int(elig_v[v]),
                             TR_avgR=np.median(avg[v, g, 0]), VA_avgR=np.median(avg[v, g, 1]), TE_avgR=np.median(avg[v, g, 2]),
                             TE_pos=(avg[v, g, 2] > 0).mean(), TE_n=np.median(n[v, g, 2]), TR_n=np.median(n[v, g, 0]),
                             best_mgmt=np.bincount(np.where(g)[0]).argmax() if g.any() else -1, random=meta.iloc[v].trigger.startswith("RANDOM")))
S = pd.DataFrame(summary); F = pd.DataFrame(fam_rows); F.to_csv("results/mega_families.csv", index=False)
pd.set_option("display.width", 340); pd.set_option("display.max_colwidth", 46); pd.set_option("display.max_rows", 100)
print("=== Does the search beat luck? (pass = TRAIN & VALID avgR>=0.15, PF>=1.3, n>=50/30) ==="); print(S.round(3).to_string(index=False))
print(f"\nrobust signal families (>=15 of 144 mgmt variants pass): {len(F)}  (random controls among them: {int(F.random.sum()) if len(F) else 0})")
if len(F):
    print(F.sort_values(["plateau"], ascending=False).groupby("symbol").head(12).drop(columns=["best_mgmt", "random"]).round(3).to_string(index=False))
