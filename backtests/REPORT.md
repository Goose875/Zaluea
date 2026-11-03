# Trading-strategy simulations: NQZ2026, ESZ2026, GCZ2026

Run date: **2026-11-03** (last complete session used: 2026-11-02). Reproduce with `python3 fetch_data.py && python3 run_daily.py && python3 intraday.py (`make_report.py` prints the formatted tables).

## What was tested

These are **47 widely published strategies**, run in three layers:

| Layer | Data | Window | Strategies |
|---|---|---|---|
| A. Daily swing/trend | Continuous front-month NQ, ES, GC daily bars (Yahoo) | Jan 2010 → Nov 2 2026 (16.8 yrs), split 2010-19 / 2020-26 | 33 (golden cross, MACD, RSI, Connors RSI-2, Bollinger, Turtle/Donchian, Keltner, Supertrend, Ichimoku, PSAR, ADX, Heikin-Ashi, TS-momentum, IBS, turn-of-month, Larry Williams vol breakout, NR7, …) |
| B. Hourly | Continuous front-month 1h bars | Jun 12 2024 → Nov 2 2026 (~723 sessions) | 11 (overnight vs day session, EMA/MACD/Donchian, RSI/Bollinger fades, intraday momentum) |
| C. 5-minute on the **actual Dec-2026 contracts** | NQZ26, ESZ26, GCZ26 5m bars | While Z26 was front month: NQ/ES Sep 14 → Nov 2 (43 sessions); GC Aug 27 → Nov 2 (56 sessions) | 16 (opening-range breakouts 5/15/30m, ORB 2R, VWAP trend & 2σ reversion, gap fade, gap-and-go, EMA 9/21, RSI/Bollinger fades, first-30-min follow, last-30-min momentum, RTH vs overnight hold) |

**Assumptions**
* 1 contract. NQ = $20/pt, ES = $50/pt, GC = $100/pt. Costs: **1 tick slippage + $2.50 commission per side** on every fill.
* Daily signals are computed at the close and **filled at the next open**. Intraday signals are filled at the bar close. Stops fill at the stop price, or at the open if price gapped through it. When a bar hits both stop and target, the stop is assumed to have hit first.
* For day-trade stop entries (Williams, NR7), on days when both the long and short levels traded we book the *worse* of the two trades, because daily bars can't tell which came first. Without this the results looked unrealistically good (Sharpe 2–3).
* % metrics (CAGR, Sharpe, max DD) are on 1× notional with no leverage. $ figures are summed P&L for one contract with no compounding.

## Headline outcomes

### Daily (2010-2026)
1. **Very little beat simply holding the index futures.** NQ buy & hold had Sharpe 0.89 and CAGR 17.6%; ES had Sharpe 0.75 and CAGR 12.1%.
2. **Best risk-adjusted equity-index strategy: IBS mean reversion** (buy when the close is in the bottom 20% of the day's range, exit when it's in the top 20%). NQ: Sharpe 1.02, max DD -22% vs -35% for B&H, in the market only 34% of the time. ES: Sharpe 0.84. It was positive in both halves of the sample.
3. **Trend filters (price > 200-day SMA, golden cross, MACD above zero)** roughly matched buy & hold's Sharpe with clearly smaller drawdowns, but delivered less total return.
4. **Short-term dip buying** (Connors RSI-2, 3 down days, Bollinger reversion, RSI-14 < 30) worked on NQ and ES, with 70-90% win rates and low exposure. It was weak on gold.
5. **Classic breakout trend-following that also goes short** (Turtle 20/55, Keltner, Bollinger breakout, Supertrend, Parabolic SAR, ADX/DI, EMA 9/21, Heikin-Ashi, stochastic) **lost money or broke even on NQ and ES**: shorting a rising stock index is expensive. On gold these were slightly positive but still trailed buy & hold.
6. **Gold:** the best results came from the Larry Williams long-only volatility breakout (Sharpe 0.92, but only 0.09 since 2020), turn-of-month (0.68, consistent in both halves) and the vol-targeted golden cross (0.55), against buy & hold at 0.53.

### Hourly (Jun 2024 – Nov 2026)
* **The overnight effect is strong.** Holding only outside the day session captured essentially all of the gains:
  * NQ: +$182.5k vs +$177k buy & hold, with max DD -$63k vs -$110k.
  * ES: Sharpe 0.90 vs 0.84.
  * GC: +$186.5k vs +$160k.
  * The day session was roughly flat or negative on all three.
* **Gold trended; the stock indexes did not.**
  * GC 1h MACD L/S: +$318k, Sharpe 1.39.
  * GC Donchian breakout: +$254k, Sharpe 1.29.
  * GC EMA 9/21: +$259k, Sharpe 1.23.
  * The same EMA 9/21 rules **lost $107k on ES**.

### The Dec-2026 contracts themselves (5-minute, about 2 months)
* While Z26 was the front month, **buy & hold lost**: NQZ26 -$24k/lot, ESZ26 -$6k, GCZ26 -$75k (since Aug 27).
* **NQZ26:** 5m EMA 9/21 (RTH only) made **+$40.1k** (153 trades, PF 1.45) and gap-and-go made +$21.7k. Opening-range breakouts, gap fades and VWAP reversion all lost.
* **ESZ26:** nearly everything lost. The best was EMA 9/21 at +$3.8k; ORB 15/30m lost $13-16k.
* **GCZ26:** mean reversion won. Bollinger fade made **+$17.4k** (max DD only -$3.8k), RSI fade +$15.9k, and ORB-15m with a 2R target +$18.6k. VWAP trend-following lost $33.6k.
* **These are 43-56 sessions, too small to be statistically meaningful.** The same rule often flips sign between markets and timeframes; for example, EMA 9/21 is a winner on NQZ26 5m and a big loser on ES 1h.

## Caveats (read these)
* **Data source:** Yahoo Finance via yfinance. The continuous `=F` series is *not* back-adjusted, so roll gaps leak into returns (gold's contango flatters long gold by roughly 1-3%/yr).
* **Daily Open is the Globex reopen:** Yahoo's daily "Open" is the 6 pm ET reopen, so daily-bar "overnight vs intraday" tests are meaningless. That analysis is done on the 1h and 5m data instead.
* **Z26 contract history:** before mid-Sep 2026 (NQ/ES) and late Aug 2026 (GC), the Z26 contracts barely traded (mostly zero-volume flat bars). That is why the long-horizon tests use the continuous front month.
* **Selection bias:** testing 47 strategies × 3 markets guarantees some winners by luck. Favour results that hold across both sub-periods *and* more than one market (IBS/dip-buying on equity indexes, the overnight effect, trend-following on gold).
* **Not modelled:** margin, position sizing, taxes, and funding.
* This is research, not investment advice.

## Full results
### A. Daily: NQ (Nasdaq-100) continuous, 2010-2026

| strategy                                | CAGR   |   Sharpe | Max DD   |   Sharpe 10-19 |   Sharpe 20-26 | Last 12m   | Z26 period $/lot   |   Trades | Win %   |     PF |
|:----------------------------------------|:-------|---------:|:---------|---------------:|---------------:|:-----------|:-------------------|---------:|:--------|-------:|
| IBS <0.2 / >0.8 (long)                  | 14.8%  |     1.02 | -21.6%   |           0.84 |           1.24 | 6.3%       | $-2,998            |      583 | 69.0%   |   1.93 |
| Buy & Hold (benchmark)                  | 17.6%  |     0.89 | -35.3%   |           0.98 |           0.81 | 8.3%       | $-25,190           |        1 | 100.0%  | inf    |
| Golden Cross + 15% vol target           | 13.4%  |     0.88 | -23.0%   |           0.81 |           1    | 5.2%       | $-10,380           |     4058 | 55.0%   |   1.14 |
| MACD cross above zero (long)            | 8.0%   |     0.87 | -11.5%   |           1.03 |           0.74 | 6.3%       | $1,905             |      180 | 50.0%   |   1.97 |
| Price > SMA200 trend filter             | 12.8%  |     0.84 | -22.0%   |           0.72 |           1    | 3.9%       | $-25,190           |       65 | 26.2%   |   6.99 |
| Golden Cross SMA 50/200 (long)          | 14.1%  |     0.82 | -27.9%   |           0.77 |           0.9  | 8.3%       | $-25,190           |       13 | 84.6%   |  52.77 |
| L. Williams vol breakout 0.6 long (day) | 6.1%   |     0.77 | -13.3%   |           0.47 |           1.1  | 14.6%      | $-6,327            |     1944 | 52.9%   |   1.29 |
| Price > SMA50 trend filter              | 9.5%   |     0.74 | -18.7%   |           0.64 |           0.87 | -1.6%      | $-12,505           |      179 | 31.8%   |   2.28 |
| RSI14 30/70 (long)                      | 10.8%  |     0.74 | -29.7%   |           1.04 |           0.5  | 13.7%      | $0                 |       22 | 81.8%   |   7.85 |
| SMA 20/50 (long)                        | 8.1%   |     0.59 | -27.0%   |           0.58 |           0.61 | 1.4%       | $-25,190           |       57 | 50.9%   |   2.77 |
| Connors RSI(2) (long)                   | 4.5%   |     0.57 | -14.1%   |           0.45 |           0.73 | 8.6%       | $-11,615           |      182 | 70.9%   |   2.44 |
| SMA 50/200 long/short                   | 9.5%   |     0.54 | -33.8%   |           0.38 |           0.72 | 8.3%       | $-25,190           |       25 | 52.0%   |   4.32 |
| 3 down days, exit up close (long)       | 3.7%   |     0.53 | -19.3%   |           0.24 |           0.92 | 7.9%       | $-15,992           |      260 | 69.6%   |   1.92 |
| Bollinger 20/2 mean-reversion (long)    | 5.8%   |     0.48 | -21.2%   |           0.81 |           0.19 | 8.0%       | $-12,802           |       94 | 74.5%   |   2.12 |
| Turn of month (long)                    | 3.8%   |     0.46 | -12.7%   |           0.43 |           0.51 | 10.2%      | $-7,282            |      263 | 54.0%   |   1.35 |
| 12-month TS momentum L/S                | 6.4%   |     0.4  | -55.5%   |           0.61 |           0.2  | 8.3%       | $-25,190           |       85 | 32.9%   |   2.21 |
| Connors RSI(2) long/short               | 3.3%   |     0.39 | -18.8%   |           0.34 |           0.46 | -2.4%      | $-11,615           |      225 | 68.4%   |   1.57 |
| L. Williams vol breakout 0.6 L/S (day)  | 3.3%   |     0.32 | -34.2%   |          -0.04 |           0.71 | 4.7%       | $5,477             |     3508 | 49.2%   |   1.11 |
| RSI14 30/70 long/short                  | 2.4%   |     0.22 | -56.1%   |           0.48 |          -0.03 | 14.8%      | $25,190            |       44 | 65.9%   |   1.11 |
| Ichimoku cloud L/S                      | 1.5%   |     0.17 | -40.5%   |           0.03 |           0.32 | -14.0%     | $-32,018           |      211 | 36.0%   |   1.34 |
| MACD 12/26/9 long/short                 | -0.6%  |     0.08 | -49.8%   |           0.15 |           0    | 6.6%       | $62,680            |      413 | 37.0%   |   1.02 |
| 3-month TS momentum L/S                 | -1.7%  |     0.02 | -58.5%   |          -0.17 |           0.22 | -6.5%      | $-78,115           |      222 | 34.2%   |   1.29 |
| EMA 9/21 long/short                     | -2.0%  |     0    | -53.5%   |          -0.19 |           0.2  | -16.8%     | $-36,960           |      235 | 27.2%   |   1.15 |
| Supertrend 10/3 L/S                     | -2.6%  |    -0.02 | -59.3%   |          -0.22 |           0.18 | -2.9%      | $18,775            |      148 | 39.9%   |   1.21 |
| Turtle S2 Donchian 55/20 L/S            | -2.0%  |    -0.03 | -41.9%   |          -0.18 |           0.1  | -18.1%     | $-24,088           |       81 | 46.9%   |   1.08 |
| Turtle S1 Donchian 20/10 L/S            | -2.4%  |    -0.04 | -60.3%   |          -0.4  |           0.32 | -6.4%      | $7,252             |      172 | 37.2%   |   1.15 |
| NR7 breakout (day)                      | -0.8%  |    -0.08 | -20.7%   |          -0.02 |          -0.14 | 3.6%       | $335               |      804 | 46.9%   |   1.01 |
| Stochastic 14/3/3 cross L/S             | -4.2%  |    -0.1  | -72.1%   |          -0.21 |          -0    | 28.6%      | $-42,295           |      113 | 56.6%   |   0.88 |
| Heikin-Ashi color L/S                   | -6.0%  |    -0.19 | -75.1%   |           0.02 |          -0.42 | -10.1%     | $22,410            |     1292 | 34.9%   |   0.89 |
| Bollinger 20/2 breakout L/S             | -4.2%  |    -0.19 | -62.1%   |          -0.53 |           0.11 | -3.3%      | $238               |      188 | 35.6%   |   0.92 |
| Keltner 20/2xATR breakout L/S           | -4.4%  |    -0.25 | -58.6%   |          -0.42 |          -0.1  | -2.1%      | $9,462             |      141 | 39.7%   |   0.85 |
| Parabolic SAR L/S                       | -9.7%  |    -0.38 | -89.5%   |          -0.91 |           0.13 | 20.3%      | $40,170            |      580 | 36.4%   |   0.96 |
| ADX>25 + DI direction L/S               | -8.7%  |    -0.53 | -80.0%   |          -0.71 |          -0.4  | -10.9%     | $-1,328            |      194 | 35.1%   |   0.53 |

### A. Daily: ES (S&P 500) continuous, 2010-2026

| strategy                                | CAGR   |   Sharpe | Max DD   |   Sharpe 10-19 |   Sharpe 20-26 | Last 12m   | Z26 period $/lot   |   Trades | Win %   |     PF |
|:----------------------------------------|:-------|---------:|:---------|---------------:|---------------:|:-----------|:-------------------|---------:|:--------|-------:|
| IBS <0.2 / >0.8 (long)                  | 9.9%   |     0.84 | -20.6%   |           0.61 |           1.1  | 9.3%       | $6,882             |      594 | 68.9%   |   1.8  |
| Buy & Hold (benchmark)                  | 12.1%  |     0.75 | -34.4%   |           0.79 |           0.73 | 10.3%      | $-4,250            |        1 | 100.0%  | inf    |
| RSI14 30/70 (long)                      | 8.9%   |     0.7  | -29.2%   |           0.94 |           0.47 | 10.6%      | $0                 |       22 | 90.9%   |   7.4  |
| Price > SMA200 trend filter             | 7.4%   |     0.66 | -18.6%   |           0.57 |           0.79 | 7.1%       | $-4,250            |       69 | 29.0%   |   3.48 |
| MACD cross above zero (long)            | 4.6%   |     0.65 | -16.7%   |           0.58 |           0.74 | 7.0%       | $-2,092            |      205 | 42.9%   |   1.79 |
| 3 down days, exit up close (long)       | 4.1%   |     0.64 | -18.4%   |           0.26 |           1.12 | 12.4%      | $4,428             |      268 | 70.9%   |   2.55 |
| Golden Cross + 15% vol target           | 8.3%   |     0.59 | -24.8%   |           0.52 |           0.69 | 4.8%       | $-4,793            |     3518 | 53.5%   |   1.07 |
| Connors RSI(2) (long)                   | 3.7%   |     0.56 | -15.5%   |           0.34 |           0.92 | 10.3%      | $-2,922            |      178 | 75.3%   |   2.56 |
| Golden Cross SMA 50/200 (long)          | 7.2%   |     0.56 | -34.4%   |           0.57 |           0.56 | 10.3%      | $-4,250            |       11 | 72.7%   |  15.21 |
| Price > SMA50 trend filter              | 4.9%   |     0.51 | -22.5%   |           0.34 |           0.72 | -2.6%      | $-7,632            |      192 | 30.2%   |   1.7  |
| SMA 20/50 (long)                        | 5.3%   |     0.51 | -30.9%   |           0.44 |           0.59 | 7.6%       | $-4,250            |       60 | 53.3%   |   2.39 |
| Connors RSI(2) long/short               | 3.7%   |     0.5  | -15.7%   |           0.35 |           0.71 | 2.8%       | $-2,922            |      226 | 73.5%   |   2.01 |
| Bollinger 20/2 mean-reversion (long)    | 5.2%   |     0.48 | -31.4%   |           0.52 |           0.45 | 18.4%      | $9,055             |       96 | 72.9%   |   2.96 |
| Turn of month (long)                    | 2.5%   |     0.37 | -13.6%   |           0.27 |           0.5  | 9.8%       | $-2,145            |      263 | 54.8%   |   1.25 |
| RSI14 30/70 long/short                  | 4.6%   |     0.35 | -44.8%   |           0.63 |           0.04 | 9.4%       | $4,250             |       44 | 68.2%   |   1.28 |
| L. Williams vol breakout 0.6 long (day) | 2.0%   |     0.33 | -13.0%   |           0.33 |           0.34 | 1.2%       | $-14,660           |     1940 | 51.9%   |   1.05 |
| 12-month TS momentum L/S                | 2.1%   |     0.2  | -40.4%   |           0.14 |           0.28 | 10.3%      | $-4,250            |       89 | 30.3%   |   2.13 |
| SMA 50/200 long/short                   | 1.6%   |     0.18 | -41.5%   |           0.16 |           0.21 | 10.3%      | $-4,250            |       21 | 47.6%   |   2.35 |
| 3-month TS momentum L/S                 | -0.0%  |     0.08 | -43.4%   |          -0.09 |           0.28 | 2.0%       | $870               |      245 | 33.9%   |   1.44 |
| Ichimoku cloud L/S                      | -1.1%  |    -0    | -37.8%   |          -0.21 |           0.21 | -7.3%      | $-1,230            |      213 | 35.7%   |   1.16 |
| MACD 12/26/9 long/short                 | -2.0%  |    -0.03 | -46.1%   |          -0.15 |           0.1  | 5.4%       | $65                |      471 | 33.5%   |   1.02 |
| Turtle S2 Donchian 55/20 L/S            | -1.7%  |    -0.05 | -37.1%   |          -0.13 |           0.03 | -18.5%     | $-9,605            |       83 | 45.8%   |   0.98 |
| L. Williams vol breakout 0.6 L/S (day)  | -1.5%  |    -0.1  | -39.2%   |          -0.34 |           0.19 | -3.1%      | $-10,052           |     3546 | 48.4%   |   0.99 |
| Turtle S1 Donchian 20/10 L/S            | -2.9%  |    -0.11 | -47.9%   |          -0.23 |           0.02 | -18.2%     | $-10,335           |      174 | 36.2%   |   0.87 |
| Supertrend 10/3 L/S                     | -3.5%  |    -0.12 | -55.8%   |          -0.03 |          -0.22 | -21.4%     | $-26,440           |      148 | 38.5%   |   0.85 |
| EMA 9/21 long/short                     | -3.7%  |    -0.13 | -65.1%   |          -0.46 |           0.23 | -18.2%     | $-8,185            |      239 | 28.0%   |   0.94 |
| Heikin-Ashi color L/S                   | -5.4%  |    -0.24 | -63.2%   |          -0.12 |          -0.37 | -19.4%     | $-16,885           |     1300 | 36.8%   |   0.85 |
| Stochastic 14/3/3 cross L/S             | -5.9%  |    -0.26 | -69.9%   |          -0.26 |          -0.27 | -5.1%      | $4,250             |      105 | 56.2%   |   0.64 |
| NR7 breakout (day)                      | -1.6%  |    -0.26 | -30.0%   |          -0.33 |          -0.18 | -3.2%      | $1,412             |      838 | 47.4%   |   0.89 |
| Parabolic SAR L/S                       | -6.2%  |    -0.28 | -71.6%   |          -0.53 |          -0.02 | -14.4%     | $-5,420            |      586 | 35.3%   |   0.86 |
| Keltner 20/2xATR breakout L/S           | -4.3%  |    -0.29 | -58.7%   |          -0.39 |          -0.21 | -2.1%      | $0                 |      128 | 37.5%   |   0.64 |
| Bollinger 20/2 breakout L/S             | -5.9%  |    -0.38 | -67.4%   |          -0.46 |          -0.33 | -14.7%     | $-12,262           |      181 | 30.9%   |   0.58 |
| ADX>25 + DI direction L/S               | -6.7%  |    -0.49 | -71.1%   |          -0.66 |          -0.36 | 1.7%       | $0                 |      179 | 30.7%   |   0.5  |

### A. Daily: GC (Gold) continuous, 2010-2026

| strategy                                | CAGR   |   Sharpe | Max DD   |   Sharpe 10-19 |   Sharpe 20-26 | Last 12m   | Z26 period $/lot   |   Trades | Win %   |     PF |
|:----------------------------------------|:-------|---------:|:---------|---------------:|---------------:|:-----------|:-------------------|---------:|:--------|-------:|
| L. Williams vol breakout 0.6 long (day) | 6.2%   |     0.92 | -22.1%   |           1.59 |           0.09 | -3.9%      | $-5,352            |     2132 | 47.9%   |   1.24 |
| Turn of month (long)                    | 5.6%   |     0.68 | -20.4%   |           0.64 |           0.75 | 2.7%       | $-11,138           |      263 | 59.3%   |   1.64 |
| L. Williams vol breakout 0.6 L/S (day)  | 6.1%   |     0.63 | -41.0%   |           1.02 |           0.17 | 15.0%      | $8,068             |     3512 | 44.9%   |   1.13 |
| Golden Cross + 15% vol target           | 6.7%   |     0.55 | -41.7%   |           0.42 |           0.71 | -1.9%      | $0                 |     3627 | 52.6%   |   1.09 |
| Buy & Hold (benchmark)                  | 8.0%   |     0.53 | -44.6%   |           0.28 |           0.83 | -0.4%      | $-43,930           |        1 | 100.0%  | inf    |
| SMA 20/50 (long)                        | 6.2%   |     0.52 | -29.7%   |           0.39 |           0.67 | 4.6%       | $-20,442           |       56 | 50.0%   |   2.71 |
| Price > SMA200 trend filter             | 6.3%   |     0.51 | -36.6%   |           0.36 |           0.66 | 5.5%       | $0                 |       77 | 29.9%   |   3.53 |
| Golden Cross SMA 50/200 (long)          | 6.0%   |     0.49 | -35.9%   |           0.33 |           0.66 | 1.5%       | $0                 |       14 | 50.0%   |   5.3  |
| MACD cross above zero (long)            | 3.7%   |     0.4  | -15.6%   |           0.35 |           0.47 | 5.3%       | $0                 |      169 | 40.8%   |   1.65 |
| Price > SMA50 trend filter              | 4.4%   |     0.4  | -44.0%   |           0.05 |           0.76 | 21.8%      | $-8,462            |      198 | 30.3%   |   1.94 |
| 3-month TS momentum L/S                 | 5.5%   |     0.4  | -42.3%   |           0.26 |           0.56 | -9.3%      | $-33,905           |      277 | 38.6%   |   1.52 |
| RSI14 30/70 (long)                      | 2.8%   |     0.35 | -28.5%   |           0.29 |           0.44 | 3.3%       | $7,948             |       20 | 90.0%   |   5.7  |
| 3 down days, exit up close (long)       | 1.5%   |     0.31 | -10.5%   |           0.35 |           0.26 | 8.2%       | $13,338            |      284 | 64.8%   |   1.4  |
| Bollinger 20/2 mean-reversion (long)    | 2.1%   |     0.28 | -15.4%   |           0.32 |           0.24 | -8.0%      | $-18,062           |       83 | 73.5%   |   1.62 |
| IBS <0.2 / >0.8 (long)                  | 2.6%   |     0.28 | -33.3%   |           0.14 |           0.46 | 3.7%       | $-21,237           |      542 | 61.4%   |   1.25 |
| 12-month TS momentum L/S                | 3.3%   |     0.27 | -52.8%   |           0.17 |           0.4  | -2.6%      | $-52,015           |      136 | 29.4%   |   1.56 |
| SMA 50/200 long/short                   | 3.2%   |     0.27 | -51.9%   |           0.2  |           0.35 | 1.7%       | $43,930            |       28 | 32.1%   |   2.26 |
| Connors RSI(2) (long)                   | 1.4%   |     0.26 | -17.2%   |           0.28 |           0.25 | -1.3%      | $0                 |      139 | 64.0%   |   1.38 |
| EMA 9/21 long/short                     | 2.7%   |     0.24 | -39.9%   |           0.07 |           0.45 | 30.2%      | $30,185            |      229 | 33.6%   |   1.56 |
| Supertrend 10/3 L/S                     | 1.9%   |     0.19 | -46.2%   |           0.36 |          -0    | 21.4%      | $30,185            |      194 | 40.7%   |   1.29 |
| Ichimoku cloud L/S                      | 1.7%   |     0.19 | -40.0%   |           0.01 |           0.4  | 17.4%      | $14,635            |      248 | 34.7%   |   1.42 |
| Parabolic SAR L/S                       | 1.2%   |     0.16 | -47.8%   |           0.14 |           0.18 | -6.4%      | $25,380            |      430 | 42.3%   |   1.17 |
| Stochastic 14/3/3 cross L/S             | 0.6%   |     0.12 | -41.6%   |          -0.12 |           0.41 | -4.3%      | $-22,455           |      157 | 58.6%   |   1.08 |
| Turtle S1 Donchian 20/10 L/S            | 0.2%   |     0.09 | -41.3%   |           0.15 |           0.03 | 30.7%      | $-7,855            |      179 | 34.1%   |   1.22 |
| Bollinger 20/2 breakout L/S             | -0.1%  |     0.06 | -39.9%   |          -0.05 |           0.18 | 15.4%      | $18,038            |      182 | 34.1%   |   1.17 |
| Connors RSI(2) long/short               | 0.1%   |     0.05 | -28.2%   |          -0.05 |           0.18 | 2.8%       | $0                 |      206 | 63.1%   |   1.18 |
| Keltner 20/2xATR breakout L/S           | -0.1%  |     0.05 | -29.5%   |           0.01 |           0.09 | -0.1%      | $4,247             |      166 | 33.7%   |   1.09 |
| Turtle S2 Donchian 55/20 L/S            | -0.9%  |     0.01 | -57.1%   |          -0.16 |           0.21 | -2.3%      | $-18,645           |       83 | 37.3%   |   1.16 |
| MACD 12/26/9 long/short                 | -2.8%  |    -0.08 | -50.8%   |          -0.04 |          -0.12 | -5.1%      | $15,320            |      445 | 34.6%   |   0.97 |
| Heikin-Ashi color L/S                   | -2.8%  |    -0.08 | -49.9%   |          -0.08 |          -0.08 | -6.9%      | $3,690             |     1430 | 38.1%   |   0.99 |
| RSI14 30/70 long/short                  | -4.1%  |    -0.16 | -71.0%   |           0.07 |          -0.43 | 1.7%       | $59,825            |       39 | 76.9%   |   0.72 |
| ADX>25 + DI direction L/S               | -4.8%  |    -0.34 | -62.0%   |          -0.42 |          -0.27 | -4.1%      | $6,307             |      203 | 31.5%   |   0.72 |
| NR7 breakout (day)                      | -2.2%  |    -0.39 | -33.1%   |          -0.44 |          -0.33 | -3.2%      | $-27,615           |     1179 | 34.4%   |   0.84 |

*Daily table columns: `Z26 period $/lot` = P&L for 1 lot from Sep 14 to Nov 2 2026, the window when the Dec-26 contract was front month. Trades, Win % and PF cover the whole 2005-2026 sample including indicator warm-up.*

### B. 1h continuous Jun2024-Nov2026: NQ (723 sessions)

| strategy                                      | P&L $/1 lot   | Max DD $   |   Sharpe |   Trades | Win %   |     PF | Avg trade $   |
|:----------------------------------------------|:--------------|:-----------|---------:|---------:|:--------|-------:|:--------------|
| Overnight session only (long)                 | $182,502      | $-62,730   |     1.1  |      604 | 56.8%   |   1.23 | $310          |
| Buy & hold 24h (benchmark)                    | $177,428      | $-109,765  |     0.73 |        1 | 100.0%  | inf    | $177,435      |
| MACD 12/26/9 L/S (1h)                         | $130,298      | $-180,125  |     0.63 |     1030 | 36.4%   |   1.08 | $127          |
| EMA 9/21 L/S (1h)                             | $122,288      | $-131,940  |     0.39 |      582 | 31.1%   |   1.12 | $210          |
| RSI(2) pullback in uptrend (1h)               | $40,405       | $-23,588   |     0.8  |      343 | 64.4%   |   1.21 | $125          |
| Bollinger 20/2 fade L/S (1h)                  | $37,788       | $-84,130   |     0.16 |      531 | 64.2%   |   1.05 | $78           |
| Intraday momentum: last hour follows 1st hour | $5,635        | $-43,605   |    -0.01 |      586 | 52.2%   |   1.03 | $17           |
| EMA 20/50 L/S (1h)                            | $3,148        | $-208,720  |    -0.1  |      244 | 31.1%   |   1    | $13           |
| Donchian 20/10 breakout L/S (1h)              | $-2,262       | $-163,780  |    -0.06 |      430 | 38.6%   |   1    | $0            |
| Day session only (long)                       | $-23,165      | $-111,235  |    -0.01 |      603 | 53.6%   |   0.98 | $-31          |
| RSI14 30/70 fade L/S (1h)                     | $-57,098      | $-83,282   |    -0.35 |      229 | 62.0%   |   0.88 | $-242         |

### C. 5m NQZ26 contract: NQ (43 sessions)

| strategy                                              | P&L $/1 lot   | Max DD $   |   Sharpe |   Trades | Win %   |   PF | Avg trade $   |
|:------------------------------------------------------|:--------------|:-----------|---------:|---------:|:--------|-----:|:--------------|
| EMA 9/21 L/S RTH (5m)                                 | $40,140       | $-13,630   |     3.73 |      153 | 41.2%   | 1.45 | $264          |
| Gap-and-go (follow gap, exit EOD)                     | $21,720       | $-13,800   |     1.98 |       31 | 41.9%   | 1.47 | $708          |
| VWAP trend: long above / short below (5m)             | $13,570       | $-30,575   |     1.33 |      199 | 24.6%   | 1.15 | $70           |
| First 30m direction -> hold to close                  | $12,160       | $-18,135   |     1.04 |       36 | 44.4%   | 1.23 | $345          |
| RSI14 30/70 fade, exit 50 (5m)                        | $915          | $-9,680    |     0.02 |       44 | 63.6%   | 1.03 | $28           |
| Opening Range Breakout 15m, stop=other side, exit EOD | $-2,390       | $-22,465   |    -0.3  |       36 | 41.7%   | 0.95 | $-59          |
| Opening Range Breakout 5m, stop=other side, exit EOD  | $-4,130       | $-20,705   |    -0.48 |       36 | 30.6%   | 0.92 | $-107         |
| ORB 15m, 2R target, stop=other side                   | $-4,305       | $-23,320   |    -0.61 |       36 | 44.4%   | 0.91 | $-112         |
| Bollinger 20/2 fade, exit mid (5m)                    | $-7,480       | $-13,025   |    -1.51 |       85 | 61.2%   | 0.87 | $-80          |
| RTH session hold (long)                               | $-7,715       | $-28,265   |    -0.62 |       36 | 47.2%   | 0.9  | $-207         |
| Last 30m follows open->10:00 return (Gao)             | $-10,335      | $-14,775   |    -3.7  |       35 | 31.4%   | 0.48 | $-288         |
| Opening Range Breakout 30m, stop=other side, exit EOD | $-11,175      | $-26,890   |    -1.06 |       34 | 50.0%   | 0.81 | $-321         |
| Gap fade to prior close (stop 1x gap)                 | $-14,965      | $-23,535   |    -1.78 |       31 | 45.2%   | 0.73 | $-475         |
| VWAP 2-sigma reversion to VWAP (5m)                   | $-15,215      | $-17,805   |    -1.96 |       70 | 61.4%   | 0.78 | $-210         |
| Overnight hold, RTH close->open (long)                | $-17,318      | $-46,060   |    -1.28 |       37 | 45.9%   | 0.79 | $-461         |
| Buy & hold (benchmark)                                | $-23,952      | $-67,035   |    -1.18 |        1 | 0.0%    | 0    | $-23,945      |

### B. 1h continuous Jun2024-Nov2026: ES (723 sessions)

| strategy                                      | P&L $/1 lot   | Max DD $   |   Sharpe |   Trades | Win %   |     PF | Avg trade $   |
|:----------------------------------------------|:--------------|:-----------|---------:|---------:|:--------|-------:|:--------------|
| Buy & hold 24h (benchmark)                    | $108,872      | $-61,450   |     0.84 |        1 | 100.0%  | inf    | $108,888      |
| Overnight session only (long)                 | $74,982       | $-42,068   |     0.9  |      604 | 57.1%   |   1.22 | $139          |
| Bollinger 20/2 fade L/S (1h)                  | $18,448       | $-38,038   |     0.15 |      536 | 63.6%   |   1.07 | $48           |
| RSI14 30/70 fade L/S (1h)                     | $7,288        | $-61,175   |     0.03 |      228 | 61.8%   |   1.05 | $47           |
| RSI(2) pullback in uptrend (1h)               | $-1,105       | $-19,245   |     0.06 |      361 | 65.4%   |   1.04 | $12           |
| Day session only (long)                       | $-2,290       | $-53,728   |     0.06 |      603 | 51.9%   |   1.01 | $11           |
| Intraday momentum: last hour follows 1st hour | $-16,208      | $-25,895   |    -0.45 |      584 | 52.4%   |   0.96 | $-13          |
| Donchian 20/10 breakout L/S (1h)              | $-35,540      | $-75,412   |    -0.33 |      431 | 38.5%   |   0.93 | $-72          |
| EMA 20/50 L/S (1h)                            | $-49,390      | $-97,700   |    -0.4  |      266 | 27.8%   |   0.87 | $-186         |
| MACD 12/26/9 L/S (1h)                         | $-77,215      | $-160,815  |    -0.48 |     1066 | 35.2%   |   0.91 | $-72          |
| EMA 9/21 L/S (1h)                             | $-106,885     | $-134,410  |    -0.77 |      590 | 29.7%   |   0.83 | $-181         |

### C. 5m ESZ26 contract: ES (43 sessions)

| strategy                                              | P&L $/1 lot   | Max DD $   |   Sharpe |   Trades | Win %   |   PF | Avg trade $   |
|:------------------------------------------------------|:--------------|:-----------|---------:|---------:|:--------|-----:|:--------------|
| EMA 9/21 L/S RTH (5m)                                 | $3,828        | $-13,820   |     0.74 |      147 | 37.4%   | 1.1  | $30           |
| VWAP 2-sigma reversion to VWAP (5m)                   | $2,202        | $-7,202    |     0.61 |       77 | 70.1%   | 1.14 | $43           |
| VWAP trend: long above / short below (5m)             | $640          | $-9,208    |     0.16 |      197 | 24.4%   | 1.03 | $6            |
| Overnight hold, RTH close->open (long)                | $-758         | $-12,290   |    -0.12 |       37 | 54.1%   | 0.99 | $-5           |
| ORB 15m, 2R target, stop=other side                   | $-3,968       | $-8,442    |    -1.41 |       36 | 44.4%   | 0.83 | $-95          |
| RSI14 30/70 fade, exit 50 (5m)                        | $-4,640       | $-7,065    |    -1.56 |       38 | 65.8%   | 0.78 | $-107         |
| Bollinger 20/2 fade, exit mid (5m)                    | $-4,942       | $-7,398    |    -1.46 |       96 | 63.5%   | 0.88 | $-37          |
| Gap-and-go (follow gap, exit EOD)                     | $-5,970       | $-9,030    |    -1.85 |       24 | 33.3%   | 0.69 | $-234         |
| Last 30m follows open->10:00 return (Gao)             | $-6,250       | $-7,490    |    -4.25 |       35 | 37.1%   | 0.44 | $-164         |
| Buy & hold (benchmark)                                | $-6,378       | $-16,050   |    -0.93 |        1 | 0.0%    | 0    | $-6,362       |
| First 30m direction -> hold to close                  | $-6,392       | $-9,118    |    -1.5  |       36 | 44.4%   | 0.78 | $-163         |
| RTH session hold (long)                               | $-7,780       | $-8,725    |    -1.7  |       36 | 47.2%   | 0.75 | $-201         |
| Opening Range Breakout 5m, stop=other side, exit EOD  | $-8,980       | $-12,940   |    -2.47 |       36 | 30.6%   | 0.63 | $-234         |
| Gap fade to prior close (stop 1x gap)                 | $-10,708      | $-10,708   |    -3.58 |       24 | 45.8%   | 0.48 | $-431         |
| Opening Range Breakout 15m, stop=other side, exit EOD | $-13,118      | $-15,278   |    -3.43 |       36 | 36.1%   | 0.54 | $-349         |
| Opening Range Breakout 30m, stop=other side, exit EOD | $-15,730      | $-15,465   |    -3.9  |       36 | 36.1%   | 0.5  | $-422         |

### B. 1h continuous Jun2024-Nov2026: GC (724 sessions)

| strategy                                      | P&L $/1 lot   | Max DD $   |   Sharpe |   Trades | Win %   |     PF | Avg trade $   |
|:----------------------------------------------|:--------------|:-----------|---------:|---------:|:--------|-------:|:--------------|
| MACD 12/26/9 L/S (1h)                         | $317,768      | $-74,025   |     1.39 |     1037 | 35.7%   |   1.25 | $306          |
| EMA 9/21 L/S (1h)                             | $258,547      | $-72,440   |     1.23 |      585 | 32.3%   |   1.31 | $442          |
| Donchian 20/10 breakout L/S (1h)              | $253,595      | $-54,505   |     1.29 |      355 | 41.4%   |   1.47 | $724          |
| Overnight session only (long)                 | $186,513      | $-96,635   |     1.24 |      604 | 57.5%   |   1.24 | $321          |
| EMA 20/50 L/S (1h)                            | $165,403      | $-134,020  |     0.76 |      254 | 33.1%   |   1.31 | $651          |
| Buy & hold 24h (benchmark)                    | $160,338      | $-169,090  |     0.97 |        1 | 100.0%  | inf    | $160,350      |
| RSI(2) pullback in uptrend (1h)               | $15,970       | $-32,152   |     0.28 |      330 | 65.5%   |   1.1  | $61           |
| Intraday momentum: last hour follows 1st hour | $14,529       | $-15,425   |     0.22 |      600 | 49.8%   |   1.12 | $37           |
| Day session only (long)                       | $-56,326      | $-99,650   |    -0.26 |      603 | 49.8%   |   0.93 | $-81          |
| RSI14 30/70 fade L/S (1h)                     | $-71,950      | $-166,480  |    -0.62 |      214 | 54.7%   |   0.83 | $-324         |
| Bollinger 20/2 fade L/S (1h)                  | $-123,669     | $-155,647  |    -0.83 |      488 | 62.7%   |   0.85 | $-241         |

### C. 5m GCZ26 contract: GC (56 sessions)

| strategy                                              | P&L $/1 lot   | Max DD $   |   Sharpe |   Trades | Win %   |   PF | Avg trade $   |
|:------------------------------------------------------|:--------------|:-----------|---------:|---------:|:--------|-----:|:--------------|
| ORB 15m, 2R target, stop=other side                   | $18,640       | $-8,620    |     2.95 |       46 | 60.9%   | 1.63 | $418          |
| Bollinger 20/2 fade, exit mid (5m)                    | $17,430       | $-3,810    |     3.38 |       90 | 67.8%   | 1.58 | $206          |
| RSI14 30/70 fade, exit 50 (5m)                        | $15,915       | $-8,500    |     2.81 |       45 | 71.1%   | 1.75 | $366          |
| VWAP 2-sigma reversion to VWAP (5m)                   | $12,515       | $-9,095    |     1.66 |       91 | 67.0%   | 1.32 | $150          |
| Opening Range Breakout 15m, stop=other side, exit EOD | $4,730        | $-12,925   |     0.83 |       46 | 50.0%   | 1.15 | $115          |
| Gap-and-go (follow gap, exit EOD)                     | $3,675        | $-23,250   |     0.52 |       41 | 41.5%   | 1.1  | $102          |
| Last 30m follows open->10:00 return (Gao)             | $3,375        | $-1,655    |     2.5  |       45 | 53.3%   | 1.71 | $87           |
| Opening Range Breakout 30m, stop=other side, exit EOD | $-3,500       | $-12,360   |    -0.4  |       44 | 45.5%   | 0.91 | $-67          |
| Opening Range Breakout 5m, stop=other side, exit EOD  | $-5,015       | $-17,580   |    -0.78 |       47 | 29.8%   | 0.87 | $-94          |
| First 30m direction -> hold to close                  | $-5,285       | $-34,635   |    -0.58 |       47 | 51.1%   | 0.91 | $-100         |
| EMA 9/21 L/S RTH (5m)                                 | $-11,750      | $-38,140   |    -1.09 |      178 | 30.3%   | 0.89 | $-63          |
| Gap fade to prior close (stop 1x gap)                 | $-12,445      | $-18,110   |    -1.65 |       41 | 53.7%   | 0.75 | $-291         |
| VWAP trend: long above / short below (5m)             | $-33,595      | $-49,840   |    -3.15 |      305 | 21.6%   | 0.73 | $-108         |
| Overnight hold, RTH close->open (long)                | $-37,367      | $-37,555   |    -2.65 |       48 | 43.8%   | 0.6  | $-766         |
| RTH session hold (long)                               | $-39,805      | $-47,595   |    -3.82 |       47 | 36.2%   | 0.49 | $-834         |
| Buy & hold (benchmark)                                | $-74,823      | $-73,250   |    -4.34 |        1 | 0.0%    | 0    | $-74,810      |
