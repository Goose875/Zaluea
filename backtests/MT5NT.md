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
