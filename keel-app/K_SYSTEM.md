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
