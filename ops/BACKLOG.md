# Single Prioritized Backlog

Ranking = funnel impact × confidence ÷ effort. Owner: CTO / CMO / COO. Status: TODO / DOING / BLOCKED / DONE.

**Last merged: 2026-10-22 — PARTIAL.** The `cmo-growth` audit is merged in full.
`cto-product` and `coo-revenue` were still running at merge time; `coo-revenue`
delivered its script but not its report. Their items are merged on completion —
see §Pending at the bottom. Nothing below is invented from an unfinished audit.

## Ranked

| # | ID | Item | Owner | Why it matters | Status |
|---|---|---|---|---|---|
| 1 | COO-001a | **Run `scripts/analytics/funnel-week1.cjs` against production (read-only) and commit the aggregates to `ops/data/`** | **Karam** | The plan's own words: 126 bids → 4 sales is "the most important unknown in the business", and the answer "changes the priorities in this document". Four causes with four different fixes — one Firestore read separates them. Settles D-106 (membership). | **TODO — needs Karam, ~minutes** |
| 2 | CMO-004 | **Remediate Tier A ad-policy copy (A1–A7): the 1-dinar opening-price framing, the price superlatives, the sticky-CTA ambiguity** | CMO drafts · Karam approves · CTO applies | Pay-1-JOD-to-bid sitting next to win-a-flagship-from-1-dinar is the penny-auction shape Meta's automated review catches. **Verified live on mazzado.com 2026-10-22.** Blocks the whole paid channel and the ban appeal. | **BLOCKED on D-110** |
| 3 | CMO-010 | Verify the 4 existing pixel events actually fire, in Events Manager Test Events — incl. whether the deferred loader suppresses `PageView` for bouncing visitors | Karam (Meta access) | Every "exists" claim in the measurement plan is read from source, not observed. If `PageView` is suppressed for bounces, ad traffic specifically is undercounted. | BLOCKED on Meta access |
| 4 | CMO-009 | Build URL-rule Website Custom Audiences incl. All Visitors 180d + exclusions (`[plan]` tasks 6, 22) | Karam (Meta access) | **Works today, no code needed.** Recovers the ~15,000 influencer visitors `[plan]` — and they go colder every day. | BLOCKED on Meta access, D-102 |
| 5 | CMO-006 | Extend the `signInPanelCopy.test.ts` guard to `src/landing/translations.ts` and `DiscoveryFeedView.tsx` — a forbidden-claims test that fails the build | CTO (CMO supplies the list) | The guard already exists and already forbids "cheapest", "verified sellers", "guarantee" — it just does not cover the page the ads point at, which ships all three. Makes the fix permanent instead of a one-off review. | TODO after CMO-004 |
| 6 | CMO-005 | Remediate Tier A remainder (A8–A20) + Tier B: guarantees, unverified stats, "Verified Sellers", the simulated-lot "Real Photos" label | CMO · Karam · CTO | Misrepresentation and trust exposure, separate from ad policy. A simulated hero lot is presented as live with a named bidder, a viewer count and a reference number. | BLOCKED on D-110 |
| 7 | CTO-001 | Repository audit incl. bid integrity, firestore.rules, payment/order state, **tracking events table** | CTO | Two other workstreams are blocked on the event table. | **DOING** |
| 8 | CMO-007 | Draft the Instagram ban appeal around the three checkable facts | CMO drafts · **Karam files** | The channel is dark until this lands. Weaker if filed before the page is fixed. | TODO after CMO-004 ships |
| 9 | CTO-002 | Implement Meta Pixel + CAPI + GA4 events per KPI spec (branch, emulator-tested; deploy separately approved) | CTO | No measurement = no CAC/ROAS/funnel. `Subscribe`, `ViewContent`, `Purchase`, CAPI and GA4 are all absent. | TODO (needs D-103) |
| 10 | CMO-014 | Replace or remove the landing `comingSoon` localStorage lead form | CTO · CMO | Every lead captured there is lost, and it collects phone numbers into a throwaway store. | TODO |
| 11 | COO-002 | Per-auction P&L template; fill for every test auction | COO | CEO hold: unit economics, ASV. Must model both fee cases until D-108 ships. | TODO |
| 12 | CMO-013 | Resolve the three-way delivery-fee contradiction in customer-facing copy | COO/CTO · Karam · lawyer | ~2–4 JOD on one screen, a 6 JOD figure the plan cites that appears nowhere in `src/`, and no delivery clause in the terms. Abandonment + legal exposure. | BLOCKED on D-105, D-108 |
| 13 | CMO-008 | Positioning rollout: one spine across landing hero, feed hero, sign-in panel | CMO · Karam · CTO | Copy quality today is inversely proportional to how public the surface is. | TODO after CMO-004 |
| 14 | COO-003 | Run & document 10–15 controlled test auctions (unified close, Friday) | COO + sourcing | Generates the clearing data every open question needs. | TODO |
| 15 | CMO-011 | Organic content calendar weeks 1–2 — production, scheduling, approval | CMO drafts · Karam approves | "Community before ads" made concrete. | TODO (needs COO-003) |
| 16 | COO-004 | Non-paying-winner + delivery-guarantee SOPs | COO | Trust + completion rate. | TODO (needs D-104, D-105) |
| 17 | CMO-001 | Complete Meta domain verification + event priority setup in the "Mazzado" portfolio | CMO + Karam | Needed for conversion optimization. | BLOCKED on Karam (Meta access) |
| 18 | CMO-012 | Pre-register the test plan and decision rules in JOD before any spend; fill the `[FILL]` gaps in `CAMPAIGN_PLAN.md` | CMO · COO | Prevents judging spend on vibes. | TODO (needs D-101, CMO-010) |
| 19 | CTO-003 | Fix top 3 conversion blockers found in the audit | CTO | Membership/bid friction. | TODO (needs CTO-001) |
| 20 | COO-005 | Seller onboarding SOP + listing quality checklist + starting price/reserve guidance | COO | Supply quality & sustainability. | TODO |
| 21 | CMO-003 | Meta campaign build as DRAFTS (not launched) | CMO | **Note:** `CAMPAIGN_PLAN.md` names `Subscribe` as the primary optimization event, and that event does not exist. The plan needs rebuilding on an event that does. | BLOCKED on D-101, D-102, CTO-002 |
| 22 | CTO-004 | Payment-match tooling for manual CliQ verification | CTO | Reduces ops time + errors while the gateway is off. | TODO |
| 23 | COO-006 | Weekly KPI dashboard per the KPI spec | COO + CTO | Weekly review cadence. | TODO |
| 24 | CMO-002 | Community launch content calendar, organic only | CMO | Superseded in practice by CMO-011. | TODO |
| 25 | CMO-015 | Normalise digits to Western across `HowItWorksView.tsx` and `DiscoveryFeedView.tsx` | CTO | Brand consistency on the price itself. | TODO |

## What changed in this merge

- **COO-001 is no longer blocked on data access.** `scripts/analytics/funnel-week1.cjs`
  now exists (orchestrator safety-checked: zero write operations, refuses to run
  without `GOOGLE_APPLICATION_CREDENTIALS`, prints aggregates only, reads
  `auctions` / `orders` / `auctionSecrets` / `subscriptionRequests`). It is
  **unrun**. It is now blocked on Karam running it, which is a different and much
  smaller thing — hence rank 1 as COO-001a.
- **CMO-004 outranks everything except the data pull**, because the orchestrator
  verified its premise on the live site rather than in source.
- **CMO-003 carries a new warning**: the campaign plan optimises for an event
  that does not exist.

## Pending — merged when the audits land

`cto-product` (CTO-005+) and `coo-revenue` (COO-007+) are still running. Their
proposed items, and the tracking-events table several items above depend on, are
merged on completion. Items 7 and 11 above are placeholders from the original
kit backlog, not audit output.

---

## Merged from coo-revenue (2026-10-22)

| # | ID | Item | Owner | Why it matters | Status |
|---|---|---|---|---|---|
| 1b | COO-010 | **Raise average sale value — the real economic problem** | COO + sourcing | **Break-even hammer price is 60 JOD** under the fee model in CLAUDE.md. That is ABOVE the plan's own 50 JOD ASV target and **triple** the proposed 20 JOD minimum. | TODO |
| 2b | COO-007 | **Give the funnel a denominator**: anonymous visits never land (`analytics_events` requires `isSignedIn()`), and landing events stop at a `window.dataLayer` nothing creates | CTO | Without it no registration rate exists, so **plan task 24's influencer gate cannot be evaluated by anyone** (D-107). | TODO |
| 3b | COO-008 | **Record failed handovers as a state** — seller-side sweep, 48h timer, server-side `shippingStatus` advancement | CTO + COO | The 1-in-3 failure rate cannot be reproduced from data today; the script yields a floor. Also blocks "zero failed handovers" from being measurable at all. | TODO |
| 4b | COO-009 | Set the membership-attribution rule, still `[FILL]` at `KPI_DASHBOARD_SPEC.md:30` | Karam · COO | Every per-auction P&L number moves with it. | BLOCKED on D-113 |
| 5b | COO-011 | Audit production for lots created **before** the reserve fix that carry an intended-but-missing reserve | COO | They hide inside `reserve_not_met` and would be wrongly "fixed" by lowering reserves — contaminating the week-1 read. Mechanism fixed; historical data may not be. | TODO |

### Corrections this merge makes to the 27 Sep plan

- **Task 8 (20 JOD minimum) does not fix unit economics.** It cuts the loss from
  ~5.40 to ~4.00 JOD per lot. Break-even is 60 JOD. It is a floor, not the fix;
  ASV is the fix (COO-010).
- **"Registration to bid 40%" is not a conversion rate.** It is bids ÷ registrations
  — events over people. Bidding is membership-gated and 24 of 313 paid, so the true
  ceiling is **7.7%**, about 5.25 bids per bidder. The target "hold at 40%+" holds a
  number that does not mean what it says.
- **Task 14 (6 JOD delivery) introduces a fee that does not exist**, against live copy
  promising ~2–4 JD and free self-collection. See the D-108 amendment.
- **The membership question largely resolves itself with ASV.** Break-even bid
  multiple is ≈4.1 at today's figures (keep) but ≈1.075 at the 50 JOD / 80-sales
  target — its defensibility collapses as ASV rises. Fix ASV first, then revisit.

### Orchestrator correction to that report
It lists silently-lost reserve prices as an **active trap**. **Already fixed** —
`AppContext.tsx:4335` routes the reserve through the `setAuctionReserve` callable,
fails loudly with a bilingual seller notification, and settlement refuses to award
such a lot. The agent read the comment documenting the old bug in past tense.
COO-011 preserves the part that survives.

---

## Merged from cto-product (2026-10-22) — all three audits now in

### Tracking events — the table everything was blocked on

| Event | Fires today? | Where |
|---|---|---|
| `PageView` | **YES** | `src/lib/pixel.ts:26` |
| `CompleteRegistration` | **YES, but racy** | `pixel.ts:31` — see below |
| `PlaceBid` (custom) | **YES** | `pixel.ts:36` |
| `ListItem` (custom) | **YES** | `pixel.ts:45` |
| `ViewContent` | **MISSING** | — |
| `Subscribe` | **MISSING** | — |
| `Purchase` | **MISSING** | — |
| GA4 — anything | **MISSING** | `measurementId: ""` |
| Meta CAPI — anything | **MISSING** | no `graph.facebook.com` in the tree |

`src/lib/pixel.ts` holds four functions. That is the entire Meta integration.

**`CompleteRegistration` is racy.** It sits inside `if (!userSnap.exists())`, but
`users/{uid}` is also written by the `onUserCreated` Auth trigger. When the server
write lands first the pixel is silently skipped — so treat Meta’s registration
count as a **floor**. The undercount cannot be quantified without production data.

**`analytics_events`** — the first-party Firestore funnel — is written reliably and
**read by nothing**. A grep returns only the writer.

| # | ID | Item | Owner | Why it matters | Status |
|---|---|---|---|---|---|
| 1c | CTO-101 | **Instrument the membership paywall** (`membership_gate_shown`) | CTO | **Blocks D-106.** | **DONE 2026-10-22** — see below |
| 2c | CTO-103 | **Meta CAPI relay + `Subscribe` + `Purchase`** | CTO | Both moments are **server-side**, so the pixel cannot reach them at all. Until this exists, **Meta optimises against registrations and bids, never revenue.** 2–3 d. | BLOCKED on D-103 |
| 3c | CTO-102 | `ViewContent` on auction detail | CTO | Unblocks standard retargeting and the campaign plan. 0.5 d. | TODO |
| 4c | CTO-116 | Make the nine landing events real — nothing creates `window.dataLayer` | CTO | On the surface paid traffic actually lands on, **nothing is recorded**. | TODO |
| 5c | CTO-105 | Minimum starting price — **client AND `firestore.rules`** | CTO | Listings are a direct client write with no callable; a client-only floor is cosmetic. | BLOCKED on D-115 |
| 6c | CTO-104 | Browsable ended-auctions / results view | CTO | Confirmed real. No surface shows what anything sold for, while "market-set pricing" is the brand message. | BLOCKED on D-117 |
| 7c | CTO-108 | Fix the flaky `listingDecisionResult.test.tsx` timeout | CTO | Passes alone in 4.2s, times out under full-suite contention. A real CI hazard. | TODO |
| 8c | CTO-110 | Images: `srcset`/`sizes`, WebP, explicit `width`/`height`, stop lazy-loading the LCP card | CTO | A 1280px JPEG into a ~180–360px slot across 8–12 cards is **the biggest byte cost on the feed**. | TODO |
| 9c | CTO-111 | Drop `motion` + `lucide` from `manualChunks` preload | CTO | ~65 KB gzipped off the critical path; neither is needed for first paint. | TODO |
| 10c | CTO-107 | Build a Firebase emulator harness | CTO | **Not configured.** Every `firestore.rules` claim in the audit is read, not executed. | TODO |

### Karam’s five claims — settled against the code

- **Task 11 (video mandatory) — REFUTED. Already fixed.** The step is labelled optional and pinned by a test.
- **Task 12 (cannot relist) — REFUTED. Already fixed.** Four relist paths plus server auto-relist. *Caveat:* a relist re-enters the approval queue as `processing` — if the real complaint was "it never went live", **the queue is the suspect**, not relisting.
- **Task 13 ("All Auctions" live-only) — CONFIRMED, real.**
- **Task 8 (no minimum price) — CONFIRMED, real**, and harder than it looks (CTO-105).
- **Task 3 (name/city screen) — HALF-FIXED.** The wall is gone; a dismissible interests picker replaced it. The complaint stands in substance but is smaller than described.

### Three invisible things that could explain 126 bids to 4 sales

1. **A far-miss below reserve notifies nobody.** `below_reserve_pending` is in-app only; a wide miss fires nothing at all.
2. **Settlement runs up to ~60s late** (cron every 1 min) — the client shows "ended" before the order exists. A blank minute at peak intent.
3. **The settlement sweep is unbounded** — every active/live/upcoming lot re-read every 60s with no `limit()`.

None is confirmed as the cause. That still needs the production pull (COO-001a).

### Build health at merge time

`npm run lint` (tsc --noEmit): **exit 0, clean.**
`npx vitest run`: **1 failed, 3,522 passed** (238 files). The failure is a 20s
timeout in `listingDecisionResult.test.tsx`, which passes alone in 4.2s — flaky
under contention, not a regression. CTO-108.

### CTO-101 shipped (2026-10-22) — not deployed

Three events now exist: `membership_gate_shown`, `membership_gate_cta`,
`membership_gate_dismissed`, each carrying a `source` so the funnel splits by
entry point. They fire **from the modal**, because a fifth path opens the paywall
from the URL (`?modal=subscription`) and is not a call site at all — instrumenting
the four known callers would have produced a number that looked complete.

- `src/utils/membershipFunnel.ts` — sources, metadata, and the signed-in guard
- `src/components/SubscriptionPromptModal.tsx` — fires the three events
- `src/services/analyticsService.ts` — the event types
- `AppContext` / `useBidFlow` / `ProfileView` — each opener now declares its source
- Tests: `membershipFunnel.test.ts` (6) + `membershipGate.wiring.test.ts` (8)

Verified: `tsc --noEmit` clean; full suite **3,537 passing / 240 files**; the
wiring guard proven non-vacuous against an injected blind opener.

**KNOWN GAP — this does not finish the job.** Two things remain before the data is
usable:
1. **Nothing reads `analytics_events`.** The collection is admin-read-only and no
   app surface or script queries it. The events will accumulate where nobody can
   see them until a reader exists — `funnel-week1.cjs` reads auctions/orders, not
   this. **New: CTO-119.**
2. **Anonymous gate views are not counted.** The rules require
   `userId == auth.uid`, so a guest opening `?modal=subscription` directly is not
   recorded. Bounded and deliberate: the bid flow sends a guest to sign-in BEFORE
   the membership step, so the population that matters is signed in.
