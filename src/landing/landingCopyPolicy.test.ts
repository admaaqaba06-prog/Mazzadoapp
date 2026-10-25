// The landing page is the page the ads point at. It gets the same guard.
//
// WHY THIS EXISTS. `src/components/signInPanelCopy.test.ts` already fails the
// build on "أرخص / cheapest", on "ضمان / guarantee" and on "بائعون موثوقون /
// verified sellers". Someone had decided those claims were unsafe and built the
// machine that enforces it — and pointed it at the sign-in panel, a surface a
// visitor reaches AFTER they are interested.
//
// The landing page shipped all three. It is the destination Meta reviews, and
// it carried the one framing most likely to get an auction account banned: a
// ~1 JOD opening price on a flagship phone, on the same page as a membership
// you must pay before you may bid. That is the shape of a bidding-fee auction,
// and `[plan 2026-09-27, p.6]` attributes the @mazzadoofficial ban to exactly
// that plus an activity spike.
//
// So the guard moves to the page that needs it. This reads the translation
// table as DATA, both languages, and fails on the claims the product cannot
// back.
//
// NOT A META RULING. The policy reasoning is recorded in
// ops/reports/cmo/2026-10-22-marketing-audit.md §3 and is sourced to Meta's
// published Advertising Standards, which Meta restructures. This test encodes
// what MAZZADO decided not to say (D-110), not what Meta currently forbids.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./translations.ts', import.meta.url), 'utf8');
const LANDING_VIEW = readFileSync(new URL('./LandingView.tsx', import.meta.url), 'utf8');

/** Every quoted string in the translation table, both languages. */
function allStrings(): string {
  const quoted = SRC.match(/"(?:[^"\\]|\\.)*"/g) || [];
  expect(quoted.length, 'parsed no strings out of translations.ts').toBeGreaterThan(200);
  return quoted.join('\n');
}

describe('the landing page does not make claims the product cannot back', () => {
  const copy = () => allStrings();

  it('claims no price superlative', () => {
    // The old H1 was "اشترِ بأرخص سعر." — an unsubstantiated superlative that
    // the sign-in guard already forbade one screen deeper.
    expect(copy()).not.toMatch(/أرخص|أفضل سعر|cheapest|best price|buy for less|for less\b/i);
  });

  it('guarantees nothing', () => {
    // "نضمن" — Mazzado holds the payment, which is a mechanism, not a promise
    // about the outcome. The distinction is the whole trust proposition.
    expect(copy()).not.toMatch(/نضمن|guarantee/i);
  });

  it('does not claim sellers are identity-verified', () => {
    // ID verification is weeks 5–6 work ([plan] tasks 16–17). Until it exists,
    // the honest claim is that listings are REVIEWED.
    expect(copy()).not.toMatch(/بائعون موثّقون|بائعون موثوقون|verified sellers/i);
    expect(copy()).not.toMatch(/نتحقق من هوية البائع|verify every seller/i);
    expect(copy()).not.toMatch(/موثقة بالكامل|fully verified/i);
  });

  it('promises no delivery window it cannot hold', () => {
    // A 48-hour promise against a stated 1-in-3 handover failure.
    expect(copy()).not.toMatch(/خلال 48 ساعة|48 hours|delivered in/i);
  });

  it('does not frame a one-dinar entry to a high-value lot', () => {
    // THE BAN RISK. A ~1 JOD opening price next to a paid-to-bid membership is
    // the defining shape of a bidding-fee auction. The membership PRICE may say
    // 1 JOD — that is true and protected by D-002 — but an opening BID may not.
    expect(copy()).not.toMatch(/يبدأ من 1 دينار|opening bid: just|من 1 دينار فقط/i);
    expect(LANDING_VIEW).not.toMatch(/ابدأ المزايدة — 1 دينار|Start Bidding — 1 JOD/);
  });

  it('does not use chance-to-acquire or prize framing', () => {
    expect(copy()).not.toMatch(/فرصتك لامتلاك|your chance to own/i);
    expect(copy()).not.toMatch(/إلى الفوز|to winning|win with absolute/i);
    expect(copy()).not.toMatch(/active battle|منافسة نشطة/i);
  });

  it('presents no statistic it did not measure', () => {
    // "%98 — تركيز على الثقة" measured nothing. CLAUDE.md rule 1.
    expect(copy()).not.toMatch(/"%?98%?"/);
  });

  it('labels the simulated hero lot as an example', () => {
    // The hero runs a generated demo with a rising bid counter. It used to call
    // its photos real.
    expect(copy()).not.toMatch(/صور حقيقية|Real Photos/i);
    expect(copy()).toMatch(/مثال توضيحي/);
    expect(copy()).toMatch(/Illustrative example/i);
  });

  it('keeps the claims the product DOES back', () => {
    // A guard that only deletes leaves a page that says nothing. These are the
    // true replacements, and losing them is also a regression.
    expect(copy()).toMatch(/السعر يحدده السوق/);
    expect(copy()).toMatch(/market sets the price/i);
    expect(copy()).toMatch(/يراجعها فريقنا|reviewed by our team/i);
  });
});

describe('the one-dinar rule', () => {
  it('still allows the membership price, which is true', () => {
    // Removing this would be over-correction: 1 JOD/month IS the membership
    // price, it is protected by D-002, and the subscription framing is what
    // REFUTES a bidding-fee reading. What is forbidden is a 1 JOD opening bid.
    expect(LANDING_VIEW).toMatch(/1 د\.أ شهرياً|1 JOD\/month/);
  });
});
