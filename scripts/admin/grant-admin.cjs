#!/usr/bin/env node
'use strict';
/**
 * Grant administrative access to one account. ONE-TIME BOOTSTRAP.
 *
 * WHY A SCRIPT AND NOT THE CALLABLE. grantAdminRole is admin-gated, which means
 * the FIRST administrator cannot be created through it without relying on the
 * hardcoded identity we are removing — the bootstrap would depend on the very
 * thing it exists to retire. A script run with a service-account key does not
 * depend on any application-level role at all, so the first admin is
 * established independently and the literal can then be deleted cleanly.
 *
 * Use the callable for every admin AFTER the first. This is not a routine tool.
 *
 * It writes exactly what the callable writes — users/{uid}.role plus an
 * adminRoleAudit row — so the two paths cannot drift apart. There is no custom
 * claim: storage.rules reads the same document via firestore.get(). One source
 * of truth, see functions/adminRoles.js.
 *
 * IDENTIFIED BY EMAIL **OR** UID. Mazzado has no email/password sign-in — the
 * only ways in are a phone OTP and Google. So an administrator may well have no
 * email on their auth record at all, and looking them up by one would make the
 * role impossible to grant to a phone account. Pass whichever identifier that
 * person actually has.
 *
 * USAGE
 *   set GOOGLE_APPLICATION_CREDENTIALS=<path to a service-account json>
 *   node scripts/admin/grant-admin.cjs karam@mazzado.com          # dry run
 *   node scripts/admin/grant-admin.cjs karam@mazzado.com --apply  # writes
 *   node scripts/admin/grant-admin.cjs --uid <firebase-uid> --apply
 *
 * To find the uid of a phone account: Firebase console -> Authentication, or
 * sign in as them and read auth.currentUser.uid.
 *
 * It REFUSES to run without GOOGLE_APPLICATION_CREDENTIALS rather than falling
 * back to any ambient credentials it might find, and it does nothing at all
 * without --apply. Both are deliberate: this grants full production access, and
 * a script that writes on its first invocation is one mistyped argument away
 * from granting it to the wrong person.
 */

const path = require('path');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const uidFlag = args.indexOf('--uid');
const uidArg = uidFlag !== -1 ? (args[uidFlag + 1] || '').trim() : '';
const email = uidArg ? '' : (args.find((a) => !a.startsWith('--')) || '').trim().toLowerCase();

function die(msg) {
  console.error(`\n  ✖ ${msg}\n`);
  process.exit(1);
}

// Either identifier is enough, and --uid is the one that works for a
// phone-only account. Validating `email` unconditionally is what made the
// documented --uid form die on its own usage message.
if (!uidArg && !email) {
  die(
    'Usage:\n' +
    '      node scripts/admin/grant-admin.cjs <email> [--apply]\n' +
    '      node scripts/admin/grant-admin.cjs --uid <firebase-uid> [--apply]'
  );
}
if (!uidArg && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  die(`"${email}" does not look like an email address.`);
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  die(
    'GOOGLE_APPLICATION_CREDENTIALS is not set.\n' +
    '    This script grants full production access; it will not guess at credentials.\n' +
    '    Point it at a service-account key for the mazadjoapp project.'
  );
}

const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.applicationDefault() });

const db = admin.firestore();
const auth = admin.auth();

(async () => {
  console.log(`\n  project : ${process.env.GOOGLE_CLOUD_PROJECT || admin.app().options.projectId || '(from credentials)'}`);
  console.log(`  target  : ${uidArg ? 'uid ' + uidArg : email}`);
  console.log(`  mode    : ${APPLY ? 'APPLY (writes)' : 'dry run (no writes)'}\n`);

  let user;
  try {
    user = uidArg ? await auth.getUser(uidArg) : await auth.getUserByEmail(email);
  } catch (e) {
    die(
      `No account exists for ${uidArg ? 'uid ' + uidArg : email}.\n` +
      '    They must sign in to the app once before a role can be attached to them.'
    );
  }

  const snap = await db.collection('users').doc(user.uid).get();
  const data = snap.exists ? snap.data() : null;

  console.log(`  uid          : ${user.uid}`);
  console.log(`  users doc    : ${snap.exists ? 'exists' : 'MISSING'}`);
  console.log(`  current role : ${data ? (data.role || '(none)') : '(no document)'}`);
  console.log(`  isAdmin      : ${data ? String(data.isAdmin) : '(no document)'}`);

  if (data && data.role === 'admin') {
    console.log('\n  Already an administrator. Nothing to do.\n');
    process.exit(0);
  }

  if (!APPLY) {
    console.log('\n  Dry run. Re-run with --apply to grant.\n');
    process.exit(0);
  }

  const ts = admin.firestore.Timestamp.now();
  const batch = db.batch();
  batch.set(db.collection('users').doc(user.uid), {
    role: 'admin',
    isAdmin: true,
    adminGrantedAt: ts,
    adminGrantedBy: 'bootstrap-script',
  }, { merge: true });
  // Same audit shape the callable writes, so the trail reads as one history
  // rather than two. A reviewer asking "who granted this?" gets an answer for
  // the first admin too.
  batch.set(db.collection('adminRoleAudit').doc(), {
    action: 'grant',
    targetUid: user.uid,
    targetEmail: user.email || email || null,
    actorUid: 'bootstrap-script',
    actorEmail: null,
    note: 'one-time bootstrap via Admin SDK',
    at: ts,
  });
  await batch.commit();

  console.log(`\n  ✔ ${user.email || user.phoneNumber || user.uid} is now an administrator (role + audit row written).`);
  console.log('    Sign out and back in, then confirm BOTH the admin panel and a');
  console.log('    payment-proof file open, before any hardcoded identity is removed.\n');
  process.exit(0);
})().catch((err) => {
  console.error('\n  ✖ Failed:', err && err.message ? err.message : err, '\n');
  process.exit(1);
});
