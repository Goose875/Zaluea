# Bot strategy research v2: breakeven, trailing stops, 33 strategies, 3-way validation

## What was tested
* **Setups:** 33 in total:
  * the 9 from the previous round;
  * 12 new: Keltner breakout, Supertrend flip, MACD cross with trend, ADX>25 pullback to EMA20, Heikin-Ashi flip, 3-bar pullback, squeeze breakout, NR7 breakout, RSI-50 cross, VWAP cross, opening drive, engulfing at EMA20;
  * 12 compression-breakout variants: NR4, NR10, NR7/NR4 + inside bar, inside bar, and NR7 with EMA trend, EMA200, active-hours and volume dry-up filters.
* **Entries (5):** market at the next open; stop order above/below the signal bar; limit at the signal bar's 50%; limit at close − 0.5 ATR; wait for a bar to *close* beyond the signal bar.
* **Initial stops (3):** signal-bar extreme; 1 × ATR; 5-bar swing.
* **Targets (7):** none (exit only by stop/trail/session end), 1R, 1.5R, 2R, 3R, 4R, 5R.
* **Breakeven (3):** off; move the stop to entry +1 tick once the trade reaches +0.5R; same at +1R.
* **Trailing stops (9):** none; ATR chandelier at 1.5× or 3× ATR; 2-bar or 5-bar low/high. Each trail either starts immediately or only after +1R.
* **Other dimensions:** direction (long + short, or long only), and an optional daily SMA-50 trend filter.
* **Scale:** over **400,000 combinations** on 1-hour NQ / ES / GC data (Jun 2024 – Nov 2026).
* **Trade management** is updated only when a bar closes, so there is no look-ahead inside a bar. Same conservative fill model as before.

## Validation: three data splits
| Split | Dates | Used for |
|---|---|---|
| TRAIN | Jun 2024 – Mar 2025 | choosing |
| VALID | Apr – Nov 2025 | must also be profitable here |
| **TEST** | **Dec 2025 – Nov 2 2026** | never used to choose; reported only at the end |

**Selection rule (mechanical, never looks at TEST):**
1. Rank each setup family by how many of its parameter sets pass both TRAIN and VALID (≥50 / ≥35 trades, ≥ +0.10R per trade, profit factor ≥ 1.2). A broad plateau of passing settings matters more than one peak.
2. Run the winning family as an ensemble of every parameter set that passed, or as one representative set made of the most common value of each parameter.

## Findings
1. **Picking the single best backtest is a trap.** Single best combos made +0.4 to +0.6R per trade on TRAIN and VALID, but only about +0.05R on TEST (NQ) and negative on GC. Out of 328k combos, those passing TRAIN+VALID still had a median TEST result of -0.01R.
2. **Breakeven stops did not improve expectancy in any market.**
   * Median R per trade was unchanged.
   * Win rate fell: about 10 points lower with breakeven at +0.5R, about 3 points lower at +1R.
   * The reason: breakeven exits turn would-be winners into scratch trades, and a scratch trade loses the commission.
3. **Trailing stops:**
   * Starting the trail only **after +1R** beat starting it immediately in every variant.
   * **ATR 1.5× after +1R** gave the highest win rate (~36–37%) with neutral expectancy.
   * Trailing alone does not turn a losing setup into a winner.
4. **Letting winners run beats small targets:** median expectancy improves steadily from 1R → 5R → no target. 1R targets were the worst choice in every market.
5. **The daily SMA-50 trend filter helped NQ:** the median TEST result of passing combos rose from +0.036R to +0.069R, and the share profitable from 68% to 77%. It made little difference for GC or ES.
6. **ES: no robust strategy found** in any round. **GC:** the top families were long-biased and **lost money in the TEST year** (gold fell in late 2026).

## The strategy that held up: NQ "NR7 breakout + trend" (1-hour bars, long and short)
This family was ranked #1 for NQ without looking at the test data.

**Rules (single representative parameter set, the most common value of each parameter among the 135 passing sets):**
* **Signal (long):**
  * the previous 1-hour bar was an **NR7** (narrowest high-low range of the last 7 bars);
  * the current bar **closes above that NR7 bar's high**;
  * **EMA20 > EMA50** (on the 1-hour chart).
* **Signal (short):** the mirror image: close below the NR7 bar's low, with EMA20 < EMA50.
* **Entry:** *confirm-close*. The next bar must also close beyond the signal bar's high (or low for shorts); then enter at market on the following bar's open.
* **Initial stop:** 1 × ATR(14) from entry.
* **Target:** none.
* **Breakeven:** none.
* **Trailing stop:** once the trade reaches **+1R**, trail at **1.5 × ATR** from the best price, updated at each bar close.
* **Session:** flat at the 17:00 ET daily close. One position at a time.

| Model | Period | Trades | Win % | Avg R | P&L (1 NQ) | PF | Max DD |
|---|---|---|---|---|---|---|---|
| Single set | TRAIN | 70 | 46% | +0.57 | +$60,624 | 2.64 | –$7,651 |
| Single set | VALID | 59 | 54% | +0.13 | +$6,882 | 1.21 | –$6,106 |
| **Single set** | **TEST (Dec 25 – Nov 26)** | **78** | **46%** | **+0.19** | **+$32,996** | **1.50** | **–$13,286** |
| Single set | NQZ26 front month (Sep 14 – Nov 2) | 11 | 55% | +0.27 | +$6,972 | 1.74 | –$4,115 |
| Ensemble of 135 sets | TEST | ~131 | 31% | +0.08 | +$20,229 avg per set | 1.15 | –$17,257 |
| Ensemble of 135 sets | NQZ26 front month | ~19 | 29% | –0.06 | +$1,428 avg per set | 1.06 | –$5,232 |

* **85% of the 135 ensemble sets were profitable in the TEST year.** That breadth is the main evidence the edge is not a single lucky parameter set.
* Average win is about $2.7k against an average loss of about $1.6k: a trend-style payoff, not a high-win-rate scalp.
* 88% of exits are stops or trailing stops; 12% are at the session close.

## Before running this with real money
* Out-of-sample proof is **one test year: 78 trades**. Paper-trade it, or trade 1–2 MNQ micro contracts, for at least 2–3 months. Compare live fills with the backtest's fill assumptions.
* The **ensemble** is the more robust version: run several passing parameter sets at once with one micro contract each. The trade-off is lower average R.
* The hourly data is a continuous series that switches contract months at expiry. A bot must trade the front contract and roll near expiry.
* **Bar-close decisions only:** the bot should act on 1-hour bar closes exactly as modelled, and should not move stops in the middle of a bar.
* This is research, not investment advice.

Code: `engine2.py` (engine with breakeven and trailing stops), `setups2.py`, `nr_family.py`, `grid2.py`, `regime_grid.py`, `select_final.py`, `final_nq_bot.py`. Trades: `results/final_nq_single_trades.csv`.
