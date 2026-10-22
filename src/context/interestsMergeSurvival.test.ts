// The interests screen came back on every login. This is the guard.
//
// AppContext's live user-doc merge builds `mergedUser` as an ALLOWLIST from
// scratch — `const mergedUser: User = { id: ..., name: ..., ... }` — so any
// field not named there is DROPPED the next time a snapshot arrives.
//
// saveInterests wrote `interests` and `interestsSkipped` to Firestore and
// mirrored them into local state correctly. Then the snapshot that write
// triggered rebuilt currentUser without them, needsInterestsOnboarding saw no
// interests again, and the user was pushed back to /onboarding/interests. On
// every login, forever.
//
// It is the third field this allowlist has eaten — the source comment records
// admin flags and onboardingCompleted before it. So this test does not just pin
// the two fields: it reads what saveInterests writes and asserts each one
// survives the merge, which means the next field added to that save cannot be
// silently forgotten.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, 'AppContext.tsx'), 'utf8');

/** The `const mergedUser: User = { ... }` object literal, as source text. */
function mergedUserBlock(): string {
  const start = SRC.indexOf('const mergedUser: User = {');
  expect(start, 'the live user merge was renamed — update this guard').toBeGreaterThan(-1);
  const end = SRC.indexOf('\n        };', start);
  expect(end, 'could not find the end of the mergedUser literal').toBeGreaterThan(start);
  return SRC.slice(start, end);
}

/** The field names saveInterests writes to users/{uid}. */
function savedByInterests(): string[] {
  const start = SRC.indexOf("batch.update(doc(db, 'users', uid), {");
  expect(start, 'saveInterests batch.update was renamed — update this guard').toBeGreaterThan(-1);
  const end = SRC.indexOf('\n    });', start);
  const block = SRC.slice(start, end);
  return [...block.matchAll(/^\s{6}(\w+):/gm)].map((m) => m[1]);
}

describe('the live user merge carries what the client saves', () => {
  it('names every field saveInterests writes', () => {
    const merged = mergedUserBlock();
    const saved = savedByInterests().filter(
      // Server-managed metadata, deliberately not mirrored into currentUser:
      // a timestamp nothing reads, and the consent record the audit
      // subcollection is the real source for.
      (f) => !['interestsUpdatedAt', 'notificationConsent'].includes(f),
    );

    expect(saved.length, 'parsed no fields out of the interests save').toBeGreaterThan(0);

    const missing = saved.filter((f) => !new RegExp(`^\\s+${f}:`, 'm').test(merged));
    expect(
      missing,
      `these fields are saved but dropped by the live merge, so they reset on the next snapshot: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('carries interests and interestsSkipped specifically', () => {
    // Named explicitly as well as derived, because these two are the ones that
    // produced the reported bug and the regression must be unmistakable.
    const merged = mergedUserBlock();
    expect(merged).toMatch(/^\s+interests:/m);
    expect(merged).toMatch(/^\s+interestsSkipped:/m);
  });

  it('uses an undefined-check, not a truthy-check, for the skip flag', () => {
    // `fbData.interestsSkipped || currentUser.interestsSkipped` would be wrong:
    // a stored `false` is a real answer, and OR would discard it in favour of
    // whatever was in memory.
    const merged = mergedUserBlock();
    expect(merged).toMatch(/interestsSkipped:\s*fbData\.interestsSkipped !== undefined/);
  });

  it('uses an undefined-check for the notification toggles too', () => {
    // Same trap: `notifyDaily: fbData.notifyDaily || ...` would resurrect an
    // opt-OUT as whatever was in memory, which is a consent bug, not a UI one.
    const merged = mergedUserBlock();
    for (const f of ['notifyDaily', 'notifyFeatured']) {
      expect(merged, `${f} must not be merged with a truthy check`).toMatch(
        new RegExp(`${f}:\\s*fbData\\.${f} !== undefined`),
      );
    }
  });
});
