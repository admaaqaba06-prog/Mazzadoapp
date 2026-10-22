# Meta Campaign Plan — MAZZADO (DRAFT — NOT LAUNCHED)
Status: requires D-101 (budget), D-102 (ad account), D-103 (tracking) before any launch. No performance numbers below are results; all are hypotheses or targets.

## 1. Strategy in one paragraph
Paid media amplifies a community that already exists; it does not replace it. Every campaign drives to ONE scheduled auction batch with a unified closing time, so ad-driven visitors land in a full, competitive room instead of empty listings. Message spine: "السعر يحدده السوق" — the price is set by the market, not the shop.

## 2. Measurement requirements (must be true before spend)
1. mazzado.com verified in the "Mazzado" Business portfolio; one canonical ad account chosen.
2. Pixel + CAPI firing and deduplicated (event_id) for: ViewContent, CompleteRegistration, Subscribe (1 JOD membership), PlaceBid (custom), Purchase (winner payment). Verified in Test Events.
3. UTM convention: utm_source=meta&utm_medium=paid&utm_campaign=<code>&utm_content=<ad_id>.
4. Weekly export of ad data to ops/data/ + matching Firestore/ledger data so CAC is computed on MAZZADO's own numbers, not only Meta's.

**Optimization event choice:** with a small budget, Meta needs frequent conversions to optimize. The 1 JOD membership (Subscribe) is likely the best primary optimization event: cheap, frequent, and it is the real "serious bidder" signal. If volume is too low to exit learning, fall back to CompleteRegistration and judge on cost per paid member downstream.

## 3. Audience hypotheses (to test, not assumed true)
| ID | Audience | Hypothesis | Test against |
|---|---|---|---|
| A1 | Broad, Jordan, 22–50, Amman/Irbid/Zarqa, Advantage+ audience | Creative does the targeting; broad finds bargain-seekers cheapest | A2 |
| A2 | Interests: online shopping, electronics, deals/discounts, OpenSooq-style marketplace behavior | Deal-seeking interests convert to membership at lower cost | A1 |
| A3 | Retargeting: site visitors 14d, WhatsApp channel/IG engagers, auction viewers without membership | Warm users convert to paid membership far cheaper | prospecting CPA |
| A4 | Retargeting: members with 0 bids | A nudge with the next batch's items converts members to bidders | organic WhatsApp only |
| A5 | Sellers: small business owners, shop owners, Jordan (separate campaign) | Merchants respond to "sell excess stock fast, you set the starting price" | organic outreach by sourcing team |
| A6 | Lookalike 1% of paid members (once ≥100 seeds) | Later-stage, when seed exists | A1 |

## 4. Campaign structure
| Campaign | Objective / event | Ad sets | Phase |
|---|---|---|---|
| C1 Bidder acquisition | Sales or Leads → Subscribe (fallback CompleteRegistration) | A1 vs A2 | Week 3 |
| C2 Retargeting ladder | Sales → Subscribe; then PlaceBid | A3, A4 | Week 2 small test (if approved), scale week 3 |
| C3 Seller acquisition | Leads (WhatsApp click-to-chat or instant form) | A5 | Week 3 |
| C4 Live event reach | Awareness/Engagement for Friday 8PM | Engagers + broad local | Event weeks only, small |

## 5. Budget allocation — PROPOSAL (needs D-101)
Known: ~1,750 JOD is the total 30-day budget (all categories). The paid-media share is not yet decided. Proposal for a paid pool of **[FILL — e.g. what Karam approves]** JOD, weeks 2–4 only:
| Line | Share of paid pool | Rationale |
|---|---|---|
| C1 bidder acquisition (A1 vs A2 split 50/50) | 40% | Main test; needs enough spend per ad set to judge |
| C2 retargeting | 25% | Highest expected efficiency; audience is small so cap spend |
| C3 seller acquisition | 20% | Supply is a CEO hold; demand without items wastes spend |
| C4 live event | 5% | Only around Friday events |
| Creative testing reserve | 10% | Fund winners from round 1 |
Decision rules (pre-registered): judge an ad set only after it has spent ≥ 3× the target cost per paid member OR 7 days; cut if cost per paid member > 2× target; scale winners +20–30% every 3 days max. Target cost per paid member [SET] from unit economics: it must be below expected contribution per paid member over 60 days (computed by coo-revenue).

## 6. Creative briefs (AR primary, EN secondary)
### CB-1 "السوق يقرر" — market-set price
- Goal: membership. Audience A1/A2. Format: 9:16 video 10–15s + 1:1 static.
- Concept: real item from this week's batch, starting price on screen, counter of bids rising, cut to "الإغلاق الجمعة 8 مساءً".
- Hooks: "بتشتري بالسعر اللي بتحدده إنت؟" / "ابدأ المزاد من 1 دينار… والسوق يقرر الباقي" (only if a real item starts at that price) / EN: "You decide the price. Friday 8PM."
- Primary text (AR): "على مزادو ما في سعر محل. في سعر سوق. اشترك وزايد على قطع حقيقية — الإغلاق الجمعة الساعة 8 مساءً."
- CTA: Subscribe / Sign up. Proof needed: real item photos, real starting prices only.

### CB-2 "الجمعة 8" — live event countdown
- Goal: event attendance → membership. Audience C4 + A3.
- Concept: carousel of the batch's items with starting prices; final card countdown.
- Hook: "5 قطع… مزاد واحد… الجمعة 8 مساءً".

### CB-3 "اشتركت؟ زايد هلق" — member activation
- Goal: first bid. Audience A4.
- Concept: "You're one step away" — item close-up, current highest bid, time left.
- Copy: "اشتراكك فعّال. القطعة لسا بـ [current bid] د.أ — باقي [time]."  (dynamic values pulled from real data at build time)

### CB-4 "بيع بسرعة، إنت بتحدد سعر البداية" — sellers
- Goal: seller leads via WhatsApp. Audience A5.
- Concept: merchant talking head or text-on-screen: excess stock → listed → sold at Friday close.
- Copy: "عندك بضاعة واقفة؟ اعرضها على مزادو، إنت بتحدد سعر البداية، والمشترين بيتنافسوا." CTA: WhatsApp.
- Must state fees honestly (5% seller fee).

### CB-5 Trust — how payment and delivery work
- Goal: reduce drop-off at win/payment. Retargeting all stages.
- Explain CliQ payment and delivery guarantee — publish only after D-105 is decided.

## 7. Retargeting ladder
Viewed auction, no registration (7d) → CB-1/CB-2 · Registered, not member (14d) → membership value + next batch · Member, no bid (14d) → CB-3 · Bid, lost (7d) → "next batch" items · Won, not paid (48h) → handled by ops via WhatsApp, NOT ads.

## 8. Testing plan (one variable at a time)
T1 audience: A1 vs A2, same creative · T2 hook: price-control vs scarcity hook, same audience · T3 format: video vs carousel · T4 optimization event: Subscribe vs CompleteRegistration (only if Subscribe volume is too low).
Each test: hypothesis, metric (cost per paid member), minimum spend/time, decision recorded in DECISIONS.md.
