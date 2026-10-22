// CR-02 orchestration, against a fake Firestore.
//
// The safety rails are the whole feature here — the message is the easy part.
// What can actually hurt someone is sending twice, sending at 3am, sending to
// someone who opted out, or a rehearsal that cancels the real run. Each of
// those has a test below, and each one describes the damage rather than the
// mechanism, because the mechanism is what a future refactor is allowed to
// change.
import { describe, it, expect, vi } from 'vitest';
import { runDailyDigest, sendWithRetry, mapWithConcurrency } from './dailyDigestRun.js';

const AT = (h, m = 0) =>
  Date.parse(`2026-09-12T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+03:00`);

/** Minimal Firestore stand-in: collections of plain objects. */
function makeDb({ config = {}, auctions = [], users = [], log = {} } = {}) {
  const store = {
    config: { notifications: { ...config } },
    auctions: Object.fromEntries(auctions.map((a) => [a.id, a])),
    users: Object.fromEntries(users.map((u) => [u.id, u])),
    notifications_log: { ...log },
  };
  const writes = [];

  const snapOf = (col, id) => ({
    id,
    exists: Object.prototype.hasOwnProperty.call(store[col], id),
    data: () => store[col][id],
  });

  const collection = (name) => ({
    doc: (id) => ({ __col: name, __id: id, get: async () => snapOf(name, id) }),
    where(field, _op, value) {
      const rows = Object.entries(store[name]).filter(([, d]) => d[field] === value);
      return {
        get: async () => ({
          forEach: (fn) => rows.forEach(([id, d]) => fn({ id, data: () => d })),
          size: rows.length,
        }),
      };
    },
    get: async () => {
      const rows = Object.entries(store[name]);
      return { forEach: (fn) => rows.forEach(([id, d]) => fn({ id, data: () => d })), size: rows.length };
    },
  });

  const db = {
    collection,
    batch: () => ({
      set(ref, data) {
        writes.push({ col: ref.__col, id: ref.__id, data });
      },
      async commit() {
        for (const w of writes.slice(-50)) store[w.col][w.id] = w.data;
      },
    }),
  };
  return { db, store, writes };
}

const lot = (id, category, extra = {}) => ({
  id,
  category,
  status: 'live',
  title: `Lot ${id}`,
  startingPrice: 5,
  totalBids: 1,
  createdAt: AT(10),
  endsAt: AT(22),
  ...extra,
});

const user = (id, extra = {}) => ({
  id,
  notifyDaily: true,
  notifyChannel: 'whatsapp',
  phoneNumber: '+962790000000',
  interests: ['Vehicles'],
  ...extra,
});

function runWith(opts = {}, dbParts = {}) {
  const { db, store, writes } = makeDb(dbParts);
  const send = opts.send || vi.fn(async () => true);
  return {
    db,
    store,
    writes,
    send,
    result: runDailyDigest({
      db,
      send,
      now: () => AT(19),
      sleep: async () => {},
      logger: { log() {}, warn() {}, error() {} },
      ...opts,
    }),
  };
}

describe('kill switch', () => {
  it('exits before touching anything when dailyEnabled is false', async () => {
    const { result, send } = runWith({}, { config: { dailyEnabled: false }, auctions: [lot('a', 'Vehicles')], users: [user('u1')] });
    const r = await result;
    expect(r.skipped).toBe('killSwitch');
    expect(send).not.toHaveBeenCalled();
  });

  it('runs when the flag is absent — the switch is opt-OUT, not opt-in', async () => {
    // A missing config doc must not silently disable the product.
    const { result, send } = runWith({}, { auctions: [lot('a', 'Vehicles')], users: [user('u1')] });
    await result;
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('quiet hours', () => {
  it('sends nothing at 03:00 even when the scheduler fired', async () => {
    // A retried invocation or a manual run carries a valid cron behind it and
    // can still land in the middle of the night.
    const { result, send } = runWith(
      { now: () => AT(3) },
      { auctions: [lot('a', 'Vehicles')], users: [user('u1')] },
    );
    expect((await result).skipped).toBe('quietHours');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('matching', () => {
  it('sends only what the user asked for', async () => {
    const { result, send } = runWith(
      {},
      {
        auctions: [lot('car', 'Vehicles'), lot('phone', 'Phones')],
        users: [user('u1', { interests: ['Vehicles'] })],
      },
    );
    await result;
    const text = send.mock.calls[0][0].text;
    expect(text).toContain('Lot car');
    expect(text).not.toContain('Lot phone');
  });

  it('sends NOTHING to a user with zero matches — no fallback', async () => {
    const { result, send } = runWith(
      {},
      { auctions: [lot('phone', 'Phones')], users: [user('u1', { interests: ['Real Estate'] })] },
    );
    const r = await result;
    expect(send).not.toHaveBeenCalled();
    expect(r.skippedNoMatch).toBe(1);
  });

  it('matches a lot stored under its legacy category', async () => {
    const { result, send } = runWith(
      {},
      { auctions: [lot('w', 'Luxury')], users: [user('u1', { interests: ['Watches'] })] },
    );
    await result;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ignores lots older than the freshness window and lots that are not live', async () => {
    const { result, send } = runWith(
      {},
      {
        auctions: [
          lot('old', 'Vehicles', { createdAt: AT(19) - 8 * 24 * 3600_000 }),
          lot('ended', 'Vehicles', { status: 'ended' }),
        ],
        users: [user('u1')],
      },
    );
    const r = await result;
    expect(send).not.toHaveBeenCalled();
    expect(r.reason).toBe('noFreshAuctions');
  });
});

describe('opt-out and reachability', () => {
  it('skips a user whose channel is none, even if notifyDaily is stale', async () => {
    const { result, send } = runWith(
      {},
      { auctions: [lot('a', 'Vehicles')], users: [user('u1', { notifyChannel: 'none' })] },
    );
    expect((await result).skippedOptedOut).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('never reaches a user with notifyDaily false', async () => {
    const { result, send } = runWith(
      {},
      { auctions: [lot('a', 'Vehicles')], users: [user('u1', { notifyDaily: false })] },
    );
    await result;
    expect(send).not.toHaveBeenCalled();
  });

  it('skips a user with no usable phone', async () => {
    const { result, send } = runWith(
      { normalizePhone: () => null },
      { auctions: [lot('a', 'Vehicles')], users: [user('u1')] },
    );
    expect((await result).skippedNoPhone).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the caps', () => {
  it('sends nothing the second time it runs the same day', async () => {
    // The acceptance criterion, stated directly. The cap is read from the log,
    // so a retried invocation, a manual run and a redeploy all hit it.
    const parts = { auctions: [lot('a', 'Vehicles')], users: [user('u1')] };
    const first = runWith({}, parts);
    await first.result;
    expect(first.send).toHaveBeenCalledTimes(1);

    const second = runDailyDigest({
      db: first.db,
      send: vi.fn(async () => true),
      now: () => AT(19, 30),
      sleep: async () => {},
      logger: { log() {}, warn() {}, error() {} },
    });
    const r2 = await second;
    expect(r2.sent).toBe(0);
    expect(r2.skippedCapped).toBe(1);
  });

  it('never sends the same auction to the same user twice', async () => {
    const { result, send } = runWith(
      { now: () => AT(19) },
      {
        auctions: [lot('a', 'Vehicles')],
        users: [user('u1')],
        // Sent over a week ago, so the six-day per-user cap has genuinely
        // expired. That matters: with a shorter gap the cap would be what
        // blocks the send, and this test would silently stop exercising the
        // per-AUCTION dedupe it is named after.
        log: {
          u1_a_daily_digest: { uid: 'u1', auctionId: 'a', type: 'daily_digest', sentAt: AT(19) - 8 * 24 * 3600_000 },
          'u1__cap_daily_digest': { uid: 'u1', sentAt: AT(19) - 8 * 24 * 3600_000 },
        },
      },
    );
    const r = await result;
    expect(send).not.toHaveBeenCalled();
    expect(r.skippedAlreadySent).toBe(1);
  });

  it('writes the log only AFTER a delivered send', async () => {
    // Logging first would make a failed send permanent: the lot is marked seen
    // and never retried, so the user simply never hears about it.
    const { result, writes } = runWith(
      { send: vi.fn(async () => false) },
      { auctions: [lot('a', 'Vehicles')], users: [user('u1')] },
    );
    const r = await result;
    expect(r.failed).toBe(1);
    expect(writes).toHaveLength(0);
  });
});

describe('dry run', () => {
  it('sends nothing but reports who it would have reached', async () => {
    const { result, send } = runWith(
      { dryRun: true },
      { auctions: [lot('a', 'Vehicles')], users: [user('u1')] },
    );
    const r = await result;
    expect(send).not.toHaveBeenCalled();
    expect(r.intended).toEqual([
      { uid: 'u1', phone: '+962790000000', auctionIds: ['a'], lang: 'ar' },
    ]);
  });

  it('does NOT write the per-recipient log, so the real run still sends', async () => {
    // A rehearsal that marks everyone as messaged silently cancels the
    // performance — and it would look like a successful dry run.
    const { db, writes } = runWith({ dryRun: true }, { auctions: [lot('a', 'Vehicles')], users: [user('u1')] });
    await runDailyDigest({
      db,
      dryRun: true,
      send: vi.fn(async () => true),
      now: () => AT(19),
      sleep: async () => {},
      logger: { log() {}, warn() {}, error() {} },
    });
    expect(writes).toHaveLength(0);

    const real = vi.fn(async () => true);
    const r = await runDailyDigest({
      db,
      send: real,
      now: () => AT(19),
      sleep: async () => {},
      logger: { log() {}, warn() {}, error() {} },
    });
    expect(real).toHaveBeenCalledTimes(1);
    expect(r.sent).toBe(1);
  });
});

describe('resilience', () => {
  it('one failing recipient does not stop the rest of the run', async () => {
    const send = vi.fn(async ({ uid }) => uid !== 'u2');
    const { result } = runWith(
      { send, concurrency: 1 },
      { auctions: [lot('a', 'Vehicles')], users: [user('u1'), user('u2'), user('u3')] },
    );
    const r = await result;
    expect(r.sent).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.attempted).toBe(3);
  });

  it('a sender that THROWS is still only one failure', async () => {
    const send = vi.fn(async ({ uid }) => {
      if (uid === 'u1') throw new Error('relay exploded');
      return true;
    });
    const { result } = runWith(
      { send, concurrency: 1 },
      { auctions: [lot('a', 'Vehicles')], users: [user('u1'), user('u2')] },
    );
    const r = await result;
    expect(r.failed).toBe(1);
    expect(r.sent).toBe(1);
  });

  it('reports every counter the spec asks to be logged', async () => {
    const { result } = runWith(
      { concurrency: 1 },
      {
        auctions: [lot('a', 'Vehicles')],
        users: [user('u1'), user('u2', { interests: ['Phones'] }), user('u3', { notifyChannel: 'none' })],
      },
    );
    const r = await result;
    expect(r).toMatchObject({ attempted: 3, sent: 1, failed: 0, skippedNoMatch: 1, skippedOptedOut: 1 });
    expect(r.freshLots).toBe(1);
  });
});

describe('sendWithRetry', () => {
  it('retries with backoff and succeeds on a later attempt', async () => {
    let n = 0;
    const send = vi.fn(async () => ++n === 3);
    const delays = [];
    const ok = await sendWithRetry(send, { uid: 'u' }, { sleep: async (ms) => delays.push(ms), logger: { warn() {} } });
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([500, 1000]);
  });

  it('gives up after the last attempt rather than looping', async () => {
    const send = vi.fn(async () => false);
    const ok = await sendWithRetry(send, { uid: 'u' }, { attempts: 2, sleep: async () => {}, logger: { warn() {} } });
    expect(ok).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('mapWithConcurrency', () => {
  it('never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('processes every item exactly once', async () => {
    const seen = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (v) => void seen.push(v));
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
