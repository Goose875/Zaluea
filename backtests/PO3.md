# 4h PO3 (Power of Three) with 15m FVG / RB / IFVG / MSS entries

Scripts: `po3.py` (all markets), `po3_gc.py` (gold deep tests), `po3_gc_controls.py`. Results are in `results/po3_*`.

## Gold candidates (fixed before the deep tests)
| | Model | Data | Trades | Avg R | Double costs | Direction flipped | Beats random entry levels | PO3 direction vs opposite ($/trade, 1 GC) |
|---|---|---|---|---|---|---|---|---|
| **A1** | 15m rejection block, bias vs 18:00 open, manipulation below open, 3R, exit at the 4h close | 10 weeks | 53 | **+0.56** | +0.50 | -0.50 | **96%** | **+$116 vs -$230** |
| A2 | 15m FVG midpoint, no bias, target previous 4h extreme, flat 16:09 | 10 weeks | 108 | +0.37 | +0.33 | -0.03 | 98% | -$4 vs -$70 |
| B2 | 1h rejection block, 4h EMA20 bias, exit at the 4h close | 2.4 years | 183 | +0.35 | +0.31 | -0.13 | 22% | +$152 vs -$118 |
| B1 | 1h FVG midpoint, previous 4h candle colour bias | 2.4 years | 106 | +0.36 | +0.33 | -0.01 | 26% | +$118 vs **+$311** |

- **A1 passes every check**: double costs, direction flip, random entry levels, PO3 direction, manipulation threshold 0.05–0.3 ATR (+0.47 to +0.61R), entry window 2.5–3.5h, and 5 of 6 candles positive (14:00 is not).
  It only has 10 weeks of data (53 trades) because 15-minute history beyond 60 days needs Topstep's data.
- **B2**: the PO3 direction matters (with the 4h EMA20), but the rejection-block level is no better than a random pullback level. Positive in 9 of 11 quarters; the losing quarters were 2024 Q2–Q3. On a Topstep 150K ($750 risk per trade, about 6–7 MGC): 70% pass, 30% fail, median 20 trading days.
- **B1 is rejected**: buying or selling a pullback in the last hour and exiting at the candle close made money in both directions on hourly bars, so its result isn't PO3.
- The 22:00 candle is flat or negative in every candidate, and the 14:00 candle is too thin to judge.
