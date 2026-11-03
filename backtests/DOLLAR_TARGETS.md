# Dollar targets: TP $1,500–3,000, risk $500–750 per trade (NQ1!, ES1!, GC1!)

Your brief means a reward:risk of **2:1 to 6:1**, so expect win rates of roughly **15–30%**. Profit comes from the few trades that run, not from frequent small wins.

## Two ways to fit the dollar brief
| Method | How |
|---|---|
| **A. Fixed bracket, 1 standard contract** | stop $500/$625/$750, TP $1,500/$2,000/$2,500/$3,000. NQ: stop 25–37.5 pt, TP 75–150 pt. ES: stop 10–15 pt, TP 30–60 pt. GC: stop $5–7.50, TP $15–30 |
| **B. Micros sized to risk** | keep the strategy's own stop (signal bar / 1×ATR / 5-bar swing / ICT stop). Buy as many **MNQ ($2/pt), MES ($5/pt), MGC ($10/pt)** as fit under a $625 or $750 risk cap, and set the TP so the position makes $1,500–3,000. Commission $0.75/side per micro |

* **Scope:** all 32 setups plus 15 ICT/level setups; breakeven off or at +$750.
* **Data:** 1-hour bars with the TRAIN / VALID / TEST split, and 5-minute bars with IS / OOS. 84,624 combinations in total.
* **Fills:** same conservative fill model as before. Trades are flat at the 17:00 ET session end.

## Findings
1. **5-minute charts don't fit these targets.**
   * Out-of-sample, the median result was negative in every market under both methods.
   * A $1,500–3,000 target is a 75–150 point move on NQ, which an intraday 5-minute setup rarely reaches before the session ends.
   * The only positive 5-minute families were two NQ ICT sweep setups with tiny samples (17 and 9 trades).
2. **On hourly bars, micro sizing (B) beats the fixed bracket (A).**
   * A $500 stop on one full contract is inside normal hourly noise: 82–84% of trades get stopped.
   * Of the micro-sized combos that passed TRAIN+VALID, **64% were profitable in TEST on NQ**, versus 46% for fixed brackets.
3. **Bigger TP is better:** for the NQ strategy, the median TEST result rises steadily from $1,500 to $3,000 TP.
4. **Breakeven at +$750 helps** in the dollar framework: the median TEST P&L roughly doubled on NQ.

## Final configurations (chosen without using TEST; modal parameters of the top family)
| Market | Method | Configuration | TEST trades | Win % | Avg/trade | **TEST P&L** | PF | Max DD | Variants profitable in TEST |
|---|---|---|---|---|---|---|---|---|---|
| **NQ1!** | **B: MNQ micros** | NR7 + EMA20/50 trend (long+short), confirm-close entry, 1×ATR stop, risk cap $625 (avg $525, ~3–5 MNQ), **TP $3,000**, BE at +$750 | 78 | 27% | +$182 | **+$14,204** | **1.69** | –$5,301 | **78% of 78** |
| NQ1! | A: 1 NQ | same setup, **$500 stop**, **TP $2,500**, BE at +$750 | 84 | 18% | +$66 | +$5,565 | 1.23 | –$4,660 | 76% of 21 |
| ES1! | B: MES | ICT turtle soup PDH/PDL, confirm entry, ICT stop, cap $625, TP $3,000 | 40 | 42% | +$25 | +$997 | 1.09 | –$3,188 | 80% of 15 |
| ES1! | A: 1 ES | ICT FVG trend (long), $500 stop, TP $2,000, BE +$750 | 58 | 26% | +$54 | +$3,135 | 1.16 | –$3,698 | **33%**, unreliable |
| GC1! | B: MGC | Donchian-20 breakout (long), confirm entry, 5-bar stop, cap $625, TP $3,000, BE +$750 | 28 | 50% | –$8 | –$237 | 0.95 | –$1,070 | 51%, ~breakeven |
| GC1! | A: 1 GC | NR7 + volume dry-up (long), $500 stop, TP $3,000 | 161 | 14% | –$109 | **–$17,625** | 0.75 | –$28,605 | 30%, fails |

**NQ details (the recommended setup, B: MNQ micros):**

| Period | Trades | Win % | P&L | PF | Max DD |
|---|---|---|---|---|---|
| TRAIN | 70 | 23% | +$12,195 | 1.60 | –$4,882 |
| VALID | 58 | 26% | +$10,131 | 1.82 | –$2,882 |
| **TEST** | **78** | **27%** | **+$14,204** | **1.69** | **–$5,301** |
| NQZ26 front window (Sep 14 – Nov 2) | 11 | 27% | +$1,412 | 1.51 | –$1,189 |

How the trades ended (TEST):
* **5%** hit the full $3,000 target;
* **71%** exited at the stop or the breakeven stop;
* the rest closed at the 17:00 session end, mostly with partial profits.

Allowing trades to hold overnight would let more of them reach $3,000. That is untested and adds gap risk.

**Gold note:** the ICT FVG-trend strategy (ICT_LEVELS.md) under micro sizing, long + short, had 13 variants passing TRAIN+VALID, and **92% of them were profitable in TEST**. It ranks below Donchian on pass-share, so the mechanical rule didn't pick it. It is the better gold candidate to paper-trade.

## Bottom line
* **Your dollar brief works on NQ:** NR7 + trend on 1-hour bars, sized with 3–5 MNQ to about $525–625 risk, TP $3,000, breakeven at +$750.
* **ES and GC are not reliable** under these dollar constraints.
* Expect long losing streaks with a 23–27% win rate; the worst TEST drawdown was about 10 losses deep (–$5.3k).
* This is research, not investment advice.

Code: `engine4.py` (dollar brackets and micro sizing), `run_dollar.py` (grid), `final_dollar.py` (selection and report).
