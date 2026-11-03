# ICT concepts and "key-level" (Rocket Scooter-style) strategies

## About Rocket Scooter
Rocket Scooter's levels (e.g. "dark pool" levels) are **proprietary, paid data**. Their public site and the third-party "RS Levels Capture" tool only *display* the levels; neither explains how they are calculated. They **cannot be reproduced or backtested** without that data feed.

Instead, I tested the same *style* of trading, from key levels, using public, computable levels:
* prior-day high/low;
* overnight high/low;
* prior-session volume-profile value area (VAH/VAL) and point of control (POC);
* the Market Profile "80% rule".

If you have an export of actual Rocket Scooter levels, e.g. via RS Levels Capture, those can be plugged into the same engine.

## ICT concepts coded (all rules are explicit and use only information available at the signal bar)
**Building blocks**
* **Liquidity levels:** prior-day high/low, Asian range (20:00–24:00 ET), London range (02:00–05:00 ET), overnight high/low.
* **Swings:** 2-left/2-right pivot highs and lows, usable only after 2 confirming bars.
* **FVG (fair value gap):** a 3-candle gap whose middle candle has a body larger than 1 × ATR.
* **MSS (market structure shift):** a close through the last confirmed swing after a liquidity sweep.
* **Kill zones:** 02:00–05:00 and 09:30–11:30 ET.

**Setups tested**
* **ICT 2022 model:** liquidity sweep → MSS → entry on the displacement FVG at its 50% level ("CE"), at its edge, at the 70.5% OTE retracement, or at market.
* **Silver Bullet:** 10–11am, 3–4am and 2–3pm windows.
* **Judas swing** at the NY open.
* **Asian-range sweep** during the London session.
* **Turtle soup** at the prior-day high/low.
* **FVG trend continuation,** with and without the premium/discount filter.

**Trade management:** every setup ran with a liquidity target, 1/2/3/5R targets or no target; breakeven at +1R on or off; and no trail, a 1.5× ATR trail after +1R, or a 5-bar trail after +1R. That is 36 variants per setup.

**Data and validation**
* **1-hour, Jun 2024 – Nov 2026:** TRAIN / VALID / TEST split as in BOT_STRATEGY.md; selection never uses TEST.
* **5-minute, Aug 25 – Nov 2 2026 (about 50 full sessions):** IS to Oct 9, OOS Oct 10 – Nov 2.

**Bug found and fixed:** a first run showed the level-fade setup winning in every market with 100% of variants positive. The cause was a limit-order rule that silently skipped bars which traded through both the entry and the stop, i.e. it skipped instant losers. After the fix those bars fill and stop out, and the result disappeared. The earlier engines (NR7 etc.) never had this rule.

## Results
| Setup family | NQ | ES | GC |
|---|---|---|---|
| **ICT FVG trend continuation (kill zones, EMA50 trend)** | 1h: train +, **valid –**, test +0.13R. 5m: 100% of variants + IS, 86% + OOS | fails | **passes train + valid; test +0.10R. 5m: 100% + IS, 97% + OOS** |
| ICT FVG trend + premium/discount filter | too few trades on 1h; 5m: small + | fails | mixed |
| ICT sweep → MSS → FVG / OTE / market | only 2–28 trades (FVG) on 1h; market entry negative in TEST | negative | negative or too few |
| ICT Silver Bullet (3 windows) | 2–7 trades per window; inconclusive | negative | inconclusive |
| ICT Judas swing NY open | negative | negative | too few |
| ICT Asian-range sweep | 5m: + IS and OOS (n = 21 / 9); 1h: negative TRAIN | negative | negative |
| ICT turtle soup PDH/PDL | negative | negative | negative |
| Levels: 80% value-area rule | negative | negative | mildly + (did not pass) |
| Levels: PDH/ONH break & retest | negative | negative | negative |
| Levels: ON/PD high-low fade to POC | not robust after the fill fix | negative | negative |

### New validated gold strategy: ICT FVG trend (GC, 1-hour bars)
Management was chosen as the most common settings among the 16 passing variants, without looking at TEST.

**Rules**
* **Signal:** during a kill zone (02:00–05:00 or 09:00–12:00 ET bar starts on 1h), a **bullish FVG** forms while close > EMA50. A bearish FVG with close < EMA50 is the short.
* **Entry:** limit order at the FVG's near edge (the top of a bullish gap), valid for 6 bars.
* **Stop:** 1 tick beyond the low of FVG candle 1 (high for shorts).
* **Exit:**
  * no fixed target; the "liquidity target" setting is empty for this setup, so it behaves the same as no target;
  * breakeven at +1R;
  * a 1.5 × ATR trailing stop once the trade reaches +1R;
  * flat at the 17:00 ET session end.

| Period | Trades | Win % | Avg R | P&L (1 GC) | PF | Max DD |
|---|---|---|---|---|---|---|
| TRAIN | 70 | 51% | +0.18 | +$15,648 | 1.90 | –$4,429 |
| VALID | 43 | 51% | +0.27 | +$20,359 | 2.00 | –$3,515 |
| **TEST (Dec 25 – Nov 26)** | **74** | **49%** | **+0.10** | **+$17,850** | **1.20** | **–$32,920** |
| GCZ26 front window (Sep 14 – Nov 2) | 11 | 36% | –0.13 | –$1,446 | 0.81 | –$3,425 |
| 5m IS (Aug 25 – Oct 9) | 63 | 54% | +0.09 | +$7,790 | 1.29 | –$8,121 |
| 5m OOS (Oct 10 – Nov 2) | 34 | 53% | +0.07 | +$370 | 1.04 | –$2,658 |

**Note:** the TEST drawdown (–$33k) was far deeper than anything seen in TRAIN or VALID. That came from gold's volatile 2026. Size it with that in mind; 1 MGC (micro gold) is 1/10 of these numbers.

**Same rules on NQ (not validated):** TEST +$47.6k (PF 2.0), and +$14.1k while NQZ26 was front month. But it **lost in VALID** (–$16.5k), so the selection rule rejects it. Treat it as a candidate for paper trading only.

## Takeaways
* The ICT idea that held up is the **simplest one:** trend-direction FVG retracement entries during kill zones.
* The more elaborate named setups produced too few trades to validate, or lost after realistic fills:
  * sweep → MSS → FVG;
  * Silver Bullet;
  * Judas swing;
  * turtle soup.
* Public level strategies (value area, prior-day and overnight levels) did not show a robust edge. Proprietary Rocket Scooter levels remain untested.
* ES still has no robust strategy in any family tested.
* This is research, not investment advice.

Code: `ict.py` (concept definitions and setups), `engine3.py` (engine with per-signal entry/stop/target prices, breakeven and trailing), `run_ict.py`, `final_ict.py`.
