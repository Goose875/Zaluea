# 551 million strategies: ICT zones, HTF FVGs, liquidity and support/resistance re-marked at every open

## What was searched
**Levels re-marked at every Globex open (18:00 ET) and RTH open (09:00 ET), using completed bars only:**
* HTF swing support/resistance (daily and 4-hour pivots);
* liquidity pools: equal highs (buy-side) and equal lows (sell-side);
* **unfilled fair value gaps** on daily, 4-hour and 1-hour charts;
* 4-hour **order blocks** (last opposite candle before a >1.5 × ATR displacement);
* weekly, monthly, Globex and RTH opens;
* new-day and new-week opening gaps (NDOG / NWOG);
* 37 static levels: prior-day high/low/close/mid, pivots, Camarilla, prior week/month, Asia/London/overnight ranges, prior VAH/VAL/POC, initial balance and extensions, VWAP ±1σ/2σ, round numbers.

**Entry models:**
* **zones:** touch-and-fade (limit at the zone edge), rejection wick, liquidity sweep and reclaim, break, break-and-retest;
* **static levels:** break, reject, retest;
* plus the 37 earlier setups and **20 random-entry controls**.

**Search grid:**
* **Direction:** long + short, long only, short only.
* **Filters (1,080):** daily trend × hourly trend × volatility × time window (Asia / London / NY AM / NY PM / any) × premium/discount vs. the prior-week range × day of week.
* **Management:**
  * zones, 1,344 variants: entry (market / confirm / limit at 50% / **limit at the level**) × stop (signal bar / 1 ATR / 5-bar / **beyond the zone**) × target (1–5R / none / **next level**) × breakeven × trailing × time stop;
  * other triggers: 648 variants.
* **Two exit styles:** flat at session end, and **swing holds across sessions** (6–96 bars).
* **Data:** 1-hour continuous NQ1!, ES1!, GC1!, Jun 2024 – Nov 2026.
* **Total: 551,103,704 strategies** (206.1M session-flat + 345.0M swing-hold), on a compiled parallel engine at ~250,000 strategies per second.

**Selection (train + validation only):**
* TRAIN to Mar 2025, VALID to Nov 2025; TEST Dec 2025 – Nov 2026 is used only for the verdict.
* Pass = avg ≥ +0.15R and PF ≥ 1.3 in both TRAIN and VALID (≥ 50 / 30 trades).
* A family **qualifies** if more of its management variants pass than for the best random-entry family in the same market and run.

## Results
### 1. Luck test (pass rate; test-year result of the passers)
| Run / market | ZONE (ICT, FVG, OB, liquidity…) | LEVEL (pivots, VWAP, prior day…) | SETUP | RANDOM |
|---|---|---|---|---|
| flat NQ | 0.6%; –0.015R | 0.7%; +0.012R | **1.7%; +0.052R (66% +)** | 0.9%; –0.047R |
| hold NQ | 1.0%; –0.040R | 1.1%; +0.019R | **3.6%; +0.051R (64% +)** | 0.8%; –0.036R |
| flat ES | 0.2%; –0.122R | 0.3%; –0.030R | 0.4%; +0.008R | 0.1%; –0.086R |
| hold ES | 0.4%; –0.126R | 0.5%; –0.069R | 0.9%; –0.022R | 0.6%; –0.100R |
| flat GC | 0.7%; –0.038R | 0.9%; –0.041R | 0.9%; –0.046R | 0.6%; –0.171R |
| hold GC | 1.3%; –0.005R | 1.8%; –0.001R | 2.0%; +0.013R | 0.5%; –0.065R |

### 2. Families that qualified (beat the random-control ceiling), judged on the untouched test year
| Category | Families | Test-year median | Share positive |
|---|---|---|---|
| **ZONE** (ICT / FVG / OB / liquidity / opens / gaps) | 72 | **–0.073R** | **28%** |
| LEVEL (static S/R) | 127 | –0.050R | 34% |
| **SETUP** | 70 | **+0.034R** | **63%** |
| **NQ narrow-range families (NR4 / NR7 / NR10, NR4 + inside bar)** | 14 | **+0.004 to +0.173R** | **14 of 14 positive** |

**Stricter filters made things worse.** Requiring a family to qualify in both exit styles gave 52 families at –0.089R (34% positive); requiring 2+ markets gave 4 families at –0.051R. At this scale, extra filters mostly select luckier noise.

## Verdict
1. **The ICT-style zones (HTF FVGs, order blocks, liquidity pools, swing S/R, opens, gaps) do not beat random entries.** On NQ they pass less often than random entries, and the ones that pass lose in the test year (zone families: median –0.073R, 72% negative). The same holds for static support/resistance levels.
2. **The one winning model, found again at 551M scale, is the narrow-range breakout on NQ:** NR4 / NR7 / NR10, usually with the hourly EMA20/50 trend filter, often stronger in low volatility.
   * Every qualifying NQ NR family was profitable in the untouched test year.
   * It works both flat by session end and as a swing hold, e.g. **NR4 + trend + low volatility, swing hold: +0.16R per trade, 99% of its management variants profitable in TEST**.
   * This is the same edge behind the bot strategy (BOT_STRATEGY.md) and the 150k evaluation basket (EVAL150.md / MEGA.md).
3. **ES:** only a few Monday NR / inside-bar families held up; nothing else beat random. **GC:** level and zone strategies that looked great in 2024–25 failed in 2026.
4. **More searching won't find a better model in this data.** Going from 8M → 551M strategies produced many more lucky-looking backtests but no new robust edge. The next real improvement would need **different information**: longer intraday history (paid 1-minute data), order-flow or volume data, or other markets to validate on.

## How to use this
* **Trade:** NQ NR-family breakouts on 1-hour bars (NR7 + EMA trend as in BOT_STRATEGY.md, optionally NR4 + trend + low volatility). Run them inside the 5-stream basket with **drawdown-cushion sizing** (MEGA.md) for evaluation accounts.
* **Skip:** stand-alone ICT zone, FVG and level entries as the basis for a bot. In this data they are indistinguishable from random entries.

This is research, not investment advice.

Code: `levels2.py` (level marking at every open), `mega_engine2.py` (engine with limit-at-level, zone stop, next-level target, time stop and swing hold), `mega2.py` (search; `HOLD=1` for swing), `mega2_analyze.py`, `mega2_final.py`. Results: `results/mega2*_variants.csv.gz`, `results/mega2*_pass.csv.gz` (all passing strategies), `results/mega2_final_qualified.csv`, `results/mega2_final_console.txt`.
