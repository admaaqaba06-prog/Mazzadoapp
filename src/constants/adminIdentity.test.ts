// The hardcoded administrator stays removed.
//
// Administrative access used to be granted, in part, by one email address and
// one uid compiled into the source: 24 occurrences across firestore.rules,
// storage.rules, eleven Cloud Functions gates and six places in the client.
// A literal identity cannot be revoked without a deploy, it outlives whoever
// held it, and it is legible to anyone who can read the repository.
//
// WHY A TEST AS WELL AS A SEMGREP RULE. There is a Semgrep rule for exactly
// this (mazzado-hardcoded-admin-identity) and the CI gate now fails the build
// on it. That rule has already been blind twice: once because its `languages`
// key meant it never opened a .rules file, and once because the whole config
// failed to parse, which is not a weaker scan — it is NO scan, while the check
// still went red for an unrelated reason. This test runs in `npm test`, needs
// no scanner, and takes forty seconds instead of a CI round trip.
//
// It scans the SAME paths as the rule and, like the rule, does NOT strip
// comments: there is no reason to write that address down in code any more,
// and a comment is how a literal comes back one paste at a time.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, sourceFiles, stripComments, assertNonEmpty } from './sourceFiles';

/** .cjs/.mjs too — the admin bootstrap script is a .cjs and must be covered. */
const CODE_EXTS = /\.(ts|tsx|js|jsx|cjs|mjs)$/;

/**
 * LOCAL PART and uid only.
 *
 * firestore.rules wrote the address escaped for its own regex engine —
 * `admaaqaba06@gmail\\.com` — so a needle containing `@gmail.com` matched none
 * of those occurrences while appearing to cover them. Grepping the plain
 * address in that file returned zero hits. The local part has no such problem.
 */
const FORBIDDEN = ['admaaqaba06', 'wtu2pG6X6Jc0mvhyKBCUsca2X0A2'];

const RULES_FILES = ['firestore.rules', 'storage.rules'];

function codeFiles(): string[] {
  const files = [
    ...sourceFiles(join(ROOT, 'src'), CODE_EXTS),
    ...sourceFiles(join(ROOT, 'functions'), CODE_EXTS),
    ...sourceFiles(join(ROOT, 'scripts'), CODE_EXTS),
  ];
  assertNonEmpty(files, 'admin identity sweep');
  return files;
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('the hardcoded administrator stays removed', () => {
  it('appears in no source file, no Cloud Function and no script', () => {
    const offenders: string[] = [];
    for (const file of codeFiles()) {
      // This test file names the literals; it is the rationale, not a breach.
      if (file.replace(/\\/g, '/').endsWith('src/constants/adminIdentity.test.ts')) continue;
      const src = readFileSync(file, 'utf8');
      for (const needle of FORBIDDEN) {
        if (src.includes(needle)) offenders.push(`${relative(ROOT, file)} -> ${needle}`);
      }
    }
    expect(offenders, 'admin access must come from users/{uid}.role, never a literal').toEqual([]);
  });

  it('appears in neither rules file', () => {
    const offenders: string[] = [];
    for (const rel of RULES_FILES) {
      const src = read(rel);
      for (const needle of FORBIDDEN) {
        if (src.includes(needle)) offenders.push(`${rel} -> ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('one source of truth for the role', () => {
  it('reads admin from users/{uid} in firestore.rules', () => {
    const src = read('firestore.rules');
    expect(src).toMatch(/function isAdmin\(\)/);
    expect(src).toMatch(/documents\/users\/\$\(request\.auth\.uid\)/);
    expect(src).toMatch(/\.data\.role == 'admin'/);
  });

  it('reads the SAME document from storage.rules, via firestore.get', () => {
    // Storage cannot see Firestore without this call. If it ever loses it, the
    // only remaining admin path for payment proofs is gone and every
    // administrator is locked out of the evidence they verify payments with.
    const src = read('storage.rules');
    expect(src).toMatch(/firestore\.get\(\/databases\/\(default\)\/documents\/users\/\$\(request\.auth\.uid\)\)/);
    expect(src).toMatch(/\.data\.role == 'admin'/);
  });

  it('grants nothing from a custom claim', () => {
    // A claim would be a SECOND store that can disagree with the first, and it
    // lives in the ID token for up to an hour — so a revoked administrator
    // keeps access until it refreshes. Nothing in this repo ever called
    // setCustomUserClaims, which made every `token.admin` check dead code that
    // still read like a working second way in.
    const offenders: string[] = [];
    for (const file of codeFiles()) {
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      if (rel.endsWith('src/constants/adminIdentity.test.ts')) continue;
      const src = stripComments(readFileSync(file, 'utf8'), file);
      if (/\btoken\.admin\b/.test(src) || /\bclaims\.admin\b/.test(src)) offenders.push(rel);
    }
    expect(offenders, 'admin must come from the role record alone').toEqual([]);
    // Comments stripped for the rules files only: both record the custom-claim
    // design and why it was rejected, which is the reason this assertion
    // exists rather than a breach of it. stripComments() does not know the
    // .rules extension, and `//` is its comment syntax.
    const ruleCode = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(ruleCode('storage.rules')).not.toMatch(/token\.admin/);
    expect(ruleCode('firestore.rules')).not.toMatch(/token\.admin/);
  });

  it('routes every Cloud Functions gate through callerIsAdmin', () => {
    const src = stripComments(read('functions/index.js'), 'index.js');
    // The predicate takes the user document and nothing else.
    expect(src).toMatch(/function callerIsAdmin\(callerData\) \{/);
    expect(src).not.toMatch(/callerIsAdmin\([^)]*,/);
    // No gate reconstructs the check inline — that is how six of them kept an
    // email comparison the shared helper had already dropped.
    expect(src).not.toMatch(/role === 'admin' \|\| \w+\.isAdmin === true \|\|/);
  });
});

describe('the bootstrap script can actually reach a phone-only account', () => {
  it('accepts --uid as well as an email', () => {
    // Mazzado signs in with a phone OTP or Google. An administrator may have no
    // email on their auth record at all, so an email-only lookup cannot grant
    // the role to them. The usage text documented --uid while the argument
    // check rejected it: `--uid X` left `email` empty and died on the usage
    // message, so the documented form never once worked.
    const src = read('scripts/admin/grant-admin.cjs');
    expect(src).toMatch(/if \(!uidArg && !email\)/);
    expect(src).toMatch(/uidArg \? await auth\.getUser\(uidArg\) : await auth\.getUserByEmail\(email\)/);
  });

  it('still refuses to run without explicit credentials, or to write without --apply', () => {
    const src = read('scripts/admin/grant-admin.cjs');
    expect(src).toMatch(/GOOGLE_APPLICATION_CREDENTIALS/);
    expect(src).toMatch(/if \(!APPLY\)/);
  });
});

describe('the SAST gate', () => {
  const wf = () => read('.github/workflows/security-sast.yml');

  it('fails the build on any finding', () => {
    // `--error` was absent for exactly two commits, while the literal was being
    // removed from 24 places. A scanner whose findings are advisory becomes a
    // list nobody reads; this is the line that stops that happening again, and
    // it is cheap to delete in a hurry.
    expect(wf()).toMatch(/^\s*--error\s*$/m);
  });

  it('still has the rule that catches a reintroduced literal', () => {
    const rules = read('.semgrep/mazzado.yml');
    expect(rules).toMatch(/id: mazzado-hardcoded-admin-identity/);
    for (const needle of FORBIDDEN) expect(rules).toContain(needle);
    // `generic` is what lets it read firestore.rules and storage.rules, which
    // are not JavaScript and which held five of the occurrences.
    expect(rules).toMatch(/languages: \[generic\]/);
  });

  it('pins every action to a commit SHA, not a movable tag', () => {
    // A tag is moved by whoever owns the action; the commit it points at today
    // is not necessarily the one that runs tomorrow. These workflows hold the
    // Firebase deploy credentials.
    const bad: string[] = [];
    for (const wfName of ['ci.yml', 'firebase-deploy.yml', 'firebase-hosting-deploy.yml', 'security-sast.yml']) {
      const src = read(`.github/workflows/${wfName}`);
      for (const m of src.matchAll(/uses:\s*([^\s#]+)/g)) {
        const ref = m[1].split('@')[1] || '';
        if (!/^[0-9a-f]{40}$/.test(ref)) bad.push(`${wfName} -> ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
