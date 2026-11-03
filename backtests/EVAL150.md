# 150k evaluation: $9k target, soft $3k daily loss limit

## Assumptions (tell me if your firm differs)
* **Account:** $150,000; **profit target $9,000**; **soft $3,000 daily loss limit** (liquidate and stop for the day); **55% consistency**.
* **Max drawdown:** not stated. I used a **static $4,500** (typical for a 150k account) and also checked a **static $3,000**. Open losses count.
* **Instruments:** micro contracts (MNQ / MGC), each trade sized to the stated $ risk. 1-hour bars, NQ1! / GC1! / ES1!.
* **Tuning vs reporting:** an evaluation was started on every trading day. Tuning used starts Jun 2024 – Sep 2025; results are reported on untouched starts Dec 2025 – Oct 2026.

## New strategies added
* **Overnight long (+ daily SMA-50 regime filter):** buy at 19:00 ET, exit at 09:00 ET. This is the documented "overnight drift": on NQ and GC most of the gains happen outside the day session.
* **Opening drive (+ regime):** the 09:00–10:00 bar closes in its top (bottom) 25% and above (below) the session VWAP → follow it to the close.
* **Engine:** v7 adds time-based exits.

## Why passing in 30 days is hard
$9,000 in ~21 trading days means about **$430 profit per day**. The real edges found are about 0.05–0.15R per trade. At any risk size the drawdown can survive, the *expected* monthly profit is about $1,500–3,500. Passing within 30 days therefore needs a lucky streak.
* **Cherry-picking failed again:** a greedy portfolio of the best 2024–25 streams passed **41% within 30 days on tuning data but only 3% on the untouched data** (its long-gold and ICT-FVG streams failed in 2026).
* **Single new strategies** (overnight, opening drive) are positive but small: e.g. NQ overnight about +$30–47 per trade at $500 risk. On their own they can't reach $9k in 30 days.

## What works: a fixed, diversified basket (no stream cherry-picking)
**Streams:**
1. NQ NR7 + EMA20/50 trend (long + short, confirm-close entry, 5-bar swing stop);
2. NQ overnight long + regime;
3. NQ opening drive + regime;
4. GC NR7 breakout (long + short);
5. GC overnight long + regime.

**Account rules:** each stream uses the same $ risk per trade; one position per market at a time; open losses across markets are summed (worst case). About **55 trades a month**; every stream has a positive average $/trade in both periods.

Only the shared risk / target / breakeven settings were tuned:

| Option | Settings | Window | Pass / fail (tuning) | **Pass / fail (untouched test)** | Median days to pass (test) |
|---|---|---|---|---|---|
| **SAFE** (best eventual pass) | **$375 risk per trade, no fixed target, breakeven at +1R** | 30 days | 8% / 16% | 5% / 4% | |
| | | 60 days | 30% / 17% | 25% / 4% | |
| | | 90 days | 48% / 17% | **60% / 4%** | |
| | | no limit | **83% / 17%** | **86% / 4%** | ~75 |
| **FAST** | **$500 risk per trade, TP $4,000, no breakeven** | 30 days | 22% / 35% | 32% / 13% | |
| | | 60 days | 44% / 43% | **71% / 15%** | |
| | | 90 days | 53% / 45% | 79% / 15% | |
| | | no limit | 55% / 45% | 79% / 15% | ~35 |
| Too slow | $250 risk | no limit | 99% / 1% | 57% / 0% (rest still running) | 107–153 |
| Too aggressive | $625 risk | no limit | 31–41% / 59–69% | 50–62% / 38–50% | 25–41 |

**With a $3,000 static drawdown instead of $4,500:** SAFE eventually passes 56% (tuning) / 81% (test); FAST passes 39% / 74%, with fail rates of 24–61%.

## Recommendation
* **A 70% pass rate within 30 days isn't achievable** with any strategy found. The best realistic 30-day pass rate is about 20–30%, and it comes with a 13–35% fail rate.
* **Best pass rate overall:** the **SAFE basket ($375 risk, breakeven at +1R, let winners run)**. About 83–86% eventually pass and only 4–17% fail, but it takes about 2–3 months. That works if your evaluation has no time limit or you're willing to pay for 2–3 months.
* **Fastest reasonable:** the **FAST basket ($500 risk, $4,000 target)**: median about 35 days and about 70% passed within 60 days on the untouched data. But in the 2024–25 tuning period it failed 45% of evaluations, so it's much riskier.
* **Per-trade risk is the biggest lever:** $375–500 is the sweet spot for a 150k account with a $4.5k drawdown. Above about $600 the fail rate climbs fast.

This is research, not investment advice. Prop-firm rules differ (trailing vs static drawdown, end-of-day vs intraday), so confirm yours.

Code: `engine7.py` (time exits), `setups_new.py` (overnight and opening-drive setups), `run_eval150.py` (single streams + greedy portfolio), `run_eval150_basket.py` (fixed basket). Results: `results/eval150_*.csv`.
