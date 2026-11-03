# Trend scalping with minis: "+$200 at a time, $1,500 a day"

## Test
* **Contracts:** minis only: 1–2 NQ, 1–3 ES, 1–2 GC.
* **Data:** continuous front month, regular hours.
  * **1-minute:** Oct 6 – Nov 2 2026 (20 sessions); tuning = first 12, untouched test = last 8.
  * **5-minute:** Aug 25 – Nov 2 2026 (49 sessions); tuning to Oct 9, test = last 16.
* **Trend scalps (with the trend only; trend = price vs VWAP plus EMA20/50, optionally a slower higher-timeframe trend):**
  * EMA-9 pullback;
  * RSI(2) dip;
  * one-bar pullback break;
  * VWAP bounce;
  * 10-bar micro breakout.
* **Trade:** fixed $ bracket, target **$100 / $150 / $200 / $300**, stop 0.5–2× target, time stop, market or confirm entry.
* **Daily rules:** stop for the day at **+$1,500** or at –$500 / –$1,000.
* **Costs:** $2.50 per contract per side plus 1 tick of slippage per side. Target fills need price to trade 1 tick through; the stop wins if both are hit in the same bar.
* **26,496 configurations.**

## Results
| | 1-minute | 5-minute |
|---|---|---|
| Median average day, all configurations | **–$422** | **–$247** |
| Configurations with a positive average day on untouched days | 11% | 4% |
| Top 200 by tuning → average untouched day | –$157 (12% positive) | –$43 (8% positive) |
| Untouched days reaching the +$1,500 goal (top 200) | **0%** | **0%** |

Best tuning-period config (1-min NQ EMA-9 pullback, confirm entry, 1 NQ, TP $300 / SL $450): **+$445/day in tuning → –$284/day on untouched days, 75% red days**.

## Why it doesn't work
* **Costs per trade are large relative to the target.**
  * One NQ round trip costs about **$15** ($5 commission + 2 ticks slippage); ES about $30; GC about $25.
  * At 10–15 trades a day that is **$150–450 a day in costs** before any edge.
  * A $200 target on 1 NQ is only 10 points, so costs are 7–15% of every winner and add to every loser.
* **Win rates of 50–60% don't overcome that.** With stops at or above the target size, 1-minute trend continuation on OHLC bars has close to zero gross edge.
* **The +$1,500 daily goal is rarely reached:** 0–25% of days even in the tuning period, 0% in the untouched period for the robust picks.
* **Caveat:** bar data can't capture queue position or tick-level order flow, and the "stop first when both are hit" rule is conservative. Real tick-level scalping could do somewhat better or worse, but the costs alone are a heavy hurdle.

## Conclusion
High-frequency trend scalping with minis loses money in this data. The edges found in this project are on **1-hour bars with few, larger trades** (EVAL150.md, MEGA.md), not in scalping. Chasing $1,500 a day with $200 scalps mainly multiplies costs.

This is research, not investment advice.
