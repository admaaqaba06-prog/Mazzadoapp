# MAZZADO — Initial State Audit (business level, pre-code)
Date: 2026-10-22 · Author: lead orchestrator · Status: PARTIAL — repository not yet inspected

## What this audit is based on
Karam's own prior statements about MAZZADO (not code, not data exports). No repository, analytics, Meta, Firestore, or CliQ data has been inspected yet. The code audit is the first job of `cto-product` (run `/kickoff` in Claude Code).

## Known current state
| Area | Known state | Confidence |
|---|---|---|
| Product | Live at mazzado.com. React/TypeScript/Firebase. Auctions running. | Stated by Karam |
| Payments | CliQ via Bank al Etihad (Staq BaaS), production onboarding. Token auth works; all data endpoints return 403 — bank-side API product subscription, not credentials. So payment verification is presumably still manual. | Stated; manual-matching assumption needs confirmation |
| Notifications | WhatsApp notifications + WhatsApp channel live | Stated |
| Monetization | 5% seller + 5% buyer = 10% effective take; paid bidder membership (mostly 1 JOD) kept as seriousness filter | Stated |
| Marketing | Website, socials, WhatsApp channel live. "Community before ads", no influencers first 30 days, Friday 8PM live event | Stated |
| Meta | Two Business portfolios: "مزاد علني" (3 ad accounts, prior spend) and "Mazzado" (brand). New ad account under "Mazzado"; mazzado.com moved there, domain verification pending; conversion tracking being built | Stated |
| Supply | Hamoudeh and Yousef source from merchants and list inventory | Stated |
| Ops/finance | Yazan: weekly ops report, bank/transfers/customer payments; raised seller-delivery-guarantee issue | Stated |
| Budget | ~1,750 JOD for 30 days (total, all categories) | Stated |
| Open CEO holds | Supply sustainability, per-auction unit economics, ASV evidence, Months 2–3 budget | Stated |

## Biggest risks visible before seeing code
1. **No measured funnel yet.** Without working Pixel/CAPI events and Firestore aggregates, no CAC/ROAS/conversion claim is possible, and the CEO holds can't be resolved with evidence.
2. **Manual payment matching** (while CliQ endpoints are 403) caps throughput and creates non-paying-winner risk.
3. **Domain verification pending** blocks reliable Aggregated Event Measurement / conversion optimization in the new ad account.
4. **Delivery guarantee** for sellers' items not yet formalized (Yazan's write-up) — trust risk for buyers.
5. **Membership paywall before first bid** is a deliberate filter, but its drop-off is unmeasured. Measure before debating it.

## To verify in the code audit (cto-product)
Bid integrity (Firestore transactions, server-side validation, server clock for end time), firestore.rules write protection on bids/prices/membership/payment status, which analytics events fire, mobile performance, RTL quality, payment/order state machine.
