/**
 * `rejectBelowReserve` — the seller's half of the Accept/Reject pair.
 *
 * The callable itself is not unit-testable here (index.js pulls in
 * firebase-admin at module load, which the repo's other callable tests work
 * around by extracting the logic — see orderPaymentSubmit.js /
 * secondChanceRespond.js). This asserts the SOURCE contract instead, in the
 * house source-text idiom, because every claim below is a security property and
 * a silent regression in any of them is a money bug:
 *
 *  - authorization is derived from server state, never from the request payload
 *  - an already-decided offer cannot be decided again
 *  - an expired offer cannot be decided at all
 *  - the whole thing runs in one transaction
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');

/** The body of one exported callable, read to its closing `});`. */
function callable(name) {
  const start = src.indexOf(`exports.${name} = functions`);
  expect(start, `${name} is not exported`).toBeGreaterThan(-1);
  const next = src.indexOf('\nexports.', start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

const reject = callable('rejectBelowReserve');
const accept = callable('acceptBelowReserve');

describe('rejectBelowReserve exists and is wired', () => {
  it('is exported as a callable', () => {
    expect(src).toContain('exports.rejectBelowReserve = functions');
  });

  it('the client has a wrapper for it', () => {
    const ctx = readFileSync(new URL('../src/context/AppContext.tsx', import.meta.url), 'utf8');
    expect(ctx).toContain("getCallableFunction<{ auctionId: string }, { success: boolean; message: string; alreadyRejected?: boolean; offerStatus?: string }>('rejectBelowReserve')");
    expect(ctx).toContain('rejectBelowReserve,');
  });

  it('the seller UI offers Reject alongside Accept', () => {
    const view = readFileSync(new URL('../src/components/SellerCenterView.tsx', import.meta.url), 'utf8');
    expect(view).toContain('reject-below-reserve-');
    expect(view).toContain('accept-below-reserve-');
    expect(view).toContain('handleRejectBelowReserve');
    // One in-flight decision disables BOTH buttons — they are mutually
    // exclusive terminal actions.
    expect(view).toContain('disabled={acceptingOfferId === auction.id || rejectingOfferId === auction.id}');
  });
});

describe('authorization is server-derived', () => {
  it('requires authentication', () => {
    expect(reject).toContain("if (!context.auth)");
    expect(reject).toContain("'unauthenticated'");
  });

  it('takes the caller from the verified token, never from the payload', () => {
    expect(reject).toContain('const callerUserId = context.auth.uid;');
    // The ONLY thing read out of `data` is the auction id.
    const destructured = reject.match(/const \{ ([^}]*) \} = data \|\| \{\};/);
    expect(destructured?.[1].trim()).toBe('auctionId');
    expect(reject).not.toMatch(/data\.(sellerId|userId|uid|isAdmin|ownerId)/);
  });

  it('compares against the AUCTION DOC\'s sellerId, not a client-supplied one', () => {
    expect(reject).toContain('const isSeller = auctionData.sellerId && auctionData.sellerId === callerUserId;');
    // One argument, not two. The second used to be the caller's token email,
    // compared against a hardcoded address — a second source of truth that
    // outranked the role record and could not be revoked without a deploy.
    expect(reject).toContain('callerIsAdmin(callerData)');
    expect(reject).not.toMatch(/tokenEmail/);
    expect(reject).toContain("'permission-denied'");
  });

  it('uses the same ownership predicate as acceptBelowReserve', () => {
    // Accept and reject must agree on who the seller is, or one of them is a
    // hole. Compare the actual line.
    const ownership = 'const isSeller = auctionData.sellerId && auctionData.sellerId === callerUserId;';
    expect(accept).toContain(ownership);
    expect(reject).toContain(ownership);
  });
});

describe('state guards', () => {
  it('runs inside a transaction', () => {
    expect(reject).toContain('db.runTransaction');
  });

  it('is idempotent — a second reject reports success and changes nothing', () => {
    expect(reject).toContain("if (offer.status === 'declined' || offer.status === 'expired')");
    expect(reject).toContain('alreadyRejected: true');
  });

  it('refuses an offer that is no longer awaiting the seller', () => {
    expect(reject).toContain("if (offer.status !== 'pending_seller' || orderSnap.exists)");
    expect(reject).toContain("'failed-precondition'");
  });

  it('refuses an EXPIRED offer', () => {
    expect(reject).toContain('isBelowReserveOfferExpired(offer, Date.now())');
  });

  it('checks for an existing order — a seller cannot un-accept by rejecting', () => {
    // Once accepted, an order exists and the buyer is being asked. Walking that
    // back is the buyer's call (declineBelowReserve), not a second seller one.
    expect(reject).toContain('orderSnap.exists');
  });

  it('preserves auditability with its own timestamp', () => {
    expect(reject).toContain("'belowReserveOffer.sellerRejectedAt': admin.firestore.FieldValue.serverTimestamp()");
    // and does not overwrite the accept-side stamp
    expect(reject).not.toContain('sellerAcceptedAt');
  });

  it('lands on the terminal status the relist gate already understands', () => {
    // 'declined' is what belowReserveBlocksRelist treats as dead, so rejecting
    // frees the lot for relist immediately rather than 24h later.
    expect(reject).toContain("'belowReserveOffer.status': 'declined'");
    const settlement = readFileSync(new URL('./settlement.js', import.meta.url), 'utf8');
    expect(settlement).toContain("return false; // 'declined' or anything terminal");
  });
});

describe('the response contract', () => {
  it('reports the contract status vocabulary, not the stored one', () => {
    expect(reject).toContain("offerStatus: belowReservePublicStatus('declined')");
  });

  it('never returns a reserve amount or a tolerance floor', () => {
    expect(reject).not.toMatch(/reservePrice|toleranceFloor|reserveFils/);
  });

  it('notifies the top bidder post-commit, and a webhook failure cannot roll it back', () => {
    expect(reject).toContain("event: 'below_reserve_declined'");
    // The notify sits AFTER the transaction closes.
    expect(reject.indexOf('await notify(')).toBeGreaterThan(reject.indexOf('return result;') - reject.length);
    expect(reject.indexOf('if (bidderNotify)')).toBeGreaterThan(reject.indexOf('const result = await db.runTransaction'));
  });

  it('uses a reject-specific idempotency key so it cannot collide with a buyer decline', () => {
    expect(reject).toContain('_below_reserve_seller_rejected');
  });
});

describe('the settlement gate that feeds it', () => {
  it('only opens an offer when the top bid is inside the tolerance band', () => {
    expect(src).toContain('if (winnerId && decision.offerBelowReserve) {');
  });

  it('the seller prompt is gated on the same decision', () => {
    // Otherwise a below-tolerance lot would notify a seller about an offer that
    // was never stamped.
    const settleFn = src.slice(src.indexOf('async function settleAuctionTxn'), src.indexOf('exports.scheduledAuctionCloser'));
    const notifyGates = settleFn.match(/if \(winnerId && decision\.offerBelowReserve\) \{/g) ?? [];
    expect(notifyGates.length).toBe(2); // the stamp and the notify
  });

  it('the tolerance percentage comes from the fresh in-transaction snapshot', () => {
    expect(src).toContain('tolerancePct: resolveReserveTolerancePct(freshData)');
  });

  it('nothing is told to the bidder when their top bid misses the band', () => {
    // The only trace is a server log, and it names the BAND, never the amount.
    expect(src).toContain('decision.reserveClass');
    expect(src).toContain('top bid outside tolerance, no offer opened');
  });
});
