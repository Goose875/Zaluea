# Search for a 70% pass rate: 30-day evaluation, $2k TP, $500 stop, soft $1k DLL

## Rules
* **Account:** $50k, static $2k drawdown (including open loss), $4k target, 55% consistency.
* **Daily loss limit:** soft $1k (liquidate and stop for the day).
* **Time limit:** 30 calendar days.
* **Trades:** **$500 stop, $2,000 target**, breakeven (off / +$500 / +$1,000) and dollar trailing (off, or start at +$750/1,000/1,500 and trail $500/750).

## The math first
Monte Carlo of a +$2,000 / –$500 trade stream with these account rules:

| Win rate (full $2k wins) | 8 trades in 30 days | 15 trades | 25 trades |
|---|---|---|---|
| 25% | 19% pass | 34% | 43% |
| 30% | 28% | 50% | 59% |
| 35% | 39% | 64% | **72%** |
| 40% | 50% | **75%** | 82% |

**A 70% pass rate needs about a 35–40% rate of full-$2,000 winners and at least 15–25 trades in the 30 days.** Partial trailing wins help less than full wins.

## What was searched
* **Single configurations:** **26,910** in total.
  * All 48 setups (33 standard incl. NR family, plus 15 ICT/level setups) on NQ, ES and GC, long+short or long only.
  * 2–3 entry types.
  * 4 sizings: fixed $500 bracket on 1 standard contract, 4 micros or 10 micros; or the strategy's own stop with micros sized to $500.
  * 3 breakeven options and 5 trailing options.
* **Evaluations:** each configuration was run on rolling evaluations started every trading day. Tuning used 335 starts (Jun 2024 – Sep 2025); testing used 216 untouched starts (Dec 2025 – Oct 2026).
* **Portfolios:** multi-stream portfolios built greedily from the best 40 configurations, one position per market at a time.

## Results
| Approach | Tuning pass / fail | **Untouched test pass / fail** |
|---|---|---|
| Best single config (GC NR10 long, micros ≤ $500, BE +$500) | 32% / 26% | **5% / 50%** |
| Best NQ single (NR7 + EMA200, micros ≤ $500, trail $1,000/$500) | 35% / 30% | **19% / 63%** |
| Best greedy portfolio (GC NR10 + NQ ICT-FVG + GC RSI-50 cross; 18 trades/month) | **47% / 26%** | **11% / 61%** |
| *Hindsight ceiling:* best config chosen **on the test period itself** (GC NR7, micros) | 19% / 65% | 43% / 27% |
| Previous best realistic setup (PROP_EVAL_30D.md: NQ+GC+ES, $250 risk, TP $2k) | 14% / 27% | 17% / 22% |

**Why it falls short**
* Only **3–14% of trades reach the full $2,000** on 1-hour bars within a session. Most "wins" are breakeven or trailing exits worth $0–800.
* The full-target win rate is far below the ~35–40% needed.
* The streams that looked best in 2024–25 (long gold) failed in 2026's market, so tuned pass rates don't carry forward.
* Even the hindsight ceiling (43%) is far from 70%, and it was a 19%-pass configuration in the earlier period.

## Conclusion
**No strategy, combination or management setting tested reaches a 70% pass rate within 30 days** under these rules. That held on the tuning data, the untouched data, and even with hindsight on the test data. A realistic expectation from the methods here is **about 15–20% pass per 30-day attempt** (soft DLL).

## What could change the odds (not yet testable here)
1. **Higher-frequency, higher-accuracy entries** (5m/1m, order flow). This needs more intraday history than the 60 days of 5-minute data available from the free source. With paid historical data (e.g. 1-minute data for 1–2 years) the scalpers could be tested properly.
2. **Allowing positions to be held overnight** (if the firm allows it), so more trades can reach $2,000.
3. **Changing the trade or account parameters you control.** In the earlier tests a smaller TP ($1,000–1,500) or a longer or unlimited time limit gave higher pass rates. Without a time limit, the best NQ/GC setups passed 51–92% (PROP_EVAL.md).

This is research, not investment advice.

Code: `engine6.py` (engine with dollar trailing stops), `run_eval70.py` (single-config search), `run_eval70_portfolio.py` (greedy portfolios). Results: `results/eval70_single.csv`, `results/eval70_portfolio.csv`.
