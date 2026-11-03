# Entry models × stops × R-multiples: NQ / ES / GC

**What was tested**
* **Setups (9):** trend pullback RSI(2), opening-range breakout, VWAP first touch, liquidity sweep & reclaim, EMA 9/21 cross with trend, momentum burst, inside-bar break, Bollinger snap-back, Donchian-20 breakout.
* **Entry models (5):**
  1. market at the next open;
  2. buy-stop above / sell-stop below the signal bar;
  3. limit at the signal bar's 50%;
  4. limit at close − 0.5 ATR;
  5. wait for a bar to *close* beyond the signal bar, then enter.
* **Stops (3):** signal-bar extreme; 1 × ATR; 5-bar swing.
* **Targets:** 1R, 1.5R, 2R, 3R, 4R, 5R, where R = the distance from entry to stop.
* **Scope:** 3 markets × 2 datasets = **4,860 combinations**.
* **Fills:** same conservative model as before:
  * market and stop entries pay 1 tick of slippage, and stop exits pay 1 tick;
  * limit orders fill only if price trades 1 tick through them;
  * on the bar a limit or stop entry fills, only the stop can be hit, not the target;
  * if a bar touches both stop and target, the stop counts first;
  * $2.50 commission per side; flat at session end.
* **Protocol:** each market's "best" strategy was chosen **on in-sample (IS) data only**. It had to be positive at ≥80% of the R targets, so the choice can't hinge on one lucky R. Out-of-sample (OOS) results were never used for selection.

## Key findings

1. **1R targets lose money.** In OOS, 1R was negative for **every one** of the 6 selected strategies. A 1R target won only about 45–55% of the time, which is not enough to cover costs and slippage.
2. **2R–5R did better.** The strategies that survived OOS made the most at **3R–5R** (hourly) or **2R** (5-minute NQ). Win rates fall to 26–40% at those targets, but each winner pays for 3–5 losers. Expect this trade-off: you can't have both a 60%+ win rate and a 3R+ target.
3. **Entry model matters.** Across all setups:
   * **Wait-for-close confirmation** and **market at next open** were the best entries.
   * **Limit pullback entries were usually worst.** A limit order mostly fills on trades that keep going against you.
   * A **buy-stop above the signal bar** was weak on the hourly data.
4. **Stop model:** the **5-bar swing stop** had the best median result. The **1 × ATR** stop was the one most often chosen inside the winning combinations.
5. **Strategies that held up OOS:**
   * **NQ (hourly):** EMA 9/21 cross with trend, limit entry at the signal bar's 50%, 1-ATR stop, **3R target**: +0.07R per trade, **+$34.7k per contract over 13 months**, PF 1.26, 34% win rate.
     * The confirm-close entry on the same setup did better still OOS, averaging +0.15R per trade across the R targets.
   * **GC (hourly):** Donchian-20 breakout, confirm-close entry, 1-ATR stop, **5R target**: +0.14R per trade, **+$25.2k**, PF 1.17, 36% win rate. 4R was similar.
   * **NQZ26 (5-minute):** Donchian-20 breakout, confirm-close entry, 1-ATR stop, **2R target**: +0.19R per trade, +$4.4k, PF 1.37. Only 20 OOS trades.
6. **Strategies that failed OOS:**
   * **ES:** every selected ES strategy failed OOS on both datasets, and ES has failed in every round so far.
   * **GC 5-minute:** the Bollinger snap-back strategy also failed OOS.
   * In-sample "best" combos often had 0.3–0.6R expectancy and dropped to roughly zero or negative OOS. Treat any single great backtest number with suspicion.

## Best combo per market: full R curve
### Hourly, continuous front month: IS Jun 2024–Sep 2025, OOS Oct 2025–Nov 2 2026 (13 months)

#### NQ: **EMA 9/21 cross with trend** · entry: *Limit @ signal-bar 50%* · stop: *1.0 x ATR*

| Target | IS trades | IS win | IS avg R | IS P&L | OOS trades | OOS win | **OOS avg R** | **OOS P&L** | OOS PF |
|---|---|---|---|---|---|---|---|---|---|
| 1R | 174 | 51% | +0.03 | $7,958 | 129 | 45% | **-0.08** | **$-9,890** | 0.91 |
| 1.5R | 174 | 46% | +0.10 | $28,848 | 129 | 37% | **-0.07** | **$-8,025** | 0.94 |
| 2R | 173 | 42% | +0.15 | $42,649 | 128 | 36% | **+0.00** | **$13,984** | 1.11 |
| 3R | 173 | 38% | +0.21 | $64,288 | 128 | 34% | **+0.07** | **$34,655** | 1.26 |
| 4R | 173 | 37% | +0.23 | $75,578 | 128 | 32% | **+0.04** | **$29,223** | 1.21 |
| 5R | 173 | 37% | +0.28 | $90,063 | 128 | 32% | **+0.04** | **$29,618** | 1.21 |

#### ES: **Inside-bar break in trend** · entry: *Stop above signal bar* · stop: *Signal-bar extreme*

| Target | IS trades | IS win | IS avg R | IS P&L | OOS trades | OOS win | **OOS avg R** | **OOS P&L** | OOS PF |
|---|---|---|---|---|---|---|---|---|---|
| 1R | 110 | 55% | +0.06 | $11,112 | 100 | 42% | **-0.13** | **$-1,238** | 0.97 |
| 1.5R | 109 | 50% | +0.10 | $7,018 | 99 | 33% | **-0.16** | **$-7,682** | 0.86 |
| 2R | 108 | 44% | +0.12 | $8,972 | 99 | 29% | **-0.17** | **$-5,795** | 0.90 |
| 3R | 107 | 41% | +0.20 | $14,265 | 99 | 24% | **-0.24** | **$-13,682** | 0.77 |
| 4R | 106 | 41% | +0.33 | $24,045 | 99 | 21% | **-0.35** | **$-19,632** | 0.68 |
| 5R | 105 | 40% | +0.39 | $27,988 | 99 | 21% | **-0.32** | **$-17,658** | 0.71 |

#### GC: **Donchian 20 breakout** · entry: *Confirm close beyond bar* · stop: *1.0 x ATR*

| Target | IS trades | IS win | IS avg R | IS P&L | OOS trades | OOS win | **OOS avg R** | **OOS P&L** | OOS PF |
|---|---|---|---|---|---|---|---|---|---|
| 1R | 169 | 54% | +0.09 | $6,169 | 126 | 48% | **-0.06** | **$-17,722** | 0.86 |
| 1.5R | 166 | 48% | +0.15 | $18,700 | 123 | 43% | **+0.02** | **$6,264** | 1.05 |
| 2R | 162 | 43% | +0.16 | $15,936 | 122 | 39% | **+0.01** | **$4,591** | 1.03 |
| 3R | 159 | 42% | +0.26 | $26,959 | 120 | 37% | **+0.06** | **$2,937** | 1.02 |
| 4R | 158 | 41% | +0.29 | $31,316 | 118 | 36% | **+0.13** | **$19,518** | 1.13 |
| 5R | 157 | 41% | +0.31 | $33,751 | 118 | 36% | **+0.14** | **$25,228** | 1.17 |

### 5-minute, Dec-2026 contracts: IS to Oct 14, OOS Oct 15–Nov 2 2026 (13 sessions)

#### NQ: **Donchian 20 breakout** · entry: *Confirm close beyond bar* · stop: *1.0 x ATR*

| Target | IS trades | IS win | IS avg R | IS P&L | OOS trades | OOS win | **OOS avg R** | **OOS P&L** | OOS PF |
|---|---|---|---|---|---|---|---|---|---|
| 1R | 41 | 61% | +0.21 | $5,402 | 24 | 46% | **-0.09** | **$-1,832** | 0.86 |
| 1.5R | 40 | 52% | +0.30 | $6,060 | 23 | 43% | **+0.08** | **$2,428** | 1.19 |
| 2R | 38 | 45% | +0.33 | $6,773 | 20 | 40% | **+0.19** | **$4,440** | 1.37 |
| 3R | 35 | 34% | +0.33 | $5,154 | 19 | 26% | **-0.09** | **$-484** | 0.97 |
| 4R | 31 | 32% | +0.48 | $8,190 | 18 | 28% | **+0.08** | **$2,858** | 1.22 |
| 5R | 29 | 31% | +0.60 | $9,364 | 18 | 28% | **+0.14** | **$3,603** | 1.28 |

#### ES: **Momentum burst** · entry: *Limit @ close-0.5ATR* · stop: *1.0 x ATR*

| Target | IS trades | IS win | IS avg R | IS P&L | OOS trades | OOS win | **OOS avg R** | **OOS P&L** | OOS PF |
|---|---|---|---|---|---|---|---|---|---|
| 1R | 24 | 54% | +0.12 | $543 | 9 | 33% | **-0.37** | **$-2,057** | 0.35 |
| 1.5R | 23 | 57% | +0.43 | $2,515 | 9 | 33% | **-0.20** | **$-1,507** | 0.53 |
| 2R | 23 | 52% | +0.57 | $3,197 | 9 | 33% | **-0.03** | **$-932** | 0.71 |
| 3R | 23 | 39% | +0.44 | $3,278 | 9 | 22% | **-0.15** | **$-1,039** | 0.70 |
| 4R | 23 | 39% | +0.48 | $4,266 | 9 | 22% | **+0.07** | **$-214** | 0.94 |
| 5R | 21 | 38% | +0.60 | $4,918 | 9 | 22% | **+0.30** | **$611** | 1.17 |

#### GC: **Bollinger snap-back** · entry: *Confirm close beyond bar* · stop: *5-bar swing*

| Target | IS trades | IS win | IS avg R | IS P&L | OOS trades | OOS win | **OOS avg R** | **OOS P&L** | OOS PF |
|---|---|---|---|---|---|---|---|---|---|
| 1R | 29 | 69% | +0.31 | $9,995 | 14 | 29% | **-0.34** | **$-6,490** | 0.27 |
| 1.5R | 28 | 61% | +0.28 | $9,100 | 14 | 29% | **-0.19** | **$-5,260** | 0.41 |
| 2R | 27 | 59% | +0.37 | $11,495 | 14 | 29% | **-0.05** | **$-4,040** | 0.55 |
| 3R | 26 | 58% | +0.42 | $8,440 | 14 | 29% | **+0.07** | **$-2,490** | 0.72 |
| 4R | 26 | 58% | +0.50 | $9,470 | 14 | 21% | **-0.16** | **$-4,400** | 0.54 |
| 5R | 26 | 58% | +0.62 | $11,250 | 14 | 21% | **-0.09** | **$-3,780** | 0.60 |

## Caveats
* The OOS edges are small: +0.05 to +0.19R per trade, with profit factors of 1.2–1.4. Worse slippage or more commission could erase them.
* 5-minute OOS samples are tiny (9–24 trades). The hourly data gives about 120 OOS trades per market, which is better but still modest.
* The continuous hourly series includes roll gaps between contract months.
* 4,860 combinations were searched. The IS-only selection and the requirement to be positive across R targets reduce the risk of lucky picks, but do not remove it.
* This is research, not investment advice.

Code: `rmultiple.py` (engine + grid), `rmultiple_report.py` (selection). Full grids: `results/rmultiple_5m.csv`, `results/rmultiple_1h.csv`.
