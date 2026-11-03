# Mega search: about 8 million strategies, new levels, and dynamic sizing for the 150k evaluation

## Stage 1: about 8 million strategies (1h bars, NQ1! / ES1! / GC1!, Jun 2024 – Nov 2026)
* **Triggers (168):**
  * 37 price levels × 3 ways of trading each (**break**, **reject**, **retest**) = 111 level triggers. Levels:

    | Group | Levels |
    |---|---|
    | Prior day | high, low, close, mid |
    | Floor pivots | P, R1, S1, R2, S2 |
    | Camarilla | H3, L3, H4, L4 |
    | Prior week / month | high, low |
    | Asia, London, overnight | high, low |
    | Prior-day volume profile | VAH, VAL, POC |
    | Initial balance | high, low, ±1× extensions |
    | Session VWAP | VWAP, ±1σ and ±2σ bands |
    | Round numbers | nearest above / below |

  * 37 existing setups (NR family, ICT, overnight, opening drive, etc.).
  * **20 random-entry control triggers** to measure luck.
* **Variations:**
  * direction: long + short, long only, short only;
  * filters: daily SMA-50 regime (with / none / against), hourly EMA trend (with / none), volatility (low / high / any), time window (Asia / London / NY AM / NY PM / any);
  * management, 144 variants: entry (market / confirm-close / limit at 50%), stop (signal bar / 1×ATR / 5-bar swing), target (1R / 2R / 3R / none), breakeven at +1R, 1.5×ATR trail after +1R.
* **Total: 7,964,064 strategies simulated** with a compiled, parallel engine (≈107,000 per second).
* **Splits:** TRAIN to Mar 2025, VALID to Nov 2025, TEST Dec 2025 – Nov 2026 (never used to choose).

### Does the search beat luck?
**Pass filter:** TRAIN and VALID both need ≥ +0.15R per trade, PF ≥ 1.3, and ≥50 / 30 trades.

| Market | Real strategies passing | Random controls passing | Real passers in TEST | Random passers in TEST |
|---|---|---|---|---|
| **NQ** | 1.6% | 1.0% | **+0.045R median, 61% profitable** | –0.028R, 46% |
| GC | 2.0% | 1.2% | –0.036R, 43% | –0.099R, 37% |
| ES | 0.5% | 0.5% (no better than random) | –0.033R | –0.036R |

**Findings**
* **NQ has a real but small edge,** concentrated in the **narrow-range breakout family (NR4 / NR7 / NR10) with the hourly trend filter.** For example, NR4 + trend + low volatility was profitable in TEST for 96% of its management variants, at +0.12R per trade.
* **The new level strategies were mostly luck.** VWAP bands, pivots, Camarilla, IB, round numbers and value area produced many in-sample winners (mostly on gold), but they did not hold up in TEST. A few gold level trades (prior VAL reject; prior-day-high break in Asia) held up, but not reliably enough to pick in advance.
* **ES: nothing beats random entries,** consistent with every earlier round.
* **Converting to micros:** adding the best new families to the evaluation basket made it **worse**. Tight-stop gold level trades need many micros, so per-micro costs eat the edge, and extra NQ streams took the position slot from better trades.

## Stage 2: the real improvement is dynamic position sizing
Each trade risks a **fraction of the remaining drawdown cushion** (equity minus the $4.5k floor), between a minimum of $150 and a maximum, optionally tapering near the target. Applied to the v1 basket of 5 streams (EVAL150.md):
* NQ NR7 + trend;
* NQ overnight long + regime;
* NQ opening drive + regime;
* GC NR7 breakout;
* GC overnight long + regime.

Rules: 150k account, $9k target, soft $3k DLL, static $4.5k drawdown, 55% consistency. Tuned on 2024–25 evaluation starts, reported on untouched Dec 2025 – Oct 2026 starts.

| Goal | Sizing rule | Target / BE | Tuning: pass / fail | **Untouched test: pass / fail** | Median days |
|---|---|---|---|---|---|
| Pass within **30 days** | risk = **1/10 of cushion**, max $1,000 | TP $4,000, BE off | 18% / 4% | **31% / 0%** | 20 |
| Pass within **45 days** | risk = **1/12 of cushion**, max $750 | TP $4,000, BE off | 24% / 2% | **55% / 0%** | 27 |
| Pass within **60 days** | risk = **1/10 of cushion**, max $750 | TP $4,000, BE +1R | 33% / 3% | **51% / 0%** | 35 |
| **Never fail, no time limit** | risk = **1/16 of cushion**, max $750–1,000, taper 0.25 | no TP, BE +1R | **100% / 0%** | **76% passed, 0% failed** (rest still running at data end) | 80–89 |
| *Previous fixed size (EVAL150.md)* | $500 fixed | TP $4,000 | 55% / 45% | 79% / 15% | 35 |

* **Dynamic sizing cuts the fail rate from 15–45% to about 0–4%**, because bets shrink automatically as the account approaches the drawdown floor.
* **It does not make passing much faster.** Even very aggressive settings (up to 1/3 of the cushion, up to $3k risk) top out around **18–21% pass within 30 days** on tuning data, with 4–11% fails. The strategies' edge (+$40–75 per trade, ~55 trades a month) caps how fast $9k can be earned.
* **Practical meaning:** with near-zero failure risk you can keep the same evaluation running until it passes, as long as the firm doesn't impose a time limit (monthly fees aside).

## Bottom line ("the best we can get" from this data)
* **Strategies:** the 5-stream basket above. After ~8 million tests, nothing beat it robustly; the new levels were mostly noise.
* **Sizing:** risk 1/10 – 1/16 of the remaining drawdown cushion per trade (minimum $150, maximum $750–1,000).
* **Expected:**
  * within 30 days, about 20–30% pass;
  * within 45–60 days, about 25–55% pass;
  * with no time limit, about 76–100% pass;
  * in every case the fail rate is close to 0%.
* **70% within 30 days remains out of reach** with any strategy found in this data.

This is research, not investment advice. Results assume the stated rules (static drawdown, soft DLL); confirm your firm's terms. Dynamic sizing uses linear scaling of micro positions (integer rounding ignored).

Code: `mega_engine.py`, `mega.py` (search), `mega_analyze.py` (luck test and families), `mega_basket.py`, `engine8.py`, `propeval_dyn.py`, `eval150_dyn.py`, `eval150_dyn2.py`. Results: `results/mega_families.csv`, `results/mega_*_meta.csv`, `results/eval150_dyn*.csv` (raw `mega_*.npy` grids are git-ignored, about 190 MB each).
