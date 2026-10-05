'use strict';
/**
 * Granting and revoking administrative access, as a role rather than a literal.
 *
 * WHY THIS EXISTS. Admin access was granted in part by an email address and a
 * uid compiled into source — in Cloud Functions, in firestore.rules, in
 * storage.rules and in the client. A literal identity cannot be revoked without
 * a deploy, survives the person leaving, and is readable by anyone who can read
 * the repository. Bank al Etihad's production-access review requires role-based
 * access with individual accounts, and a personal address hardcoded as a
 * superuser does not meet it.
 *
 * ONE SOURCE OF TRUTH: users/{uid}.role
 *
 * An earlier draft of this file also set a Firebase custom claim, because
 * storage.rules at the time read `request.auth.token.admin` and could not see
 * a Firestore document. That was rejected, and the reasoning is worth keeping:
 *
 *   - TWO STORES CAN DIVERGE. A grant that writes both is two writes that can
 *     half-fail, and an admin editing users/{uid} in the Firebase console would
 *     change the role without touching the claim. "Is this person an admin?"
 *     would then have two answers, and the security question becomes which
 *     store you happened to ask.
 *   - A CLAIM CANNOT BE REVOKED PROMPTLY. Custom claims live in the ID token,
 *     so a revoked administrator keeps Storage access until their token
 *     refreshes — up to an hour. For the one action you most want to be
 *     instant, that is the wrong property.
 *
 * storage.rules now reads the same document through firestore.get(). The read
 * sits behind `isOwner(userId) || isAdmin()` and Firestore rules short-circuit,
 * so an ordinary owner fetching their own receipt never triggers it; it is
 * evaluated only for an admin reading someone else's file, or a delete. That is
 * a handful of reads, and the price of having one answer.
 */

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Normalised email, or '' when the input is not usable. */
function normalizeEmail(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * Can `actorUid` revoke `targetUid`?
 *
 * NOBODY MAY REVOKE THEMSELVES. It is the classic way an access-control system
 * removes its own last operator: the person testing the revoke flow tries it on
 * the account they are signed in as, and there is then no one left who can grant
 * it back. Revoking someone else always has a second admin to undo it; revoking
 * yourself may not.
 */
function canRevoke(actorUid, targetUid) {
  if (!actorUid || !targetUid) return false;
  return actorUid !== targetUid;
}

/**
 * Grant admin to the account with this email.
 *
 * The role and the audit row are written in ONE batch, so a grant cannot exist
 * without a record of who made it — which is the whole point of an audit trail
 * a reviewer is going to read.
 */
async function grantAdmin(deps, args = {}) {
  const { db, auth, Timestamp, now = () => Date.now() } = deps;
  const { email, actorUid, actorEmail } = args;

  const target = normalizeEmail(email);
  if (!target) throw makeError('invalid-argument', 'An email address is required.');
  if (!actorUid) throw makeError('unauthenticated', 'Missing the acting administrator.');

  let user;
  try {
    user = await auth.getUserByEmail(target);
  } catch (e) {
    // Deliberately specific: "no such account" is the common case when an admin
    // is being added before they have signed up, and a generic failure here
    // sends someone hunting through logs for a typo that is not there.
    throw makeError('not-found', `No account exists for ${target}. They must sign in once before they can be granted admin.`);
  }

  const ts = Timestamp.fromMillis(now());

  const batch = db.batch();
  batch.set(db.collection('users').doc(user.uid), {
    role: 'admin',
    isAdmin: true,
    adminGrantedAt: ts,
    adminGrantedBy: actorEmail || actorUid,
  }, { merge: true });
  batch.set(db.collection('adminRoleAudit').doc(), {
    action: 'grant',
    targetUid: user.uid,
    targetEmail: target,
    actorUid,
    actorEmail: actorEmail || null,
    at: ts,
  });
  await batch.commit();

  return { uid: user.uid, email: target, granted: true };
}

/**
 * Remove admin from the account with this email.
 *
 * Takes effect immediately — the next rule evaluation reads the changed
 * document. The audit row is kept: an access-control record that deletes its own
 * history answers no question a reviewer will ask.
 */
async function revokeAdmin(deps, args = {}) {
  const { db, auth, Timestamp, now = () => Date.now() } = deps;
  const { email, actorUid, actorEmail } = args;

  const target = normalizeEmail(email);
  if (!target) throw makeError('invalid-argument', 'An email address is required.');
  if (!actorUid) throw makeError('unauthenticated', 'Missing the acting administrator.');

  let user;
  try {
    user = await auth.getUserByEmail(target);
  } catch (e) {
    throw makeError('not-found', `No account exists for ${target}.`);
  }

  if (!canRevoke(actorUid, user.uid)) {
    throw makeError('failed-precondition', 'You cannot revoke your own administrative access. Ask another administrator.');
  }

  const ts = Timestamp.fromMillis(now());

  const batch = db.batch();
  batch.set(db.collection('users').doc(user.uid), {
    role: 'user',
    isAdmin: false,
    adminRevokedAt: ts,
    adminRevokedBy: actorEmail || actorUid,
  }, { merge: true });
  batch.set(db.collection('adminRoleAudit').doc(), {
    action: 'revoke',
    targetUid: user.uid,
    targetEmail: target,
    actorUid,
    actorEmail: actorEmail || null,
    at: ts,
  });
  await batch.commit();

  return { uid: user.uid, email: target, revoked: true };
}

module.exports = { grantAdmin, revokeAdmin, canRevoke, normalizeEmail };
