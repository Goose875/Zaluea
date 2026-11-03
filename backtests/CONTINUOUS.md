# Re-test on continuous front-month contracts (NQ1!, ES1!, GC1!)

Yahoo's `NQ=F`, `ES=F` and `GC=F` series always hold the front-month (most-traded) contract, the same idea as TradingView's NQ1! / ES1! / GC1!. Like TradingView's default, they are *not* back-adjusted at the rolls.

## What was already on continuous data (unchanged)
| Report | Data |
|---|---|
| REPORT.md: daily strategies 2010–2026, hourly strategies | continuous ✔ |
| BOT_STRATEGY.md: NQ NR7 + trend bot (1h, Jun 2024 – Nov 2026) | continuous ✔ |
| ICT_LEVELS.md: ICT / key levels (1h and 5m), GC FVG-trend bot | continuous ✔ |
| SCALPING.md: scalper rounds (1m, 5m) | **was Z26, now re-run** ↓ |
| RMULTIPLE.md: 5m section | **was Z26, now re-run** ↓ |

## 1-minute scalping: identical results
The 1-minute window (Oct 6 – Nov 2) is entirely after the September roll, so NQ1!, ES1! and GC1! *were* the Z26 contracts. The 1-minute closes match 100% and so do the results. Before the roll, the continuous NQ series differed from NQZ26 by about 293 points on average (it was then the Sep-26 contract).

## 5-minute scalping on continuous data (now Aug 25 – Nov 2, 49 sessions, vs 36 before)
The walk-forward was re-run (IS to Oct 9, OOS Oct 10 – Nov 2). Same conclusion as before: the **trend-pullback RSI(2)** scalper is the only family that passes, on NQ and GC.

| Market | Setup | OOS trades | OOS win | OOS P&L |
|---|---|---|---|---|
| NQ | Trend pullback RSI(2)<10 (tgt 107t / stop 321t / 8 bars) | 36 | 69% | +$2,730 |
| NQ | Trend pullback RSI(2)<5 (tgt 107t / stop 160t / 8 bars) | 19 | 68% | +$2,910 |
| GC | Trend pullback RSI(2)<10 (tgt 29t / stop 174t / 8 bars) | 18 | 83% | +$2,110 |
| ES | – | nothing passes | | |

**The final scalper on continuous data with its original parameters unchanged:**

| Market | Sample | Trades | Win | Net P&L | PF |
|---|---|---|---|---|---|
| NQ1! | all, Aug 25 – Nov 2 | 93 | 65% | +$6,950 | 1.31 |
| NQ1! | **fresh window Aug 25 – Sep 11** (never used for tuning) | 29 | **59%** | +$580 | 1.09 |
| GC1! | all, Aug 25 – Nov 2 | 54 | 72% | +$7,160 | 2.00 |
| ES1! | all | 93 | 48% | +$1,773 | 1.16 (fails the 60% goal) |

On the only truly fresh window, the NQ scalper dipped just under 60% wins and was roughly breakeven. Treat the scalper's edge as thin.

## 5-minute R-multiple grid on continuous data
For every market, the in-sample "best" setup + entry + stop **failed out-of-sample**:
* **NQ:** liquidity sweep & reclaim, –$6k to –$28k depending on R.
* **ES:** opening-range breakout, only 9 OOS trades, near flat.
* **GC:** Bollinger snap-back, –$5k to –$9k.

On the Z26 data the NQ pick (Donchian, confirm entry) had passed. That flip shows 5-minute R-multiple selections from about 33 sessions are unstable. **Use the hourly results** (2.4 years, train/valid/test) for bot decisions.

## Bottom line for the bot (all continuous)
| Market | Strategy | Evidence |
|---|---|---|
| NQ1! | NR7 breakout + EMA20/50 trend, 1h (BOT_STRATEGY.md) | test year +$33.0k, PF 1.50; 85% of 135 variants profitable |
| GC1! | ICT FVG trend in kill zones, 1h (ICT_LEVELS.md) | passes train/valid; test year +$17.9k, PF 1.20 (big test drawdown) |
| NQ1!, GC1! | Trend-pullback RSI(2) 5m scalper | 65–72% win rate overall, but only ~2 months of data; thin on NQ's fresh window |
| ES1! | none | nothing has passed validation in any family |
