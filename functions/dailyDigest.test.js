import { describe, it, expect } from 'vitest';
import {
  ammanHour,
  formatAmmanClock,
  isQuietHours,
  isFresh,
  matchesInterests,
  pickForUser,
  logKey,
  isCapped,
  excludeAlreadySent,
  renderDigest,
  isStopMessage,
  isStartMessage,
  newRunSummary,
  QUIET_START_HOUR,
  QUIET_END_HOUR,
  DAILY_CAP_MS,
  CHEAP_MAX_JOD,
} from './dailyDigest.js';

/** Build an epoch ms for a given Amman wall-clock time on 2026-09-12. */
const amman = (h, m = 0) => Date.parse(`2026-09-12T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+03:00`);

describe('Amman clock', () => {
  it('reads the wall-clock hour, not UTC', () => {
    // 19:00 Amman is 16:00 UTC. Reading UTC here would put the send three
    // hours early — inside the afternoon, not the evening browsing peak.
    expect(ammanHour(amman(19))).toBe(19);
    expect(new Date(amman(19)).getUTCHours()).toBe(16);
  });

  it('formats a closing time a human recognises', () => {
    expect(formatAmmanClock(amman(21, 5))).toBe('21:05');
    expect(formatAmmanClock(amman(9, 30))).toBe('9:30');
  });
});

describe('quiet hours', () => {
  it('is silent from 23:00 to 09:00 Amman', () => {
    expect(isQuietHours(amman(23))).toBe(true);
    expect(isQuietHours(amman(2))).toBe(true);
    expect(isQuietHours(amman(8, 59))).toBe(true);
  });

  it('allows the daytime and the evening send window', () => {
    expect(isQuietHours(amman(9))).toBe(false);
    expect(isQuietHours(amman(19))).toBe(false);
    expect(isQuietHours(amman(22, 59))).toBe(false);
  });

  it('handles the window WRAPPING midnight', () => {
    // The natural `h >= start && h < end` is empty for a wrapping window, so
    // the bug it produces is not "slightly wrong" — it is a function that
    // returns false at 3am and sends anyway.
    expect(QUIET_START_HOUR).toBeGreaterThan(QUIET_END_HOUR);
    for (let h = 0; h < 24; h++) {
      const expected = h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
      expect(isQuietHours(amman(h))).toBe(expected);
    }
  });
});

describe('freshness', () => {
  const now = amman(19);
  it('accepts a lot created inside the last 24h', () => {
    expect(isFresh(now - 60_000, now)).toBe(true);
    expect(isFresh(now - 23 * 3600_000, now)).toBe(true);
  });
  it('rejects anything older', () => {
    expect(isFresh(now - 25 * 3600_000, now)).toBe(false);
  });
  it('rejects a createdAt in the future', () => {
    // Clock skew or a seeded doc. Not a new lot, and treating it as one keeps
    // it "new" for a whole day after its timestamp finally passes.
    expect(isFresh(now + 3600_000, now)).toBe(false);
  });
  it('rejects junk rather than guessing', () => {
    expect(isFresh(undefined, now)).toBe(false);
    expect(isFresh(NaN, now)).toBe(false);
  });
});

describe('interest matching', () => {
  it('matches a canonical category', () => {
    expect(matchesInterests('Vehicles', ['Vehicles'])).toBe(true);
  });

  it('matches the LEGACY value an older lot still carries', () => {
    // The reason this is not a raw string compare. A user picks 'Watches';
    // every watch listed before the rename is stored as 'Luxury'. Without
    // this, that user matches nothing and is silently never messaged.
    expect(matchesInterests('Luxury', ['Watches'])).toBe(true);
    expect(matchesInterests('Cars', ['Vehicles'])).toBe(true);
    expect(matchesInterests('Misc', ['Fashion'])).toBe(true);
  });

  it('is case-insensitive about what is stored', () => {
    expect(matchesInterests('vehicles', ['Vehicles'])).toBe(true);
  });

  it('does not match an unrelated category', () => {
    expect(matchesInterests('Phones', ['Vehicles'])).toBe(false);
  });

  it('matches nothing for a user with no interests', () => {
    // The no-fallback rule, at its root. An empty interest list must never
    // read as "interested in everything".
    expect(matchesInterests('Vehicles', [])).toBe(false);
    expect(matchesInterests('Vehicles', undefined)).toBe(false);
    expect(matchesInterests('Vehicles', ['', '  '])).toBe(false);
  });
});

describe('picking auctions', () => {
  // `currentPrice` defaults to a cheap lot so these stay tests of ORDERING and
  // capping. pickForUser now drops anything above CHEAP_MAX_JOD before it sorts
  // — without a price these fixtures are all filtered out and every assertion
  // below reads as "returned nothing", which says nothing about ordering. The
  // price filter has its own tests further down.
  const lot = (id, category, totalBids, createdAtMs = 0, currentPrice = 5) =>
    ({ id, category, totalBids, createdAtMs, currentPrice });

  it('leads with the most-bid lot', () => {
    const { picks } = pickForUser(
      [lot('a', 'Vehicles', 1), lot('b', 'Vehicles', 9), lot('c', 'Vehicles', 4)],
      ['Vehicles'],
    );
    expect(picks.map((p) => p.id)).toEqual(['b', 'c', 'a']);
  });

  it('caps at three and reports the overflow', () => {
    const lots = ['a', 'b', 'c', 'd', 'e'].map((id, i) => lot(id, 'Vehicles', 10 - i));
    const { picks, overflow, matchedCount } = pickForUser(lots, ['Vehicles']);
    expect(picks).toHaveLength(3);
    expect(overflow).toBe(2);
    expect(matchedCount).toBe(5);
  });

  it('breaks ties deterministically so two runs agree', () => {
    // Without a tiebreak the order depends on the input order, and the log
    // becomes impossible to reconcile against what was actually sent.
    const lots = [lot('older', 'Phones', 3, 1000), lot('newer', 'Phones', 3, 2000)];
    expect(pickForUser(lots, ['Phones']).picks.map((p) => p.id)).toEqual(['newer', 'older']);
    expect(pickForUser([...lots].reverse(), ['Phones']).picks.map((p) => p.id)).toEqual(['newer', 'older']);
  });

  it('returns nothing when nothing matches — and never falls back', () => {
    const { picks, overflow } = pickForUser([lot('a', 'Phones', 5)], ['Real Estate']);
    expect(picks).toEqual([]);
    expect(overflow).toBe(0);
  });
});

describe('log key and cap', () => {
  it('is keyed {uid}_{auctionId}_{type}', () => {
    expect(logKey('u1', 'a1')).toBe('u1_a1_daily_digest');
  });

  it('never produces a nested path from an id with a slash', () => {
    // A '/' would silently turn the document id into a subcollection path.
    expect(logKey('u/1', 'a/1')).toBe('u_1_a_1_daily_digest');
  });

  it('caps a user who was messaged inside 24h', () => {
    const now = amman(19);
    expect(isCapped(now - 1000, now)).toBe(true);
    expect(isCapped(now - (DAILY_CAP_MS - 1), now)).toBe(true);
  });

  it('lets a user through once the window has passed', () => {
    const now = amman(19);
    expect(isCapped(now - DAILY_CAP_MS - 1, now)).toBe(false);
    expect(isCapped(null, now)).toBe(false);
  });

  it('caps rather than sends when the stored time is in the future', () => {
    // An untrustworthy clock should cost one quiet evening, not produce a
    // user who gets messaged on every run.
    const now = amman(19);
    expect(isCapped(now + 60_000, now)).toBe(true);
  });

  it('drops auctions already sent to this user', () => {
    const picks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(excludeAlreadySent(picks, ['b']).map((p) => p.id)).toEqual(['a', 'c']);
  });
});

describe('message', () => {
  const picks = [
    { id: 'a1', title: 'آيفون 15 برو', startingPrice: 5, endsAt: amman(21, 30), totalBids: 4 },
    { id: 'a2', title: 'ساعة رولكس', startingPriceFils: 25_000, endsAt: amman(22), totalBids: 2 },
  ];

  it('renders name, starting price, closing time and a link per lot', () => {
    const msg = renderDigest({ picks, lang: 'ar' });
    expect(msg).toContain('آيفون 15 برو');
    expect(msg).toContain('5 د.أ');
    expect(msg).toContain('21:30');
    expect(msg).toContain('https://www.mazzado.com/auction/a1');
  });

  it('converts fils to dinars', () => {
    // Fils are thousandths. Getting this wrong prints 25000 د.أ for a 25 dinar
    // lot, which reads as a typo at best and a scam at worst.
    expect(renderDigest({ picks, lang: 'ar' })).toContain('25 د.أ');
  });

  it('always ends with the opt-out line', () => {
    expect(renderDigest({ picks, lang: 'ar' })).toContain('للإيقاف، ارسل "إيقاف"');
    expect(renderDigest({ picks, lang: 'en' })).toContain('To stop these, reply "STOP"');
  });

  it('appends the overflow count', () => {
    expect(renderDigest({ picks, overflow: 4, lang: 'ar' })).toContain('+ و 4 مزاد غير');
  });

  it('omits the overflow line when there is none', () => {
    expect(renderDigest({ picks, overflow: 0, lang: 'ar' })).not.toContain('مزاد غير');
  });

  it('returns null when there is nothing to say', () => {
    // The no-match rule enforced at the renderer too, so a caller that forgets
    // to check still cannot produce an empty "here are your auctions".
    expect(renderDigest({ picks: [], lang: 'ar' })).toBeNull();
    expect(renderDigest({ picks: undefined, lang: 'ar' })).toBeNull();
  });

  it('never renders a nameless bullet', () => {
    const msg = renderDigest({ picks: [{ id: 'x', title: '', startingPrice: 1 }], lang: 'ar' });
    expect(msg).toContain('قطعة جديدة');
  });
});

describe('opt-out parsing', () => {
  it('accepts the spelling we print', () => {
    expect(isStopMessage('إيقاف')).toBe(true);
  });

  it('accepts the spellings people actually type', () => {
    // ايقاف / أيقاف / إيقاف are the same word to the person sending it. A
    // handler that only takes one turns an opt-out into silence, and the
    // user's next move is to report the number — which we cannot undo.
    for (const v of ['ايقاف', 'أيقاف', 'إيقاف ', 'ايقاف.', 'توقف', 'الغاء']) {
      expect(isStopMessage(v)).toBe(true);
    }
  });

  it('accepts the English forms', () => {
    for (const v of ['stop', 'STOP', 'Stop', 'unsubscribe', 'cancel']) {
      expect(isStopMessage(v)).toBe(true);
    }
  });

  it('finds the word inside a short sentence', () => {
    expect(isStopMessage('بدي ايقاف')).toBe(true);
    expect(isStopMessage('please stop')).toBe(true);
  });

  it('does not fire on unrelated messages', () => {
    expect(isStopMessage('')).toBe(false);
    expect(isStopMessage('شو سعر السيارة')).toBe(false);
    expect(isStopMessage('non-stopping')).toBe(false);
  });

  it('recognises the way back in', () => {
    expect(isStartMessage('تشغيل')).toBe(true);
    expect(isStartMessage('START')).toBe(true);
    expect(isStartMessage('ايقاف')).toBe(false);
  });
});

describe('run summary', () => {
  it('carries every counter the spec asks to be logged', () => {
    expect(Object.keys(newRunSummary()).sort()).toEqual(
      [
        'attempted',
        'failed',
        'sent',
        'skippedAlreadySent',
        'skippedCapped',
        'skippedNoMatch',
        'skippedNoPhone',
        'skippedOptedOut',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Only cheap lots earn a WhatsApp message.
//
// The digest used to message people about every fresh lot in their categories
// at any price. A ping is a favour, and a favour spent on a 400 JOD wardrobe is
// why people mute a sender. The ceiling is CHEAP_MAX_JOD in dailyDigest.js.
describe('price filter', () => {
  const priced = (id, currentPrice, extra = {}) =>
    ({ id, category: 'Vehicles', totalBids: 1, createdAtMs: 0, currentPrice, ...extra });

  it('keeps lots at or under the ceiling', () => {
    const { picks } = pickForUser([priced('cheap', 5), priced('edge', CHEAP_MAX_JOD)], ['Vehicles']);
    expect(picks.map((p) => p.id).sort()).toEqual(['cheap', 'edge']);
  });

  it('drops a lot above the ceiling', () => {
    const { picks, matchedCount } = pickForUser([priced('pricey', CHEAP_MAX_JOD + 1)], ['Vehicles']);
    expect(picks).toEqual([]);
    // Not counted as matched either — it was never a candidate.
    expect(matchedCount).toBe(0);
  });

  it('judges on the CURRENT price, not the starting price', () => {
    // A lot that opened at 1 JOD and has been bid to 300 is not a bargain, and
    // "يبدأ من 1 دينار" beside a live price of 300 reads as bait.
    const bidUp = { id: 'bidUp', category: 'Vehicles', totalBids: 40, createdAtMs: 0, startingPrice: 1, currentPrice: 300 };
    expect(pickForUser([bidUp], ['Vehicles']).picks).toEqual([]);
  });

  it('falls back to the starting price for a lot with no bids yet', () => {
    const fresh = { id: 'fresh', category: 'Vehicles', totalBids: 0, createdAtMs: 0, startingPrice: 3 };
    expect(pickForUser([fresh], ['Vehicles']).picks.map((p) => p.id)).toEqual(['fresh']);
  });

  it('reads fils fields when that is what the doc carries', () => {
    const inFils = { id: 'fils', category: 'Vehicles', totalBids: 0, createdAtMs: 0, currentPriceFils: 7000 };
    expect(pickForUser([inFils], ['Vehicles']).picks.map((p) => p.id)).toEqual(['fils']);
  });

  it('does NOT assume a lot with no usable price is cheap', () => {
    // Fail closed: messaging someone about a lot we cannot price is worse than
    // staying quiet, and a missing price usually means a malformed doc.
    for (const bad of [{}, { currentPrice: 0 }, { currentPrice: -5 }, { currentPrice: 'x' }]) {
      const l = { id: 'bad', category: 'Vehicles', totalBids: 0, createdAtMs: 0, ...bad };
      expect(pickForUser([l], ['Vehicles']).picks, `accepted ${JSON.stringify(bad)}`).toEqual([]);
    }
  });

  it('filters on price BEFORE interests, so an expensive lot reaches nobody', () => {
    const l = priced('pricey', 999);
    expect(pickForUser([l], ['Vehicles']).picks).toEqual([]);
    expect(pickForUser([l], []).picks).toEqual([]);
  });
});
