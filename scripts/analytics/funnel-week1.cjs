#!/usr/bin/env node
'use strict';
/**
 * WEEK-1 FUNNEL PULL — READ ONLY, ALWAYS.
 *
 * WHY THIS FILE EXISTS. The 27 Sep 60-day plan names one unknown as the most
 * important in the business: "126 bids produced 4 sales. We do not know why."
 * The plan's own decision table says the fix depends entirely on WHICH of four
 * things happened, and that the answer "changes the priorities in this
 * document":
 *
 *   auctions did not meet reserve  -> lower reserves (easy)
 *   winners did not pay            -> existential; all ad spend is wasted
 *   auctions were still running     -> timing; not a problem at all
 *   many bids per auction           -> the ratio is misleading; 30 lots to 4
 *                                      sales is 13%, which is reasonable
 *
 * Those four have nothing in common except that one Firestore read separates
 * them. Until it is run, every downstream plan — reserve policy, the 20 JOD
 * minimum, the membership question, whether to resume influencer spend — is
 * being argued from a ratio nobody has decomposed. This script decomposes it.
 *
 * It also prints the exact weekly lines the plan asks for ("one number per
 * line, same format, every week"): auctions ended, auctions that met reserve,
 * winners who paid, completed sales, average sale value, commission earned,
 * failed handovers.
 *
 * WHAT IT REFUSES TO DO
 *
 *  1. It never writes. There is no set, update, delete, add, create or batch
 *     call in this file, and no --apply flag to add one. That is checkable
 *     rather than promised:
 *         grep -nE "\.(set|update|delete|add|create)\(|\.batch\(|bulkWriter" \
 *              scripts/analytics/funnel-week1.cjs
 *     must print nothing. (Uniqueness is tracked with plain objects, not Set,
 *     specifically so that grep stays clean.) It is safe against production,
 *     and it is meant to be: the alternative is guessing about live money.
 *
 *  2. It refuses to run without GOOGLE_APPLICATION_CREDENTIALS rather than
 *     falling back to any ambient credential it might find. A script that
 *     quietly attaches to whatever project the shell happens to be pointing at
 *     is a script that reports one environment's numbers as another's.
 *
 *  3. It prints AGGREGATES ONLY — counts, sums, percentiles. No document ids,
 *     no names, no phone numbers, no national ids, no payment references, no
 *     CliQ aliases. There is deliberately no --ids flag. The output of this
 *     script is meant to be committed to ops/data/, and CLAUDE.md forbids
 *     personal data in the repo. Several collections it reads DO carry PII
 *     (subscriptionRequests holds userName, userEmail, transferFullName and
 *     transferPhone); none of it is read into the report.
 *
 *  4. It states no targets and models no costs. Delivery cost, sourcing cost
 *     and ad spend are not in Firestore, so putting them here would mean
 *     hardcoding an assumption and printing it next to measured facts as if it
 *     were one. The unit-economics model lives in the COO report, where its
 *     assumptions are labelled. This file emits only what the database says.
 *
 * SCHEMA NOTES (read out of the code, not guessed — see the COO report for
 * file:line citations):
 *   - Bids are a SUBCOLLECTION: auctions/{id}/bids/{bidId}, with `amount`
 *     (JOD), `amountFils`, `bidderId`, `timestamp` (epoch ms).
 *   - An order's DOCUMENT ID IS THE AUCTION ID (functions/index.js:487).
 *   - Settlement writes exactly three terminal auction statuses
 *     (functions/settlement.js:98-158):
 *       'completed'        = had bids AND met reserve  -> a sale
 *       'reserve_not_met'  = had bids, did NOT clear the reserve
 *       'ended'            = no bids at all
 *   - The reserve AMOUNT is never on the auction doc; it lives in
 *     auctionSecrets/{auctionId}.reservePrice (admin-only). This script reads
 *     only whether the doc EXISTS and whether a reserve was recorded — never
 *     the amount, which would leak a live secret into a committed file.
 *   - endTime is epoch ms and may be NULL for a 'first_bid' lot whose clock
 *     never started. `null < now` is true, so an unguarded comparison reports
 *     every never-started lot as "ended". That guard is why `resolveEnd`
 *     exists.
 *   - Simulator rows carry isSimulated: true and are EXCLUDED by default
 *     (functions/index.js:6247 — "so real metrics" are not polluted).
 *
 * USAGE
 *   export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/mazadjoapp-key.json
 *   # firebase-admin is vendored by scripts/loadtest — see scripts/admin/README.md
 *   node scripts/analytics/funnel-week1.cjs                  # last 60 days
 *   node scripts/analytics/funnel-week1.cjs --days 7
 *   node scripts/analytics/funnel-week1.cjs --from 2026-08-01 --to 2026-10-01
 *   node scripts/analytics/funnel-week1.cjs --json > ops/data/2026-10-22-funnel.json
 *   node scripts/analytics/funnel-week1.cjs --include-simulated   # debugging only
 */

/**
 * Load a firebase-admin that actually has the API this script uses.
 *
 * A SUCCESSFUL REQUIRE IS NOT ENOUGH. The repo root carries firebase-admin
 * v14, whose modular API exposes `applicationDefault` at the top level and has
 * no `admin.credential`, no `admin.firestore()` and no `admin.auth()`. Requiring
 * it succeeds, and then the very next line dies with
 * "Cannot read properties of undefined (reading 'applicationDefault')" — an
 * error that points at the credential and blames the key, when the key is fine
 * and the module is simply the wrong shape.
 *
 * functions/ pins v11, which is the namespaced API this script is written
 * against. So: check the shape, take the first candidate that has it, and say
 * plainly what was rejected when none does.
 */
function loadAdmin() {
  const candidates = [
    '../../functions/node_modules/firebase-admin', // v11 — namespaced, what we want
    '../loadtest/node_modules/firebase-admin',
    'firebase-admin',
  ];
  const rejected = [];
  for (const c of candidates) {
    try {
      const mod = require(c.startsWith('.') ? require('path').join(__dirname, c) : c);
      if (mod && mod.credential && typeof mod.firestore === 'function' && typeof mod.auth === 'function') {
        return mod;
      }
      rejected.push(`${c} (loaded, but no namespaced credential/firestore/auth — likely v13+)`);
    } catch (e) {
      rejected.push(`${c} (${e.message.split('\n')[0]})`);
    }
  }
  console.error('\n  No usable firebase-admin found. Tried:');
  rejected.forEach((r) => console.error('    - ' + r));
  console.error('\n  This script needs the NAMESPACED API (admin.credential / admin.firestore()).');
  console.error('  functions/node_modules carries it. Run `npm ci` in functions/ if it is missing.\n');
  process.exit(1);
}

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const INCLUDE_SIM = argv.includes('--include-simulated');
const flag = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 ? (argv[i + 1] || '').trim() : '';
};

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error(
    '\n  GOOGLE_APPLICATION_CREDENTIALS is not set.\n' +
    '  This script reads production money data; it will not guess at credentials\n' +
    '  or fall back to an ambient login. Point it at a service-account key for\n' +
    '  the mazadjoapp project — see scripts/admin/README.md.\n'
  );
  process.exit(1);
}

const admin = loadAdmin();
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** Settlement's three terminal auction statuses (functions/settlement.js). */
const TERMINAL_AUCTION = ['completed', 'reserve_not_met', 'ended'];

/**
 * Order statuses meaning the buyer's money actually arrived — mirrors
 * PAID_OR_BEYOND in src/utils/orderStatusGlossary.ts. waiting_payment is
 * absent (money not in); refunded/defaulted/cancelled are absent (no sale
 * stands).
 */
const PAID_OR_BEYOND = ['paid', 'preparing_shipment', 'out_for_delivery', 'shipped', 'delivered', 'completed'];

/** Normalize Firestore Timestamp | epoch ms | ISO string -> epoch ms, or null. */
function ms(t) {
  if (t == null) return null;
  if (typeof t === 'number') return Number.isFinite(t) && t > 0 ? t : null;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (typeof t === 'object' && typeof t.seconds === 'number') return t.seconds * 1000;
  if (typeof t === 'object' && typeof t._seconds === 'number') return t._seconds * 1000;
  const p = Date.parse(t);
  return Number.isFinite(p) ? p : null;
}

/**
 * The auction's end instant, or null when it genuinely has none.
 *
 * MUST stay null-safe. A 'first_bid' lot that never received a bid carries
 * endTime: null, and `null < Date.now()` is true — comparing it directly would
 * file every never-started lot under "ended with zero bids" and inflate the
 * exact number this script exists to measure.
 */
function resolveEnd(a) {
  return ms(a.endsAt) != null ? ms(a.endsAt) : ms(a.endTime);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const jod = (v) => Math.round((v + Number.EPSILON) * 1000) / 1000;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function describe(values) {
  if (!values.length) return { n: 0 };
  const s = values.slice().sort((x, y) => x - y);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    sum: jod(sum),
    mean: jod(sum / s.length),
    min: s[0],
    p25: percentile(s, 25),
    median: percentile(s, 50),
    p75: percentile(s, 75),
    p90: percentile(s, 90),
    max: s[s.length - 1],
  };
}

/** Count occurrences into a plain object. */
function tally(obj, key) {
  const k = key == null || key === '' ? '<missing>' : String(key);
  obj[k] = (obj[k] || 0) + 1;
}

/**
 * Fulfilment bucket — a faithful CJS copy of bucketOrder() in
 * src/utils/fulfillmentQueues.ts. Kept in sync by hand because this script
 * must not import TypeScript. If that file changes, change this.
 */
function bucketOrder(o) {
  if (o.status === 'disputed') return null;
  if (o.status === 'waiting_payment') return 'awaiting_payment';
  if (o.status === 'paid' && o.paymentVerified === true) return 'awaiting_shipment';
  if (o.status === 'preparing_shipment') return 'awaiting_shipment';
  if (o.status === 'out_for_delivery') return 'awaiting_delivery';
  if (o.status === 'shipped') return 'awaiting_delivery';
  if (o.status === 'delivered') return 'awaiting_release';
  return null;
}

/** Wave 4 SLA: one 24-hour clock for every fulfilment bucket (fulfillmentQueues.ts). */
const THRESHOLDS = { awaiting_shipment: 24 * HOUR, awaiting_delivery: 24 * HOUR, awaiting_release: 24 * HOUR };
const DEFAULT_PAYMENT_WINDOW_HOURS = 24;

/**
 * A CliQ gateway request is still live on this order.
 *
 * Mirrors isCliqRequestLive() in functions/cliqPayment.js. This matters for
 * honesty: paymentDefaultEnforcer (functions/index.js:1619) SKIPS these orders,
 * so an order past its payment deadline with a live CliQ request is not a
 * non-payer — it is a payment in flight. Counting it as a default would
 * manufacture evidence for the plan's "existential" hypothesis.
 */
function isCliqRequestLive(o, nowMs) {
  if (o.cliqPaymentStatus !== 'pending') return false;
  const exp = ms(o.cliqRequestExpiresAt);
  return exp == null ? true : nowMs < exp;
}

/** Faithful CJS copy of isOverdue() in src/utils/fulfillmentQueues.ts. */
function isOverdue(o, updatedAtMs, nowMs) {
  const bucket = bucketOrder(o);
  if (!bucket || updatedAtMs == null) return false;
  if (bucket === 'awaiting_payment') {
    const deadline = ms(o.paymentDeadlineAt);
    if (deadline != null) return nowMs >= deadline;
    const h = num(o.paymentWindowHours);
    const win = h && h > 0 ? h : DEFAULT_PAYMENT_WINDOW_HOURS;
    return nowMs - updatedAtMs > win * HOUR;
  }
  return nowMs - updatedAtMs > THRESHOLDS[bucket];
}

async function main() {
  const now = Date.now();
  const toMs = flag('--to') ? Date.parse(flag('--to')) : now;
  const fromMs = flag('--from')
    ? Date.parse(flag('--from'))
    : toMs - (Number(flag('--days')) > 0 ? Number(flag('--days')) : 60) * DAY;

  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    console.error('  Bad window. Use --days N, or --from YYYY-MM-DD --to YYYY-MM-DD.');
    process.exit(1);
  }

  const report = {
    generatedAt: new Date(now).toISOString(),
    window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    simulatedRows: INCLUDE_SIM ? 'INCLUDED (debugging)' : 'excluded',
    caveats: [],
  };

  // These collections are small (tens to low thousands). Paging them whole is
  // cheaper and more internally consistent than a dozen filtered queries, and
  // it needs no composite indexes.
  const [auctionSnap, orderSnap, bidSnap, subSnap] = await Promise.all([
    db.collection('auctions').get(),
    db.collection('orders').get(),
    db.collectionGroup('bids').get(),
    db.collection('subscriptionRequests').get(),
  ]);

  const real = (d) => INCLUDE_SIM || d.isSimulated !== true;

  const auctions = {};
  auctionSnap.docs.forEach((d) => { const v = d.data() || {}; if (real(v)) auctions[d.id] = v; });
  const orders = {};
  orderSnap.docs.forEach((d) => { const v = d.data() || {}; if (real(v)) orders[d.id] = v; });

  report.collectionTotals = {
    auctionsAllTime: Object.keys(auctions).length,
    ordersAllTime: Object.keys(orders).length,
    bidsAllTime: bidSnap.docs.filter((d) => real(d.data() || {})).length,
    subscriptionRequestsAllTime: subSnap.size,
    simulatedExcluded: {
      auctions: auctionSnap.size - Object.keys(auctions).length,
      orders: orderSnap.size - Object.keys(orders).length,
    },
  };

  // ---- Bids, grouped by auction -------------------------------------------
  // `totalBids` on the auction doc is maintained in the same transaction as the
  // bid write (functions/index.js applyBidWrites), so it SHOULD equal the
  // subcollection count. We count the subcollection anyway and report any
  // disagreement: a counter that has drifted would silently distort every
  // bids-per-auction number below.
  const bidsByAuction = {};
  const biddersByAuction = {};
  const allBidderIds = {};
  let bidsInWindow = 0;
  bidSnap.docs.forEach((d) => {
    const b = d.data() || {};
    if (!real(b)) return;
    const aId = b.auctionId || d.ref.parent.parent.id;
    bidsByAuction[aId] = (bidsByAuction[aId] || 0) + 1;
    if (!biddersByAuction[aId]) biddersByAuction[aId] = {};
    if (b.bidderId) {
      biddersByAuction[aId][b.bidderId] = true;
      allBidderIds[b.bidderId] = true;
    }
    const t = ms(b.timestamp);
    if (t != null && t >= fromMs && t < toMs) bidsInWindow += 1;
  });

  // ---- THE WEEK-1 QUESTION -------------------------------------------------
  const ended = [];           // terminal auctions whose end instant is in window
  const stillRunning = { live: 0, upcoming: 0, processing: 0, other: 0 };
  const neverStarted = { n: 0, note: "first_bid lots with no endTime — clock never started, NOT 'ended'" };
  let terminalNoEndTime = 0;

  for (const id of Object.keys(auctions)) {
    const a = auctions[id];
    const end = resolveEnd(a);
    const terminal = TERMINAL_AUCTION.indexOf(a.status) !== -1;

    if (!terminal) {
      if (end == null && a.startMode === 'first_bid') neverStarted.n += 1;
      else if (a.status === 'live') stillRunning.live += 1;
      else if (a.status === 'upcoming') stillRunning.upcoming += 1;
      else if (a.status === 'processing') stillRunning.processing += 1;
      else stillRunning.other += 1;
      continue;
    }
    if (end == null) { terminalNoEndTime += 1; continue; }
    if (end < fromMs || end >= toMs) continue;
    ended.push({ id, a, end });
  }

  if (terminalNoEndTime > 0) {
    report.caveats.push(
      `${terminalNoEndTime} auction(s) carry a terminal status but no usable end instant; ` +
      'they are excluded from the window and from every rate below.'
    );
  }

  const metReserve = ended.filter((r) => r.a.status === 'completed');
  const missedReserve = ended.filter((r) => r.a.status === 'reserve_not_met');
  const zeroBidStatus = ended.filter((r) => r.a.status === 'ended');
  const trulyZeroBids = ended.filter((r) => (bidsByAuction[r.id] || 0) === 0);

  // The reserve-not-met bucket is NOT homogeneous, and the distinction decides
  // the fix. functions/settlement.js:126 returns reserve_not_met with
  // reserveUnverifiable when a reserve was INTENDED but its amount is missing
  // from auctionSecrets — a createListing permission bug, not a pricing
  // problem. "Lower the reserves" is the wrong response to those lots.
  // Reserve INTENT is recorded by the mere PRESENCE of the `reserveMet` field,
  // not its value (functions/orderRepair.js:126 — hasOwnProperty). createListing
  // omits the field entirely on a no-reserve lot, so absent means "no reserve
  // on this lot", never "unknown".
  const hasReserveField = (a) => Object.prototype.hasOwnProperty.call(a, 'reserveMet');
  const lotsWithAReserve = ended.filter((r) => hasReserveField(r.a)).length;

  let reserveDocsPresent = 0;
  const missedIds = missedReserve.map((r) => r.id);
  for (let i = 0; i < missedIds.length; i += 300) {
    const chunk = missedIds.slice(i, i + 300);
    const refs = chunk.map((id) => db.collection('auctionSecrets').doc(id));
    const snaps = await db.getAll.apply(db, refs);
    // Existence only. The reserve AMOUNT is a live secret and is never read
    // into this report.
    snaps.forEach((s) => { if (s.exists) reserveDocsPresent += 1; });
  }

  report.q1_auctionOutcomes = {
    endedInWindow: ended.length,
    metReserve_sold: metReserve.length,
    reserveNotMet: missedReserve.length,
    endedWithNoBids: zeroBidStatus.length,
    crossCheck_zeroBidsBySubcollection: trulyZeroBids.length,
    endedLotsCarryingAReserve: lotsWithAReserve,
    endedLotsWithNoReserveAtAll: ended.length - lotsWithAReserve,
    reserveNotMet_withReserveAmountRecorded: reserveDocsPresent,
    reserveNotMet_reserveAmountMissing: missedReserve.length - reserveDocsPresent,
    reserveAmountMissing_note:
      'A reserve_not_met lot with NO auctionSecrets doc did not fail on price — the ' +
      'reserve amount was never stored (createListing write denied). Lowering reserves ' +
      'does not fix these; fixing the write path does.',
    stillRunningNow: stillRunning,
    neverStarted,
    sellThroughVsReserve: ended.length ? jod(metReserve.length / ended.length) : null,
  };

  // ---- Bids per auction ----------------------------------------------------
  const bidCounts = ended.map((r) => bidsByAuction[r.id] || 0);
  const uniqueBidders = ended.map((r) => Object.keys(biddersByAuction[r.id] || {}).length);
  let counterDrift = 0;
  ended.forEach((r) => {
    const stored = num(r.a.totalBids);
    if (stored != null && stored !== (bidsByAuction[r.id] || 0)) counterDrift += 1;
  });

  report.q2_bidsPerAuction = {
    bidsPlacedInWindow: bidsInWindow,
    distributionAcrossEndedAuctions: describe(bidCounts),
    uniqueBiddersPerAuction: describe(uniqueBidders),
    auctionsWithOneBidOnly: bidCounts.filter((c) => c === 1).length,
    auctionsWithTwoPlusBids: bidCounts.filter((c) => c >= 2).length,
    distinctBiddersAllTime: Object.keys(allBidderIds).length,
    totalBidsCounterDisagreements: counterDrift,
    why:
      "The plan's fourth hypothesis: if bids cluster on few lots, the 126:4 ratio " +
      'is misleading and lot-level conversion is the honest denominator.',
  };

  // ---- Winners: paid vs not ------------------------------------------------
  // An order's doc id IS its auction id (functions/index.js:487).
  const orderStatus = {};
  let withOrder = 0, noOrder = 0, paidCount = 0, notPaid = 0;
  let defaulted = 0, waitingPaymentOverdue = 0, waitingPaymentInWindow = 0, waitingPaymentCliqLive = 0;
  const hammerPaid = [];
  let commissionStored = 0, commissionRecomputed = 0, storedFieldsMissing = 0;

  metReserve.forEach((r) => {
    const o = orders[r.id];
    if (!o) { noOrder += 1; return; }
    withOrder += 1;
    tally(orderStatus, o.status);

    const paid = PAID_OR_BEYOND.indexOf(o.status) !== -1;
    if (paid) {
      paidCount += 1;
      const h = num(o.winningBidAmount);
      if (h != null) {
        hammerPaid.push(h);
        const bp = num(o.buyersPremium);
        const sc = num(o.sellerCommission);
        if (bp != null && sc != null) commissionStored += bp + sc;
        else storedFieldsMissing += 1;
        commissionRecomputed += Math.round(h * 1000 * 0.05) / 1000 * 2;
      }
    } else {
      notPaid += 1;
      if (o.status === 'defaulted') defaulted += 1;
      if (o.status === 'waiting_payment') {
        if (isCliqRequestLive(o, now)) waitingPaymentCliqLive += 1;
        else if (isOverdue(o, ms(o.updatedAt) != null ? ms(o.updatedAt) : ms(o.createdAt), now)) waitingPaymentOverdue += 1;
        else waitingPaymentInWindow += 1;
      }
    }
  });

  report.q3_winnersPaid = {
    auctionsThatProducedAWinner: metReserve.length,
    ordersFound: withOrder,
    soldButNoOrderDocument: noOrder,
    soldButNoOrder_note:
      'A completed auction with no order is the anomaly repairEndedAuctionOrder exists for — ' +
      'a winner who was never invoiced. Counted separately because it is a bug, not a refusal to pay.',
    winnersWhoPaid: paidCount,
    winnersWhoDidNotPay: notPaid,
    ofWhich_formallyDefaulted: defaulted,
    ofWhich_waitingPaymentPastDeadline: waitingPaymentOverdue,
    ofWhich_waitingPaymentStillInWindow: waitingPaymentInWindow,
    ofWhich_cliqRequestStillLive: waitingPaymentCliqLive,
    cliqLive_note:
      'paymentDefaultEnforcer deliberately skips an order with a live CliQ request ' +
      '(functions/index.js:1619). These are payments in flight, NOT non-payers.',
    sweepLag_note:
      "'defaulted' is written only by paymentDefaultEnforcer, which runs every 30 minutes " +
      '(functions/index.js:1553). Up to 30 minutes of genuinely-defaulted orders will still ' +
      "read as 'past deadline, not yet swept'.",
    winnerPaymentRate: metReserve.length ? jod(paidCount / metReserve.length) : null,
    orderStatusDistribution: orderStatus,
    why:
      "The plan's second hypothesis, and the one it calls existential: if winners are " +
      'not paying, every dinar of traffic spend is wasted downstream of the bid.',
  };

  // ---- Completed sales, ASV, commission ------------------------------------
  const stats = describe(hammerPaid);
  report.q4_salesAndCommission = {
    completedSales_moneyReceived: hammerPaid.length,
    ordersReachingStatusCompleted: orderStatus.completed || 0,
    hammerPriceDistribution: stats,
    averageSaleValue_mean: stats.mean != null ? stats.mean : null,
    averageSaleValue_median: stats.median != null ? stats.median : null,
    grossMerchandiseValue: stats.sum != null ? stats.sum : 0,
    commissionEarned_fromStoredFields: jod(commissionStored),
    commissionEarned_recomputedAt10pct: jod(commissionRecomputed),
    ordersMissingStoredFeeFields: storedFieldsMissing,
    note:
      'Take = 5% buyer premium + 5% seller commission (functions/settlement.js:244,268). ' +
      'Both figures are shown so a disagreement between what was stored at settlement ' +
      'and what the current rate implies is visible rather than averaged away. ' +
      'Mean AND median are both reported: with a handful of sales a single large lot ' +
      'moves the mean and the median does not.',
  };

  // ---- Failed handovers ----------------------------------------------------
  // The plan's "one in three transactions failed because a seller became
  // unreachable after winning". Derivable, using the product's OWN definition:
  // src/utils/actionQueue.ts raises 'delivery_stalled' / 'seller_hasnt_prepped'
  // for an order sitting in awaiting_shipment past the 24h SLA.
  const handover = {
    paidOrdersConsidered: 0,
    sellerHasntPrepped_overdue: 0,
    buyerHasntConfirmed_overdue: 0,
    disputed: 0,
    refunded: 0,
    cancelled: 0,
    reachedDelivered: 0,
    reachedCompleted: 0,
    adminNudgedSeller_atLeastOnce: 0,
    adminNudgedSeller_totalNudges: 0,
  };
  metReserve.forEach((r) => {
    const o = orders[r.id];
    if (!o) return;
    if (o.status === 'disputed') handover.disputed += 1;
    if (o.status === 'refunded') handover.refunded += 1;
    if (o.status === 'cancelled') handover.cancelled += 1;
    if (o.status === 'delivered') handover.reachedDelivered += 1;
    if (o.status === 'completed') handover.reachedCompleted += 1;
    if (PAID_OR_BEYOND.indexOf(o.status) === -1) return;
    handover.paidOrdersConsidered += 1;
    const nudges = num(o.nudgeCount);
    if (nudges != null && nudges > 0) {
      handover.adminNudgedSeller_atLeastOnce += 1;
      handover.adminNudgedSeller_totalNudges += nudges;
    }
    const upd = ms(o.updatedAt) != null ? ms(o.updatedAt) : ms(o.createdAt);
    if (!isOverdue(o, upd, now)) return;
    const b = bucketOrder(o);
    if (b === 'awaiting_shipment') handover.sellerHasntPrepped_overdue += 1;
    if (b === 'awaiting_delivery' || b === 'awaiting_release') handover.buyerHasntConfirmed_overdue += 1;
  });
  handover.failedHandoverRate_sellerSide = handover.paidOrdersConsidered
    ? jod(handover.sellerHasntPrepped_overdue / handover.paidOrdersConsidered)
    : null;
  handover.definition =
    "'Seller unreachable after winning' = a PAID order still in awaiting_shipment past the " +
    '24h SLA. This is the product\'s own rule (bucketOrder + isOverdue in ' +
    'src/utils/fulfillmentQueues.ts, surfaced as seller_hasnt_prepped in actionQueue.ts), ' +
    'not a definition invented here.';
  handover.THIS_IS_A_PROXY_NOT_A_FACT =
    'Firestore records NO seller-default state. There is no seller-side sweep, no ' +
    '48h seller-confirmation timer, and the server never advances shippingStatus past ' +
    '"not_started" — an absent seller simply leaves the order untouched forever. So this ' +
    'number is DERIVED, and it UNDERCOUNTS twice over: (1) it is point-in-time, so a lot ' +
    'that stalled and was later rescued by hand no longer shows; (2) the clock runs on ' +
    'updatedAt, which unrelated writes bump, silently resetting it ' +
    '(src/utils/fulfillmentQueues.ts:98-112). Treat it as a FLOOR on the failure rate, and ' +
    "do NOT compare it directly to the plan's stated 1-in-3 without saying so. " +
    'adminNudgedSeller_* is an independent human signal — an admin chased this seller — ' +
    'but it exists only where an admin bothered, so it is also a floor.';
  report.q5_failedHandovers = handover;

  // ---- Membership (settles D-106) ------------------------------------------
  // Counts and money only. subscriptionRequests also carries userName,
  // userEmail, transferFullName and transferPhone — none of which is read.
  const subsByTier = {};
  const subsByStatus = {};
  let approvedInWindow = 0, membershipRevenueInWindow = 0, approvedAllTime = 0, membershipRevenueAllTime = 0;
  const payingMemberIds = {};
  subSnap.docs.forEach((d) => {
    const s = d.data() || {};
    tally(subsByStatus, s.status);
    if (s.status !== 'approved') return;
    const price = num(s.price) || 0;
    approvedAllTime += 1;
    membershipRevenueAllTime += price;
    if (s.userId) payingMemberIds[s.userId] = true;
    const t = ms(s.createdAt);
    if (t != null && t >= fromMs && t < toMs) {
      approvedInWindow += 1;
      membershipRevenueInWindow += price;
      tally(subsByTier, s.tier);
    }
  });

  // Did paying members actually bid? This is the membership's whole claim.
  let membersWhoBid = 0;
  const memberIds = Object.keys(payingMemberIds);
  memberIds.forEach((uid) => { if (allBidderIds[uid]) membersWhoBid += 1; });

  report.q6_membership = {
    requestStatusDistribution: subsByStatus,
    approvedInWindow,
    approvedAllTime,
    membershipRevenueInWindow_JOD: jod(membershipRevenueInWindow),
    membershipRevenueAllTime_JOD: jod(membershipRevenueAllTime),
    approvedByTierInWindow: subsByTier,
    payingMembersAllTime: memberIds.length,
    payingMembersWhoPlacedAtLeastOneBid: membersWhoBid,
    payingMembersWhoNeverBid: memberIds.length - membersWhoBid,
    memberActivationRate: memberIds.length ? jod(membersWhoBid / memberIds.length) : null,
    distinctBiddersAllTime: Object.keys(allBidderIds).length,
    why:
      'D-106. The membership is defended as a seriousness filter. memberActivationRate is ' +
      'that claim as a number: the share of people who paid and then actually bid. ' +
      'Compare it against the decision thresholds in the COO baseline report.',
  };

  // ---- Registrations (authoritative source) --------------------------------
  // users/{uid}.createdAt is written CLIENT-side as new Date().toISOString()
  // (src/context/AppContext.tsx:1027,1188,1205) — a device clock, not a server
  // one. Firebase Auth's own creationTime is authoritative, so we use it.
  // listUsers needs the Firebase Authentication Admin role, which a
  // Firestore-only key may not carry. A missing permission must not throw away
  // the whole report at the last step, so this degrades to a stated gap.
  let registrationsInWindow = 0, registrationsAllTime = 0, pageToken, authError = null;
  try {
    do {
      const page = await admin.auth().listUsers(1000, pageToken);
      page.users.forEach((u) => {
        registrationsAllTime += 1;
        const t = Date.parse(u.metadata.creationTime);
        if (Number.isFinite(t) && t >= fromMs && t < toMs) registrationsInWindow += 1;
      });
      pageToken = page.pageToken;
    } while (pageToken);
  } catch (e) {
    authError = e && e.message ? e.message : String(e);
  }

  report.q7_registrations = authError
    ? {
        unavailable: true,
        reason: authError,
        note:
          'Firebase Auth could not be listed — the service-account key probably lacks the ' +
          'Firebase Authentication Admin role. Registration counts are therefore MISSING, ' +
          'not zero. Every other section above is unaffected.',
      }
    : {
        registrationsInWindow,
        registrationsAllTime,
        source:
          'Firebase Auth metadata.creationTime (authoritative; the Firestore users.createdAt ' +
          'field is written client-side from a device clock and is not trustworthy for this)',
        registrationToPaidMember: registrationsAllTime ? jod(memberIds.length / registrationsAllTime) : null,
        registrationToAnyBidder: registrationsAllTime ? jod(Object.keys(allBidderIds).length / registrationsAllTime) : null,
      };

  report.caveats.push(
    'VISITS ARE NOT IN HERE AND CANNOT BE. The top of the funnel is not measurable from ' +
    'Firestore: analytics_events requires isSignedIn() so anonymous visits never reach it, ' +
    'and landing events go only to window.dataLayer with no GA/GTM wiring ' +
    '(src/landing/landingAnalytics.ts). Visit-to-registration needs GA4 or a Meta export.'
  );
  report.caveats.push(
    'Every rate here is computed over auctions that ENDED in the window. Auctions still ' +
    'running are reported separately and excluded — that is the plan\'s third hypothesis ' +
    '("just timing") and it must not be allowed to contaminate the first two.'
  );

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  render(report);
}

function render(r) {
  const line = (k, v) => console.log('  ' + String(k).padEnd(46) + (v == null ? 'n/a' : v));
  const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));

  console.log('\nMAZZADO — WEEK 1 FUNNEL PULL (read-only)');
  console.log(`window  ${r.window.from.slice(0, 10)} -> ${r.window.to.slice(0, 10)}`);
  console.log(`run at  ${r.generatedAt}`);
  console.log(`simulated rows: ${r.simulatedRows}`);

  head('THE QUESTION: what happened to the bids that did not become sales');
  const q1 = r.q1_auctionOutcomes;
  line('auctions ended in window', q1.endedInWindow);
  line('  met reserve (sold)', q1.metReserve_sold);
  line('  reserve not met', q1.reserveNotMet);
  line('    of which reserve amount recorded', q1.reserveNotMet_withReserveAmountRecorded);
  line('    of which reserve amount MISSING (bug)', q1.reserveNotMet_reserveAmountMissing);
  line('  ended with zero bids', q1.endedWithNoBids);
  line('sell-through vs reserve', q1.sellThroughVsReserve);
  line('still running now (not counted)', JSON.stringify(q1.stillRunningNow));
  line('never started (first_bid, no clock)', q1.neverStarted.n);

  head('BIDS PER AUCTION');
  const q2 = r.q2_bidsPerAuction;
  line('bids placed in window', q2.bidsPlacedInWindow);
  line('per ended auction (median / mean / max)',
    `${q2.distributionAcrossEndedAuctions.median} / ${q2.distributionAcrossEndedAuctions.mean} / ${q2.distributionAcrossEndedAuctions.max}`);
  line('unique bidders per auction (median)', q2.uniqueBiddersPerAuction.median);
  line('auctions with exactly 1 bid', q2.auctionsWithOneBidOnly);
  line('auctions with 2+ bids', q2.auctionsWithTwoPlusBids);
  line('totalBids counter disagreements', q2.totalBidsCounterDisagreements);

  head('WINNERS: PAID vs NOT');
  const q3 = r.q3_winnersPaid;
  line('auctions that produced a winner', q3.auctionsThatProducedAWinner);
  line('winners who paid', q3.winnersWhoPaid);
  line('winners who did not pay', q3.winnersWhoDidNotPay);
  line('  formally defaulted', q3.ofWhich_formallyDefaulted);
  line('  past deadline, not yet swept', q3.ofWhich_waitingPaymentPastDeadline);
  line('  still inside payment window', q3.ofWhich_waitingPaymentStillInWindow);
  line('  CliQ request still live (in flight)', q3.ofWhich_cliqRequestStillLive);
  line('sold but NO order document (bug)', q3.soldButNoOrderDocument);
  line('winner payment rate', q3.winnerPaymentRate);

  head('SALES, ASV, COMMISSION');
  const q4 = r.q4_salesAndCommission;
  line('completed sales (money received)', q4.completedSales_moneyReceived);
  line('orders reaching status=completed', q4.ordersReachingStatusCompleted);
  line('average sale value (mean)', q4.averageSaleValue_mean);
  line('average sale value (median)', q4.averageSaleValue_median);
  line('GMV (JOD)', q4.grossMerchandiseValue);
  line('commission earned, stored (JOD)', q4.commissionEarned_fromStoredFields);
  line('commission earned, recomputed (JOD)', q4.commissionEarned_recomputedAt10pct);

  head('FAILED HANDOVERS');
  const q5 = r.q5_failedHandovers;
  line('paid orders considered', q5.paidOrdersConsidered);
  line('seller has not prepped, past 24h SLA', q5.sellerHasntPrepped_overdue);
  line('buyer has not confirmed, past 24h SLA', q5.buyerHasntConfirmed_overdue);
  line('disputed / refunded / cancelled', `${q5.disputed} / ${q5.refunded} / ${q5.cancelled}`);
  line('orders an admin nudged the seller on', q5.adminNudgedSeller_atLeastOnce);
  line('failed-handover rate (seller side)', q5.failedHandoverRate_sellerSide);
  console.log('\n  PROXY, NOT A STORED FACT — a floor, not a count. See the JSON for why.');

  head('MEMBERSHIP (D-106)');
  const q6 = r.q6_membership;
  line('approved in window', q6.approvedInWindow);
  line('membership revenue in window (JOD)', q6.membershipRevenueInWindow_JOD);
  line('paying members, all time', q6.payingMembersAllTime);
  line('  who placed >=1 bid', q6.payingMembersWhoPlacedAtLeastOneBid);
  line('  who never bid', q6.payingMembersWhoNeverBid);
  line('member activation rate', q6.memberActivationRate);

  head('REGISTRATIONS');
  const q7 = r.q7_registrations;
  if (q7.unavailable) {
    console.log('  UNAVAILABLE — ' + q7.reason);
    console.log('  (missing, not zero: ' + q7.note + ')');
  } else {
    line('registrations in window', q7.registrationsInWindow);
    line('registrations all time', q7.registrationsAllTime);
    line('registration -> paid member', q7.registrationToPaidMember);
    line('registration -> any bidder', q7.registrationToAnyBidder);
  }

  head('CAVEATS');
  r.caveats.forEach((c) => console.log('  - ' + c));
  console.log('\n  Aggregates only. No ids, names, phones or payment references are printed.\n');
}

main().catch((err) => {
  console.error('\n  Failed:', err && err.message ? err.message : err, '\n');
  process.exit(1);
});
