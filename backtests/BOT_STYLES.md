# Common trading-bot styles, backtested like Keel's K strategies

`bot_styles.py`. Hourly NQ / GC / ES, Jun 2024 – Nov 2026. A signal on a bar's close enters at the next open. When a bar
touches both the stop and the target, the stop is assumed to come first. Includes 1 tick of slippage and $5 commission per
mini round trip. Flat by 16:00 ET. Settings were picked on **Jun 2024 – Nov 2025** and judged on **Dec 2025 – Nov 2026**.
R = profit in multiples of the trade's risk.

| Style | Versions tried | Best version on the tuning period | Untouched test period | Verdict |
|---|---|---|---|---|
| Trend following | 68 | GC MACD 12/26/9 cross with the trend, stop 2 ATR: +0.178R, PF 1.58 | **+0.175R, PF 1.60, 132 trades** | **Real edge on gold only.** Positive in every half-year, longs and shorts. NQ and ES versions did not hold up. |
| Mean reversion (RSI, Bollinger) | 60 | NQ RSI(2) +0.043R | −0.046R | No edge. 7% of versions made money in both periods. |
| Grid trading | 18 | GC grid +0.023R | −0.004R | No edge. No version made money in both periods. |
| Machine learning (walk-forward gradient boosting, retrained monthly) | 6 | GC +0.030R | +0.013R | No usable edge. About break-even after costs, and it hurts a prop account (see below). |
| Scalping (1-minute bars) | 12 | 4 weeks of data only | 11 of 12 lost money | Costs and noise eat it. The one winner (GC 5-min opening range) had 33 trades, too few to mean anything. |
| Dollar-cost averaging | 3 | Buy 1 micro every Monday, hold | Made money because NQ, GC and ES rose | Buy-and-hold, not a trading edge. Can't be done on a prop account (flat every day). The position keeps growing: 116 micro NQ ≈ $6.6M of exposure by the end. |
| Arbitrage (spatial / triangular) | — | — | — | Not testable. It needs prices from several venues at the same instant. In CME futures it's done by co-located HFT firms within microseconds. |
| Market making | — | — | — | Not testable from bars. It needs the order book and queue position. Prop accounts and retail latency can't compete. |
| LLM-driven (Claude / ChatGPT via TradingView) | — | — | — | Can't be backtested honestly: the model has read about these exact prices. Keel already uses Claude as an entry check, not as the signal. |

## On a Topstep 50K Static Combine (same rules as Compare mixes)

| Account | Risk | Pass | Median days | Pass ≤ 20 days | First payout | Cash in first 60 funded days |
|---|---|---|---|---|---|---|
| Keel best mix (K8 + K9 + K1 + K3 + K4 + K6 + K7) | $350 | 92.4% | 24 | 37% | 94.5% | $2,253 |
| **+ GC MACD trend** | $350 | **93.1%** | **21** | **45%** | **96.8%** | **$5,034** |
| Keel best mix | $500 | 89.5% | 17 | 57% | 88.4% | $6,144 |
| + GC MACD trend | $500 | 85.0% | 14 | 62% | 90.5% | $4,744 |
| + mean reversion (best per market) | $500 | 82.7% | 15 | 52% | 85.4% | $3,588 |
| + grid (best per market) | $500 | 83.3% | 17 | 54% | 75.8% | $1,042 |
| + machine learning (best per market) | $500 | 45.9% | 12 | 35% | 82.1% | $2,258 |

GC MACD on its own passes almost always, but slowly (median 81–96 days). Added to Keel at $350, it improved every
measure. At $500 it passes faster but slightly less often. Every other style made the Keel mix worse.

Caveats: gold trended strongly through 2024–2026, which suits a trend system. GC MACD was the best of 68 trend versions
(chosen on the tuning period only). It competes with K5–K9 for the one GC position Keel allows at a time. Paper-trade it
before using it live.

## Is GC trend-following luck? (checked against the luck benchmark used in `strategy_search_hourly.js`)
* **Neighbouring versions agree.** 16 of the 24 GC trend versions made money in both periods: every MACD and Donchian
  55 / 20 variant. A lucky one-off would stand alone.
* **Coin-flip benchmark.** Same entry times, random direction, 200 runs: average +0.074R (the exit rule and gold's rise
  help any direction), 95th percentile +0.142R, best +0.193R. Real MACD: +0.177R, beaten by 0.5% of the coin flips.
* **t = 1.83 on the test period alone (132 trades), 2.91 over the whole period (357 trades).** That's a modest edge.
  About +0.10R per trade is beyond what random direction gives.
