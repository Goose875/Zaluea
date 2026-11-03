# $50k static-drawdown evaluation: pass / fail simulation

## Rules simulated
| Rule | Value |
|---|---|
| Starting balance | $50,000 |
| Drawdown | **static $2,000**: fail if equity touches **$48,000**, including the worst *open* loss inside a trade (from bar highs/lows) |
| Profit target | **$4,000** |
| Consistency | **55%**: pass only when the best single day ≤ 55% of total profit; if a big day breaks it, keep trading until it is satisfied |
| Not modelled | daily loss limit, minimum trading days (none given) |

**How the tests were run**
* **Rolling starts:** an evaluation was started on **every trading day** and run trade by trade until pass or fail.
* **Scale:** 9 strategies × 450 settings = **4,050 configurations**. With about 510 rolling starts each, that is over **2 million simulated evaluations**.
* **Settings tested:** risk $250–750 per trade (micros sized to risk, or 1 standard contract with a fixed $ stop), TP $1,000–3,000, breakeven off/+$500/+$750, two entry types and two stop types.
* **Tuning vs reporting:** tuned on evaluations starting **Jun 2024 – Sep 2025**; pass/fail reported on **untouched evaluations starting Dec 2025 – Aug 2026** (173 starts per strategy). Data: 1-hour bars, continuous NQ1! / ES1! / GC1!.
* **Time limit:** results are shown with a **90-day limit** (about 3 months of evaluation fees) and with no limit.
* **Final selection:** maximise *pass% − fail%* on the tuning starts. Maximising pass% alone picked the biggest risk every time, and those settings failed 52–100% of test evaluations.

## Scorecard (untouched test-period evaluations, 90-day limit)
| Verdict | Market | Strategy | Settings | Passed | Failed | Timed out | Pass % | Fail % | Median days to pass | No time limit: pass / fail |
|---|---|---|---|---|---|---|---|---|---|---|
| **PASS** | GC | NR7 breakout (long+short), **MGC micros** | market entry, 1×ATR stop, **risk $250** (~2 MGC), TP $2,000, BE +$500 | 87 | **9** | 76 | **51%** | **5%** | 58 | **141 / 13 (92%)** |
| **MARGINAL** | NQ | NR7 + EMA20/50 trend (**long only**), **MNQ micros** | confirm-close, 5-bar swing stop, risk cap $750 (~3.6 MNQ), TP $2,000, BE +$500 | 57 | 34 | 82 | 33% | 20% | 41 | 111 / 44 (72%) |
| FAIL | NQ | NR7 + EMA20/50 trend (long+short), MNQ | confirm-close, 5-bar swing, risk $625, TP $1,500 | 57 | 76 | 40 | 33% | 44% | 44 | 76 / 121 |
| FAIL | GC | NR7 breakout, MGC (inside your $500–750 risk range) | confirm-close, 1×ATR, risk $500, TP $2,500, BE +$500 | 43 | 84 | 45 | 25% | 49% | 63 | 93 / 96 |
| FAIL | ES | ICT turtle soup, 1 ES | $625 fixed stop, TP $2,500, BE +$750 | 36 | 137 | 0 | 21% | 79% | 36 | 36 / 149 |
| FAIL | NQ | NR10 long, 1 NQ | $750 fixed stop, TP $2,000 | 28 | 136 | 9 | 16% | 79% | 40 | 32 / 143 |
| FAIL | NQ | ICT FVG trend, 1 NQ | $750 fixed stop, TP $1,000–1,500 | 15–28 | 145 | 0–13 | 9–16% | 84% | 40–54 | 15–28 / 145 |
| FAIL | GC | ICT FVG trend, MGC | ICT stop, risk $625 | 3 | 30 | 139 | 2% | 17% | 64 | 41 / 91 |
| FAIL | GC | Donchian-20 long, MGC | 5-bar stop, risk $500 | 0 | 0 | 172 | 0% | 0% | – | no trades* |
| FAIL | ES | ICT FVG trend long, MES | ICT stop, risk $500–625 | 0 | 0 | 173 | 0% | 0% | – | no trades* |

\* In 2026 gold and ES volatility was high enough that **one micro already risked more than the cap** on these stops, so the bot skipped every signal. With a $500–750 cap, wide-stop strategies simply stop trading in volatile markets.

**NQ + GC in one account** (NQ NR7-trend MNQ at $500 risk + GC NR7 MGC at $250 risk, chosen on tuning; overlapping trades counted conservatively): **53% pass / 47% fail**, median **29 days** to pass.

## What the tuning showed
* **Risk per trade is the main lever.** A $2,000 static drawdown gives only 2.7–4 losses of room at $500–750 risk, and these strategies win only 20–30% of trades. NQ NR7-trend, untouched starts, no time limit:

| Risk per trade | Pass | Fail | Pass rate | Median days to pass |
|---|---|---|---|---|
| $250 | 108 | 54 | 67% | 87 |
| $375 | 102 | 74 | 58% | 72 |
| $500 | 99 | 97 | 51% | 58 |
| $625 | 76 | 121 | 39% | 59 |
| $750 | 62 | 140 | 31% | 37 |

* **Smaller risk passes more often but takes longer.** About $375–500 risk is the best balance for NQ. **Your $500–750 range is at the aggressive end** for a $2k static drawdown.
* **Micros beat 1 standard contract.** Fixed $500–750 stops on a full contract sit inside normal hourly noise. All 1-standard-contract versions failed 79–98% of test evaluations.
* **TP:** $1,500–2,000 passed more often than $2,500–3,000 under a 90-day limit (the median pass rate was highest at $1,000–2,000 TP).
* **Consistency (55%) was rarely the binding constraint.** With TP ≤ $3,000 and a $4,000 target, one day rarely exceeds 55% of total profit unless two winners land on the same day.

## Bottom line
1. **GC NR7 breakout, 2 MGC (about $250 risk), TP $2,000, BE +$500:** best in the test period (51% pass / 5% fail within 90 days; 92% eventually pass). **Caveat:** in the tuning period it passed only 33% within 90 days. Its 2026 strength partly reflects gold's volatile 2026, so it's not guaranteed to repeat.
2. **NQ NR7 + trend long-only, ~3–4 MNQ, TP $2,000, BE +$500:** usable but marginal (33% pass / 20% fail within 90 days; 72% eventually pass).
3. **Inside your exact range ($500–750 risk, $1.5–3k TP), no configuration was more likely to pass than fail** in the untouched period. To pass a $2k static drawdown, **drop risk to about $250–400 per trade** and use micros.
4. **Fail rates are real:** even the best settings fail some evaluations. Budget for resets.

This is research, not investment advice. Prop-firm rules vary (intraday trailing vs end-of-day, max contracts, news rules); check your firm's exact terms.

Code: `engine5.py` (adds intra-trade worst open P&L), `propeval.py` (evaluation simulator), `run_eval.py`, `run_eval_portfolio.py`. Results: `results/eval_grid.csv`, `results/eval_grid_90d.csv`, `results/eval_scorecard.csv`, `results/eval_portfolio_90d.csv`.
