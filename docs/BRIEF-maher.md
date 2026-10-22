# Brief — Maher

Two jobs, independent of each other. **(A)** finish the Bank al Etihad CliQ integration.
**(B)** finish removing the hardcoded admin identity.

Repo: `admaaqaba06-prog/Mazzadoapp` · project `mazadjoapp` · region `us-central1`
Firebase: Firestore, Auth, Cloud Functions **v1 (1st gen, Node 20)**, Hosting.

Read this whole brief before starting. It contains things that are not obvious from
the code and that have already cost time once.

---

## House rules — these are not negotiable

1. **Never commit a key, token, certificate or IBAN.** `.gitignore` already refuses
   `*.crt *.pem *.key *.p12 *.pfx` and service-account JSON. Secrets go in Firebase
   secrets — never `functions:config`, never `.env`, never the repo.
2. **Never trust the client for money, auction status, or permissions.** Every such
   decision is made server-side, inside a transaction where money is involved.
3. **`firestore.rules` and `storage.rules` changes get shown to Karam before deploying.**
4. **Do not change any price, commission or subscription amount.**
5. **Do not rewrite Arabic user-facing copy** without flagging it. New copy is fine,
   but say so in the PR so Karam can read it.
6. **No new dependencies** without asking.
7. **Do not disable a failing test to go green.** If a test blocks you it is either
   telling you something, or its invariant genuinely changed — say which, in the PR.
8. **Verify from the live artefact, not the deploy log.** A green deploy is not
   evidence. Fetch the served bundle, call the function, read the value back.

Run before every push: `npx tsc --noEmit && npx vitest run` — 3,500+ tests, ~60s.

---

# JOB A — Bank al Etihad CliQ integration

## What already exists — do NOT rebuild it

The whole payer-facing flow, the data model and the server state machine are done and
merged. Read these before writing anything:

| File | What it is |
|---|---|
| `src/components/order/CliqPaymentFlow.tsx` | The 7 buyer screens BAE specified |
| `functions/cliqPayment.js` | Server core: 90-min duplicate lock, amount check, webhook handler |
| `functions/index.js` → `createCliqPaymentRequest` | The callable. **This is where the API call goes.** |
| `src/utils/cliqIdentifier.ts` | Alias / Jordanian-mobile validation, normalisation, masking |
| `src/utils/cliqIban.ts` | Payer bank name from the IBAN prefix (full BAE code list) |
| `src/utils/cliqRequest.ts` | Client mirror of the 90-minute lock — **display only** |
| `docs/MAZZADO-CliQ-Payment-UX.html` | What was sent to the bank |

The integration points are marked `// TODO: BAE CliQ API`. There are two.

**The rail is behind a feature flag, `enableCliqGateway`, which is OFF in production.**
Leave it off. Turning it on with no bank behind it tells a real buyer "we sent the
request to your bank" when nothing was sent, and then locks them out of retrying for
90 minutes while their payment deadline runs down.

## What you need to do

### A1. Portal, certificate, application

Karam does the portal registration; coordinate with him.

```
openssl genrsa -out mazzado.key 2048
openssl req -sha256 -new -key mazzado.key -out mazzado.csr \
  -subj "/C=JO/ST=Amman/L=Amman/O=MAZZADO/OU=Engineering/CN=<portal username>/emailAddress=<same>"
```

Upload the CSR at `developer.bankaletihad.com/certificates`, download the signed
certificate. Create a **B2B** application with scope **CLIQ Payment**.

Store cert, key, client id and client secret in Firebase secrets:
`CLIQ_GATEWAY_CERT`, `CLIQ_GATEWAY_KEY`, `CLIQ_GATEWAY_CLIENT_ID`,
`CLIQ_GATEWAY_CLIENT_SECRET`, `CLIQ_WEBHOOK_SECRET`.

### A2. Token + payment request

Token: `POST https://api.developer.bankaletihad.com/api/v1/tppa/token`, mTLS with the
cert and key, `grant_type=client_credentials`, `scope=cliqpayment`. Returns a bearer
token, `expires_in` 3599. **Cache it** — do not fetch one per payment.

Payment request: `POST /api/v1/partner/cliq/payment/request`

```json
{ "Alias": "<payer alias or mobile>", "Amount": 12.6, "ExternalTransactionId": "<our id>" }
```

Response carries `ObjectId`, `AccountNumber`, `Timestamp`.

Wire it inside `createCliqRequest` in `functions/cliqPayment.js`, at the marked TODO,
**inside the existing transaction**, and use the response for `cliqRequestId` and
`cliqPayerIbanPrefix` (the first 8 chars of `AccountNumber` — that is what drives the
payer bank name on screen 4).

### A3. Webhook

Create an HTTPS function. Verify the `X-Finto-Signature` header — format is
`t=<unix>,s=<hex>`. Reject anything that fails, and reject a stale timestamp.
Respond `200` with `{"Result":"Success"}` — Staq retries otherwise.

Then call the existing `applyCliqWebhook` in `functions/cliqPayment.js`. **Do not write
a second state machine.** Read that function first; it already handles the hard cases.

### A4. The eight test cases

They are in Staq's document (§6). Karam has it. Cover them.

## ⚠️ Things that will bite you

**The static IP.** `createCliqPaymentRequest` routes through a VPC connector so its
outbound traffic leaves from **35.193.49.148**, which the bank whitelists. The config
is the `BAE_EGRESS` constant in `functions/index.js`.

- **Put it on the webhook-calling function too if that function makes outbound calls.**
- **Do not put it on a high-frequency function** like `placeBid` — `ALL_TRAFFIC` routes
  *everything* through the NAT, Firestore included, and you would bill NAT on every bid
  and add a hop inside a live auction.
- If the connector is deleted, deploys of those functions **fail**. That is deliberate.
- Verify with the admin callable `checkEgressIp` — it reports the address calls actually
  leave from. Reserving a NAT does not prove a function uses it.

**BAE only notifies on SUCCESS.** Their documentation describes a "Payment notification"
and nothing else. There is no `rejected` callback. `expired` is derived locally from the
90-minute window. Do not wait for events that will not arrive.

**`TransactionId` may be null.** One example in their own document shows
`"TransactionId": null` — and that is our reconciliation key. Karam has asked them
whether it can genuinely arrive null. **Do not design reconciliation around it until
that answer comes back.** If it can be null, alias + amount is ambiguous and we need
another key.

**Money never comes from the client.** `resolveCliqAmount` reads the settled
`order.totalDue` the settler wrote. The browser sends its displayed total *only* so a
mismatch can be refused. Keep it that way.

**Read `functions/cliqPaymentSafety.test.js` before touching the webhook.** It encodes
two cases that cost a rewrite: a payment landing on an order that already defaulted, and
a late payment for a superseded request. Both must be recorded and escalated, never
dropped — money moved at the bank and our side must have a trace.

---

# JOB B — Finish the admin role migration

## The problem

Admin access is granted partly by a **hardcoded identity**: the email literal
`admaaqaba06@gmail.com` and the uid literal `wtu2pG6X6Jc0mvhyKBCUsca2X0A2`. About 20
occurrences across `functions/index.js`, `firestore.rules`, `storage.rules` and
`src/context/AppContext.tsx`.

Bank al Etihad's access-control requirement is role-based access with individual
accounts. A personal address compiled into source as a superuser fails it: it cannot be
revoked without a deploy, it survives the person leaving, and anyone who can read the
repo can read it.

## What is already done — PR #312, read it first

- `functions/adminRoles.js` — `grantAdmin` / `revokeAdmin`, with tests
- `grantAdminRole` / `revokeAdminRole` callables, both behind `assertAdmin`, both writing
  an `adminRoleAudit` row whose actor comes from the **verified token**
- `scripts/admin/grant-admin.cjs` — one-time bootstrap via Admin SDK, takes an email
  **or** `--uid`
- `storage.rules` `isAdmin()` now reads `users/{uid}.role` via `firestore.get()`
- Four client defects fixed in `AppContext.tsx` / `AdminPanel.tsx` (see below)

**One source of truth: `users/{uid}.role`.** A custom claim was considered and rejected —
two stores can diverge, and a claim cannot be revoked promptly because it lives in the ID
token for up to an hour. Do not reintroduce claims.

## What remains

### B1. Phases 2 and 3, in this order

**Nothing hardcoded comes out until Karam confirms the role path works.** That is his
call, not yours.

1. Deploy `storage.rules` (PR #312). It *adds* the role path and *keeps* the literal, so
   it cannot lock anyone out.
2. Karam grants himself the role with the bootstrap script.
3. Karam signs out, signs back in, and confirms **both**: the admin panel opens, **and a
   payment-proof file opens**. The second is what proves `storage.rules` reads the role.
4. Grant the backup admin by role.
5. **Only then**, remove every literal — functions, `firestore.rules`, `storage.rules`,
   client — and deploy. Verify both admins still work afterwards.

### B2. An admin UI for granting roles — ~~build~~ **DONE, review it**

Corrected after Maher pointed it out: this was built in the same commit that wrote this
brief, so the instruction above was stale the moment it was written.

`src/components/admin/AdminRoleToggle.tsx`, wired into the Members row. Four states,
checked in the browser: normal user, existing admin, yourself (no self-revoke offered —
the server refuses it), and a phone-only account with no email (both callables identify
by email). A grant asks twice.

Review it rather than rebuild it. The one thing worth a second opinion: rendering the
control is not authorisation — `assertAdmin` re-checks server side — so it is deliberately
not hidden from anyone.

### B3. Second admin

Karam will give you an email. Grant by role, never by code.

## ⚠️ Things that will bite you

**`karam@mazzado.com` is on Titan, not Google Workspace.** The app signs in by phone OTP
or Google only — there is no email/password, and Karam wants the login screen left alone.
So that address cannot sign in unless a Google Account is created against it. Until then
the admin identity is a phone account, granted with `--uid`.

**The browser used to demote admins.** `AppContext` had a branch writing
`role:'user', isAdmin:false` over a stored `role:'admin'` for anyone whose email was not
the literal — and the write succeeded. It is removed. **Do not reintroduce a client-side
privilege write of any shape.** Authorization is the rules' job. `firestore.rules` already
denylists `role` and `isAdmin` for a user updating their own document, so nobody can
self-promote and there is nothing for the client to defend against.

**Gate admin UI with `isAdminUser()`** from `src/utils/adminAuth.ts` — it accepts either
`role === 'admin'` or `isAdmin === true`. A bare `currentUser.role !== 'admin'` check hid
the panel from admins granted the other way.

**Nobody may revoke themselves.** `adminRoles.js` enforces it. It is how an access-control
system removes its own last operator. Leave it.

**⚠️ DO NOT GREP FOR THE PLAIN ADDRESS IN `firestore.rules`. IT RETURNS ZERO.**

Caught by Maher, and it is the sharpest trap in this migration. All four email
occurrences in that file are written **escaped for the rules regex engine**:

```
request.auth.token.email.matches('(?i)admaaqaba06@gmail\\.com')
```

So `grep "admaaqaba06@gmail\.com" firestore.rules` finds **nothing**, and anyone who
trusts that result leaves four live admin grants behind believing the file is clean.

**Grep the local part — `admaaqaba06` — which no escaping can hide.** Current positions:
lines ~16 (the **uid** literal, a different string), 18, 155, 163, 190. The file moves;
re-check before editing.

The Semgrep rule had the identical blind spot and has been fixed: it declared
`languages: [javascript, typescript]`, so it never opened a `.rules` file at all, and its
pattern contained `@gmail\.com`, which would not have matched the escaped form even if it
had. It is now `languages: [generic]` matching the local part. A SAST rule that cannot see
the authorization layer is a clean report over a live finding.

---

## Open PRs — do not duplicate this work

| PR | Branch | What |
|---|---|---|
| #307 | `feat/admin-member-lookup` | Admin search by name/phone; seller details form |
| #308 | `feat/bae-static-egress-ip` | Static egress IP (**already deployed**) |
| #309 | `fix/interests-screen-repeats` | Interests screen repeating on every login |
| #310 | `feat/whatsapp-cheap-lots-only` | WhatsApp digest limited to cheap lots |
| #311 | `feat/sast-semgrep` | Semgrep SAST + security policy |
| #312 | `feat/admin-roles-phase1` | Admin roles phase 1 (**Job B builds on this**) |

Branch off `main`, one concern per PR, and say in the PR body what you verified and how.

## When you are unsure

Say so in the PR rather than guessing. On this codebase a wrong guess about money,
permissions or a bank destination reaches a real customer — that has happened, which is
why several of the warnings above exist.
