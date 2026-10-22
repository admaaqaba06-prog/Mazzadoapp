# STATUS — what is configured, what works, what needs a human
Updated: 2026-10-22 (Phase 4 merge — COMPLETE, all three audits in)

## Configured and in the repo
- `CLAUDE.md` — corrected 2026-10-22 against the 27 Sep plan. Now carries a
  **precedence rule** (DECISIONS → newest dated plan → this file) because three of
  its statements had gone stale.
- 3 subagent definitions, 2 slash commands, `.claude/settings.json`
  (blocks `firebase deploy`, Firestore deletes, force pushes, push to main;
  blocks reading `.env`/keys/service accounts; asks before push or npm install).
- `ops/` workspace, with `ops/data/2026-09-27-60-day-plan.karam-stated.md` as the
  one real source on file.
- **`.claude/` is gitignored** (`.gitignore:12`) — the agents, commands and the
  deploy block are **local to Karam only**. Not shared with Maher. Open decision.

## Works now — verified, with how
- **Bidding is server-authoritative**: `placeBid` runs in a Firestore transaction
  with a server-side rate limit and ban check.
- **Money state is server-only**: orders are `allow create: if false`; financial
  fields are denylisted against every client including admin.
- **Admin is a role** with one source of truth, `users/{uid}.role` (PR #313).
- **SAST gate on and green**: Semgrep `--error`, zero findings, weekly through 19 Oct.
- **PR #299 is deployed** — pixel deferral and `signInIntent` confirmed in the
  live bundle, 2026-10-22.
- `scripts/analytics/funnel-week1.cjs` exists and is **safety-checked by the
  orchestrator**: zero write operations, refuses to run without
  `GOOGLE_APPLICATION_CREDENTIALS`, prints aggregates only, 32 green unit
  assertions on its pure logic. **It has never touched a database.**

## Does NOT work — found this cycle
- **Visits are unmeasurable by anyone.** No GA4; `analytics_events` requires
  `isSignedIn()` so anonymous visits never land; landing events reach
  `window.dataLayer`, which nothing creates, and stop. Eight landing funnel
  events have been built and silently discarded since launch.
- **`Subscribe`, `ViewContent`, `Purchase`, CAPI and GA4 do not exist** in the
  codebase. `CAMPAIGN_PLAN.md:13` names `Subscribe` as the primary optimization
  event for the entire paid plan — it cannot be configured.
- **No delivery-fee field exists anywhere.** `totalDue` is hammer + 5% only.
- **Failed handovers are not a recorded state.** No seller-side sweep, no 48h
  timer, `shippingStatus` never advances server-side. The 1-in-3 figure cannot be
  reproduced from data; the script yields a floor.
- **Three delivery-fee stories live at once**: "~2–4 JD" in `HowItWorksView.tsx:75`,
  the plan's 6 JOD which appears nowhere in `src/`, and no delivery clause in the
  legal terms.

## Live on mazzado.com and flagged — verified on the served page 2026-10-22
The H1 "اشترِ بأرخص سعر.", the iPhone 17 Pro Max "يبدأ من 1 دينار فقط", the
1 JOD/month bid membership and "بائعون موثّقون" are all on the live landing page.
Pay-to-bid beside win-a-flagship-from-a-dinar is the penny-auction shape Meta's
automated review catches. The hero also presents a **simulated lot as live** with a
named bidder, a viewer count and a reference number. Drafts to fix all of it are in
`ops/reports/cmo/2026-10-22-marketing-audit.md` §3, behind D-110.

## Needs human ACCESS
- **Meta**: Events Manager (verify the 4 real pixel events actually fire — CMO-010),
  domain verification, the six audiences, ad-account choice (D-102).
- **Firebase service-account key** so Karam can run the week-1 script.
- Current `@mazzadoofficial` bio text (not in the repo) for the policy sweep.
- Any Meta ban notice, if one exists — the ban's cause is currently Karam's
  inference, and the whole appeal is built on it.

## Needs human APPROVAL — nothing granted yet
D-101 … D-113 in `ops/DECISIONS.md`. The two that block the most:
**D-110** (approve the copy rewrites — no copy changes without it) and
**D-106** (the membership, which the week-1 script settles).
Any deploy · any ad launch or spend · any publish · any production data change.

## Cycle complete
All three audits are in and merged. Reports:
- `ops/reports/cto/2026-10-22-repo-audit.md` (637 lines)
- `ops/reports/cmo/2026-10-22-marketing-audit.md`
- `ops/reports/coo/2026-10-22-baseline.md`

**No application code was changed by any agent** — `git status` on `src/`,
`functions/`, the rules files, `index.html` and `vite.config.ts` is clean.

Build health: `tsc --noEmit` clean; `vitest` 3,522 passed / 1 flaky timeout
(passes alone in 4.2s — CTO-108). **The Firebase emulator is not configured**, so
every `firestore.rules` claim in the audits is read, not executed (CTO-107).
