# Topstep 50K Static: best strategy mix (`topstep_static.py`, `oos_check.py`)

Rules modelled:
- **Combine:** $4,000 target, $2,000 static max loss, hard $1,000 daily loss limit, 55% consistency, max 40 micros (MGC 25).
- **Express Funded Account (XFA):** starts at $0 with a static -$2,000 limit, which becomes $0 after the first payout. A payout needs 5 days of at least +$150 and pays 50% of the balance, capped at $2,000 (the $8,000 cap gave the same ranking). Split 90%.

Test: 8 strategies, all 255 combinations, risk $150/$250/$350/$500 per trade, MNQ/MGC micros, one position per market. A new Combine starts every trading day, Jun 2024 to Nov 2026.

## Out-of-sample (Combines started Dec 2025 to Nov 2026, after the K strategies were chosen)
| Mix | Risk | Pass | Median trading days to pass | Reached 1st payout | Days pass to payout |
|---|---|---|---|---|---|
| **K1+K3+K4+K5+K6+K7** | **$350** | **97%** | **27** | **100%** | **13** |
| K1+K3+K4+K5+K6+K7 | $250 | 100% | 31 | 100% | 13 |
| K1+K3+K4+K5+K6+K7 | $500 | 90% | 17 | 79% | 11 |
| K1+K3+K4+K6+K7 | $350 | 99% | 30.5 | 100% | 14 |
| GC PO3 1h RB + K1+K3+K4+K6+K7 | $250 | 100% | 35 | 100% | 14 |
| GC Fractal + K1+K3+K4+K5+K6 | $350 | 97% | 28 | 100% | 14 |

$500 risk passes fastest but fails about 1 in 10 Combines, and about 1 in 5 funded accounts is lost before the first payout. $350 is the sweet spot.
