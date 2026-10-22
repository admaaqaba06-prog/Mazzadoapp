// Granting and revoking admin.
//
// The cases that matter are the ones that decide whether someone is locked out
// of production: both stores must be written (storage.rules reads only the
// custom claim, firestore.rules reads only the role), the claim must go first,
// and nobody may revoke themselves.

import { describe, it, expect } from 'vitest';
import { grantAdmin, revokeAdmin, canRevoke, normalizeEmail } from './adminRoles.js';

const NOW_MS = 1750000000000;
const FakeTimestamp = { fromMillis: (ms) => ({ _ms: ms, toMillis: () => ms }) };

function makeFakeAuth(users) {
  const claims = {};
  const order = [];
  return {
    _claims: claims,
    _order: order,
    async getUserByEmail(email) {
      const u = users[email];
      if (!u) throw new Error('auth/user-not-found');
      return { ...u, customClaims: claims[u.uid] ?? u.customClaims };
    },
    async setCustomUserClaims(uid, c) {
      claims[uid] = c;
      order.push('claim');
    },
  };
}

function makeFakeDb() {
  const writes = [];
  const order = [];
  return {
    _writes: writes,
    _order: order,
    collection(name) {
      return { doc: (id) => ({ _path: `${name}/${id ?? 'auto'}` }) };
    },
    batch() {
      const staged = [];
      return {
        set(ref, data, opts) { staged.push({ path: ref._path, data, opts }); },
        async commit() { writes.push(...staged); order.push('firestore'); },
      };
    },
  };
}

const USERS = { 'karam@mazzado.com': { uid: 'uid_karam' }, 'backup@mazzado.com': { uid: 'uid_backup' } };

function deps(db, auth) {
  return { db, auth, Timestamp: FakeTimestamp, now: () => NOW_MS };
}

const actor = { actorUid: 'uid_actor', actorEmail: 'owner@mazzado.com' };

describe('grantAdmin writes the role', () => {
  it('NEVER writes a custom claim — one source of truth', async () => {
    // An earlier draft set a claim for storage.rules. Two stores can diverge:
    // a console edit changes the role without the claim, and a revoked claim
    // lingers in the ID token for up to an hour. storage.rules now reads the
    // same document through firestore.get().
    const auth = makeFakeAuth(USERS);
    const db = makeFakeDb();
    await grantAdmin(deps(db, auth), { email: 'karam@mazzado.com', ...actor });
    expect(auth._order).toEqual([]);
    expect(auth._claims).toEqual({});
  });

  it('sets the role, which is what firestore.rules and the callables read', async () => {
    const auth = makeFakeAuth(USERS);
    const db = makeFakeDb();
    await grantAdmin(deps(db, auth), { email: 'karam@mazzado.com', ...actor });
    const w = db._writes.find((x) => x.path === 'users/uid_karam');
    expect(w.data.role).toBe('admin');
    expect(w.data.isAdmin).toBe(true);
  });

  it('records who granted it, in the same batch as the role', async () => {
    const auth = makeFakeAuth(USERS);
    const db = makeFakeDb();
    await grantAdmin(deps(db, auth), { email: 'karam@mazzado.com', ...actor });
    const audit = db._writes.find((x) => x.path.startsWith('adminRoleAudit/'));
    expect(audit.data).toMatchObject({ action: 'grant', targetEmail: 'karam@mazzado.com', actorUid: 'uid_actor' });
  });

  it('says plainly when the account does not exist yet', async () => {
    // The common case: adding an admin before they have ever signed in. A
    // generic failure sends someone hunting for a typo that is not there.
    const auth = makeFakeAuth(USERS);
    await expect(grantAdmin(deps(makeFakeDb(), auth), { email: 'nobody@mazzado.com', ...actor }))
      .rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses a blank email and an unauthenticated actor', async () => {
    const d = deps(makeFakeDb(), makeFakeAuth(USERS));
    await expect(grantAdmin(d, { email: '  ', ...actor })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(grantAdmin(d, { email: 'karam@mazzado.com' })).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

describe('revokeAdmin', () => {
  it('clears the role, immediately', async () => {
    const auth = makeFakeAuth(USERS);
    const db = makeFakeDb();
    await revokeAdmin(deps(db, auth), { email: 'karam@mazzado.com', ...actor });
    const w = db._writes.find((x) => x.path === 'users/uid_karam');
    expect(w.data.role).toBe('user');
    expect(w.data.isAdmin).toBe(false);
    expect(auth._claims).toEqual({});
  });

  it('REFUSES SELF-REVOCATION', async () => {
    // The classic way an access-control system removes its own last operator:
    // someone tests the revoke flow on the account they are signed in as.
    const auth = makeFakeAuth({ 'me@mazzado.com': { uid: 'uid_actor' } });
    await expect(
      revokeAdmin(deps(makeFakeDb(), auth), { email: 'me@mazzado.com', actorUid: 'uid_actor' })
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('keeps the audit row — history is the point of it', async () => {
    const auth = makeFakeAuth(USERS);
    const db = makeFakeDb();
    await revokeAdmin(deps(db, auth), { email: 'karam@mazzado.com', ...actor });
    const audit = db._writes.find((x) => x.path.startsWith('adminRoleAudit/'));
    expect(audit.data.action).toBe('revoke');
  });
});

describe('canRevoke', () => {
  it('is false for yourself and true for anyone else', () => {
    expect(canRevoke('a', 'a')).toBe(false);
    expect(canRevoke('a', 'b')).toBe(true);
    expect(canRevoke(null, 'b')).toBe(false);
    expect(canRevoke('a', null)).toBe(false);
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases so casing cannot create a second identity', () => {
    expect(normalizeEmail('  Karam@Mazzado.COM ')).toBe('karam@mazzado.com');
    expect(normalizeEmail(null)).toBe('');
  });
});
