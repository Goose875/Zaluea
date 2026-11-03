# Scalping research: NQZ26, ESZ26, GCZ26

Goal: design scalping strategies that keep a **win rate above 60%**. To count, a strategy must hold that rate on data it was **not** tuned on and still make money after costs.

## Protocol
* **Data:** Dec-2026 contracts only, regular trading hours (NQ/ES 9:30–16:00 ET, GC 8:20–13:30 ET).
  * 1-minute bars: Oct 6 – Nov 2, 2026 (20 sessions).
  * 5-minute bars: Sep 14 – Nov 2 for NQ/ES (36 sessions), Aug 27 – Nov 2 for GC (47 sessions).
* **Walk-forward:** parameters are chosen on the in-sample window (1m: to Oct 21; 5m: to Oct 14). The out-of-sample (OOS) window after it is used only to judge.
* **Pass:** OOS win rate > 60% **and** OOS net P&L > 0.
* **Fills (conservative):**
  * Entry: market at the next bar's open, plus 1 tick of slippage.
  * Target: limit order, filled only if price trades 1 tick *through* it.
  * Stop: filled with 1 tick of slippage.
  * If a bar touches both target and stop, the stop is assumed first.
  * Commission: $2.50 per side.

## Iterations
| Round | What was tried | Result |
|---|---|---|
| 1 | 9 original 1m setups (VWAP σ snap-back, trend RSI-2 pullback, liquidity sweep & reclaim, exhaustion fade …), tick-grid targets/stops tuned per market | 0 real passes. In-sample 61–62% win rates dropped to ~50% OOS and lost money. The only "pass" was GC exhaustion fade: 14 trades, +$10, which is noise. |
| 2 | +5 new setups (momentum burst, ORB-15 pullback, VWAP first touch on trend days, inside-bar break, double-stretch fade) + morning-only filters, on 1m **and** 5m | **2 passes:** 5m trend-pullback RSI(2) on **NQ** (69% OOS, +$2,510) and **GC** (86% OOS, +$2,160). Everything else failed OOS. |
| 3 | One universal rule-set with ATR-based exits, tuned once on all markets pooled | Failed. No universal set was both above 60% and profitable even in-sample: 77% winners with a 0.5-ATR target and 3-ATR stop still lost money. |
| 4 | Neighbour-parameter robustness of the round-2 winners; partial gap-fill scalp | NQ: 15/18 neighbouring settings profitable OOS, all ≥59% win. GC: 18/18 profitable OOS, all ≥60%. Gap-fill scalp: 60–88% win rates but lost money in-sample, so rejected. |

## Final strategy: 5-minute Trend-Pullback Scalper
* **Long setup (short is the mirror image):**
  * close above session VWAP;
  * EMA20 above EMA50;
  * EMA50 higher than 5 bars ago;
  * RSI(2) below 10.
* **Entry:** next bar's open.
* **Exit:** fixed target, fixed stop, or a 40-minute time stop; always flat at the session end.

| Market | Target / Stop | Sample | Trades | **Win rate** | Net P&L (1 lot) | Profit factor | Avg win / avg loss | Max DD |
|---|---|---|---|---|---|---|---|---|
| **NQZ26** | 27.25 pt ($545) / 81.75 pt ($1,635) | In-sample (23 sessions) | 35 | 66% | +$3,860 | 1.51 | $497 / –$631 | –$2,075 |
| | | **Out-of-sample (13 sessions)** | 29 | **69%** | **+$2,510** | 1.32 | $514 / –$863 | –$2,765 |
| **GCZ26** | $4.30 ($430) / $17.10 ($1,710) | In-sample (34 sessions) | 36 | 67% | +$4,260 | 1.84 | $388 / –$422 | –$1,510 |
| | | **Out-of-sample (13 sessions)** | 14 | **86%** | **+$2,160** | 2.14 | $338 / –$945 | –$1,725 |
| ESZ26 | 7.5 pt ($375) / 5 pt ($250) | In-sample | 42 | 62% | +$4,203 | 2.25 | $291 / –$210 | –$803 |
| | | Out-of-sample | 28 | **43% ✗** | –$90 | 0.98 | $317 / –$243 | –$1,503 |

**No ES scalper passed in any round.**

## Read before trading any of this
* **The 60% win rate comes from the payoff shape:** the stop is 3–4× the target. NQ needs about **59%** winners to break even after costs, and GC about **57%**. The edge is thin. A drop of a few points in win rate, or worse fills, erases it.
* **This is a short-hold intraday scalp, not a 1–2 tick scalp.** Average hold is up to 40 minutes, and about 35–45% of trades exit on the time stop rather than the target.
* **The samples are tiny.** OOS is 29 trades (NQ) and 14 trades (GC) over about 2½ weeks. A 69% win rate over 29 trades has a 95% confidence interval of roughly 50–85%. This is a candidate for forward/paper testing, not a proven edge.
* **Many setups were tried.** Roughly 300 setup/market/timeframe tests across 4 rounds. Some OOS passes are expected by chance; the neighbour-robustness check reduces that risk but does not remove it.
* **Bar data hides the tick-by-tick order of trades,** so queue position and intrabar ordering are approximated.
* This is research, not investment advice.

Code: `scalping.py` (rounds 1–2), `scalping_v3.py`, `scalping_v4.py`, `scalping_final.py`. Trade lists are in `results/final_trades_*.csv`.
