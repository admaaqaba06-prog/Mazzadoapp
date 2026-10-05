# Access Control Policy — Mazzado

**Owner:** Mazzado engineering
**Last reviewed:** 3 October 2026
**Audience:** Bank al Etihad / Staq production-access review, and whoever maintains this next.

This document has two halves, kept deliberately separate:

- **Policy** — what people are required to do.
- **Enforcement** — what the system makes impossible, with the file and function
  that does it, so a reviewer can check the claim rather than take it.

A policy statement with no enforcement behind it is marked as such.

---

## 1. Roles

Mazzado has three application roles. The role lives in exactly one place:
the field `role` on the Firestore document `users/{uid}`.

| Role | Can do | Cannot do |
|---|---|---|
| `user` | Browse, bid, pay for and receive their own orders; read and write their own profile | See another account's phone, address or payment proof; change any money field |
| `seller` | Everything a `user` can, plus list auctions, see their own orders' buyers, mark items prepared and dispatched | Verify a payment, release escrow, refund, settle, or see any account they are not transacting with |
| `admin` | Verify payments, release and refund escrow, resolve disputes, ban and unban accounts, grant and revoke `admin` | Write a subscription grant from the browser; revoke their own `admin` |

There is no fourth role and no per-feature permission grid. A grid nobody
maintains drifts from what the code checks; three roles that are each enforced
in one predicate do not.

### 1.1 Least privilege, concretely

Two restrictions apply to administrators as well as everyone else, because the
risk they address is a compromised admin browser session, not a dishonest
administrator:

- **Subscription grants are server-only for every client, admin included.**
  `touchesSubscriptionGrantFields()` in `firestore.rules` rejects the write
  whoever makes it; only Cloud Functions (Admin SDK) may set those fields.
- **Orders are server-created only** (`allow create: if false`), and every
  financial and identity field on an order is on a denylist that applies to the
  buyer, the seller and the admin client alike.

---

## 2. Individual accounts

**Policy.** Every person who touches production has their own account. Shared
logins, shared passwords and shared devices are prohibited. Nobody signs in as
"the admin account"; there is no such account.

**Enforcement.**

- Every privileged action is taken by a Firebase Auth `uid` and recorded against
  that `uid`. A grant writes `actorUid`; a ban writes the acting admin; a
  payment verification writes `paymentVerifiedBy`. There is no code path that
  records an action without an actor.
- Authentication is **Firebase Auth**. The sign-in surface offers two methods:
  a **one-time code to a phone number**, and **Google**. Neither produces a
  password that can be handed to a second person. (Email/password functions
  exist in the client context; no view calls them.)
- A second concurrent sign-in to the same account is detected and the older
  session is ended — the client writes a `sessionId` on login and signs itself
  out when the stored value changes. This is a *detection* of account sharing,
  not a prevention of it.

**Not enforced by the system:** that the person holding a phone or a Google
account is the person we think it is, and that the device is not shared. Those
are organisational controls. They are listed here as policy, not claimed as
technical facts.

---

## 3. How `admin` is granted

### 3.1 The normal path

`grantAdminRole`, a Cloud Function callable (`functions/adminRoles.js`,
exported in `functions/index.js`).

1. The caller must already be an administrator. This is re-checked **on the
   server** against the caller's own `users/{uid}` document — `assertAdmin()`.
   The UI button in `src/components/admin/AdminRoleToggle.tsx` is a button, not
   an authorisation.
2. The target is resolved through **Firebase Auth** (`auth.getUserByEmail`), not
   through the `email` field on the user document. That distinction matters: the
   document's `email` is writable by its owner, the Auth record's is not.
3. The role change and an audit row are written **in one batch**, so a grant
   cannot exist without a record of who made it.

### 3.2 The first administrator

`scripts/admin/grant-admin.cjs`, run once, with a service-account key.

The callable is admin-gated, so the first administrator cannot be created
through it without leaning on the very hardcoded identity this migration
removed. A script authenticated by a service-account key depends on no
application-level role at all.

It refuses to run unless `GOOGLE_APPLICATION_CREDENTIALS` is set — it will not
fall back to ambient credentials — and it writes nothing without `--apply`. It
accepts an email **or** `--uid`, because an administrator who signed up by phone
has no email on their auth record and could not otherwise be granted the role.

### 3.3 Revocation

`revokeAdminRole`. Same server-side caller check, same single-batch audit row.

**Nobody may revoke themselves.** This is the classic way an access-control
system loses its last operator: someone tests the revoke flow on the account
they are signed in as, and there is then nobody left who can grant it back.
Revoking somebody else always leaves a second administrator who can undo it.

**Revocation is immediate.** The next request reads the changed document. This
is the main reason the role record was chosen over a Firebase custom claim: a
claim lives in the ID token until it refreshes — up to an hour — so a revoked
administrator would keep Storage access for that long. For the one action you
most want to be instant, that is the wrong property.

### 3.4 Audit trail

Collection `adminRoleAudit`. One document per grant or revoke:

| Field | Meaning |
|---|---|
| `action` | `grant` or `revoke` |
| `targetUid`, `targetEmail` | Who the role changed for |
| `actorUid`, `actorEmail` | Who changed it |
| `at` | Server timestamp |

Revoke rows are **kept**. An access-control record that deletes its own history
answers no question a reviewer will ask.

---

## 4. Where the role is enforced

One record, read in three places. They must agree, so none of them holds its own
copy of the answer.

| Layer | File | Predicate |
|---|---|---|
| Database | `firestore.rules` | `isAdmin()` — `get(users/$(uid)).data.role == 'admin'` |
| File storage | `storage.rules` | `isAdmin()` — the **same document**, via `firestore.get()` |
| Server logic | `functions/index.js` | `callerIsAdmin(callerData)` — every gate in the file routes through it |

The client's `isAdminUser()` (`src/utils/adminAuth.ts`) decides what to *render*.
It is not an authorisation boundary and is not relied on as one: every action it
reveals is re-checked server-side.

### 4.1 What was removed, and why it was removed last

Until 3 October 2026, administrative access was **also** granted by one email
address and one uid written into source — 24 occurrences across
`firestore.rules` (5), `storage.rules` (1), Cloud Functions (11) and the client
(7).

A literal identity cannot be revoked without a deploy, it outlives whoever held
it, and it is legible to anyone who can read the repository. It also carried two
consequences that were not obvious until the code was read closely:

- **`firestore.rules` contained a self-promotion path.** The users-create rule
  allowed a document with `role: 'admin'` if the token's email matched the
  literal, and the client used it: on every sign-in the browser wrote
  `role:'admin', isAdmin:true` to its own document. Both the write and the
  exception are gone.
- **`storage.rules` had no working role path at all.** It accepted a custom
  claim or the email literal, and nothing in the codebase ever called
  `setCustomUserClaims`, so the claim was never set. The literal was the only
  functioning admin path to payment proofs. This is why the migration ran in two
  deploys: the role path was added and **confirmed working in production**
  before the literal was removed. Removing it first would have locked every
  administrator out of the evidence they verify payments with.

The order was: add the role path → confirm the admin panel and a payment-proof
file both open for an administrator holding only the role → remove the literal.

### 4.2 Keeping it removed

- `mazzado-hardcoded-admin-identity` in `.semgrep/mazzado.yml` — fails the build
  on any reintroduction. See [`sast-policy.md`](./sast-policy.md).
- `src/constants/adminIdentity.test.ts` — asserts the same thing in `npm test`,
  needing no scanner. It exists because that Semgrep rule has already been blind
  twice: once its `languages` key meant it never opened a `.rules` file, and
  once the whole config failed to parse, which is not a weaker scan but no scan.

---

## 5. Account suspension

An administrator may ban an account (`isBlocked: true`). A banned account cannot
bid: `placeBid` evaluates `isEffectivelyBlocked()` inside its transaction,
against the user document it has already read, so no client-side tampering
reaches it.

There are two kinds of ban and the predicate distinguishes them. An **admin ban**
has no expiry and holds until lifted. A **payment-default ban** is applied
automatically by the ladder in `functions/banLadder.js` — a cooldown on the first
default, a longer suspension on a repeat — and lapses on its own when
`blockedUntil` passes.

Every transition in or out of the blocked state flows through one Cloud Function
trigger, so the notification and the record are emitted exactly once whichever
route set the flag. A ban also blocks creating a listing
(`functions/listingApproval.js`) and activating as a seller
(`functions/sellerActivation.js`).

An administrator **cannot ban themselves** — the guard rejects it, and the UI
shows a "You" chip rather than a button that would only error. Unbanning is
always available, including on your own account, so a mistaken ban is not a
lockout.

---

## 6. Infrastructure access

Application roles are not the whole surface. These accounts bypass
`firestore.rules` entirely and are the ones worth guarding hardest.

| System | Access | Control |
|---|---|---|
| Firebase / Google Cloud console (project `mazadjoapp`) | Named Google accounts | Individual accounts; two-factor authentication **required by policy** |
| GitHub (`admaaqaba06-prog/Mazzadoapp`) | Named GitHub accounts | Individual accounts; two-factor authentication **required by policy** |
| Service-account keys | Used only for the one-time admin bootstrap and CI deploys | Never committed; `.gitignore` refuses `*.crt`, `*.pem`, `*.key`, `*.p12`, `*.pfx` and service-account JSON |
| Bank / Staq credentials | Firebase Secret Manager | Never in `functions:config`, never in `.env`, never in the repository |

**Maintained by Karam.** The current holder list for the first two rows is not
reproduced in this repository, because a roster in version control is a roster
that goes stale silently. It is reviewed on the cadence in §7.

The two-factor requirement in rows one and two is a **policy statement**: it is
enforced in the Google Workspace and GitHub organisation settings, not by
anything in this repository, so this document cannot evidence it. Rows three and
four are enforced by `.gitignore` and by where the secrets are stored, and are
checkable here.

---

## 7. Review and lifecycle

| Event | Action |
|---|---|
| Someone joins | Account created by that person signing in; role granted explicitly if they need more than `user`. No role is granted at sign-up — `onUserCreated` writes `role: 'user'` for every account without exception. |
| Someone changes role | Grant or revoke through the callable. The audit row is the record. |
| Someone leaves | `revokeAdminRole` the same day, and remove their Firebase and GitHub access. Application role and infrastructure access are separate removals; doing one is not doing the other. |
| Quarterly | Review `adminRoleAudit` and the current `role == 'admin'` holders against the people who should have it, and review the §6 roster. |
| On any incident | Immediate revoke; the audit trail is the starting point. |

---

## 8. Known gaps

Listed because a policy that claims completeness is not credible.

- **`grantAdminRole` resolves its target by email only.** An administrator who
  signed up with a phone number and has no email on their auth record cannot be
  granted the role through the UI; the bootstrap script's `--uid` form is the
  workaround. This should become a uid option on the callable.
- **`role` has an older mirror, `isAdmin`.** Both writers set the two together
  and `firestore.rules` honours either, but `storage.rules` reads `role` alone.
  A user document hand-edited to set only `isAdmin` would pass in Firestore and
  be refused in Storage. Do not hand-edit; use the callable.
- **Device and identity assurance is organisational, not technical** (§2).
- **There is no automated quarterly review.** §7 describes a calendar
  commitment, not a job that runs.
