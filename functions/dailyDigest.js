'use strict';
// CR-02 — the daily "new auctions matching your interests" digest. PURE logic.
//
// NO firebase deps, deliberately: the root Vitest config loads this file
// directly, same rule the header of notify.js sets out. Everything that needs
// Firestore (the query, the log reads, the sends) lives in index.js and calls
// into here, so every decision this feature makes is testable without a
// project, a clock, or a network.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: a user with zero matching auctions
// gets NOTHING. Not a fallback, not "here's what else is live". The spec is
// explicit and it is the difference between a digest people keep and a
// broadcast people block — and on WhatsApp, being blocked is not reversible by
// changing our minds later.

// Jordan is permanently UTC+3 — no DST since 2022. Offset math instead of ICU
// (`Intl` with a timeZone) keeps this pure and identical in every Node build;
// src/utils/ammanTime.ts makes the same call for the same reason.
const AMMAN_OFFSET_MS = 3 * 60 * 60 * 1000;

/** The digest's own log type. Part of the notifications_log key. */
const DIGEST_TYPE = 'daily_digest';

/** How far back "new" reaches. */
const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** One digest per user per 24h, enforced against the log — never the clock. */
const DAILY_CAP_MS = 24 * 60 * 60 * 1000;

/** Most auctions in one message. More than this is a wall of text nobody reads. */
const MAX_AUCTIONS_PER_MESSAGE = 3;

/** Quiet hours, Amman wall clock: [23:00, 09:00). */
const QUIET_START_HOUR = 23;
const QUIET_END_HOUR = 9;

/** Canonical site. Mirrors SITE in emailCopy.js. */
const SITE = 'https://www.mazzado.com';

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Amman wall-clock hour (0-23) for an epoch ms. */
function ammanHour(ms) {
  return new Date(ms + AMMAN_OFFSET_MS).getUTCHours();
}

/** "H:MM", 24-hour Amman wall clock. */
function formatAmmanClock(ms) {
  const d = new Date(ms + AMMAN_OFFSET_MS);
  return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * Is `ms` inside quiet hours?
 *
 * The window WRAPS midnight, which is why this is an OR and not the `>= start
 * && < end` that reads more naturally and is wrong — that form is empty for
 * every wrapping window, so it would have sent at 3am and never told anyone.
 */
function isQuietHours(ms) {
  const h = ammanHour(ms);
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

/** Was this auction created inside the freshness window? */
function isFresh(createdAtMs, nowMs) {
  if (typeof createdAtMs !== 'number' || !Number.isFinite(createdAtMs)) return false;
  const age = nowMs - createdAtMs;
  // A createdAt in the FUTURE is clock skew or a seeded doc, not a new lot.
  return age >= 0 && age <= FRESH_WINDOW_MS;
}

/** Firestore Timestamp | number | {seconds} -> epoch ms. Mirrors notify.js toMs. */
function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * Stored values each canonical category ALSO answers to.
 *
 * This mirrors `legacyMatch` in src/utils/categories.ts, and the mirror is
 * load-bearing rather than convenient: `users/{uid}.interests` holds canonical
 * ids ('Watches'), while older auction docs still carry the value they were
 * written with ('Luxury'). Compare them raw and a user who picked Watches is
 * matched against no watch listed before the rename — silently, because "no
 * matches" is a legitimate outcome this feature is told not to fall back from.
 *
 * categoryParity.test.js asserts this map against the TypeScript source, so the
 * two cannot drift without a red test.
 */
const LEGACY_MATCH = {
  Vehicles: ['Cars'],
  Phones: [],
  Electronics: [],
  Watches: ['Luxury'],
  Appliances: [],
  'Home & Furniture': [],
  'Real Estate': [],
  Fashion: ['Misc'],
};

/** Every stored value that satisfies an interest in `canonical`. */
function matchValues(canonical) {
  const extra = LEGACY_MATCH[canonical];
  return extra ? [canonical, ...extra] : [canonical];
}

/** Does this auction's stored category satisfy any of the user's interests? */
function matchesInterests(auctionCategory, interests) {
  const raw = String(auctionCategory ?? '').trim().toLowerCase();
  if (!raw) return false;
  if (!Array.isArray(interests) || interests.length === 0) return false;
  for (const id of interests) {
    if (typeof id !== 'string' || !id.trim()) continue;
    for (const v of matchValues(id)) {
      if (String(v).toLowerCase() === raw) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Starting price in dinars. Fils are thousandths — see filsToUnits. */
function startingPriceUnits(a) {
  if (a && typeof a.startingPriceFils === 'number') return a.startingPriceFils / 1000;
  if (a && typeof a.startingPrice === 'number') return a.startingPrice;
  return 0;
}

/**
 * The ceiling, in dinars, above which a lot is not worth a WhatsApp message.
 *
 * ⚠️ THIS NUMBER IS A PRODUCT DECISION, not a technical one. It decides how many
 * messages go out, and the digest reaches real phones. Change it here and
 * nowhere else.
 *
 * The digest used to message people about every fresh lot in their categories,
 * at any price. The instruction is now: notify about a CHEAP lot, and otherwise
 * stay quiet — a WhatsApp ping is a favour, and a favour spent on a 400 JOD
 * wardrobe is the reason people mute a sender.
 */
const CHEAP_MAX_JOD = 25;

/**
 * Is this lot still cheap RIGHT NOW?
 *
 * Current price, not starting price. A lot that opened at 1 JOD and has been
 * bid to 300 is not a bargain any more, and "يبدأ من 1 دينار" next to a live
 * price of 300 is the kind of message that reads as bait. Falls back to the
 * starting price only when no current price is stored — a brand-new lot with no
 * bids, where the two are the same thing.
 */
function currentPriceUnits(a) {
  if (a && typeof a.currentPriceFils === 'number') return a.currentPriceFils / 1000;
  if (a && typeof a.currentPrice === 'number' && a.currentPrice > 0) return a.currentPrice;
  return startingPriceUnits(a);
}

function isCheapLot(a, maxJod = CHEAP_MAX_JOD) {
  const price = currentPriceUnits(a);
  // A lot with no usable price is NOT assumed cheap. Guessing in the permissive
  // direction here means messaging someone about a lot we cannot price.
  if (!Number.isFinite(price) || price <= 0) return false;
  return price <= maxJod;
}

/**
 * Which auctions this user gets, and how many were left over.
 *
 * Ordered by bid count descending — the spec's rule, and a good one: the lot
 * other people are already bidding on is the one worth leading with. Ties break
 * on the newer lot so the order is deterministic; without a tiebreak two runs
 * over the same data can disagree, which makes the log impossible to read.
 *
 * PRICE FILTER FIRST, before interests: a lot that is too expensive is not sent
 * to anyone, whatever their categories say.
 */
function pickForUser(auctions, interests, max = MAX_AUCTIONS_PER_MESSAGE) {
  const affordable = (auctions || []).filter((a) => isCheapLot(a));
  const matched = affordable.filter((a) => matchesInterests(a && a.category, interests));
  matched.sort((x, y) => {
    const bx = typeof x.totalBids === 'number' ? x.totalBids : 0;
    const by = typeof y.totalBids === 'number' ? y.totalBids : 0;
    if (by !== bx) return by - bx;
    return (y.createdAtMs || 0) - (x.createdAtMs || 0);
  });
  const picks = matched.slice(0, max);
  return { picks, matchedCount: matched.length, overflow: Math.max(0, matched.length - picks.length) };
}

// ---------------------------------------------------------------------------
// Log keys + cap
// ---------------------------------------------------------------------------

/**
 * notifications_log document id. `{uid}_{auctionId}_{type}`, per the spec.
 *
 * Slashes would create a subcollection path rather than a document id, so any
 * that appear in an id are replaced. Firestore ids also cannot be '.' or '..'.
 */
function logKey(uid, auctionId, type = DIGEST_TYPE) {
  const clean = (v) => String(v ?? '').replace(/\//g, '_').trim();
  return `${clean(uid)}_${clean(auctionId)}_${clean(type)}`;
}

/** Has this user already had a digest inside the cap window? */
function isCapped(lastDigestAtMs, nowMs) {
  if (typeof lastDigestAtMs !== 'number' || !Number.isFinite(lastDigestAtMs)) return false;
  const since = nowMs - lastDigestAtMs;
  // A future timestamp means a clock we cannot trust. Treat it as capped: the
  // failure mode of holding a message back is one quiet evening; the failure
  // mode of the other branch is a user messaged repeatedly.
  if (since < 0) return true;
  return since < DAILY_CAP_MS;
}

/** Drop auctions this user has already been sent, whatever the reason. */
function excludeAlreadySent(picks, sentAuctionIds) {
  const seen = new Set(sentAuctionIds || []);
  return (picks || []).filter((a) => !seen.has(a.id));
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

/** The opt-out line. Every message carries it — no exceptions, no config. */
const OPT_OUT_AR = 'للإيقاف، ارسل "إيقاف"';
const OPT_OUT_EN = 'To stop these, reply "STOP"';

/** Numbers render in western digits in both languages — see ARABIC_UI_DIGITS. */
function money(n, isAr) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2);
  return isAr ? `${s} د.أ` : `${s} JOD`;
}

function auctionUrl(id) {
  const v = String(id ?? '').trim();
  return v ? `${SITE}/auction/${encodeURIComponent(v)}` : `${SITE}/discover`;
}

/**
 * Render one digest. Returns null when there is nothing to say — the caller
 * treats null as "skip this user", so the no-match rule is enforced by the
 * renderer too and not only by the loop that calls it.
 */
function renderDigest({ picks, overflow = 0, lang = 'ar' }) {
  const list = Array.isArray(picks) ? picks.filter(Boolean) : [];
  if (list.length === 0) return null;
  const isAr = lang !== 'en';

  const head = isAr ? 'مزادات جديدة بتهمك 👋' : 'New auctions you might like 👋';
  const lines = [head, ''];

  for (const a of list) {
    const endMs = toMs(a.endsAt);
    const when = endMs
      ? (isAr ? `بينتهي ${formatAmmanClock(endMs)}` : `ends ${formatAmmanClock(endMs)}`)
      : (isAr ? 'بينتهي قريباً' : 'ending soon');
    const start = isAr
      ? `يبدأ من ${money(startingPriceUnits(a), true)}`
      : `from ${money(startingPriceUnits(a), false)}`;
    lines.push(`• ${String(a.title || '').trim() || (isAr ? 'قطعة جديدة' : 'New listing')}`);
    lines.push(`  ${start} · ${when}`);
    lines.push(`  ${auctionUrl(a.id)}`);
    lines.push('');
  }

  if (overflow > 0) {
    lines.push(isAr ? `+ و ${overflow} مزاد غير` : `+ ${overflow} more`);
    lines.push('');
  }

  lines.push(isAr ? OPT_OUT_AR : OPT_OUT_EN);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Opt-out parsing
// ---------------------------------------------------------------------------

/**
 * Does an inbound WhatsApp message mean "stop"?
 *
 * Arabic is matched after stripping diacritics and normalising alef forms:
 * people type إيقاف, ايقاف and أيقاف interchangeably, and a handler that only
 * accepts the one spelling we printed turns an opt-out into silence — which is
 * the single worst outcome for a channel where the user's next move is to
 * report the number.
 */
function isStopMessage(text) {
  const raw = String(text ?? '').trim().toLowerCase();
  if (!raw) return false;
  const normalised = raw
    .replace(/[ً-ْ]/g, '')       // harakat
    .replace(/[آأإ]/g, 'ا') // آ أ إ -> ا
    .replace(/ة/g, 'ه')          // ة -> ه
    .replace(/[^\p{L}\p{N}]+/gu, ' ')      // punctuation, emoji
    .trim();
  const STOP = ['ايقاف', 'توقف', 'الغاء', 'stop', 'unsubscribe', 'cancel'];
  return STOP.some((w) => normalised === w || normalised.split(' ').includes(w));
}

/** Confirmation sent back after an opt-out. */
function optOutConfirmation(lang = 'ar') {
  return lang === 'en'
    ? 'Done — you will not get auction alerts from us again. Reply START any time to turn them back on.'
    : 'تمام، وقّفنا التنبيهات. ما رح توصلك رسائل مزادات بعد هلق. لو غيّرت رأيك ابعتلنا "تشغيل".';
}

/** The mirror of isStopMessage, so a user can come back. */
function isStartMessage(text) {
  const raw = String(text ?? '').trim().toLowerCase();
  if (!raw) return false;
  const normalised = raw
    .replace(/[ً-ْ]/g, '')
    .replace(/[آأإ]/g, 'ا')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const START = ['تشغيل', 'اشتراك', 'start', 'subscribe'];
  return START.some((w) => normalised === w || normalised.split(' ').includes(w));
}

// ---------------------------------------------------------------------------
// Run accounting
// ---------------------------------------------------------------------------

/** The per-run counters the spec asks to be logged. */
function newRunSummary() {
  return {
    attempted: 0,
    sent: 0,
    failed: 0,
    skippedNoMatch: 0,
    skippedCapped: 0,
    skippedNoPhone: 0,
    skippedOptedOut: 0,
    skippedAlreadySent: 0,
  };
}

module.exports = {
  AMMAN_OFFSET_MS,
  DIGEST_TYPE,
  FRESH_WINDOW_MS,
  DAILY_CAP_MS,
  MAX_AUCTIONS_PER_MESSAGE,
  QUIET_START_HOUR,
  QUIET_END_HOUR,
  SITE,
  ammanHour,
  formatAmmanClock,
  isQuietHours,
  isFresh,
  toMs,
  LEGACY_MATCH,
  matchValues,
  matchesInterests,
  startingPriceUnits,
  currentPriceUnits,
  isCheapLot,
  CHEAP_MAX_JOD,
  pickForUser,
  logKey,
  isCapped,
  excludeAlreadySent,
  renderDigest,
  money,
  auctionUrl,
  isStopMessage,
  isStartMessage,
  optOutConfirmation,
  newRunSummary,
  OPT_OUT_AR,
  OPT_OUT_EN,
};
