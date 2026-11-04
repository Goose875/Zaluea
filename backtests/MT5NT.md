# MetaTrader 5 and NinjaTrader 8 strategies, ported and backtested

## What was ported
Neither platform runs here, so each strategy's documented rules were coded into the backtest engine.
* **MT5, MQL5 Wizard signal modules:** all 20, using their official "market models" analysed on the last formed bar:
  * the MA family: SMA, EMA, AMA (adaptive), DEMA, TEMA, FRAMA, each with crossover, failed breakout and formed breakout;
  * MACD (reverse, signal cross, zero cross, divergence, double divergence);
  * RSI (reverse beyond 30/70, failed swing, divergence, double divergence);
  * Stochastic, CCI, Williams %R, DeMarker, Parabolic SAR, Envelopes, Awesome / Accelerator Oscillator, Bulls / Bears Power, RVI and TRIX.
* **MT5 sample EAs:** "Moving Average" (MA 12, shift 6) and "MACD Sample".
* **NinjaTrader 8 samples:** SampleMACrossOver (SMA 10/25) and SampleMultiTimeFrame (5/50 cross with higher-timeframe agreement).
* **Total:** 73 strategy triggers plus 20 random-entry controls.
* **Note:** MT5's "failed breakout" model can never fire for an EMA-type average, since an EMA can't rise while the bar closes below it. That's a property of the original module, not a porting error.

## How they were tested
* **Daily swing:** NQ / ES / GC, 2005 – Nov 2026.
  * Splits: TRAIN 2005–2014, VALID 2015–2019, **untouched TEST 2020–2026**.
  * Exits: stop, target, trail or time stop (5 / 10 / 20 days).
  * 432 management variants × direction × trend / volatility filters: **2,565,216 strategies**.
* **Hourly intraday:** NQ / ES / GC, Jun 2024 – Nov 2026, flat by the session end; 144 management variants × filters including time-of-day: **3,869,712 strategies**.
* **Pass rule:** avg ≥ +0.15R and PF ≥ 1.3 in both TRAIN and VALID. A family qualifies when more of its variants pass than for the best random-entry family.
* **Fill model:** same conservative fills as all earlier tests.

## Results
### Hourly: no edge (same as every earlier hourly search)
* Pass rates were about the same as random entries.
* The 7 families that beat the random ceiling went **–0.054R median in TEST, only 14% positive**.
* Use none of these as intraday bots.

### Daily swing: a real but modest edge
**Untouched 2020–2026 result of strategies that passed 2005–2019:**

| Market | MT5 modules, all directions | **MT5 modules, long only** | Random long entries that passed | Random entries that passed (all) |
|---|---|---|---|---|
| NQ | +0.104R (70% positive) | **+0.110R (72%)** | –0.013R (41%) | –0.105R (29%) |
| ES | +0.126R (76%) | **+0.151R (84%)** | –0.171R (n = 4) | –0.076R (46%) |
| GC | +0.212R (82%) | **+0.227R (85%)** | +0.064R (63%) | –0.086R (34%) |

* **51 families beat the random ceiling;** their TEST median was **+0.092R and 80% were positive.**
* **Part of this is the 2020–26 uptrend:** even random long entries made a little on GC and NQ. The MT5 trend signals still beat random long entries by about **+0.05 to +0.15R per trade**, and on gold they also worked in both directions.
* **Short-only versions lost money,** as they did everywhere in this project.

**Strongest daily candidates** (chosen on 2005–2019 only; TEST = 2020–2026 median across the family's passing variants):

| Market | Strategy | Direction / filters | Variants passing | TEST avg R | TEST variants positive | TEST trades |
|---|---|---|---|---|---|---|
| NQ | MT5 MACD 12/26/9: signal-line cross | long, daily EMA20 > EMA50 | 72% | +0.13 | 93% | ~42 |
| NQ | MT5 MACD: signal-line cross | long, daily trend + regime with | 66% | +0.15 | 97% | ~39 |
| GC | MT5 TEMA(12): failed breakout | long | 59% | +0.18 | 91% | ~59 |
| GC | MT5 TEMA(12): failed breakout | long + short, low volatility | 59% | +0.25 | 100% | ~45 |
| GC | MT5 Envelopes: cross outer line | long, low volatility | 65% | +0.12 | 71% | ~39 |
| ES | MT5 TEMA(12): crossover | long + short, daily trend with, regime against | 56% | +0.19 | 95% | ~24 |

Trade counts are low (about 4–10 a year per strategy), and holds last days to weeks.

## What it means for Keel
* **These are multi-day swing strategies.** They can't run on Topstep evaluations, which require being flat every day, nor on most prop evaluations. They suit a personal futures account, or a prop firm that allows overnight and weekend holds.
* **Low frequency:** a handful of trades a year each. Combining several (NQ MACD, GC TEMA, ES TEMA) gives more trades and diversification.
* **Intraday, the K system (NR breakouts and prior-day levels on NQ / GC) remains the only edge that held up.** MT5 / NinjaTrader indicator strategies on hourly bars did not.

This is research, not investment advice. Code: `mt5nt.py` (ports + search), `mt5nt_analyze.py` (verdict). Results: `results/mt5nt_*`.

---
# Part 2: every MQL5 CodeBase strategy family, plus rebuild checks

## What exists, and what can be tested
* **MQL5 Market:** about 10,000 paid, closed-source (compiled) EAs. There are no rules to read, and they run only inside MetaTrader on broker data. **They cannot be tested here.**
* **NinjaTrader Ecosystem:** paid, closed add-ons. The free user scripts sit behind a forum login. The built-in samples were tested in Part 1.
* **MQL5 CodeBase:** **1,713 free MT5 experts**, catalogued from the public listing pages. MQL5's robots.txt allows reading listings and description pages, but **not automated source viewing or downloading**, so none was fetched.

| Kind | Count |
|---|---|
| Strategies with their logic described | 1,061 |
| Strategies with the logic not described in the listing (source needed) | 305 |
| Grid / martingale / hedging | 201 (not tested: hidden blow-up risk, banned by most prop firms) |
| Utilities (panels, guards, trade managers) | 146 |

* **Coverage:** the 1,061 strategies use about 22 logic families. Most were already covered by earlier searches. The rest were ported in `mt5ext.py`:
  * Bill Williams Alligator / Fractals;
  * ZigZag-Fibonacci retracements;
  * 8 candlestick patterns;
  * OBV / MFI / volume-spike;
  * Hull / VIDYA / T3;
  * z-score reversion and linear-regression slope;
  * CodeBase combos: MACD + EMA200, RSI + EMA200, ADX + DI.
* **Not ported:** neural-net / ONNX EAs (models trained on forex data).
* **Results for the new families:**
  * **daily:** 1,242,000 variants; the 35 families that beat the random-entry ceiling made **+0.071R median in 2020–26, 83% positive**;
  * **hourly:** 1,866,528 variants; no edge.
* **Total MT5 / NinjaTrader-style variants tested: 9,673,456.**

## Rebuild check of the strongest daily swing candidates (`swing_robust.py`)
Each candidate was tested with one fixed set of trade settings (the most typical of its family, chosen on 2005–2019).

| Candidate | Avg R per trade 2005–26 | 2005–19 → 2020–26 | Profitable years | Periods ±20% | Same rule on other markets | Verdict |
|---|---|---|---|---|---|---|
| GC TEMA(12) failed breakout, long | +0.41 (138 trades) | +0.44 → +0.36 | 16/22 | +0.27 to +0.70 | ~0 | **rebuild** |
| NQ outside-bar reversal, long, daily trend | +0.37 (114) | +0.43 → +0.25 | 17/22 (worst year −1.4R) | n/a | ~0 | **rebuild** |
| GC VIDYA(14) cross, long, low volatility | +0.33 (110) | +0.41 → +0.15 | 15/22 | +0.27 to +0.41 | NQ +0.35 | **rebuild** |
| ES MACD zero cross, both, high volatility | +0.28 (97) | +0.36 → +0.10 | 15/22 | +0.06 to +0.22 | NQ +0.06 | optional |
| GC Fractal breakout, both, filtered | +0.20 (137) | +0.21 → +0.18 | 15/22 | stable | NQ +0.10 | optional |
| NQ three white soldiers, long | +0.49 (304) | +0.43 → +0.62 | 14/22 (worst year −14R) | n/a | positive everywhere (rides the uptrend) | too volatile |
| NQ MACD signal cross, long | +0.32 | +0.49 → −0.02 | 13/22 | | | faded |

**Important:** these hold positions for days to weeks (time stops of 5–20 days). They **cannot be traded on accounts that must be flat every day** (Topstep evaluations and most prop evaluations).

## Part 3 - Flat-daily versions (Topstep-compatible)
Same daily signals. Enter at the next session's open, exit at the stop or target, or else at that session's close. No overnight holds.
Each candidate's stop and target were picked on 2005-2019 only (12 versions each). Every result was then compared with 200 random-entry runs that used the same days, direction, trade count and stop/target (`swing_flat.py`, `swing_flat_control.py`).

| Candidate | Flat version | Trades | Avg R 2005-26 | Avg R 2020-26 | Beats random (all / 2020-26) | Swing version 2020-26 |
|---|---|---|---|---|---|---|
| GC Fractal breakout (both sides, low vol, with trend) | 0.5xATR stop, 3R target | 168 | **+0.31** | **+0.28** | 100% / 88% | +0.18 |
| ES MACD zero cross (high vol) | 1xATR stop, 3R target | 101 | +0.08 | +0.13 | 94% / 84% | +0.10 |
| GC TEMA failed breakout (long) | 0.5xATR stop, exit at close | 198 | +0.13 | +0.05 | 93% / 54% | +0.36 |
| GC VIDYA cross (long, low vol) | signal-bar stop, exit at close | 129 | +0.12 | +0.01 | 61% / 73% | +0.15 |
| NQ outside bar reversal (long) | signal-bar stop, 1R target | 134 | +0.02 | -0.02 | 100% / 94% (random is -0.21) | +0.25 |

Verdict: forcing a flat exit each day kills the edge in the three main swing winners, because their edge comes from holding for days.
Only the GC Fractal breakout holds up as a day trade, and it even improves (+0.28R since 2020, 18 of 22 years positive).
It trades only about 8 times a year, and its 2020-26 result is not separable from luck on its own (88th percentile against random).
