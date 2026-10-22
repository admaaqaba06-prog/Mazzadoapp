# CMO — Positioning & Channel Audit
**Date:** 2026-10-22 · **Author:** cmo-growth · **Branch:** `agent/setup`
**Status: DRAFT. Nothing here is published, launched, or shipped. No ad was created, edited, paused or boosted. No copy in the repo was changed by me.**

---

## Summary

MAZZADO has no campaign data of any kind in this repo — no Meta export, no GA4, no Firestore aggregate — so this audit makes no claim about CTR, CPC, CAC or ROAS, and plans the measurement instead. What it does have is primary evidence: the live customer-facing copy. Reading it, the Instagram ban looks less like an accident of the influencer spike and more like a standing property of the landing page: it pairs a **1 JOD paid membership to bid** with a **1 JOD opening price on an iPhone 17 Pro Max**, which is the textbook shape of a bidding-fee ("penny") auction — the thing Meta's automated review is built to catch. The fix is framing, not business model: MAZZADO charges a flat monthly subscription with unlimited free bids, which is *not* a bidding-fee auction, and the page currently hides that true distinction behind hype.

The second finding is that the codebase already knows this. `src/components/signInPanelCopy.test.ts:57` fails the build if the sign-in panel says "أرخص / cheapest / best price" — while `src/landing/translations.ts:180` ships "اشترِ بأرخص سعر." as the landing page H1. The guard exists; it just doesn't cover the page the ads point at.

Third: the Meta Pixel fires PageView, CompleteRegistration, PlaceBid and ListItem, but **Subscribe does not exist anywhere in the repo** — and `ops/CAMPAIGN_PLAN.md:13` names Subscribe as the primary optimization event for the whole paid plan. GA4 is not installed at all, and every landing-page funnel event is silently discarded.

---

## Evidence

Every line below was read in this session at the stated path. `[plan 2026-09-27]` = Karam's stated figures in `ops/data/2026-09-27-60-day-plan.karam-stated.md` — **STATED, not measured**.

### What data exists
| Asset | State |
|---|---|
| `ops/data/` | One file: `2026-09-27-60-day-plan.karam-stated.md`. **No Meta, GA4, Firestore or ledger export exists.** Verified by directory listing. |
| Meta Ads export | Absent |
| GA4 export | Absent |
| Firestore aggregate | Absent |
| A Meta ban notice / policy citation | Absent. The ban's cause is **Karam's inference** `[plan 2026-09-27, p.6]`, not a quoted Meta decision. |

### Tracking code that actually exists
| Event | Where | Fires when |
|---|---|---|
| Pixel init | `index.html:40` (deferred loader `index.html:45–62`) | On first pointer interaction, or load + 1200 ms |
| `PageView` | `src/lib/pixel.ts:26` → `src/context/AppContext.tsx:822`, `:855` | Every SPA route change, after the URL commits |
| `CompleteRegistration` | `src/lib/pixel.ts:31` → `src/context/AppContext.tsx:1224` | After the user doc write resolves; covers phone OTP, Google and email |
| `PlaceBid` (custom) | `src/lib/pixel.ts:36` → `src/context/AppContext.tsx:3669` | After the server accepts the bid; simulated lots excluded (`AppContext.tsx:3662`) |
| `ListItem` (custom) | `src/lib/pixel.ts:45` → `src/context/AppContext.tsx:4397` | After the listing is written |

**Absent from the entire repo** (grep across `src/` and `functions/`): `Subscribe`, `ViewContent`, `Purchase`, any Conversions API call, any `gtag`/GTM container, any `getAnalytics()`. `VITE_FIREBASE_MEASUREMENT_ID` is present in `src/services/firebase.ts:18` but nothing consumes it.

**Landing-page analytics are a no-op in production.** `src/landing/landingAnalytics.ts:45` pushes to `window.dataLayer` only `if (Array.isArray(w.dataLayer))`. Nothing in `index.html` creates `window.dataLayer`. So `landing_viewed`, `browse_cta_clicked`, `seller_cta_clicked`, `auction_register_clicked` and four others are built and then dropped on the floor. The file says so itself at line 5 ("ready for a future GA/Segment/GTM wiring") — that future never arrived.

### Fee model — three different stories live in the product at once
| Source | What it says |
|---|---|
| `CLAUDE.md:8` | 5% seller + 5% buyer + membership. No delivery fee. |
| `src/content/legalTerms.ts:172` | 5% buyer above hammer, 5% from seller proceeds, membership separate. **No delivery clause anywhere in the file.** |
| `src/components/HowItWorksView.tsx:75` | "توصيل بأجرة بسيطة (٢–٤ دنانير تقريباً)" — ~2–4 JOD |
| `[plan 2026-09-27]` task 14 | Information pages state **6 JOD**; terms must be updated; lawyer review required |
| `src/landing/translations.ts:190` | "توصيل خلال 48 ساعة" — a 48-hour delivery promise, no price |

The string `6 JOD` / `6 دنانير` appears **nowhere** in `src/`. So the plan's "information pages state 6 JOD" is not reproducible at this commit; what is actually shipped is ~2–4 JOD on one page, a 48-hour promise on another, and silence in the terms.

---

## Findings, ranked by impact

### F1 — The landing page reads as a bidding-fee auction. That is the ad-policy problem, and it is structural, not a slip.
Two facts sit on the same public page:
- You must pay **1 JOD/month** to be allowed to bid (`src/landing/LandingView.tsx:2425`, `translations.ts:346`).
- An **iPhone 17 Pro Max** has an opening price of **"1 دينار فقط"** (`src/landing/translations.ts:167`, rendered `src/landing/components/IPhoneAuctionSection.tsx:171`, mounted on the live page at `src/landing/LandingView.tsx:1891`).

To an automated classifier those two facts *are* a penny auction: pay a fee for the right to bid, win a high-value good for near-nothing. Add a 50× traffic spike from an influencer campaign and you get exactly the outcome `[plan 2026-09-27, p.6]` describes.

**MAZZADO is not a bidding-fee auction, and the difference is defensible.** The membership is a flat monthly subscription with *unlimited* bidding (`src/components/HowItWorksView.tsx:49–60`); bids themselves are free; the winner pays the hammer price plus a published 5%. Nothing is consumed per bid. That distinction is true, it is checkable, and it belongs at the top of any appeal — but today the page buries it under "يبدأ من 1 دينار فقط" and the reviewer never reaches it.

This also collides with the plan's own rules: `[plan 2026-09-27]` task 8 sets a **20 JOD minimum starting price** and "No auctions under 20 JOD" — so the 1-dinar iPhone announcement would be non-compliant with MAZZADO's own policy even if Meta did not exist. And `ops/CAMPAIGN_PLAN.md:48` already permits the 1-dinar hook *"only if a real item starts at that price"* — a condition task 8 is designed to make permanently false. Three documents already forbid this string. It is still on the page.

**Impact: blocks the entire paid channel. Cost to fix: one copy change, zero engineering.**

### F2 — The copy guard exists and does not cover the page the ads point at.
`src/components/signInPanelCopy.test.ts` is a real, passing, enforced test that fails the build if the sign-in panel contains:

| Forbidden at `signInPanelCopy.test.ts` | Line | Shipped anyway on the landing page |
|---|---|---|
| `/cheapest\|best price\|أرخص\|أفضل سعر/i` | `:57` | `translations.ts:180` "اشترِ بأرخص سعر." · `:427` "Buy for less." |
| `/verified sellers\|بائعون موثوقون/i` | `:58` | `translations.ts:211` "بائعون موثّقون" · `:456` "Verified Sellers" · `DiscoveryFeedView.tsx:1508` |
| `/guarantee\|ضمان\|نضمن/i` | `:54` | `translations.ts:318` "نضمن لك الدفع الآمن" |
| `/24 hours\|خلال 24\|next day/i` | `:56` | `translations.ts:190` "توصيل خلال 48 ساعة" (same class of promise) |

Someone on this team already decided these claims are unsafe and wrote a machine to enforce it. The machine was pointed at the one surface that was already clean. **Extending the same guard to `src/landing/translations.ts` is the cheapest durable fix in this report** and it converts "a CMO reviewed the copy once" into "the build fails if it regresses". (CTO work — I propose it, I do not write it.)

### F3 — Subscribe does not exist, so the paid plan cannot run on its own stated objective.
`ops/CAMPAIGN_PLAN.md:13` chooses Subscribe (the 1 JOD membership) as the primary optimization event, on sound reasoning: cheap, frequent, and the genuine "serious bidder" signal. **It is not implemented.** Nor are `ViewContent` or `Purchase`. Detail in §4 below.

### F4 — The hero labels a simulated lot "Real Photos".
`src/landing/translations.ts:196–197` / `441–442` render a "Toyota Camry 2022 · صور حقيقية · عمّان" with a live-looking bid counter driven by `src/landing/heroSim.ts` (`driftWatchers`, `stepPrice`, anti-snipe bump — all random). The widget is honestly named *simulator* in code and in the Arabic section heading (`translations.ts:258` "محاكاة تفاعلية"), but the card itself asserts "صور حقيقية / Real Photos" and "✓ بائع موثق / Verified Seller" with no "illustrative" marker. This is a misrepresentation exposure independent of Meta — and it is the kind of thing a Jordanian consumer-protection complaint or a screenshot on social media turns into a trust problem overnight.

### F5 — Delivery: a 48-hour promise against a stated 1-in-3 failure rate.
`translations.ts:190` promises "توصيل خلال 48 ساعة". `[plan 2026-09-27, p.4]` states one in three handovers failed because the seller became unreachable. A hard delivery-time promise on the landing page, at that failure rate, is simultaneously (a) the strongest "unrealistic outcome" signal on the page after the 1-dinar iPhone, (b) a legal exposure given `legalTerms.ts` contains no delivery clause at all, and (c) the abandonment case task 14 was written to remove. Three fee stories (F in Evidence) make it worse.

### F6 — Fabricated and hand-mirrored statistics.
`translations.ts:253` ships `{ value: "%98", label: "تركيز على الثقة" }` — "98% focus on trust" is not a measurement of anything; it is a number chosen to look like one. `:254` ships `"3≤"`, which is `≤3` typed backwards so it *renders* correctly in an RTL run. Both are symptoms of the same thing: these Arabic strings are being typed to look right rather than laid out right. `signInPanelCopy.ts:26` shows the correct pattern — `activityLabel: (n) => …` takes the **real live count** and the file comments "never hardcode a number here."

### F7 — Digit convention is broken across surfaces.
`src/utils/arabicNumerals.test.ts:14` asserts `ARABIC_UI_DIGITS === 'western'` as an app-wide decision. `HowItWorksView.tsx:49` ("١ دينار") and `DiscoveryFeedView.tsx:1040, 1069, 1102, 1524` ("١ دينار") use Arabic-Indic digits; `translations.ts:167` uses Western ("1 دينار"). The same price is written two ways on three surfaces. Minor on its own; it matters because price is the brand spine and inconsistent price rendering reads as carelessness.

### F8 — The notification layer is clean. Say so.
`functions/messageCopy.js` is the best-disciplined customer-facing copy in the repo: factual, transactional, bilingual, parity-tested against the n8n node (`functions/notifyCopyParity.test.js`), and it refuses to overstate — see the comment at `messageCopy.js:40–47` forbidding either branch from claiming bids "fell short" when the real cause was a non-paying winner. **The WhatsApp/push copy is not where the ad-policy problem lives** and should not be touched in this remediation. It also carries "فزت بالمزاد 🎉 / You won the auction" (`:101`, `:52`) — correct and necessary, because that is a transactional message to an actual winner, not an advertising claim.

---

## 1. Positioning & messaging house

**Arabic primary (Jordanian/Levantine, RTL-correct, Western digits per `ARABIC_UI_DIGITS`). English secondary.**

### Brand idea
> **«السعر يحدده السوق، مش المحل.»**
> *EN: "The market sets the price — not the shop."*

Continuous with `ops/CAMPAIGN_PLAN.md:5`, which already fixed "السعر يحدده السوق" as the spine. This does not replace it; it sharpens the contrast that makes it mean something in Jordan, where the alternative is a shop price you haggle down.

### Brand promise (the roof)
> **«مزاد علني شفّاف: السعر يحدده السوق، وكل مزايدة مكشوفة، والرسوم معلنة.»**
> *EN: "A transparent public auction: the market sets the price, every bid is visible, and the fees are published."*

### Three pillars

**1 · السعر يحدده السوق — market-set pricing**
- *Claim:* البائع يحدد سعر الافتتاح. المزايدون يحددون سعر الإغلاق.
- *EN:* The seller sets the opening price. The bidders set the closing price.
- *Reasons to believe, already true in the product:* "بدون فصال — السوق بيحدد السعر" (`translations.ts:191`); the live bid log (`translations.ts:266`); seller sets the reserve (`translations.ts:310`).

**2 · مزاد علني مكشوف — transparent public auction**
- *Claim:* كل مزايدة مكشوفة، وقت الإغلاق معروف مسبقاً، وإذا زايدت بآخر الثواني بينمدد الوقت.
- *EN:* Every bid is visible, the closing time is known in advance, and a bid in the final seconds extends the clock.
- *RTB:* auto-extension (`translations.ts:192`, `:227`); unified Friday 8PM close (D-004); server-authoritative bidding with rate limiting, verified in `functions/index.js` per the orchestrator brief.
- *Why this pillar carries the policy load:* "public auction" is the category Meta recognises as legitimate. "Win an iPhone for a dinar" is the category it bans. Same business, two descriptions.

**3 · فلوسك محجوزة لحد ما تستلم — money held until you receive**
- *Claim:* مزادو يحتفظ بمبلغك، وما بيحوّله للبائع إلا بعد ما تستلم وتتأكد إنها مطابقة.
- *EN:* Mazzado holds your payment; the seller is paid only after you receive the item and confirm it matches.
- *RTB:* `signInPanelCopy.ts:45` (AR) / `:31` (EN); `AuctionDetailsModal.tsx:273`; `MyOrdersList.tsx:44`.
- *Caveat for Karam:* manual escrow is `[plan 2026-09-27]` task 15, weeks 5–6, owner Yazan. I could not verify from the repo that it is operating today. If it is not, this pillar is a promise, not a proof — and it is currently stated as fact on four surfaces.

### Messages by audience

| Audience | AR | EN |
|---|---|---|
| **المزايد** (bidder) | «ما في سعر محل. في سعر سوق. اشترك بـ 1 د.أ بالشهر، وزايد بلا حدود — والإغلاق الجمعة 8 مساءً.» | "There's no shop price here. There's a market price. 1 JOD a month, unlimited bids, closing Friday 8PM." |
| **البائع** (seller) | «إنت بتحدد سعر الافتتاح وأقل سعر بتقبله. المشترين بيتنافسوا. عمولة 5% عند البيع فقط — وإذا ما انباع، ما بتدفع إشي.» | "You set the opening price and the lowest price you'll accept. Buyers compete. 5% only when it sells — nothing if it doesn't." |
| **المتردد** (sceptic) | «فلوسك محجوزة عند مزادو لحد ما تستلم وتتأكد. وكل إعلان بيمر بمراجعة فريقنا قبل ما ينزل.» | "Your money is held by Mazzado until you receive and confirm. Every listing is reviewed by our team before it goes live." |

### House rules — the lexicon

**نقولها دائماً / Always:** السعر يحدده السوق · مزاد علني · سعر الافتتاح · سعر الإغلاق · الإغلاق الجمعة 8 مساءً · الرسوم: 5% مشتري + 5% بائع + العضوية · صور حقيقية للقطعة نفسها · أرقام حقيقية معدودة فقط.

**ما نقولها أبداً / Never:**

| Never | Why | Say instead |
|---|---|---|
| اربح / تربح as the *reward* frame | Prize/outcome framing | زايد · أعلى مزايد |
| أرخص سعر · بسعر أفضل · for less | Already forbidden by `signInPanelCopy.test.ts:57` | السعر يحدده السوق |
| «يبدأ من 1 دينار» on a high-value lot | The penny-auction signal (F1) | سعر الافتتاح [الرقم الحقيقي] د.أ |
| ضمان / نضمن / guarantee | `signInPanelCopy.test.ts:54`; unbacked | نحتفظ بمبلغك حتى تأكيد الاستلام |
| الأولى / الأفضل / premier | Unverifiable superlative | منصة مزادات علنية في الأردن |
| Any % or count not counted from live data | F6 | The live count, as `signInPanelCopy.ts:26` does |
| Delivery-time promises | F5; 1-in-3 failure `[plan 2026-09-27]` | استلام من موقعنا أو توصيل مدفوع |
| بائعون موثّقون | ID verification is tasks 16–17, unshipped | كل إعلان يمر بمراجعة فريقنا قبل النشر |

**The one-dinar rule — read this precisely.** "1 دينار بالشهر" as a *membership price* is a true, factual, defensible statement and should stay. "يبدأ من 1 دينار" as an *opening bid on a phone* is the banned framing. The problem is that today both appear on the same page, where a classifier cannot tell them apart and a human reviewer will not try. **Rule: never render a 1-dinar membership price and a 1-dinar opening price on the same surface, and always qualify the membership one as `/شهرياً`.**

---

## 2. Channel audit — what the product actually says to a visitor today

Primary evidence. Every line read at the stated path in this session.

### Surface A — the public landing page (`src/landing/`)
The first thing a visitor sees is `hero.titleFirst` + `titleGradient` (`translations.ts:180–182`): **"اشترِ بأرخص سعر. بِع أسرع."** — "Buy at the cheapest price. Sell faster." Then `hero.desc` (`:185`): the escrow promise. Then three proof chips (`:190–192`): a 48-hour delivery promise, "بدون فصال — السوق بيحدد السعر", and auto-extension.

So the page leads with **price-cheapness**, and the brand spine — market-set pricing — is the *second* of three chips, below the fold of attention. The spine is present but demoted.

Below the hero sits the launch announcement (`LandingView.tsx:1891` → `IPhoneAuctionSection.tsx`): **iPhone 17 Pro Max · "فرصتك لامتلاك أحدث آيفون … بسعر أفضل!" · "يبدأ من 1 دينار فقط"** (`translations.ts:166–167`, rendered `:171`). This is the single highest-risk element on any MAZZADO surface (F1).

Then: a simulated Camry labelled "صور حقيقية / Real Photos" (F4); four trust cards claiming seller ID verification that is not yet built (`:211–212`); a stats strip with "%98" and "3≤" (F6); a six-item FAQ that is, by contrast, **honest and well-written** — it states the 5% buyer premium, the 5% seller commission and 95% seller net, the escrow mechanism, and "لا توجد رسوم عرض حالياً" (`:346–367`). The FAQ is the most accurate block on the page.

One live defect worth naming: `comingSoon` (`:322–338`) collects a visitor's name and **email or Jordanian phone number**, and `:336` admits in Arabic that it is a prototype storing data **in the visitor's own browser** (`experimentalNote`). A public page is harvesting contact details into `localStorage`. Every lead captured there is lost, and collecting a phone number into a throwaway store is a privacy posture nobody chose.

### Surface B — the discovery feed (`src/components/DiscoveryFeedView.tsx`)
Markedly better. The guest hero (`:1024–1029`) is **"زايد. اشترِ. بع — مباشر."** with "مزادات فورية — مزاد يحتفظ بمبلغك حتى تستلم القطعة وتؤكّد." — concrete, no superlatives, escrow stated plainly. The value row (`:1069–1079`) is the clearest honest statement of the model anywhere in the product: **"انضم من ١ دينار بالشهر" / "زايد مجاناً" / "ادفع فقط عند الفوز (+٥٪ عمولة)"** — subscription, free bids, 5% on win. That is exactly the three-line rebuttal to a penny-auction classification, and it is on the wrong page: the feed, which a cold ad click does not see first.

Blemishes: "بائعون موثّقون" again at `:1508`; Arabic-Indic digits against the house convention (F7); "المزادات القوية جاية 🔥" (`:1437`) is hype but harmless.

### Surface C — sign-in prompts (`src/utils/signInIntent.ts`)
The strongest copy in the product, and the only surface with a stated copy doctrine. `signInIntent.ts:10–13` states it outright: *the copy makes ONE promise — what happens next* — and refuses claims about being free, instant, secure or verified, because a sign-in screen is "where those are most tempting and least checkable." Five intents, each with Jordanian-Arabic headline and subline (`:23–44`): tap to bid → «سجّل دخولك للمزايدة · بترجع على نفس القطعة بعد الدخول.» The companion `signInPanelCopy.ts` condenses only already-approved claims and is guarded by the test in F2.

`postOnboardingView()` (`:87`) is the fix for the influencer deep-link defect `[plan 2026-09-27]` task 2: a visitor who arrived on `/auction/:id` now returns to that lot after onboarding instead of being dumped on a generic feed. Deployed per the orchestrator brief (#6); **the post-signup return itself is still unverified on production** (orchestrator brief, #6).

### Surface D — WhatsApp / notification copy (`functions/messageCopy.js`)
See F8. Clean, factual, parity-tested, bilingual with Arabic as the safe default (`:29–32`). Twenty events covering win, payment due, outbid, second chance, shipping, returns and bans. **Not a source of ad-policy risk.** Leave it alone.

### The through-line
MAZZADO's copy quality is **inversely proportional to how public the surface is**. The sign-in screen has a written doctrine and an enforcing test. The feed is honest. The notification layer is parity-guarded. The landing page — the one an ad click lands on, the one Meta's reviewer reads — has no doctrine, no guard, and carries every claim the others were explicitly forbidden from making.

---

## 3. The ad-policy problem — copy review (`[plan 2026-09-27]` task 23)

### Read this before the table

1. **The ban's cause is an inference, not a finding.** `[plan 2026-09-27, p.6]` attributes the `@mazzadoofficial` ban to a 50× activity spike plus "not paying full price" language. That reasoning is sound and I act on it — but **no Meta notice, policy citation or appeal correspondence exists in this repo.** If Karam has the actual notice, it should go into `ops/data/`; it would change which of the items below are urgent.
2. **Policy names are EXTERNAL and must be re-checked.** Source: Meta Advertising Standards, `https://transparency.meta.com/policies/ad-standards/`. I am mapping strings to the policy families most likely to catch them. Meta renames and restructures these; the family historically titled *"Penny Auctions, Bidding Fee Auctions and Other Similar Business Models"* may now sit under a differently-named section. **Karam must read the current live text before filing the appeal.** None of this is a Meta ruling and none of it is a MAZZADO result.
3. **Meta reviews the destination page, not only the ad.** (EXTERNAL, same source.) This is why the landing page is in scope at all, and why Tier A below outranks the ad copy that does not yet exist.
4. **Nothing in this table has been changed.** These are proposed rewrites only.

> ### ⚠ APPROVAL GATE
> **Every row below touches live customer-facing copy. Karam must approve each rewrite before it ships.** I have not edited any file. The rewrites are drafts for his review; a developer applies them only after his written approval is logged in `ops/DECISIONS.md` (proposed: **D-106**).

### Tier A — the public landing page. This is the ad destination. Highest risk.

| # | Offending string | `file:line` | Why it trips policy | Compliant AR rewrite | Compliant EN rewrite |
|---|---|---|---|---|---|
| A1 | `يبدأ من 1 دينار فقط` | `src/landing/translations.ts:167` (rendered `components/IPhoneAuctionSection.tsx:171`) | **Highest risk on any surface.** A ~1 JOD entry to a ~1,500 JOD phone, on a platform that charges a fee to bid — the defining shape of a bidding-fee/penny auction. Also an unrealistic-outcome claim. Also violates `[plan 2026-09-27]` task 8 (20 JOD minimum) and the condition at `CAMPAIGN_PLAN.md:48`. | `سعر الافتتاح يحدده البائع — وسعر الإغلاق يحدده السوق.` | "The seller sets the opening price. The market sets the closing price." |
| A2 | `Opening bid: just 1 JOD` | `src/landing/translations.ts:416` | As A1, English. "just" adds the unrealistic-outcome emphasis. | — | "Opening price: [real figure] JOD." |
| A3 | `فرصتك لامتلاك أحدث آيفون … بسعر أفضل!` | `src/landing/translations.ts:166` | "فرصتك" (your chance) + "بسعر أفضل" + a named flagship product = chance-to-acquire framing. "Not paying full price" is the exact phrasing `[plan 2026-09-27]` names. | `آيفون 17 برو ماكس — مزاد علني. الإغلاق الجمعة 8 مساءً.` | "iPhone 17 Pro Max — public auction. Closes Friday 8PM." |
| A4 | `Your chance to own the newest iPhone — for less.` | `src/landing/translations.ts:415` | As A3. | — | As A3 EN. |
| A5 | `اشترِ بأرخص سعر.` (page H1) | `src/landing/translations.ts:180` | Unsubstantiated price superlative; **already forbidden by `signInPanelCopy.test.ts:57`** on another surface. Pairs with A1 into the full penny-auction read. | `السعر يحدده السوق.` | — |
| A6 | `Buy for less.` | `src/landing/translations.ts:427` | As A5. | — | "The market sets the price." |
| A7 | `ابدأ المزايدة — 1 دينار` / `Start Bidding — 1 JOD` (sticky mobile CTA) | `src/landing/LandingView.tsx:3172` | Reads as "bidding costs 1 dinar" → a bid fee. It is actually a monthly subscription. Ambiguity is the whole risk. | `اشترك وزايد — العضوية 1 د.أ شهرياً` | "Subscribe to bid — 1 JOD/month" |
| A8 | `بيع أسرع، تزايد بذكاء، واربح بثقة.` | `src/landing/translations.ts:371` | "اربح" as the payoff + "المنصة ... الأولى" earlier in the same string = prize framing plus unverifiable superlative. | `منصة مزادات علنية في الأردن — السعر يحدده السوق، والرسوم معلنة.` | — |
| A9 | `The premier modern auction platform … win with absolute confidence.` | `src/landing/translations.ts:616` | As A8. "absolute confidence" is an unqualifiable guarantee. | — | "A public auction platform in Jordan — the market sets the price, and the fees are published." |
| A10 | `توصيل خلال 48 ساعة` | `src/landing/translations.ts:190` | Delivery-time promise with no fulfilment capability behind it; 1-in-3 handovers failed `[plan 2026-09-27]`. Unrealistic-outcome + misleading-claim. Same class `signInPanelCopy.test.ts:56` forbids. | `استلام من موقعنا أو توصيل مدفوع` | "Pickup from our location, or paid delivery" |
| A11 | `Delivered in 48 hours` | `src/landing/translations.ts:435` | As A10. | — | As A10 EN. |
| A12 | `بائعون موثّقون` + `نتحقق من هوية البائع قبل عرض أي منتج` | `src/landing/translations.ts:211`, `:212` | Claims ID verification that does not exist yet (`[plan 2026-09-27]` tasks 16–17, weeks 5–6). Forbidden by `signInPanelCopy.test.ts:58`. Misleading claim. | `كل إعلان يمر بمراجعة فريقنا قبل النشر.` *(the claim the product does keep — see `HowItWorksView.tsx:110`)* | "Every listing is reviewed by our team before it goes live." |
| A13 | `Verified Sellers` / `We verify every seller's identity before any product is listed.` | `src/landing/translations.ts:456`, `:457` | As A12. | — | As A12 EN. |
| A14 | `نضمن لك الدفع الآمن` | `src/landing/translations.ts:318` | "نضمن" (we guarantee) — forbidden by `signInPanelCopy.test.ts:54`; unqualified guarantee. | `الدفع بيضل محجوز عند مزادو لحد ما تستلم وتأكد.` | "Payment stays held by Mazzado until you receive and confirm." |
| A15 | `%98` / `تركيز على الثقة` · `98%` / `Focus on Trust` | `src/landing/translations.ts:253`, `:498` | A statistic presented as a measurement that measures nothing. Misleading claim; also violates `CLAUDE.md` rule 1. | Delete the tile, or use the real live count: `[N] قطعة معروضة الآن` (pattern at `signInPanelCopy.ts:41`) | Delete, or "[N] lots live right now" |
| A16 | `3≤` / `خطوات للمزايدة` | `src/landing/translations.ts:254` | Not a policy trip — an **RTL defect**: `≤3` typed backwards to force visual order. | `3 خطوات للمزايدة` | "3 steps to bid" |
| A17 | `صور حقيقية · عمّان · مزاد مميز` on the simulated Camry | `src/landing/translations.ts:197` (`:442` EN), data from `src/landing/heroSim.ts` | Asserts "Real Photos" and "✓ بائع موثق" over a randomly-generated demo with a fake rising bid counter. Misrepresentation; a reviewer who identifies it reads the whole page as deceptive. | Add a visible `مثال توضيحي` marker and drop `صور حقيقية` | Add "Illustrative example"; drop "Real Photos" |
| A18 | `قطع موثقة بالكامل` (FAQ) | `src/landing/translations.ts:346` (`:591` EN) | "fully verified items" — same unbacked verification claim as A12. | `قطع يراجعها فريقنا قبل النشر` | "items reviewed by our team before they go live" |
| A19 | `بساطة كاملة من الإعلان إلى الفوز.` | `src/landing/translations.ts:306` (`:551` EN) | "الفوز / winning" as the journey's endpoint reinforces prize framing. Low risk alone; cumulative with A1–A8. | `من الإدراج حتى الإغلاق — خطوات واضحة.` | "From listing to close — clear steps." |
| A20 | `🔥 منافسة نشطة` / `🔥 Active Battle` · `🔥 منافسة حقيقية` / `🔥 Real Competition` | `src/landing/translations.ts:263`, `:508`, `:200`, `:445` | "Battle" + flame on a bidding surface reads as contest-for-prizes. Low risk alone; cumulative. | `مزايدات مباشرة` / `مزايدة علنية` | "Live bidding" / "Public bidding" |

### Tier B — in-app. Lower risk: a signed-in user sees these, Meta's reviewer usually does not. **In scope only if these screens appear in ad creative or a reviewer walks the funnel.**

| # | Offending string | `file:line` | Why it trips policy | Compliant AR rewrite | Compliant EN rewrite |
|---|---|---|---|---|---|
| B1 | `انضم عشان تزايد وتربح 🔨` / `Join to bid & win 🔨` | `src/components/SubscriptionPromptModal.tsx:44` | This is the **paywall** modal — the one place "pay to win" is literally the user's next action. Highest-risk in-app string. | `انضم عشان تزايد` | "Join to bid" |
| B2 | `لا مشتريات بعد — زايد واربح!` / `bid and win!` | `src/components/MyOrdersView.tsx:267` | Prize framing in an empty state. | `لا مشتريات بعد — تصفّح المزادات المفتوحة.` | "No purchases yet — browse the open auctions." |
| B3 | `بائعون موثّقون` / `Verified sellers` | `src/components/DiscoveryFeedView.tsx:1508` | As A12, on the feed. | As A12 | As A12 |
| B4 | `توصيل بأجرة بسيطة (٢–٤ دنانير تقريباً)` | `src/components/HowItWorksView.tsx:75` | Not a Meta issue — a **fee-consistency** issue. Contradicts `legalTerms.ts` (no delivery clause) and `[plan 2026-09-27]` task 14 (6 JOD). See F5. | Blocked on D-105 / task 14. Do not rewrite until one number is approved. | Same |

### Explicitly NOT flagged, and why
- **All "ادفع فقط عند الفوز / pay only if you win" strings** (`DesktopFrame.tsx:744`, `:793`; `DiscoveryFeedView.tsx:1079`, `:1512`; `SubscriptionView.tsx:109`; `OnboardingModal.tsx:86`). These are **accurate descriptions of the payment term** to a signed-in user, and they are the exact copy that *refutes* a bidding-fee classification. Removing them would make the policy position worse. Keep.
- **`functions/messageCopy.js` win notifications** (`:101` AR, `:52` EN). Transactional messages to an actual winner. Not advertising. Keep (F8).
- **"عضوية 1 دينار شهرياً" as a membership price.** True, factual, and protected by D-002/`CLAUDE.md:8`. Keep — but qualify it with `/شهرياً` everywhere, and never co-locate it with a 1-dinar opening price (see the one-dinar rule in §1).

### What to put in the appeal (DRAFT — Karam files it, I do not)
Three true, checkable statements, in this order: **(1)** The membership is a flat monthly subscription with unlimited bidding; no fee is consumed per bid — `HowItWorksView.tsx:49–60`. **(2)** The winner pays the hammer price plus a published 5% premium; the fee schedule is in the public terms — `legalTerms.ts:172`. **(3)** Bidding is server-authoritative with a server-side rate limit and a public bid log; it is a transparent public auction, not a game of chance — `functions/index.js`, per the orchestrator brief (#2). Attach the corrected landing page as evidence of remediation — which means **A1–A7 must ship before the appeal is filed, not after.**

---

## 4. Measurement-first plan

The tracking-event table is being produced in parallel by cto-product and is not available to me. This section states what is *impossible* today and which decision each gap blocks. It is written from code I read, not from the dashboard.

### What exists vs. what the plans assume

| Event | Required by | In the repo? |
|---|---|---|
| `PageView` | KPI spec §1 | ✅ `src/lib/pixel.ts:26` → `AppContext.tsx:822`, `:855` |
| `CompleteRegistration` | KPI spec §1; `CAMPAIGN_PLAN.md:13` (fallback); `[plan]` task 21 | ✅ `src/lib/pixel.ts:31` → `AppContext.tsx:1224` |
| `PlaceBid` (custom) | KPI spec §1; `CAMPAIGN_PLAN.md:29` (C2 rung 2) | ✅ `src/lib/pixel.ts:36` → `AppContext.tsx:3669` |
| `ListItem` (custom) | — (not in either spec; exists anyway) | ✅ `src/lib/pixel.ts:45` → `AppContext.tsx:4397` |
| **`Subscribe`** | **`CAMPAIGN_PLAN.md:13` — the PRIMARY optimization event** | ❌ **Absent from the entire repo** |
| **`ViewContent`** | KPI spec §1 "Auction views"; `CAMPAIGN_PLAN.md:9` | ❌ Absent |
| **`Purchase`** | KPI spec §1 "Paid winners", §4 ROAS | ❌ Absent |
| **Conversions API** | `CAMPAIGN_PLAN.md:9` (event_id dedup) | ❌ No server-side event anywhere in `functions/` |
| **GA4** | KPI spec §1 "Visitors", §6 | ❌ No `gtag`, no GTM, no `getAnalytics()`. `measurementId` present but unused (`firebase.ts:18`) |
| **Landing funnel events** | `landingAnalytics.ts` (8 events) | ⚠️ **Built, then dropped.** `landingAnalytics.ts:45` writes only if `window.dataLayer` is an array; nothing creates it. Zero data has ever been collected. |

### Optimization objectives that are IMPOSSIBLE today

| Objective | Blocked on | Consequence |
|---|---|---|
| Optimize C1 to **Subscribe** (cost per paid member) | `Subscribe` event | `CAMPAIGN_PLAN.md`'s primary objective cannot be configured. The whole §5 budget table is denominated in "cost per paid member" and that number cannot be produced by Meta. |
| Any **Purchase/value** optimization, platform ROAS, value-based bidding, Advantage+ value rules | `Purchase` with `value` | ROAS (platform-reported) in KPI spec §4 is unavailable. Do not report one. |
| **Lookalike** off paid members (A6) | `Subscribe` **and** ≥100 seeds; `[plan]` p.9 says seeds are <1,000 | Deferred regardless. Plan says revisit above 500 bidders. |
| **CAC (paid member)** — KPI spec §4 | `Subscribe` + a spend export that does not exist | Cannot be computed by Meta *or* by MAZZADO. |
| **ROAS (MAZZADO-revenue based)** — KPI spec §4 | Ad export + ledger join; CliQ payments are manual (Yazan), KPI spec §6 | Impossible until both sides exist. Never mix with platform ROAS (KPI spec §4). |
| **Event deduplication** | CAPI + `event_id` | Browser-only events undercount on iOS/ad-blocked traffic by an unknown amount. Treat all pixel counts as **lower bounds**, never as totals. |
| **Landing-page funnel** (browse CTA vs seller CTA vs register) | `window.dataLayer` never initialized | We cannot tell whether the landing page sends visitors to bid or to sell. Eight events, zero rows. |
| **Visit→registration rate** — the gate on `[plan]` task 24 | GA4 absent; `landingAnalytics` dead | **The measurement that gates the influencer decision cannot currently be produced.** See §6. |

### What is ACTUALLY possible today — act on these first

1. **`[plan]` task 21 — switch the campaign from link clicks to registrations — is NOT blocked by code.** `CompleteRegistration` exists and fires after the user doc write (`AppContext.tsx:1224`), covering phone OTP, Google and email signups. It is blocked only on D-102 (ad account), D-103, domain verification (CMO-001), and Karam confirming in Events Manager that it fires in production. This is the single highest-leverage unblocked item in the whole measurement plan — `[plan, p.6]` notes the account has recorded 313 registrations and 126 bids that the optimiser used none of.
2. **URL-rule retargeting audiences work today, without `ViewContent`.** `trackPageView()` fires on every SPA route change, and `src/utils/navUrl.ts:95` puts an auction at `/auction/<id>`. So a Website Custom Audience with a URL-contains rule on `/auction/` captures "viewed a lot" — which is the C2/A3 ladder rung and `[plan]` task 6 ("All Visitors 180d" + exclusions) and task 22 (retarget the influencer audience). **Website audiences backfill**, so the ~15,000 influencer visitors `[plan 2026-09-27, p.3]` are still reachable — and `[plan]` flags they go colder every day. **This is time-sensitive and needs no code.**
3. **`PlaceBid` already excludes simulated lots** (`AppContext.tsx:3662`), so bid-based audiences and events are not poisoned by admin testing. Good hygiene already in place.

### The gap that must be closed first, and it is not code

**Nothing above is verified to fire in production.** Everything in the "exists" column is read from source. Before any event-table work, Karam must open Events Manager → Test Events and confirm the four live events actually arrive. If the deferred loader (`index.html:45–62`) means the pixel loads only on first pointer interaction, a bouncing visitor may never fire `PageView` at all — which would systematically undercount exactly the low-intent ad traffic a campaign buys. **I cannot test this; it needs production browser access and Meta access.** It belongs in `ops/DATA_REQUIREMENTS.md`.

### Sequence (cheapest first, each unblocking the next)

| # | Step | Needs code? | Owner | Unblocks |
|---|---|---|---|---|
| M0 | Verify the 4 existing events in Events Manager Test Events | No | Karam | Everything. Do this first. |
| M1 | Domain verification + canonical ad account (CMO-001, D-102) | No | Karam | Any conversion objective |
| M2 | Build URL-rule audiences incl. All Visitors 180d + exclusions (`[plan]` task 6) | No | Karam | C2 retargeting, `[plan]` task 22 — **time-sensitive, audience is cooling** |
| M3 | Switch campaign objective to registrations (`[plan]` task 21) | No | Karam | A real conversion signal at the same 400 JOD |
| M4 | Add `Subscribe`, `ViewContent`, `Purchase` (CTO-002, D-103) | Yes | CTO | C1 primary objective, cost per paid member, CAC |
| M5 | Initialize `dataLayer` / GTM or call the pixel directly from `landingAnalytics.ts` | Yes | CTO | Landing funnel — eight events already written and wasted |
| M6 | CAPI + `event_id` dedup | Yes | CTO | Trustworthy counts, iOS recovery |
| M7 | Weekly ad + Firestore export into `ops/data/` (`CAMPAIGN_PLAN.md:11`) | No | Karam + COO | CAC on MAZZADO's own numbers, not Meta's |

**Until M0–M3 are done, no paid spend should be judged on anything, because nothing is measured.** That is a measurement statement, not a budget recommendation — the budget decision is D-101 and remains Karam's.

**One privacy flag.** Audience A4 ("members with 0 bids", `CAMPAIGN_PLAN.md:22`) cannot be a pixel audience without `Subscribe`. The only alternative is a Customer List built from Firestore, which means exporting phone numbers or emails to Meta. That collides with `CLAUDE.md:29` ("NEVER commit personal data … aggregate or anonymize first") and needs an explicit decision from Karam before anyone builds it. I am not proposing it; I am flagging that the plan implies it.

---

## 5. Content calendar — weeks 1–2, organic only

**Constraints honoured:** organic only, no paid, no influencers, "community before ads" (D-003), unified closing times and Friday 8PM live event (D-004). Channels: WhatsApp channel, Instagram (the surviving account — the banned `@mazzadoofficial` is under appeal `[plan]` task 5), TikTok if it exists.

**DRAFT — NOT PUBLISHED. Nothing here goes out without Karam's approval.**

**Dependency, stated plainly:** week 1's Friday is **tomorrow, 23 Oct**. If no auction batch is ready, that event cannot happen as a real close. The calendar below therefore treats Fri 23 Oct as a **soft event** (a short live walk-through of current inventory, with the honest framing "first full batch closes next Friday") and Fri 30 Oct as the **first real unified close**. This hangs on COO-003 (10–15 controlled test auctions). If COO-003 slips, both Fridays slip and the calendar must be rebuilt — I am not going to pretend an event exists because a calendar says so.

### Week 1 — Thu 22 Oct → Wed 28 Oct · "كيف بيشتغل المزاد"
Goal: establish the mechanism. Not demand generation — comprehension. Most people who registered `[plan: 313]` have never watched an auction close.

| Day | Channel | Format | AR hook | Purpose |
|---|---|---|---|---|
| Thu 22 | WhatsApp channel | Text + 1 image | «بكرا الجمعة 8 مساءً — بنفتح الغرفة ونمشي على القطع المعروضة سوية.» | Set the Friday ritual |
| Fri 23 | IG Story ×3 + WhatsApp | Story sequence, day-of | «اليوم 8 مساءً.» → «باقي ساعة.» → «إحنا مباشر.» | Event attendance |
| **Fri 23, 8PM** | **Live** | **Soft live, 20–30 min** | Walk the current lots, show the bid log updating, say the closing time out loud, state the fees out loud | The ritual matters more than the sale |
| Sat 24 | IG Reel (20s) | Screen recording | «شو يعني "السعر يحدده السوق"؟» — opening price → competing bids → closing price | Pillar 1 |
| Sun 25 | IG carousel (5) | Static | «الرسوم، بالكامل: 5% مشتري · 5% بائع · العضوية 1 د.أ شهرياً.» | Pre-empts the #1 objection; pre-empts the penny-auction read |
| Mon 26 | WhatsApp + IG | Seller-facing | «عندك إشي واقف من زمان؟ إنت بتحدد سعر الافتتاح وأقل سعر بتقبله.» | Supply — the real constraint (`~30` listings `[plan]`) |
| Tue 27 | IG Reel | Explainer | «فلوسك محجوزة لحد ما تستلم.» — the escrow flow, screen-recorded | Pillar 3 — **only if escrow is actually operating** |
| Wed 28 | WhatsApp | Text | «هاي القطع اللي رح تسكّر الجمعة الساعة 8.» + list | Concentrate demand on one close (D-004) |

### Week 2 — Thu 29 Oct → Wed 4 Nov · "ناس حقيقية، أسعار حقيقية"
Goal: proof. Week 1 explained the mechanism; week 2 shows it worked. Aligns with `[plan]` task 20 ("document every completed sale as content", owner Karam).

| Day | Channel | Format | AR hook | Purpose |
|---|---|---|---|---|
| Thu 29 | WhatsApp + IG | Carousel of the batch | «بكرا 8 مساءً — [N] قطع، كلها بتسكّر بنفس الوقت.» Real count only | Unified close |
| Fri 30 | IG Story ×3 | Countdown | As week 1 | Attendance |
| **Fri 30, 8PM** | **Live** | **First real unified close** | Close the lots on air; announce closing prices out loud | The product's single best piece of content |
| Sat 31 | IG post + WhatsApp | Result card | «سعر الافتتاح [X] → سعر الإغلاق [Y]. السوق قرر.» Real numbers only | Pillar 1, proven — the spine, demonstrated not asserted |
| Sun 1 Nov | IG Reel | Buyer handover | Winner receiving the item, with consent, face optional | Attacks the 1-in-3 handover failure `[plan]` — the real trust gap |
| Mon 2 | WhatsApp + IG | Seller result | «بايع [الصنف] بـ[Y] د.أ خلال [N] يوم.» With the seller's consent | Seller acquisition from evidence |
| Tue 3 | IG carousel | «أسئلة بتتكرر» | Three real questions from the Friday live, answered | Community, not broadcast |
| Wed 4 | WhatsApp | Next batch | «قطع الجمعة الجاي.» | Close the loop |

### Rules binding every post
1. **Every number is counted, never estimated.** If there is no real figure, the post ships without one. (`CLAUDE.md` rule 1; the `signInPanelCopy.ts:26` pattern.)
2. **No post uses a word from the Never list in §1.** In particular: no "اربح" as a reward, no "أرخص", no 1-dinar opening on a high-value lot.
3. **Every post naming a price also names the closing time.** Market-set pricing is meaningless without a deadline.
4. **Consent before any customer appears** — face, name, item or price. Not implied, asked for.
5. **Fees stated whenever a price is stated.**
6. **Western digits** (`ARABIC_UI_DIGITS`).
7. **Nothing is scheduled or posted by me.** This is a draft for Karam.

### What I'd measure organically, given no analytics
Hand-counted, written into `ops/data/` weekly: live-event concurrent viewers at peak; messages in the live chat; WhatsApp channel subscribers (delta, not total); new listings from the seller posts; bids placed during the Friday hour vs. the rest of the week. None of this needs the pixel. All of it is real.

---

## 6. The conflict Karam must resolve — influencers

**I am presenting both rules. I am not choosing between them.**

### Rule A — `CLAUDE.md:9` and D-003
> "no influencers in first 30 days" · "community before ads"

Logged in `ops/DECISIONS.md` as **D-003, dated "pre-2026-10", status APPROVED**, and restated in my own role definition (`.claude/agents/cmo-growth.md:25`) as a constraint not to be overridden without a logged decision. Per the orchestrator brief (#10), **CLAUDE.md wins by default until Karam rules.**

**The clock has no start date.** "First 30 days" of what — the repo? the kickoff? a launch? D-003's date is recorded only as "pre-2026-10". If the clock started at kickoff (2026-10-22), it runs to **2026-11-21**. If it started when D-003 was actually made, it may already have expired. **This ambiguity is not a detail; it is the whole operative content of the rule**, and nothing in the repo resolves it.

**What Rule A implies for the next 30 days:** no influencer spend, full stop, regardless of any metric. The rule is time-based. It would expire on a date, not on evidence. Organic-only (§5) is the complete plan.

### Rule B — `[plan 2026-09-27]` task 24
> "Resume influencer spend — only if week 2 metrics improved" · Owner: Maher (decision) · Karam (data) · Done when: "Decision made on data"

The gate is explicit `[plan, p.7]`: *if visit→registration has moved from 1.5% toward 5%, the channel is worth repeating; if it has not, more traffic will not solve the problem.* The channel's past performance is stated as ~15,000 visits at ~0.08 JOD each — cheap and effective at delivering traffic; what failed was the platform's ability to hold it, specifically the deep-link defect that `[plan]` task 2 / PR #299 fixed.

**What Rule B implies for the next 30 days:** influencer spend is permitted *the moment the week-2 measurement clears the gate* — and by the plan's own calendar, **week 2 ended around 11 October 2026. That date has passed.** So on Rule B's clock the decision is already overdue.

**Except it cannot be made.** `[plan]` task 7 ("Measure registration rate against the 1.5% baseline", owner Karam, due end of week 2) has **no recorded result anywhere in `ops/`**. And per §4, the instrumentation that would produce it does not exist: GA4 is not installed, and `landingAnalytics.ts` events are discarded. **The measurement that gates task 24 is currently unproducible.** `[plan]` task 1 ("pull the auction data from Firebase") is likewise unreported.

### What each rule implies, side by side

| | Rule A (`CLAUDE.md`/D-003) | Rule B (`[plan]` task 24) |
|---|---|---|
| Basis | Time | Evidence |
| Clock | 30 days from an **undefined** start | Week 2 of the plan — **already elapsed** |
| Next 30 days | No influencer spend, unconditionally | Permitted if the gate clears |
| Can the gate be evaluated today? | N/A | **No** — task 7 unreported, instrumentation absent (§4) |
| What would change it | A date passing | A registration-rate measurement |
| Decision owner | Karam (D-003) | Maher decides, Karam supplies data |

### The honest observation
The two rules **currently point to the same near-term action** — no influencer spend — but for entirely different reasons, and **that convergence is an accident that dissolves the moment task 7 is measured.** Rule A would still forbid spend on a date basis even if registration had tripled; Rule B would permit it tomorrow on evidence Rule A does not care about. They also disagree about **who decides**: D-003 is Karam's standing decision; task 24 assigns the decision to Maher.

One factor neither rule accounts for: per the orchestrator brief (#6), PR #299 is deployed, **but the post-signup deep-link return is still unverified on production** — it needs a real signup, deliberately not performed. That is the exact defect that wasted the last influencer campaign `[plan, p.3]`. So even under Rule B with a clearing gate, resuming spend would be repeating the previous bet on an unverified fix.

**This is logged as a decision for Karam (D-107 below). I have not picked one, and nothing in §5 depends on the answer — the week 1–2 calendar is organic either way.**

---

## Proposed backlog items

Existing CMO items are CMO-001 … CMO-003 in `ops/BACKLOG.md`; these continue the sequence. Orchestrator owns the backlog file — I propose, I do not edit it.

| ID | Item | Impact | Effort | Owner | Depends on |
|---|---|---|---|---|---|
| **CMO-004** | **Remediate Tier A ad-policy copy (A1–A7 first): remove the 1-dinar opening-price framing, the price superlatives and the sticky-CTA ambiguity from the landing page.** | **Critical — unblocks the entire paid channel and is a precondition for the ban appeal** | S (copy only; a developer applies it) | CMO drafts · Karam approves · CTO applies | **D-106** |
| CMO-005 | Remediate Tier A remainder (A8–A20) and Tier B (B1–B3): guarantees, unverified stats, "Verified Sellers", the simulated-lot "Real Photos" label | High — misrepresentation and trust exposure | S–M | CMO · Karam · CTO | D-106 |
| CMO-006 | **Extend the `signInPanelCopy.test.ts` guard pattern to `src/landing/translations.ts` and `DiscoveryFeedView.tsx`** — a forbidden-claims test that fails the build | High — makes the fix permanent instead of a one-off review | S | CTO (CMO supplies the forbidden list from §1) | CMO-004 |
| CMO-007 | Draft the Instagram ban appeal around the three checkable facts in §3 | High — the channel is dark until this lands | S | CMO drafts · **Karam files** | CMO-004 shipped first |
| CMO-008 | Positioning rollout: apply the §1 messaging house to landing hero, feed hero and the sign-in panel so one spine runs across all three | Medium-high | M | CMO · Karam · CTO | CMO-004 |
| CMO-009 | Build URL-rule Website Custom Audiences incl. All Visitors 180d + exclusions (`[plan]` task 6, 22) — **works today, no code needed, audience is cooling daily** | High — recovers ~15,000 influencer visitors `[plan]` | S | Karam (Meta access) | CMO-001, D-102 |
| CMO-010 | Verify the 4 existing pixel events in Events Manager Test Events (M0) — including whether the deferred loader suppresses `PageView` for bouncing visitors | **High — everything in §4 is unverified until this is done** | S | Karam | Meta access |
| CMO-011 | Organic content calendar weeks 1–2 (§5) — production, scheduling, approval | Medium-high — "community before ads" made concrete | M | CMO drafts · Karam approves | COO-003 (test auctions) |
| CMO-012 | Pre-register the C1/C2 test plan and decision rules in JOD before any spend; fill the `[FILL]`/`[SET]` gaps in `CAMPAIGN_PLAN.md:34, 42` | Medium — prevents judging spend on vibes | S | CMO · COO (contribution per member) | D-101, CMO-010 |
| CMO-013 | Resolve the three-way delivery-fee contradiction in customer-facing copy (F5, B4): ~2–4 JOD vs 6 JOD vs silent terms | Medium-high — abandonment + legal exposure | S (copy) after the decision | COO/CTO · Karam · lawyer | **D-105**, `[plan]` task 14 |
| CMO-014 | Replace the landing `comingSoon` localStorage lead form (`translations.ts:336`) with a real capture, or remove it | Medium — every lead captured there is lost; and it collects phone numbers into a throwaway store | S | CTO · CMO | — |
| CMO-015 | Normalise digits to Western across `HowItWorksView.tsx:49` and `DiscoveryFeedView.tsx:1040, 1069, 1102, 1524` per `ARABIC_UI_DIGITS` | Low — brand consistency on the price itself | XS | CTO | — |

---

## Decisions needed from Karam

| ID | Decision | Why it is blocking | Proposed by |
|---|---|---|---|
| **D-106** | **Approve the Tier A / Tier B copy rewrites in §3 — each row individually.** This is live customer-facing Arabic and English on mazzado.com. **No copy may change without this.** | CMO-004/005/007 all block on it. The appeal (CMO-007) is weaker if filed before the page is fixed. | cmo-growth |
| **D-107** | **Which influencer rule governs the next 30 days** — `CLAUDE.md`/D-003's time-based ban, or `[plan]` task 24's evidence gate. **If D-003 governs: state the start date.** **If task 24 governs: state who supplies the registration-rate measurement, given §4 shows it is currently unproducible.** | Unresolved, the team cannot tell whether to build the measurement or wait out a clock. Also unresolved: Karam decides (D-003) or Maher decides (task 24). | cmo-growth · flagged by orchestrator (#10) |
| D-108 | Whether the iPhone 17 Pro Max launch announcement stays on the landing page **at all**, given `[plan]` task 8's 20 JOD minimum and `CAMPAIGN_PLAN.md:48`'s "only if a real item starts at that price" | It is the single highest-risk element on any MAZZADO surface (F1). Fixing the copy without deciding the lot's real opening price only defers it. | cmo-growth |
| D-109 | Whether audience A4 ("members with no bids") may be built as a **Customer List uploaded to Meta** from Firestore — i.e. whether customer phone/email may be sent to Meta at all | `CAMPAIGN_PLAN.md:22` implies it; `CLAUDE.md:29` restricts personal data. Nobody should build it on an assumption. | cmo-growth |
| D-105 *(existing)* | Delivery fee / guarantee model — one number, on every screen, in the terms | Three contradictory fee stories are live today (F5, Evidence). Blocks CMO-013 and `[plan]` task 14. | pre-existing |
| D-101, D-102, D-103 *(existing)* | Paid-media budget share · canonical ad account · approve implementing pixel/CAPI events | Block M1, M3, M4 and all of §4's impossible list | pre-existing |

---

## What I could NOT verify, and why

1. **Any campaign metric whatsoever.** No Meta, GA4, Firestore or ledger export exists in `ops/data/`. **No CTR, CPC, CPM, CAC, ROAS, conversion rate or cost-per-anything appears in this report**, and none should be quoted from it. `[plan 2026-09-27]` figures (21,000 visits → 4 sales; 313 registrations; 24 paid memberships; 126 bids; ASV ~6 JOD; 1-in-3 failed handovers; ~30 listings) are **STATED by Karam in a dated document, not measured by me.**
2. **The reason for the Instagram ban.** No Meta notice, policy citation, appeal correspondence or account record is in this repo. The attribution to spike + "not paying full price" language is `[plan 2026-09-27, p.6]` — Karam's inference. My entire §3 is built on it, and would need revising against an actual notice.
3. **Meta's current policy text.** I had no browsing access in this session. The policy family names in §3 are EXTERNAL, from Meta's published Advertising Standards (`https://transparency.meta.com/policies/ad-standards/`), and Meta restructures them. **Karam must check the live text before filing.** Nothing in §3 is a Meta ruling.
4. **Whether any pixel event actually fires in production.** Everything in §4's "exists" column is read from source code. Events Manager needs Meta access I do not have (CMO-010). The deferred loader (`index.html:45–62`) may suppress `PageView` for visitors who never interact — **unverified and potentially significant for ad traffic specifically.**
5. **Whether the ad account, Business portfolio, domain verification or the six audiences exist or are populated.** `[plan]` tasks 5 and 6 are Karam's, outside the repo. CMO-001 is already BLOCKED on this in `ops/BACKLOG.md`.
6. **Whether manual escrow is operating.** The escrow promise is stated as present-tense fact on four customer-facing surfaces. `[plan]` task 15 schedules it for weeks 5–6 under Yazan. The code supports held payments; whether the operation runs today is an ops fact I cannot read from the repo. **Pillar 3 of the messaging house depends on this.**
7. **Whether the landing page I read is the deployed landing page.** I read `src/` on branch `agent/setup`. The orchestrator verified a deployed bundle on 2026-10-22 for PR #299's `signInIntent` copy only (#6). **I did not fetch mazzado.com and grep the served bundle for the Tier A strings.** Per the standing lesson about verifying from live artefacts, **someone should confirm A1–A7 are actually on the live page before the appeal cites them as fixed.** Everything in §3 is sourced to the repo at this commit, not to production.
8. **The "6 JOD" information pages.** `[plan]` task 14 says information pages state 6 JOD. The string appears **nowhere** in `src/`. Either those pages live outside this repo, or the plan refers to a state since changed, or to a surface I did not find. Flagged for Karam (F5, CMO-013).
9. **Whether `@mazzadoofficial`'s bio copy trips policy.** The brief names bio copy (`[plan]` task 23). **Bios are not in the repo.** Karam must paste the current bio text for review; §1's Never list is the checklist to run it against.
10. **The tracking-event table from cto-product.** Being produced in parallel; not available to me. §4 is written from code I read directly and may overlap or conflict with it. **If they conflict, cto-product's reading of the event plumbing should win on plumbing; §4's mapping of events to blocked campaign decisions stands independently.**
