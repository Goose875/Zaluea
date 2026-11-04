# K system (K1–K7) in Keel

Seven hourly strategies from the research (`keel/KEEL_BOT_SPEC.md`). Signals use NQ and GC prices; orders go in MNQ and MGC micros.

## Set up
1. **Logins:** save your TopstepX username and API key (Topstep's API subscription is needed for history and orders).
2. **Risk limits:**
   * add **MNQ** and **MGC** to allowed symbols;
   * set max contracts per order high enough for your risk (e.g. $300 on a ~70-point NQ stop is 2 MNQ);
   * set a daily loss limit.
3. **Validate K:** export 1-hour charts of NQ1! and GC1! from TradingView (and daily, optional), then run the check. Every row should say *Matches*.
4. **K system page:**
   * pick **Paper** and choose sizing and flat-by;
   * select the account at the top, then **Start bot**;
   * let it run for a few weeks and compare the paper results.
5. **Go live:** only after that, switch to **Live**. Live needs the bot stopped to switch, and asks you to confirm.

## How it trades
**Every hour** (a few seconds after the bar closes), Keel:
1. loads ~1,500 hourly bars and ~150 daily bars of NQ and GC from TopstepX;
2. rebuilds every indicator and level;
3. re-runs the same simulator that reproduces the research trade for trade.

**What it then does:**
* **New entry:** a market order, then at once a **stop order resting at TopstepX** and a target limit order (when the strategy has one). If the stop can't be placed, the position is closed straight away.
* **Breakeven or trail:** the resting stop is modified.
* **Time stop, session end, flat-by, or the simulator no longer in the trade:** orders are cancelled and the position closed at market.
* **Between hours:** every 15 seconds it checks positions. When a stop or target fills, the other order is cancelled. A missing stop is placed again.

**Safety rules**
* **One K trade per instrument at a time,** in priority order K3 > K2 > K1 > K4 (NQ) and K6 > K7 > K5 (GC). This means resting orders can never flip a netted position.
* **Every entry passes Keel's risk limits:**
  * daily loss limit;
  * contract caps;
  * allowed symbols;
  * no trading when P&L can't be read.
* **Stop all trading flattens everything,** K trades included.
* **Open K trades are saved,** so a restart picks them up.

## Flat-by time (prop rules)
* **Topstep:** be flat by 3:10 PM CT, which is 4:10 PM ET. The default flat-by is **4:00 PM ET**: K trades are closed at 3:57 PM and nothing opens until 6 PM.
* **Effect on the backtest** (`scripts/parity.js` with `FLAT_BY=16`):
  * K1, K3, K4, K5 and K7 are essentially unchanged;
  * K6 is somewhat lower but still strong;
  * **K2 drops to about breakeven,** because its edge needs overnight holds. **K2 starts switched off.**
* **No cut-off** allows the researched swing holds. Session-end strategies are still closed at 4:57 PM because the market halts at 5 PM.

## Tests (run from this folder after `npm install` and `npx tsc -p . && node scripts/copy.js`)
* `node scripts/parity.js NQ_1h.csv GC_1h.csv` runs the engine and compares with the research, period by period. With the research data: all 1,063 research trades reproduce exactly.
* `node scripts/replay-test.js NQ_1h.csv GC_1h.csv 1500` replays 1,500 hours through the **live runner** with paper orders. Result: 95/95 simulator trades taken live, and P&L within ~$200 of the simulator.

## Known limits (next steps)
* **Contract rolls.** History comes from TopstepX's current front contract. Right after a roll, the new contract's earlier bars are thin back-month trading, so volume-based levels (VWAP, POC/VAL) can be off for a few days. *Next step:* stitch the previous contract's bars before the roll.
* **Lucid / Rithmic:** still waiting on Rithmic's API approval. K live needs history, stop orders and order modify on that connection too.
* **TopstepX endpoints:** `Contract/search`, `Position/searchOpen`, `Order/searchOpen` and `Order/modify` field names follow ProjectX's docs and third-party clients. **Run paper mode, then live on a practice account, before real money.**
* **Not investment advice.** Backtests don't guarantee future results.

## PO3 and Fractal (K8, K9, P1–P3), new in 0.4.0
| Id | Strategy | Market | Evidence | Live? |
|---|---|---|---|---|
| K8 | GC Fractal breakout, day trade: daily signal, market entry at the 18:00 reopen, stop 0.5× daily ATR, target 3R | MGC | 2005–2026 daily | yes |
| K9 | GC PO3 1h rejection block, 4h EMA20 bias, exit at the 4h candle close | MGC | Jun 2024 – Nov 2026 hourly | yes |
| P1 | GC PO3 15m FVG midpoint, exit at the 4h close | MGC | 10 weeks only | paper only |
| P2 | GC PO3 15m rejection block, bias vs 18:00 open, 3R | MGC | 10 weeks only | paper only |
| P3 | NQ PO3 15m FVG midpoint, exit at the 4h close | MNQ | 10 weeks only | paper only |

**How they trade:**
- **PO3 entries** are resting limit orders at the exact level, rounded a tick in the safe direction.
- The entry is cancelled when the research's window ends: 3 hours into the 4h candle, or 15:55 ET.
- When an entry fills, the stop (and target) are placed at once, measured from the real fill.
- **Exits:** stop or target at the broker, the 4h candle's close, or the flat-by time.
- **One position per market** across K1–K9 and P1–P3. If a market is held, or has a working entry, any other entry on it is skipped.

**Tests** (after `npx tsc -p .`):
- `node scripts/parity-x.js ../backtests` reproduces all 632 research trades exactly (K8 168, K9 183, P1 115, P2 53, P3 113).
- `node scripts/replay-x.js P1 ../backtests/data/GC_cont_5m.csv` replays bars through the live runner with paper orders and compares its fills with the simulator.

## Rankings page
It shows every mix and single strategy from the Topstep 50K Static simulation ($4k target, $2k static drawdown, $1k daily loss limit, 55% consistency, payouts after 5 days of $150+).
- Sort by pass rate, days to pass, payout rate, days to payout, cash, or results on the last year only.
- **Use** switches the K system to that mix and risk.
- Recommended: **K1+K3+K4+K5+K6+K7 at $350**. On the last year that passed 97% of the time in a median of 27 trading days, and every passed account reached a first payout, a median of 13 trading days later.

**Topstep notes:**
- The API only works on Topstep's simulated accounts (Combine and Express Funded), not Live Funded.
- Topstep requires automated trading to run from your own computer. A VPS or VPN can get the account closed.
