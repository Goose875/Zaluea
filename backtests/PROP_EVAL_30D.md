# $50k evaluation with a 30-day limit and a $1,000 daily loss limit

## Rules simulated
* **Account:** $50k start, **static $2k drawdown** (fail at $48k, including open loss), **$4k target**, **55% consistency**.
* **New:** a **$1,000 daily loss limit (DLL)** and a **30-calendar-day limit** (~21 trading days). Not passing in 30 days counts as not passing.
* **DLL tested two ways:**
  * **Hard:** the day's loss including open loss reaches –$1,000 → account fails.
  * **Soft:** the position is liquidated at –$1,000 and trading stops for the day; the account continues.
* **Tuning vs reporting:** an evaluation was started on every trading day. Settings were tuned on starts Jun 2024 – Sep 2025 and reported on **216 untouched starts, Dec 2025 – Oct 2026**. 1-hour bars, NQ1! / ES1! / GC1!, micro contracts sized to the $ risk.

## 1. Single strategies: the 30-day limit is the problem
4,050 configurations per DLL mode. Best per strategy, chosen on tuning, then judged on untouched starts:

| Rule set | Best single strategy (chosen on tuning) | Pass | Fail | Timed out |
|---|---|---|---|---|
| 30 days, no DLL | NQ NR7+trend, MNQ, $750 risk, TP $2k, BE +$500 | 9% | 17% | 74% |
| 30 days, soft DLL | NQ NR7+trend, MNQ, $750 risk, TP $2k | 6% | 39% | 55% |
| 30 days, hard DLL | best tuned configs barely traded (0% pass / 0–10% fail); highest test pass rate of any config: 27% | | | |

A single hourly strategy trades only ~4–10 times a month and wins 25–30% of the time. It can't reliably reach $4k in 21 trading days.

## 2. Several strategies in one account (more trades)
**Streams:** NQ NR7-trend (MNQ), GC NR7 (MGC), ES ICT turtle soup (MES) and NQ ICT FVG (MNQ). Each uses the same $ risk per trade; about 30–43 trades a month in total. When positions overlap, their worst open losses are **summed** (worst case) for both the drawdown and the DLL.

Best configuration per DLL mode, chosen on tuning (pass% − fail%), on untouched test starts:

| DLL | Streams | Risk / trade | TP | BE | **Pass** | **Fail** | Timed out | Median days to pass |
|---|---|---|---|---|---|---|---|---|
| none | NQ + GC + ES | $375 | $2,000 | +$500 | **25%** (54) | 28% (61) | 47% | 23.5 |
| **soft $1k** | NQ + GC + ES | $250 | $2,000 | +$500 | **17%** (37) | 22% (48) | 61% | 18 |
| soft $1k | NQ + GC | $250 | $2,500 | +$500 | 16% (34) | 14% (30) | 70% | 21.5 |
| **hard $1k** | NQ + GC + ES | $250 | $2,500 | +$500 | **17%** (37) | 53% (115; 105 of them DLL breaches) | 30% | 18 |
| hard $1k | NQ + GC | $250 | $1,000 | +$750 | 12% (27) | 38% (82; 63 DLL) | 50% | 25 |

Pushing for speed with bigger risk ($500, TP $1,500) raised the test pass rate to 29–32% (no DLL) and 14–19% (soft DLL), but **fail rates jumped to 50–74%**.

## Verdict
* **No configuration passes most 30-day / $1k-DLL evaluations.** Realistic odds from the best settings:
  * **soft DLL:** about **1 in 6 pass, 1 in 4–5 fail**, the rest run out of time;
  * **hard DLL:** about **1 in 6 pass, 1 in 2 fail**.
* **Hard DLL hurts most when trading several markets at once,** because simultaneous losers add up within a day. With a hard DLL, trade **one or two streams at $250 risk**, or cap open risk to one position at a time.
* **Best practical setup:**
  * **soft DLL:** NQ NR7-trend + GC NR7 (+ ES turtle soup) on micros, **$250 risk per trade, TP $2,000–2,500, breakeven at +$500**;
  * **no DLL:** the same streams at **$375 risk, TP $2,000, BE +$500**.
* **Budget:** these strategies need more than 30 days to show their edge (median pass time without a time limit was 40–90 days). On a 30-day evaluation, expect several attempts per pass. Without a time limit, the same strategies passed 51–92% of the time (PROP_EVAL.md).
* **Not testable here:** the 5-minute scalper trades more often and might suit 30-day evaluations, but there are only ~2 months of 5-minute history, so it can't be tested with rolling 30-day starts and a separate tuning period.

This is research, not investment advice. Check your firm's exact DLL rule (hard vs soft, intraday vs end-of-day).

Code: `propeval.py` (now with DLL and time limit), `run_eval.py` (env `MAX_DAYS`, `DLL`, `DLL_MODE`), `run_eval_multi.py`. Results: `results/eval_grid_30d*.csv`, `results/eval_multi_30d.csv`.
