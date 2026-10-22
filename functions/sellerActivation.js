/**
 * Seller activation — granting `isSeller`.
 *
 * WHY THIS IS SERVER-SIDE. `isSeller` sits in the self-write denylist in
 * firestore.rules, next to role / isAdmin / isBlocked / isVerified: a user may
 * not promote themselves. WalletView's `handleActivateSeller` tried to write it
 * straight from the client and would have failed with PERMISSION_DENIED — it
 * was never called, so nobody found out. The consequence in production was that
 * NO route to a seller account existed at all: 5 people held sold orders with
 * no seller flag and could not see their own sales, because AppContext only
 * opened the seller-orders subscription for flagged sellers.
 *
 * So the grant lives here, behind the Admin SDK, the same shape subscription
 * grants already use.
 *
 * Deliberately narrow: it sets the seller flag and seeds a profile. It does NOT
 * touch `role` (AppContext derives an effective 'seller' role from `isSeller`,
 * and writing role has its own auto-downgrade hazard — see AppContext), and it
 * does not touch any other privileged flag.
 */
function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const STORE_NAME_FALLBACK = { ar: 'متجري الخاص', en: 'My Store' };
const STORE_ABOUT = {
  ar: 'أهلاً بكم في متجري الخاص على مزادو.',
  en: 'Welcome to my store on MAZZADO.',
};
/**
 * ⚠️ DELETED, NOT EDITED: `STORE_LOCATION = {ar:'عمان، الأردن', en:'Amman, Jordan'}`.
 *
 * Seller activation stamped that constant onto `location` for every new seller,
 * on a document that is `allow read: if true`. It was not a display fallback —
 * it was a fabricated fact PERSISTED to a public profile, so every seller on
 * the platform, in Irbid or Aqaba or anywhere else, was published as being in
 * Amman. A buyer choosing a seller by proximity was reading an invention.
 *
 * The irony is three lines below: that comment refuses to seed a rating or a
 * verified badge because doing so "would be fabricated reputation on a publicly
 * readable profile". A fabricated location is the same thing.
 *
 * A seller now states their own governorate in the seller-centre form, and
 * until they do the field is empty and the profile simply shows no location.
 * Do not reintroduce a default here.
 */

function storeNameFor(name, lang) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean) return STORE_NAME_FALLBACK[lang] || STORE_NAME_FALLBACK.en;
  return lang === 'ar' ? `متجر ${clean}` : `${clean}'s Store`;
}

async function activateSeller(deps, args = {}) {
  const { db, Timestamp, now = () => Date.now(), lang = 'ar' } = deps;
  const { uid } = args;

  if (!uid || typeof uid !== 'string') {
    throw makeError('invalid-argument', 'uid is required.');
  }

  return db.runTransaction(async (txn) => {
    // Reads before writes.
    const userRef = db.collection('users').doc(uid);
    const userSnap = await txn.get(userRef);
    if (!userSnap.exists) throw makeError('not-found', `User ${uid} not found.`);
    const u = userSnap.data() || {};

    // A ban must not be a route to a seller account.
    if (u.isBlocked === true) {
      throw makeError('permission-denied', 'This account cannot be activated as a seller.');
    }

    const profileRef = db.collection('sellerProfiles').doc(uid);
    const profileSnap = await txn.get(profileRef);

    const alreadySeller = u.isSeller === true || u.role === 'seller';
    if (alreadySeller && profileSnap.exists) {
      return { activated: false, alreadySeller: true };
    }

    const ts = Timestamp.fromMillis(now());

    if (!alreadySeller) {
      txn.set(userRef, {
        isSeller: true,
        sellerStatus: 'active',
        sellerActivatedAt: ts,
      }, { merge: true });
    }

    if (!profileSnap.exists) {
      const storeName = storeNameFor(u.name, lang);
      txn.set(profileRef, {
        id: uid,
        userId: uid,
        storeName,
        storeLogo: u.avatar || '',
        coverImage: '',
        bio: STORE_ABOUT[lang] || STORE_ABOUT.en,
        // Empty until the seller states it themselves. See the note above.
        location: '',
        // A brand-new seller has sold nothing and is not verified. Seeding a
        // rating or a verified badge here would be fabricated reputation on a
        // publicly readable profile (sellerProfiles is `allow read: if true`).
        rating: 0,
        totalSales: 0,
        followers: 0,
        following: 0,
        isVerifiedMerchant: false,
        verificationStatus: 'not_verified',
        trustScore: 50,
        badges: [],
        createdAt: ts,
      });
    }

    return { activated: true, alreadySeller };
  });
}

module.exports = { activateSeller, storeNameFor };
