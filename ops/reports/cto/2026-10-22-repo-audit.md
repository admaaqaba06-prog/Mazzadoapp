# CTO repo audit — 2026-10-22

Agent: cto-product · Branch: `agent/setup` · Repo root: `MAZADAPPJO-main`
Phase: **AUDIT ONLY — no application code was changed.** The only file this run
created is this report.

## Summary

The funnel is implemented end to end and the server-authoritative parts are sound,
but **the measurement layer is roughly one third built**: of the five events the
growth plan is about to be built on, two fire (`CompleteRegistration`, custom
`PlaceBid`), one of those is racy, and **`ViewContent`, `Subscribe` and `Purchase`
do not exist in the codebase at all** — there is no Meta CAPI anywhere and no GA4
anywhere. The membership paywall's drop-off is **not measurable today**: the
paywall modal has zero instrumentation at all four of its trigger sites, so the
single decision Karam has deferred to data cannot be answered from what the product
currently records. Of Karam's five asserted defects, **two are real (task 13, task 8),
two are already fixed (task 11, task 12), and one is half-fixed** — the name/city wall
is gone but a different mandatory full-screen gate took its place. Auction close is
correct and server-clocked, with 30s/30s anti-sniping and a fail-closed reserve;
its weaknesses are latency (a ≤60s gap between "ended" and the order existing) and
an unbounded per-minute sweep.

---

## Evidence

### What I ran (exact commands, real output)

```
$ npm run lint          # == tsc --noEmit
> react-example@0.0.0 lint
> tsc --noEmit
(no diagnostics)                                    EXIT 0
```

```
$ npx vitest run
 Test Files  1 failed | 237 passed (238)
      Tests  1 failed | 3522 passed (3523)
   Duration  117.04s

FAIL src/context/listingDecisionResult.test.tsx
  > a failed listing write is reported, not swallowed
  > approveListing resolves { success: false } when the write is rejected
  Error: Test timed out in 20000ms.
```

```
$ npx vitest run src/context/listingDecisionResult.test.tsx
 ✓ src/context/listingDecisionResult.test.tsx (8 tests) 4230ms
   ✓ approveListing resolves { success: false } when the write is rejected  4181ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

**Reading:** the single failure is **flaky under full-suite contention, not a
regression** — the same test passes in 4.2s in isolation against a 20s timeout, so
it is losing its budget to parallel-worker CPU contention on this machine, not
failing on behaviour. It is still a real CI hazard (see CTO-108). Note: I piped
both runs through `tail`, so the shell's reported exit code is `tail`'s, not
vitest's; the pass/fail counts above are read from vitest's own summary lines.

**Firebase emulator: NOT configured, so no rules/functions test was run.**
`firebase.json` has no `emulators` block; `@firebase/rules-unit-testing` is not a
dependency of either `package.json`. The only emulator reference in the repo is
`functions/package.json:5` → `"serve": "firebase emulators:start --only functions"`,
which covers Functions only and has no Firestore rules harness behind it. Every
`firestore.rules` statement in this report is therefore **read from the rules file,
not executed**.

### Bundle / critical path measurements

Measured locally with `gzip -9 -c <file> | wc -c` against `dist/assets/` (a local
build dated 2026-09-29 — **stale relative to the live site**, and used here only for
the *shape* of the critical path, which `vite.config.ts` has not changed since).
The live main bundle at 536 KB was measured by the orchestrator and is not
re-measured here.

| Chunk (local build) | raw | gzip | On critical path? |
|---|---:|---:|---|
| `index-Dd7XFk4O.js` (main) | 549,851 | 160,636 | yes — entry |
| `firebase-BN9H9b04.js` | 565,100 | 128,930 | yes — `modulepreload` |
| `motion-CEumuitZ.js` | 158,133 | 52,662 | yes — `modulepreload` |
| `lucide-DYZWD3Bo.js` | 59,234 | 12,253 | yes — `modulepreload` |
| `vendor-BE5WOvBH.js` | 3,893 | 1,532 | yes — `modulepreload` |
| `index-BwngB8OP.css` | 201,902 | 27,540 | yes — render-blocking |
| **total before any image or font** | **1,538,113** | **≈383,553** | |

---

## 1. The funnel in code

| # | Step | Implemented at | Server-side validation | Analytics fired there |
|---|---|---|---|---|
| 1 | Auction feed | `src/hooks/useDiscoverFeed.ts:124` (live), `:139` (upcoming), `:160` (first-bid), `:184` (featured); rendered by `src/components/DiscoveryFeedView.tsx` | `firestore.rules:216` `allow read: if true` — public by design | **PageView only** (`src/context/AppContext.tsx:822`). No feed-level event. |
| 2 | Auction detail | `src/components/LiveStreamView.tsx`, `src/components/MobileAuctionView.tsx`, `src/components/DesktopLiveAuctionLayout.tsx`; single-doc live read `src/hooks/useVisibleAuctionLive.ts:38` | read-only; price/bidder/`reserveMet` are server-written fields | **PageView only**, via the `/auction/:id` route (`src/utils/navUrl.ts:31`). **No `ViewContent`.** |
| 3 | Register / login | `src/components/LoginView.tsx` (WhatsApp OTP primary, Google, email); account doc written `src/context/AppContext.tsx:1192` and server-side `functions/index.js:3369` `onUserCreated` | Firebase Auth; `functions/index.js:3375` — no account is born admin | `trackRegistration()` → **`CompleteRegistration`** at `src/context/AppContext.tsx:1224`; `logAnalyticsEvent('user_registration')` at `:3019` (email path only) |
| 4 | Membership purchase | gate decision `src/utils/guestGate.ts:38` + `:80`; modal `src/components/SubscriptionPromptModal.tsx`; purchase screen `src/components/SubscriptionView.tsx`; submit `src/context/AppContext.tsx:3444` → `requestSubscription` callable; grant `functions/index.js:2800` `approveSubscription` | grant is server-only — `functions/index.js:2806` `assertAdmin`, duration recomputed server-side from the verified tier; subscription-grant fields denied to **all** clients in `firestore.rules` | `membership_submitted` at `src/context/AppContext.tsx:3463` (proof uploaded, **not** paid); `subscription_conversion` server-side at `functions/index.js:2825`. **No `Subscribe` pixel event anywhere.** |
| 5 | Place bid | client gate `src/hooks/useBidFlow.ts:75`; callable `functions/index.js:2243` `placeBid` | full transaction: rate limit `:2274`, ban check `:2297`, membership `:2310`, status `:2334`, end-time `:2346`, min-increment `:2351`; writes via `applyBidWrites` `functions/index.js:2174` | `trackBid()` → custom **`PlaceBid`** at `src/context/AppContext.tsx:3669`; `bid_placed` / `first_bid` at `:3670` / `:3675` — all three behind an `isSimulated` guard at `:3665` |
| 6 | Auction close | `functions/index.js:820` `scheduledAuctionCloser` (every 1 min) → `settleAuctionTxn` `functions/index.js:~460`; decision `functions/settlement.js:98` `resolveSettlement` | entirely server-side; order created inside the settle transaction `functions/index.js:~587` | **none** |
| 7 | Winner notification (WhatsApp) | `functions/index.js:757` `notify({event:'auction_won'})`; channel policy `functions/notify.js:11` `auction_won: ALL`; relay `functions/index.js:92` `postToN8n` (env `N8N_WEBHOOK_URL`) | idempotency key `${auctionId}_auction_won` `functions/index.js:766` | **none** |
| 8 | CliQ payment | embedded rail `src/components/order/CliqPaymentFlow.tsx` → `createCliqPaymentRequest` (`functions/cliqPayment.js`); manual rail `src/components/OrderDetailsView.tsx:590` → `submitOrderPayment` (`functions/orderPaymentSubmit.js`) | embedded rail fail-closed behind `enableCliqGateway`, checked server-side at `functions/index.js:3064`; **flag is OFF in production**, so the live rail is manual. Global txn-ref uniqueness enforced by `paymentReferences` (`firestore.rules`: `allow read, write: if false`) | embedded rail: 9 `cliq_*` events via `src/components/order/CliqPaymentFlow.tsx:105` — **dormant in prod**. Manual rail: `payment_submitted` at `src/components/OrderDetailsView.tsx:603`. **No `Purchase`.** |
| 9 | Order state | FSM `src/utils/orderWorkflow.ts:23` `VALID_TRANSITIONS`; status vocabulary `src/utils/orderStatusGlossary.ts` | orders are `allow create: if false`; every financial field denylisted against buyer, seller **and** admin (settled, per orchestrator context §3) | **none** on any transition |
| 10 | Delivery confirmation | attempt gate `functions/deliveryConfirm.js:36` (max 5 attempts, `:19`); authoritative code check inside `releaseOrderEscrow`'s money transaction | returns `{matched:false}` rather than throwing so the counter commits — `functions/deliveryConfirm.js:5-14` | **none** |

**Structural consequence.** Steps 6–10 are *all* server-side moments. The pixel is a
browser API, so `Subscribe` (fires at admin approval, step 4) and `Purchase` (fires
at payment verification / escrow release, steps 8–10) **cannot be implemented
client-side correctly**. They need Meta CAPI. There is none in the repo.

---

## 2. TRACKING EVENTS TABLE

**This is the deliverable. Read the "fires today" column literally.**

| Event | Expected at funnel step | Fires today? | `file:line` | Channel |
|---|---|---|---|---|
| `PageView` | every route change | **YES** | `src/lib/pixel.ts:26`, called `src/context/AppContext.tsx:822` and `:855` (popstate) | Pixel |
| `ViewContent` | 2 — auction detail opened | **NO — MISSING** | MISSING (no occurrence of the string in `src/`) | none |
| `CompleteRegistration` | 3 — account created | **YES, but racy — see note** | `src/lib/pixel.ts:31`, called `src/context/AppContext.tsx:1224` | Pixel |
| `Subscribe` | 4 — membership granted | **NO — MISSING** | MISSING | none |
| `PlaceBid` (custom) | 5 — server accepted a bid | **YES** | `src/lib/pixel.ts:36`, called `src/context/AppContext.tsx:3669` | Pixel |
| `ListItem` (custom) | seller — listing created | **YES** | `src/lib/pixel.ts:45`, called `src/context/AppContext.tsx:4397` | Pixel |
| `Purchase` | 8–10 — payment verified / order completed | **NO — MISSING** | MISSING | none |
| `InitiateCheckout` | 8 — buyer enters payment | **NO — MISSING** | MISSING | none |
| `Lead` | — | **NO — MISSING** | MISSING | none |
| — any GA4 event — | all | **NO — MISSING** | No `gtag`, no GTM container, no `measurementId` (`src/services/firebase.ts:18` sets it to `""`) | none |
| — any Meta CAPI call — | 4, 6, 8–10 | **NO — MISSING** | No `graph.facebook.com` and no CAPI call anywhere in the repo (grepped whole tree) | none |

### Secondary (first-party Firestore `analytics_events`) — not Meta, not GA4

These exist and are reliable, but **nothing in the product reads them**: `grep -rn
"analytics_events" src/` returns only the writer (`src/services/analyticsService.ts:64`).
There is no dashboard, no export job and no scheduled query.

| Event | Fires at | `file:line` |
|---|---|---|
| `user_registration` | email/password signup only | `src/context/AppContext.tsx:3019` |
| `membership_submitted` | proof uploaded (**not** paid) | `src/context/AppContext.tsx:3463` |
| `subscription_conversion` | admin approves the grant | `functions/index.js:2825` (server) |
| `bid_placed`, `first_bid` | server accepted a bid | `src/context/AppContext.tsx:3670`, `:3675` |
| `bid_spam_blocked`, `rate_limit_triggered` | client pre-checks | `:3611`, `:3629` |
| `auction_created` | listing created | `src/context/AppContext.tsx:4307` |
| `auction_won_seen` | win celebration rendered | `src/components/feedback/WinCelebration.tsx:72` |
| `payment_submitted` | manual CliQ proof submitted | `src/components/OrderDetailsView.tsx:603` |
| 9 × `cliq_*` | embedded CliQ rail | `src/components/order/CliqPaymentFlow.tsx:105` — **dormant: flag OFF in prod** |

### Landing-page events — declared, wired to nothing

`src/landing/landingAnalytics.ts` defines 9 seller-funnel events and pushes them to
`window.dataLayer` (`:45`) — but **only `if (Array.isArray(w.dataLayer))`, and nothing
in `index.html` ever creates `window.dataLayer`.** There is no GTM container. So on
the surface where paid traffic actually lands, **every one of these nine events is a
silent no-op in production.** The file's own header says this is intentional
("ready for a future GA/Segment/GTM wiring") — the point is that the wiring was
never done, and a growth plan that assumes landing-page events exist would be wrong.

### The `CompleteRegistration` race — read this before trusting the number

`trackRegistration()` is inside `if (!userSnap.exists())` (`src/context/AppContext.tsx:1158`,
fired at `:1224`). But `users/{uid}` is **also** written server-side by the Auth
trigger `onUserCreated` (`functions/index.js:3369`, `batch.set(userRef, …)` at `:3380`).
The client's `getDoc` at `:1150` and that server write race. Whenever the server
trigger lands first, the client takes the `else` branch and **`CompleteRegistration`
is silently skipped for a genuinely new account.**

The client usually wins (the trigger has invocation latency, often a cold start),
but this is not guaranteed, and the losing case is exactly the slow-network Jordanian
mobile session the campaign is buying. **I could not quantify the undercount** — it
needs a production comparison of Meta's `CompleteRegistration` count against Firebase
Auth's `creationTime` count over the same window. Treat registration-rate numbers
from Meta as a **floor**, not a measurement, until that comparison is run.

### Also worth knowing for whoever builds on this

`trackPageView` fires on the `/auction/:id` route (`src/utils/navUrl.ts` special-cases
`live` → `/auction/:id`). That means a **URL-based** custom audience for auction
viewers is buildable today. It is *not* a substitute for `ViewContent` — there are no
`content_ids`, so no product-catalogue retargeting, no value optimisation, and no
`ViewContent → PlaceBid` funnel in Events Manager.

---

## 3. Auction-close correctness

**Server clock vs client clock — correct.** The client renders countdowns from
`serverNow()` (`src/utils/serverTime.ts:22`), an NTP-style half-RTT offset derived
from the `getServerTime` callable (`functions/index.js:2227`); `computeServerOffset`
(`src/utils/serverTime.ts:59`) rejects non-finite samples, negative RTT and RTT > 10s
rather than poisoning the offset. The offset is **advisory only** — `placeBid`
re-reads the end time server-side at `functions/index.js:2346` (`resolveAuctionEndMs`)
and compares it to the server's own `Date.now()`, so a tampered client clock affects
only its own UI. Settlement likewise uses `admin.firestore.Timestamp.now()`
(`functions/index.js:822`). **No client-clock authority anywhere.**

**Anti-sniping — present, server-side, 30s/30s.** `applyBidWrites` calls
`computeBidEndTime` (`functions/index.js:2195`), which applies `computeSoftCloseEnd`
(`functions/settlement.js:205`): a bid inside the final `antiSnipeWindowSec` pushes
the end to `now + antiSnipeExtendSec`. Defaults are 30s and 30s
(`functions/settlement.js:188-189`), clamped to 5–120s (`:190-191`), and
`computeSoftCloseEnd` takes `Math.max(currentEndMs, nowMs + extendMs)` so an
asymmetric admin config can **never shorten** an auction. Admins can tune it per
drop (`src/components/admin/MoreSettingsDrawer.tsx:254`); self-serve sellers cannot
(`firestore.rules` forces `antiSnipeWindowSec == 30` and `antiSnipeExtendSec == 30`
on non-admin creates).

> **Stale comment, not a bug.** `functions/index.js:2173` still documents
> "anti-snipe extension (+15s when 0 < timeRemaining < 10s)". The code does 30/30.
> Anyone reading that comment to answer "what is our anti-snipe window" gets the
> wrong answer. (CTO-109.)

**Reserve handling — fail-closed, and notably well done.** The amount lives in
`auctionSecrets/{id}` (admin-write only) and is read **inside** the settle
transaction (`functions/index.js:520`) so a concurrent reserve edit forces a retry
instead of a stale award. `resolveSettlement` (`functions/settlement.js:98`) has a
dedicated branch for "a reserve was intended but its amount is unreadable"
(`:126`) — the intent survives on the public doc as the mere *presence* of
`reserveMet`, and when intent exists without an amount the lot is **refused, not
awarded** (`:132-140`). The reserve is never sent to a client, and the tolerance
band is explicitly a settlement-time gate, never a bid-time one
(`functions/settlement.js:20-29`) — rejecting under-reserve bids would both make a
lot un-biddable up to its reserve and leak the reserve.

**Ends with zero bids →** `resolveSettlement` returns
`{outcome:'unsold', status:'ended'}` (`functions/settlement.js:160`). No order, no
money moved, no notification. If `autoRelist` was opted in, `shouldAutoRelist`
(`functions/settlement.js:375`) allows up to `MAX_AUTO_RELISTS = 2` (`:284`) relists,
blocked while a below-reserve or second-chance offer is live.

**Ends below reserve →** `{outcome:'reserve_not_met', status:'reserve_not_met'}`,
and `offerBelowReserve` is true **only if the top bid is within the tolerance band**
(default 10% of the reserve, clamped 0–50%, `functions/settlement.js:29-31`). Inside
the band the seller gets a 24h window (`BELOW_RESERVE_WINDOW_HOURS`) to accept, then
the top bidder must confirm. **Outside the band the auction simply ends and nobody is
told anything** — `below_reserve_pending` is `INAPP_ONLY` (`functions/notify.js:21`)
and no event fires at all for a far-miss.

### What this says about "126 bids → 4 sales"

The close logic is not the suspect. Three things in it are, and **all three are
currently unobservable**:

1. **A far-miss below reserve is a silent dead end.** No WhatsApp, no email, no
   analytics event, no Pixel event. A bidder who bid 7 times and lost to an invisible
   reserve learns nothing and is never re-engaged.
2. **Settlement is up to ~60s late.** The cron is `every 1 minutes`
   (`functions/index.js:821`). The client shows "ended" at `endTime`; the order does
   not exist until the next sweep. That is a blank minute at the single highest-intent
   moment in the product.
3. **The sweep is unbounded.** `functions/index.js:830` does
   `.where('status','in',['active','live','upcoming']).get()` with **no `limit()`**,
   every 60 seconds, forever. At ~30–80 lots this is cheap; it scales linearly with
   inventory and is a cost and latency cliff, not a correctness bug.

**I cannot tell you which of the four hypotheses actually explains 126→4 from the
code** — that needs the Firestore pull. A read-only script for exactly this
(`scripts/analytics/funnel-week1.cjs`) was created by another agent **during this
session** and is still untracked; it has not been run (it refuses to start without
`GOOGLE_APPLICATION_CREDENTIALS`). Its own caveat at `:643` reaches the same
conclusion I reach independently above: top-of-funnel visits are not recoverable
from Firestore at all.

---

## 4. Karam's five claims from the 27 Sep plan — verified against code

| Task | Claim | Verdict |
|---|---|---|
| **11** | Video upload mandatory when listing | **REFUTED — already fixed** |
| **12** | An unsold auction cannot be re-listed | **REFUTED — already fixed** |
| **13** | "All Auctions" shows only live auctions | **CONFIRMED — real** |
| **8** | No minimum starting price enforced | **CONFIRMED — real** |
| **3** | Mandatory name/city screen blocks the path after signup | **HALF-FIXED — the wall moved, it did not go** |

### Task 11 — REFUTED (already fixed)

Video is optional and photos alone suffice. `src/components/ListingWizardView.tsx:145`
gates on `draftHasMedia({thumbnailFile, videoFile, gallery})` — the shared one-rule
media gate at `src/utils/listingMedia.ts:26`, which returns true for **any** of cover,
gallery or video. The error copy at `:148` reads "Add at least one piece of media: a
video or a cover image." Step 1 is labelled `Product Video (Optional)` / `(اختياري)`
at `:352`. A regression test pins it: `src/components/optionalUploads.wiring.test.ts`
asserts the old `"Please upload a video first"` string is gone and that a cover image
alone passes. The same gate is enforced on the admin drop builder
(`src/utils/dropFormState.ts:108`, both call sites pinned by
`src/components/dropBuilderMediaGate.wiring.test.ts`).

### Task 12 — REFUTED (already fixed)

Four relist paths exist:
- Seller, per lot: `src/components/SellerCenterView.tsx:1499` → `handleDuplicate`
  (`:810`), available whenever `auction.status !== 'live' && !== 'upcoming'` (`:1414`).
- Seller, bulk: `src/components/SellerCenterView.tsx:1606` → `handleRelistSelected` (`:984`).
- Seller prompt: `src/components/seller/sellerActions.ts:71` surfaces an
  "Auctions ended — relist" action, driven by `isUnsoldAuction` (`:38`), which counts
  `ended`, `reserve_not_met`, and `completed`-with-no-order.
- Admin: `src/components/DropsListPanel.tsx:111` shows Relist for
  `['reserve_not_met','ended']`; `src/components/AuctionDropBuilderView.tsx:554`
  `handleRelist` prefills the builder.
- Plus server-side auto-relist: `functions/settlement.js:375`, up to 2×.

A relist is a **new listing at `status:'processing'`** that re-enters the approval
queue (`src/components/SellerCenterView.tsx:836`). That is correct, but it does mean
a relist is not instant — if Karam's complaint was really "I relisted and it didn't
go live", the approval queue is the thing to look at, not the relist button.

### Task 13 — CONFIRMED (real)

The public feed can only show live and upcoming lots. Every query is status-scoped:
`where('status','==','live')` at `src/hooks/useDiscoverFeed.ts:127`, `:164`, `:188`,
`:498`, and `where('status','==','upcoming')` at `:142`. The live query additionally
excludes anything past its end server-side —
`where('endsAt','>', Timestamp.fromMillis(serverNow()))` at `:131`. The landing page
is the same: `where('status','==','live')` at `src/landing/useLandingAuctions.ts:173`.

**There is no browsable ended/results view anywhere in the product.** The only read
of finished auctions is `src/hooks/useSocialProof.ts:119`
(`where('status','in',['completed','ended','closed'])`, `limit(24)`), and that feeds
a "recent wins" trust strip, not a list a visitor can browse.

Business weight: this is the cheapest credibility asset the marketplace already owns
and throws away. "Market-set pricing" is CLAUDE.md's core brand message, and the
product currently has **no surface on which a visitor can see what anything actually
sold for.** Prices paid are also the single most convincing answer to "is this real?".

### Task 8 — CONFIRMED (real)

No minimum starting price exists at any layer.
- Admin drop builder: `src/utils/dropFormState.ts:97-98` —
  `if (!Number.isFinite(price) || price <= 0) errors.startingPrice = 'REQUIRED'`.
  **Any positive number passes**, including 0.001 JOD.
- Seller wizard: `src/components/ListingWizardView.tsx` / `src/components/SellView.tsx`
  carry no price floor.
- Server: there is **no `createListing` callable** — listings are a direct client
  Firestore write from `src/context/AppContext.tsx:4046`, policed by
  `firestore.rules:276` onward. Those rules constrain status, schedule, bid/winner
  seeding, `paymentWindowHours`, anti-snipe and `viewing` — **but say nothing about
  `startingPrice`.** `grep -n startingPrice firestore.rules` returns only lines 224,
  318 and 331, none of which is a floor.

So a 20 JOD minimum needs **two** changes to be real, not one: the client validator
(`src/utils/dropFormState.ts:98` plus the two seller forms) **and** `firestore.rules`.
A client-only fix is cosmetic here, because the write path is the client.

One nuance worth flagging to Karam before he sets the number: a low *starting* price
is the standard auction mechanic for generating early bids, and the plan's own
hypothesis is that the problem is the *clearing* price, not the opening one. A reserve
floor and a starting-price floor are different levers. The code already supports
reserves properly (§3).

### Task 3 — HALF-FIXED

**The name/city wall is genuinely gone.** `src/App.tsx:329-343` documents its removal
explicitly: it used to render full-screen and non-dismissable until the user had both
a name and a city, and **every phone signup hit it by construction** because the new
user doc is written with `name: 'User'` and `city: ''`
(`src/context/AppContext.tsx:1163`, `:1185`). Both fields are now collected at the
moment they are used — name at the bid gate (`src/utils/guestGate.ts:80`), city at
the win, as a delivery address.

**But a different mandatory full-screen gate now sits in the same place.** The
interests picker: `src/App.tsx:230` computes `interestsGateOpen`, `:235` forces the
view, and `:364-391` renders it **outside `DesktopFrame`, so there is no nav bar to
escape through** — the comment at `:357` says that is deliberate ("forced through the
screen once"). It triggers for any authenticated user whose `interests` array is
empty (`src/utils/interests.ts:130-142`), which is **every new account**.

Mitigation: there is a visible "Skip for now" / "تخطي الآن" button
(`src/components/InterestsPicker.tsx:283-286`) that sets `interestsSkipped: true`
(`:120`) and exits permanently. So it is **one dismissible tap**, not the old wall.

**Verdict: Karam's complaint still stands in substance — a mandatory screen still
interrupts the path right after signup — but it is a materially smaller one than he
described, and it is skippable.** Whether it should exist at all is a conversion
question, and **today it is unmeasurable**: the gate fires no event, and the skip
fires no event, so nobody can say how many people skip, how many bounce, or whether
the interests data it collects is ever used.

---

## 5. The membership paywall

**Where the gate sits.** One ordered gate, declared in exactly one place:
`BID_GATE_ORDER` at `src/utils/guestGate.ts:80` — `signin → membership → name →
photo → contact`. Resolved by `resolveBidGate` (`:107`), consumed by
`useBidFlow.startBid` (`src/hooks/useBidFlow.ts:75`). `membership` opens the
paywall via `setShowSubscriptionPrompt(true)` (`src/hooks/useBidFlow.ts:82`).

The file's own header (`src/utils/guestGate.ts:64-78`) says the paywall's position
in that array is **provisional pending Karam's decision**, and deliberately keeps each
step an independent predicate so membership can be moved or removed by editing one
line. That is good engineering and it means **the removal experiment is cheap to run**
— the obstacle is not the code, it is that we cannot currently measure the outcome.

**What a guest can do before paying.**

| | Logged-out guest | Signed-in non-member | Paid member |
|---|---|---|---|
| Browse Discover, open a lot, view media/price/countdown | yes (`GUEST_ALLOWED_VIEWS`, `src/utils/guestGate.ts:10`) | yes | yes |
| Landing, How-it-works, Prohibited items | yes | yes | yes |
| **Place a bid** | no → signup (`resolveBidTap`, `:39`) | no → **paywall** (`:40`) | yes |
| Chat, save/watchlist, sell, profile, orders, wallet | no → signup (`resolveGuestWriteAction`, `:44`) | yes | yes |

The guest-browsing path is a production kill switch — `enableGuestBrowsing`
(`src/utils/guestGate.ts:124`), fail-open, only an explicit `false` disables it.
So the paywall is the **second** gate a visitor meets, after signup. A visitor must
create an account *and then* pay before placing a first bid.

### Is its drop-off measurable today? **NO.**

This is the finding that matters most in this report, because CLAUDE.md now records
the membership as **HELD, pending data**, and the data does not exist.

**The paywall modal is completely uninstrumented.** `src/components/SubscriptionPromptModal.tsx`
has **zero** analytics imports and zero event calls — I read the whole file. It has
three exits (`handleJoin` `:13`, `handleHowItWorks` `:18`, the X at `:32`) and **none
of them records anything.** Its four trigger sites fire nothing either:
`src/hooks/useBidFlow.ts:82`, `src/context/AppContext.tsx:3578`, `:3697`,
`src/components/ProfileView.tsx:575`.

`src/components/SubscriptionView.tsx` — the purchase screen itself — has **no
`logAnalyticsEvent` call and no pixel call** anywhere in its 650+ lines.

So the measurable chain is:

```
bid tap by a non-member ──────── NOT RECORDED
paywall modal shown ──────────── NOT RECORDED
modal dismissed (X / back) ───── NOT RECORDED
"Join" tapped ────────────────── NOT RECORDED
subscription screen viewed ───── only a PageView on /wallet  <- weak proxy
tier chosen ────────────────────  NOT RECORDED
payment proof uploaded ───────── membership_submitted   (AppContext.tsx:3463)
admin approves the grant ─────── subscription_conversion (functions/index.js:2825)
```

**Everything before the proof upload is invisible.** We can count how many people
*finished* paying; we cannot count how many *saw the ask*. That is precisely the
denominator the keep-or-remove decision needs — "24 of 313 registrations paid" is a
registration-to-payment rate, not a paywall conversion rate, and the two differ by
however many registrants never tapped bid at all.

The one partial proxy: route changes push `/wallet` (`src/utils/navUrl.ts:35`) and
`trackPageView()` fires on that (`src/context/AppContext.tsx:822`), so a Meta
URL-based custom conversion on `/wallet` would approximate "reached the subscription
screen". It cannot see the modal impression or the dismissal, and it cannot
distinguish a bid-triggered arrival from a nav-bar tap.

**And even the events that do fire are not readable.** `analytics_events` is written
by `src/services/analyticsService.ts:65` and **read by nothing in the application** —
`grep -rn "analytics_events" src/` returns the writer and two comments. There is no
dashboard, no export job, no scheduled query. Answering this question today means
someone runs an ad-hoc Firestore query by hand. (The untracked
`scripts/analytics/funnel-week1.cjs`, written by another agent during this session,
would be that query — it has not been run.)

**Minimum instrumentation to make the decision answerable** (CTO-101 — four events,
all cheap): `membership_gate_shown` (with the trigger source),
`membership_gate_dismissed`, `membership_tier_selected`, and a `Subscribe` **CAPI**
event at `functions/index.js:2825` where the grant actually happens. The first two
are the whole decision; without them any removal test produces a number nobody can
interpret.

---

## 6. Mobile performance — Jordanian mobile is the constraint

The 536 KB live main bundle is the *smallest* part of this problem. Measured above:
**≈383 KB gzipped of JS+CSS must arrive, parse and execute before anything renders**,
and that is before a single image or font byte.

**1. Four chunks are `modulepreload`-ed at top priority, two of which are not needed
for first paint.** `dist/index.html` preloads `motion`, `vendor`, `firebase`,
`lucide`. `motion` is 52.7 KB gzipped (158 KB raw) of animation library and `lucide`
is 12.3 KB gzipped of icons — neither is required to paint a feed card, and both
compete for bandwidth with the main bundle on a 3G/mid-tier Android connection. They
are declared in `vite.config.ts:25-30` `manualChunks`, which is what forces them into
the entry graph and therefore into the preload set.

**2. The stylesheet is 197 KB raw / 27.5 KB gzipped and render-blocking.** For a
Tailwind 4 build that is large, and it is on the critical path with no `media` trick
and no critical-CSS inline.

**3. Fonts: two families, ten weights, cross-origin.**
`index.html:159-163` requests `Readex Pro` at 300/400/600/700/800 **and** `Tajawal` at
400/500/700/800/900 from Google Fonts. Mitigations are already in place and are good
— `preconnect` to both Google hosts (`:157-158`), `preload as="style"`, the
`media="print" onload="this.media='all'"` non-blocking trick, and `display=swap`.
But ten weights across two families on a third-party origin is still a third-party
connection plus up to ten font files on the critical path for text LCP, and the
Arabic family (Tajawal) is the one that matters for the actual audience. Arabic
subsets are large.

**4. Images — good hygiene, three gaps.** `src/utils/resizeImage.ts:33-34` resizes
uploads to 1280px longest edge at JPEG q0.8 **before** they leave the device, and
never throws (falls back to the original on any failure) — genuinely well done, and
`createListing` resizes thumbnails specifically (`src/context/AppContext.tsx:4087`).
`src/components/ui/ListingImage.tsx:92` sets `loading="lazy"`. The gaps:
- **No `width`/`height` and no `aspect-ratio`** on the `<img>` (`:87-100`) → layout
  shift on every card as images arrive. CLS is a ranking and a perceived-speed factor.
- **No `srcset`/`sizes` and no WebP/AVIF.** A 1280px JPEG is served into a card that
  is ~180–360 CSS px wide on a phone. With ~8–12 cards above and just below the fold,
  that is the single largest byte cost on the feed — plausibly several MB — and it is
  entirely avoidable with Storage-side resized variants or an image CDN.
- `loading="lazy"` is applied **uniformly**, including to the first card, which
  delays the LCP element. The first 1–2 cards should be `loading="eager"` +
  `fetchpriority="high"`.

**5. Firestore reads on first feed paint — better than I expected, but still heavy.**
The broad public `auctions` listener was already removed
(`src/context/AppContext.tsx:1688-1692`: buyer surfaces map to `'none'` and open
nothing; only admin tooling keeps a broad list). That is the right architecture and
it is already done. What remains on a cold guest load of `/discover`:

| Source | Reads | `file:line` |
|---|---:|---|
| `siteSettings/maintenanceMode` + `featureFlags` (2 × `onSnapshot`) | 2 | `src/context/AppContext.tsx:1428`, `:1449` |
| live feed page 1 — `PAGE = 24` | ≤24 | `src/hooks/useDiscoverFeed.ts:365`; `src/utils/discoverQuery.ts:9` |
| upcoming — `PAGE = 24` | ≤24 | `:366` |
| first-bid preview — `ALL_TAB_FIRST_BID_LIMIT = 8` | ≤8 | `:368`; `src/utils/discoverQuery.ts:67` |
| featured — `FEATURED_CAP = 6` | ≤6 | `:370`; `src/utils/featuredRank.ts:13` |
| new-drops detector `onSnapshot` `limit(1)` | 1 | `src/hooks/useDiscoverFeed.ts:492` |
| social proof `getDocs` `limit(24)` | ≤24 | `src/hooks/useSocialProof.ts:116` |
| **per visible card**, one live `onSnapshot` each | +N | `src/hooks/useVisibleAuctionLive.ts:38` |
| **cold-load subtotal** | **≈89 + N listeners** | |

Two specifics worth acting on: **`upcoming` fetches 24 docs for a strip that shows a
handful**, and **social proof costs 24 reads for a trust chip** — it is cached per
session (`:112`) but not across sessions. On the landing page the equivalent is a
single `limit(60)` fetch (`src/landing/useLandingAuctions.ts:173`), cached per session
(`:166`), curated down client-side — 60 full documents fetched to render a small
curated set is the same pattern.

**Caching is correct**: `firebase.json` sets `Cache-Control: public, max-age=31536000,
immutable` on `/assets/**`, and a service worker is registered in production only
(`src/main.tsx:93-103`).

---

## 7. Proposed backlog items

Impact is against the funnel in CLAUDE.md rule 6. Effort is engineering days.

| ID | Item | Impact | Effort | Owner |
|---|---|---|---|---|
| **CTO-101** | **Instrument the membership paywall.** `membership_gate_shown` (+ trigger source), `membership_gate_dismissed`, `membership_tier_selected`, at `src/components/SubscriptionPromptModal.tsx` and `src/components/SubscriptionView.tsx`. **Blocks the keep-or-remove decision.** | Critical | 0.5 d | cto-product |
| **CTO-102** | **Add `ViewContent`** on auction detail with `content_ids=[auctionId]`, `value`, `currency:'JOD'`, fired on confirmed render in `LiveStreamView`/`MobileAuctionView`, matching the `src/lib/pixel.ts` house rule (server-confirmed state, never a tap). Unblocks catalogue retargeting and the `ViewContent→PlaceBid` funnel. | Critical | 0.5 d | cto-product |
| **CTO-103** | **Build the Meta CAPI relay** and emit `Subscribe` at `functions/index.js:2825` and `Purchase` at payment-verified / escrow-release. These moments are server-side and **cannot** be done with the pixel. Include an `event_id` dedup key so browser events can be deduped later. | Critical | 2–3 d | cto-product |
| **CTO-104** | **Ship an ended-auctions / results view** (task 13). Reuse `mapFeedDoc`; add a `status in ['completed','ended','reserve_not_met']` query ordered by `endsAt desc`. Needs one composite index. Direct answer to the "market-set pricing" brand message. | High | 1–2 d | cto-product |
| **CTO-105** | **Enforce a minimum starting price** (task 8) in **both** `src/utils/dropFormState.ts:98` (+ the two seller forms) **and** `firestore.rules` auction-create — the write path is the client, so a rules change is mandatory. Amount is Karam's (CLAUDE.md rule 8). | High | 0.5 d | cto-product |
| **CTO-106** | **Decide and instrument the post-signup interests gate** (task 3). Minimum: fire `onboarding_interests_shown` / `_skipped` / `_completed` so the drop-off is visible before anyone argues about removing it. | High | 0.5 d | cto-product |
| **CTO-107** | **Make `analytics_events` readable.** A scheduled aggregation (or BigQuery export) plus an admin funnel panel. The data is being collected and nothing can read it. Note `scripts/analytics/funnel-week1.cjs` (untracked, another agent's, unrun) covers the one-shot case. | High | 1–2 d | cto-product |
| **CTO-108** | **Fix the flaky test.** `src/context/listingDecisionResult.test.tsx` takes 4.2s solo against a 20s timeout and fails the full run on contention. Raise that test's timeout or cap `poolOptions.threads.maxThreads` in `vitest.config.ts`. A red CI nobody trusts is a gate that does not gate. | High | 0.25 d | cto-product |
| **CTO-109** | **Correct the stale anti-snipe comment** at `functions/index.js:2173` ("+15s / 10s window"); the code is 30s/30s (`functions/settlement.js:188-189`). Comment-only. | Medium | 0.1 d | cto-product |
| **CTO-110** | **Images: add `width`/`height` (CLS), `srcset`/`sizes` + WebP variants, and `loading="eager" fetchpriority="high"` on the first 1–2 feed cards.** `src/components/ui/ListingImage.tsx:87-100`. Largest single byte win on the feed. | High | 1–2 d | cto-product |
| **CTO-111** | **Trim the preload graph.** Drop `motion` and `lucide` from `manualChunks` (`vite.config.ts:25-30`) so they stop being `modulepreload`-ed at top priority; lazy-load `motion`. ≈65 KB gzipped off the critical path. | High | 0.5 d | cto-product |
| **CTO-112** | **Cut font weights.** Ten weights across two families (`index.html:159-163`); most UI uses 3–4. Consider self-hosting the Arabic family (Tajawal) subset to remove a third-party origin from text LCP. | Medium | 0.5 d | cto-product |
| **CTO-113** | **Bound the settlement sweep.** `functions/index.js:830` runs an unbounded `.get()` over all active/live/upcoming lots every 60s. Add `where('endsAt','<=',now).limit(N)` with cursor continuation. Cost/latency, not correctness. | Medium | 0.5 d | cto-product |
| **CTO-114** | **Close the far-miss dead end.** An auction ending below reserve and **outside** the tolerance band notifies nobody (`functions/notify.js:21` is `INAPP_ONLY`; nothing fires for a far miss). Add a "you were outbid by the reserve / here is what else is live" message for the top bidder. Direct re-engagement of exactly the bids that did not convert. | Medium | 1 d | cto-product |
| **CTO-115** | **Shrink the ended→order gap.** Up to ~60s between the client showing "ended" and the order existing (`functions/index.js:821`). Either a "finalising…" state on the auction screen or an on-demand settle on winner page-load. Highest-intent moment in the product. | Medium | 1 d | cto-product |
| **CTO-116** | **Wire or delete the landing events.** The nine events in `src/landing/landingAnalytics.ts` push to a `window.dataLayer` nothing ever creates — they are silent no-ops on the surface paid traffic lands on. Add GTM/GA4, or delete them so nobody plans around them. | High | 0.5 d | cto-product |
| **CTO-117** | **Quantify the `CompleteRegistration` race** (`src/context/AppContext.tsx:1150` vs `functions/index.js:3380`), then make the event unconditional by firing it from a dedicated "first session for this uid" marker instead of `!userSnap.exists()`. | Medium | 0.5 d | cto-product |
| **CTO-118** | **Reduce first-paint Firestore reads:** drop `upcoming` from 24 to ~8, and persist the social-proof result (24 reads/session) in `localStorage` with a TTL. ≈40 reads per cold visit. | Low | 0.5 d | cto-product |

---

## Decisions needed from Karam

1. **Meta CAPI — approve the build (CTO-103).** `Subscribe` and `Purchase` happen on
   the server and cannot be done any other way. Until this exists, **Meta is optimising
   campaigns against registrations and bids, never against revenue.** This is the single
   highest-leverage item in this report.
2. **GA4 — do we want it at all?** There is none, and `measurementId` is empty
   (`src/services/firebase.ts:18`). `ops/KPI_DASHBOARD_SPEC.md:7-8` names GA4 as the
   source of truth for Visitors and Auction views. Either we add it or the KPI spec's
   top two rows have no source. Decision, not an engineering question.
3. **The minimum starting price amount (CTO-105).** The plan says 20 JOD. CLAUDE.md
   rule 8 makes the number Karam's. Also worth his attention: a starting-price floor and
   a reserve floor are different levers, and the code already supports reserves well —
   a low opener with a sensible reserve may serve the goal better than a high opener.
4. **The membership.** I am not proposing either way — CLAUDE.md says quantify. My
   position is narrower: **do not run a removal test until CTO-101 ships**, because
   without `membership_gate_shown` the result is a number nobody can interpret.
5. **The post-signup interests gate (task 3).** It is one skippable tap, not the wall
   Karam described. Keep it, move it after the first bid, or remove it — but instrument
   it first (CTO-106).
6. **The ended-auctions view (CTO-104).** Product decision as much as engineering:
   showing real clearing prices is the strongest possible support for the "market-set
   pricing" message, and also exposes lots that ended cheap or unsold. Worth his call.
7. **The far-miss silence (CTO-114).** Messaging a bidder that they lost to a reserve
   touches customer communication — CLAUDE.md rule 2 territory.

---

## What I could NOT verify, and why

1. **Anything requiring the Firebase emulator.** Not configured — no `emulators` block
   in `firebase.json`, no `@firebase/rules-unit-testing` in either `package.json`. Every
   `firestore.rules` statement here is **read, not executed**. In particular I could not
   execute-test the auction-create rules I rely on for task 8.
2. **Whether `CompleteRegistration` actually undercounts in production, and by how
   much.** The race at `src/context/AppContext.tsx:1150` vs `functions/index.js:3380` is
   real in the code; its production frequency needs a Meta-vs-Firebase-Auth comparison
   over the same window. Not runnable from here. (CTO-117.)
3. **Whether the live site's deployed bundle matches this tree.** `dist/` here is a
   local build from 2026-09-29 and is stale; I used it only for critical-path *shape*,
   which `vite.config.ts` has not changed. I did **not** re-measure the live bundle (the
   orchestrator's 536 KB stands) and I did **not** fetch the live site.
4. **Real Lighthouse / field numbers on a Jordanian mobile connection.** Everything in
   §6 is byte counts and code reading. No LCP, CLS or TTI figure is claimed, because I
   measured none. The image numbers are reasoning about 1280px JPEGs in ~180–360px
   slots, not a measured payload.
5. **Which of the four "126 bids → 4 sales" hypotheses is true.** Not answerable from
   code — it needs the production Firestore pull. The read-only script for it
   (`scripts/analytics/funnel-week1.cjs`) was created by another agent **during this
   session**, is untracked, and **has not been run** (it refuses to start without
   `GOOGLE_APPLICATION_CREDENTIALS`). I did not run it: that is a production read and
   not my task.
6. **Whether the `cliq_*` events ever fire in production.** They are behind
   `enableCliqGateway`, which the orchestrator's context records as OFF in production. I
   verified the server-side gate (`functions/index.js:3064`) and the client read
   (`src/components/OrderDetailsView.tsx:108`); I did **not** read production
   `siteSettings/featureFlags` to confirm the live value.
7. **Whether the n8n WhatsApp workflow actually delivers.** `postToN8n`
   (`functions/index.js:92`) no-ops when `N8N_WEBHOOK_URL` is unset, and I did not read
   production function config or touch n8n. A saved n8n node edit is only a draft —
   production serves `activeVersionId` until Publish — so the committed
   `n8n/webhook-receiver-v2.json` is not evidence of what is live.
8. **How many `onSnapshot` listeners a real feed session opens.** `useVisibleAuctionLive`
   opens one per *visible* card with refcounting; the actual N depends on viewport,
   scroll depth and the IntersectionObserver thresholds, which I did not instrument.
9. **Whether the interests data the onboarding gate collects is used for anything.** I
   found the writer (`src/components/InterestsPicker.tsx:120`) and
   `src/hooks/useInterestCategories.ts`, but did not trace whether it meaningfully
   changes what any user sees.
