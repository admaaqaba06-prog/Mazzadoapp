// CR-02 wiring — the parts that only exist as text in index.js and
// firestore.rules, and that no unit test would notice regressing.
//
// The run logic is covered in dailyDigestRun.test.js against a fake Firestore.
// What is asserted here is the stuff around it: that the cron is actually on
// Amman time, that the admin trigger cannot send by accident, that the inbound
// opt-out endpoint refuses to run unauthenticated, and that no client can
// rewrite the ledger the caps depend on.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`./${p}`, import.meta.url), 'utf8');
const readRoot = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('the schedule', () => {
  const idx = () => code(read('index.js'));

  it('runs on Amman wall-clock time', () => {
    // Without the timeZone the job runs on UTC and fires at 22:00 Amman — an
    // hour before quiet hours, which is exactly the kind of near-miss nobody
    // spots from a log line that says "sent".
    expect(idx()).toMatch(/\.timeZone\('Asia\/Amman'\)/);
  });

  it('takes the hour from config, not a literal in the cron string', () => {
    const src = idx();
    expect(src).toMatch(/process\.env\.DIGEST_HOUR/);
    expect(src).toMatch(/\.schedule\(`\$\{DIGEST_MINUTE\} \$\{DIGEST_HOUR\} \* \* \$\{DIGEST_DAY\}`\)/);
    expect(src).toMatch(/process\.env\.DIGEST_DAY/);
  });

  it('falls back to 19:00 when the env var is absent or nonsense', () => {
    expect(idx()).toMatch(/Number\.isInteger\(raw\) && raw >= 0 && raw <= 23 \? raw : 19/);
  });

  it('warns when the configured hour would be swallowed by quiet hours', () => {
    // Otherwise the job fires, the gate rejects it, and the logs read like a
    // working cron that simply never sends.
    expect(idx()).toMatch(/DIGEST_HOUR >= DIGEST_QUIET_START \|\| DIGEST_HOUR < DIGEST_QUIET_END/);
  });

  it('swallows a thrown run instead of letting the scheduler retry it', () => {
    // A scheduler retry is a second evening message for everyone already sent.
    const src = idx();
    const block = src.slice(src.indexOf('exports.dailyInterestDigest'), src.indexOf('exports.runDailyDigestNow'));
    expect(block).toMatch(/try \{[\s\S]*runDailyDigest[\s\S]*\} catch/);
  });
});

describe('the admin trigger', () => {
  const idx = () => code(read('index.js'));

  it('is dry-run by default and needs an explicit false to send', () => {
    // The obvious mistake is calling it to "see what it does". That must not
    // be the call that messages every subscriber at once.
    expect(idx()).toMatch(/const dryRun = !\(data && data\.dryRun === false\)/);
  });

  it('is admin-only', () => {
    const src = idx();
    const block = src.slice(src.indexOf('exports.runDailyDigestNow'), src.indexOf('exports.notificationsInbound'));
    expect(block).toMatch(/await assertAdmin\(context\)/);
  });
});

describe('the send', () => {
  const idx = () => code(read('index.js'));

  it('checks whether the relay actually accepted the message', () => {
    // postToN8n is fire-and-forget and returns nothing. Using it here would
    // write a notifications_log row for a send that never happened, and the
    // lot would then never be offered to that user again.
    const src = idx();
    const block = src.slice(src.indexOf('async function postDigestToN8n'), src.indexOf('function digestDeps'));
    expect(block).toMatch(/await isRelayDelivered\(res\)/);
    expect(block).not.toMatch(/postToN8n\(/);
  });

  it('asks only for WhatsApp', () => {
    const block = code(read('index.js'));
    expect(block).toMatch(/channels: \{ inapp: false, whatsapp: true, email: false \}/);
  });

  it('sends copy rendered in this repo, not a template name', () => {
    // n8n/build-messages.js forwards a non-blank wa_text straight through, so
    // the workflow needs no change — and the wording stays reviewable here.
    expect(code(read('index.js'))).toMatch(/wa_text: text/);
  });
});

describe('the inbound opt-out endpoint', () => {
  const block = () => {
    const src = code(read('index.js'));
    return src.slice(src.indexOf('exports.notificationsInbound'));
  };

  it('fails CLOSED when no shared secret is configured', () => {
    // It edits notification settings by phone number alone. Unauthenticated,
    // anyone who guessed the URL could silence any customer — and silence is
    // the one failure this feature cannot detect on its own.
    expect(block()).toMatch(/if \(!secret\) \{[\s\S]{0,300}503/);
  });

  it('compares the secret in constant time', () => {
    expect(block()).toMatch(/crypto\.timingSafeEqual/);
  });

  it('turns BOTH digests off, and the channel with them', () => {
    const b = block();
    expect(b).toMatch(/notifyDaily: on/);
    expect(b).toMatch(/notifyFeatured: on/);
    expect(b).toMatch(/notifyChannel: on \? 'whatsapp' : 'none'/);
  });

  it('records the opt-out in the append-only consent trail', () => {
    // An opt-OUT is exactly as important to be able to prove as an opt-in.
    expect(block()).toMatch(/collection\('consentEvents'\)/);
  });

  it('answers 200 for an unknown number rather than inviting a retry', () => {
    expect(block()).toMatch(/action: 'unknown_number'/);
  });
});

describe('notification rules', () => {
  const rules = () => readRoot('firestore.rules');

  it('lets no client write the ledger the caps depend on', () => {
    // A client that could write notifications_log could erase its own cap row
    // and be messaged on every run; one that could delete rows could make the
    // digest resend everything it has already sent.
    const src = rules();
    const block = src.slice(src.indexOf('match /notifications_log/'), src.indexOf('match /notificationRuns/'));
    expect(block).toMatch(/allow read: if isAdmin\(\);/);
    expect(block).toMatch(/allow write: if false;/);
  });

  it('keeps the kill switch reachable from the console', () => {
    // Admin-writable on purpose: a switch that needs an engineer to flip is
    // not a kill switch.
    const src = rules();
    const block = src.slice(src.indexOf('match /config/notifications'), src.indexOf('match /config/{docId}'));
    expect(block).toMatch(/allow write: if isAdmin\(\);/);
  });

  it('closes the rest of config/ to clients', () => {
    const src = rules();
    const block = src.slice(src.indexOf('match /config/{docId}'));
    expect(block.slice(0, 120)).toMatch(/allow read, write: if false;/);
  });
});

// The digest introduces a brand-new event name into a workflow that was written
// before it existed. That is a contract between two systems, and the n8n side
// is deployed separately — a saved node edit is only a draft until it is
// published — so "it will probably be fine" is not good enough here.
//
// What makes it fine is specific and worth pinning: Build Messages forwards a
// non-blank `wa_text` verbatim, and its local copy map returns a safe default
// for an unrecognised event instead of throwing. The throw is the one that
// would matter: that Code node feeds BOTH send branches, so an exception in it
// aborts the run before either fires — the whole digest would vanish with a red
// execution and no message.
describe('the n8n contract for a new event', () => {
  const bm = () => readRoot('n8n/build-messages.js');

  it('forwards a non-blank wa_text verbatim', () => {
    expect(bm()).toMatch(/typeof b\.wa_text === 'string' && b\.wa_text\.trim\(\) !== ''/);
  });

  it('falls back rather than throwing on an event it has never heard of', () => {
    // If this map ever starts throwing for unknown keys, the digest stops
    // dead — silently, because index.js only logs a relay rejection.
    expect(bm()).toMatch(/return M\[event\] \|\| \{ type: 'info'/);
  });

  it('gates the WhatsApp send on the channels Functions sent', () => {
    expect(bm()).toMatch(/sendWhatsapp: ch\.whatsapp === true && phone\.length >= 8/);
  });

  it('will not send an email for a digest that carries no address', () => {
    // channels.email is false AND the address is empty, so both halves of the
    // guard hold. Either alone would be enough; this asserts the one in n8n.
    expect(bm()).toMatch(/sendEmail: ch\.email === true &&/);
  });
});
