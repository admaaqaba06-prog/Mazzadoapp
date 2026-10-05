const crypto = require('crypto');
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const {
  normalizePhone,
  generateOtpCode,
  hashOtp,
  canSendOtp,
  checkOtp,
  OTP_TTL_MS,
  SEND_COOLDOWN_MS,
  MAX_SENDS_PER_HOUR,
  MAX_ATTEMPTS,
  isRelayDelivered,
} = require('./whatsappOtp');
const { otpMessage } = require('./otpCopy');
const {
  N8N_HEALTH_WORKFLOWS, summarizeExecutions, incidentFor,
} = require('./n8nHealth');
const { runDailyDigest } = require("./dailyDigestRun");
const {
  isStopMessage,
  isStartMessage,
  optOutConfirmation,
  QUIET_START_HOUR: DIGEST_QUIET_START,
  QUIET_END_HOUR: DIGEST_QUIET_END,
} = require("./dailyDigest");
const { resolveTierByPrice } = require('./subscriptionTiers');
const {
  approveSubscriptionRequest,
  grantSubscriptionDirect,
  rejectSubscriptionRequest,
} = require('./subscriptionApproval');
const { verifyOrderPayment: verifyOrderPaymentTxn, rejectOrderPayment: rejectOrderPaymentTxn } = require('./orderPaymentVerify');
const { submitOrderPayment: submitOrderPaymentTxn } = require('./orderPaymentSubmit');
const { createCliqRequest: createCliqRequestTxn, applyCliqWebhook: applyCliqWebhookTxn, isCliqRequestLive } = require('./cliqPayment');
const { grantAdmin: grantAdminCore, revokeAdmin: revokeAdminCore } = require('./adminRoles');
const { assignOrderRef } = require('./assignOrderRef');
const { issueDeliveryCode: issueDeliveryCodeTxn } = require('./deliveryIssue');
const { activateSeller: activateSellerTxn } = require('./sellerActivation');
const { buildPayoutTransferStamp } = require('./payoutTransfer');
const { resolveCounterpartyContact, waMeLink } = require('./contactReveal');
const { shouldActivateSellerOnApproval } = require('./listingApproval');
const { normalizeDeliveryCodeInput } = require('./deliveryCode');
const { checkDeliveryConfirm, isHttpsUrl } = require('./deliveryConfirm');
const { sendFulfillmentNudge: sendFulfillmentNudgeTxn } = require('./fulfillmentNudge');
const { stampDisputeResolution: stampDisputeResolutionTxn } = require('./disputeResolution');
const { userStatusForSubscriptionRequest } = require('./subscriptionRequestStatus');
const { expireLapsedSubscriptions, isActiveMember: isActiveMemberServer } = require('./subscriptionExpiry');
const { normalizeReservePrice, authorizeReserveWrite } = require('./auctionReserve');
const { resolveSettlement, reserveMet, resolvePaymentWindowHours, resolveAntiSnipe, computeSoftCloseEnd, computeBidEndTime, sellerCommissionFils, sellerNetFils, buyerPremiumJod, totalDueJod, shouldAutoRelist, MAX_AUTO_RELISTS, belowReserveExpiryMs, isBelowReserveOfferExpired, resolveReserveTolerancePct, belowReservePublicStatus } = require('./settlement');
const { authorizeOrderRepair, auctionRecordsReserve } = require('./orderRepair');
const { OFFER_FIELDS, PENDING_STATUSES, lapsedOffers, undatableOffers, expiryNotification, expiryNeedsCopy } = require('./offerExpiry');
const { bidRateLimitConfig, readBidRateLimitState, evaluateBidRateLimit } = require('./bidRateLimit');
const { pickRunnerUp, shouldSkipRunnerUp, openingStateFor, buildOfferRecord, needsNotifyRetry, secondChanceOrderId } = require('./secondChance');
const { respondToSecondChance: respondToSecondChanceTxn } = require('./secondChanceRespond');
const { resolveEscrowWinner, shouldRefundEscrow } = require('./escrowRepair');
const { resolvePaymentDefaultBan, isEffectivelyBlocked } = require('./banLadder');
const { onAuctionWriteAlgolia } = require('./algoliaSync');
const { channelsFor, copyFor, dueReminders } = require('./notify');
// resolveLang comes straight from the copy module — notify.js re-exports copyFor
// only, and widening its surface is not this task's business.
const { resolveLang, pushCopyFor } = require('./messageCopy');
const { emailFor } = require('./emailCopy');
const { buildReturnClaim, canRequestReturn } = require('./returns');
const { buildBuyerRating, canSellerRateOrder } = require('./ratings');
const { maskBidderName } = require('./bidderMask');
const { buildWarmPlan } = require('./warmTargets');

admin.initializeApp();
const db = admin.firestore();

// Firestore → Algolia search mirror (defined in ./algoliaSync with its own
// ALGOLIA_ADMIN_KEY secret + runWith). Re-exported here so it deploys with the
// rest of the functions bundle.
exports.onAuctionWriteAlgolia = onAuctionWriteAlgolia;

// Per-auction payment window: hours the winner has to pay before the
// paymentDefaultEnforcer blocks them. Set at auction creation; clamp + 24h
// default live in ./settlement (resolvePaymentWindowHours) so the rule has one
// unit-tested source of truth. This wrapper turns the resolved hours into the
// order's Firestore deadline Timestamp.
function paymentDeadlineFromNow(auctionData) {
  const hours = resolvePaymentWindowHours(auctionData && auctionData.paymentWindowHours);
  return admin.firestore.Timestamp.fromMillis(Date.now() + hours * 60 * 60 * 1000);
}

// Fire-and-forget notification to the n8n webhook. No-ops if unconfigured.
// NEVER throws — these calls sit inside financial/transaction paths, so a
// webhook failure must only log and never disrupt settlement/bid/escrow logic.
async function postToN8n(event, payload) {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, ...payload, ts: Date.now() }),
      // Bound the wait: a hung n8n endpoint must never stall the settlement cron
      // or a callable. On timeout, fetch rejects and the catch below swallows it.
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.warn(`[n8n] ${event} webhook failed:`, e && e.message);
  }
}

// Hand a freshly-minted OTP to the n8n relay for WhatsApp delivery. Mirrors
// postToN8n's contract: bounded 5s wait, NEVER throws (a relay failure must not
// break the auth callable — the code is already persisted), no-op + warn if the
// webhook URL is unconfigured.
// The OTP relay webhook (n8n → WaSender). Not a secret + stable, so it defaults
// to the live endpoint and works out of the box; N8N_OTP_WEBHOOK_URL overrides it
// if ever needed. Same fallback pattern as the Firebase config in services/firebase.
const OTP_RELAY_URL = 'https://mazadjo.app.n8n.cloud/webhook/send-otp';

/**
 * Hand the code to the WhatsApp relay. Returns whether it was ACCEPTED for
 * delivery. Still never throws — the code is already committed and the caller
 * must not fail because of this.
 *
 * It used to return nothing, so the callable answered `{ ok: true }` whatever
 * happened and the sign-in screen said "we sent a code to WhatsApp" even when
 * nothing had been sent. With the relay's own failure rate at ~60%, that is
 * most of the people who try: they wait for a message that is not coming, and
 * the SMS fallback sits unnoticed under the button.
 *
 * Two failures were invisible, not one. `fetch` only rejects on a transport
 * error, so an HTTP 404 or 500 — a deactivated workflow, a renamed path —
 * resolved as success and was never even logged. `isRelayDelivered` checks the
 * status.
 */
async function postOtpToRelay(phone, code) {
  const url = process.env.N8N_OTP_WEBHOOK_URL || OTP_RELAY_URL;
  if (!url) {
    console.warn('[otp] OTP relay URL unset — skipping OTP relay send');
    return false;
  }
  // Render the message HERE, not in n8n. Same precedent notify() set for the
  // notification pipe, which ships a pre-rendered `wa_text` so the workflow owns
  // no wording (index.js:216, n8n/README.md). The OTP relay was the last place
  // that still composed a sentence inside n8n, which is how the retired brand
  // «مزاد جو» stayed in the most-read message the product sends: no test, no
  // brand guard, no review, no git history could see it.
  //
  // Guarded on its own, BEFORE the payload literal, exactly as notify() does:
  // this function must never throw (the code is already committed), so a broken
  // renderer degrades to omitting the key rather than failing the send. n8n
  // type-guards `wa_text` the same way build-messages.js:277 does and falls back
  // to its own template, so a half-landed deploy sends the old wording, never a
  // blank message.
  let waText;
  try {
    waText = otpMessage(code);
  } catch (e) {
    console.warn('[otp] copy render failed, letting the relay template stand:', e && e.message);
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `code` stays its own field: the relay still needs it, and n8n falls back
      // to its own template until its node is pointed at wa_text.
      body: JSON.stringify({ phone, code, ...(waText ? { wa_text: waText } : {}) }),
      signal: AbortSignal.timeout(5000),
    });
    const delivered = await isRelayDelivered(res);
    if (!delivered) {
      // Log the BODY, not just the status. The live failure mode is HTTP 200 with
      // {"success":false,"message":"Your Whatsapp Session is not connected ..."},
      // so a bare status of 200 in the logs reads as a success and names no cause.
      // Never throws; reads a clone, so isRelayDelivered is undisturbed.
      let detail = '';
      try {
        if (typeof res.clone === 'function') detail = (await res.clone().text() || '').slice(0, 300);
      } catch (_) { /* unreadable body: the status alone is all we get */ }
      console.warn('[otp] relay rejected the send:', res && res.status, detail);
    }
    return delivered;
  } catch (e) {
    console.warn('[otp] relay send failed:', e && e.message);
    return false;
  }
}

// resolveLang for the call sites that are NOT notify() — the two FCM pushes,
// which build their own payload and so never pass through notify()'s renderer.
// NEVER throws, for the same reason notify() guards its own resolveLang call:
// both sit inside settlement / bid paths where an exception would take the money
// path with it. A language we cannot resolve degrades to Arabic (the market
// default and the safe direction — an Arabic-only reader must never be sent
// English by accident), never to a lost push.
//
// It takes a user OBJECT, not a uid: every current caller already holds the
// recipient's user document, so resolving the language here costs zero extra
// Firestore reads. Keep it that way — adding a read inside this helper would
// put one on a settlement transaction's critical path.
function safeResolveLang(user, where) {
  try {
    return resolveLang(user);
  } catch (e) {
    console.warn(`[lang] resolve failed (${where}):`, e && e.message);
    return 'ar';
  }
}

// Single notification choke point (E5). Resolves the event's channels, writes
// the in-app bell doc, and hands phone+email+channels to n8n for WhatsApp/email
// fan-out. NEVER throws — same money-path safety contract as postToN8n.
async function notify({ uid, event, data = {} }) {
  const d = data || {};
  const channels = channelsFor(event);
  let user = {};
  if (uid) {
    try {
      const s = await db.collection('users').doc(uid).get();
      if (s.exists) user = s.data() || {};
    } catch (e) { console.warn(`[notify] user lookup ${uid} failed:`, e && e.message); }
  }
  // The user doc is already loaded above for phone/email/name, so reading the
  // language preference off it costs no extra Firestore read. It MUST be read
  // after `user = s.data()` — before that assignment `user` is {} and every
  // recipient silently gets Arabic, which looks correct in production and is
  // invisible by eye.
  // Guarded for the same reason every other callee in this function is: notify()
  // runs inside settlement / escrow / bid post-commit paths that rely on it
  // never throwing (see the header comment), and an unguarded call here would
  // propagate. Arabic is the product default, so the degraded path is the
  // default locale rather than a lost notification.
  let lang = 'ar';
  try {
    lang = resolveLang(user);
  } catch (e) { console.warn(`[notify] language resolve ${event} failed:`, e && e.message); }
  if (channels.inapp && uid) {
    try {
      const c = copyFor(event, d, lang);
      await db.collection('notifications').add({
        userId: uid, type: c.type, title: c.title, description: c.description,
        timestamp: Date.now(), read: false, priority: d.priority || 'medium',
        ...(d.auctionId ? { auctionId: d.auctionId } : {}),
      });
    } catch (e) { console.warn(`[notify] in-app ${event} failed:`, e && e.message); }
  }
  if (channels.whatsapp || channels.email) {
    // postToN8n never throws — but its ARGUMENT EXPRESSION is evaluated by
    // notify(), not by postToN8n, so a renderer that threw inside that literal
    // would escape notify() entirely and land in the money paths. Each renderer
    // is therefore evaluated into a local inside its own guard BEFORE the
    // payload literal is built. A renderer that fails drops its own surface
    // (the key is undefined, so JSON.stringify omits it from the wire body) and
    // nothing else; on the happy path the payload is byte-identical to what
    // inlining these expressions produced.
    let emailContent;
    if (channels.email) {
      // Rendered email content, so the n8n workflow is a dumb template rather
      // than a second copy map that can drift from this repo. It carries the
      // amount, deadline, order reference and a real deep link — none of which
      // reached the old email, which reused the terse in-app one-liner.
      try {
        emailContent = emailFor(event, { ...d, name: user.name || d.name || '' }, lang);
      } catch (e) { console.warn(`[notify] email copy ${event} failed:`, e && e.message); }
    }
    let waText;
    if (channels.whatsapp) {
      // The WhatsApp body, rendered here so the n8n node forwards a string
      // instead of keeping its own copy map. The shape — `title\ndescription`,
      // or the title alone when there is no description — is byte-for-byte what
      // the node produces today, so its fallback and this render are identical.
      try {
        const c = copyFor(event, d, lang);
        waText = c.description ? `${c.title}\n${c.description}` : c.title;
      } catch (e) { console.warn(`[notify] whatsapp copy ${event} failed:`, e && e.message); }
    }
    await postToN8n(event, {
      phone: user.phoneNumber || user.phone || d.phone || '',
      email: user.email || d.email || '',
      name: user.name || d.name || '',
      channels,
      ...d,
      ...(channels.email ? { email_content: emailContent } : {}),
      // Gated on the channel, exactly as email_content is: an in-app-only event
      // has no business carrying a WhatsApp body.
      ...(channels.whatsapp ? { wa_text: waText } : {}),
    });
  }
}

/**
 * assertAdmin — shared admin gate for admin-only callables.
 *
 * ONE definition of administrator, and it is the role record:
 * users/{uid}.role === 'admin' || users/{uid}.isAdmin === true. Every gate in
 * this file resolves through callerIsAdmin below, so the question has a
 * single answer and a single place to change it.
 *
 * It used to short-circuit on a hardcoded email BEFORE reading the document
 * at all. That identity could not be revoked without a deploy, it outlived
 * whoever held it, and it was legible to anyone who could read the
 * repository. Granting is now an audited write (grantAdminRole in
 * adminRoles.js, or the one-time bootstrap script) and a revoke takes effect
 * on the caller's very next request.
 *
 * Throws HttpsError('permission-denied') otherwise; returns the caller uid.
 */
async function assertAdmin(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated.');
  }
  const callerSnap = await db.collection('users').doc(context.auth.uid).get();
  const callerData = callerSnap.exists ? callerSnap.data() : {};
  if (!callerIsAdmin(callerData)) {
    throw new functions.https.HttpsError('permission-denied', 'Unauthorized. Administrators only.');
  }
  return context.auth.uid;
}

// THE caller-is-admin check. Every admin gate in this file — assertAdmin, the
// escrow callables, the below-reserve callables — resolves through this one
// function, so "who is an administrator" has exactly one answer.
//
// `callerData` is users/{uid}.data(), read by the caller (often inside its own
// transaction, which is why this stays tiny and pure rather than doing the
// read itself).
//
// It took a second argument, `tokenEmail`, compared against a hardcoded
// address. Two sources of truth for one decision is one too many: the email
// could not be revoked without a deploy, and it silently outranked whatever
// the role record said. The role record is now the only input.
function callerIsAdmin(callerData) {
  const d = callerData || {};
  return d.role === 'admin' || d.isAdmin === true;
}

// Delete a list of document refs in chunks (Firestore batches cap at 500 writes).
async function deleteRefsInBatches(refs) {
  let count = 0;
  for (let i = 0; i < refs.length; i += 450) {
    const chunk = refs.slice(i, i + 450);
    const batch = db.batch();
    chunk.forEach((ref) => batch.delete(ref));
    await batch.commit();
    count += chunk.length;
  }
  return count;
}

/**
 * E3 Slice B — mutate a settlement `update` object in place to stamp
 * `relistEligibleAt` (auction end + 24h) when the listing opted in to auto-relist
 * and is under the cap. Only called from the unsold / reserve_not_met branches —
 * NEVER on a sold outcome. `freshData` is the authoritative in-txn snapshot (used
 * for the eligibility fields + end time); `auctionData` is the sweep snapshot
 * fallback for the end time. No-op when not eligible (leaves `update` untouched).
 */
function addRelistEligibility(update, freshData, auctionData) {
  if (!shouldAutoRelist(freshData, Date.now())) return;
  const endMs = resolveAuctionEndMs(freshData) || resolveAuctionEndMs(auctionData || {}) || Date.now();
  update.relistEligibleAt = admin.firestore.Timestamp.fromMillis(endMs + 24 * 3600 * 1000);
}

/**
 * settleAuctionTxn — the per-auction settlement, extracted verbatim from the
 * body of scheduledAuctionCloser so the cron and simulateSettleNow run the
 * EXACT same settle path: transactional status flip, order creation with
 * buyer's premium + 24h payment deadline, winner wonCount increment, FCM,
 * and post-commit auction_won / payment_due webhooks.
 *
 * `auctionData` is the caller's pre-transaction snapshot; like the original
 * closer code it is only used for the vestigial escrow lookup, logging, and
 * order display fields — winner/price/bids are re-derived from the FRESH
 * in-transaction read, and the completed/ended + order-exists guards make
 * this safe against double-settling.
 *
 * Simulated auctions: when the FRESH in-transaction auction doc carries
 * isSimulated: true, the created order carries isSimulated: true as well —
 * derived here (not caller-supplied) so BOTH the closer cron and
 * simulateSettleNow flag it, and simulateCleanup / metrics can find it.
 * For real auctions the payload is byte-identical to before (no key added).
 *
 * Returns { settled, orderId }: settled=true when THIS call transitioned the
 * auction (completed with order, or ended unsold); orderId set only on the
 * completed-with-winner path.
 */
async function settleAuctionTxn(auctionRef, auctionData) {
  const auctionId = auctionRef.id;

  // NOTE: these are computed from the caller's snapshot and may be STALE
  // (a bid can land between that read and the transaction below). They are
  // only used for the vestigial escrow lookup + logging; the settlement
  // itself derives winner/price from the fresh in-txn read.
  const sweepWinnerId = auctionData.currentBidderId || auctionData.highestBidderId || auctionData.winnerId;
  const sweepFinalPrice = auctionData.currentPrice || auctionData.startingPrice;

  console.log("Checking ended auction:", auctionId);
  console.log("Winner (sweep snapshot):", sweepWinnerId);
  console.log("Final price (sweep snapshot):", sweepFinalPrice);

  let escrowId = null;
  if (sweepWinnerId) {
    console.log("Creating order:", auctionId);
    try {
      const escrowSnap = await db.collection('escrows')
        .where('auctionId', '==', auctionId)
        .where('bidderId', '==', sweepWinnerId)
        .where('status', '==', 'locked')
        .limit(1)
        .get();
      if (!escrowSnap.empty) {
        escrowId = escrowSnap.docs[0].id;
      }
    } catch (escErr) {
      console.warn(`[settleAuctionTxn] Escrow fetch failed for ${auctionId}:`, escErr);
    }
  }

  // The reserve lives in an admin/server-only doc (never on the world-readable
  // auction). It is read INSIDE the transaction below, alongside every other
  // read the decision depends on — see the note at that read for why it cannot
  // be read out here.
  const secretRef = db.collection('auctionSecrets').doc(auctionId);

  // (notify) set ONLY on a real settlement this run; fired AFTER the txn commits.
  let notifyData = null;
  // (notify) E3 Slice C — set when a reserve_not_met settlement stamps a fresh
  // below-reserve offer, so the seller is prompted post-commit to accept.
  let belowReserveNotify = null;
  let settled = false;
  let settledOrderId = null;
  await db.runTransaction(async (transaction) => {
    notifyData = null; // reset each attempt — transactions retry on contention
    belowReserveNotify = null;
    settled = false;
    settledOrderId = null;
    const freshDoc = await transaction.get(auctionRef);
    // A lot deleted between the sweep query and this transaction: `.data()` is
    // undefined and the status check below would throw INSIDE the transaction,
    // which the cron then logs as a settlement failure and retries forever.
    if (!freshDoc.exists) {
      console.warn(`[settleAuctionTxn] ${auctionId} disappeared before settlement — nothing to do.`);
      return;
    }
    const freshData = freshDoc.data() || {};

    /**
     * ALREADY SETTLED? `settledAt` as well as `status`.
     *
     * Status alone is not a record that a lot has settled, because
     * "Approve & go live" OVERWRITES it back to `live`. That happened in
     * production on `auction-new-1784771726248-7597`: a winner defaulted, an
     * admin hit the obvious green button, and the dead lot re-opened carrying
     * its old `currentPrice` and `currentBidderId`.
     *
     * `src/utils/approvalGuard.ts` refuses that approval now — but it is a
     * CLIENT guard, and this is the server. If a lot reaches here re-opened,
     * the status check passes and it settles a SECOND time; orders are keyed
     * `orders/{auctionId}` and creation is `if (!orderSnap.exists)`, so the
     * defaulted order still holds the id, the new winner gets no order at all,
     * and the lot sells with nothing behind it.
     *
     * `settledAt` survives the status overwrite, so it is the durable record.
     * Refusing here is the safe half of the trade: the lot stays unsettled and
     * visible instead of selling to someone who would receive nothing, and the
     * correct recovery — relisting into a NEW document — is what the relist
     * paths already do (autoRelistSweep mints a fresh id and builds the child
     * field-by-field, so it carries no `settledAt` of its own).
     */
    if (['completed', 'ended', 'reserve_not_met'].includes(freshData.status)) {
      return;
    }
    if (freshData.settledAt != null) {
      console.warn(
        `[settleAuctionTxn] ${auctionId} carries settledAt but status is '${freshData.status}' — ` +
        `it was re-opened after settling. Refusing to settle it twice; relist it as a new lot instead.`,
      );
      return;
    }

    // Derive winner/price/bids from the FRESH in-txn snapshot. A bid
    // landing between the sweep query and this transaction would make
    // the sweep values settle the wrong bidder at the wrong price.
    const winnerId = freshData.currentBidderId || freshData.highestBidderId || freshData.winnerId;
    const winnerName = freshData.currentBidderName || freshData.highestBidderName || freshData.winnerName || 'Buyer';
    const finalPrice = freshData.currentPrice || freshData.startingPrice;
    const totalBids = freshData.totalBids || 0;

    const orderRef = db.collection('orders').doc(auctionId);
    const orderSnap = await transaction.get(orderRef);

    // Firestore requires ALL reads before ANY writes. Read the winner doc
    // HERE (before the settlement writes below). Previously this read ran
    // AFTER the writes, throwing on every settlement so no auction ever
    // completed and no order was ever created.
    const winnerRef = winnerId ? db.collection('users').doc(winnerId) : null;
    const winnerSnap = winnerRef ? await transaction.get(winnerRef) : null;

    /**
     * THE RESERVE AMOUNT, READ INSIDE THE TRANSACTION.
     *
     * It used to be read before `runTransaction` opened, which left the one
     * value the sale hinges on outside the consistency guarantee protecting
     * everything else. Two ways that goes wrong, both narrow and both
     * unrecoverable once an order exists:
     *
     *   - `setAuctionReserve` lands between the outer read and this
     *     transaction. We settle against an amount the seller has replaced.
     *   - The reserve is set for the FIRST time in that gap. The outer read
     *     returned nothing, and the pre-transaction snapshot has no
     *     `reserveMet` either, so intent reads false too — a lot with a live
     *     reserve is awarded as though it never had one.
     *
     * Reading it here puts the secret in the transaction's read set, so a
     * concurrent write to it forces a retry rather than a stale award. This is
     * the same thing autoRelistSweep already does when it copies a reserve.
     *
     * Still FAIL CLOSED: a throw here aborts the transaction, settleAuctionTxn
     * rejects, and the per-minute cron retries. Defaulting to "no reserve"
     * would sell the lot, and that cannot be taken back.
     */
    const secretSnap = await transaction.get(secretRef);
    const reservePrice = secretSnap.exists ? (secretSnap.data().reservePrice ?? null) : null;

    // winnerName above is derived from the (now MASKED) public auction doc.
    // The PRIVATE order needs the REAL buyer name — resolve it from the user
    // doc read above (all reads stay before any writes). Fall back to the
    // masked winnerName / 'Buyer' when the user doc is missing.
    const realWinnerName = (winnerSnap && winnerSnap.exists && winnerSnap.data().name) || winnerName;

    /**
     * Did this lot have a reserve AT ALL? The amount is admin-only and lives in
     * auctionSecrets; the world-readable auction doc carries the boolean
     * `reserveMet` whenever createListing set a reserve. So the field's PRESENCE
     * is the surviving record of intent even when the amount was never stored —
     * which is exactly the case that was selling lots below their reserve. See
     * resolveSettlement for the full chain.
     *
     * Presence, not truthiness: `reserveMet` is flipped to `true` by
     * onBidCreated once a qualifying bid lands, so testing the value would miss
     * every lot that had already cleared its bar.
     *
     * From `freshData`, not the pre-transaction snapshot. Every other input to
     * the decision — winner, price, bid count, tolerance — is taken from the
     * in-transaction read for the reason given above them, and intent was the
     * one that was not. A reserve set in that gap leaves the stale snapshot
     * with no `reserveMet`, and the lot is then awarded as though it never had
     * a reserve: the exact failure the flag was added to prevent.
     */
    const reserveIntended = auctionRecordsReserve(freshData);

    // Tolerance band is per-auction (clamped) and read from the FRESH snapshot,
    // so an admin edit between the sweep query and this txn is honoured. It only
    // narrows which reserve-not-met lots OPEN AN OFFER; `reserveIntended` above
    // still decides, on its own, whether the lot may be awarded at all.
    const decision = resolveSettlement({
      totalBids, winnerId, finalPrice, reservePrice, reserveIntended,
      tolerancePct: resolveReserveTolerancePct(freshData),
    });

    if (decision.reserveUnverifiable) {
      // Loud on purpose. This lot needs an admin to restore its reserve amount;
      // until then it will keep landing here instead of completing.
      console.error(
        `[settleAuctionTxn] RESERVE UNVERIFIABLE for ${auctionId}: the auction doc records a reserve ` +
        `(reserveMet present) but auctionSecrets/${auctionId} has no reservePrice. Refusing to award ` +
        `(top bid ${finalPrice}). Restore the reserve amount, or accept the below-reserve offer.`
      );
    }

    if (decision.outcome === 'sold') {
      // Mark completed
      transaction.update(auctionRef, {
        status: 'completed',
        settledAt: admin.firestore.FieldValue.serverTimestamp()
      });
      settled = true;
      settledOrderId = orderRef.id;

      // Increment win count (winnerRef was read above, before any writes)
      transaction.set(winnerRef, {
        wonCount: admin.firestore.FieldValue.increment(1)
      }, { merge: true });

      // Create Order System (Phase 1)
      if (!orderSnap.exists) {
        const orderPayload = {
          id: auctionId,
          auctionId: auctionId,
          auctionTitle: auctionData.title || '',
          auctionImage: auctionData.thumbnailUrl || auctionData.imageUrl || '',
          sellerId: auctionData.sellerId || '',
          sellerName: auctionData.sellerName || 'Seller',
          buyerId: winnerId,
          buyerName: realWinnerName,
          winningBidAmount: finalPrice,
          buyersPremium: buyerPremiumJod(finalPrice),
          totalDue: totalDueJod(finalPrice),
          sellerCommission: sellerCommissionFils(Math.round(finalPrice * 1000)) / 1000,
          sellerNet: sellerNetFils(Math.round(finalPrice * 1000)) / 1000,
          paymentDeadlineAt: paymentDeadlineFromNow(auctionData),
          paymentWindowHours: resolvePaymentWindowHours(auctionData && auctionData.paymentWindowHours),
          status: "waiting_payment",
          paymentStatus: "unpaid",
          shippingStatus: "not_started",
          escrowStatus: "locked",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (escrowId) {
          orderPayload.escrowId = escrowId;
        }

        // Derive from the fresh in-txn doc (NOT a caller option): a simulated
        // auction settled by the cron must still produce a flagged order.
        if (freshData.isSimulated === true) {
          orderPayload.isSimulated = true;
        }

        transaction.set(orderRef, orderPayload);
        console.log(`[settleAuctionTxn] Created order for auction ${auctionId}`);
      } else {
        console.log(`[settleAuctionTxn] Order for auction ${auctionId} already exists, skipping creation.`);
      }

      console.log(`[settleAuctionTxn] Settled completed auction ${auctionId} - Winner: ${winnerName} (${winnerId}) at ${finalPrice} JOD`);

      // (notify) capture the winner's contact details for the post-commit
      // side effects (FCM push + webhooks). NOTHING is sent from in here:
      // Firestore retries this callback on contention — and a last-second bid
      // on a settling auction is exactly that — so a send inside the txn fires
      // the winner's "you won 🎉" push once per retry. Capture in, send out.
      const winnerData = (winnerSnap && winnerSnap.exists) ? winnerSnap.data() : null;
      notifyData = {
        phone: (winnerData && winnerData.phoneNumber) || '',
        fcmToken: (winnerData && winnerData.fcmToken) || '',
        // (language) captured here, from the winner doc this transaction ALREADY
        // read for the phone and the token — no extra read, and no read added
        // inside the transaction. It is carried out to the post-commit push
        // below, which is the ONE customer surface that does not go through
        // notify() and so cannot resolve the language for itself.
        lang: safeResolveLang(winnerData, `settleAuctionTxn winner ${winnerId}`),
        // Private "you won" notification to the winner themselves — real name.
        winnerId, winnerName: realWinnerName, finalPrice, auctionTitle: auctionData.title || '', auctionId,
      };
    } else if (decision.outcome === 'reserve_not_met') {
      // A winner exists but the top bid never cleared the hidden reserve.
      // Per spec: NO sale, NO order, NO wonCount. Relist-able.
      const rnmUpdate = {
        status: 'reserve_not_met',
        settledAt: admin.firestore.FieldValue.serverTimestamp()
      };
      // E3 Slice C — below-reserve near-miss: a real bidder exists but never
      // cleared the reserve. Stamp a bounded (24h) offer so the seller can
      // one-tap accept the top bid (then the buyer confirms). NO order + NO
      // wallet movement here — that only happens on seller-accept / buyer-
      // confirm via the acceptBelowReserve / confirmBelowReserve callables.
      // reserve_not_met already implies totalBids>0 && winnerId, so there is
      // always a real top bid to offer.
      //
      // TOLERANCE GATE: only a top bid inside the band (>= reserve x (1 - pct))
      // is worth putting to the seller. Below the floor the lot just closes
      // reserve_not_met with NO offer — no seller prompt, no notification, and
      // critically nothing said to the bidder, because "your bid missed the
      // near-miss band" would disclose roughly where the reserve sits.
      if (winnerId && decision.offerBelowReserve) {
        rnmUpdate.belowReserveOffer = {
          topBid: finalPrice,
          topBidderId: winnerId,
          topBidderName: winnerName,
          expiresAt: admin.firestore.Timestamp.fromMillis(belowReserveExpiryMs(Date.now())),
          status: 'pending_seller',
        };
      }
      // E3 Slice B — stamp auto-relist eligibility (24h after the auction end)
      // when the seller opted in and the cap isn't hit. autoRelistSweep picks
      // these up but WAITS while a below-reserve offer is still live
      // (shouldAutoRelist → belowReserveBlocksRelist). NEVER on a sold outcome.
      addRelistEligibility(rnmUpdate, freshData, auctionData);
      transaction.update(auctionRef, rnmUpdate);
      settled = true;
      // (notify) capture the seller prompt — sent post-commit (never inside the
      // retrying txn). Seller phone is fetched post-commit only when set.
      if (winnerId && decision.offerBelowReserve) {
        belowReserveNotify = {
          sellerId: auctionData.sellerId || freshData.sellerId || '',
          // The top bidder is told, in-app only, that their near-miss bid is
          // now with the seller. Without this the buyer's side of the 24h
          // window was silent: they saw the lot end and heard nothing until
          // (and unless) the seller accepted.
          topBidderId: winnerId,
          auctionId,
          auctionTitle: auctionData.title || freshData.title || '',
          topBid: finalPrice,
        };
      }
      // reserveClass is SERVER-SIDE LOGGING ONLY. It names the band, never the
      // amount, and never leaves this process.
      console.log(`[settleAuctionTxn] Reserve not met for ${auctionId} (${decision.reserveClass}) — ${decision.offerBelowReserve ? 'below-reserve offer opened' : 'top bid outside tolerance, no offer opened'}, no order created`);
    } else {
      // Close without bidder
      const unsoldUpdate = {
        status: 'ended',
        settledAt: admin.firestore.FieldValue.serverTimestamp()
      };
      // E3 Slice B — same auto-relist eligibility stamp for a truly unsold lot.
      addRelistEligibility(unsoldUpdate, freshData, auctionData);
      transaction.update(auctionRef, unsoldUpdate);
      settled = true;
      console.log(`[settleAuctionTxn] Closed unsold auction ${auctionId}`);
    }
  });

  // (order-ref) DECOUPLED from settlement — runs AFTER the money transaction
  // above has committed, in its own transaction, wrapped so it can NEVER throw
  // out of settlement. Only when a sold outcome produced an order doc
  // (settledOrderId set); unsold/reserve-not-met runs create no order and must
  // not get a phantom orderRef stamp.
  if (settledOrderId) {
    try {
      await assignOrderRef({ db, Timestamp: admin.firestore.Timestamp, now: () => Date.now() }, auctionId);
    } catch (e) {
      console.error('assignOrderRef failed (non-fatal)', auctionId, e);
    }
  }

  // (notify) post-commit: fire ONLY when this run actually settled a winner.
  // Outside the transaction so retries never double-send; postToN8n never throws.
  if (notifyData) {
    // Winner push. Post-commit for the same reason as the webhooks below — a
    // retried transaction must never re-send it. Never throws: a dead FCM token
    // must not fail a settlement that has already committed.
    if (notifyData.fcmToken) {
      // Rendered from the SAME event copy the `auction_won` notify() call below
      // sends to WhatsApp/email/bell, in the winner's own language. Hardcoded
      // Arabic here meant an English-preference winner got an Arabic push
      // seconds before the English WhatsApp for the same win.
      //
      // The try wraps the RENDER as well as the send: copyFor is evaluated by
      // this function, not by send(), so the old `.catch()` on the promise could
      // never have caught a throw from the argument expression — and this runs
      // after the settlement transaction has committed, where throwing fails the
      // cron run for an auction whose money has already moved.
      try {
        const c = copyFor('auction_won', {
          auctionTitle: notifyData.auctionTitle,
          totalDue: totalDueJod(notifyData.finalPrice),
        }, notifyData.lang);
        await admin.messaging().send({
          token: notifyData.fcmToken,
          notification: { title: c.title, body: c.description }
        });
      } catch (err) {
        console.warn(`FCM error for winner ${notifyData.winnerId}: ${err && err.message}`);
      }
    }

    await notify({ uid: notifyData.winnerId, event: 'auction_won', data: {
      name: notifyData.winnerName,
      auctionId: notifyData.auctionId, auctionTitle: notifyData.auctionTitle,
      amount: notifyData.finalPrice,
      buyersPremium: buyerPremiumJod(notifyData.finalPrice),
      totalDue: totalDueJod(notifyData.finalPrice),
      paymentHours: resolvePaymentWindowHours(auctionData && auctionData.paymentWindowHours),
      // Orders are keyed by the auction id (settleAuctionTxn), so this deep-links.
      orderId: notifyData.auctionId,
      idempotencyKey: `${notifyData.auctionId}_auction_won`,
    } });
    await notify({ uid: notifyData.winnerId, event: 'payment_due', data: {
      name: notifyData.winnerName,
      auctionId: notifyData.auctionId, auctionTitle: notifyData.auctionTitle,
      amount: notifyData.finalPrice,
      buyersPremium: buyerPremiumJod(notifyData.finalPrice),
      totalDue: totalDueJod(notifyData.finalPrice),
      paymentHours: resolvePaymentWindowHours(auctionData && auctionData.paymentWindowHours),
      orderId: notifyData.auctionId,
      idempotencyKey: `${notifyData.auctionId}_payment_due`,
    } });
  }

  // (notify) E3 Slice C — prompt the seller that a below-reserve offer is open.
  // Post-commit + never-throws for the same reason as the win webhooks above.
  if (belowReserveNotify) {
    await notify({ uid: belowReserveNotify.sellerId, event: 'below_reserve_offer', data: {
      sellerId: belowReserveNotify.sellerId,
      auctionId: belowReserveNotify.auctionId,
      auctionTitle: belowReserveNotify.auctionTitle,
      topBid: belowReserveNotify.topBid,
      idempotencyKey: `${belowReserveNotify.auctionId}_below_reserve_offer`,
    } });
  }

  // (notify) and tell the TOP BIDDER their bid is with the seller. Separate
  // await, not chained onto the seller's: notify() never throws, but a failure
  // to reach one party must not silently skip the other.
  //
  // In-app ONLY (CHANNEL_POLICY.below_reserve_pending), so this sends no
  // WhatsApp and no email and never posts to n8n. It also says nothing the
  // buyer does not already know — their own bid, and that the lot's public
  // status is reserve_not_met. It carries no reserve amount and no tolerance
  // floor, and it is sent ONLY when an offer was actually stamped: a top bid
  // that fell outside the band gets no message at all, because "your bid was
  // too far below" would disclose roughly where the reserve sits.
  if (belowReserveNotify && belowReserveNotify.topBidderId) {
    await notify({ uid: belowReserveNotify.topBidderId, event: 'below_reserve_pending', data: {
      auctionId: belowReserveNotify.auctionId,
      auctionTitle: belowReserveNotify.auctionTitle,
      topBid: belowReserveNotify.topBid,
      idempotencyKey: `${belowReserveNotify.auctionId}_below_reserve_pending`,
    } });
  }

  return { settled, orderId: settledOrderId };
}

/**
 * 1. scheduledAuctionCloser (BUG #2 & BUG #6 Compliance)
 * Runs every minute to sweep, settle & close expired auctions with transactional consistency.
 * Prevents client-reliant closing so that auctions always conclude on server-set time.
 */
exports.scheduledAuctionCloser = functions.pubsub
  .schedule('every 1 minutes')
  .onRun(async (context) => {
    const now = admin.firestore.Timestamp.now();
    const nowMs = now.toMillis();
    
    console.log('[scheduledAuctionCloser] Executing minute cron check for expired active listings and migrating old listings...');

    try {
      // Query all auctions in states: active, live, upcoming
      const querySnap = await db.collection('auctions')
        .where('status', 'in', ['active', 'live', 'upcoming'])
        .get();

      if (querySnap.empty) {
        console.log('[scheduledAuctionCloser] No active, live, or upcoming listings found.');
        return null;
      }

      console.log(`[scheduledAuctionCloser] Scanning ${querySnap.size} active/live/upcoming listings for migration and expiration check...`);

      const promises = querySnap.docs.map(async (auctionDoc) => {
        const auctionId = auctionDoc.id;
        const auctionData = auctionDoc.data();
        let endsAt = auctionData.endsAt;
        let endTime = auctionData.endTime;
        let endsAtMs = 0;
        let needsMigration = false;

        // 1. Resolve endsAt to epoch ms
        if (endsAt) {
          if (typeof endsAt === 'object' && typeof endsAt.toMillis === 'function') {
            endsAtMs = endsAt.toMillis();
          } else if (endsAt.seconds !== undefined) {
            endsAtMs = endsAt.seconds * 1000;
          } else {
            endsAtMs = new Date(endsAt).getTime();
          }
        }

        // 2. Fallback to endTime & Migrate if endsAt is absent
        if (!endsAt && endTime) {
          endsAtMs = typeof endTime === 'number' ? endTime : (endTime.seconds ? endTime.seconds * 1000 : Date.parse(endTime));
          endsAt = admin.firestore.Timestamp.fromMillis(endsAtMs);
          needsMigration = true;
        }

        if (needsMigration && endsAt) {
          console.log(`[scheduledAuctionCloser] Migrating old auction ${auctionId} - setting endsAt to Firestore Timestamp.`);
          await auctionDoc.ref.update({
            endsAt: endsAt,
            endTime: endsAtMs
          }).catch(err => console.error(`Migration fail for auction ${auctionId}`, err));
        }

        // 3. Check if active/live auction has expired
        const isLive = auctionData.status === 'active' || auctionData.status === 'live';
        // E3 first_bid safety: a 'first_bid' lot goes live with NO endTime and
        // starts its clock only on the first bid. Until then endsAtMs is 0, so
        // `isExpired` is false and it is never settled/closed — it stays open
        // indefinitely awaiting that first bid. Once a bid sets endsAt, normal
        // expiry applies. This guard makes that intent explicit (endsAtMs > 0).
        const isExpired = endsAtMs > 0 && endsAtMs <= nowMs;

        if (isLive && isExpired) {
          console.log(`[scheduledAuctionCloser] Settling expired auction ${auctionId}...`);
          // Full settle logic lives in settleAuctionTxn (shared with simulateSettleNow).
          // Per-auction guard: a throw here (e.g. fail-closed reserve read) must
          // abort only THIS auction's settle this sweep — log and let the other
          // auctions settle; the per-minute cron retries this one next run.
          try {
            await settleAuctionTxn(auctionDoc.ref, auctionData);
          } catch (settleErr) {
            console.error(`[scheduledAuctionCloser] Settle failed for ${auctionId} — will retry next sweep:`, settleErr);
          }
        }
      });

      await Promise.all(promises);
      console.log('[scheduledAuctionCloser] Completed settlement sweep successfully.');
    } catch (err) {
      console.error('[scheduledAuctionCloser Global Error]', err);
    }
    return null;
  });

/**
 * scheduledAuctionOpener
 * Runs every minute; flips `upcoming` auctions whose scheduledStartAt has
 * arrived to `live`, resetting the countdown from `duration` at open time.
 * Only touches auctions that HAVE a scheduledStartAt (null = manual open).
 */
exports.scheduledAuctionOpener = functions.pubsub
  .schedule('every 1 minutes')
  .onRun(async (context) => {
    const nowMs = admin.firestore.Timestamp.now().toMillis();
    try {
      const snap = await db.collection('auctions').where('status', '==', 'upcoming').get();
      if (snap.empty) return null;

      const promises = snap.docs.map(async (docSnap) => {
        const data = docSnap.data();
        let startMs = data.scheduledStartAt;
        if (startMs === null || startMs === undefined) return; // manual-open drop; skip
        if (typeof startMs === 'object' && typeof startMs.toMillis === 'function') {
          startMs = startMs.toMillis();
        } else if (typeof startMs !== 'number') {
          startMs = new Date(startMs).getTime();
        }
        if (!(startMs > 0) || startMs > nowMs) return; // not due yet

        const durationSec = Number(data.duration) > 0 ? Number(data.duration) : 600;

        return db.runTransaction(async (tx) => {
          const fresh = await tx.get(docSnap.ref);
          const fd = fresh.data();
          if (!fd || fd.status !== 'upcoming') return; // already opened / changed
          // Mirror approveListing's go-live fields so an auto-opened auction is
          // NOT left counted as a pending approval (AdminDashboardView badge,
          // SellerCenterView bucket) and sorts correctly (LiveStreamView uses approvedAt).
          const goLive = {
            status: 'live',
            approvalStatus: 'approved',
            isApproved: true,
            approvedAt: admin.firestore.FieldValue.serverTimestamp(),
            approvedBy: 'scheduledAuctionOpener',
            openedAt: admin.firestore.FieldValue.serverTimestamp(),
          };
          // E3 first_bid: go live NOW but leave endTime/endsAt absent — the
          // duration clock starts on the first bid (applyBidWrites/computeBidEndTime).
          // Scheduled lots reset their countdown from `duration` at open time.
          if (fd.startMode !== 'first_bid') {
            const openMs = admin.firestore.Timestamp.now().toMillis();
            const endMs = openMs + durationSec * 1000;
            goLive.endTime = endMs;
            goLive.endsAt = admin.firestore.Timestamp.fromMillis(endMs);
          }
          tx.update(docSnap.ref, goLive);
        }).catch((err) => console.error(`[scheduledAuctionOpener] open failed for ${docSnap.id}`, err));
      });

      await Promise.all(promises);
    } catch (err) {
      console.error('[scheduledAuctionOpener]', err);
    }
    return null;
  });

/**
 * autoRelistSweep (E3 Slice B)
 * Every 60 minutes: finds auctions whose `relistEligibleAt` (stamped 24h after an
 * unsold / reserve-not-met settlement, seller opted in) has passed and creates a
 * FRESH listing for each — a brand-new auction doc copying the sale-relevant
 * fields, with autoRelistCount incremented.
 *
 * IDEMPOTENCY / anti-spam (three layers):
 *  1. The stamp only lands when the seller opted in AND autoRelistCount < cap
 *     (settleAuctionTxn → addRelistEligibility → shouldAutoRelist).
 *  2. Each relist runs in a transaction that RE-READS the original and bails
 *     unless shouldAutoRelist is still true, then marks the ORIGINAL
 *     `{ relisted: true }`. That mark makes shouldAutoRelist false forever after,
 *     so a later sweep (or an overlapping run — the tx reads the original, so a
 *     concurrent writer forces a retry that then sees relisted:true) never
 *     re-processes it. Exactly one replacement per original.
 *  3. autoRelistCount carries onto the child (prev+1); once it reaches the cap
 *     the child never gets a stamp, so the chain terminates at MAX_AUTO_RELISTS.
 */
exports.autoRelistSweep = functions.pubsub
  .schedule('every 60 minutes')
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now();
    try {
      const snap = await db.collection('auctions')
        .where('relistEligibleAt', '<=', now)
        .get();
      if (snap.empty) {
        console.log('[autoRelistSweep] Nothing eligible for relist.');
        return null;
      }
      console.log(`[autoRelistSweep] ${snap.size} candidate(s) past relistEligibleAt.`);

      const promises = snap.docs.map(async (docSnap) => {
        const origRef = docSnap.ref;
        const origId = origRef.id;
        // Pre-generate the child ref so a tx retry reuses the SAME id (no dupes).
        const newRef = db.collection('auctions').doc();
        const newId = newRef.id;
        try {
          let created = false;
          let reservePrice = null;
          await db.runTransaction(async (tx) => {
            const fresh = await tx.get(origRef);
            if (!fresh.exists) return;
            const d = fresh.data();
            // Re-check under the transaction: opted in, under cap, not already
            // relisted. The `relisted` mark below makes this false on any retry
            // or later sweep — exactly-once.
            if (!shouldAutoRelist(d, Date.now())) return;

            // Reserve copy: read the admin-only secret INSIDE the tx (all reads
            // before writes). Absent = no reserve; nothing to copy.
            const secretSnap = await tx.get(db.collection('auctionSecrets').doc(origId));
            if (secretSnap.exists) reservePrice = secretSnap.data().reservePrice ?? null;

            // A below-reserve offer that the seller accepted but the buyer never
            // confirmed leaves a stale pending order. We only reach here once the
            // offer window lapsed (shouldAutoRelist blocks a live offer), so cancel
            // that zombie order and expire the offer as we relist — no orphan +
            // duplicate-listing pair. (reads before writes.)
            const origOrderSnap = await tx.get(db.collection('orders').doc(origId));

            const nowMs = Date.now();
            const durationSec = Number(d.duration) > 0 ? Number(d.duration) : 600;
            const startMode = d.startMode === 'first_bid' ? 'first_bid' : 'scheduled';
            const startingPrice = d.startingPrice;

            const child = {
              id: newId,
              title: d.title || '',
              description: d.description || '',
              category: d.category || '',
              channel: d.channel || 'misc',
              thumbnailUrl: d.thumbnailUrl || '',
              startingPrice: startingPrice,
              currentPrice: startingPrice,
              minIncrement: d.minIncrement ?? 10,
              duration: durationSec,
              sellerId: d.sellerId || '',
              sellerName: d.sellerName || 'Seller',
              createdById: d.createdById || d.sellerId || '',
              startMode: startMode,
              autoRelist: true,
              autoRelistCount: (d.autoRelistCount || 0) + 1,
              relistedFrom: origId, // provenance (audit / analytics)
              totalBids: 0,
              currentBidderId: null,
              currentBidderName: null,
              isApproved: true,
              approvalStatus: 'approved',
              status: startMode === 'first_bid' ? 'live' : 'upcoming',
              // Open promptly: scheduled lots are flipped live by the opener on
              // its next run; first_bid lots are already live here.
              scheduledStartAt: nowMs,
              createdAt: nowMs,
              createdByName: d.createdByName || d.sellerName || 'Seller',
              paymentWindowHours: resolvePaymentWindowHours(d.paymentWindowHours),
              openedAt: admin.firestore.FieldValue.serverTimestamp(),
              approvedAt: admin.firestore.FieldValue.serverTimestamp(),
              approvedBy: 'autoRelistSweep',
            };
            // Conditional / optional sale fields — Firestore rejects explicit
            // undefined, so only copy when present.
            //
            // `viewing` / `viewingPlace` are DELIBERATELY absent from this
            // whitelist — do not "fix" that by adding them. The drop-builder
            // relist carries them because it is ATTENDED: an admin is looking at
            // the seeded chip and can change or clear it before the lot is
            // created. This sweep is UNATTENDED and stamps the child
            // isApproved: true, so it never re-enters the approval queue — no
            // human ever sees the claim it would be republishing. Auto-carrying
            // a physical-viewing claim onto a new lot with no human touchpoint
            // is exactly the fabrication utils/viewing.ts exists to prevent.
            // Omitting fails safe: resolveViewing returns null and the child
            // renders no viewing claim at all until staff state one.
            if (typeof startingPrice === 'number') child.currentPriceFils = Math.round(startingPrice * 1000);
            if (Array.isArray(d.mediaUrls) && d.mediaUrls.length > 0) child.mediaUrls = d.mediaUrls;
            if (d.imageUrl) child.imageUrl = d.imageUrl;
            if (typeof d.marketPrice === 'number') child.marketPrice = d.marketPrice;
            if (d.antiSnipeWindowSec != null) child.antiSnipeWindowSec = d.antiSnipeWindowSec;
            if (d.antiSnipeExtendSec != null) child.antiSnipeExtendSec = d.antiSnipeExtendSec;
            if (d.vendorId != null) child.vendorId = d.vendorId;
            if (d.vendorName) child.vendorName = d.vendorName;
            if (d.condition) child.condition = d.condition;
            if (reservePrice && reservePrice > 0) child.reserveMet = false;
            // first_bid: NO endTime/endsAt (clock starts on the first bid).
            // scheduled: fixed window from now.
            if (startMode !== 'first_bid') {
              const endMs = nowMs + durationSec * 1000;
              child.endTime = endMs;
              child.endsAt = admin.firestore.Timestamp.fromMillis(endMs);
            }

            // (a) mark the ORIGINAL relisted (idempotency — fires once); expire a
            // still-open below-reserve offer so it can't be acted on post-relist.
            const origUpdate = { relisted: true };
            if (d.belowReserveOffer && (d.belowReserveOffer.status === 'pending_seller' || d.belowReserveOffer.status === 'pending_buyer')) {
              origUpdate['belowReserveOffer.status'] = 'expired';
            }
            // Same treatment for a second-chance offer. `shouldAutoRelist`
            // already refuses to relist a lot carrying a live one, so reaching
            // here with a pending offer should be impossible — but if that
            // guard is ever weakened, an offer left open on a relisted lot
            // could still be accepted, selling an item that is live again.
            if (d.secondChanceOffer && (d.secondChanceOffer.status === 'pending_seller' || d.secondChanceOffer.status === 'pending_buyer')) {
              origUpdate['secondChanceOffer.status'] = 'expired';
            }
            tx.update(origRef, origUpdate);
            // (a2) cancel a stale seller-accepted-but-unconfirmed order.
            if (origOrderSnap.exists && origOrderSnap.data().status === 'pending_buyer_confirmation') {
              tx.update(origOrderSnap.ref, { status: 'cancelled', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            }
            // (b) create the fresh listing
            tx.set(newRef, child);
            created = true;
          });

          // Copy the reserve secret for the new listing (outside the tx: it's a
          // different collection doc and non-critical to the atomic relist mark).
          if (created && reservePrice && reservePrice > 0) {
            await db.collection('auctionSecrets').doc(newId).set({ reservePrice })
              .catch((e) => console.warn(`[autoRelistSweep] reserve copy failed for ${newId}:`, e));
          }
          if (created) {
            console.log(`[autoRelistSweep] Relisted ${origId} -> ${newId} (cap ${MAX_AUTO_RELISTS}).`);
          }
        } catch (relErr) {
          console.error(`[autoRelistSweep] Relist failed for ${origId} — will retry next sweep:`, relErr);
        }
      });

      await Promise.all(promises);
      console.log('[autoRelistSweep] Sweep complete.');
    } catch (err) {
      console.error('[autoRelistSweep Global Error]', err);
    }
    return null;
  });

/**
 * Announce a second-chance offer, then mark it announced.
 *
 * Shared by the open pass and the retry sweep so there is exactly one place
 * that decides WHO hears about an offer and one place that stamps
 * `notifiedAt` — a second copy would be free to drift into notifying the wrong
 * party or into never stamping.
 *
 * The stamp is written only AFTER notify returns. Throws on a failed stamp, on
 * purpose: the caller's catch logs it, `notifiedAt` stays null, and the sweep
 * picks the lot up next run.
 */
async function notifySecondChanceOffer(auctionRef, auction, offer) {
  // pending_seller waits on the seller; pending_buyer goes straight out.
  // Reuses `below_reserve_offer` deliberately — the live n8n workflow routes a
  // fixed 20-event contract and silently drops anything else.
  const uid = offer.status === 'pending_seller' ? auction.sellerId : offer.bidderId;
  // NO RECIPIENT — refuse rather than pretend. A `pending_seller` offer on a lot
  // with no `sellerId` (only reachable on a legacy/imported auction) would
  // otherwise notify nobody, still stamp `notifiedAt` as though it had been
  // announced, and hold the lot out of auto-relist for a full 24h for an offer
  // that renders for no one and that nobody can accept — `seller_accept`
  // requires `auction.sellerId === callerUserId`, which no caller can satisfy
  // when the field is empty. `notify()` does not fail on a blank uid either: it
  // posts to n8n with empty phone/email and returns happily.
  //
  // Same PRINCIPLE as the decline path's `if (!pendingNotify.uid) pendingNotify
  // = null` — a recipient-less notification is never sent — but deliberately NOT
  // the same mechanism, and the difference matters. There, dropping the notify
  // is the whole remedy: the transaction has already written the decline and
  // there is no follow-up write to protect.
  //
  // HERE a bare `return` would leave `notifiedAt` null too — the guard sits
  // above both the notify and the stamp, so either exit skips them. What a
  // `return` would NOT do is say anything: the callers at the two call sites
  // only ever learn about this through their `catch`. Throwing is for
  // observability, not for control flow. A silent return would leave the retry
  // sweep re-reading a lot it can never announce, with nothing in the logs
  // naming the empty `sellerId` as the reason.
  //
  // Either way the offer stays findable by retryUnnotifiedSecondChanceOffers
  // rather than being disguised as announced, and the retry stops on its own
  // once the 24h window lapses (`needsNotifyRetry` requires a LIVE offer).
  if (!uid) {
    throw new Error(`[secondChance] ${auctionRef.id}: ${offer.status} offer has no recipient uid — not announcing`);
  }
  await notify({
    uid,
    event: 'below_reserve_offer',
    data: {
      auctionId: auctionRef.id,
      auctionTitle: auction.title || '',
      topBid: offer.amount,
      // The event is shared with a genuine below-reserve offer, so the COPY has
      // to be told which situation this is: here the bids did not fall short —
      // the winner defaulted. `offerStatus` then picks the right recipient's
      // wording (seller asked to accept vs runner-up being offered the lot).
      secondChance: true,
      offerStatus: offer.status,
      idempotencyKey: `${auctionRef.id}_second_chance_open`,
    },
  });
  await auctionRef.update({
    'secondChanceOffer.notifiedAt': admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Finish the job for offers that were opened but never announced.
 *
 * Stamping the offer and telling someone about it are two writes. When the
 * second fails, the lot ends up in the worst of both worlds: held out of
 * auto-relist for 24h on behalf of a bidder who was never told they had an
 * offer. Nothing else can rescue it — the defaulted order has left the
 * enforcer's `waiting_payment` query permanently, and the one-offer-per-lot
 * guard would skip the auction anyway.
 *
 * Runs on EVERY enforcer tick, including ticks where nothing new defaults —
 * which is most of them, and exactly when the stranded offer from an earlier
 * run is waiting.
 *
 * The query leans on `notifiedAt: null` being written explicitly: Firestore's
 * `== null` matches a stored null but NOT a missing field, so lots that never
 * had an offer never appear here. NEVER THROWS.
 */
async function retryUnnotifiedSecondChanceOffers() {
  try {
    const snap = await db.collection('auctions')
      .where('secondChanceOffer.notifiedAt', '==', null)
      .limit(50)
      .get();
    for (const docSnap of snap.docs) {
      const auction = docSnap.data() || {};
      const offer = auction.secondChanceOffer;
      // Expired or already-decided offers stay unstamped and simply age out —
      // re-announcing one would invite someone to act on a dead offer.
      if (!needsNotifyRetry(offer, Date.now())) continue;
      try {
        await notifySecondChanceOffer(docSnap.ref, auction, offer);
        console.log(`[secondChance] re-announced stranded ${offer.status} offer on ${docSnap.id}`);
      } catch (e) {
        console.error(`[secondChance] notify retry failed for ${docSnap.id} (non-fatal):`, e && e.message);
      }
    }
  } catch (e) {
    console.error('[secondChance] un-notified sweep failed (non-fatal):', e && e.message);
  }
}

/**
 * Retire offers whose window closed with nobody answering.
 *
 * The 24h window is enforced when somebody ACTS — every accept/confirm/reject/
 * decline callable refuses a lapsed offer. Nothing enforced it when nobody
 * acted, which is the case the window exists for. An ignored offer therefore
 * sat at `pending_seller` forever: both parties kept seeing a decision that
 * could no longer be made, neither was ever told the window closed, and the
 * lot's own record of what happened never reached a terminal value.
 *
 * `autoRelistSweep` expires offers in passing, but only on lots it is
 * relisting, and `shouldAutoRelist` requires `autoRelist === true` — so every
 * lot whose seller did not opt into auto-relisting was skipped entirely.
 *
 * Queries by STATUS, not by expiry: an equality match on a nested field uses
 * the automatic single-field index, so this needs no composite index, and the
 * result set is bounded by how many offers are pending right now rather than
 * by how many have ever expired. Expiry is then decided in `offerExpiry.js`.
 *
 * Runs on the enforcer's 30-minute tick beside the other offer housekeeping.
 * NEVER THROWS — the enforcer also lifts expired bans, and a stuck offer must
 * not stop that.
 */
async function expireLapsedOffers() {
  try {
    const nowMs = Date.now();

    // One auction can hold both offer fields, and four queries can return it
    // more than once. Collect first, decide once.
    const candidates = new Map();
    for (const field of OFFER_FIELDS) {
      for (const status of PENDING_STATUSES) {
        const snap = await db.collection('auctions')
          .where(`${field}.status`, '==', status)
          .limit(100)
          .get();
        for (const d of snap.docs) candidates.set(d.id, d);
      }
    }

    for (const docSnap of candidates.values()) {
      const auction = docSnap.data() || {};

      // Loud, and deliberately NOT auto-fixed: with no datable timestamp
      // anywhere, retiring the offer would be a guess, and a wrong guess here
      // cancels a live offer. These are stuck until someone looks.
      for (const stuck of undatableOffers(auction)) {
        console.error(
          `[offerExpiry] ${docSnap.id}.${stuck.field} is pending with no usable expiresAt and ` +
          `nothing to derive one from — it can never expire and blocks relisting. Needs a human.`,
        );
      }

      for (const lapsed of lapsedOffers(auction, nowMs)) {
        const { field, offer, derived } = lapsed;
        try {
          await docSnap.ref.update({
            [`${field}.status`]: 'expired',
            [`${field}.expiredAt`]: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`[offerExpiry] retired ${offer.status} ${field} on ${docSnap.id}${derived ? ' (deadline derived — it had no usable expiresAt)' : ''}`);
        } catch (e) {
          console.error(`[offerExpiry] could not retire ${field} on ${docSnap.id} (non-fatal):`, e && e.message);
          continue; // no write, so send nothing
        }

        const plan = expiryNotification(auction, field, offer);
        if (plan) {
          await notify({
            uid: plan.uid,
            event: plan.event,
            data: {
              auctionId: docSnap.id,
              auctionTitle: auction.title || '',
              ...plan.data,
              idempotencyKey: `${docSnap.id}_${field}_expired`,
            },
          });
        } else if (expiryNeedsCopy(offer)) {
          // The seller accepted and the buyer never confirmed, so the seller
          // lost a sale they had agreed to — and there is no string that says
          // that. Rendering the bidder's wording at them would be worse than
          // the silence, so the gap is logged rather than papered over.
          console.warn(
            `[offerExpiry] ${docSnap.id}.${field} lapsed at pending_buyer — seller ${auction.sellerId} ` +
            `was NOT notified: no copy exists for "the buyer did not confirm".`,
          );
        }
      }
    }
  } catch (e) {
    console.error('[offerExpiry] sweep failed (non-fatal):', e && e.message);
  }
}

/**
 * Open a second-chance offer on each freshly-defaulted lot.
 *
 * Runs AFTER the enforcer's batch commits: finding the runner-up needs a bids
 * subcollection query, which does not belong inside a write batch.
 *
 * NEVER THROWS. paymentDefaultEnforcer also lifts expired bans; a second-chance
 * failure must not stop that. A lot that fails to get an offer is simply the
 * status quo.
 *
 * Idempotent: the enforcer runs every 30 minutes, so an auction that already
 * carries a `secondChanceOffer` is skipped rather than re-offered.
 */
async function openSecondChanceOffers(defaultedDocs) {
  for (const doc of defaultedDocs) {
    const order = doc.data() || {};
    const auctionId = order.auctionId;
    if (!auctionId) continue;
    // No buyerId (the enforcer's `noBuyer` path) means we cannot tell the
    // runner-up from the defaulter, and `pickRunnerUp(bids, undefined)` would
    // hand the lot straight back to whoever just failed to pay. Skipping leaves
    // the status quo — the safe side of a data anomaly.
    if (!order.buyerId) {
      console.log(`[secondChance] ${auctionId} order ${doc.id} has no buyerId — skipping`);
      continue;
    }
    try {
      const auctionRef = db.collection('auctions').doc(auctionId);
      const auctionSnap = await auctionRef.get();
      if (!auctionSnap.exists) continue;
      const auction = auctionSnap.data() || {};

      // One offer per lot, ever.
      if (auction.secondChanceOffer) {
        console.log(`[secondChance] ${auctionId} already has an offer — skipping`);
        continue;
      }

      const bidsSnap = await auctionRef.collection('bids').get();
      const bids = bidsSnap.docs.map(d => d.data());
      const runnerUp = pickRunnerUp(bids, order.buyerId);
      if (!runnerUp) {
        console.log(`[secondChance] ${auctionId} has no runner-up — relist path unchanged`);
        continue;
      }

      // NEVER OPEN AN OFFER TO A BANNED RUNNER-UP.
      //
      // THE READ IS HERE, THE JUDGEMENT IS NOT. This function does the I/O —
      // reading `users/{uid}` is exactly what the pure layer must not do — and
      // `secondChance.shouldSkipRunnerUp` decides, so the decision is covered by
      // BEHAVIOURAL tests rather than source greps. That split is not cosmetic: a
      // review mutated the previous inline `isEffectivelyBlocked` to its inverse
      // — offering to every banned runner-up and skipping every eligible one —
      // and all 18 source-text assertions still passed. Do NOT re-inline it.
      //
      // The lookup result is reported honestly, including WHY it is empty:
      // a missing doc and a failed read are different facts, and the helper owns
      // what each one means (both fail open; see its comment for why the failed
      // read is deliberately the opposite call to the reserve read below).
      //
      // NOT inside `pickRunnerUp`: threading the ban in would mean reading a user
      // doc for EVERY bidder to build a ban set before the pick, instead of one
      // read for the one bidder who won it.
      //
      // NO CASCADE to the third bidder — a second chance is one-shot by design
      // (see secondChance.js). A skipped lot simply follows today's relist path,
      // which is precisely the documented no-qualifying-bidder behaviour. The log
      // line is distinct from the no-runner-up one so the two are never confused.
      let banLookup = { readable: true, user: null };
      try {
        const bidderSnap = await db.collection('users').doc(runnerUp.bidderId).get();
        banLookup = { readable: true, user: bidderSnap.exists ? (bidderSnap.data() || {}) : null };
      } catch (e) {
        banLookup = { readable: false, user: null };
        console.warn(`[secondChance] ban lookup failed for ${runnerUp.bidderId} on ${auctionId}:`, e && e.message);
      }
      if (shouldSkipRunnerUp(banLookup, Date.now())) {
        console.log(`[secondChance] ${auctionId} runner-up ${runnerUp.bidderId} is blocked — no offer opened, relist path unchanged`);
        continue;
      }

      // The reserve is admin-only (auctions/{id} is world-readable), so it comes
      // from auctionSecrets. `openingStateFor` distinguishes a GENUINELY ABSENT
      // reserve (no doc / no field / the number 0 — anything clears it) from one
      // that is PRESENT BUT UNREADABLE (NaN, '', 'abc', -5 — ask the seller).
      // The stored value is therefore passed through UNCHANGED: no Number(), no
      // `|| 0`, no `?? 0`. Coercing here would silently sell a lot under its
      // seller's reserve, which is the exact harm that fork exists to prevent.
      let reserve = null;
      let reserveReadable = true;
      try {
        const secretSnap = await db.collection('auctionSecrets').doc(auctionId).get();
        if (secretSnap.exists) reserve = (secretSnap.data() || {}).reservePrice;
      } catch (e) {
        // A failed lookup is not an absent reserve — we simply do not know. Same
        // fail-safe: ask the seller. (We cannot retry later; once the order is
        // `defaulted` this sweep never sees it again.)
        reserveReadable = false;
        console.warn(`[secondChance] reserve lookup failed for ${auctionId}:`, e && e.message);
      }

      const openingState = reserveReadable
        ? openingStateFor(runnerUp.amount, reserve)
        : 'pending_seller';
      const offer = buildOfferRecord(
        { Timestamp: admin.firestore.Timestamp, now: () => Date.now() },
        { runnerUp, defaultedOrderId: doc.id, openingState },
      );

      await auctionRef.update({ secondChanceOffer: offer });

      // ORDER MATTERS from here. The offer is now live and already holds the lot
      // out of auto-relist for 24h, so announcing it is no longer optional — and
      // these are separate round-trips that cannot be made atomic.
      //
      // THE AUDIT ROW GOES FIRST. `second_chance_opened` is the only way to
      // watch the first fully automatic sale path in the system (docs/BACKLOG.md),
      // and it is needed MOST on the runs where something then went wrong.
      // Written after the notify it would be lost by a throw at the `notifiedAt`
      // stamp — losing the observability record for an offer that did in fact go
      // live, which is exactly backwards. Writing it first can only ever
      // overstate by recording an offer whose announcement then failed, and that
      // offer IS live: it already blocks relist, and the un-notified retry sweep
      // will finish announcing it.
      //
      // Then: announce, THEN stamp notifiedAt. Anything that fails before the
      // stamp leaves `notifiedAt: null`, which is what
      // retryUnnotifiedSecondChanceOffers hunts for on a later run.
      await db.collection('system_health').add({
        type: 'second_chance_opened',
        title: `Second chance offered (${openingState})`,
        details: `Auction ${auctionId} (${order.auctionTitle || ''}) → ${runnerUp.bidderName} at ${runnerUp.amount} JOD after ${order.buyerName || order.buyerId} defaulted.`,
        source: 'paymentDefaultEnforcer',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await notifySecondChanceOffer(auctionRef, auction, offer);
      console.log(`[secondChance] opened ${openingState} on ${auctionId} for ${runnerUp.bidderId}`);
    } catch (e) {
      console.error(`[secondChance] failed for auction ${auctionId} (non-fatal):`, e && e.message);
    }
  }
}

/**
 * subscriptionExpirySweep
 * Every 60 minutes: any membership still flagged 'active' whose expiry has
 * passed is written to 'expired'.
 *
 * WHY THIS EXISTS AT ALL, given placeBid already refuses expired members and
 * auctions/{id}/bids is `allow write: if false`: `subscriptionStatus` was a
 * LATCH. It was written once at approval and never again, so the stored flag
 * drifted permanently away from the expiry sitting beside it. Nothing was
 * mis-granted — but every reader that trusted the flag instead of recomputing
 * the date inherited the lie, which is why the admin subscriber count counted
 * lapsed members and the account screen printed ACTIVE above a past date.
 *
 * 60 MINUTES, NOT 5. A membership boundary is a date, not a deadline anyone is
 * racing: an hour of staleness in a *derived-anyway* flag costs nothing, since
 * every gate that matters recomputes from the expiry on the spot. The interval
 * is about keeping stored state honest, not about enforcement latency.
 *
 * `timeoutSeconds: 300` — two indexed queries plus one merge write per lapsed
 * member. The default 60s is enough today; the headroom is for a backlog on the
 * first run after deploy, which sweeps every member who has ever lapsed.
 */
exports.subscriptionExpirySweep = functions
  .runWith({ timeoutSeconds: 300 })
  .pubsub
  .schedule('every 60 minutes')
  .onRun(async () => {
    try {
      const summary = await expireLapsedSubscriptions({
        db,
        Timestamp: admin.firestore.Timestamp,
        FieldValue: admin.firestore.FieldValue,
        now: () => Date.now(),
      });
      console.log('[subscriptionExpirySweep] done', JSON.stringify(summary));
    } catch (e) {
      // A thrown sweep is a retried sweep with no record of why. Log and
      // swallow: the next run is an hour away and the data is unchanged.
      console.error('[subscriptionExpirySweep] run failed:', e && e.message);
    }
    return null;
  });

/**
 * paymentDefaultEnforcer
 * Every 30 minutes: any order still waiting_payment past its paymentDeadlineAt
 * is marked defaulted and the buyer is blocked (isBlocked) pending admin review.
 * A defaulted lot then gets one automatic second-chance offer to the runner-up.
 *
 * `timeoutSeconds: 540` — the 60s default is no longer enough headroom. Per
 * defaulted lot this now does 4 reads + 2 writes plus a 5s-bounded HTTP call to
 * n8n, and a ≤50-doc un-notified retry sweep runs BEFORE any of that. A hung
 * n8n behind a sweep backlog could burn the whole minute before a single order
 * is defaulted — and a timeout here also drops section A, the cooldown lift that
 * un-bans users. 9 minutes is the same ceiling Cloud Functions v1 allows.
 */
exports.paymentDefaultEnforcer = functions
  .runWith({ timeoutSeconds: 540 })
  .pubsub
  .schedule('every 30 minutes')
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now();
    const nowMs = now.toMillis();
    try {
      // A. Auto-expiry: lift any cooldown whose blockedUntil has elapsed so the
      // user regains bidding and the UI/ban banner clears without a bid attempt.
      // Permanent bans have no blockedUntil, so they never match this query.
      const expiredSnap = await db.collection('users')
        .where('blockedUntil', '<=', now)
        .get();
      for (const uDoc of expiredSnap.docs) {
        const u = uDoc.data();
        if (u.isBlocked === true) {
          await uDoc.ref.set(
            {
              isBlocked: false,
              blockedUntil: admin.firestore.FieldValue.delete(),
              blockedReason: admin.firestore.FieldValue.delete(),
            },
            { merge: true }
          );
          console.log(`[paymentDefaultEnforcer] cooldown expired — unblocked ${uDoc.id}`);
        }
      }

      // A2. Finish any second-chance offer that was opened but never announced.
      // Deliberately ABOVE the `snap.empty` early return below: the stranded
      // offer was opened on some earlier run, and the runs that can rescue it
      // are overwhelmingly the ones where nothing new defaults.
      await retryUnnotifiedSecondChanceOffers();

      // A3. Retire offers whose 24h window closed with nobody answering.
      // Same reason as A2 for sitting above the early return: the lapsed
      // offers are from earlier runs, so the ticks that can clear them are
      // precisely the quiet ones where nothing new defaults.
      await expireLapsedOffers();

      // B. Default any order past its payment deadline and advance the buyer's
      // strike ladder (1st = 48h, repeat = 3-month). Group by buyer so a buyer
      // with N newly-defaulted orders advances N strikes computed once.
      const snap = await db.collection('orders')
        .where('status', '==', 'waiting_payment')
        .where('paymentDeadlineAt', '<=', now)
        .get();
      if (snap.empty) return null;

      const ordersByBuyer = new Map();
      const noBuyer = [];
      for (const doc of snap.docs) {
        // A buyer with a LIVE CliQ request is not a non-payer. They have been
        // told by our own screen to approve it in their bank app, and our own
        // disclaimer says that can take up to two hours — while this sweep runs
        // every 30 minutes. Defaulting them mid-request would block them, add a
        // strike (48h first offence, 3 months on repeat) and hand their lot to
        // the runner-up, for doing exactly what we asked.
        //
        // Deferring is safe: the request expires after 90 minutes, at which
        // point cliqPaymentStatus stops being 'pending' and the NEXT sweep
        // defaults them normally. Nothing escapes the ladder, it only waits.
        // Filtered here rather than in the query because Firestore cannot
        // express "!= pending OR missing" alongside the two range/equality
        // clauses above without a composite index and a second query.
        if (isCliqRequestLive(doc.data(), Date.now())) {
          console.log(`[paymentDefaultEnforcer] deferring ${doc.id} — CliQ request pending`);
          continue;
        }
        const buyerId = doc.data().buyerId;
        if (!buyerId) { noBuyer.push(doc); continue; }
        if (!ordersByBuyer.has(buyerId)) ordersByBuyer.set(buyerId, []);
        ordersByBuyer.get(buyerId).push(doc);
      }

      const markDefaulted = (batch, doc) => {
        const o = doc.data();
        batch.update(doc.ref, { status: 'defaulted', defaultedAt: admin.firestore.FieldValue.serverTimestamp() });
        batch.set(db.collection('system_health').doc(), {
          type: 'payment_fail',
          title: `Order defaulted (${resolvePaymentWindowHours(o.paymentWindowHours)}h unpaid)`,
          details: `Order ${doc.id} (${o.auctionTitle || ''}) buyer ${o.buyerName || o.buyerId} — ${o.totalDue || o.winningBidAmount} JOD. Buyer blocked; decide re-run/runner-up.`,
          source: 'paymentDefaultEnforcer',
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      };

      for (const [buyerId, docs] of ordersByBuyer.entries()) {
        const userRef = db.collection('users').doc(buyerId);
        const userSnap = await userRef.get();
        const currentStrikes = userSnap.exists ? (Number(userSnap.data().strikeCount) || 0) : 0;
        // A "miss" is one occasion, not one-per-order: multiple unpaid wins
        // lapsing in the SAME run count as a single strike, so a first-time
        // defaulter with several same-night wins still gets the 48h tier (not
        // an instant 3-month suspension). Advance at most +1 per enforcer run.
        const newStrikes = currentStrikes + 1;
        const { blockedUntil, blockedReason } = resolvePaymentDefaultBan(newStrikes, nowMs);

        const batch = db.batch();
        for (const doc of docs) markDefaulted(batch, doc);
        batch.set(userRef, {
          isBlocked: true,
          blockedUntil: admin.firestore.Timestamp.fromMillis(blockedUntil),
          blockedReason,
          strikeCount: newStrikes,
        }, { merge: true });
        await batch.commit();
        console.log(`[paymentDefaultEnforcer] buyer ${buyerId}: +1 strike (${docs.length} order(s) defaulted) → ${newStrikes}, ${blockedReason} until ${new Date(blockedUntil).toISOString()}`);
        // Second chance for THIS buyer's lots, immediately after their commit
        // and never before it — the runner-up lookup needs a bids subcollection
        // query, which has no place inside a write batch. Per-buyer rather than
        // once at the end because a later buyer's commit can throw: those
        // orders are already `defaulted` and will never re-enter the
        // `waiting_payment` query, so a deferred pass would forfeit their
        // second chance for good. Wrapped because this function ALSO lifts
        // expired bans above; a second-chance failure must not stop that.
        // Re-entry is safe — the offer-already-exists guard makes it a no-op.
        try {
          await openSecondChanceOffers(docs);
        } catch (e) {
          console.error('[paymentDefaultEnforcer] second-chance pass failed (non-fatal):', e && e.message);
        }
      }

      // Orders with no buyer id: still default them (no strike to apply).
      for (const doc of noBuyer) {
        const batch = db.batch();
        markDefaulted(batch, doc);
        await batch.commit();
        // Same call for the same reason — one code path, no special case. These
        // orders are then skipped inside: with no buyerId there is no way to
        // tell the runner-up from the defaulter.
        try {
          await openSecondChanceOffers([doc]);
        } catch (e) {
          console.error('[paymentDefaultEnforcer] second-chance pass failed (non-fatal):', e && e.message);
        }
      }
    } catch (err) {
      console.error('[paymentDefaultEnforcer]', err);
    }
    return null;
  });

/**
 * Keep the admin callables warm.
 *
 * The Action Center's buttons sit behind callables that cold-start at ~2s
 * (measured 2026-07-31). Admins work in bursts after idle periods, which is
 * precisely when a cold start lands. Five minutes is comfortably inside
 * Google's idle-eviction window without being chatty.
 *
 * Never throws: a warmer that breaks the function log is worse than a cold
 * start. Failures are counted and logged once, not raised. Note that a JS
 * exception is not the only way to pollute that log — see the bounded signal
 * below; a stalled ping that runs out the function's own timeoutSeconds is
 * recorded by Cloud Functions at ERROR severity, which would defeat the whole
 * point of this function through a side door the try/catch cannot cover.
 *
 * What to ping is decided by buildWarmPlan (warmTargets.js), not here: this
 * loop deliberately has no per-target logic for a skip to hide in.
 */
exports.warmAdminCallables = functions
  .runWith({ timeoutSeconds: 60 })
  .pubsub
  .schedule('every 5 minutes')
  .onRun(async () => {
    const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
    if (!projectId) {
      console.warn('[warmAdminCallables] no project id in env — skipping');
      return null;
    }
    // us-central1 is where everything in this repo deploys — nothing sets a
    // region, so that is the value that is actually used.
    //
    // The env read is a BEST-EFFORT FALLBACK THAT IS EXPECTED TO BE UNSET here.
    // FUNCTION_REGION is a legacy Node 8 runtime variable and was removed on
    // Node 10+; this is a Node 20 1st-gen deployment, so it is almost certainly
    // undefined and the literal always wins. It does NOT self-correct on a
    // region change — an earlier comment claimed it did, which was wrong. If
    // this project ever moves region, CHANGE THE LITERAL; the pings would
    // otherwise 404 and report as one warn line while cold starts quietly
    // came back.
    const region = process.env.FUNCTION_REGION || 'us-central1';
    const plan = buildWarmPlan(projectId, region);
    const results = await Promise.all(plan.map(async ({ name, url, body }) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          // Bounded like every other outbound call here (pollN8nHealth uses the
          // same idiom). Unbounded, one stalled ping parks Promise.all until
          // timeoutSeconds fires and the run is logged as an error.
          signal: AbortSignal.timeout(10000),
        });
        // Drain the body. Under Node 20's undici an unread response holds its
        // connection until GC; harmless alone, but it compounds with any delay.
        await res.arrayBuffer().catch(() => {});
        return res.ok;
      } catch (e) {
        console.warn(`[warmAdminCallables] ${name} ping failed: ${e.message}`);
        return false;
      }
    }));
    const failed = results.filter(ok => !ok).length;
    if (failed) console.warn(`[warmAdminCallables] ${failed}/${plan.length} pings failed`);
    return null;
  });

// E5 — nudge buyers with an unpaid order still inside its payment window. One
// reminder at ~50% remaining, a final one ~2h before expiry; idempotent via
// remind50Sent/remindFinalSent flags. Expired orders are the enforcer's job.
exports.paymentReminderSweep = functions.pubsub
  .schedule('every 30 minutes')
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now();
    const nowMs = now.toMillis();
    try {
      const snap = await db.collection('orders')
        .where('status', '==', 'waiting_payment')
        .where('paymentDeadlineAt', '>', now)
        .get();
      for (const doc of snap.docs) {
        const o = doc.data();
        const due = dueReminders(o, nowMs);
        if (due.length === 0) continue;
        await notify({
          uid: o.buyerId,
          event: 'payment_reminder',
          data: {
            auctionId: o.auctionId, auctionTitle: o.auctionTitle,
            totalDue: o.totalDue || o.winningBidAmount,
            paymentHours: resolvePaymentWindowHours(o.paymentWindowHours),
            // The email states the amount, the exact deadline and the MZ ref —
            // the old one said only "before the deadline expires".
            orderId: doc.id,
            orderRef: o.orderRef || '',
            paymentDeadlineAt: o.paymentDeadlineAt || null,
            idempotencyKey: `${doc.id}_payment_reminder_${due[0]}`,
          },
        });
        const flags = due[0] === 'final'
          ? { remind50Sent: true, remindFinalSent: true }
          : { remind50Sent: true };
        await doc.ref.set(flags, { merge: true });
      }
    } catch (err) {
      console.error('[paymentReminderSweep]', err);
    }
    return null;
  });

/**
 * pollN8nHealth
 * Every 15 minutes: pull execution stats for the three watched n8n workflows
 * (reply bot, notification pipe, OTP relay) via the n8n API and write a single
 * status doc the admin health tab reads in real time. Raises a system_health
 * incident when a workflow's failure rate crosses the threshold OR when it has
 * no executions at all — see ./n8nHealth for why silence is its own alarm.
 * De-duped to at most one incident per hour per workflow.
 *
 * Requires N8N_API_KEY + N8N_BASE_URL; if either is unset this is a clean no-op
 * (same discipline as postToN8n). NEVER throws — a failed poll only logs and
 * leaves the last-known system_status/current doc intact.
 *
 * The watched workflows, the window, the thresholds and the judgement all live
 * in ./n8nHealth — pure, so every branch is EXECUTED by n8nHealth.test.js
 * rather than asserted as source text.
 */

exports.pollN8nHealth = functions.pubsub
  .schedule('every 15 minutes')
  .onRun(async () => {
    const apiKey = process.env.N8N_API_KEY;
    const baseUrl = process.env.N8N_BASE_URL;
    if (!apiKey || !baseUrl) {
      console.log('[pollN8nHealth] N8N_API_KEY / N8N_BASE_URL not configured — skipping.');
      return null;
    }

    try {
      const n8n = {};

      for (const wf of N8N_HEALTH_WORKFLOWS) {
        try {
          const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/executions?workflowId=${wf.id}&limit=100`;
          const res = await fetch(url, {
            headers: { 'X-N8N-API-KEY': apiKey },
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) {
            console.warn(`[pollN8nHealth] n8n API ${res.status} for workflow ${wf.key} — skipping this block.`);
            continue;
          }
          const body = await res.json();
          // Tolerate both API shapes: { data: [...] } (n8n public API) or a bare array.
          const executions = Array.isArray(body) ? body : (Array.isArray(body.data) ? body.data : []);
          n8n[wf.key] = {
            ...summarizeExecutions(executions, Date.now()),
            checkedAt: admin.firestore.Timestamp.now(),
          };
        } catch (wfErr) {
          console.warn(`[pollN8nHealth] Poll failed for workflow ${wf.key}:`, wfErr && wfErr.message);
        }
      }

      if (Object.keys(n8n).length === 0) {
        console.warn('[pollN8nHealth] No workflow blocks fetched — leaving last status doc intact.');
        return null;
      }

      await db.collection('system_status').doc('current').set({
        n8n,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      // Threshold incidents (de-duped: at most one per workflow per hour).
      for (const wf of N8N_HEALTH_WORKFLOWS) {
        const incident = incidentFor(n8n[wf.key], wf.label);
        if (!incident.raise) continue;
        const title = incident.title;
        try {
          const oneHourAgo = admin.firestore.Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
          const recent = await db.collection('system_health')
            .where('source', '==', 'pollN8nHealth')
            .where('title', '==', title)
            .where('createdAt', '>=', oneHourAgo)
            .limit(1)
            .get();
          if (!recent.empty) continue;
          await db.collection('system_health').add({
            type: 'error',
            title,
            details: incident.details,
            source: 'pollN8nHealth',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`[pollN8nHealth] Incident logged: ${title} — ${incident.details}`);
        } catch (incErr) {
          console.warn(`[pollN8nHealth] Incident write failed for ${wf.key}:`, incErr && incErr.message);
        }
      }
    } catch (err) {
      console.error('[pollN8nHealth]', err);
    }
    return null;
  });

/**
 * 2. onBidCreated (BUG #5 Compliance)
 * Activates instant real-time outbid notifications.
 * Sends push messaging to the outbid user (previousBidderId) the instant a higher bid enters the database subcollection.
 */
exports.onBidCreated = functions.firestore
  .document('auctions/{auctionId}/bids/{bidId}')
  .onCreate(async (snapshot, context) => {
    const bidData = snapshot.data();
    const auctionId = context.params.auctionId;

    const amount = bidData.amount;
    const bidderId = bidData.bidderId;

    try {
      // Get the current leading auction document to retrieve the previous bidder details recorded during transaction
      const auctionSnap = await db.collection('auctions').doc(auctionId).get();
      if (!auctionSnap.exists) {
        console.warn(`[onBidCreated] Auction ${auctionId} not found.`);
        return null;
      }

      const auctionData = auctionSnap.data();

      // Maintain the room's reserve-met label without leaking the amount.
      // Only flip false -> true (once), and only when a reserve actually exists.
      try {
        const secretSnap = await db.collection('auctionSecrets').doc(auctionId).get();
        const rp = secretSnap.exists ? (secretSnap.data().reservePrice ?? null) : null;
        if (rp) {
          const met = reserveMet(auctionData.currentPrice ?? amount, rp);
          if (met && auctionData.reserveMet !== true) {
            await db.collection('auctions').doc(auctionId).update({ reserveMet: true });
          }
        }
      } catch (rmErr) {
        console.warn(`[onBidCreated] reserveMet update failed for ${auctionId}:`, rmErr);
      }

      const previousBidderId = auctionData.previousBidderId;

      // Only notify if there is an active previous bidder and they are not the person who just bid
      if (previousBidderId && previousBidderId !== bidderId) {
        const prevUserSnap = await db.collection('users').doc(previousBidderId).get();
        if (prevUserSnap.exists) {
          const prevUserData = prevUserSnap.data();
          const fcmToken = prevUserData.fcmToken;

          if (fcmToken) {
            console.log(`[onBidCreated] Dispatching FCM outbid notification to user ${previousBidderId}`);

            // (language) off the doc already fetched for the FCM token, so no
            // extra read. Same event copy as the `outbid` notify() call below —
            // the push and the WhatsApp for one bid must not arrive in two
            // different languages.
            const outbidLang = safeResolveLang(prevUserData, `outbid ${previousBidderId}`);
            // pushCopyFor, not copyFor: the push carries the NEW PRICE, which is
            // what actually brings a bidder back to bid again. The in-app and
            // WhatsApp lines stay terse on purpose — see the override map in
            // messageCopy.js. Same language, different length.
            const c = pushCopyFor('outbid', {
              auctionTitle: (auctionData && auctionData.title) || '',
              amount,
            }, outbidLang);

            const payload = {
              token: fcmToken,
              notification: {
                title: c.title,
                body: c.description
              },
              data: {
                click_action: 'FLUTTER_NOTIFICATION_CLICK',
                auctionId: auctionId,
                bidAmount: String(amount)
              }
            };

            await admin.messaging().send(payload);
            console.log('[onBidCreated] FCM dispatch successful.');
          } else {
            console.log(`[onBidCreated] User ${previousBidderId} does not have a registered FCM Token.`);
          }

          // (notify) WhatsApp outbid — fires even without an FCM token; never throws.
          await notify({ uid: previousBidderId, event: 'outbid', data: {
            name: (prevUserData && prevUserData.name) || 'Bidder',
            auctionId: auctionId,
            auctionTitle: (auctionData && auctionData.title) || '',
            amount: amount,
            idempotencyKey: `outbid_${context.params.bidId}`,
          } });
        }
      }
    } catch (err) {
      console.error('[onBidCreated Error]', err);
    }
    return null;
  });

/**
 * onOrderStatusChanged
 * Emits a WhatsApp webhook event when an order's `status` transitions to a
 * notify-worthy value (shipped/delivered/etc). Never fires on create, and
 * never on waiting_payment (that's covered by payment_due at auction close),
 * so there's no overlap with the closer's events.
 */
exports.onOrderStatusChanged = functions.firestore
  .document('orders/{orderId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data() || {};
    const after = change.after.data() || {};
    if (before.status === after.status) return null; // no status change
    const NOTIFY = {
      preparing_shipment: 'order_preparing',
      // Wave 3 — reuses the EXISTING order_shipped event on purpose. The n8n
      // workflow (v2, live) has a fixed 20-event contract that notify.js's
      // CHANNEL_POLICY mirrors; a new key here would emit an event n8n does not
      // route, and the buyer would silently get nothing. "Out for delivery" is
      // already what order_shipped means to a buyer.
      out_for_delivery: 'order_shipped',
      shipped: 'order_shipped',
      delivered: 'order_delivered',
      completed: 'order_completed',
      refunded: 'order_refunded',
    };
    const event = NOTIFY[after.status];
    if (!event) return null;
    await notify({ uid: after.buyerId, event, data: {
      name: after.buyerName || 'Buyer',
      orderId: context.params.orderId, auctionId: after.auctionId || '',
      auctionTitle: after.auctionTitle || '', amount: after.winningBidAmount || 0,
      status: after.status, trackingNumber: after.trackingNumber || '',
      orderRef: after.orderRef || '',
      totalDue: after.totalDue || after.winningBidAmount || 0,
      paymentDeadlineAt: after.paymentDeadlineAt || null,
      idempotencyKey: `${context.params.orderId}_${after.status}`,
    } });
    return null;
  });

/**
 * onListingApproved
 *
 * Listing an item creates a seller account — but only once the admin team has
 * approved the lot. Approval is their judgement gate, so it is the moment the
 * grant is earned; granting at create time would hand an account to anyone who
 * submitted anything.
 *
 * A TRIGGER rather than a call inside approveListing on purpose: approval is a
 * client-side admin `updateDoc` on the auction (AppContext approveListing), and
 * more than one admin surface performs it. Hooking the write itself means every
 * present and future approval path is covered, and `isSeller` stays grantable
 * only by the Admin SDK.
 *
 * NEVER throws. A failure to activate must not surface as a failed approval —
 * the lot is already live by the time this runs, and the user can still
 * self-activate from the wallet.
 */
exports.onListingApproved = functions.firestore
  .document('auctions/{auctionId}')
  .onUpdate(async (change, context) => {
    try {
      const before = change.before.data() || {};
      const after = change.after.data() || {};

      // Cheap pre-check so the common case (any edit to an already-live lot,
      // including every bid) costs no user-doc read.
      const preliminary = shouldActivateSellerOnApproval(before, after, { isAdmin: false });
      if (!preliminary.activate && preliminary.reason === 'not_an_approval_transition') return null;
      if (!preliminary.activate && ['sold_by_mazad', 'no_creator'].includes(preliminary.reason)) {
        console.log(`[onListingApproved] ${context.params.auctionId} skipped: ${preliminary.reason}`);
        return null;
      }

      const uid = after.createdById;
      const creatorSnap = await db.collection('users').doc(uid).get();
      const creator = creatorSnap.exists ? creatorSnap.data() : null;

      const decision = shouldActivateSellerOnApproval(before, after, creator);
      if (!decision.activate) {
        console.log(`[onListingApproved] ${context.params.auctionId} skipped: ${decision.reason}`);
        return null;
      }

      const result = await activateSellerTxn(
        { db, Timestamp: admin.firestore.Timestamp, now: () => Date.now(), lang: 'ar' },
        { uid: decision.uid },
      );
      console.log(`[onListingApproved] activated seller ${decision.uid} via ${context.params.auctionId}: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error('[onListingApproved] failed (non-fatal):', err && err.message);
    }
    return null;
  });

/**
 * onUserBlockChanged
 * Single choke point for ban apply/lift notifications. Fires on ANY isBlocked
 * transition on users/{userId} regardless of writer — the paymentDefaultEnforcer
 * (strike ladder + auto-expiry) AND client-side admin ban/unban (AppContext
 * writes isBlocked via updateDoc) both flow through here, so there is exactly
 * one notify per transition and no double-fire. Never throws.
 */
exports.onUserBlockChanged = functions.firestore
  .document('users/{userId}')
  .onUpdate(async (change, context) => {
    try {
      const before = change.before.data() || {};
      const after = change.after.data() || {};
      const wasBlocked = before.isBlocked === true;
      const nowBlocked = after.isBlocked === true;
      if (!wasBlocked && nowBlocked) {
        const until = after.blockedUntil && typeof after.blockedUntil.toMillis === 'function'
          ? after.blockedUntil.toMillis() : null;
        await notify({
          uid: context.params.userId,
          event: 'account_banned',
          data: {
            reason: after.blockedReason || 'admin',
            blockedUntil: until,
            idempotencyKey: `${context.params.userId}_banned_${until || 'perm'}`,
          },
        });
      } else if (wasBlocked && !nowBlocked) {
        await notify({
          uid: context.params.userId,
          event: 'ban_lifted',
          data: { idempotencyKey: `${context.params.userId}_lifted_${(before.blockedUntil && before.blockedUntil.toMillis && before.blockedUntil.toMillis()) || 'x'}` },
        });
      }
    } catch (e) {
      console.warn('[onUserBlockChanged]', e && e.message);
    }
    return null;
  });

/**
 * Shared bid helpers — extracted from placeBid so simulateBid applies the
 * EXACT same end-time resolution, min-next-bid pricing, and anti-snipe rules.
 */

// Resolve an auction's end time to epoch ms, prioritizing endsAt Timestamp
// over the legacy endTime field (extracted from placeBid).
function resolveAuctionEndMs(auctionData) {
  let endTime = auctionData.endsAt || auctionData.endTime;
  if (typeof endTime === 'object' && endTime.seconds) {
    endTime = endTime.seconds * 1000;
  } else if (typeof endTime === 'string') {
    endTime = Date.parse(endTime);
  }
  return endTime;
}

// Min-next-bid rule (extracted from placeBid): the FIRST bid may equal the
// asking price; every later bid must clear currentPrice + minIncrement.
// All math in integer fils to avoid float loss.
function bidPricing(auctionData) {
  const currentPriceFils = Math.round((auctionData.currentPrice || auctionData.startingPrice || 0) * 1000);
  const minIncrementFils = Math.round((auctionData.minIncrement || 10) * 1000);
  const totalBids = auctionData.totalBids || 0;
  const minRequiredFils = totalBids > 0 ? (currentPriceFils + minIncrementFils) : currentPriceFils;
  return { currentPriceFils, minIncrementFils, totalBids, minRequiredFils };
}

// Buffered transaction writes for ONE accepted bid (extracted from placeBid):
// bid doc under auctions/{id}/bids + auction pricing fields + anti-snipe
// extension (+15s when 0 < timeRemaining < 10s). Caller has already validated
// auction state and bid amount. bid.isSimulated adds the flag to the bid doc
// ONLY when true — real bids keep the exact same shape as before.
function applyBidWrites(transaction, auctionRef, auctionData, bid) {
  const totalBids = auctionData.totalBids || 0;

  const bidRef = auctionRef.collection('bids').doc();
  const bidDoc = {
    id: bidRef.id,
    auctionId: auctionRef.id,
    amount: bid.amountJod,
    amountFils: bid.amountFils,
    bidderId: bid.bidderId,
    bidderName: bid.bidderName,
    bidderAvatar: bid.bidderAvatar || '',
    timestamp: Date.now()
  };
  if (bid.isSimulated) {
    bidDoc.isSimulated = true;
  }
  transaction.set(bidRef, bidDoc);

  // End time after this bid. 'first_bid' listings start their clock on the FIRST
  // bid (now + duration); every other bid applies the anti-snipe soft close.
  const nowMs = Date.now();
  const finalEndTime = computeBidEndTime(auctionData, totalBids, bid.endTimeMs, nowMs);

  transaction.update(auctionRef, {
    currentPrice: bid.amountJod,
    currentPriceFils: bid.amountFils,
    currentBidderId: bid.bidderId,
    currentBidderName: bid.bidderName,
    totalBids: totalBids + 1,
    endTime: finalEndTime,
    endsAt: admin.firestore.Timestamp.fromMillis(finalEndTime),
    previousBidderId: auctionData.currentBidderId || null
  });

  return { finalEndTime, bidId: bidRef.id };
}

/**
 * 3. placeBid Callable Cloud Function
 * Handles the high-frequency and critical bidding business rules transactionally in a single Firestore runTransaction block.
 * Ensures subscription checking, blocking, pricing thresholds, sniper extensions, wallet deductively atomic locking,
 * and outbid user refunding are guaranteed without race-conditions or browser-side vulnerability bypasses.
 * Balances and calculations are implemented in integer FILS to prevent float decimals loss.
 */
/**
 * getServerTime (CORR1) — echoes the SERVER's own clock so the client can derive
 * a latency-compensated client↔server offset (src/utils/serverTime.ts). No auth,
 * no inputs, no side effects: it is a read-only clock probe. Because the value
 * comes from the server's own Date.now() and uses NO client-supplied data, a
 * client cannot game it to shift the offset — and even if it tampers with its
 * own local timestamps in the offset math, that only skews its own UI clock; the
 * placeBid transaction below re-checks endTime with the real server clock, so no
 * client can bid or settle past the true auction close.
 */
exports.getServerTime = functions.runWith({ cors: true }).https.onCall(async () => {
  return { now: Date.now() };
});

// PF3: keep one instance warm so the first bid of a drop doesn't eat a 2-5s
// cold start at the open stampede; cap parallelism (bid contention is on the
// single auction doc anyway — tune maxInstances after the load test).
//
// Load-tested 2026-07-24 (docs/PERFORMANCE.md): maxInstances:20 caused real
// platform-level HTTP 500s (not app errors — placeBid's own execution logs
// showed zero internal failures) starting at ~500 concurrent bidders.
// Confirmed via direct A/B on a throwaway project: 0 errors at
// maxInstances:500 under the same load, clean up to 2,000 concurrent
// bidders. Raised accordingly — this only bounds a burst ceiling and costs
// nothing at idle; minInstances:1 (unchanged) is the only always-billed part.
exports.placeBid = functions.runWith({ cors: true, minInstances: 1, maxInstances: 500 }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated.');
  }
  const userId = context.auth.uid;
  const { auctionId, amount } = data; // amount is in JOD (double)

  if (!auctionId || typeof amount !== 'number' || amount <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid auctionId or amount.');
  }

  try {
    const txnResult = await db.runTransaction(async (transaction) => {
      // 1. Get user profile
      const userRef = db.collection('users').doc(userId);
      const userSnap = await transaction.get(userRef);
      if (!userSnap.exists) {
        return { success: false, message: 'User profile not found.' };
      }
      const userData = userSnap.data();

      // Server-side per-USER bidding rate limit (./bidRateLimit). Subsumes the
      // old inline 1.5s check — that rule survives as `minBidIntervalMs`, now
      // alongside an hourly cap, a daily cap and a cooldown, all configurable.
      //
      // Evaluated INSIDE this transaction against the user doc read above, so:
      // no extra read, concurrent bids serialize on users/{uid} rather than all
      // reading the same pre-increment count, and no amount of client-side
      // tampering (page refresh, sign-out/in, a different auctionId, an edited
      // request payload) touches the counters — they are keyed on the verified
      // context.auth.uid and stored server-side.
      const now = Date.now();
      const rateVerdict = evaluateBidRateLimit(
        readBidRateLimitState(userData),
        now,
        bidRateLimitConfig(),
      );
      if (!rateVerdict.allowed) {
        if (rateVerdict.persist) {
          // The cooldown that was just opened must be recorded, so it applies
          // to the NEXT attempt too. This is the only write on a rejected bid.
          transaction.update(userRef, { bidRateLimit: rateVerdict.nextState });
        }
        // Client-safe: a code and a retry hint. No limit, no count, no config.
        return {
          success: false,
          code: rateVerdict.code,
          retryAfterMs: rateVerdict.retryAfterMs,
          message: rateVerdict.code === 'BIDDING_RATE_LIMITED'
            ? 'BIDDING_RATE_LIMITED'
            : 'يرجى الانتظار لحظة قبل المزايدة مرة أخرى',
        };
      }

      if (isEffectivelyBlocked(userData, Date.now())) {
        return { success: false, message: 'Account restricted. Bidding disabled.' };
      }
      // THE MEMBERSHIP GATE, from ./subscriptionExpiry — the same predicate the
      // hourly expiry sweep uses to decide what to write, and mirrored a third
      // time in src/utils/membership.ts for the UI. It used to live here as its
      // own inline copy of the arithmetic, which is how the UI came to promise
      // access this check refused. subscriptionExpiry.test.js binds the copies
      // together so they cannot drift again.
      //
      // Still fails closed on a missing or unreadable expiry, and still handles
      // a Timestamp, an epoch number and a legacy DATE STRING — the string case
      // once fell through to null and let a lapsed member keep bidding.
      if (!isActiveMemberServer(userData, Date.now())) {
        return { success: false, message: 'MEMBERSHIP_REQUIRED' };
      }

      // 2. Get auction item
      const auctionRef = db.collection('auctions').doc(auctionId);
      const auctionSnap = await transaction.get(auctionRef);
      if (!auctionSnap.exists) {
        return { success: false, message: 'Auction listing not found.' };
      }
      const auctionData = auctionSnap.data();

      // COUNT THE ATTEMPT, not the success. Written here — after the LAST read
      // in this transaction, before the first validation that can return — so
      // that a bidder who spams bids the server rejects (below minimum, wrong
      // status, ended) still burns quota. Counting only successful bids left the
      // whole limiter bypassable by sending deliberately invalid amounts: those
      // paths returned before any write, so no counter ever moved and
      // `lastBidAtMs` never advanced, which disarmed the burst guard too.
      transaction.update(userRef, {
        lastBidAt: now,
        bidRateLimit: rateVerdict.nextState,
      });

      if (auctionData.status !== 'live' && auctionData.status !== 'active') {
        return { success: false, message: 'This auction is not accepting bids.' };
      }

      // Idempotency: Prevent rapid double-click bid of the exact same amount on the same auction by same user
      const amountFils = Math.round(amount * 1000);
      const { currentPriceFils, minRequiredFils } = bidPricing(auctionData);
      if (auctionData.currentBidderId === userId && currentPriceFils === amountFils) {
        return { success: false, message: 'لقد قمت بتقديم هذا العرض بالفعل.' };
      }

      // Determine end time, prioritizing endsAt Timestamp over old endTime
      const endTime = resolveAuctionEndMs(auctionData);
      if (endTime && endTime <= Date.now()) {
        return { success: false, message: 'This auction has already ended.' };
      }

      if (amountFils < minRequiredFils) {
        return { success: false, message: `Minimum bid of ${(minRequiredFils / 1000).toLocaleString()} JOD required.` };
      }

      // 7. + 10. Write new bid document and update the auction details
      // (anti-sniping and pricing) via the shared helper.
      const { finalEndTime } = applyBidWrites(transaction, auctionRef, auctionData, {
        amountJod: amount,
        amountFils: amountFils,
        bidderId: userId,
        // PUBLIC write: applyBidWrites stamps this onto the world-readable
        // auction doc (currentBidderName) AND the public bid-history doc.
        // Must be masked — the real name never touches public Firestore.
        bidderName: maskBidderName(userData.name || 'User'),
        bidderAvatar: userData.avatar || '',
        endTimeMs: endTime
      });

      // 11. The system chat "winning bid" indicator is a SIDE EFFECT — it does
      // not need transactional consistency with the money-state. It is written
      // AFTER the txn commits (below) to shrink the lock window on the hot
      // auction doc. We only pass the payload out here.
      return {
        success: true,
        message: `Successfully bid ${amount} JOD! You are currently the highest bidder.`,
        amount,
        finalEndTime,
        _chat: {
          auctionId,
          userId,
          // PUBLIC write: this flows into the chats collection (allow read: if
          // isSignedIn()), so the seller can read it. Must be masked to stay
          // consistent with the masked public bid history — the real name never
          // touches the world-readable bid indicator.
          userName: maskBidderName(userData.name || 'User'),
          userAvatar: userData.avatar || '',
          amount
        }
      };
    });

    // POST-COMMIT side effect: system chat bid indicator. The bid has ALREADY
    // committed at this point — a chat write failure must NEVER fail the bid,
    // so it is logged and swallowed. Awaited (not fire-and-forget) so the write
    // is guaranteed to run before the function freezes, but it happens OUTSIDE
    // the transaction, so the auction-doc lock is already released.
    if (txnResult && txnResult.success && txnResult._chat) {
      const c = txnResult._chat;
      try {
        const chatRef = db.collection('chats').doc();
        await chatRef.set({
          id: chatRef.id,
          auctionId: c.auctionId,
          userId: c.userId,
          userName: c.userName,
          userAvatar: c.userAvatar,
          text: `placed a winning bid of ${c.amount.toLocaleString()} JOD`,
          timestamp: Date.now(),
          isSystem: false,
          isBid: true,
          bidAmount: c.amount
        });
      } catch (chatErr) {
        console.warn('[placeBid] post-commit chat write failed (bid already committed, ignoring):', chatErr && chatErr.message);
      }
      // Strip the internal side-effect payload from the client response so the
      // response shape stays byte-identical to before.
      const { _chat, ...clientResult } = txnResult;
      return clientResult;
    }

    return txnResult;
  } catch (error) {
    console.error('Error during transaction:', error);
    // Transaction contention / deadline / unavailable is a RETRIABLE infra
    // condition on the hot auction doc — NOT a real bid rejection. Genuine
    // validation errors never reach here (they return {success:false} inside
    // the txn). Surface a distinct, retriable 'aborted' code so the client can
    // offer a friendly "try again" instead of a scary generic 'internal'.
    const code = error && (error.code !== undefined ? error.code : error.status);
    const msg = (error && error.message) || '';
    const isContention =
      code === 10 || code === 4 || code === 14 || // gRPC ABORTED / DEADLINE_EXCEEDED / UNAVAILABLE
      code === 'aborted' || code === 'deadline-exceeded' || code === 'unavailable' ||
      code === 'ABORTED' || code === 'DEADLINE_EXCEEDED' || code === 'UNAVAILABLE' ||
      /aborted|deadline exceeded|too much contention|contention|unavailable/i.test(msg);
    if (isContention) {
      throw new functions.https.HttpsError('aborted', 'PRICE_MOVED_RETRY');
    }
    throw new functions.https.HttpsError('internal', msg || 'Transaction failed.');
  }
});

/**
 * 4. releaseEscrow Callable Cloud Function
 * Admin approved release of locked escrow funds. Adds balance to user wallet if it represents cliq fast topup.
 */
exports.releaseEscrow = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated.');
  }
  const handlerUserId = context.auth.uid;
  const { escrowId } = data;

  if (!escrowId) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid escrowId.');
  }

  try {
    return await db.runTransaction(async (transaction) => {
      // Verify user role
      const handlerUserRef = db.collection('users').doc(handlerUserId);
      const handlerSnap = await transaction.get(handlerUserRef);
      if (!handlerSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'Authenticated user not found.');
      }
      const handlerData = handlerSnap.data();
      if (!callerIsAdmin(handlerData)) {
        throw new functions.https.HttpsError('permission-denied', 'Unauthorized. Administrators only.');
      }

      const escrowRef = db.collection('escrows').doc(escrowId);
      const escrowSnap = await transaction.get(escrowRef);
      if (!escrowSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'Escrow transaction not found.');
      }
      const escrowData = escrowSnap.data();
      if (escrowData.status !== 'locked') {
        throw new functions.https.HttpsError('failed-precondition', 'Escrow is not locked.');
      }

      // Read bidder wallet BEFORE writing to escrow, if it is a CliQ Top-up
      let bidderWalletSnap = null;
      const bidderWalletRef = db.collection('wallets').doc(escrowData.bidderId);
      if (escrowData.auctionId === 'cliq-dep') {
        bidderWalletSnap = await transaction.get(bidderWalletRef);
      }

      // Mark escrow as released
      transaction.update(escrowRef, { status: 'released' });

      // If it was a CliQ Top-Up transfer approval, add balance to wallet!
      if (escrowData.auctionId === 'cliq-dep') {
        const addedFils = escrowData.amountFils || Math.round((escrowData.amount || 0) * 1000);

        if (bidderWalletSnap && bidderWalletSnap.exists) {
          const wData = bidderWalletSnap.data();
          const oldAvail = wData.availableBalance || 0;
          const oldEscrow = wData.escrowBalance || 0;
          const newAvail = oldAvail + addedFils;

          transaction.set(bidderWalletRef, {
            userId: escrowData.bidderId,
            availableBalance: newAvail,
            escrowBalance: oldEscrow,
            totalBalance: newAvail + oldEscrow
          }, { merge: true });
        } else {
          transaction.set(bidderWalletRef, {
            userId: escrowData.bidderId,
            availableBalance: addedFils,
            escrowBalance: 0,
            totalBalance: addedFils
          });
        }
      }

      // Log admin action
      const actionRef = db.collection('adminActions').doc();
      transaction.set(actionRef, {
        id: actionRef.id,
        actionType: 'release_escrow',
        targetId: escrowId,
        targetName: `Escrow: ${escrowData.auctionTitle || 'Auction Item'}`,
        adminName: handlerData.name || 'Admin',
        timestamp: Date.now(),
        details: 'Admin reviewed and approved release.'
      });

      return { success: true, message: 'Escrow released successfully.' };
    });
  } catch (error) {
    console.error('Error in releaseEscrow:', error);
    throw new functions.https.HttpsError('internal', error.message || 'Operation failed.');
  }
});

/**
 * 5. refundEscrow Callable Cloud Function
 * Refund locked escrow funds back to bidder’s available balance & subtract from escrow.
 */
exports.refundEscrow = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated.');
  }
  const handlerUserId = context.auth.uid;
  const { escrowId } = data;

  if (!escrowId) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid escrowId.');
  }

  try {
    return await db.runTransaction(async (transaction) => {
      // Verify user role
      const handlerUserRef = db.collection('users').doc(handlerUserId);
      const handlerSnap = await transaction.get(handlerUserRef);
      if (!handlerSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'Authenticated user not found.');
      }
      const handlerData = handlerSnap.data();
      if (!callerIsAdmin(handlerData)) {
        throw new functions.https.HttpsError('permission-denied', 'Unauthorized. Administrators only.');
      }

      const escrowRef = db.collection('escrows').doc(escrowId);
      const escrowSnap = await transaction.get(escrowRef);
      if (!escrowSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'Escrow transaction not found.');
      }
      const escrowData = escrowSnap.data();
      if (escrowData.status !== 'locked') {
        throw new functions.https.HttpsError('failed-precondition', 'Escrow is not locked.');
      }

      // Read bidder wallet BEFORE writing to escrow, if not a cliq-dep
      let bidderWalletSnap = null;
      const bidderWalletRef = db.collection('wallets').doc(escrowData.bidderId);
      if (escrowData.auctionId !== 'cliq-dep') {
        bidderWalletSnap = await transaction.get(bidderWalletRef);
      }

      // Mark escrow as refunded
      transaction.update(escrowRef, { status: 'refunded' });

      // Return escrow funds back to bidder’s wallet (availableBalance increase, escrowBalance decrease)
      if (escrowData.auctionId !== 'cliq-dep') {
        const refundAmtFils = escrowData.amountFils || Math.round((escrowData.amount || 0) * 1000);

        if (bidderWalletSnap && bidderWalletSnap.exists) {
          const wData = bidderWalletSnap.data();
          const oldAvail = wData.availableBalance || 0;
          const oldEscrow = wData.escrowBalance || 0;

          // Guard that releaseOrderEscrow and refundOrderEscrow both already
        // have. Without it a legacy doc that is `locked` against a zeroed
        // escrowBalance MINTS money into availableBalance, which
        // requestWithdrawal will pay out in cash. This fix widens the set of
        // escrows that reach here, so the gap had to close with it.
        if (oldEscrow < refundAmtFils) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            `رصيد الضمان غير كافٍ للمزايد ${escrowData.bidderId} — تعذر الاسترداد الآمن`
          );
        }
        const newEscrow = Math.max(0, oldEscrow - refundAmtFils);
          const newAvail = oldAvail + refundAmtFils;

          transaction.set(bidderWalletRef, {
            userId: escrowData.bidderId,
            availableBalance: newAvail,
            escrowBalance: newEscrow,
            totalBalance: newAvail + newEscrow
          }, { merge: true });
        } else {
          // No wallet doc yet (mirrors releaseEscrow's else branch above):
          // without this the escrow still flips to 'refunded' below and the
          // money is gone for good — nothing ever creates the doc, so no
          // later write would ever restore it.
          transaction.set(bidderWalletRef, {
            userId: escrowData.bidderId,
            availableBalance: refundAmtFils,
            escrowBalance: 0,
            totalBalance: refundAmtFils
          });
        }
      }

      // Log admin action
      const actionRef = db.collection('adminActions').doc();
      transaction.set(actionRef, {
        id: actionRef.id,
        actionType: 'refund_escrow',
        targetId: escrowId,
        targetName: `Refund: ${escrowData.auctionTitle || 'Auction Item'}`,
        adminName: handlerData.name || 'Admin',
        timestamp: Date.now(),
        details: 'Admin reviewed and approved refund.'
      });

      return { success: true, message: 'Escrow refunded successfully.' };
    });
  } catch (error) {
    console.error('Error in refundEscrow:', error);
    throw new functions.https.HttpsError('internal', error.message || 'Operation failed.');
  }
});

/**
 * 6. requestTopUp Callable Cloud Function
 * Enrolls a manual Top-Up request as a locked CliQ escrow transfer record on the database safely.
 */
exports.requestTopUp = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated.');
  }
  const userId = context.auth.uid;
  const { amount, alias, paymentProofUrl, escrowId: passedEscrowId } = data; // amount is in JOD (double)

  if (typeof amount !== 'number' || amount <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid top-up amount.');
  }

  try {
    const userSnap = await db.collection('users').doc(userId).get();
    if (!userSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'User profile not found.');
    }
    const userData = userSnap.data();

    const escrowId = passedEscrowId || `cliq-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const amountFils = Math.round(amount * 1000);

    const newCliQTransaction = {
      id: escrowId,
      walletId: 'wallet-current',
      auctionId: 'cliq-dep',
      auctionTitle: 'CliQ Fast Top-up request',
      bidderId: userId,
      bidderName: userData.name || 'User',
      sellerId: 'system',
      sellerName: 'Central Reserve Bank',
      amount: amount,
      amountFils: amountFils,
      status: 'locked',
      timestamp: Date.now(),
      paymentProofUrl: paymentProofUrl || '',
      receiptUrl: paymentProofUrl || '',
      paymentProofImage: paymentProofUrl || '',
      cliqAlias: alias || ''
    };

    await db.collection('escrows').doc(escrowId).set(newCliQTransaction);

    return { success: true, escrowId, message: 'Top-up request registered successfully.' };
  } catch (error) {
    console.error('Error in requestTopUp:', error);
    throw new functions.https.HttpsError('internal', error.message || 'Operation failed.');
  }
});

/**
 * 7. requestSubscription Callable Cloud Function
 * Enrolls a premium/pro subscription request safely on the server side 
 * and marks the user's subscriptionStatus as 'pending'.
 */
exports.requestSubscription = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated.');
  }

  const userId = context.auth.uid;
  const { price, paymentProofUrl, paymentProofImage, transferFullName, transferPhone } = data;

  // Wave 1 S3 — the PRICE is the anchor. Derive the canonical tier + duration
  // from the amount (the admin verifies the CliQ proof against it); NEVER trust
  // the client's plan label, and reject any amount not in the tier table.
  // (The old `price || 15` / `plan || 'monthly'` fallbacks were latent mis-grants.)
  const resolved = resolveTierByPrice(price);
  if (!resolved) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      `Invalid subscription price: ${JSON.stringify(price)}. Offered amounts are 1, 4 or 7 JD.`
    );
  }

  try {
    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'User profile not found.');
    }

    const userData = userSnap.data();
    const reqId = `sub-req-${Date.now()}-${userId}`;
    const proofUrl = paymentProofUrl || paymentProofImage || '';

    const newRequest = {
      id: reqId,
      userId: userId,
      userName: userData.name || 'User',
      userEmail: userData.email || '',
      // Server-derived canonical values (approveSubscription re-derives anyway).
      plan: resolved.tier,
      tier: resolved.tier,
      durationDays: resolved.durationDays,
      price: price,
      paymentProofUrl: proofUrl,
      paymentProofImage: proofUrl,
      transferFullName: transferFullName || '',
      transferPhone: transferPhone || '',
      status: 'pending',
      subscriptionStatus: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const batch = db.batch();

    // 1. Create the subscription request document inside subscriptionRequests
    const reqRef = db.collection('subscriptionRequests').doc(reqId);
    batch.set(reqRef, newRequest);

    // 2. Set user status on the user doc. An already-active member upgrading
    // stays 'active' (bidding is gated on it) — only non-active users flip to
    // pending. The REQUEST doc is always 'pending' (needs review) regardless.
    batch.set(userRef, {
      subscriptionStatus: userStatusForSubscriptionRequest(userData.subscriptionStatus),
      subscriptionPlan: resolved.tier,
      paymentProofUrl: proofUrl,
      paymentProofImage: proofUrl,
      transferFullName: transferFullName || '',
      transferPhone: transferPhone || ''
    }, { merge: true });

    await batch.commit();

    return { success: true, reqId, message: 'Subscription request registered successfully.' };

  } catch (error) {
    console.error('Error in requestSubscription:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    throw new functions.https.HttpsError('internal', error.message || 'Operation failed.');
  }
});

/**
 * 7b. approveSubscription Callable Cloud Function (Wave 1 S3)
 * Admin-only. The SOLE writer of the users/{uid} subscription-grant fields
 * (Firestore rules block all client writes to them, including the admin
 * client). Recomputes the grant duration server-side from the request's
 * verified amount / canonical tier — never from a client plan label.
 * Idempotent: re-approving an approved request is a no-op.
 *
 * Input: { reqId } (approve a subscriptionRequests doc)
 *     or { userId, tier? } (direct comped grant — the admin "activate user
 *        directly" flow; tier defaults to 'monthly', offered tiers only).
 */
const SUBSCRIPTION_ERROR_CODES = ['invalid-argument', 'not-found', 'failed-precondition'];

exports.approveSubscription = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  // Warm ping from `warmAdminCallables`, ABOVE the auth check by design: below
  // it, it throws `unauthenticated` ~1,700x/day, burying real auth failures.
  // Reachable unauthenticated — accepted risk, see warmTargets.js header.
  if (data && data.__warm === true) return { warm: true };
  await assertAdmin(context);
  const { reqId, userId, tier } = data || {};

  try {
    const deps = { db, Timestamp: admin.firestore.Timestamp };
    let result;
    if (reqId) {
      result = await approveSubscriptionRequest(deps, reqId);
    } else if (userId) {
      result = await grantSubscriptionDirect(deps, { userId, ...(tier ? { tier } : {}) });
    } else {
      throw new functions.https.HttpsError('invalid-argument', 'Either reqId or userId is required.');
    }

    if (result.alreadyApproved) {
      return { success: true, alreadyApproved: true, message: 'Request was already approved — no changes made.' };
    }

    // Log the conversion server-side (mirrors the old client analytics event).
    await db.collection('analytics_events').add({
      eventType: 'subscription_conversion',
      userId: result.userId,
      userEmail: result.userEmail || null,
      timestamp: Date.now(),
      metadata: {
        plan: result.tier,
        durationDays: result.durationDays,
        price: typeof result.price === 'number' ? result.price : 0,
        reqId: reqId || null,
        direct: !reqId,
        approvedBy: context.auth.uid,
      },
    }).catch((e) => console.warn('[approveSubscription] analytics log failed:', e && e.message));

    console.log(`[approveSubscription] Granted ${result.tier}/${result.durationDays}d to ${result.userId} (by ${context.auth.uid}, reqId=${reqId || 'direct'})`);
    return {
      success: true,
      alreadyApproved: false,
      userId: result.userId,
      tier: result.tier,
      durationDays: result.durationDays,
      expiryMs: result.expiryMs,
    };
  } catch (error) {
    console.error('Error in approveSubscription:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    const code = SUBSCRIPTION_ERROR_CODES.includes(error.code) ? error.code : 'internal';
    throw new functions.https.HttpsError(code, error.message || 'Operation failed.');
  }
});

/**
 * 7c. rejectSubscription Callable Cloud Function (Wave 1 S3)
 * Admin-only counterpart of approveSubscription — needed because the rules
 * now block ALL client writes to the user subscription fields, including the
 * admin client's old reject/downgrade updateDoc.
 * Input: { reqId } (reject a request; downgrades the user only if still
 * 'pending' — never wipes an active membership) or { userId } (direct reject).
 */
exports.rejectSubscription = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  // Warm ping from `warmAdminCallables`, ABOVE the auth check by design: below
  // it, it throws `unauthenticated` ~1,700x/day, burying real auth failures.
  // Reachable unauthenticated — accepted risk, see warmTargets.js header.
  if (data && data.__warm === true) return { warm: true };
  await assertAdmin(context);
  const { reqId, userId, reason } = data || {};

  try {
    const deps = { db, Timestamp: admin.firestore.Timestamp };
    const result = await rejectSubscriptionRequest(deps, { reqId, userId, reason });
    console.log(`[rejectSubscription] Rejected (reqId=${result.reqId || 'direct'}, userId=${result.userId}, downgraded=${result.userDowngraded}) by ${context.auth.uid}`);
    // Only notify on a real reviewed request rejection (reqId). A bare
    // direct-downgrade admin action returns reqId: null and must stay silent —
    // it predates this slice and was never meant to trigger a rejection message.
    if (result.reqId) {
      await notify({ uid: result.userId, event: 'membership_rejected', data: {
        reason: result.reason || '',
        reqId: result.reqId || null,
        idempotencyKey: `membership_rejected_${result.reqId || result.userId}`,
      } });
    }
    return { success: true, ...result };
  } catch (error) {
    console.error('Error in rejectSubscription:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    const code = SUBSCRIPTION_ERROR_CODES.includes(error.code) ? error.code : 'internal';
    throw new functions.https.HttpsError(code, error.message || 'Operation failed.');
  }
});

/**
 * submitOrderPayment — Slice A (Submit). The BUYER self-claims a CliQ payment
 * on their own order (proof URL + CliQ sender phone + txn ref + delivery info).
 * State machine + ownership + idempotency live in orderPaymentSubmit.js
 * (unit-tested); this wrapper is auth-gating only. Ownership is enforced inside
 * the transaction via buyerUid — no assertAdmin here.
 */
exports.submitOrderPayment = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'You must be signed in to submit a payment.');
  }
  try {
    const deps = { db, Timestamp: admin.firestore.Timestamp, now: () => Date.now() };
    const result = await submitOrderPaymentTxn(deps, {
      orderId: data.orderId,
      buyerUid: context.auth.uid,
      proofUrl: data.proofUrl,
      cliqSenderPhone: data.cliqSenderPhone,
      txnRef: data.txnRef,
      deliveryAddress: data.deliveryAddress,
      deliveryPhone: data.deliveryPhone,
    });
    console.log(`[submitOrderPayment] submitted order=${data.orderId} by ${context.auth.uid}`);
    return { success: true, ...result };
  } catch (error) {
    console.error('Error in submitOrderPayment:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    const code = ['not-found', 'permission-denied', 'failed-precondition', 'resource-exhausted', 'invalid-argument', 'already-exists'].includes(error.code) ? error.code : 'internal';
    throw new functions.https.HttpsError(code, error.message || 'Operation failed.');
  }
});

/**
 * grantAdminRole / revokeAdminRole — administrative access as a ROLE.
 *
 * These replaced the hardcoded identity that used to grant admin in Cloud
 * Functions, firestore.rules, storage.rules and the client. There is now ONE
 * store: users/{uid}.role. storage.rules reads that same document through
 * firestore.get(); no custom claim is written, and functions/adminRoles.js
 * records why a claim was rejected (a second store that can disagree with the
 * first, and one that keeps a revoked admin signed in until their token
 * refreshes — up to an hour).
 *
 * ADMIN-GATED, WHICH IS ALSO WHY THE FIRST ADMIN NEEDS A SCRIPT. Only an
 * existing administrator can grant one, so the first cannot come through here
 * — see scripts/admin/grant-admin.cjs, which authenticates with a
 * service-account key and depends on no application role at all.
 *
 * The acting admin's uid and email are taken from the verified token, never
 * from the request payload, so the audit trail records who actually called.
 */
exports.grantAdminRole = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  const actorUid = await assertAdmin(context);
  try {
    const result = await grantAdminCore(
      { db, auth: admin.auth(), Timestamp: admin.firestore.Timestamp, now: () => Date.now() },
      {
        email: data && data.email,
        actorUid,
        actorEmail: (context.auth.token && context.auth.token.email) || null,
      }
    );
    console.log(`[grantAdminRole] ${result.email} granted by ${actorUid}`);
    return { success: true, ...result };
  } catch (error) {
    console.error('Error in grantAdminRole:', error.code || error.message);
    if (error instanceof functions.https.HttpsError) throw error;
    const code = ['not-found', 'invalid-argument', 'unauthenticated', 'failed-precondition'].includes(error.code) ? error.code : 'internal';
    throw new functions.https.HttpsError(code, error.message || 'Could not grant administrative access.');
  }
});

exports.revokeAdminRole = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  const actorUid = await assertAdmin(context);
  try {
    const result = await revokeAdminCore(
      { db, auth: admin.auth(), Timestamp: admin.firestore.Timestamp, now: () => Date.now() },
      {
        email: data && data.email,
        actorUid,
        actorEmail: (context.auth.token && context.auth.token.email) || null,
      }
    );
    console.log(`[revokeAdminRole] ${result.email} revoked by ${actorUid}`);
    return { success: true, ...result };
  } catch (error) {
    console.error('Error in revokeAdminRole:', error.code || error.message);
    if (error instanceof functions.https.HttpsError) throw error;
    const code = ['not-found', 'invalid-argument', 'unauthenticated', 'failed-precondition'].includes(error.code) ? error.code : 'internal';
    throw new functions.https.HttpsError(code, error.message || 'Could not revoke administrative access.');
  }
});

/**
 * createCliqPaymentRequest — embedded CliQ (Bank al Etihad / Staq).
 *
 * The buyer picks CliQ and gives their alias or mobile; this raises the request
 * against their bank. It does NOT mark anything paid — only applyCliqWebhook
 * can, and that is not reachable from a client.
 *
 * The 90-minute duplicate lock and the amount check live in cliqPayment.js,
 * inside the transaction, because a browser can be refreshed and a refresh must
 * not mint a second request. See cliqPayment.test.js.
 */
/**
 * STATIC OUTBOUND IP — required by Bank al Etihad's whitelist.
 *
 * Cloud Functions have no fixed egress address by default; outbound traffic
 * leaves from a large, shifting Google pool, so there is nothing a bank can
 * whitelist. Routing this function through a Serverless VPC connector whose
 * network has a Cloud NAT bound to a reserved address gives it one:
 *
 *   connector  mazzado-egress        (us-central1, READY)
 *   router     mazzado-router
 *   NAT        mazzado-nat  ->  mazzado-bae-egress  =  35.193.49.148
 *
 * ⚠️ ON THIS FUNCTION ONLY, and deliberately. `ALL_TRAFFIC` sends *everything*
 * this function emits through the NAT — Firestore included. That is fine here:
 * it runs once per payment. Putting it on a hot path like placeBid would bill
 * NAT on every bid and add a hop to a live auction. Do not copy this block
 * onto a high-frequency function.
 *
 * If the connector is ever deleted, deploys of this function FAIL rather than
 * silently falling back to dynamic egress — which is the safe direction: a
 * failed deploy is visible, a silently-changed source IP is not, and the bank
 * would simply start refusing our calls.
 */
const BAE_EGRESS = {
  vpcConnector: 'mazzado-egress',
  vpcConnectorEgressSettings: 'ALL_TRAFFIC',
};

/**
 * Report the address our outbound calls actually leave from. Admin only.
 *
 * Provisioning a NAT proves a reservation exists; it does not prove THIS
 * function uses it. Before giving a bank an IP to whitelist, that needs to be
 * observed rather than assumed — a wrong number here is discovered when a real
 * customer's payment fails.
 *
 * Carries the same egress config as the payment function above, so what it
 * reports is what that function would use.
 */
exports.checkEgressIp = functions.runWith({ cors: true, ...BAE_EGRESS }).https.onCall(async (data, context) => {
  await assertAdmin(context);
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    const body = await res.json();
    console.log('[checkEgressIp] outbound address:', body && body.ip);
    return { ip: (body && body.ip) || null };
  } catch (error) {
    console.error('Error in checkEgressIp:', error.message);
    throw new functions.https.HttpsError('internal', error.message || 'Could not determine the outbound address.');
  }
});

exports.createCliqPaymentRequest = functions.runWith({ cors: true, ...BAE_EGRESS }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول أولاً.');
  }
  // THE KILL SWITCH, SERVER SIDE. The UI hides the rail behind the same flag,
  // but a hidden button is not a disabled payment rail — this callable is
  // reachable directly. Fail CLOSED: an absent siteSettings/featureFlags doc,
  // an absent field, or a read failure all leave the gateway off, because the
  // harm of raising a request no bank receives (a buyer told their payment was
  // sent, then locked out for 90 minutes) is worse than the harm of refusing.
  let gatewayEnabled = false;
  try {
    const flagsSnap = await db.collection('siteSettings').doc('featureFlags').get();
    gatewayEnabled = flagsSnap.exists && flagsSnap.data().enableCliqGateway === true;
  } catch (flagErr) {
    console.error('[createCliqPaymentRequest] could not read featureFlags; failing closed:', flagErr.message);
  }
  if (!gatewayEnabled) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'الدفع عبر كليك غير متاح حالياً. استخدم التحويل اليدوي.'
    );
  }

  try {
    const deps = { db, Timestamp: admin.firestore.Timestamp, now: () => Date.now() };
    const result = await createCliqRequestTxn(deps, {
      orderId: data && data.orderId,
      buyerUid: context.auth.uid,
      identifierType: data && data.identifierType,
      identifier: data && data.identifier,
      expectedTotal: data && data.expectedTotal,
    });
    // NEVER log the identifier — it is the payer's banking handle.
    console.log(`[createCliqPaymentRequest] order=${data && data.orderId} by ${context.auth.uid} total=${result.total}`);
    return { success: true, ...result };
  } catch (error) {
    console.error('Error in createCliqPaymentRequest:', error.code || error.message);
    if (error instanceof functions.https.HttpsError) throw error;
    const code = ['not-found', 'permission-denied', 'failed-precondition', 'resource-exhausted', 'invalid-argument'].includes(error.code) ? error.code : 'internal';
    const err = new functions.https.HttpsError(code, error.message || 'Operation failed.', error.details);
    throw err;
  }
});

/**
 * cliqDemoAdvance — DEMO MODE ONLY, admin-gated.
 *
 * BAE evaluates a recorded walkthrough of the seven screens before production
 * keys exist, so the status screen needs a way to reach paid / rejected /
 * expired without a bank. This drives the SAME applyCliqWebhook the real
 * webhook will, so what BAE sees on the video is the real state machine and not
 * a mock of it.
 *
 * Admin-only on purpose: it is the one callable that can move an order to paid
 * without money arriving. It is also restricted to SIMULATED orders — an admin
 * mis-tapping this on a real buyer's order would mark a genuine sale paid for
 * free.
 *
 * TODO: BAE CliQ API — replace with the real webhook handler (verify the BAE
 * signature against CLIQ_WEBHOOK_SECRET, then call applyCliqWebhookTxn). Delete
 * this callable once production keys are live.
 */
exports.cliqDemoAdvance = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  const adminUid = await assertAdmin(context);
  const orderId = data && data.orderId;
  const outcome = data && data.outcome;
  try {
    const orderSnap = await db.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) {
      throw new functions.https.HttpsError('not-found', `Order ${orderId} not found.`);
    }
    if (orderSnap.data().isSimulated !== true) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Demo advance is restricted to simulated orders.'
      );
    }
    const deps = { db, Timestamp: admin.firestore.Timestamp, now: () => Date.now() };
    const result = await applyCliqWebhookTxn(deps, {
      orderId,
      requestId: data && data.requestId,
      outcome,
    });
    console.log(`[cliqDemoAdvance] order=${orderId} outcome=${outcome} by ${adminUid}`);
    return { success: true, ...result };
  } catch (error) {
    console.error('Error in cliqDemoAdvance:', error.code || error.message);
    if (error instanceof functions.https.HttpsError) throw error;
    const code = ['not-found', 'failed-precondition', 'invalid-argument'].includes(error.code) ? error.code : 'internal';
    throw new functions.https.HttpsError(code, error.message || 'Operation failed.');
  }
});

/**
 * revealCounterpartyContact — D5. Give one party to a PAID order the other
 * party's phone, so they can coordinate the handover themselves instead of
 * routing it through CS.
 *
 * Must be server-side: firestore.rules restricts `users` reads to the owner and
 * admins, so a buyer physically cannot look the seller up from the client. The
 * gate (party-only, payment-verified, not closed) lives in contactReveal.js and
 * is unit-tested; this wrapper reads the documents and maps errors.
 */
exports.revealCounterpartyContact = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول أولاً.');
  }
  const orderId = data && data.orderId;
  if (!orderId) {
    throw new functions.https.HttpsError('invalid-argument', 'معرّف الطلب مطلوب.');
  }
  try {
    const orderSnap = await db.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'الطلب غير موجود.');
    }
    const order = orderSnap.data() || {};

    // Read only the doc the caller could be entitled to, not both.
    const isBuyer = order.buyerId === context.auth.uid;
    const otherUid = isBuyer ? order.sellerId : order.buyerId;
    const otherSnap = otherUid ? await db.collection('users').doc(otherUid).get() : null;
    const other = otherSnap && otherSnap.exists ? otherSnap.data() : null;

    const contact = resolveCounterpartyContact(
      { order, buyer: isBuyer ? null : other, seller: isBuyer ? other : null },
      context.auth.uid,
    );

    console.log(`[revealCounterpartyContact] order=${orderId} to=${context.auth.uid} role=${contact.role}`);
    return { success: true, ...contact, waMe: waMeLink(contact.phone) };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Error in revealCounterpartyContact:', error);
    const code = ['not-found', 'permission-denied', 'failed-precondition', 'invalid-argument'].includes(error.code) ? error.code : 'internal';
    throw new functions.https.HttpsError(code, error.message || 'تعذر عرض بيانات التواصل.');
  }
});

/**
 * activateSeller — a signed-in user turns their own account into a seller
 * account. Self-service by design; the caller may only ever activate THEMSELVES
 * (the uid comes from the auth context, never from `data`), so there is no
 * admin gate and no way to promote someone else.
 *
 * Must be server-side: firestore.rules denylists `isSeller` for self-writes, so
 * the client physically cannot grant it. State + idempotency live in
 * sellerActivation.js (unit-tested); this wrapper is auth-gating only.
 */
exports.activateSeller = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول أولاً.');
  }
  try {
    const lang = (data && data.lang) === 'en' ? 'en' : 'ar';
    const deps = { db, Timestamp: admin.firestore.Timestamp, now: () => Date.now(), lang };
    const result = await activateSellerTxn(deps, { uid: context.auth.uid });
    console.log(`[activateSeller] uid=${context.auth.uid} activated=${result.activated}`);
    return { success: true, ...result };
  } catch (error) {
    console.error('Error in activateSeller:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    const code = ['not-found', 'permission-denied', 'failed-precondition', 'invalid-argument'].includes(error.code) ? error.code : 'internal';
    throw new functions.https.HttpsError(code, error.message || 'تعذر تفعيل حساب البائع.');
  }
});

/**
 * issueDeliveryCode — Wave 3. The SELLER (or an admin acting for them) obtains
 * the code they must write on the parcel, which then has to be legible in their
 * dispatch photo AND in the buyer's receipt photo. Idempotent; ownership and
 * state live in deliveryIssue.js (unit-tested). This wrapper is auth-gating and
 * admin resolution only.
 */
exports.issueDeliveryCode = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'لا تملك صلاحية تنفيذ هذه العملية');
  }
  try {
    // Same admin resolution releaseOrderEscrow uses, so one definition of
    // "admin" governs every order-side callable.
    const callerSnap = await db.collection('users').doc(context.auth.uid).get();
    const cd = callerSnap.exists ? (callerSnap.data() || {}) : {};
    const isAdmin = callerIsAdmin(cd);

    const deps = { db, Timestamp: admin.firestore.Timestamp, now: () => Date.now() };
    const result = await issueDeliveryCodeTxn(deps, {
      orderId: data && data.orderId,
      actorUid: context.auth.uid,
      isAdmin,
    });
    console.log(`[issueDeliveryCode] order=${data && data.orderId} created=${result.created}`);
    return { success: true, ...result };
  } catch (error) {
    console.error('Error in issueDeliveryCode:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    const code = ['not-found', 'permission-denied', 'failed-precondition', 'invalid-argument'].includes(error.code) ? error.code : 'internal';
    throw new functions.https.HttpsError(code, error.message || 'Operation failed.');
  }
});

/**
 * verifyOrderPayment — Slice B (Verify & Approve).
 * Admin verifies (or rejects) a buyer's self-claimed CliQ payment on an order.
 * State machine + idempotency live in orderPaymentVerify.js (unit-tested);
 * this wrapper is admin-gating + the post-commit WhatsApp notify.
 */
exports.verifyOrderPayment = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  // Warm ping from `warmAdminCallables`, ABOVE the auth check by design: below
  // it, it throws `unauthenticated` ~1,700x/day, burying real auth failures.
  // Reachable unauthenticated — accepted risk, see warmTargets.js header.
  if (data && data.__warm === true) return { warm: true };
  await assertAdmin(context);
  const { orderId, action, reason } = data || {};
  if (action !== 'verify' && action !== 'reject') {
    throw new functions.https.HttpsError('invalid-argument', "action must be 'verify' or 'reject'.");
  }
  try {
    const deps = { db, Timestamp: admin.firestore.Timestamp };
    if (action === 'verify') {
      const result = await verifyOrderPaymentTxn(deps, { orderId, adminUid: context.auth.uid });
      console.log(`[verifyOrderPayment] verified order=${orderId} already=${result.alreadyVerified} by ${context.auth.uid}`);
      return { success: true, ...result };
    }
    const result = await rejectOrderPaymentTxn(deps, { orderId, adminUid: context.auth.uid, reason });
    // Post-commit, best-effort: tell the buyer why, so they can resubmit.
    await notify({ uid: result.buyerId, event: 'order_payment_rejected', data: {
      name: result.buyerName, reason: result.reason, orderId,
      idempotencyKey: `order_payment_rejected_${orderId}`,
    } });
    return { success: true, ...result };
  } catch (error) {
    console.error('Error in verifyOrderPayment:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    const code = ['not-found', 'invalid-argument', 'failed-precondition'].includes(error.code) ? error.code : 'internal';
    throw new functions.https.HttpsError(code, error.message || 'Operation failed.');
  }
});

/**
 * sendFulfillmentNudge — Slice C (Fulfillment). Admin nudges a seller to
 * ship or a buyer to confirm delivery. Manual-only: this callable is the
 * ONLY way a nudge fires — nothing calls it on a timer/trigger.
 */
exports.sendFulfillmentNudge = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  // Warm ping from `warmAdminCallables`, ABOVE the auth check by design: below
  // it, it throws `unauthenticated` ~1,700x/day, burying real auth failures.
  // Reachable unauthenticated — accepted risk, see warmTargets.js header.
  if (data && data.__warm === true) return { warm: true };
  await assertAdmin(context);
  const { orderId, kind } = data || {};
  try {
    const deps = { db, Timestamp: admin.firestore.Timestamp };
    const result = await sendFulfillmentNudgeTxn(deps, { orderId, kind, adminUid: context.auth.uid });

    const event = kind === 'ship' ? 'seller_ship_nudge' : 'buyer_confirm_nudge';
    // Hour-bucketed key: dedupes accidental same-click retries within a clock-hour,
    // but still lets a deliberately-later repeat nudge (a spec requirement) through;
    // the exact window is tunable once the n8n Switch branches + real dedup are wired.
    const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
    await notify({ uid: result.targetUserId, event, data: {
      name: result.targetUserName, orderId,
      idempotencyKey: `${event}_${orderId}_${hourBucket}`,
    } });

    console.log(`[sendFulfillmentNudge] ${kind} nudge sent for order=${orderId} by ${context.auth.uid}`);
    return { success: true, ...result };
  } catch (error) {
    console.error('Error in sendFulfillmentNudge:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    const code = ['not-found', 'invalid-argument', 'failed-precondition'].includes(error.code) ? error.code : 'internal';
    throw new functions.https.HttpsError(code, error.message || 'Operation failed.');
  }
});

/**
 * stampDisputeResolution — Slice D (Disputes). Records the admin's
 * resolution note AFTER the real resolution (release/refund/resume) has
 * already happened via the existing, unmodified resolve_dispute path.
 * This callable moves no money and re-derives nothing from order state —
 * it is purely descriptive metadata.
 */
exports.stampDisputeResolution = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  await assertAdmin(context);
  const { orderId, resolutionType, notes } = data || {};
  try {
    const deps = { db, Timestamp: admin.firestore.Timestamp };
    const result = await stampDisputeResolutionTxn(deps, { orderId, resolutionType, adminUid: context.auth.uid, notes });
    console.log(`[stampDisputeResolution] ${resolutionType} note stamped for order=${orderId} by ${context.auth.uid}`);

    // Return-type dispute: the stamp already closed out returnClaim.status (no
    // money moved — the refund/release ran before this). Notify the buyer of the
    // outcome. notify() never throws and runs AFTER the txn — a webhook hiccup
    // must not undo the resolution stamp.
    if (result.isReturn) {
      await notify({ uid: result.buyerId, event: 'return_resolved', data: {
        auctionId: result.auctionId,
        auctionTitle: result.auctionTitle,
        orderId,
        outcome: result.outcome,
        idempotencyKey: `${orderId}_return_resolved`,
      } });
    }

    return { success: true, ...result };
  } catch (error) {
    console.error('Error in stampDisputeResolution:', error);
    if (error instanceof functions.https.HttpsError) throw error;
    const code = ['not-found', 'invalid-argument'].includes(error.code) ? error.code : 'internal';
    throw new functions.https.HttpsError(code, error.message || 'Operation failed.');
  }
});

/**
 * 8. onUserCreated (Auth Trigger)
 * Automatically triggers on user signup in Auth to construct profile doc & wallet safely on the server side.
 */
exports.onUserCreated = functions.auth.user().onCreate(async (user) => {
  const uid = user.uid;
  const userRef = db.collection('users').doc(uid);
  const walletRef = db.collection('wallets').doc(uid);

  const cleanEmail = user.email ? user.email.toLowerCase().trim() : '';
  // No account is born an administrator. One address used to be promoted
  // here on sign-up, which made "who is an admin" a property of the auth
  // provider rather than a decision somebody made and can be shown to have
  // made. The role is granted afterwards, deliberately, via grantAdminRole.

  const batch = db.batch();

  // Create user doc if not exists
  batch.set(userRef, {
    id: uid,
    uid: uid,
    name: user.displayName || 'User',
    email: cleanEmail,
    avatar: user.photoURL || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&q=80',
    role: 'user',
    isAdmin: false,
    accountStatus: 'active',
    isVerified: true,
    isBlocked: false,
    subscriptionStatus: 'none',
    subscriptionExpiry: null,
    phoneNumber: user.phoneNumber || '',
    phone: user.phoneNumber || '',
    city: '',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  // Create wallet doc if not exists
  batch.set(walletRef, {
    userId: uid,
    availableBalance: 0,
    escrowBalance: 0,
    totalBalance: 0,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  try {
    await batch.commit();
    console.log(`[onUserCreated] Successfully initialized user profile and wallet for uid: ${uid}`);
  } catch (err) {
    console.error(`[onUserCreated Error] Failed for uid: ${uid}`, err);
  }
  return null;
});

/**
 * 9. initializeUserWallet (Callable)
 * Safely initializes or checks the presence of a user's wallet from server context.
 */
exports.initializeUserWallet = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated.');
  }
  const userId = context.auth.uid;

  try {
    const walletRef = db.collection('wallets').doc(userId);
    const walletSnap = await walletRef.get();
    if (!walletSnap.exists) {
      await walletRef.set({
        userId,
        availableBalance: 0,
        escrowBalance: 0,
        totalBalance: 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`[initializeUserWallet] Initialized wallet for ${userId}`);
    }
    return { success: true, message: 'Wallet checked/initialized.' };
  } catch (error) {
    console.error(`[initializeUserWallet Error] Failed for userId: ${userId}`, error);
    throw new functions.https.HttpsError('internal', error.message || 'Failed to initialize wallet.');
  }
});

/**
 * 10. checkDuplicateAccount (Callable)
 * Server-side validation to check for duplicate phone numbers and names using Admin SDK.
 * Bypasses firestore client-side read security rules to ensure robust security.
 */
exports.checkDuplicateAccount = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  const phone = data.phone || '';
  const name = data.name || '';

  const normalizedPhone = phone.replace(/\D/g, '');
  const normalizedName = name.trim().toLowerCase();

  let phoneExists = false;
  let nameExists = false;

  console.log(`[checkDuplicateAccount] Checking duplicate for phone: ${phone} (${normalizedPhone}) and name: ${name} (${normalizedName})`);

  try {
    if (normalizedPhone) {
      const phoneSnap = await db.collection('users')
        .where('normalizedPhone', '==', normalizedPhone)
        .limit(1)
        .get();
      if (!phoneSnap.empty) {
        phoneExists = true;
      }
    }

    if (normalizedName) {
      const nameSnap = await db.collection('users')
        .where('normalizedName', '==', normalizedName)
        .limit(1)
        .get();
      if (!nameSnap.empty) {
        nameExists = true;
      }
    }

    return {
      phoneExists,
      nameExists,
      duplicate: phoneExists || nameExists
    };
  } catch (error) {
    console.error('[checkDuplicateAccount Error]', error);
    throw new functions.https.HttpsError('internal', error.message || 'Failed to check duplicates.');
  }
});

/**
 * 11. repairEndedAuctionOrder (Callable)
 * Admin-only utility to repair any ended auction by creating its corresponding Order document
 * if the cron check didn't trigger or failed.
 */
exports.repairEndedAuctionOrder = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated.');
  }
  const handlerUserId = context.auth.uid;
  const { auctionId } = data;

  if (!auctionId) {
    throw new functions.https.HttpsError('invalid-argument', 'Invalid auctionId.');
  }

  try {
    const handlerUserRef = db.collection('users').doc(handlerUserId);
    const handlerSnap = await handlerUserRef.get();
    if (!handlerSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Authenticated user not found.');
    }
    const handlerData = handlerSnap.data();
    if (!callerIsAdmin(handlerData)) {
      throw new functions.https.HttpsError('permission-denied', 'Unauthorized. Administrators only.');
    }

    const auctionRef = db.collection('auctions').doc(auctionId);
    const auctionSnap = await auctionRef.get();
    if (!auctionSnap.exists) {
      return { success: false, message: 'Auction not found.' };
    }
    const auctionData = auctionSnap.data();

    // Check if there is a winner/highest bidder
    const winnerId = auctionData.currentBidderId || auctionData.highestBidderId || auctionData.winnerId;
    if (!winnerId) {
      return { success: false, message: 'No winner or highest bidder found for this auction.' };
    }

    const winnerName = auctionData.currentBidderName || auctionData.highestBidderName || auctionData.winnerName || 'Buyer';
    const finalPrice = auctionData.currentPrice || auctionData.startingPrice || 0;

    // currentBidderName on the public auction doc is now MASKED. The PRIVATE
    // order (and the winner's own notifications) need the REAL name — resolve
    // it from the winner's user doc, falling back to the masked label.
    let realWinnerName = winnerName;
    try {
      const winnerSnap = await db.collection('users').doc(winnerId).get();
      if (winnerSnap.exists && winnerSnap.data().name) {
        realWinnerName = winnerSnap.data().name;
      }
    } catch (nameErr) {
      console.warn(`[repairEndedAuctionOrder] winner name lookup failed for ${winnerId}:`, nameErr);
    }

    const orderRef = db.collection('orders').doc(auctionId);
    const orderSnap = await orderRef.get();

    /**
     * THE REPAIR RUNS THE SAME SETTLEMENT DECISION AS THE CRON.
     *
     * Everything below this comment used to be absent. The repair read the
     * winner and the price, checked that no order existed, and wrote one —
     * without reading the reserve amount, the `reserveMet` marker, or even the
     * auction's own status. So a lot that closed CORRECTLY as `reserve_not_met`
     * (no order, seller asked) was indistinguishable, in the admin's list of
     * ended auctions without orders, from a lot the closer had genuinely
     * dropped. One click awarded it below its reserve and billed the buyer.
     *
     * FAIL CLOSED on the secrets read, exactly as settleAuctionTxn does: if we
     * cannot read the reserve we cannot prove the bid cleared it, and an
     * unreadable reserve must never be worth the same as no reserve.
     */
    let reservePrice = null;
    try {
      const secretSnap = await db.collection('auctionSecrets').doc(auctionId).get();
      if (secretSnap.exists) reservePrice = secretSnap.data().reservePrice ?? null;
    } catch (secErr) {
      console.error(`[repairEndedAuctionOrder] auctionSecrets read failed for ${auctionId} — refusing to repair (fail closed):`, secErr);
      return { success: false, message: 'Could not read the reserve for this auction. Nothing was written; try again.' };
    }

    const decision = resolveSettlement({
      totalBids: auctionData.totalBids || 0,
      winnerId,
      finalPrice,
      reservePrice,
      reserveIntended: auctionRecordsReserve(auctionData),
      tolerancePct: resolveReserveTolerancePct(auctionData),
    });

    const permitted = authorizeOrderRepair({ auction: auctionData, decision, orderExists: orderSnap.exists });
    if (!permitted.ok) {
      console.warn(`[repairEndedAuctionOrder] refused for ${auctionId} (${permitted.code}): ${permitted.message}`);
      return { success: false, code: permitted.code, message: permitted.message };
    }

    // Query escrow if any exists
    let escrowId = null;
    const escrowQuery = await db.collection('escrows')
      .where('auctionId', '==', auctionId)
      .where('bidderId', '==', winnerId)
      .where('status', '==', 'locked')
      .limit(1)
      .get();
    if (!escrowQuery.empty) {
      escrowId = escrowQuery.docs[0].id;
    }

    console.log("Checking ended auction:", auctionId);
    console.log("Winner:", winnerId);
    console.log("Final price:", finalPrice);
    console.log("Creating order:", auctionId);

    const orderPayload = {
      id: auctionId,
      auctionId: auctionId,
      auctionTitle: auctionData.title || '',
      auctionImage: auctionData.thumbnailUrl || auctionData.imageUrl || '',
      sellerId: auctionData.sellerId || '',
      sellerName: auctionData.sellerName || 'Seller',
      buyerId: winnerId,
      buyerName: realWinnerName,
      winningBidAmount: finalPrice,
      buyersPremium: buyerPremiumJod(finalPrice),
      totalDue: totalDueJod(finalPrice),
      sellerCommission: sellerCommissionFils(Math.round(finalPrice * 1000)) / 1000,
      sellerNet: sellerNetFils(Math.round(finalPrice * 1000)) / 1000,
      paymentDeadlineAt: paymentDeadlineFromNow(auctionData),
      paymentWindowHours: resolvePaymentWindowHours(auctionData && auctionData.paymentWindowHours),
      status: "waiting_payment",
      paymentStatus: "unpaid",
      shippingStatus: "not_started",
      escrowStatus: "locked",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (escrowId) {
      orderPayload.escrowId = escrowId;
    }

    await orderRef.set(orderPayload);
    console.log(`[repairEndedAuctionOrder] Created repaired order for auction ${auctionId}`);

    // (order-ref) DECOUPLED — assign the human-readable MZ ref AFTER the order
    // doc is committed, in its own transaction, wrapped so it can NEVER throw
    // out of the repair path.
    try {
      await assignOrderRef({ db, Timestamp: admin.firestore.Timestamp, now: () => Date.now() }, auctionId);
    } catch (e) {
      console.error('assignOrderRef failed (non-fatal)', auctionId, e);
    }

    // (notify) mirror the closer: an admin-repaired win still owes payment, so
    // send the same auction_won + payment_due WhatsApp events. Never throws.
    await notify({ uid: winnerId, event: 'auction_won', data: {
      name: realWinnerName,
      auctionId, auctionTitle: auctionData.title || '', amount: finalPrice,
      buyersPremium: buyerPremiumJod(finalPrice),
      totalDue: totalDueJod(finalPrice),
      paymentHours: resolvePaymentWindowHours(auctionData && auctionData.paymentWindowHours),
      idempotencyKey: `${auctionId}_auction_won`,
    } });
    await notify({ uid: winnerId, event: 'payment_due', data: {
      name: realWinnerName,
      auctionId, auctionTitle: auctionData.title || '', amount: finalPrice,
      buyersPremium: buyerPremiumJod(finalPrice),
      totalDue: totalDueJod(finalPrice),
      paymentHours: resolvePaymentWindowHours(auctionData && auctionData.paymentWindowHours),
      idempotencyKey: `${auctionId}_payment_due`,
    } });

    return { success: true, message: `Successfully created repaired order for auction ${auctionId}.`, orderId: auctionId };

  } catch (error) {
    console.error('Error in repairEndedAuctionOrder:', error);
    throw new functions.https.HttpsError('internal', error.message || 'Operation failed.');
  }
});

/**
 * E3 Slice C — acceptBelowReserve (money-path).
 * The auction ended reserve_not_met with a real top bid; settleAuctionTxn
 * stamped a `belowReserveOffer` (status 'pending_seller'). The SELLER (or an
 * admin) one-taps to accept that top bid. This creates a PENDING order that the
 * top BIDDER must still confirm — so NO payment deadline, NO escrow lock, and
 * NO wallet movement happen here. Fees are the SAME as a normal sale, computed
 * from the below-reserve top bid via the shared settlement helpers (never
 * recomputed inline). Idempotent: an existing order short-circuits.
 */
exports.acceptBelowReserve = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول لتنفيذ هذه العملية.');
  }
  const callerUserId = context.auth.uid;
  const { auctionId } = data || {};
  if (!auctionId) {
    throw new functions.https.HttpsError('invalid-argument', 'معرّف المزاد مطلوب.');
  }

  try {
    let buyerNotify = null;
    const result = await db.runTransaction(async (transaction) => {
      buyerNotify = null; // reset each attempt — a retried txn must not re-emit a prior attempt's notify
      const auctionRef = db.collection('auctions').doc(auctionId);
      const orderRef = db.collection('orders').doc(auctionId);
      const callerRef = db.collection('users').doc(callerUserId);

      const [auctionSnap, orderSnap, callerSnap] = await Promise.all([
        transaction.get(auctionRef),
        transaction.get(orderRef),
        transaction.get(callerRef),
      ]);

      if (!auctionSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'المزاد غير موجود.');
      }
      const auctionData = auctionSnap.data();
      const offer = auctionData.belowReserveOffer;
      if (!offer) {
        throw new functions.https.HttpsError('failed-precondition', 'لا يوجد عرض أقل من السعر المطلوب لهذا المزاد.');
      }

      const callerData = callerSnap.exists ? callerSnap.data() : {};
      const isAdmin = callerIsAdmin(callerData);
      const isSeller = auctionData.sellerId && auctionData.sellerId === callerUserId;
      if (!isAdmin && !isSeller) {
        throw new functions.https.HttpsError('permission-denied', 'هذه العملية متاحة للبائع فقط.');
      }

      // Idempotency: an order already exists (this call already ran, or the
      // buyer already confirmed) — do not double-create or reopen.
      if (orderSnap.exists) {
        return { success: true, alreadyAccepted: true, offerStatus: belowReservePublicStatus('pending_buyer'), message: 'تم قبول العرض مسبقاً.' };
      }

      if (offer.status !== 'pending_seller') {
        throw new functions.https.HttpsError('failed-precondition', 'العرض لم يعد بانتظار موافقة البائع.');
      }
      if (isBelowReserveOfferExpired(offer, Date.now())) {
        throw new functions.https.HttpsError('failed-precondition', 'انتهت مهلة قبول هذا العرض.');
      }

      const topBid = offer.topBid;
      const topBidderId = offer.topBidderId;
      const topBidderName = offer.topBidderName || 'Buyer';

      // offer.topBidderName is the MASKED public label. The PRIVATE order needs
      // the REAL buyer name — resolve it from the user doc. This read runs
      // BEFORE any write below (Firestore requires all reads first); the
      // Promise.all above couldn't include it because topBidderId is only known
      // after reading the auction. Fall back to the masked label if missing.
      let realTopBidderName = topBidderName;
      if (topBidderId) {
        const topBidderSnap = await transaction.get(db.collection('users').doc(topBidderId));
        if (topBidderSnap.exists && topBidderSnap.data().name) {
          realTopBidderName = topBidderSnap.data().name;
        }
      }

      // Money-path: fees on the below-reserve top bid, computed with the SAME
      // shared helpers the sold path uses (buyer +5%, seller net 95%). PENDING —
      // no paymentDeadlineAt, no escrow lock. escrowStatus is a status field only.
      const orderPayload = {
        id: auctionId,
        auctionId: auctionId,
        auctionTitle: auctionData.title || '',
        auctionImage: auctionData.thumbnailUrl || auctionData.imageUrl || '',
        sellerId: auctionData.sellerId || '',
        sellerName: auctionData.sellerName || 'Seller',
        buyerId: topBidderId,
        buyerName: realTopBidderName,
        winningBidAmount: topBid,
        buyersPremium: buyerPremiumJod(topBid),
        totalDue: totalDueJod(topBid),
        sellerCommission: sellerCommissionFils(Math.round(topBid * 1000)) / 1000,
        sellerNet: sellerNetFils(Math.round(topBid * 1000)) / 1000,
        status: 'pending_buyer_confirmation',
        paymentStatus: 'unpaid',
        shippingStatus: 'not_started',
        escrowStatus: 'pending',
        belowReserve: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (auctionData.isSimulated === true) {
        orderPayload.isSimulated = true;
      }

      transaction.set(orderRef, orderPayload);
      transaction.update(auctionRef, {
        'belowReserveOffer.status': 'pending_buyer',
        'belowReserveOffer.sellerAcceptedAt': admin.firestore.FieldValue.serverTimestamp(),
        // Give the buyer a FRESH 24h window to confirm (not the residual of the
        // seller's window) — keeps the confirm window fair and keeps
        // belowReserveBlocksRelist blocking a relist until the buyer's window lapses.
        'belowReserveOffer.expiresAt': admin.firestore.Timestamp.fromMillis(belowReserveExpiryMs(Date.now())),
      });

      buyerNotify = {
        buyerId: topBidderId,
        // Private notification to the buyer themselves — real name.
        buyerName: realTopBidderName,
        auctionId,
        auctionTitle: auctionData.title || '',
        topBid,
      };
      return { success: true, offerStatus: belowReservePublicStatus('pending_buyer'), message: 'تم قبول العرض. بانتظار تأكيد المشتري.' };
    });

    // (notify) prompt the buyer to confirm. Post-commit, never-throws — a webhook
    // failure must not roll back an accepted offer.
    if (buyerNotify) {
      await notify({ uid: buyerNotify.buyerId, event: 'below_reserve_seller_accepted', data: {
        name: buyerNotify.buyerName,
        buyerId: buyerNotify.buyerId,
        auctionId: buyerNotify.auctionId,
        auctionTitle: buyerNotify.auctionTitle,
        topBid: buyerNotify.topBid,
        idempotencyKey: `${buyerNotify.auctionId}_below_reserve_accepted`,
      } });
    }

    return result;
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Error in acceptBelowReserve:', error);
    throw new functions.https.HttpsError('internal', error.message || 'تعذر قبول العرض.');
  }
});

/**
 * rejectBelowReserve — the SELLER (or an admin) turns down a below-reserve
 * near-miss offer that is still awaiting their decision.
 *
 * This is the missing half of the seller's Accept/Reject pair. `acceptBelowReserve`
 * existed; the only "decline" was `declineBelowReserve`, which is the BUYER
 * walking away AFTER acceptance — it requires an order to exist and refuses any
 * caller who is not that order's buyer. A seller facing a `pending_seller` offer
 * therefore had exactly one button, and rejecting meant letting the 24h window
 * lapse.
 *
 * Rejecting is terminal: status goes to 'declined', which is the same state a
 * lapsed/declined offer reaches, so belowReserveBlocksRelist stops blocking and
 * the lot becomes relistable immediately instead of 24h later.
 *
 * Security: ownership is derived from the AUCTION DOC's sellerId compared to the
 * verified context.auth.uid — never from anything in `data`. Idempotent, and
 * guarded on both status and expiry the same way acceptBelowReserve is.
 */
exports.rejectBelowReserve = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول لتنفيذ هذه العملية.');
  }
  const callerUserId = context.auth.uid;
  const { auctionId } = data || {};
  if (!auctionId) {
    throw new functions.https.HttpsError('invalid-argument', 'معرّف المزاد مطلوب.');
  }

  try {
    let bidderNotify = null;
    const result = await db.runTransaction(async (transaction) => {
      bidderNotify = null; // reset each attempt — a retried txn must not re-emit a prior attempt's notify
      const auctionRef = db.collection('auctions').doc(auctionId);
      const orderRef = db.collection('orders').doc(auctionId);
      const callerRef = db.collection('users').doc(callerUserId);

      const [auctionSnap, orderSnap, callerSnap] = await Promise.all([
        transaction.get(auctionRef),
        transaction.get(orderRef),
        transaction.get(callerRef),
      ]);

      if (!auctionSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'المزاد غير موجود.');
      }
      const auctionData = auctionSnap.data();
      const offer = auctionData.belowReserveOffer;
      if (!offer) {
        throw new functions.https.HttpsError('failed-precondition', 'لا يوجد عرض أقل من السعر المطلوب لهذا المزاد.');
      }

      // Authorization from SERVER state only: the auction's own sellerId, or an
      // admin. Nothing the caller sent is consulted.
      const callerData = callerSnap.exists ? callerSnap.data() : {};
      const isAdmin = callerIsAdmin(callerData);
      const isSeller = auctionData.sellerId && auctionData.sellerId === callerUserId;
      if (!isAdmin && !isSeller) {
        throw new functions.https.HttpsError('permission-denied', 'هذه العملية متاحة للبائع فقط.');
      }

      // Idempotency: already rejected (or lapsed into a terminal state) — say so
      // and change nothing, rather than throwing at a seller who double-tapped.
      if (offer.status === 'declined' || offer.status === 'expired') {
        return {
          success: true,
          alreadyRejected: true,
          offerStatus: belowReservePublicStatus(offer.status),
          message: 'تم رفض العرض مسبقاً.',
        };
      }

      // The seller already accepted — an order exists and the buyer is being
      // asked. Walking that back is the buyer's call (declineBelowReserve) or
      // an admin cancellation, not a second seller decision.
      if (offer.status !== 'pending_seller' || orderSnap.exists) {
        throw new functions.https.HttpsError('failed-precondition', 'العرض لم يعد بانتظار موافقة البائع.');
      }
      if (isBelowReserveOfferExpired(offer, Date.now())) {
        throw new functions.https.HttpsError('failed-precondition', 'انتهت مهلة الرد على هذا العرض.');
      }

      transaction.update(auctionRef, {
        'belowReserveOffer.status': 'declined',
        'belowReserveOffer.sellerRejectedAt': admin.firestore.FieldValue.serverTimestamp(),
      });

      if (offer.topBidderId) {
        bidderNotify = {
          topBidderId: offer.topBidderId,
          auctionTitle: auctionData.title || '',
        };
      }
      return {
        success: true,
        offerStatus: belowReservePublicStatus('declined'),
        message: 'تم رفض العرض.',
      };
    });

    // (notify) tell the top bidder the lot did not go their way. Reuses the
    // existing below_reserve_declined event — from the bidder's side a seller
    // rejection and a buyer-side decline read identically: the offer is dead.
    // Post-commit and never-throws, matching the rest of this family.
    if (bidderNotify) {
      await notify({
        uid: bidderNotify.topBidderId,
        event: 'below_reserve_declined',
        data: {
          auctionId,
          auctionTitle: bidderNotify.auctionTitle,
          idempotencyKey: `${auctionId}_below_reserve_seller_rejected`,
        },
      });
    }

    return result;
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Error in rejectBelowReserve:', error);
    throw new functions.https.HttpsError('internal', error.message || 'تعذر رفض العرض.');
  }
});

/**
 * E3 Slice C — confirmBelowReserve (money-path).
 * The seller accepted; the top BIDDER (or admin) confirms, turning the pending
 * order into a real obligation: status 'waiting_payment', escrowStatus 'locked'
 * (status field only — actual wallet movement stays with the existing
 * pay → verify → releaseOrderEscrow flow), and a 24h payment deadline via the
 * SAME paymentDeadlineFromNow helper a normal win uses. Idempotent.
 */
exports.confirmBelowReserve = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول لتنفيذ هذه العملية.');
  }
  const callerUserId = context.auth.uid;
  const { auctionId } = data || {};
  if (!auctionId) {
    throw new functions.https.HttpsError('invalid-argument', 'معرّف المزاد مطلوب.');
  }

  try {
    let buyerNotify = null;
    const result = await db.runTransaction(async (transaction) => {
      buyerNotify = null; // reset each attempt — a retried txn must not re-emit a prior attempt's notify
      const auctionRef = db.collection('auctions').doc(auctionId);
      const orderRef = db.collection('orders').doc(auctionId);
      const callerRef = db.collection('users').doc(callerUserId);

      const [auctionSnap, orderSnap, callerSnap] = await Promise.all([
        transaction.get(auctionRef),
        transaction.get(orderRef),
        transaction.get(callerRef),
      ]);

      if (!orderSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'الطلب غير موجود.');
      }
      const orderData = orderSnap.data();
      const auctionData = auctionSnap.exists ? auctionSnap.data() : {};

      const callerData = callerSnap.exists ? callerSnap.data() : {};
      const isAdmin = callerIsAdmin(callerData);
      const isBuyer = orderData.buyerId && orderData.buyerId === callerUserId;
      if (!isAdmin && !isBuyer) {
        throw new functions.https.HttpsError('permission-denied', 'هذه العملية متاحة للمشتري فقط.');
      }

      // Idempotency: already confirmed (or beyond) — the obligation already exists.
      if (orderData.status !== 'pending_buyer_confirmation') {
        if (orderData.status === 'waiting_payment') {
          return { success: true, alreadyConfirmed: true, message: 'تم تأكيد الشراء مسبقاً.' };
        }
        throw new functions.https.HttpsError('failed-precondition', 'لا يمكن تأكيد هذا الطلب في حالته الحالية.');
      }

      // Guard the offer window: an expired offer can't be turned into a sale.
      const offer = auctionData.belowReserveOffer;
      if (offer && isBelowReserveOfferExpired(offer, Date.now())) {
        throw new functions.https.HttpsError('failed-precondition', 'انتهت مهلة تأكيد هذا العرض.');
      }

      transaction.update(orderRef, {
        status: 'waiting_payment',
        escrowStatus: 'locked',
        paymentDeadlineAt: paymentDeadlineFromNow(auctionData),
        paymentWindowHours: resolvePaymentWindowHours(auctionData && auctionData.paymentWindowHours),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      if (auctionSnap.exists) {
        transaction.update(auctionRef, {
          'belowReserveOffer.status': 'confirmed',
          'belowReserveOffer.buyerConfirmedAt': admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      buyerNotify = {
        buyerId: orderData.buyerId,
        buyerName: orderData.buyerName || 'Buyer',
        auctionId,
        auctionTitle: orderData.auctionTitle || '',
        amount: orderData.winningBidAmount,
        paymentHours: resolvePaymentWindowHours(auctionData && auctionData.paymentWindowHours),
      };
      return { success: true, message: 'تم تأكيد الشراء. يرجى إتمام الدفع.' };
    });

    // (notify) same auction_won + payment_due events a normal win fires — the
    // buyer now owes payment. Post-commit, never-throws.
    if (buyerNotify) {
      const payload = {
        name: buyerNotify.buyerName,
        auctionId: buyerNotify.auctionId, auctionTitle: buyerNotify.auctionTitle,
        amount: buyerNotify.amount,
        buyersPremium: buyerPremiumJod(buyerNotify.amount),
        totalDue: totalDueJod(buyerNotify.amount),
        paymentHours: buyerNotify.paymentHours,
      };
      await notify({ uid: buyerNotify.buyerId, event: 'auction_won', data: { ...payload, idempotencyKey: `${buyerNotify.auctionId}_auction_won` } });
      await notify({ uid: buyerNotify.buyerId, event: 'payment_due', data: { ...payload, idempotencyKey: `${buyerNotify.auctionId}_payment_due` } });
    }

    return result;
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Error in confirmBelowReserve:', error);
    throw new functions.https.HttpsError('internal', error.message || 'تعذر تأكيد الشراء.');
  }
});

/**
 * E3 Slice C — declineBelowReserve. The top BIDDER (or admin) declines the
 * seller-accepted offer: the pending order is cancelled and the offer marked
 * 'declined'. The auction stays reserve_not_met, so auto-relist (if the seller
 * opted in) picks it up — shouldAutoRelist stops blocking once status='declined'.
 * No wallet movement (nothing was ever locked). Idempotent.
 */
exports.declineBelowReserve = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول لتنفيذ هذه العملية.');
  }
  const callerUserId = context.auth.uid;
  const { auctionId } = data || {};
  if (!auctionId) {
    throw new functions.https.HttpsError('invalid-argument', 'معرّف المزاد مطلوب.');
  }

  let bidderNotify = null;
  try {
    const result = await db.runTransaction(async (transaction) => {
      bidderNotify = null; // reset each attempt — a retried txn must not re-emit a prior attempt's notify
      const auctionRef = db.collection('auctions').doc(auctionId);
      const orderRef = db.collection('orders').doc(auctionId);
      const callerRef = db.collection('users').doc(callerUserId);

      const [auctionSnap, orderSnap, callerSnap] = await Promise.all([
        transaction.get(auctionRef),
        transaction.get(orderRef),
        transaction.get(callerRef),
      ]);

      if (!orderSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'الطلب غير موجود.');
      }
      const orderData = orderSnap.data();

      const callerData = callerSnap.exists ? callerSnap.data() : {};
      const isAdmin = callerIsAdmin(callerData);
      const isBuyer = orderData.buyerId && orderData.buyerId === callerUserId;
      if (!isAdmin && !isBuyer) {
        throw new functions.https.HttpsError('permission-denied', 'هذه العملية متاحة للمشتري فقط.');
      }

      // Idempotency: already declined/cancelled.
      if (orderData.status === 'cancelled') {
        return { success: true, alreadyDeclined: true, offerStatus: belowReservePublicStatus('declined'), message: 'تم رفض العرض مسبقاً.' };
      }
      // Only a still-pending (un-confirmed) offer can be declined. A confirmed
      // (waiting_payment) obligation can't be walked back here.
      if (orderData.status !== 'pending_buyer_confirmation') {
        throw new functions.https.HttpsError('failed-precondition', 'لا يمكن رفض هذا الطلب في حالته الحالية.');
      }

      transaction.update(orderRef, {
        status: 'cancelled',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      if (auctionSnap.exists && auctionSnap.data().belowReserveOffer) {
        const auctionData = auctionSnap.data();
        const offer = auctionData.belowReserveOffer;
        transaction.update(auctionRef, {
          'belowReserveOffer.status': 'declined',
          'belowReserveOffer.buyerDeclinedAt': admin.firestore.FieldValue.serverTimestamp(),
        });
        if (offer && offer.topBidderId) {
          bidderNotify = {
            topBidderId: offer.topBidderId,
            auctionTitle: auctionData.title || auctionData.auctionTitle || '',
          };
        }
      }
      return { success: true, offerStatus: belowReservePublicStatus('declined'), message: 'تم رفض العرض.' };
    });

    if (bidderNotify) {
      await notify({
        uid: bidderNotify.topBidderId,
        event: 'below_reserve_declined',
        data: {
          auctionId,
          auctionTitle: bidderNotify.auctionTitle,
          idempotencyKey: `${auctionId}_below_reserve_declined`,
        },
      });
    }

    return result;
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Error in declineBelowReserve:', error);
    throw new functions.https.HttpsError('internal', error.message || 'تعذر رفض العرض.');
  }
});

/**
 * respondToSecondChance — act on a second-chance offer (seller_accept /
 * buyer_accept / decline).
 *
 * Thin wrapper, same split as submitOrderPayment: the transaction, the money
 * and the state machine live in ./secondChanceRespond (unit-tested with an
 * injected db); this does auth, the post-commit notify, and the cosmetic order
 * reference.
 */
exports.respondToSecondChance = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول لتنفيذ هذه العملية.');
  }
  const callerUserId = context.auth.uid;
  const { auctionId, action } = data || {};

  try {
    const deps = { db, Timestamp: admin.firestore.Timestamp, now: () => Date.now() };
    const { result, notify: pendingNotify } = await respondToSecondChanceTxn(deps, {
      auctionId, action, callerUserId,
    });

    // Post-commit: a notify inside a transaction re-sends on every retry.
    if (pendingNotify && pendingNotify.uid) {
      try {
        await notify({
          uid: pendingNotify.uid,
          event: pendingNotify.event,
          data: {
            ...pendingNotify.data,
            idempotencyKey: `${auctionId}_sc_${action}`,
          },
        });
      } catch (e) {
        console.warn('[respondToSecondChance] notify failed (non-fatal):', e && e.message);
      }
    }

    // A ref is cosmetic — never let it fail the purchase.
    if (result && result.success && action === 'buyer_accept' && !result.alreadyCreated) {
      try {
        await assignOrderRef(deps, secondChanceOrderId(auctionId));
      } catch (e) {
        console.error('[respondToSecondChance] assignOrderRef failed (non-fatal):', e && e.message);
      }
    }
    console.log(`[respondToSecondChance] ${action} on ${auctionId} by ${callerUserId}`);
    return result;
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Error in respondToSecondChance:', error);
    const code = ['not-found', 'permission-denied', 'failed-precondition', 'invalid-argument', 'unauthenticated'].includes(error.code) ? error.code : 'internal';
    throw new functions.https.HttpsError(code, error.message || 'تعذر تنفيذ العملية.');
  }
});

/**
 * E6 Task A3 — requestReturn (NO money movement).
 * The BUYER opens a not-as-described/damaged return on a shipped order. This
 * FREEZES the order into a `disputed` status with a structured returnClaim and
 * NOTHING else: escrow stays `locked`, no wallet/ledger/escrow writes happen
 * here. Money moves later ONLY through the admin refundOrderEscrow /
 * releaseOrderEscrow callables. Idempotent: a re-run on an order that already
 * carries a returnClaim aborts inside the transaction.
 */
exports.requestReturn = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول لتنفيذ هذه العملية.');
  }
  const callerUserId = context.auth.uid;
  const { orderId, reason, description, photoUrls } = data || {};
  if (!orderId) {
    throw new functions.https.HttpsError('invalid-argument', 'معرّف الطلب مطلوب.');
  }

  // Sanitize photoUrls up front — coerce to an array of non-empty strings.
  // The pure helper silently drops falsy entries; reject junk here instead.
  const cleanPhotoUrls = (Array.isArray(photoUrls) ? photoUrls : [])
    .filter((u) => typeof u === 'string' && u.trim().length > 0)
    .map((u) => u.trim());

  // Build (and validate) the claim BEFORE the transaction. The helper throws a
  // plain Error with code 'invalid-argument' on bad input; surface it as such.
  let returnClaim;
  try {
    returnClaim = buildReturnClaim({ reason, description, photoUrls: cleanPhotoUrls }, Date.now());
  } catch (e) {
    throw new functions.https.HttpsError('invalid-argument', e.message || 'بيانات الإرجاع غير صحيحة.');
  }

  try {
    let sellerNotify = null;
    const result = await db.runTransaction(async (transaction) => {
      sellerNotify = null; // reset each attempt — a retried txn must not re-emit a prior attempt's notify
      const orderRef = db.collection('orders').doc(orderId);
      const orderSnap = await transaction.get(orderRef);

      if (!orderSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'الطلب غير موجود.');
      }
      const orderData = orderSnap.data();

      // Auth: only the buyer of this order may open a return.
      if (!orderData.buyerId || orderData.buyerId !== callerUserId) {
        throw new functions.https.HttpsError('permission-denied', 'هذه العملية متاحة للمشتري فقط.');
      }

      // Guard (re-checked inside the txn for idempotency): must be shipped and
      // have no existing returnClaim.
      if (!canRequestReturn(orderData)) {
        throw new functions.https.HttpsError('failed-precondition', 'لا يمكن طلب الإرجاع لهذا الطلب في حالته الحالية.');
      }

      // Freeze the order. STATUS + claim ONLY — escrow stays locked, no wallet/
      // ledger/escrow writes.
      transaction.update(orderRef, {
        status: 'disputed',
        disputeType: 'return',
        disputeReason: `إرجاع (${reason}): ${description}`,
        returnClaim,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      sellerNotify = {
        sellerId: orderData.sellerId || '',
        auctionId: orderData.auctionId || '',
        auctionTitle: orderData.auctionTitle || '',
        buyerName: orderData.buyerName || orderData.buyerId || '',
      };
      return { success: true, message: 'تم فتح طلب الإرجاع.' };
    });

    // Post-commit, never-throws: notify the seller + surface to admins. A webhook
    // or admin-doc failure must not roll back an accepted return claim.
    if (sellerNotify) {
      await notify({
        uid: sellerNotify.sellerId,
        event: 'return_requested',
        data: {
          auctionId: sellerNotify.auctionId,
          auctionTitle: sellerNotify.auctionTitle,
          orderId,
          idempotencyKey: `${orderId}_return_requested`,
        },
      });
      try {
        await db.collection('system_health').add({
          type: 'return_requested',
          title: `Return opened — ${reason}`,
          details: `Order ${orderId} (${sellerNotify.auctionTitle || ''}) buyer ${sellerNotify.buyerName} opened a ${reason} return. Escrow frozen (locked); awaiting admin refund/release decision.`,
          source: 'requestReturn',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (incErr) {
        console.warn('[requestReturn] system_health write failed:', incErr && incErr.message);
      }
    }

    return result;
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Error in requestReturn:', error);
    throw new functions.https.HttpsError('internal', error.message || 'تعذر فتح طلب الإرجاع.');
  }
});

/**
 * E6 Task B1 — respondToReturn (NO money movement).
 * The SELLER responds to an OPEN return claim: either accepts it (agreeing the
 * return is valid) or contests it with a note. This is ADVISORY ONLY — it writes
 * NOTHING but the returnClaim sub-fields (sellerResponse + optional
 * status:'accepted'). No wallet/ledger/escrow writes happen here; the admin
 * still executes any actual refund/release via refundOrderEscrow /
 * releaseOrderEscrow. Precondition (re-checked in the txn): the order carries a
 * returnClaim with status==='open' — a non-open claim aborts.
 */
exports.respondToReturn = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول لتنفيذ هذه العملية.');
  }
  const callerUserId = context.auth.uid;
  const { orderId, accept, note } = data || {};
  if (!orderId) {
    throw new functions.https.HttpsError('invalid-argument', 'معرّف الطلب مطلوب.');
  }
  if (typeof accept !== 'boolean') {
    throw new functions.https.HttpsError('invalid-argument', 'يجب تحديد قبول أو اعتراض على طلب الإرجاع.');
  }
  const cleanNote = typeof note === 'string' ? note.trim() : '';

  try {
    let adminNotify = null;
    const result = await db.runTransaction(async (transaction) => {
      adminNotify = null; // reset each attempt — a retried txn must not re-emit a prior attempt's notify
      const orderRef = db.collection('orders').doc(orderId);
      const orderSnap = await transaction.get(orderRef);

      if (!orderSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'الطلب غير موجود.');
      }
      const orderData = orderSnap.data();

      // Auth: only the SELLER of this order may respond to its return claim.
      if (!orderData.sellerId || orderData.sellerId !== callerUserId) {
        throw new functions.https.HttpsError('permission-denied', 'هذه العملية متاحة للبائع فقط.');
      }

      // Precondition (re-checked inside the txn): an OPEN return claim must exist.
      const claim = orderData.returnClaim;
      if (!claim || claim.status !== 'open') {
        throw new functions.https.HttpsError('failed-precondition', 'لا يوجد طلب إرجاع مفتوح لهذا الطلب.');
      }

      // Advisory write ONLY — the returnClaim sub-fields via dot-paths. NO wallet/
      // ledger/escrow writes: escrow stays exactly as it was, the admin still
      // executes any refund/release.
      const updates = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (cleanNote) {
        updates['returnClaim.sellerResponse'] = cleanNote;
      }
      if (accept === true) {
        updates['returnClaim.status'] = 'accepted';
      }
      transaction.update(orderRef, updates);

      adminNotify = {
        accept: accept === true,
        note: cleanNote,
        buyerName: orderData.buyerName || orderData.buyerId || '',
        auctionTitle: orderData.auctionTitle || '',
      };
      return {
        success: true,
        message: accept === true
          ? 'تم قبول طلب الإرجاع. سيتولى الفريق تنفيذ الاسترداد.'
          : 'تم إرسال ردك على طلب الإرجاع للمراجعة.',
      };
    });

    // Post-commit, never-throws: surface the seller's response to admins. A
    // system_health write failure must not roll back a recorded response.
    if (adminNotify) {
      try {
        await db.collection('system_health').add({
          type: 'return_seller_response',
          title: `Return ${adminNotify.accept ? 'accepted' : 'contested'} by seller`,
          details: `Order ${orderId} (${adminNotify.auctionTitle || ''}) — seller ${adminNotify.accept ? 'ACCEPTED' : 'CONTESTED'} the return from ${adminNotify.buyerName}.${adminNotify.note ? ` Note: ${adminNotify.note}` : ''} Advisory only — no money moved; admin still executes any refund/release.`,
          source: 'respondToReturn',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (incErr) {
        console.warn('[respondToReturn] system_health write failed:', incErr && incErr.message);
      }
    }

    return result;
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Error in respondToReturn:', error);
    throw new functions.https.HttpsError('internal', error.message || 'تعذر إرسال الرد على طلب الإرجاع.');
  }
});

/**
 * E7 Task A2 — rateBuyer (NO money movement).
 * The SELLER rates the BUYER after a COMPLETED order. This writes EXACTLY ONE
 * new doc to the `reviews` collection and nothing else — no wallet/ledger/escrow
 * writes ever happen here; ratings never touch money. Idempotency is guaranteed
 * by a deterministic review doc id (`${orderId}_seller_rates_buyer`): the txn
 * reads that ref, and a double-submit hits failed-precondition. No notification.
 */
exports.rateBuyer = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول لتنفيذ هذه العملية.');
  }
  const callerUserId = context.auth.uid;
  const { orderId, stars, comment } = data || {};
  if (!orderId) {
    throw new functions.https.HttpsError('invalid-argument', 'معرّف الطلب مطلوب.');
  }

  // Pre-check auth against the order before opening the txn (mirrors how other
  // callables here gate before the transaction).
  const orderRef = db.collection('orders').doc(orderId);
  const preSnap = await orderRef.get();
  if (!preSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'الطلب غير موجود.');
  }
  const preOrder = preSnap.data();
  if (!preOrder.sellerId || preOrder.sellerId !== callerUserId) {
    throw new functions.https.HttpsError('permission-denied', 'هذه العملية متاحة للبائع فقط.');
  }

  try {
    const result = await db.runTransaction(async (transaction) => {
      // Reads-before-writes: re-read the order, then read the deterministic
      // review ref that makes double-submit safe.
      const orderSnap = await transaction.get(orderRef);
      if (!orderSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'الطلب غير موجود.');
      }
      const orderData = orderSnap.data();

      // Auth (re-checked inside the txn): only the SELLER of this order may rate.
      if (!orderData.sellerId || orderData.sellerId !== callerUserId) {
        throw new functions.https.HttpsError('permission-denied', 'هذه العملية متاحة للبائع فقط.');
      }

      const reviewRef = db.collection('reviews').doc(`${orderId}_seller_rates_buyer`);
      const reviewSnap = await transaction.get(reviewRef);
      const existing = reviewSnap.exists ? reviewSnap.data() : null;

      // Guard: order completed, caller is seller, and no rating exists yet.
      if (!canSellerRateOrder(orderData, callerUserId, existing)) {
        throw new functions.https.HttpsError('failed-precondition', 'already rated or not completed');
      }

      // Validate/normalize the rating input via the pure helper.
      let built;
      try {
        built = buildBuyerRating({ stars, comment }, Date.now());
      } catch (e) {
        throw new functions.https.HttpsError('invalid-argument', e.message);
      }

      // Write EXACTLY ONE new reviews doc. NO wallet/ledger/escrow writes.
      transaction.set(reviewRef, {
        orderId,
        auctionId: orderData.auctionId,
        buyerId: orderData.buyerId,
        sellerId: orderData.sellerId,
        ratedBy: orderData.sellerId,
        stars: built.stars,
        text: built.text,
        direction: 'seller_rates_buyer',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return { success: true, message: 'تم تقييم المشتري.' };
    });

    return result;
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Error in rateBuyer:', error);
    throw new functions.https.HttpsError('internal', error.message || 'تعذر حفظ التقييم.');
  }
});

/**
 * rateAuction Callable Cloud Function (rating-forgery fix)
 * Buyer → seller/auction rating. Mirrors rateBuyer (seller → buyer): order-verified,
 * one-per-order via deterministic review id, and NEVER moves money. This is the sole
 * writer of `buyer_rates_auction` review docs — firestore.rules blocks client creation
 * so a malicious client can no longer forge ratings with an arbitrary sellerId/stars.
 */
exports.rateAuction = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول لتنفيذ هذه العملية.');
  }
  const callerUserId = context.auth.uid;
  const { orderId, stars, comment } = data || {};
  if (!orderId) {
    throw new functions.https.HttpsError('invalid-argument', 'معرّف الطلب مطلوب.');
  }

  // Pre-check auth against the order before opening the txn (mirrors rateBuyer).
  const orderRef = db.collection('orders').doc(orderId);
  const preSnap = await orderRef.get();
  if (!preSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'الطلب غير موجود.');
  }
  const preOrder = preSnap.data();
  if (!preOrder.buyerId || preOrder.buyerId !== callerUserId) {
    throw new functions.https.HttpsError('permission-denied', 'هذه العملية متاحة للمشتري فقط.');
  }

  try {
    const result = await db.runTransaction(async (transaction) => {
      // Reads-before-writes: re-read the order, then read the deterministic review ref.
      const orderSnap = await transaction.get(orderRef);
      if (!orderSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'الطلب غير موجود.');
      }
      const orderData = orderSnap.data();

      // Auth (re-checked inside the txn): only the BUYER of this order may rate.
      if (!orderData.buyerId || orderData.buyerId !== callerUserId) {
        throw new functions.https.HttpsError('permission-denied', 'هذه العملية متاحة للمشتري فقط.');
      }

      // Order must be completed OR delivered (matches the client canRateOrder gate).
      if (orderData.status !== 'completed' && orderData.status !== 'delivered') {
        throw new functions.https.HttpsError('failed-precondition', 'الطلب غير مكتمل.');
      }

      // One-per-order: deterministic review id makes double-submit safe.
      const reviewRef = db.collection('reviews').doc(`${orderId}_buyer_rates_auction`);
      const reviewSnap = await transaction.get(reviewRef);
      if (reviewSnap.exists) {
        throw new functions.https.HttpsError('failed-precondition', 'already rated');
      }

      // Validate/normalize the rating input via the pure helper.
      let built;
      try {
        built = buildBuyerRating({ stars, comment }, Date.now());
      } catch (e) {
        throw new functions.https.HttpsError('invalid-argument', e.message);
      }

      // Write EXACTLY ONE new reviews doc using REAL order fields (not client-supplied).
      // NO wallet/ledger/escrow writes.
      transaction.set(reviewRef, {
        orderId,
        auctionId: orderData.auctionId,
        buyerId: orderData.buyerId,
        sellerId: orderData.sellerId || null,
        vendorId: orderData.vendorId || null,
        stars: built.stars,
        text: built.text,
        direction: 'buyer_rates_auction',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return { success: true, message: 'تم تسجيل تقييمك.' };
    });

    return result;
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('Error in rateAuction:', error);
    throw new functions.https.HttpsError('internal', error.message || 'تعذر حفظ التقييم.');
  }
});

/**
 * 12. releaseOrderEscrow Callable Cloud Function (CRITICAL FIX PHASE 1)
 * Moves the financial logic of escrow release to a secure transactional server-side environment.
 * Ensures order completion, escrow release, wallet updates, and double-entry ledger logs are performed atomically.
 */
exports.releaseOrderEscrow = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'لا تملك صلاحية تنفيذ هذه العملية');
  }
  const callerUserId = context.auth.uid;
  const { orderId, action, deliveryCode, receivedPhotoUrl } = data;

  if (!orderId) {
    throw new functions.https.HttpsError('invalid-argument', 'الطلب غير موجود');
  }

  // Wave 3 — the buyer's receipt confirmation runs through two layers on
  // purpose. This gate COUNTS wrong guesses; the transaction below re-verifies
  // the code as the authority. The split exists because the money transaction
  // cannot count failures — a mismatch there throws, and the rollback takes the
  // counter with it, leaving unlimited free guesses at a payout endpoint.
  //
  // Deliberately OUTSIDE the try/catch below, which maps unknown errors to
  // 'internal': the gate's own codes ('resource-exhausted', 'permission-denied',
  // 'failed-precondition') are what the buyer's UI branches on.
  //
  // Skipped entirely on an order that has already released: the transaction
  // below answers those idempotently ("تم تحرير هذا المبلغ سابقاً"), and running
  // the gate first would instead reject a duplicate confirm with
  // failed-precondition ("not out for delivery") — a wrong message on a stale
  // tab, and a break in the idempotent contract the rest of this callable keeps.
  if (action === 'buyer_confirm_receipt') {
    const preSnap = await db.collection('orders').doc(orderId).get();
    const pre = preSnap.exists ? (preSnap.data() || {}) : {};
    const alreadySettled = pre.escrowStatus === 'released' || pre.status === 'completed';

    if (!alreadySettled) {
      let gate;
      try {
        gate = await checkDeliveryConfirm(
          { db, Timestamp: admin.firestore.Timestamp, now: () => Date.now() },
          { orderId, buyerUid: callerUserId, typedCode: deliveryCode, receivedPhotoUrl }
        );
      } catch (gateError) {
        console.error('[releaseOrderEscrow] delivery-confirm gate rejected:', gateError && gateError.message);
        const code = ['not-found', 'permission-denied', 'failed-precondition', 'resource-exhausted', 'invalid-argument'].includes(gateError.code)
          ? gateError.code
          : 'internal';
        throw new functions.https.HttpsError(code, gateError.message || 'تعذر تأكيد الاستلام.');
      }
      if (!gate.matched) {
        // `details` carries the remaining-attempt count as DATA, so the client
        // can build the message in the user's own language instead of echoing
        // this Arabic string into an English UI. The message stays populated
        // for any caller that does not read details.
        throw new functions.https.HttpsError(
          'invalid-argument',
          `رمز التسليم غير مطابق. المحاولات المتبقية: ${gate.remaining}`,
          { reason: 'delivery_code_mismatch', remaining: gate.remaining }
        );
      }
    }
  }

  try {
    return await db.runTransaction(async (transaction) => {
      // 1. Read the order document from orders/{orderId}
      const orderRef = db.collection('orders').doc(orderId);
      const orderSnap = await transaction.get(orderRef);
      if (!orderSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'الطلب غير موجود');
      }
      const orderData = orderSnap.data();

      // 2. Validate basic properties of the order
      const buyerId = orderData.buyerId;
      const sellerId = orderData.sellerId;
      const auctionId = orderData.auctionId;

      if (!buyerId || !sellerId || !auctionId) {
        throw new functions.https.HttpsError('failed-precondition', 'بيانات الطلب غير مكتملة');
      }

      // Check authorization: Caller must be buyer OR admin
      const callerRef = db.collection('users').doc(callerUserId);
      const callerSnap = await transaction.get(callerRef);
      if (!callerSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'ملف المستخدم غير موجود');
      }
      const callerData = callerSnap.data();
      const isCallerAdmin = callerIsAdmin(callerData);
      const isCallerBuyer = callerUserId === buyerId;

      if (!isCallerAdmin && !isCallerBuyer) {
        throw new functions.https.HttpsError('permission-denied', 'لا تملك صلاحية تنفيذ هذه العملية');
      }

      // 12. Idempotency check: If order is already completed or escrow is already released
      if (orderData.escrowStatus === 'released' || orderData.status === 'completed') {
        return {
          success: true,
          alreadyReleased: true,
          message: "تم تحرير هذا المبلغ سابقاً"
        };
      }

      // 12b. Money-in guard: NEVER pay a seller out of a payment nobody checked.
      // The only human check that a CliQ receipt is real is the admin flipping
      // paymentVerified on verifyOrderPayment. Every path into this callable —
      // the buyer's "confirm delivery", the admin's one-click release in the
      // fulfillment queue — can be reached by an order that got to `paid` on a
      // forged receipt and was then hand-advanced through the relay, because
      // only the paid -> awaiting_shipment bucket rule ever consults this flag.
      // Placed AFTER the idempotency check on purpose: an order that already
      // released must still answer idempotently rather than start failing.
      if (!orderData.paymentVerified) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'Payment for this order has not been verified. Verify the buyer payment before releasing escrow.'
        );
      }

      // 12b-bis. Wave 3 — the LEGACY one-tap confirm must not become a way
      // around the evidence chain. `buyer_confirm_delivery` carries no code and
      // no photo, and nothing else in this callable constrains the status it may
      // run from, so a buyer whose order is `out_for_delivery` could otherwise
      // release their own escrow with the older action and skip step 3 entirely.
      // The UI stops offering that button there, but the UI is not the gate.
      //
      // Admin release / force close stay available at this status: the team must
      // be able to settle an order whose buyer has gone silent.
      if (action === 'buyer_confirm_delivery' && !isCallerAdmin && orderData.status === 'out_for_delivery') {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'أكّد الاستلام برمز التسليم الظاهر على الطرد.'
        );
      }

      // 12c. Wave 3 — AUTHORITATIVE preconditions for the buyer's receipt
      // confirmation. The gate above already checked these, but it ran in its
      // OWN transaction: between that commit and this one the status could have
      // moved, the seller's dispatch photo could have been cleared, or the code
      // document could have been rewritten. This is the check money actually
      // depends on; the gate is only the rate limiter.
      //
      // Placed AFTER the idempotency + money-in guards on purpose (same
      // reasoning as those): an order that already released must keep answering
      // idempotently rather than start failing on a stale code. Placed BEFORE
      // every write so the transaction stays reads-then-writes.
      if (action === 'buyer_confirm_receipt') {
        if (!isCallerBuyer) {
          throw new functions.https.HttpsError('permission-denied', 'لا يمكن تأكيد الاستلام إلا من المشتري.');
        }
        if (orderData.status !== 'out_for_delivery') {
          throw new functions.https.HttpsError('failed-precondition', 'هذا الطلب ليس في حالة "خرج للتوصيل".');
        }
        if (!orderData.sentPhotoUrl) {
          throw new functions.https.HttpsError('failed-precondition', 'لم يرفع البائع صورة الإرسال لهذا الطلب.');
        }
        if (!isHttpsUrl(receivedPhotoUrl)) {
          throw new functions.https.HttpsError('invalid-argument', 'صورة الاستلام مطلوبة.');
        }
        const codeSnap = await transaction.get(db.collection('deliveryCodes').doc(orderId));
        const storedCode = codeSnap.exists ? (codeSnap.data() || {}).code : null;
        if (!storedCode || normalizeDeliveryCodeInput(deliveryCode) !== storedCode) {
          throw new functions.https.HttpsError('invalid-argument', 'رمز التسليم غير مطابق.');
        }
      }

      // 3. Find the locked escrow document:
      let escrowRef = null;
      let escrowData = null;
      
      if (orderData.escrowId) {
        const directEscrowRef = db.collection('escrows').doc(orderData.escrowId);
        const directEscrowSnap = await transaction.get(directEscrowRef);
        if (directEscrowSnap.exists && directEscrowSnap.data().status === 'locked') {
          escrowRef = directEscrowRef;
          escrowData = directEscrowSnap.data();
        }
      }

      if (!escrowData) {
        const escrowQuery = await db.collection('escrows')
          .where('auctionId', '==', auctionId)
          .where('bidderId', '==', buyerId)
          .where('status', '==', 'locked')
          .limit(1)
          .get();

        if (!escrowQuery.empty) {
          escrowRef = escrowQuery.docs[0].ref;
          escrowData = escrowQuery.docs[0].data();
        }
      }

      // Under the membership model no escrow is created for bids, so a missing
      // escrow simply means there are no funds to move — the order must still complete.
      const hasEscrow = !!(escrowRef && escrowData);

      // 5. Determine amount for messaging/records
      let amountFils = 0;
      if (hasEscrow) {
        amountFils = escrowData.amountFils;
        if (!amountFils && escrowData.amount) {
          amountFils = Math.round(escrowData.amount * 1000);
        }
        if (!amountFils && orderData.winningBidAmount) {
          amountFils = Math.round(orderData.winningBidAmount * 1000);
        }

        if (!amountFils || amountFils <= 0) {
          throw new functions.https.HttpsError('failed-precondition', 'قيمة العملية غير صالحة');
        }
      } else if (orderData.winningBidAmount) {
        amountFils = Math.round(orderData.winningBidAmount * 1000);
      }

      const winningAmountJOD = amountFils / 1000;

      if (escrowRef && escrowData) {
        // 4. Read wallets (reads must precede writes inside the transaction)
        const buyerWalletRef = db.collection('wallets').doc(buyerId);
        const sellerWalletRef = db.collection('wallets').doc(sellerId);

        const buyerWalletSnap = await transaction.get(buyerWalletRef);
        const sellerWalletSnap = await transaction.get(sellerWalletRef);

        // 6. Validate balances
        const oldBuyerEscrow = buyerWalletSnap.exists ? (buyerWalletSnap.data().escrowBalance || 0) : 0;
        const oldBuyerAvail = buyerWalletSnap.exists ? (buyerWalletSnap.data().availableBalance || 0) : 0;

        if (oldBuyerEscrow < amountFils) {
          throw new functions.https.HttpsError('failed-precondition', 'رصيد المشتري المحجوز غير كافٍ');
        }

        // 7. Apply wallet movement
        const newBuyerEscrow = Math.max(0, oldBuyerEscrow - amountFils);
        const newBuyerTotal = oldBuyerAvail + newBuyerEscrow;

        // Seller receives the hammer MINUS Mazad's 5% seller commission (net 95 on
        // a 100 sale). The buyer's escrow is still debited the full hammer; the 5%
        // commission is retained by Mazad (not credited to the seller) — mirroring
        // how the 5% buyer premium is retained. Recorded on the ledger below.
        const commissionFils = sellerCommissionFils(amountFils);
        const sellerNetCreditFils = sellerNetFils(amountFils);
        const oldSellerAvail = sellerWalletSnap.exists ? (sellerWalletSnap.data().availableBalance || 0) : 0;
        const oldSellerEscrow = sellerWalletSnap.exists ? (sellerWalletSnap.data().escrowBalance || 0) : 0;
        const newSellerAvail = oldSellerAvail + sellerNetCreditFils;
        const newSellerTotal = newSellerAvail + oldSellerEscrow;

        // Execute Writes in Transaction
        transaction.set(buyerWalletRef, {
          userId: buyerId,
          availableBalance: oldBuyerAvail,
          escrowBalance: newBuyerEscrow,
          totalBalance: newBuyerTotal,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        transaction.set(sellerWalletRef, {
          userId: sellerId,
          availableBalance: newSellerAvail,
          escrowBalance: oldSellerEscrow,
          totalBalance: newSellerTotal,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // 8. Update escrow status
        transaction.update(escrowRef, {
          status: 'released',
          releasedAt: admin.firestore.FieldValue.serverTimestamp(),
          releasedBy: callerUserId,
          releaseReason: action || 'buyer_confirm_delivery',
          orderId: orderId
        });
      }

      // 9. Update order status
      transaction.update(orderRef, {
        status: 'completed',
        escrowStatus: 'released',
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        escrowReleasedAt: admin.firestore.FieldValue.serverTimestamp(),
        escrowReleasedBy: callerUserId,
        // Wave 3 — the buyer's half of the evidence chain, committed in the SAME
        // transaction as the money it releases. Conditional spread: every other
        // caller (admin release, force close, the legacy buyer confirm) has no
        // receipt photo, and Firestore rejects an explicit `undefined`.
        // deliveryCodeAttempts is zeroed because the code has now been used
        // successfully — a later admin looking at the order should not see a
        // stale failed-guess tally on a clean delivery.
        ...(action === 'buyer_confirm_receipt' ? {
          receivedPhotoUrl: String(receivedPhotoUrl).trim(),
          deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
          deliveryConfirmedBy: callerUserId,
          deliveryCodeAttempts: 0,
        } : {}),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      if (escrowRef && escrowData) {
        // 10. Create double-entry ledger records
        const buyerLedgerRef = db.collection('ledger').doc();
        const sellerLedgerRef = db.collection('ledger').doc();

        transaction.set(buyerLedgerRef, {
          id: buyerLedgerRef.id,
          userId: buyerId,
          orderId: orderId,
          auctionId: auctionId,
          amount: -winningAmountJOD,
          amountFils: -amountFils,
          type: 'escrow_released_to_seller',
          direction: 'debit',
          titleAr: 'تحرير الضمان المالي للطلب',
          titleEn: 'Escrow Released to Seller',
          descriptionAr: `تم تحرير مبلغ الضمان بقيمة ${winningAmountJOD} د.أ وتحويله إلى البائع.`,
          descriptionEn: `Escrow funds of ${winningAmountJOD} JOD released to seller.`,
          timestamp: Date.now()
        });

        const sellerNetJOD = sellerNetCreditFils / 1000;
        const commissionJOD = commissionFils / 1000;
        transaction.set(sellerLedgerRef, {
          id: sellerLedgerRef.id,
          userId: sellerId,
          orderId: orderId,
          auctionId: auctionId,
          amount: sellerNetJOD,
          amountFils: sellerNetCreditFils,
          type: 'sale_payment_received',
          direction: 'credit',
          titleAr: 'تحصيل دفعة مبيعات',
          titleEn: 'Sale Payment Received',
          descriptionAr: `تم استلام ${sellerNetJOD} د.أ (بعد خصم عمولة مزادو ٥٪) في رصيدك.`,
          descriptionEn: `Received ${sellerNetJOD} JOD (after 5% Mazad commission) into your available balance.`,
          timestamp: Date.now()
        });

        // Mazad's 5% seller commission — the CREDIT leg to the platform revenue
        // account, so the release event's double-entry balances to zero
        // (buyer escrow −hammer, seller +net, platform +commission) and the
        // seller's own ledger sums to exactly what their wallet was credited (net).
        if (commissionFils > 0) {
          const commissionLedgerRef = db.collection('ledger').doc();
          transaction.set(commissionLedgerRef, {
            id: commissionLedgerRef.id,
            userId: 'mazad-platform', // synthetic platform revenue account, not the seller
            sellerId: sellerId,
            orderId: orderId,
            auctionId: auctionId,
            amount: commissionJOD,
            amountFils: commissionFils,
            type: 'seller_commission',
            direction: 'credit',
            titleAr: 'عمولة مزادو (٥٪)',
            titleEn: 'Mazad Commission (5%)',
            descriptionAr: `عمولة المنصة ٥٪ بقيمة ${commissionJOD} د.أ على سعر البيع.`,
            descriptionEn: `5% platform commission (${commissionJOD} JOD) on the sale price.`,
            timestamp: Date.now()
          });
        }

        // 11. Create audit log
        const auditLogRef = db.collection('financialAuditLogs').doc();
        transaction.set(auditLogRef, {
          id: auditLogRef.id,
          action: 'release_order_escrow',
          orderId: orderId,
          auctionId: auctionId,
          buyerId: buyerId,
          sellerId: sellerId,
          amount: winningAmountJOD,
          amountFils: amountFils,
          triggeredBy: callerUserId,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      if (isCallerAdmin) {
        const adminActionsRef = db.collection('adminActions').doc();
        transaction.set(adminActionsRef, {
          id: adminActionsRef.id,
          orderId: orderId,
          action: action || 'release_escrow',
          adminId: callerUserId,
          adminName: callerData.name || 'Admin',
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          details: hasEscrow
            ? `Force released escrow of ${winningAmountJOD} JOD to seller for order ${orderId}`
            : `Force completed order ${orderId} (no escrow funds to move)`
        });
      }

      // Write Order Activity record
      const activityRef = orderRef.collection('activity').doc();
      let messageAr;
      let messageEn;
      if (hasEscrow) {
        messageAr = isCallerAdmin
          ? `قام المشرف بفرض إغلاق الطلب وتحرير الضمان المالي بقيمة ${winningAmountJOD} د.أ للبائع.`
          : `تم الإفراج عن الضمان المالي بقيمة ${winningAmountJOD} د.أ وتحويله إلى محفظة البائع بنجاح.`;
        messageEn = isCallerAdmin
          ? `Admin forced close order and released secure Escrow funds of ${winningAmountJOD} JOD to seller.`
          : `Escrow funds of ${winningAmountJOD} JOD released and securely deposited into seller's wallet.`;
      } else {
        messageAr = isCallerAdmin
          ? 'قام المشرف بفرض إغلاق الطلب وتأكيد اكتماله.'
          : 'تم تأكيد استلام الطلب واكتماله بنجاح.';
        messageEn = isCallerAdmin
          ? 'Admin forced close order and confirmed its completion.'
          : 'Delivery confirmed and order completed successfully.';
      }

      transaction.set(activityRef, {
        id: activityRef.id,
        type: hasEscrow ? 'Escrow Released' : 'Order Completed',
        messageAr: messageAr,
        messageEn: messageEn,
        message: messageEn,
        performedBy: callerUserId,
        performedByName: callerData.name || 'User',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      // Notifications for Buyer and Seller
      const buyerNotifRef = db.collection('notifications').doc();
      const sellerNotifRef = db.collection('notifications').doc();

      transaction.set(buyerNotifRef, {
        id: buyerNotifRef.id,
        userId: buyerId,
        title: 'تم اكتمال الطلب',
        titleAr: 'تم اكتمال الطلب',
        titleEn: 'Order Completed',
        description: hasEscrow
          ? `الطلب رقم ${orderId.substring(0, 8)} مكتمل. تم تحويل الضمان للبائع.`
          : `الطلب رقم ${orderId.substring(0, 8)} مكتمل بنجاح.`,
        descriptionAr: hasEscrow
          ? `الطلب رقم ${orderId.substring(0, 8)} مكتمل. تم تحويل الضمان للبائع.`
          : `الطلب رقم ${orderId.substring(0, 8)} مكتمل بنجاح.`,
        descriptionEn: hasEscrow
          ? `Order #${orderId.substring(0, 8)} has been completed. Escrow funds transferred to seller.`
          : `Order #${orderId.substring(0, 8)} has been completed.`,
        type: 'info',
        timestamp: Date.now(),
        read: false,
        orderId: orderId
      });

      transaction.set(sellerNotifRef, {
        id: sellerNotifRef.id,
        userId: sellerId,
        title: hasEscrow ? 'تحصيل رصيد مبيعات 🎉' : 'تم اكتمال الطلب 🎉',
        titleAr: hasEscrow ? 'تحصيل رصيد مبيعات 🎉' : 'تم اكتمال الطلب 🎉',
        titleEn: hasEscrow ? 'Sales Funds Collected 🎉' : 'Order Completed 🎉',
        description: hasEscrow
          ? `تم الإفراج عن مبلغ ${winningAmountJOD} د.أ وإضافته لرصيدك المتاح بنجاح!`
          : `الطلب رقم ${orderId.substring(0, 8)} مكتمل. أكد المشتري استلام الطلب.`,
        descriptionAr: hasEscrow
          ? `تم الإفراج عن مبلغ ${winningAmountJOD} د.أ وإضافته لرصيدك المتاح بنجاح!`
          : `الطلب رقم ${orderId.substring(0, 8)} مكتمل. أكد المشتري استلام الطلب.`,
        descriptionEn: hasEscrow
          ? `Funds of ${winningAmountJOD} JOD have been released to your available wallet balance.`
          : `Order #${orderId.substring(0, 8)} has been completed. The buyer confirmed delivery.`,
        type: 'win',
        timestamp: Date.now(),
        read: false,
        orderId: orderId
      });

      return {
        success: true,
        message: hasEscrow
          ? `تم تحرير مبلغ ${winningAmountJOD} د.أ بنجاح للبائع.`
          : 'تم اكتمال الطلب بنجاح.'
      };
    });
  } catch (error) {
    console.error('Error in releaseOrderEscrow:', error);
    const arabicMsg = error.message || "تعذر تحرير المبلغ، حاول مرة أخرى";
    throw new functions.https.HttpsError('internal', arabicMsg);
  }
});

/**
 * 12.5. refundOrderEscrow Callable Cloud Function (CRITICAL FIX REFUND)
 * Moves the financial logic of escrow refund to a secure transactional server-side environment.
 * Ensures order refunding, escrow refunding, wallet updates, and double-entry ledger logs are performed atomically.
 * Admin only.
 */
exports.refundOrderEscrow = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'لا تملك صلاحية تنفيذ هذه العملية');
  }
  const callerUserId = context.auth.uid;
  const { orderId, action } = data;

  if (!orderId) {
    throw new functions.https.HttpsError('invalid-argument', 'الطلب غير موجود');
  }

  try {
    return await db.runTransaction(async (transaction) => {
      // 1. Read the order document from orders/{orderId}
      const orderRef = db.collection('orders').doc(orderId);
      const orderSnap = await transaction.get(orderRef);
      if (!orderSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'الطلب غير موجود');
      }
      const orderData = orderSnap.data();

      // 2. Validate basic properties of the order
      const buyerId = orderData.buyerId;
      const sellerId = orderData.sellerId;
      const auctionId = orderData.auctionId;

      if (!buyerId || !sellerId || !auctionId) {
        throw new functions.https.HttpsError('failed-precondition', 'بيانات الطلب غير مكتملة');
      }

      // Check authorization: Caller must be admin ONLY
      const callerRef = db.collection('users').doc(callerUserId);
      const callerSnap = await transaction.get(callerRef);
      if (!callerSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'ملف المستخدم غير موجود');
      }
      const callerData = callerSnap.data();
      const isCallerAdmin = callerIsAdmin(callerData);

      if (!isCallerAdmin) {
        throw new functions.https.HttpsError('permission-denied', 'غير مصرح للقيام بهذه العملية، يجب أن تكون مشرفاً فقط');
      }

      // Idempotency check: If order is already refunded
      if (orderData.escrowStatus === 'refunded' || orderData.status === 'refunded') {
        return { 
          success: true, 
          alreadyRefunded: true, 
          message: "تم استرداد هذا المبلغ سابقاً" 
        };
      }

      // 3. Find the locked escrow document:
      let escrowRef = null;
      let escrowData = null;
      
      if (orderData.escrowId) {
        const directEscrowRef = db.collection('escrows').doc(orderData.escrowId);
        const directEscrowSnap = await transaction.get(directEscrowRef);
        if (directEscrowSnap.exists) {
          const status = directEscrowSnap.data().status;
          if (status === 'refunded') {
            return {
              success: true,
              alreadyRefunded: true,
              message: "تم استرداد هذا المبلغ سابقاً"
            };
          }
          if (status === 'locked') {
            escrowRef = directEscrowRef;
            escrowData = directEscrowSnap.data();
          }
        }
      }

      if (!escrowData) {
        // Filtered by status, like releaseOrderEscrow's equivalent fallback:
        // an auctionId+bidderId pair can have more than one escrow doc over
        // time (repair runs, re-bid/top-up flows), and an unfiltered
        // `.limit(1)` can return one that is neither 'locked' nor 'refunded'
        // (e.g. 'released' from an unrelated earlier flow) — this then fell
        // through with hasEscrow=false and quietly completed the order
        // without ever finding or moving the actually-locked escrow.
        const escrowQuery = await db.collection('escrows')
          .where('auctionId', '==', auctionId)
          .where('bidderId', '==', buyerId)
          .where('status', '==', 'locked')
          .limit(1)
          .get();

        if (!escrowQuery.empty) {
          const docSnap = escrowQuery.docs[0];
          escrowRef = docSnap.ref;
          escrowData = docSnap.data();
        } else {
          const refundedQuery = await db.collection('escrows')
            .where('auctionId', '==', auctionId)
            .where('bidderId', '==', buyerId)
            .where('status', '==', 'refunded')
            .limit(1)
            .get();
          if (!refundedQuery.empty) {
            return {
              success: true,
              alreadyRefunded: true,
              message: "تم استرداد هذا المبلغ سابقاً"
            };
          }
        }
      }

      // Under the membership model no escrow is created for bids, so a missing
      // escrow simply means there are no funds to move — the order must still be refunded.
      const hasEscrow = !!(escrowRef && escrowData);

      // 5. Determine amount for messaging/records
      let amountFils = 0;
      if (hasEscrow) {
        amountFils = escrowData.amountFils;
        if (!amountFils && escrowData.amount) {
          amountFils = Math.round(escrowData.amount * 1000);
        }
        if (!amountFils && orderData.winningBidAmount) {
          amountFils = Math.round(orderData.winningBidAmount * 1000);
        }

        if (!amountFils || amountFils <= 0) {
          throw new functions.https.HttpsError('failed-precondition', 'قيمة العملية غير صالحة');
        }
      } else if (orderData.winningBidAmount) {
        amountFils = Math.round(orderData.winningBidAmount * 1000);
      }

      const winningAmountJOD = amountFils / 1000;

      if (escrowRef && escrowData) {
        // 4. Read wallets (only buyer is credited; reads must precede writes)
        const buyerWalletRef = db.collection('wallets').doc(buyerId);
        const buyerWalletSnap = await transaction.get(buyerWalletRef);

        // 6. Validate balances
        const oldBuyerEscrow = buyerWalletSnap.exists ? (buyerWalletSnap.data().escrowBalance || 0) : 0;
        const oldBuyerAvail = buyerWalletSnap.exists ? (buyerWalletSnap.data().availableBalance || 0) : 0;

        if (oldBuyerEscrow < amountFils) {
          throw new functions.https.HttpsError('failed-precondition', 'رصيد المشتري المحجوز غير كافٍ');
        }

        // 7. Apply wallet movement (from escrow to available for buyer)
        const newBuyerEscrow = Math.max(0, oldBuyerEscrow - amountFils);
        const newBuyerAvail = oldBuyerAvail + amountFils;
        const newBuyerTotal = newBuyerAvail + newBuyerEscrow;

        // Execute Writes in Transaction
        transaction.set(buyerWalletRef, {
          userId: buyerId,
          availableBalance: newBuyerAvail,
          escrowBalance: newBuyerEscrow,
          totalBalance: newBuyerTotal,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // 8. Update escrow status
        transaction.update(escrowRef, {
          status: 'refunded',
          refundedAt: admin.firestore.FieldValue.serverTimestamp(),
          refundedBy: callerUserId,
          refundReason: action || 'admin_refund_dispute',
          orderId: orderId
        });
      }

      // 9. Update order status
      transaction.update(orderRef, {
        status: 'refunded',
        escrowStatus: 'refunded',
        refundedAt: admin.firestore.FieldValue.serverTimestamp(),
        escrowRefundedAt: admin.firestore.FieldValue.serverTimestamp(),
        escrowRefundedBy: callerUserId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      if (escrowRef && escrowData) {
        // 10. Create double-entry ledger records
        const buyerLedgerRef = db.collection('ledger').doc();
        const sellerLedgerRef = db.collection('ledger').doc();

        // Buyer Ledger: credit
        transaction.set(buyerLedgerRef, {
          id: buyerLedgerRef.id,
          userId: buyerId,
          orderId: orderId,
          auctionId: auctionId,
          amount: winningAmountJOD,
          amountFils: amountFils,
          type: 'escrow_refund',
          direction: 'credit',
          titleAr: 'استرداد الضمان المالي للطلب',
          titleEn: 'Escrow Refunded for Order',
          descriptionAr: `تم استرداد مبلغ الضمان بقيمة ${winningAmountJOD} د.أ وإعادته لمحافظتك بنجاح بعد إلغاء الطلب.`,
          descriptionEn: `Escrow funds of ${winningAmountJOD} JOD returned to your available balance.`,
          timestamp: Date.now()
        });

        // Seller Ledger: neutral / cancellation reference
        transaction.set(sellerLedgerRef, {
          id: sellerLedgerRef.id,
          userId: sellerId,
          orderId: orderId,
          auctionId: auctionId,
          amount: 0,
          amountFils: 0,
          type: 'order_refunded_neutral',
          direction: 'neutral',
          titleAr: 'إلغاء الطلب واسترداد الضمان للمشتري',
          titleEn: 'Order Cancelled and Escrow Refunded',
          descriptionAr: `تم إلغاء الطلب واسترجاع الضمان بقيمة ${winningAmountJOD} د.أ للمشتري بقرار من الإدارة.`,
          descriptionEn: `Order cancelled and escrow of ${winningAmountJOD} JOD refunded to the buyer.`,
          timestamp: Date.now()
        });

        // 11. Create audit log
        const auditLogRef = db.collection('financialAuditLogs').doc();
        transaction.set(auditLogRef, {
          id: auditLogRef.id,
          action: 'refund_order_escrow',
          orderId: orderId,
          auctionId: auctionId,
          buyerId: buyerId,
          sellerId: sellerId,
          amount: winningAmountJOD,
          amountFils: amountFils,
          triggeredBy: callerUserId,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      // Admin Action Log
      const adminActionsRef = db.collection('adminActions').doc();
      transaction.set(adminActionsRef, {
        id: adminActionsRef.id,
        orderId: orderId,
        action: action || 'refund_order_escrow',
        adminId: callerUserId,
        adminName: callerData.name || 'Admin',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        details: hasEscrow
          ? `Force refunded escrow of ${winningAmountJOD} JOD to buyer for order ${orderId}`
          : `Force refunded (cancelled) order ${orderId} (no escrow funds to move)`
      });

      // Write Order Activity record
      const activityRef = orderRef.collection('activity').doc();
      const messageAr = hasEscrow
        ? `قام المشرف بفرض إلغاء الطلب واسترداد الضمان المالي بقيمة ${winningAmountJOD} د.أ للمشتري.`
        : 'قام المشرف بفرض إلغاء الطلب وإرجاعه.';
      const messageEn = hasEscrow
        ? `Admin forced refund. Escrow funds of ${winningAmountJOD} JOD returned to buyer's available wallet.`
        : 'Admin forced refund. Order has been cancelled and marked as refunded.';

      transaction.set(activityRef, {
        id: activityRef.id,
        type: hasEscrow ? 'Escrow Refunded' : 'Order Refunded',
        messageAr: messageAr,
        messageEn: messageEn,
        message: messageEn,
        performedBy: callerUserId,
        performedByName: callerData.name || 'Admin',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      // Notifications for Buyer and Seller
      const buyerNotifRef = db.collection('notifications').doc();
      const sellerNotifRef = db.collection('notifications').doc();

      transaction.set(buyerNotifRef, {
        id: buyerNotifRef.id,
        userId: buyerId,
        title: hasEscrow ? 'استرداد الضمان المالي للطلب 💸' : 'تم إلغاء الطلب 💸',
        titleAr: hasEscrow ? 'استرداد الضمان المالي للطلب 💸' : 'تم إلغاء الطلب 💸',
        titleEn: hasEscrow ? 'Order Escrow Refunded 💸' : 'Order Refunded 💸',
        description: hasEscrow
          ? `تم إرجاع مبلغ الضمان بقيمة ${winningAmountJOD} د.أ إلى رصيدك المتاح بنجاح لعدم اكتمال الطلب.`
          : `تم إلغاء الطلب رقم ${orderId.substring(0, 8)} وإرجاعه بنجاح.`,
        descriptionAr: hasEscrow
          ? `تم إرجاع مبلغ الضمان بقيمة ${winningAmountJOD} د.أ إلى رصيدك المتاح بنجاح لعدم اكتمال الطلب.`
          : `تم إلغاء الطلب رقم ${orderId.substring(0, 8)} وإرجاعه بنجاح.`,
        descriptionEn: hasEscrow
          ? `A pending escrow of ${winningAmountJOD} JOD has been returned to your wallet available balance.`
          : `Order #${orderId.substring(0, 8)} has been cancelled and refunded.`,
        type: 'info',
        timestamp: Date.now(),
        read: false,
        orderId: orderId
      });

      transaction.set(sellerNotifRef, {
        id: sellerNotifRef.id,
        userId: sellerId,
        title: 'تم إلغاء واسترداد الطلب',
        titleAr: 'تم إلغاء واسترداد الطلب',
        titleEn: 'Order Cancelled & Refunded',
        description: hasEscrow
          ? `تم إلغاء الطلب رقم ${orderId.substring(0, 8)} واسترجاع الضمان المالي للمشتري.`
          : `تم إلغاء الطلب رقم ${orderId.substring(0, 8)}.`,
        descriptionAr: hasEscrow
          ? `تم إلغاء الطلب رقم ${orderId.substring(0, 8)} واسترجاع الضمان المالي للمشتري.`
          : `تم إلغاء الطلب رقم ${orderId.substring(0, 8)}.`,
        descriptionEn: hasEscrow
          ? `Order #${orderId.substring(0, 8)} has been cancelled and funds refunded to the buyer.`
          : `Order #${orderId.substring(0, 8)} has been cancelled.`,
        type: 'alert',
        timestamp: Date.now(),
        read: false,
        orderId: orderId
      });

      return {
        success: true,
        message: hasEscrow
          ? `تم استرداد مبلغ ${winningAmountJOD} د.أ بنجاح للمشتري.`
          : 'تم إلغاء الطلب وإرجاعه بنجاح.'
      };
    });
  } catch (error) {
    console.error('Error in refundOrderEscrow:', error);
    const arabicMsg = error.message || "تعذر استرداد المبلغ، حاول مرة أخرى";
    throw new functions.https.HttpsError('internal', arabicMsg);
  }
});

/**
 * 13. repairStuckEscrowsForEndedAuction Callable Cloud Function (PHASE 1.5)
 * Safely refunds stuck bid escrows for losing bidders of ended auctions.
 * Admin only. Fully transactional, safe, and idempotent.
 */
exports.repairStuckEscrowsForEndedAuction = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول أولاً');
  }
  const callerUserId = context.auth.uid;
  const { auctionId } = data;

  if (!auctionId) {
    throw new functions.https.HttpsError('invalid-argument', 'معرف المزاد غير صحيح أو مفقود');
  }

  try {
    return await db.runTransaction(async (transaction) => {
      // 1. Check if caller is admin
      const callerRef = db.collection('users').doc(callerUserId);
      const callerSnap = await transaction.get(callerRef);
      if (!callerSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'ملف المستخدم الخاص بالمشرف غير موجود');
      }
      const callerData = callerSnap.data();
      const isCallerAdmin = callerIsAdmin(callerData);

      if (!isCallerAdmin) {
        throw new functions.https.HttpsError('permission-denied', 'عذراً، هذا الإجراء مخصص للمشرفين فقط');
      }

      // 2. Read auction document
      const auctionRef = db.collection('auctions').doc(auctionId);
      const auctionSnap = await transaction.get(auctionRef);
      if (!auctionSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'المزاد المحدد غير موجود');
      }
      const auctionData = auctionSnap.data();

      // 3. Validate auction status is ended/completed/closed
      const endedStatuses = ['ended', 'completed', 'closed'];
      if (!endedStatuses.includes(auctionData.status)) {
        throw new functions.https.HttpsError('failed-precondition', 'المزاد لم ينتهِ بعد أو ليس في حالة مكتملة');
      }

      // 4. Determine whose escrow is NOT a loser's.
      //
      // BOTH orders are read: a lot whose winner defaulted carries the dead
      // order at orders/{auctionId} and the live one at orders/{auctionId}__sc.
      // Reading only the base doc named the DEFAULTER, which would keep their
      // escrow locked and refund the runner-up who actually paid. The rule
      // lives in escrowRepair.resolveEscrowWinner so it is covered
      // behaviourally rather than by reading this function's source.
      const orderRef = db.collection('orders').doc(auctionId);
      const scOrderRef = db.collection('orders').doc(secondChanceOrderId(auctionId));
      const [orderSnap, scOrderSnap] = await Promise.all([
        transaction.get(orderRef),
        transaction.get(scOrderRef),
      ]);

      const { winnerId, activeBuyerId, source: winnerSource } = resolveEscrowWinner({
        auction: auctionData,
        baseOrder: orderSnap.exists ? orderSnap.data() : null,
        secondChanceOrder: scOrderSnap.exists ? scOrderSnap.data() : null,
      });
      console.log(`[repairStuckEscrows] ${auctionId}: winner=${winnerId || 'none'} via ${winnerSource}`);

      // 5. Query all locked escrows for this auction inside the transaction
      const escrowsQuery = await transaction.get(
        db.collection('escrows')
          .where('auctionId', '==', auctionId)
          .where('status', '==', 'locked')
      );

      if (escrowsQuery.empty) {
        return {
          success: true,
          refundedCount: 0,
          keptWinnerEscrow: false,
          totalRefundedAmount: 0,
          message: 'لا توجد ضمانات مالية محجوزة/مغلقة لهذا المزاد لتعديلها.'
        };
      }

      const escrowDocs = escrowsQuery.docs;

      // Filter losing escrows to refund
      const losingEscrowDocs = [];
      let keptWinnerEscrow = false;

      for (const escDoc of escrowDocs) {
        const escData = escDoc.data();
        const bidderId = escData.bidderId;

        // Delegated: this line was previously inline, and a review inverted it
        // (keep every loser, refund the winner) with the whole suite green,
        // because a source-regex test cannot execute a decision.
        if (shouldRefundEscrow({ bidderId, winnerId, activeBuyerId })) {
          losingEscrowDocs.push(escDoc);
        } else {
          keptWinnerEscrow = true;
        }
      }

      if (losingEscrowDocs.length === 0) {
        return {
          success: true,
          refundedCount: 0,
          keptWinnerEscrow,
          totalRefundedAmount: 0,
          message: keptWinnerEscrow 
            ? 'الضمان المالي الوحيد المحجوز يعود للفائز بالمزاد، وتم إبقاؤه محجوزاً بنجاح.'
            : 'لا توجد ضمانات للمزايدين الخاسرين متبقية لتسويتها.'
        };
      }

      // 6. Fetch unique bidder wallet references we need to read first
      const uniqueBidderIds = [...new Set(losingEscrowDocs.map(d => d.data().bidderId))];
      const walletRefs = {};
      const walletStates = {};

      for (const bidderId of uniqueBidderIds) {
        const walletRef = db.collection('wallets').doc(bidderId);
        const walletSnap = await transaction.get(walletRef);
        walletRefs[bidderId] = walletRef;
        if (walletSnap.exists) {
          const wData = walletSnap.data();
          walletStates[bidderId] = {
            availableBalance: wData.availableBalance || 0,
            escrowBalance: wData.escrowBalance || 0,
            exists: true
          };
        } else {
          walletStates[bidderId] = {
            availableBalance: 0,
            escrowBalance: 0,
            exists: false
          };
        }
      }

      let refundedCount = 0;
      let totalRefundedAmount = 0;

      // 7. Perform updates
      for (const escDoc of losingEscrowDocs) {
        const escRef = escDoc.ref;
        const escData = escDoc.data();
        const bidderId = escData.bidderId;

        const refundAmtFils = escData.amountFils || Math.round((escData.amount || 0) * 1000);
        const refundAmtJOD = escData.amount || (refundAmtFils / 1000);

        // Update escrow document
        transaction.update(escRef, {
          status: 'refunded',
          refundedAt: admin.firestore.FieldValue.serverTimestamp(),
          refundReason: 'auction_lost_repair'
        });

        // Update memory balance state & write to transaction
        const wState = walletStates[bidderId];
        const oldAvail = wState.availableBalance;
        const oldEscrow = wState.escrowBalance;

        // Guard that releaseOrderEscrow and refundOrderEscrow both already
        // have. Without it a legacy doc that is `locked` against a zeroed
        // escrowBalance MINTS money into availableBalance, which
        // requestWithdrawal will pay out in cash. This fix widens the set of
        // escrows that reach here, so the gap had to close with it.
        if (oldEscrow < refundAmtFils) {
          throw new functions.https.HttpsError(
            'failed-precondition',
            `رصيد الضمان غير كافٍ للمزايد ${bidderId} — تعذر الاسترداد الآمن`
          );
        }
        const newEscrow = Math.max(0, oldEscrow - refundAmtFils);
        const newAvail = oldAvail + refundAmtFils;
        const newTotal = newAvail + newEscrow;

        wState.availableBalance = newAvail;
        wState.escrowBalance = newEscrow;
        wState.exists = true;

        const walletRef = walletRefs[bidderId];
        transaction.set(walletRef, {
          userId: bidderId,
          availableBalance: newAvail,
          escrowBalance: newEscrow,
          totalBalance: newTotal,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // Create ledger entry
        const ledgerRef = db.collection('ledger').doc();
        transaction.set(ledgerRef, {
          id: ledgerRef.id,
          userId: bidderId,
          auctionId: auctionId,
          amount: refundAmtJOD,
          amountFils: refundAmtFils,
          type: 'escrow_refund',
          direction: 'credit',
          reason: 'auction_lost_repair',
          titleAr: 'استرداد الضمان المالي للمزاد (إصلاح)',
          titleEn: 'Escrow Refund for Auction (Repair)',
          descriptionAr: `تم استرداد مبلغ الضمان بقيمة ${refundAmtJOD} د.أ تلقائياً لعدم اكتمال هذا المزاد (تشغيل نظام الإصلاح).`,
          descriptionEn: `Secure escrow refund of ${refundAmtJOD} JOD processed (Admin Repair run) for ended auction.`,
          timestamp: Date.now()
        });

        // Create financial audit log
        const auditLogRef = db.collection('financialAuditLogs').doc();
        transaction.set(auditLogRef, {
          id: auditLogRef.id,
          action: 'repair_stuck_escrow_refund',
          auctionId: auctionId,
          escrowId: escDoc.id,
          userId: bidderId,
          amount: refundAmtJOD,
          amountFils: refundAmtFils,
          triggeredBy: callerUserId,
          reason: 'auction_lost_repair',
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Send a notification to the outbid user
        const notificationRef = db.collection('notifications').doc();
        transaction.set(notificationRef, {
          id: notificationRef.id,
          userId: bidderId,
          title: 'استرداد ضمان مالي معلق 💸',
          titleAr: 'استرداد ضمان مالي معلق 💸',
          titleEn: 'Suspended Escrow Refunded 💸',
          description: `تم إرجاع مبلغ الضمان المعلق بقيمة ${refundAmtJOD} د.أ إلى محفظتك بنجاح بعد فحص المزاد المنتهي.`,
          descriptionAr: `تم إرجاع مبلغ الضمان المعلق بقيمة ${refundAmtJOD} د.أ إلى محفظتك بنجاح بعد فحص المزاد المنتهي.`,
          descriptionEn: `A pending escrow of ${refundAmtJOD} JOD has been returned to your wallet after checking ended auction.`,
          type: 'info',
          timestamp: Date.now(),
          read: false
        });

        refundedCount++;
        totalRefundedAmount += refundAmtJOD;
      }

      // Create Admin Action Log
      const adminActionsRef = db.collection('adminActions').doc();
      transaction.set(adminActionsRef, {
        id: adminActionsRef.id,
        auctionId: auctionId,
        action: 'repair_stuck_escrows',
        adminId: callerUserId,
        adminName: callerData.name || 'Admin',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        details: `Repaired stuck escrows for ended auction ${auctionId}. Refunded ${refundedCount} escrows for non-winners. Total amount: ${totalRefundedAmount} JOD.`
      });

      return {
        success: true,
        refundedCount,
        keptWinnerEscrow,
        totalRefundedAmount,
        // Gated: winnerId is now legitimately null on any lot whose order
        // died (defaulted / cancelled / rejected), and on those the tool
        // refunds EVERYONE. Claiming a winner's escrow was kept would be
        // backwards on exactly the new outcome an admin most needs to see.
        message: keptWinnerEscrow
          ? `تمت تسوية وإصلاح ${refundedCount} من الضمانات العالقة بنجاح بمجموع ${totalRefundedAmount} د.أ، وتم إبقاء ضمان الفائز محجوزاً.`
          : `تمت تسوية وإصلاح ${refundedCount} من الضمانات العالقة بنجاح بمجموع ${totalRefundedAmount} د.أ. لم يبقَ أي ضمان محجوزاً — لم يكتمل بيع هذه القطعة.`
      };
    });
  } catch (error) {
    console.error('Error in repairStuckEscrowsForEndedAuction:', error);
    const arabicMsg = error.message || 'تعذر تسوية الضمانات العالقة، حاول مرة أخرى';
    throw new functions.https.HttpsError('internal', arabicMsg);
  }
});

/**
 * 14. requestWithdrawal Callable Cloud Function (PHASE 1.6)
 * Secure, transactional, and client-immutable withdrawal request flow.
 */
exports.requestWithdrawal = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول أولاً');
  }

  const userId = context.auth.uid;
  const { amount, method, accountDetails } = data;

  if (!amount || typeof amount !== 'number' || amount <= 0) {
    throw new functions.https.HttpsError('invalid-argument', 'المبلغ المطلوب سحبه غير صحيح');
  }

  if (!method || (method !== 'cliq' && method !== 'bank')) {
    throw new functions.https.HttpsError('invalid-argument', 'طريقة السحب المحددة غير مدعومة');
  }

  if (!accountDetails || typeof accountDetails !== 'object') {
    throw new functions.https.HttpsError('invalid-argument', 'بيانات الحساب البنكي أو كليك ناقصة');
  }

  try {
    return await db.runTransaction(async (transaction) => {
      // 1. Read User Wallet
      const walletRef = db.collection('wallets').doc(userId);
      const walletSnap = await transaction.get(walletRef);

      if (!walletSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'المحفظة غير موجودة، يرجى تهيئتها أولاً');
      }

      const walletData = walletSnap.data();
      const oldAvailable = walletData.availableBalance || 0;
      const oldEscrow = walletData.escrowBalance || 0;
      const oldPendingWithdrawal = walletData.pendingWithdrawalBalance || 0;

      // Convert amount in JOD to fils (integers)
      const amountFils = Math.round(amount * 1000);

      // 2. Validate availableBalance >= amount
      if (oldAvailable < amountFils) {
        throw new functions.https.HttpsError('failed-precondition', 'المبلغ المطلوب يتجاوز الرصيد المتاح للسحب في محفظتك');
      }

      // 3. Move amount from availableBalance to pendingWithdrawalBalance
      const newAvailable = oldAvailable - amountFils;
      const newPendingWithdrawal = oldPendingWithdrawal + amountFils;
      const newTotal = newAvailable + oldEscrow + newPendingWithdrawal;

      // 4. Update user wallet
      transaction.update(walletRef, {
        availableBalance: newAvailable,
        pendingWithdrawalBalance: newPendingWithdrawal,
        totalBalance: newTotal,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // 5. Create withdrawals document with status "pending_review"
      const wId = `with-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const refId = 'TXN-' + Math.floor(100000 + Math.random() * 900000);
      const withdrawalRef = db.collection('withdrawals').doc(wId);

      transaction.set(withdrawalRef, {
        id: wId,
        userId: userId,
        amount: amount,
        amountFils: amountFils,
        type: method,
        status: 'pending_review',
        timestamp: Date.now(),
        details: accountDetails,
        referenceId: refId
      });

      // 6. Create ledger entry
      const ledgerRef = db.collection('ledger').doc();
      transaction.set(ledgerRef, {
        id: ledgerRef.id,
        userId: userId,
        amount: -amount,
        amountFils: -amountFils,
        type: 'withdrawal',
        direction: 'debit',
        reason: 'withdrawal_request',
        titleAr: method === 'cliq' ? 'طلب سحب كليك (قيد المراجعة)' : 'طلب سحب حوالة بنكية (قيد المراجعة)',
        titleEn: method === 'cliq' ? 'CliQ Withdrawal Request (Pending Review)' : 'Bank Withdrawal Request (Pending Review)',
        descriptionAr: `تم تقديم طلب سحب بقيمة ${amount} د.أ وهو قيد التدقيق والمراجعة.`,
        descriptionEn: `Withdrawal request of ${amount} JOD submitted and currently pending audit desk review.`,
        timestamp: Date.now()
      });

      // 7. Create financial audit log
      const auditLogRef = db.collection('financialAuditLogs').doc();
      transaction.set(auditLogRef, {
        id: auditLogRef.id,
        action: 'withdrawal_request',
        userId: userId,
        amount: amount,
        amountFils: amountFils,
        method: method,
        withdrawalId: wId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return {
        success: true,
        message: 'طلب السحب قيد المراجعة. سيتم التواصل معك بعد مراجعة الطلب.'
      };
    });
  } catch (error) {
    console.error('Error in requestWithdrawal:', error);
    const arabicMsg = error.message || 'عذراً، فشل تقديم طلب السحب المالي.';
    throw new functions.https.HttpsError('internal', arabicMsg);
  }
});

/**
 * 15. resetTestAuctionData Callable Cloud Function
 * Secure admin function to delete active/locked escrows of reset test auctions.
 * Directly prevents client-side write access to the escrows collection.
 */
exports.resetTestAuctionData = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول أولاً');
  }

  const callerUserId = context.auth.uid;

  try {
    // 1. Fetch caller's profile to verify admin privileges
    const callerSnap = await db.collection('users').doc(callerUserId).get();
    if (!callerSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'الملف الشخصي للمشرف غير موجود');
    }

    const callerData = callerSnap.data();
    const isCallerAdmin = callerIsAdmin(callerData);

    if (!isCallerAdmin) {
      throw new functions.https.HttpsError('permission-denied', 'غير مصرح للقيام بهذه العملية، يجب أن تكون مشرفاً');
    }

    const { auctionIds } = data;
    if (!auctionIds || !Array.isArray(auctionIds) || auctionIds.length === 0) {
      throw new functions.https.HttpsError('invalid-argument', 'مصفوفة معرّفات المزادات مطلوبة وغير صالحة');
    }

    // 2. Query locked escrows
    const escrowsSnap = await db.collection('escrows').where('status', '==', 'locked').get();
    const refsToDelete = [];

    escrowsSnap.forEach(docSnap => {
      const eData = docSnap.data();
      if (auctionIds.includes(eData.auctionId)) {
        refsToDelete.push(docSnap.ref);
      }
    });

    // 3. Delete in batches
    if (refsToDelete.length > 0) {
      const chunkSize = 400;
      for (let i = 0; i < refsToDelete.length; i += chunkSize) {
        const chunk = refsToDelete.slice(i, i + chunkSize);
        const batch = db.batch();
        chunk.forEach(ref => {
          batch.delete(ref);
        });
        await batch.commit();
      }
    }

    // 4. Log admin action
    const adminActionRef = db.collection('adminActions').doc();
    await adminActionRef.set({
      id: adminActionRef.id,
      action: 'reset_test_auctions_escrows',
      adminId: callerUserId,
      adminName: callerData.name || 'Admin',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      details: `Reset test auction escrows. Deleted ${refsToDelete.length} locked escrows associated with auctions: ${auctionIds.join(', ')}.`
    });

    return {
      success: true,
      deletedCount: refsToDelete.length,
      message: `تم مسح ${refsToDelete.length} من سجلات الضمان المالي للمزادات التجريبية بنجاح.`
    };
  } catch (error) {
    console.error('Error in resetTestAuctionData:', error);
    const arabicMsg = error.message || 'تعذر إعادة تعيين بيانات الإسكرو للمزادات التجريبية، حاول مرة أخرى لاحقاً';
    throw new functions.https.HttpsError('internal', arabicMsg);
  }
});

/**
 * 16. approveWithdrawal Callable Cloud Function
 * Secure admin-only withdrawal approval flow.
 */
exports.approveWithdrawal = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  // Warm ping from `warmAdminCallables`, ABOVE the auth check by design: below
  // it, it throws `unauthenticated` ~1,700x/day, burying real auth failures.
  // Reachable unauthenticated — accepted risk, see warmTargets.js header.
  if (data && data.__warm === true) return { warm: true };
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول أولاً');
  }

  const callerUserId = context.auth.uid;
  const { withdrawalId, transferRef } = data;

  if (!withdrawalId) {
    throw new functions.https.HttpsError('invalid-argument', 'معرّف طلب السحب مطلوب');
  }

  // A payout may not be marked complete without recording the transfer that
  // was actually made. Same discipline as the bankVerified gate on money
  // coming IN — see functions/payoutTransfer.js. Built BEFORE the transaction
  // so a missing reference fails fast and moves nothing.
  let transferStamp;
  try {
    transferStamp = buildPayoutTransferStamp(
      { Timestamp: admin.firestore.Timestamp, now: () => Date.now() },
      { transferRef, adminUid: callerUserId },
    );
  } catch (e) {
    throw new functions.https.HttpsError('invalid-argument', 'أدخل رقم عملية التحويل عبر كليك قبل اعتماد السحب.');
  }

  try {
    return await db.runTransaction(async (transaction) => {
      // 1. Verify admin privileges
      const callerRef = db.collection('users').doc(callerUserId);
      const callerSnap = await transaction.get(callerRef);
      if (!callerSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'الملف الشخصي للمشرف غير موجود');
      }

      const callerData = callerSnap.data();
      const isCallerAdmin = callerIsAdmin(callerData);

      if (!isCallerAdmin) {
        throw new functions.https.HttpsError('permission-denied', 'غير مصرح للقيام بهذه العملية، يجب أن تكون مشرفاً فقط');
      }

      // 2. Read Withdrawal Request
      const withdrawalRef = db.collection('withdrawals').doc(withdrawalId);
      const withdrawalSnap = await transaction.get(withdrawalRef);

      if (!withdrawalSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'طلب السحب غير موجود');
      }

      const withdrawalData = withdrawalSnap.data();

      // Idempotency / state checks
      if (withdrawalData.status === 'completed') {
        return { success: true, alreadyProcessed: true };
      }
      if (withdrawalData.status !== 'pending_review') {
        throw new functions.https.HttpsError('failed-precondition', 'حالة الطلب الحالية لا تسمح بالموافقة عليه');
      }

      const userId = withdrawalData.userId;
      const amount = withdrawalData.amount;
      const amountFils = withdrawalData.amountFils || Math.round(amount * 1000);

      // 3. Read Wallet
      const walletRef = db.collection('wallets').doc(userId);
      const walletSnap = await transaction.get(walletRef);

      if (!walletSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'المحفظة غير موجودة');
      }

      const walletData = walletSnap.data();
      const oldAvailable = walletData.availableBalance || 0;
      const oldEscrow = walletData.escrowBalance || 0;
      const oldPendingWithdrawal = walletData.pendingWithdrawalBalance || 0;

      if (oldPendingWithdrawal < amountFils) {
        throw new functions.https.HttpsError('failed-precondition', 'رصيد طلبات السحب المعلقة غير كافٍ');
      }

      // 4. Update Wallet: Deduct from pendingWithdrawalBalance
      const newPendingWithdrawal = Math.max(0, oldPendingWithdrawal - amountFils);
      const newTotal = oldAvailable + oldEscrow + newPendingWithdrawal;

      transaction.update(walletRef, {
        pendingWithdrawalBalance: newPendingWithdrawal,
        totalBalance: newTotal,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // 5. Update Withdrawal Document
      transaction.update(withdrawalRef, {
        status: 'completed',
        approvedBy: callerUserId,
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        // Proof the money actually left, not just that someone clicked approve.
        ...transferStamp,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // 6. Create ledger entry
      const ledgerRef = db.collection('ledger').doc();
      transaction.set(ledgerRef, {
        id: ledgerRef.id,
        userId: userId,
        amount: -amount,
        amountFils: -amountFils,
        type: 'withdrawal_approved',
        direction: 'debit',
        titleAr: 'اكتمل سحب الأموال',
        titleEn: 'Withdrawal Completed',
        descriptionAr: `تمت الموافقة على طلب السحب بقيمة ${amount} د.أ وتحويل الرصيد بنجاح.`,
        descriptionEn: `Withdrawal request of ${amount} JOD approved and successfully transferred.`,
        timestamp: Date.now()
      });

      // 7. Create audit log
      const auditLogRef = db.collection('financialAuditLogs').doc();
      transaction.set(auditLogRef, {
        id: auditLogRef.id,
        action: 'approve_withdrawal',
        userId: userId,
        amount: amount,
        amountFils: amountFils,
        withdrawalId: withdrawalId,
        triggeredBy: callerUserId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // 8. Create admin action log
      const adminActionRef = db.collection('adminActions').doc();
      transaction.set(adminActionRef, {
        id: adminActionRef.id,
        action: 'approve_withdrawal',
        adminId: callerUserId,
        adminName: callerData.name || 'Admin',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        details: `Approved withdrawal ID ${withdrawalId} of ${amount} JOD for user ${userId}`
      });

      // 9. Send Notification
      const notifRef = db.collection('notifications').doc();
      transaction.set(notifRef, {
        id: notifRef.id,
        userId: userId,
        title: 'تمت الموافقة على طلب السحب 🎉',
        titleAr: 'تمت الموافقة على طلب السحب 🎉',
        titleEn: 'Withdrawal Approved 🎉',
        description: `تمت الموافقة على طلب السحب بقيمة ${amount} د.أ وتحويل الرصيد بنجاح.`,
        descriptionAr: `تمت الموافقة على طلب السحب بقيمة ${amount} د.أ وتحويل الرصيد بنجاح.`,
        descriptionEn: `Your withdrawal of ${amount} JOD has been approved and successfully transferred.`,
        type: 'info',
        timestamp: Date.now(),
        read: false
      });

      return {
        success: true,
        message: 'تمت الموافقة على طلب السحب وتحرير الرصيد بنجاح'
      };
    });
  } catch (error) {
    console.error('Error in approveWithdrawal:', error);
    const arabicMsg = error.message || 'فشلت عملية الموافقة على طلب السحب المالي';
    throw new functions.https.HttpsError('internal', arabicMsg);
  }
});

/**
 * 17. rejectWithdrawal Callable Cloud Function
 * Secure admin-only withdrawal rejection flow.
 * Refunds the withdrawal amount back to user's available balance.
 */
exports.rejectWithdrawal = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  // Warm ping from `warmAdminCallables`, ABOVE the auth check by design: below
  // it, it throws `unauthenticated` ~1,700x/day, burying real auth failures.
  // Reachable unauthenticated — accepted risk, see warmTargets.js header.
  if (data && data.__warm === true) return { warm: true };
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول أولاً');
  }

  const callerUserId = context.auth.uid;
  const { withdrawalId, reason } = data;

  if (!withdrawalId) {
    throw new functions.https.HttpsError('invalid-argument', 'معرّف طلب السحب مطلوب');
  }

  try {
    return await db.runTransaction(async (transaction) => {
      // 1. Verify admin privileges
      const callerRef = db.collection('users').doc(callerUserId);
      const callerSnap = await transaction.get(callerRef);
      if (!callerSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'الملف الشخصي للمشرف غير موجود');
      }

      const callerData = callerSnap.data();
      const isCallerAdmin = callerIsAdmin(callerData);

      if (!isCallerAdmin) {
        throw new functions.https.HttpsError('permission-denied', 'غير مصرح للقيام بهذه العملية، يجب أن تكون مشرفاً فقط');
      }

      // 2. Read Withdrawal Request
      const withdrawalRef = db.collection('withdrawals').doc(withdrawalId);
      const withdrawalSnap = await transaction.get(withdrawalRef);

      if (!withdrawalSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'طلب السحب غير موجود');
      }

      const withdrawalData = withdrawalSnap.data();

      // Idempotency / state checks
      if (withdrawalData.status === 'rejected') {
        return { success: true, alreadyProcessed: true };
      }
      if (withdrawalData.status !== 'pending_review') {
        throw new functions.https.HttpsError('failed-precondition', 'حالة الطلب الحالية لا تسمح برفضه');
      }

      const userId = withdrawalData.userId;
      const amount = withdrawalData.amount;
      const amountFils = withdrawalData.amountFils || Math.round(amount * 1000);

      // 3. Read Wallet
      const walletRef = db.collection('wallets').doc(userId);
      const walletSnap = await transaction.get(walletRef);

      if (!walletSnap.exists) {
        throw new functions.https.HttpsError('not-found', 'المحفظة غير موجودة');
      }

      const walletData = walletSnap.data();
      const oldAvailable = walletData.availableBalance || 0;
      const oldEscrow = walletData.escrowBalance || 0;
      const oldPendingWithdrawal = walletData.pendingWithdrawalBalance || 0;

      if (oldPendingWithdrawal < amountFils) {
        throw new functions.https.HttpsError('failed-precondition', 'رصيد طلبات السحب المعلقة غير كافٍ');
      }

      // 4. Update Wallet: Refund back from pendingWithdrawalBalance to availableBalance
      const newPendingWithdrawal = Math.max(0, oldPendingWithdrawal - amountFils);
      const newAvailable = oldAvailable + amountFils;
      const newTotal = newAvailable + oldEscrow + newPendingWithdrawal;

      transaction.update(walletRef, {
        availableBalance: newAvailable,
        pendingWithdrawalBalance: newPendingWithdrawal,
        totalBalance: newTotal,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // 5. Update Withdrawal Document
      transaction.update(withdrawalRef, {
        status: 'rejected',
        rejectedBy: callerUserId,
        rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
        rejectionReason: reason || 'تم الرفض من الإدارة',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // 6. Create ledger entry
      const ledgerRef = db.collection('ledger').doc();
      transaction.set(ledgerRef, {
        id: ledgerRef.id,
        userId: userId,
        amount: amount,
        amountFils: amountFils,
        type: 'withdrawal_rejected',
        direction: 'credit',
        titleAr: 'رفض طلب السحب واستعادة الرصيد',
        titleEn: 'Withdrawal Rejected & Funds Returned',
        descriptionAr: `تم رفض طلب السحب بقيمة ${amount} د.أ وإرجاع المبلغ لمحفظتك. السبب: ${reason || 'تم الرفض من الإدارة'}`,
        descriptionEn: `Withdrawal request of ${amount} JOD rejected and funds returned. Reason: ${reason || 'Rejected by admin'}`,
        timestamp: Date.now()
      });

      // 7. Create audit log
      const auditLogRef = db.collection('financialAuditLogs').doc();
      transaction.set(auditLogRef, {
        id: auditLogRef.id,
        action: 'reject_withdrawal',
        userId: userId,
        amount: amount,
        amountFils: amountFils,
        withdrawalId: withdrawalId,
        triggeredBy: callerUserId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // 8. Create admin action log
      const adminActionRef = db.collection('adminActions').doc();
      transaction.set(adminActionRef, {
        id: adminActionRef.id,
        action: 'reject_withdrawal',
        adminId: callerUserId,
        adminName: callerData.name || 'Admin',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        details: `Rejected withdrawal ID ${withdrawalId} of ${amount} JOD for user ${userId}. Reason: ${reason || 'None'}`
      });

      // 9. Send Notification
      const notifRef = db.collection('notifications').doc();
      transaction.set(notifRef, {
        id: notifRef.id,
        userId: userId,
        title: '❌ تم رفض طلب السحب',
        titleAr: '❌ تم رفض طلب السحب',
        titleEn: 'Withdrawal Rejected ❌',
        description: `تم رفض طلب السحب بقيمة ${amount} د.أ وإرجاع الرصيد لمحفظتك. السبب: ${reason || 'تم الرفض من الإدارة'}`,
        descriptionAr: `تم رفض طلب السحب بقيمة ${amount} د.أ وإرجاع الرصيد لمحفظتك. السبب: ${reason || 'تم الرفض من الإدارة'}`,
        descriptionEn: `Your withdrawal of ${amount} JOD has been rejected and the funds returned to your balance. Reason: ${reason || 'Rejected by admin'}`,
        type: 'info',
        timestamp: Date.now(),
        read: false
      });

      return {
        success: true,
        message: 'تم رفض طلب السحب واستعادة الرصيد بنجاح'
      };
    });
  } catch (error) {
    console.error('Error in rejectWithdrawal:', error);
    const arabicMsg = error.message || 'فشلت عملية رفض طلب السحب المالي';
    throw new functions.https.HttpsError('internal', arabicMsg);
  }
});

/* =========================================================================
 * AUCTION SIMULATOR — Wave 1 (server callables, admin-only)
 *
 * Test harness for exercising the real auction engine end-to-end:
 *   simulateSpawnAuction — create a flagged (isSimulated) test auction
 *   simulateBid          — apply one rival bid via the SAME pricing +
 *                          anti-snipe rules as placeBid (shared helpers)
 *   simulateSettleNow    — force-settle via the SAME settleAuctionTxn the
 *                          closer cron uses (order + wonCount + webhooks)
 *   simulateCleanup      — wipe everything flagged isSimulated
 *
 * Every doc the simulator creates carries isSimulated: true so real metrics
 * can filter it out and cleanup can find it.
 * ========================================================================= */

const SIM_PLACEHOLDER_IMG = 'https://placehold.co/600x400/1a1a2e/f5b301?text=TEST+AUCTION';
// Wave 2 (media gallery): stable extra gallery images so simulated auctions
// exercise the swipeable MediaGallery end-to-end (video-less: image-only path).
const SIM_PLACEHOLDER_MEDIA_URLS = [
  'https://picsum.photos/id/1060/800/1200',
  'https://picsum.photos/id/201/800/1200',
  'https://picsum.photos/id/119/800/1200'
];
const SIM_BOT_ID = 'sim-bot';

exports.simulateSpawnAuction = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  const callerUid = await assertAdmin(context);
  const d = data || {};

  const category = (typeof d.category === 'string' && d.category.trim()) ? d.category.trim() : 'Electronics';
  const title = (typeof d.title === 'string' && d.title.trim()) ? d.title.trim() : `TEST — ${category}`;
  const startingPrice = (typeof d.startingPrice === 'number' && d.startingPrice > 0) ? d.startingPrice : 10;
  const durationSec = (typeof d.durationSec === 'number' && d.durationSec > 0) ? Math.round(d.durationSec) : 120;
  const channel = (typeof d.channel === 'string' && d.channel.trim()) ? d.channel.trim() : 'misc';
  const status = d.status === 'upcoming' ? 'upcoming' : 'live';

  try {
    const auctionRef = db.collection('auctions').doc();
    const doc = {
      id: auctionRef.id,
      isSimulated: true,
      title,
      description: 'Simulated auction (engine test) — removed by simulateCleanup.',
      category,
      channel,
      status,
      startingPrice,
      currentPrice: startingPrice,
      currentPriceFils: Math.round(startingPrice * 1000),
      minIncrement: Math.max(5, Math.round(startingPrice * 0.05)),
      totalBids: 0,
      duration: durationSec, // scheduledAuctionOpener uses this when opening an upcoming drop
      isApproved: true,
      approvalStatus: 'approved',
      ownershipAttested: true,
      attestedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdById: callerUid,
      sellerId: callerUid,
      sellerName: 'Simulator',
      thumbnailUrl: SIM_PLACEHOLDER_IMG,
      imageUrl: SIM_PLACEHOLDER_IMG,
      mediaUrls: SIM_PLACEHOLDER_MEDIA_URLS,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (status === 'live') {
      const endMs = Date.now() + durationSec * 1000;
      doc.endTime = endMs;
      doc.endsAt = admin.firestore.Timestamp.fromMillis(endMs);
      // Mirror the opener's go-live fields so the test auction is not counted
      // as a pending approval and sorts correctly in LiveStreamView.
      doc.approvedAt = admin.firestore.FieldValue.serverTimestamp();
      doc.approvedBy = 'simulateSpawnAuction';
      doc.openedAt = admin.firestore.FieldValue.serverTimestamp();
    } else {
      // scheduledAuctionOpener flips it live once scheduledStartAt arrives,
      // setting endTime = openedAt + duration (same as a real scheduled drop).
      doc.scheduledStartAt = Date.now() + 60 * 1000;
    }

    await auctionRef.set(doc);
    console.log(`[simulateSpawnAuction] Spawned ${status} test auction ${auctionRef.id} (${durationSec}s @ ${startingPrice} JOD) by ${callerUid}`);
    return { auctionId: auctionRef.id };
  } catch (error) {
    console.error('[simulateSpawnAuction]', error);
    throw new functions.https.HttpsError('internal', error.message || 'simulateSpawnAuction failed.');
  }
});

// Intentionally skips placeBid's 1.5s rate limit + membership checks: sim-bot
// has no user doc, and the client bot paces bids at 4-12s anyway.
exports.simulateBid = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  await assertAdmin(context);
  const { auctionId, bidderLabel } = data || {};
  if (!auctionId || typeof auctionId !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'auctionId is required.');
  }

  try {
    return await db.runTransaction(async (transaction) => {
      const auctionRef = db.collection('auctions').doc(auctionId);
      const auctionSnap = await transaction.get(auctionRef);
      // Soft no-ops (never throw): the client bid bot loops until the
      // auction ends, so a missing/ended auction just stops the loop.
      if (!auctionSnap.exists) {
        return { noop: true, reason: 'not_found' };
      }
      const auctionData = auctionSnap.data();
      // Never bid on a REAL auction: sim-bot would take currentBidderId,
      // onBidCreated would fire real outbid notifications, anti-snipe would
      // extend a live drop, and a sim-bot win would create a real order.
      if (auctionData.isSimulated !== true) {
        return { noop: true, reason: 'not_simulated' };
      }
      if (auctionData.status !== 'live' && auctionData.status !== 'active') {
        return { noop: true, reason: 'not_live' };
      }
      const endTimeMs = resolveAuctionEndMs(auctionData);
      if (endTimeMs && endTimeMs <= Date.now()) {
        return { noop: true, reason: 'ended' };
      }

      // Next valid bid per placeBid's rule (first bid = asking price,
      // afterwards currentPrice + minIncrement), then the shared write path
      // (bid doc + pricing fields + anti-snipe +15s under 10s).
      const { minRequiredFils } = bidPricing(auctionData);
      const { finalEndTime } = applyBidWrites(transaction, auctionRef, auctionData, {
        amountJod: minRequiredFils / 1000,
        amountFils: minRequiredFils,
        bidderId: SIM_BOT_ID,
        // PUBLIC write (same applyBidWrites path as placeBid) — mask the label.
        bidderName: maskBidderName((typeof bidderLabel === 'string' && bidderLabel.trim()) ? bidderLabel.trim() : 'Test Bidder'),
        endTimeMs: endTimeMs,
        isSimulated: true
      });

      return { currentPrice: minRequiredFils / 1000, endTime: finalEndTime };
    });
  } catch (error) {
    console.error('[simulateBid]', error);
    throw new functions.https.HttpsError('internal', error.message || 'simulateBid failed.');
  }
});

exports.simulateSettleNow = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  await assertAdmin(context);
  const { auctionId } = data || {};
  if (!auctionId || typeof auctionId !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'auctionId is required.');
  }

  try {
    const auctionRef = db.collection('auctions').doc(auctionId);
    const auctionSnap = await auctionRef.get();
    if (!auctionSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'Auction not found.');
    }
    const auctionData = auctionSnap.data();

    // Mirror the closer's gate: it only settles live/active auctions. This
    // also short-circuits already-settled (completed/ended) auctions, and
    // settleAuctionTxn's fresh in-txn status + order-exists guards make the
    // settle race-safe against the cron (no double order, no double webhook).
    if (auctionData.status !== 'live' && auctionData.status !== 'active') {
      return { settled: false, reason: `status_${auctionData.status || 'unknown'}` };
    }

    // Same settle path as scheduledAuctionCloser. settleAuctionTxn derives
    // the order's isSimulated flag from the fresh in-txn auction doc, so a
    // simulated auction yields a flagged order and force-settling a REAL
    // auction still produces a real (metric-visible) order.
    const result = await settleAuctionTxn(auctionRef, auctionData);

    const response = { settled: result.settled };
    if (result.orderId) {
      response.orderId = result.orderId;
    }
    return response;
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('[simulateSettleNow]', error);
    throw new functions.https.HttpsError('internal', error.message || 'simulateSettleNow failed.');
  }
});

exports.simulateCleanup = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  await assertAdmin(context);
  const deleted = { auctions: 0, bids: 0, orders: 0 };

  try {
    // 1. Simulated auctions — delete each auction's bids subcollection FIRST
    //    (bids live under auctions/{id}/bids; deleting the parent doc alone
    //    would orphan them). Everything under a simulated auction is test data.
    const auctionsSnap = await db.collection('auctions').where('isSimulated', '==', true).get();
    for (const auctionDoc of auctionsSnap.docs) {
      const bidsSnap = await auctionDoc.ref.collection('bids').get();
      deleted.bids += await deleteRefsInBatches(bidsSnap.docs.map((b) => b.ref));
    }
    deleted.auctions += await deleteRefsInBatches(auctionsSnap.docs.map((a) => a.ref));

    // 2. Simulated orders (created by simulateSettleNow via settleAuctionTxn).
    const ordersSnap = await db.collection('orders').where('isSimulated', '==', true).get();
    deleted.orders += await deleteRefsInBatches(ordersSnap.docs.map((o) => o.ref));

    // 3. Best-effort: stray simulated bids under NON-simulated auctions
    //    (simulateBid pointed at a real auction). Requires a collection-group
    //    index on bids.isSimulated — if it doesn't exist, log and move on.
    try {
      const straySnap = await db.collectionGroup('bids').where('isSimulated', '==', true).get();
      deleted.bids += await deleteRefsInBatches(straySnap.docs.map((b) => b.ref));
    } catch (cgErr) {
      console.warn('[simulateCleanup] stray-bid sweep skipped — create a Firestore collection-group index on bids.isSimulated for this sweep to work:', cgErr && cgErr.message);
    }

    // 4. Drop the sim-bot user doc so its settle-time wonCount increment
    //    never leaks into real user metrics. No-op if it doesn't exist.
    await db.collection('users').doc(SIM_BOT_ID).delete().catch(() => {});

    console.log('[simulateCleanup] deleted:', JSON.stringify(deleted));
    return { deleted };
  } catch (error) {
    console.error('[simulateCleanup]', error);
    throw new functions.https.HttpsError('internal', error.message || 'simulateCleanup failed.');
  }
});


// ─── WhatsApp OTP auth (unauthenticated gate to every account) ───────────────
// These two callables ARE the login. They mint no wallet/ledger/escrow state —
// a custom token is issued ONLY after checkOtp passes. Rate-limit + attempt
// bookkeeping lives in the whatsappOtps/{e164digits} doc (admin-SDK only; the
// firestore rule denies all client access). Responses are deliberately generic
// (ok:false / ok:true) so neither callable leaks whether an account exists.
const OTP_WINDOW_MS = 60 * 60 * 1000; // 1 hour rolling send window

// Firestore doc id for a normalized +962… number: digits only, no leading '+'.
function otpDocId(e164) {
  return e164.replace(/[^\d]/g, '');
}

// Step 2: request an OTP. UNauthenticated by design.
/**
 * Store an auction's reserve price. THE ONLY WRITE PATH for `auctionSecrets`
 * that a seller can reach.
 *
 * `auctionSecrets` is `allow write: if isAdmin()` and that rule is right — the
 * amount is a secret and a browser must not hold write access to it. The old
 * code ignored that and wrote the document straight from the seller's browser,
 * so Firestore denied it, the failure was swallowed into a console.warn, and
 * the lot went live carrying `reserveMet: false` with no amount stored. At
 * settlement the document was simply ABSENT — not an error, so the fail-closed
 * guard never fired — the reserve read as null, and null means "no reserve", so
 * the lot was awarded at whatever the top bid happened to be.
 *
 * The Admin SDK bypasses rules, which is exactly why the decision about WHO may
 * write has to be made here, explicitly, instead of being delegated to a rule
 * that no longer applies. Both halves of that decision are pure and unit-tested
 * in auctionReserve.js.
 *
 * Idempotent: called again with the same amount it simply rewrites it, so a
 * client retry after a network wobble is safe.
 */
exports.setAuctionReserve = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  const callerUid = context.auth && context.auth.uid;
  if (!callerUid) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول.');
  }

  const auctionId = data && typeof data.auctionId === 'string' ? data.auctionId.trim() : '';
  if (!auctionId) {
    throw new functions.https.HttpsError('invalid-argument', 'معرّف المزاد مفقود.');
  }

  // Rejecting an unusable amount rather than storing it is the point: a stored
  // 0 or NaN is a reserve that silently never blocks anything, which is the
  // failure mode this whole change exists to end.
  const reservePrice = normalizeReservePrice(data && data.reservePrice);
  if (reservePrice === null) {
    throw new functions.https.HttpsError('invalid-argument', 'سعر الحد الأدنى غير صالح.');
  }

  const auctionSnap = await db.collection('auctions').doc(auctionId).get();
  const auction = auctionSnap.exists ? auctionSnap.data() : null;

  let isAdmin = false;
  try {
    const callerSnap = await db.collection('users').doc(callerUid).get();
    const callerData = callerSnap.exists ? callerSnap.data() || {} : {};
    isAdmin = callerData.role === 'admin' || callerData.isAdmin === true;
  } catch (e) {
    // An unreadable caller doc is not admin. Fail closed on privilege.
    console.warn(`[setAuctionReserve] caller lookup failed for ${callerUid}:`, e && e.message);
  }

  const verdict = authorizeReserveWrite({ callerUid, isAdmin, auction });
  if (!verdict.ok) {
    const messages = {
      'not-found': 'المزاد غير موجود.',
      'permission-denied': 'لا تملك صلاحية تعديل هذا المزاد.',
      'unauthenticated': 'يجب تسجيل الدخول.',
    };
    throw new functions.https.HttpsError(verdict.code, messages[verdict.code] || 'غير مسموح.');
  }

  await db.collection('auctionSecrets').doc(auctionId).set({ reservePrice }, { merge: true });

  // `reserveMet: false` is the world-readable half — the boolean only, never the
  // amount. Settlement reads its PRESENCE to know a reserve was intended, so it
  // must be written whenever the secret is, or a lot could still settle as if it
  // had no reserve. Written here rather than trusted to the client for the same
  // reason the amount is.
  await db.collection('auctions').doc(auctionId).set({ reserveMet: false }, { merge: true });

  console.log(`[setAuctionReserve] reserve stored for ${auctionId} by ${callerUid}${isAdmin ? ' (admin)' : ''}`);
  return { success: true };
});

exports.requestWhatsappOtp = functions.runWith({ cors: true }).https.onCall(async (data) => {
  const e164 = normalizePhone(data && data.phone);
  if (!e164) {
    throw new functions.https.HttpsError('invalid-argument', 'رقم الهاتف غير صالح.');
  }

  const ref = db.collection('whatsappOtps').doc(otpDocId(e164));

  // Atomic gate+write: a concurrent burst can't slip past the cooldown /
  // per-hour cap, because the read, the canSendOtp check, and the record
  // write all happen inside one Firestore transaction (retries on contention).
  let sendCode = null;
  let retryAfterSec = Math.ceil(SEND_COOLDOWN_MS / 1000);
  await db.runTransaction(async (tx) => {
    sendCode = null; // reset each attempt (txn callback can retry on contention)
    const snap = await tx.get(ref);
    const record = snap.exists ? snap.data() : null;

    const gate = canSendOtp(record, Date.now(), {
      cooldownMs: SEND_COOLDOWN_MS,
      windowMs: OTP_WINDOW_MS,
      maxPerWindow: MAX_SENDS_PER_HOUR,
    });
    if (!gate.ok) {
      retryAfterSec = gate.retryAfterSec;
      return;
    }

    const now = Date.now();
    const code = generateOtpCode();
    const salt = crypto.randomBytes(16).toString('hex');

    // Rolling-window bookkeeping: fresh window on first send or after it elapses.
    let windowStartAt;
    let sendCount;
    if (record && now - (record.windowStartAt || 0) < OTP_WINDOW_MS) {
      windowStartAt = record.windowStartAt || now;
      sendCount = (record.sendCount || 0) + 1;
    } else {
      windowStartAt = now;
      sendCount = 1;
    }

    // set fully replaces the old doc (resets attempts, drops any stale hash),
    // so a previously-issued code can never verify.
    tx.set(ref, {
      codeHash: hashOtp(code, salt),
      salt,
      expiresAt: now + OTP_TTL_MS,
      attempts: 0,
      lastSentAt: now,
      windowStartAt,
      sendCount,
    });
    sendCode = code;
  });

  if (!sendCode) {
    // UX, not an error: tell the client to wait — never throw.
    return { ok: false, retryAfterSec };
  }

  // Never throws — and AFTER the commit, so a relay outage cannot cost the user
  // a code that was already issued.
  const delivered = await postOtpToRelay(e164, sendCode);

  /**
   * `ok` still means "a code was issued", which is what the verify step needs.
   * `delivered` is separate and new: whether the WhatsApp relay accepted it.
   *
   * The rate-limit bookkeeping in the transaction above is deliberately NOT
   * rolled back on a failed delivery. It is the abuse guard, and letting a
   * caller reset the 60s cooldown and the 5/hour window by forcing the relay to
   * fail is a worse problem than the one being fixed. The user is not stuck
   * either way: SMS is a different provider with its own limit, and the client
   * now routes there instead of waiting.
   */
  return { ok: true, delivered, retryAfterSec: Math.ceil(SEND_COOLDOWN_MS / 1000) };
});

// Step 3: verify an OTP and mint a custom token. UNauthenticated by design.
exports.verifyWhatsappOtp = functions.runWith({ cors: true }).https.onCall(async (data) => {
  const e164 = normalizePhone(data && data.phone);
  if (!e164) {
    throw new functions.https.HttpsError('invalid-argument', 'رقم الهاتف غير صالح.');
  }

  const ref = db.collection('whatsappOtps').doc(otpDocId(e164));

  // Atomic read→check→(increment | single-use-delete): a concurrent burst can't
  // exceed the MAX_ATTEMPTS lockout, and two racing verifies of the same code
  // can't both consume it (only one delete wins) — so a token is minted at most
  // once per issued code. The auth/token ops run OUTSIDE the txn, AFTER commit.
  let verified = false;
  await db.runTransaction(async (tx) => {
    verified = false; // reset each attempt (txn callback can retry on contention)
    const snap = await tx.get(ref);
    const record = snap.exists ? snap.data() : null;

    const res = checkOtp(record, data && data.code, Date.now());
    if (res.ok) {
      tx.delete(ref);       // single-use — atomic, so concurrent verifies can't double-mint
      verified = true;
    } else if (record) {
      // Attempt increment feeds the MAX_ATTEMPTS lockout. Generic ok:false — no leak.
      tx.update(ref, { attempts: (record.attempts || 0) + 1 });
    }
  });

  if (!verified) return { ok: false };

  // uid resolution + token mint are admin.auth() ops — outside the txn, only
  // reachable once the code has been atomically consumed.
  let uid;
  try {
    uid = (await admin.auth().getUserByPhoneNumber(e164)).uid;
  } catch (e) {
    if (e && e.code === 'auth/user-not-found') {
      try {
        uid = (await admin.auth().createUser({ phoneNumber: e164 })).uid;
      } catch (e2) {
        // concurrent create won the race — re-fetch the now-existing user
        if (e2 && e2.code === 'auth/phone-number-already-exists') {
          uid = (await admin.auth().getUserByPhoneNumber(e164)).uid;
        } else {
          throw e2;
        }
      }
    } else {
      throw e;
    }
  }

  const token = await admin.auth().createCustomToken(uid);
  return { ok: true, token };
});

// Step 3b (E5 contact completion): verify an OTP and ATTACH the phone to the
// CURRENT signed-in account. AUTHENTICATED — unlike verifyWhatsappOtp this mints
// NO token (the user is already signed in); it attaches the verified number to
// context.auth.uid via admin.auth().updateUser, preserving the uid — and thus the
// wallet/history. Same atomic read→checkOtp→(single-use-delete | attempt-increment)
// as verifyWhatsappOtp. NO wallet/ledger/escrow writes.
exports.attachWhatsappPhone = functions.runWith({ cors: true }).https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'يجب تسجيل الدخول لتنفيذ هذه العملية.');
  }
  const e164 = normalizePhone(data && data.phone);
  if (!e164) {
    throw new functions.https.HttpsError('invalid-argument', 'رقم الهاتف غير صالح.');
  }

  const ref = db.collection('whatsappOtps').doc(otpDocId(e164));

  // Same single-use, attempt-bounded consume as verifyWhatsappOtp: read→check→
  // (atomic delete on success | attempt-increment on miss). The auth op runs
  // OUTSIDE the txn, AFTER the code has been atomically consumed.
  let verified = false;
  await db.runTransaction(async (tx) => {
    verified = false; // reset each attempt (txn callback can retry on contention)
    const snap = await tx.get(ref);
    const record = snap.exists ? snap.data() : null;

    const res = checkOtp(record, data && data.code, Date.now());
    if (res.ok) {
      tx.delete(ref);       // single-use — atomic, so concurrent verifies can't double-consume
      verified = true;
    } else if (record) {
      tx.update(ref, { attempts: (record.attempts || 0) + 1 });
    }
  });

  if (!verified) return { ok: false };

  // Attach to the EXISTING session's uid — NO token minted (already authed).
  try {
    await admin.auth().updateUser(context.auth.uid, { phoneNumber: e164 });
  } catch (e) {
    // The number is already claimed by a DIFFERENT account — never merge/orphan;
    // surface a distinct code so the client can show "on another account".
    if (e && e.code === 'auth/phone-number-already-exists') {
      throw new functions.https.HttpsError('already-exists', 'هذا الرقم مسجّل على حساب آخر.');
    }
    throw e;
  }

  return { ok: true };
});







/* =========================================================================
 * CR-02 — daily "new auctions matching your interests" digest.
 *
 * Decisions live in ./dailyDigest.js, the run order in ./dailyDigestRun.js.
 * What is here is the wiring only: the relay call, the schedule, an admin
 * trigger, and the inbound opt-out webhook.
 * ========================================================================= */

/**
 * The send hour, as a CONFIG value rather than a literal in the cron string.
 *
 * Read at deploy time, because `.schedule()` is baked into the Cloud Scheduler
 * job — changing it needs a redeploy. That is fine and is a different lever
 * from the kill switch, which is read at RUN time precisely so stopping a send
 * never needs one.
 *
 * 19:00 Amman is the default: before the evening browsing peak. Worth A/B'ing
 * against 21:00, which is why it is a variable at all.
 */
const DIGEST_HOUR = (() => {
  const raw = Number(process.env.DIGEST_HOUR);
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : 19;
})();
const DIGEST_MINUTE = (() => {
  const raw = Number(process.env.DIGEST_MINUTE);
  return Number.isInteger(raw) && raw >= 0 && raw <= 59 ? raw : 0;
})();

// A misconfigured hour is silent otherwise: the job fires, the quiet-hours gate
// rejects it, and the logs read like a working cron that never sends.
if (DIGEST_HOUR >= DIGEST_QUIET_START || DIGEST_HOUR < DIGEST_QUIET_END) {
  console.warn(
    `[dailyDigest] DIGEST_HOUR=${DIGEST_HOUR} is inside quiet hours ` +
      `(${DIGEST_QUIET_START}:00-${DIGEST_QUIET_END}:00 Amman). Every run will exit without sending.`,
  );
}

/**
 * Hand one digest to the n8n relay. Returns whether it was ACCEPTED.
 *
 * Modelled on postOtpToRelay, not postToN8n: the fire-and-forget variant
 * returns nothing, and this caller has to know, because it writes the
 * notifications_log row that decides whether the user is ever told about these
 * lots again. Recording a send that never happened is how a lot goes missing
 * permanently.
 *
 * No n8n change is needed for this event. Build Messages forwards a non-blank
 * `wa_text` straight through (n8n/build-messages.js) and gates the send on
 * `channels.whatsapp` plus a plausible phone — so the workflow stays a
 * forwarder and the copy stays in this repo.
 */
async function postDigestToN8n({ phone, text, uid, lang }) {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) {
    console.warn('[dailyDigest] N8N_WEBHOOK_URL unset — cannot send.');
    return false;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'daily_digest',
        phone,
        email: '',
        name: '',
        // Explicitly NOT email and NOT in-app: this is a WhatsApp digest, and
        // an in-app copy of it would be a bell notification per evening that
        // nobody asked for.
        channels: { inapp: false, whatsapp: true, email: false },
        wa_text: text,
        // One key per user per calendar day, so a replayed webhook is
        // recognisable downstream even though the real guard is the log.
        idempotencyKey: `${uid}_daily_digest_${new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10)}`,
        lang,
        ts: Date.now(),
      }),
      // Longer than the 5s the money paths allow: nothing is waiting on this,
      // and a digest cut off at 5s would be logged as failed and retried.
      signal: AbortSignal.timeout(10000),
    });
    const delivered = await isRelayDelivered(res);
    if (!delivered) {
      // Log the BODY: the live failure mode is HTTP 200 with
      // {"success":false,"message":"Your Whatsapp Session is not connected"}.
      let detail = '';
      try {
        if (typeof res.clone === 'function') detail = (await res.clone().text() || '').slice(0, 300);
      } catch (_) { /* unreadable body */ }
      console.warn('[dailyDigest] relay rejected the send:', res && res.status, detail);
    }
    return delivered;
  } catch (e) {
    console.warn('[dailyDigest] relay send failed:', e && e.message);
    return false;
  }
}

/** Shared options for both entry points into the run. */
function digestDeps(extra) {
  return {
    db,
    send: postDigestToN8n,
    resolveLang: (user) => safeResolveLang(user, 'dailyDigest'),
    normalizePhone,
    serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
    ...extra,
  };
}

/** Record every run, dry or real, so a rehearsal is reviewable afterwards. */
async function recordDigestRun(summary) {
  try {
    await db.collection('notificationRuns').add({
      kind: 'daily_digest',
      at: admin.firestore.FieldValue.serverTimestamp(),
      ...summary,
    });
  } catch (e) {
    console.error('[dailyDigest] run summary write failed:', e && e.message);
  }
}

/**
 * The scheduled send. 540s and 512MB because the work is one relay round trip
 * per subscriber, bounded by the concurrency limit inside the run.
 */
exports.dailyInterestDigest = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .pubsub
  .schedule(`${DIGEST_MINUTE} ${DIGEST_HOUR} * * *`)
  .timeZone('Asia/Amman')
  .onRun(async () => {
    try {
      const summary = await runDailyDigest(digestDeps({}));
      await recordDigestRun(summary);
    } catch (e) {
      // A thrown run would be retried by the scheduler, and a retry is a
      // second evening message for everyone already sent. The per-user log cap
      // would catch that, but this is the cheaper place to stop it.
      console.error('[dailyDigest] run failed:', e);
    }
    return null;
  });

/**
 * Admin trigger. DRY RUN BY DEFAULT — `{ dryRun: false }` has to be passed
 * explicitly to send anything, because the obvious mistake here (calling it to
 * "see what it does") is the one that messages every subscriber at once.
 */
exports.runDailyDigestNow = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .https.onCall(async (data, context) => {
    await assertAdmin(context);
    const dryRun = !(data && data.dryRun === false);
    const summary = await runDailyDigest(digestDeps({ dryRun }));
    await recordDigestRun(summary);
    return { ok: true, dryRun, summary };
  });

/**
 * Inbound WhatsApp handler — the "إيقاف" path, called by n8n.
 *
 * Requires a shared secret and FAILS CLOSED without one. This endpoint edits
 * notification settings by phone number alone; unauthenticated, anyone who
 * guessed the URL could silence any customer, and silence is the one failure
 * this feature cannot detect on its own.
 */
exports.notificationsInbound = functions.https.onRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  const secret = process.env.N8N_INBOUND_SECRET;
  if (!secret) {
    console.error('[notificationsInbound] N8N_INBOUND_SECRET unset — refusing every request.');
    res.status(503).json({ ok: false, error: 'not_configured' });
    return;
  }
  const provided = String(req.get('x-mazad-signature') || (req.body && req.body.token) || '');
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return;
  }

  const body = req.body || {};
  const text = String(body.text || body.message || '');
  const stop = isStopMessage(text);
  const start = isStartMessage(text);
  if (!stop && !start) {
    // Not an opt-out. Say so plainly rather than guessing — a wrong guess here
    // either silences someone who asked a question, or ignores someone who
    // asked to be left alone.
    res.status(200).json({ ok: true, action: 'ignored' });
    return;
  }

  const e164 = normalizePhone(body.phone || body.from);
  if (!e164) {
    res.status(400).json({ ok: false, error: 'bad_phone' });
    return;
  }

  // The number may be on either field — phone signups write phoneNumber,
  // older profiles carry phone.
  let hit = null;
  for (const field of ['phoneNumber', 'phone']) {
    const snap = await db.collection('users').where(field, '==', e164).limit(1).get();
    if (!snap.empty) { hit = snap.docs[0]; break; }
  }
  if (!hit) {
    // Nothing to change, and we still answer 200: an unknown number is not an
    // error n8n should retry.
    res.status(200).json({ ok: true, action: 'unknown_number' });
    return;
  }

  const lang = safeResolveLang(hit.data(), 'notificationsInbound');
  const on = start;
  await hit.ref.update({
    notifyDaily: on,
    notifyFeatured: on,
    notifyChannel: on ? 'whatsapp' : 'none',
    notificationConsent: {
      granted: on,
      channel: on ? 'whatsapp' : 'none',
      at: admin.firestore.Timestamp.now(),
      source: on ? 'whatsapp-start' : 'whatsapp-stop',
    },
  });
  // Same append-only trail CR-01 writes. An opt-OUT is exactly as important to
  // be able to prove as an opt-in.
  try {
    await hit.ref.collection('consentEvents').add({
      granted: on,
      channel: on ? 'whatsapp' : 'none',
      notifyDaily: on,
      notifyFeatured: on,
      at: admin.firestore.FieldValue.serverTimestamp(),
      source: on ? 'whatsapp-start' : 'whatsapp-stop',
    });
  } catch (e) {
    console.error('[notificationsInbound] consent event write failed:', e && e.message);
  }

  res.status(200).json({
    ok: true,
    action: on ? 'resubscribed' : 'unsubscribed',
    // n8n sends this back verbatim, same contract as wa_text.
    wa_text: on
      ? (lang === 'en' ? 'Done — auction alerts are back on.' : 'تمام، رجّعنا التنبيهات. بنبعتلك أول ما ينزل إشي بيهمك.')
      : optOutConfirmation(lang),
  });
});
