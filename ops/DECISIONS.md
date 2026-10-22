# Decision Log (append-only)
Format: ID · date · decision · owner · status (PENDING / APPROVED / REJECTED) · evidence/rationale

## Standing decisions (already made by Karam)
- D-001 · pre-2026-10 · Effective take rate = 10% (5% seller + 5% buyer) · Karam · APPROVED
- D-002 · pre-2026-10 · Keep paid bidder membership (mostly 1 JOD) as seriousness filter; revisit only with auction data · Karam · APPROVED
- D-003 · pre-2026-10 · "Community before ads"; no influencers in first 30 days · Karam · APPROVED
- D-004 · pre-2026-10 · Concentrate demand: few auctions, unified closing times; Friday 8PM live event · Karam · APPROVED
- D-005 · pre-2026-10 · 30-day budget ≈ 1,750 JOD total · Karam · APPROVED
- D-006 · 2026-10-22 · No deploy / ad launch / spend / publish / production data change without written approval logged here · Karam · APPROVED (per kickoff brief)

## Pending (need Karam)
- D-101 · Paid media share of the 1,750 JOD and the split proposed in CAMPAIGN_PLAN.md §5 · PENDING
- D-102 · Which Meta ad account is canonical for MAZZADO going forward (new "Mazzado" account vs legacy "مزاد علني" accounts) · PENDING
- D-103 · Approve implementing Meta Pixel + Conversions API events (code change; deploy separately approved) · PENDING
- D-104 · Non-paying-winner policy (time limit, fallback to second bidder, penalty) · PENDING
- D-105 · Seller delivery guarantee model (who holds the item / when seller is paid) · PENDING

## Reopened by the 27 Sep plan (logged 2026-10-22 by the orchestrator)
Appended, not edited: D-002 and D-003 above stay on the record. These supersede
them as the OPERATIVE status, and CLAUDE.md has been corrected to match.

- D-106 · 2026-10-22 · **Paid bidder membership — REOPENED.** Supersedes D-002 as the operative status. The 27 Sep plan puts it at "held, pending data": ~30 JOD/month, 24 of 313 registrations paid (7.7%), and the plan calls it "a tax on growth". Settled by the week-1 Firestore pull, not by argument. · Karam · **PENDING**
- D-107 · 2026-10-22 · **Influencer rule — UNRECONCILED.** D-003 says no influencers in the first 30 days (a calendar). Plan task 24 says resume only if week-2 metrics improved (a measurement). Orchestrator default until Karam rules: the stricter one — **no influencer spend authorised**. That default is the orchestrator's, not Karam's ruling. · Karam · **PENDING**
- D-108 · 2026-10-22 · **6 JOD delivery fee (plan task 14) — DECIDED, NOT SHIPPED.** Must ship as ONE release: every screen plus the legal terms, after a Jordanian lawyer reviews the wording. Today the product charges no delivery fee while the information pages already say 6 JOD and the terms enumerate fees without it — a live exposure. All unit-economics work models both cases until it ships. · Karam + lawyer · **PENDING**
- D-109 · 2026-10-22 · **CliQ endpoint status unverified.** CLAUDE.md previously asserted the data endpoints return 403 pending a bank-side API product subscription. Not verifiable from the repo; the last blocker seen in the bank thread (2026-10-05) was developer-portal / sandbox access. Confirm which is current before any agent plans around it. · Karam · **PENDING**

## Merged from the cmo-growth audit (2026-10-22, orchestrator)

**ID collision resolved.** cmo-growth proposed its decisions as D-106..D-109,
but those numbers were already taken by the four logged above. Renumbered here.
Its proposed D-107 is the SAME question as the D-107 already logged, so it is
merged into that entry rather than duplicated — see the amendment below.

- D-110 · 2026-10-22 · **Approve the Tier A / Tier B copy rewrites**, row by row (cmo-growth report §3). This is live customer-facing Arabic and English on mazzado.com. **No copy changes without this.** Blocks CMO-004, CMO-005, CMO-007. · Karam · **PENDING**
- D-111 · 2026-10-22 · **Does the iPhone 17 Pro Max "يبدأ من 1 دينار فقط" announcement stay on the landing page at all?** Plan task 8 sets a 20 JOD minimum and CAMPAIGN_PLAN.md:48 allows the framing only if a real item starts at that price. Rewriting the copy without deciding the lot's real opening price only defers the problem. · Karam · **PENDING**
- D-112 · 2026-10-22 · **May customer phone/email be uploaded to Meta as a Customer List** to build audience A4 (members with no bids)? CAMPAIGN_PLAN.md:22 implies it; CLAUDE.md restricts personal data leaving the platform. Nobody should build it on an assumption. · Karam · **PENDING**

### Amendment to D-107 (influencer rule) — sharpened by cmo-growth
The two rules do not only differ on the clock. Also unresolved:
- D-003's "first 30 days" **has no stated start date**.
- Plan task 24's week-2 gate **already elapsed ~11 Oct**, and the measurement that
  gates it (task 7, registration rate) was never reported — and per the audit is
  currently **unproducible**: no GA4, and the landing analytics are discarded.
- They disagree on **who decides**: Karam (D-003) vs Maher (task 24).
So: **if D-003 governs, state the start date. If task 24 governs, state who supplies
the measurement.** The two rules happen to agree on the near-term action today for
unrelated reasons, and that agreement dissolves the moment task 7 is measured.
The orchestrator default stands until Karam rules: **no influencer spend authorised.**

### Orchestrator verification note (2026-10-22)
cmo-growth listed as its limitation #7 that it read `src/` only and had not checked
production. **The orchestrator fetched mazzado.com on 2026-10-22 and confirmed the
core of F1 is live**: the H1 "اشترِ بأرخص سعر.", the iPhone 17 Pro Max
"يبدأ من 1 دينار فقط", the 1 JOD/month bid membership, and "بائعون موثّقون" are all
on the served page. F1 is therefore a production fact, not a source-only reading.
Still unverified on live: the remaining Tier A rows A8–A20.

## Merged from the coo-revenue audit (2026-10-22, orchestrator)

- D-113 · 2026-10-22 · **Membership-attribution rule for per-auction P&L.** Still `[FILL]` at `KPI_DASHBOARD_SPEC.md:30`. Every unit-economics number moves with it, so it cannot stay blank. · Karam · **PENDING**

### Amendment to D-107 (influencer rule) — now decisive
coo-revenue establishes that **visits are unmeasurable by anyone today**: there is
no GA4, `analytics_events` requires `isSignedIn()` so anonymous visits never land,
and landing events reach `window.dataLayer` and stop. Plan task 24 gates influencer
spend on the **registration rate** — visits to registrations. **That gate has no
denominator.** It cannot be evaluated today, by anyone, at any time.
So D-107 is not merely unreconciled: one of its two rules is currently
**unrunnable**. Either measurement gets built first (CTO-002 / CMO-010), or the
rule reverts to the calendar. The orchestrator default is unchanged: no spend.

### Amendment to D-108 (delivery fee) — the premise does not hold
Verified by the orchestrator against the repo, 2026-10-22:
- **No delivery-fee field exists anywhere** in `src/` or `functions/`. `totalDue` is
  hammer + 5% only. A grep for `deliveryFee|shippingFee|deliveryCost` returns nothing.
- Live copy says **"٢–٤ دنانير تقريباً" / "~2–4 JD"** (`HowItWorksView.tsx:75`), not 6 JOD.
  The "6 JOD" the plan says information pages state appears **nowhere** in this repo.
- **Free self-collection is already promised** on the same line, so a 6 JOD fee does
  not straightforwardly earn 6 JOD — the opt-out rate is unmeasured.
Task 14 is therefore not a change to an existing figure; it is introducing a fee
that does not exist, against copy that currently promises a different one and a
free alternative. Worth knowing before a lawyer reviews wording.

### Correction to the coo-revenue report (orchestrator, verified)
The report lists as an **active trap** that reserves set in the listing form are
silently lost to an admin-only rule and swallowed into a `console.warn`.
**That is the pre-fix state and it is already fixed.** `AppContext.tsx:4335` now
routes the reserve through the `setAuctionReserve` callable, which writes from a
trusted context and checks ownership; failure raises `console.error`, a seller
notification and a toast, in both languages; and settlement refuses to award a lot
whose reserve was intended but unreadable. The agent read the comment that
documents the old bug in past tense.
**What survives:** lots created BEFORE that fix may still carry intended-but-missing
reserves in production. Those would be wrongly "fixed" by lowering reserves, so the
script splitting them out of `reserve_not_met` keeps its value.

## Merged from the cto-product audit (2026-10-22, orchestrator)

- D-114 · 2026-10-22 · **Does GA4 exist at all?** `measurementId` is empty (`src/services/firebase.ts:18`), there is no gtag and no GTM container. `KPI_DASHBOARD_SPEC.md:7-8` names GA4 as the source of truth for the **top two funnel rows**. The spec is built on a source that does not exist — either create it or rewrite those rows. · Karam · **PENDING**
- D-115 · 2026-10-22 · **Minimum starting price: what amount, and is a STARTING-price floor the right instrument?** A *reserve* floor may serve the goal better. Either way the plan’s 20 JOD does not reach the 60 JOD break-even. Implementation needs **both** a client and a `firestore.rules` change — listings are a direct client write with no callable, so client-only is cosmetic. · Karam · **PENDING**
- D-116 · 2026-10-22 · **What happens to the interests gate?** The name/city wall Karam reported is genuinely gone; a full-screen interests picker took its place for every new account. It has a visible "Skip for now", so it is one dismissible tap, not the old wall — and it fires no events, so its cost is unmeasured. · Karam · **PENDING**
- D-117 · 2026-10-22 · **Build a browsable ended-auctions / results view?** Confirmed: every feed query filters to live/upcoming, and **no surface anywhere shows what anything sold for** — while "market-set pricing" is the brand message. · Karam · **PENDING**
- D-118 · 2026-10-22 · **Break the far-miss silence?** A bid that misses reserve by a wide margin notifies nobody; `below_reserve_pending` is in-app only. Messaging customers is gated by CLAUDE.md rule 2. · Karam · **PENDING**

### Amendment to D-106 (membership) — the data to settle it does not fully exist yet
cto-product: `SubscriptionPromptModal` and `SubscriptionView` contain **zero**
analytics calls, and all four paywall trigger sites fire nothing. The first
recorded moment is `membership_submitted` — **after** the proof upload. So we can
count who finished paying and **not** who saw the ask. That denominator is exactly
what the keep/remove decision needs.
**Do not run a removal test until the paywall is instrumented (CTO-101, ~0.5 day)** —
without a `membership_gate_shown` event the result is uninterpretable. The gate is
cleanly factored (`guestGate.ts:80`), so the experiment is cheap once measurable.
The week-1 script still answers the other half: what happened to the bids.

## Approvals granted by Karam

- D-119 · 2026-10-22 · **Deploy CTO-101 (membership paywall instrumentation) to production.** Approved verbally by Karam in session ("اعمل commit وانشر"). Logged here because CLAUDE.md rule 2 requires a deploy approval to be on the record, not only in a chat. Scope: the frontend only — five modified `src/` files plus three new ones. **No rules, no functions, no pricing, no copy.** Ships by merge to `main`, which triggers `firebase-hosting-deploy.yml`. · Karam · **APPROVED**
