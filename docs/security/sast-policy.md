# Static Application Security Testing (SAST) — Mazzado

**Owner:** Mazzado engineering
**Last reviewed:** 3 October 2026
**Audience:** Bank al Etihad / Staq production-access review, and whoever maintains this next.

---

## 1. Tool

**Semgrep**, pinned to `semgrep/semgrep:1.86.0`, run in GitHub Actions.

Semgrep rather than SonarQube. SonarQube needs a server to host, keep patched and
secure — a standing cost and one more system inside our trust boundary for a team
this size. Semgrep runs in CI with no infrastructure, and its rules are files in
this repository, so what we scan for is reviewable in the same pull request as
the code it scans.

There is no separate "security scanning environment" to compromise, and no
scanner credentials to leak. That is a deliberate choice, not an omission.

## 2. Configuration

Defined in [`.github/workflows/security-sast.yml`](../../.github/workflows/security-sast.yml).
Two layers:

**Public rulesets** — maintained by Semgrep, updated upstream:

| Ruleset | Covers |
|---|---|
| `p/javascript`, `p/typescript` | language-level defects |
| `p/react` | XSS sinks, unsafe rendering |
| `p/nodejs` | injection, path traversal, unsafe deserialisation |
| `p/secrets` | credentials committed to the repository |
| `p/owasp-top-ten` | the OWASP list |
| `p/ci` | workflow injection, unpinned actions |

**Our own rules** — [`.semgrep/mazzado.yml`](../../.semgrep/mazzado.yml). Each one
was written after a real incident or a real review finding in this codebase, not
copied from a template:

| Rule | What it prevents |
|---|---|
| `mazzado-hardcoded-admin-identity` | An email or uid literal granting production admin |
| `mazzado-client-writes-money-state` | The browser writing a payment or settlement field |
| `mazzado-payer-identifier-to-analytics` | A payer's CliQ alias, mobile or IBAN reaching analytics |
| `mazzado-secret-in-source` | Private keys, client secrets, API keys in source |
| `mazzado-bank-name-literal` | A hardcoded English bank name drifting from the account record |
| `mazzado-bank-name-literal-ar` | The same, for the Arabic name — the one a Jordanian customer reads |
| `mazzado-dangerous-html` | `dangerouslySetInnerHTML` on user-supplied content |

The bank-name rule exists because the receiving account has moved banks twice,
and each move left literals behind in customer-facing copy that named the wrong
bank. It is a correctness rule with a money consequence, which is why it is in
the security scan rather than a linter nobody runs.

## 3. Cadence

| Trigger | Why |
|---|---|
| Every pull request | A finding is cheapest to fix on the branch that introduced it |
| Every push to `main` | Catches anything merged by another route |
| Weekly, Mondays 04:00 UTC | Semgrep adds rules after our last commit. A repository with no pushes is not a repository with no vulnerabilities. |
| On demand (`workflow_dispatch`) | For a review or an audit request |

## 4. The build fails on a finding

`semgrep scan --error` exits non-zero on any result, failing the check on the pull
request. **It is on, as of 3 October 2026, and the finding count is zero.**

This is deliberate. A scanner whose output is advisory becomes a list nobody
reads: findings accumulate, the count becomes background noise, and the report
handed to a reviewer is a backlog rather than a result. Failing the build keeps
the number at zero by construction, because the only moment it can rise is a pull
request that someone is already looking at.

It exits non-zero on findings of **any** severity, warnings included. There is no
severity threshold to tune and no "accepted findings" list.

### Why it was off for two commits, and how that is prevented from recurring

The flag was deliberately absent between 30 September and 3 October 2026, while
the hardcoded administrative identity was being removed from 24 places. Turning
the gate on before that work landed would have failed every build on a finding
already found, documented and scheduled — and the alternatives were worse:
excluding those files would have hidden the finding from this very report, and
lowering the severity would not have helped, because the flag ignores severity.

A comment in a workflow file is not a control. So the restoration is now asserted
by a test — `src/constants/adminIdentity.test.ts` — which fails if `--error`
leaves the workflow, if the literal reappears anywhere, or if an action stops
being pinned to a commit SHA. Deleting the flag in a hurry now breaks the build
it was deleted to unblock.

## 5. Remediation process

1. **The build fails.** The finding is on the pull request, annotated on the
   exact line, before review.
2. **The author fixes it on that branch.** Not a ticket, not later — the pull
   request cannot merge red.
3. **If it is a false positive**, the rule is narrowed or the path excluded in
   `.semgrep/mazzado.yml`, *in the same pull request*, with a comment saying why.
   Blanket `nosem` suppressions in code are not used: a suppression in the scan
   config is visible to the next reviewer, one buried in a source line is not.
4. **If it is real but cannot be fixed immediately** — a dependency issue, or a
   change too large for that branch — the pull request does not merge. Splitting
   the fix out is the normal answer; shipping past a known finding is not.
5. **Findings from the weekly run** (a new upstream rule matching old code) open
   as an issue and are fixed on their own branch. These do not block unrelated
   work, because the code was already in production before the rule existed.

Every result is published to the repository's **Security** tab as SARIF, and kept
as a downloadable artifact for **90 days**. That artifact is the report.

## 6. What SAST does not cover

Stated plainly, because a scan report presented as complete assurance is
misleading:

- **Firestore security rules** are not JavaScript and are not covered by these
  rulesets. They are the real authorisation layer in this system. They are
  reviewed by hand on every change and asserted by the test suite — see
  `firestore.rules` and the guard tests in `src/constants/`.
- **Business-logic authorisation** — who may settle an order, who may see a
  counterparty's phone — is not a pattern a scanner recognises. It is covered by
  unit tests against the server functions (3,500+ tests, run on the same CI).
- **Dependency vulnerabilities** are `npm audit`'s job, not Semgrep's.
- **Secrets already committed in history** would not be caught by scanning the
  current tree. Nothing of that kind is known to be in this repository; the
  `.gitignore` refuses `*.crt`, `*.pem`, `*.key`, `*.p12`, `*.pfx` and
  service-account JSON.

## 7. Current status — zero findings, and what the first scan actually found

**Current: 0 findings.** 149 rules over 719 files, every pull request.

A zero that was always zero says nothing about the scanner. The first full run,
on 30 September 2026, returned **43 findings**. All 43 were resolved by
3 October. They were:

| Count | Rule | What it was | What was done |
|---:|---|---|---|
| 24 | `mazzado-hardcoded-admin-identity` | One email address and one uid granting production admin, across `firestore.rules` (5), `storage.rules` (1), Cloud Functions (11) and the client (7) | **Real.** Removed; access is now `users/{uid}.role`. See [`access-control-policy.md`](./access-control-policy.md) |
| 11 | `github-actions-mutable-action-tag` | Workflow steps pinned to movable tags (`@v4`) rather than commit SHAs — including the two workflows that hold the Firebase deploy credentials | **Real.** All eleven pinned to 40-character commit SHAs, with the version in a trailing comment |
| 7 | `mazzado-bank-name-literal` | Doc comments naming the integration partner ("Embedded CliQ (Bank al Etihad / Staq)") | **False positives.** The rule matched the bare name and so could not tell prose from a string. Narrowed to require an opening quote on the same line, and its blind spot written into the rule. Zero true positives in seven — the invariant is really held by `src/constants/brandBoundary.test.ts` |
| 1 | `mazzado-client-writes-money-state` | The browser writing `paymentStatus: 'paid'` in `orderWorkflow.ts` | **Real, and dead.** Payment moved to the `submitOrderPayment` callable in Wave 1 and nothing had called this branch since; `paymentStatus` is on the orders denylist in `firestore.rules`, so the write would have been rejected whole. The branch was deleted |

Two of the four were genuine defects a reviewer would care about; one was a
supply-chain exposure nobody had raised; one was the scanner being wrong, which
is recorded here rather than quietly excluded.

### A failure mode worth naming

The first version of `.semgrep/mazzado.yml` used Semgrep's AST patterns and
failed to load — exit 7 — twice: once on an invalid `typescriptreact` language
key, once on patterns that would not parse. **Semgrep rejects the entire config
on one bad rule, so no rule ran at all**, while the check showed red for a reason
that looked like the code under inspection. A config that does not load is not a
weaker scan; it is no scan.

Separately, the admin rule was blind twice over in its first form: its
`languages` key meant it never opened a `.rules` file, and its pattern matched
the plain address while `firestore.rules` stores it escaped for its own regex
engine (`admaaqaba06@gmail\\.com`). It would have reported zero findings over
four live grants. Both are why every rule here is now a regex on `generic`, and
why the admin invariant is also asserted by a plain unit test that needs no
scanner at all.
