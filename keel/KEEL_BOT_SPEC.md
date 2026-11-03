# Keel Bot: strategy implementation spec (7 strategies, NQ + GC, 1-hour bars)

Source: backtest research in `backtests/` (551M-strategy search, MEGA500.md). These 7 were chosen because they passed selection on 2024–25 data **and** stayed profitable on the untouched Dec 2025 – Nov 2026 test year. Because the final pick used that test year, **run them on paper or micros first** before trusting live size.

---
## 1. Data and session conventions (all strategies)
* **Bars:** 1-hour OHLCV, continuous front-month **NQ** and **GC**. Timestamps are the **bar open time** in **America/New_York**.
* **Globex session:** 18:00 → 17:00 ET. `session_key = date(bar_open_time + 6h)`. The last bar of a session is the 16:00 bar.
* **Decisions happen only at bar close.** A signal is evaluated when bar *i* closes; orders go to bar *i+1*. Stops, breakeven and trails are updated after each bar closes. No intrabar logic.
* **One open position per strategy.** After an exit, the next signal can be taken from the bar after the exit bar. Strategies are independent; see §6 for netting.
* **Roll:** trade the front month and roll before expiry (volume crossover). The backtest used Yahoo continuous `NQ=F` / `GC=F`, which is not back-adjusted.

## 2. Indicators (exact definitions)
| Name | Definition |
|---|---|
| `ATR14` | Wilder ATR on 1h bars: TR = max(H−L, \|H−Cprev\|, \|L−Cprev\|); ATR = RMA with alpha = 1/14 (ewm, adjust = False), continuous across sessions |
| `EMA20`, `EMA50` | EMA of 1h closes, span 20 / 50, adjust = False |
| Hourly trend | up if EMA20 > EMA50, down if EMA20 < EMA50 |
| Daily regime | daily bars (exchange daily close); **up = yesterday's daily close > SMA50 of daily closes** (value known before today's session) |
| Volatility | **high** if ATR14 > SMA100(ATR14) on 1h bars; **low** otherwise |
| Session VWAP | from the session's first bar: Σ(typical × volume) / Σ(volume), typical = (H+L+C)/3 |
| VWAP σ bands | σ = expanding standard deviation (min 3 bars, sample std) of (Close − VWAP) within the session; **+1σ band = VWAP + σ** |
| Prior-week midpoint | weeks by Globex session date (week ending Friday); mid = (prior week high + prior week low) / 2 |
| Prior-day POC / VAL | volume profile of the **previous Globex day's RTH bars** (1h bars starting **10:00–15:00 ET**). Typical price (H+L+C)/3 of each bar, weighted by volume, in **40 equal-width bins** between those bars' low and high. **POC** = midpoint of the highest-volume bin. **Value area:** start at the POC bin and add the larger neighbouring bin (up or down; ties go up) until ≥ 70% of volume. **VAL** = lower edge of the value area, VAH = upper edge. Use the previous day's values for the whole current session. |
| `NRk` bar | bar range (H−L) equals the minimum of the last k ranges (including itself) |

## 3. Filters
Filters apply to the **signal bar** *i*.
* **daily_regime = "with":** longs only if regime up, shorts only if down. **"against":** longs only if regime down, shorts only if up. **"none":** no filter.
* **hourly_trend = "with":** longs only if EMA20 > EMA50, shorts only if EMA20 < EMA50.
* **volatility:** "low" / "high" as defined in §2.
* **window:** applies to the signal bar's open hour.
  * `ASIA_18_02`: hour ≥ 18 or < 2.
  * `NY_AM_08_12`: 8 ≤ hour < 12.
* **premium_discount = "with":** longs only if Close < prior-week midpoint; shorts only if Close > prior-week midpoint.

## 4. Triggers
Evaluated at the close of bar *i*. X = the level's value on bar *i*; Xprev = its value on bar *i−1*.
* **level_break:**
  * long if `Close[i] > X and Close[i-1] <= Xprev`;
  * short if `Close[i] < X and Close[i-1] >= Xprev`.
* **level_retest:**
  * short if a short level_break happened on any of bars i−6 … i−1, and `High[i] >= X and Close[i] < X`;
  * long is the mirror image.
* **narrow_range_break (k):** bar *i−1* was an NRk bar, and
  * long if `Close[i] > High[i-1]`;
  * short if `Close[i] < Low[i-1]`.
  * **K3 also requires** EMA20 > EMA50 for longs and EMA20 < EMA50 for shorts.
* **Direction:** "long" or "short" means only that side is traded.

## 5. Trade management
**Entry**
* `market_next_open`: buy/sell at the open of bar *i+1*. That bar must be in the same Globex session; otherwise skip the signal.
* `confirm_close`: wait for bar *i+1* to close beyond the signal bar (long: Close[i+1] > High[i]; short: Close[i+1] < Low[i]). Then enter at the open of bar *i+2*, which must be in the same session. If bar *i+1* doesn't confirm, the signal is cancelled.

**Initial stop**, from the fill price E
* `signal_bar`: Low[i] − 1 tick (long) / High[i] + 1 tick (short).
* `atr_1x`: E ∓ ATR14[i].
* `swing_5bar`: lowest low of bars i−4 … i − 1 tick (long) / highest high + 1 tick (short).
* Risk R = |E − stop|. If R < 4 ticks, widen the stop to 4 ticks.

**Exits**
* **Target:** E ± target_R × R, rounded to the tick, sent as a resting limit order. `null` = no target.
* **Breakeven:** when the best price since entry (checked at bar close) reaches +breakeven_at_R × R, move the stop to E + 1 tick (long) / E − 1 tick (short).
* **Trail `atr_1_5x_after_1R`:** once the best price is ≥ +1R, set stop = max(stop, best − 1.5 × ATR14[current bar]) for longs (mirror for shorts), updated at every bar close. The stop never loosens.
* **Time stop:** exit at market at the close of the N-th bar held (the fill bar counts as bar 1).
* **flat_at_session_end = true:** exit at the close of the session's last bar (16:00 ET bar, 17:00 close). **false:** hold across sessions until stop, target, trail or time stop.

**Backtest fill assumptions**
* Market and stop fills include 1 tick of slippage.
* Targets filled only if price traded 1 tick through.
* If the stop and target were both touched in the same bar, the stop counted first.
* Commission: $2.50 per side per mini.

## 6. Position sizing (recommended)
* Size each trade by $ risk using micros: `qty = floor(risk_usd / (R_points × usd_per_point_micro))` (MNQ $2/pt, MGC $10/pt). Skip the trade if qty = 0.
* **Start at about $250–300 risk per trade.** For prop evaluations, use **drawdown-cushion sizing**: risk = 1/10 – 1/16 of (equity − drawdown floor), min $150, max $750 (see `backtests/MEGA.md`).
* **Several strategies can be in the same market at once** (e.g. K1, K2, K3 on NQ). Either run them as independent sub-positions and let the broker net them, **or** enforce one position per instrument using priority order K3 > K2 > K1 > K4 (NQ) and K6 > K7 > K5 (GC). Cap total open risk at about 3× per-trade risk.

## 7. Strategy table (see `keel_strategies.json` for the machine-readable version)
| ID | Market / side | Trigger | Filters | Entry | Stop | Target | BE | Trail | Time stop | Session end |
|---|---|---|---|---|---|---|---|---|---|---|
| **K1** | NQ, both | break of prior-day **POC** | daily regime **against**, hourly trend **with** | market | 1×ATR | **5R** | +1R | 1.5 ATR after 1R | **3 bars** | flat |
| **K2** | NQ, both | **NR4** break | hourly trend **with**, **low** vol | confirm-close | signal bar | **2R** | – | 1.5 ATR after 1R | 48 bars | **swing hold** |
| **K3** | NQ, both | **NR7** break + EMA20/50 direction | – | confirm-close | 1×ATR | none | – | 1.5 ATR after 1R | – | flat |
| **K4** | NQ, **short** | retest of session **VWAP +1σ** | **low** vol, **NY AM 08–12** | market | 1×ATR | **3R** | – | 1.5 ATR after 1R | 6 bars | flat |
| **K5** | GC, **short** | break of prior-day **VAL** | **high** vol, premium/discount **with** | market | signal bar | **2R** | +1R | – | 6 bars | flat |
| **K6** | GC, **long** | **NR7** break | **low** vol, **Asia 18–02** | market | 5-bar swing | **5R** | – | – | 96 bars | **swing hold** |
| **K7** | GC, both | break of prior-day **VAL** | daily regime **against**, **high** vol, premium/discount **with** | market | 1×ATR | **1.5R** | +1R | – | 48 bars | **swing hold** |

## 8. Backtest results (1 mini contract, after costs; use these to check your implementation)
| ID | TRAIN Jun 24 – Mar 25: trades / win / avg R / PF | VALID Apr – Nov 25 | **TEST Dec 25 – Nov 26** | TEST $ (1 mini) |
|---|---|---|---|---|
| K1 | 53 / 43% / +0.27 / 1.67 | 42 / 57% / +0.38 / 2.71 | **77 / 47% / +0.12 / 1.60** | +$33,482 |
| K2 | 61 / 46% / +0.27 / 1.44 | 50 / 60% / +0.32 / 1.54 | **68 / 49% / +0.23 / 1.72** | +$42,404 |
| K3 | 70 / 46% / +0.57 / 2.64 | 59 / 54% / +0.13 / 1.21 | **78 / 46% / +0.19 / 1.50** | +$32,996 |
| K4 | 56 / 41% / +0.32 / 1.46 | 44 / 41% / +0.22 / 1.37 | **56 / 38% / +0.13 / 1.20** | +$8,996 |
| K5 | 50 / 50% / +0.45 / 1.95 | 46 / 46% / +0.22 / 1.70 | **41 / 49% / +0.19 / 1.30** | +$14,035 |
| K6 | 50 / 28% / +0.54 / 1.42 | 42 / 24% / +0.36 / 1.66 | **45 / 31% / +0.47 / 1.76** | +$69,365 |
| K7 | 52 / 42% / +0.26 / 1.56 | 44 / 41% / +0.28 / 1.99 | **64 / 38% / +0.12 / 1.28** | +$20,793 |

**Notes**
* About **5–7 trades a month per strategy, ~40 a month combined.**
* Expect win rates of 25–60% and losing streaks of 6–10 trades.
* Avg R is per trade after costs.
* $ figures are for 1 standard contract (NQ $20/pt, GC $100/pt); divide by 10 for one micro.

**Validation check:** once implemented, replay Jun 2024 – Nov 2026 hourly data. Trade counts should come out within roughly ±10% of the table. Small differences in data vendor, VWAP or volume-profile rounding will shift them a little.

## 9. Risks and caveats
* **The edge is modest** (+0.1 to +0.5R per trade) and was measured on one data source over ~2.4 years. A live run can underperform.
* **Gold strategies (K5–K7) depend on gold's volatility regime.** They were weak or mixed in parts of the research.
* **Monitor rolling 30-trade avg R per strategy,** and pause a strategy whose rolling avg R drops below –0.2.
* **Not investment advice.** Paper-trade first.
