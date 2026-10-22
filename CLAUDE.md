# MAZZADO — Project Instructions (read by every Claude Code session and subagent)

Last reviewed: 2026-10-22.

## Sources of truth, and which one wins

This file is a **summary**. It is injected into every session and every subagent,
which makes a stale line here more dangerous than a stale line anywhere else: an
agent will reason from it without ever opening the document it summarises.

Precedence, highest first:

1. `ops/DECISIONS.md` — a decision marked APPROVED, with its date.
2. **The newest dated plan Karam has supplied.** Currently
   `ops/data/2026-09-27-60-day-plan.karam-stated.md` (the 60-day execution plan,
   27 Sep 2026).
3. This file.

**When this file and a dated plan disagree, the plan wins and this file is wrong
— say so and fix it.** That has already happened once: the fee model below.

A number in a plan is **stated, not measured**. Precedence settles *what we have
decided*, never *what is true*. Evidence still comes from code, exports or a query.

## What MAZZADO is

Jordan-focused online auction marketplace (mazzado.com / مزادو).
Stack: React 19, Vite 6, Tailwind CSS 4, TypeScript, Firebase (Auth, Firestore,
Storage, Hosting, Functions v1 / Node 20), project `mazadjoapp`, `us-central1`.
No router library — `activeView` + History API; route table in `src/utils/navUrl.ts`.
Notifications: WhatsApp.

**Payments — CliQ (Bank al Etihad embedded CliQ via Staq), production onboarding.**
Verified 2026-10: the UX, the data model and the server-side state machine are
built and sit behind a **fail-closed feature flag that is OFF in production**; no
BAE API call is implemented; a static egress IP for BAE's whitelist is live
(PR #308). Payment verification is therefore **manual today**.
An earlier draft of this file stated the data endpoints return "403 pending a
bank-side API product subscription". That is **unverified here** — the last
blocker seen in the bank thread (2026-10-05) was developer-portal / sandbox
access. Confirm with Karam before reasoning from either.

## Business model

**Live today:** 5% seller fee + 5% buyer fee — effective take rate 10% — plus a
paid bidder membership, mostly the 1 JOD tier.

**Decided but NOT yet shipped:** a **6 JOD delivery fee**, per task 14 of the
27 Sep plan: charged across every screen (listing, bid confirmation, checkout,
order, WhatsApp) *and* written into the legal terms, as one release, after a
Jordanian lawyer reviews the wording.
Until that ships the product charges no delivery fee, while the information pages
already say 6 JOD and the legal terms enumerate fees exhaustively **without** it.
That gap is itself a live exposure, named in the plan.

**Therefore: any unit-economics work models BOTH cases** — no delivery fee (today)
and 6 JOD charged (after task 14) — and labels which is which. Do not present one
as the model.

## Open questions — do not treat these as settled either way

These were previously written here as fixed constraints. They are not; the 27 Sep
plan reopened both. An agent that argues either side without the week-1 data is
guessing.

**The paid bidder membership.** Status: **HELD, pending data** (plan, p.1).
The case for keeping it: paying filters out unserious bidders — a real concern.
The case against, from the plan: it is mostly the 1 JOD tier and returns roughly
30 JOD a month; 24 of 313 registrations paid (7.7%); it asks a stranger to pay
before they have seen anyone win or receive anything. Commission already earns
far more and grows with volume instead of capping it.
**Decision rule:** settled by the week-1 Firestore pull — what happened to the
bids that did not become sales. Reviewed in week 1 by Karam. Until then, propose
neither removal nor retention as settled; quantify instead.

**Influencer spend.** Two rules exist and have **not** been reconciled:
- *"No influencers in the first 30 days"* — the earlier strategy anchor.
- *"Resume influencer spend only if week-2 metrics improved"* — plan task 24,
  gated on the registration rate moving from 1.5% toward 5%.
One is a calendar, the other a measurement. Until Karam reconciles them, **treat
the stricter as binding: no influencer spend is authorised.** That default is the
orchestrator's, chosen to be safe, not Karam's ruling — it is logged PENDING in
`ops/DECISIONS.md` and he may overturn it.

## Strategy anchors (not in dispute)

"Community before ads." Brand message = **market-set pricing** and **transparent
public auction** — not "win", not "unbelievable price", not one-dinar framing,
which is what Meta's automated systems read as gambling or unrealistic-outcome
content. Concentrate demand on few auctions with unified closing times; Friday
8PM live event; 10–15 controlled test auctions to generate real clearing data.

Open CEO holds on the 90-day plan: supply model sustainability, per-auction unit
economics, ASV evidence, Months 2–3 budget.

## Team

- Lead orchestrator = the main Claude Code session. It plans, delegates, merges, and owns ops/BACKLOG.md and ops/DECISIONS.md.
- cto-product   → code, architecture, QA, security, UX of auction/bid/membership/checkout flows.
- cmo-growth    → positioning, content, Meta Ads plans, creative briefs, campaign analysis.
- coo-revenue   → sellers, buyers, unit economics, KPIs, weekly business review.
Subagents cannot spawn other subagents. Cross-agent work goes through the orchestrator and the shared files below.

## Shared, version-controlled workspace (ops/)

- ops/BACKLOG.md            single prioritized backlog (orchestrator edits; agents propose via their reports)
- ops/DECISIONS.md          decision log (append-only)
- ops/KPI_DASHBOARD_SPEC.md metric definitions — the single source of truth for formulas
- ops/WEEKLY_PLAN.md        current week's execution plan
- ops/30_DAY_PLAN.md        30-day plan
- ops/CAMPAIGN_PLAN.md      Meta campaign plan
- ops/DATA_REQUIREMENTS.md  integrations/data access needed
- ops/STATUS.md             what is configured / works / needs human access or approval
- ops/reports/<agent>/YYYY-MM-DD-<topic>.md   each agent's dated outputs
- ops/data/                 exported data snapshots (CSV/JSON) with source + export date in filename. NEVER commit personal data (phone numbers, names, national IDs, payment refs) — aggregate or anonymize first.

## Hard rules (all agents)

1. NEVER fabricate metrics, campaign results, integrations, or "completed" actions. Every number needs a source (file path, query, export) or is labeled HYPOTHESIS / TARGET / ASSUMPTION.
2. NEVER deploy to production, run `firebase deploy`, change Firestore/Auth production data, change security rules in prod, publish content, launch/edit/pause ads, spend money, or message customers/sellers without explicit written approval from Karam recorded in ops/DECISIONS.md.
3. If an integration or access is missing, write it to ops/DATA_REQUIREMENTS.md and say so plainly. Do not simulate it.
4. Work on a git branch (`agent/<agent-name>/<topic>`), never directly on main. Small, reviewable commits.
5. Arabic content: Jordanian/Levantine-appropriate Arabic, RTL-correct. Bilingual (AR/EN) where customer-facing. Do not rewrite live customer-facing Arabic copy without flagging it for Karam's approval.
6. Prioritize by business impact on the funnel: visit → register → paid membership → bid → win → CliQ payment → delivery → completed transaction (and seller: contacted → listed → closed ≥ reserve → paid out).
7. Secrets: never print, commit, or copy .env values, service-account keys, CliQ RSA keys/certs, or API tokens.
8. Pricing, commission, membership and delivery amounts are Karam's. Do not change one in code because a plan says so — the plan authorises the work, a logged APPROVED decision authorises the change.

## Already settled — do not re-litigate or re-audit

Verified in code and against the live site, 2026-10 (see
`ops/reports/orchestrator/2026-10-22-context.md` for the evidence):
bidding is server-authoritative inside a Firestore transaction, with a
server-side rate limit and ban check; orders are server-created and every
financial field is denylisted against all clients including admin; admin is a
role with one source of truth, `users/{uid}.role` (PR #313); the Semgrep SAST
gate runs with `--error` at zero findings; PR #299 is deployed and live.

## Report format (every agent output)

Summary (3–5 lines) · Evidence (with sources) · Findings ranked by impact · Proposed backlog items (ID, impact, effort, owner) · Decisions needed from Karam · What I could NOT verify and why.
