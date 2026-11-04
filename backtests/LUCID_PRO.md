# LucidPro 50K evaluation (`lucid_pro.py`)
Rules modelled:
- $3,000 profit target.
- $2,000 max loss that trails the end-of-day high.
- Optional $1,200 daily loss limit (it stops the day; it doesn't fail the account).
- No consistency rule, no time limit.

Same strategies, MNQ/MGC sizing and one-position-per-market netting as the Topstep test. A new evaluation starts on every trading day, Jun 2024 to Nov 2026. "Last year" means evaluations started from Dec 2025, after K1-K7 were chosen.

| Mix | Risk | Daily loss limit | Pass, all / last year | Median days to pass, last year |
|---|---|---|---|---|
| **K1+K3+K4+K5+K6+K7** | **$250** | **on** | **100% / 100%** | **22** |
| K1+K3+K4+K5+K6+K7+K9 | $250 | on | 97% / 95% | 22 |
| K1+K3+K4+K6+K7 | $250 | on or off | 100% / 100% | 24 |
| K1+K3+K4+K5+K6+K7 | $350 | on | 82% / 74% | 19 |
| K1+K3+K4+K5+K6+K7 | $500 | on | 71% / 77% | 13 |
| K1+K3+K4+K5+K6+K7 | $750 | on | 63% / 74% | 7 |

The end-of-day trailing max loss is much less forgiving than Topstep's static one. Above $250 risk, the pass rate drops quickly.
