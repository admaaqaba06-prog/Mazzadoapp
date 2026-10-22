# KPI Dashboard Specification
Owner: coo-revenue (formulas) · cto-product (event plumbing). All values must trace to a source below. Currency: JOD.

## 1. Funnel (weekly, and per auction batch)
| Stage | Definition | Source of truth | Tracking event |
|---|---|---|---|
| Visitors | Unique users on site | GA4 | page_view |
| Auction views | Users viewing an auction page | GA4 / Pixel | ViewContent (content_ids = auction id) |
| Registrations | New accounts created | Firebase Auth / Firestore users | CompleteRegistration |
| Paid members | Users with an active paid membership | Firestore memberships + payment confirmation | Subscribe (value, currency=JOD) |
| Active bidders | Members with ≥1 bid in period | Firestore bids | PlaceBid (custom) |
| Winners | Users winning ≥1 auction | Firestore auctions | — |
| Paid winners | Winners whose CliQ payment is confirmed | Payments / Yazan's ledger (until CliQ API live) | Purchase (value = hammer + buyer fee) |
| Completed | Delivered and accepted | Ops log | — |

Conversion rates = stage N ÷ stage N-1. Report both counts and rates.

## 2. Auction health
- Auctions listed, auctions closed, auctions with ≥1 bid
- Completion rate = auctions ending in Completed ÷ auctions closed
- Sell-through vs reserve = closed ≥ reserve ÷ closed
- Bids per auction, unique bidders per auction (distribution: median, p25, p75)
- Clearing ratio = hammer price ÷ starting price; and ÷ estimated retail value where known
- ASV (average sale value) = Σ hammer price of completed ÷ count completed — report median too

## 3. Unit economics (per auction, then aggregated)
Revenue = hammer × 5% (seller fee) + hammer × 5% (buyer fee) + attributable membership revenue
Costs = sourcing/acquisition cost (if any) + delivery/handling + payment fees + attributable ad spend + refunds/non-payment losses
Contribution = Revenue − Costs. Show distribution; flag auctions with negative contribution.
Membership revenue attribution rule: [FILL — decide: per-period pool spread across auctions with bids, or excluded from per-auction view]

## 4. Acquisition
- Spend (Meta exports) · CPM · CTR (link) · CPC
- Cost per registration, cost per paid member, cost per active bidder
- CAC (paid member) = spend ÷ new paid members attributed (state attribution window: 7d click / 1d view)
- ROAS (platform-reported) and ROAS (MAZZADO-revenue based) — never mix them
- Seller CAC = sourcing team cost + seller ads ÷ new active sellers

## 5. Supply
- New sellers, active sellers (≥1 listing in period), listings per seller
- Repeat-seller rate (sellers listing again within 30 days)
- Time from seller contact → listing live
- Listing quality score (checklist in COO SOP)

## 6. Data plumbing status
| Feed | Status |
|---|---|
| GA4 | UNKNOWN — verify in code audit |
| Meta Pixel | UNKNOWN — verify; domain verification pending |
| Meta CAPI | Being built (stated) — verify |
| Firestore export | Needs read-only export path |
| Payments | Manual (Yazan) until CliQ API 403 is resolved |
