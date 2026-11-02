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

/**
 * The translation table is NOT where most of this page's copy lives.
 *
 * THE HOLE THIS CLOSES. The first pass of this guard read translations.ts and
 * nothing else, so it certified a page it had only partly looked at. A large
 * share of the landing copy is written inline in LandingView.tsx — as
 * `lang === "ar" ? "…" : "…"` ternaries and as hardcoded data arrays — and all
 * of it was invisible here. The sharpest example: the pass rewrote
 * `hero.carDetails` to «مثال توضيحي» and the hero renders
 * `ACTIVE_ITEMS[].detailsAr` instead, so «صور حقيقية» stayed on screen over
 * stock photography while this file reported the claim removed. A guard that
 * reads one of the two files does not guard the page; it guards a file.
 *
 * So the claim checks below read BOTH. LandingView.tsx also holds class names
 * and URLs, which is fine: these assertions match claim phrases, not words.
 */
function allCopy(): string {
  const inView = LANDING_VIEW.match(/"(?:[^"\\]|\\.)*"/g) || [];
  expect(inView.length, 'parsed no strings out of LandingView.tsx').toBeGreaterThan(100);
  return allStrings() + '\n' + inView.join('\n');
}

describe('the landing page does not make claims the product cannot back', () => {
  const copy = () => allCopy();

  it('claims no price superlative', () => {
    // The old H1 was "اشترِ بأرخص سعر." — an unsubstantiated superlative that
    // the sign-in guard already forbade one screen deeper.
    expect(copy()).not.toMatch(/أرخص|أفضل سعر|cheapest|best price|buy for less|for less\b/i);
  });

  it('guarantees nothing', () => {
    // "نضمن" — Mazzado holds the payment, which is a mechanism, not a promise
    // about the outcome. The distinction is the whole trust proposition.
    //
    // THE FORMS MATTER. The first pass matched «نضمن» only, so «عضوية مدفوعة
    // تضمن جدية الجميع» walked straight through it and stayed on the page in
    // the comparison table — the one guarantee the product's own data refutes
    // (27 of 53 paying members never placed a bid). A guard that catches one
    // conjugation of a verb catches nothing. If «تضمن» ever trips on its other
    // sense — "to include" — rewrite the sentence rather than the guard.
    expect(copy()).not.toMatch(/نضمن|تضمن|يضمن|مضمون|guarantee/i);
    expect(copy()).not.toMatch(/to ensure (serious|safe|fair)/i);
  });

  it('does not claim sellers are identity-verified', () => {
    // ID verification is weeks 5–6 work ([plan] tasks 16–17). Until it exists,
    // the honest claim is that listings are REVIEWED.
    expect(copy()).not.toMatch(/بائعون موثّقون|بائعون موثوقون|verified sellers/i);
    expect(copy()).not.toMatch(/نتحقق من هوية البائع|verify every seller/i);
    expect(copy()).not.toMatch(/موثقة بالكامل|fully verified/i);

    // THE SAME CLAIM, FOUR MORE TIMES. The first pass rewrote the trust CARD
    // to «كل إعلان مُراجَع» and left the section subtitle one line above it
    // still saying «كل بائع موثّق» — both rendered on screen together — plus
    // «✓ موثّقة» on every card in the live grid (LandingView.tsx:332), which
    // is the most-repeated verification claim on the page.
    expect(copy()).not.toMatch(/كل بائع موثّق|every seller is verified/i);
    expect(copy()).not.toMatch(/مزايدون موثوقون|بائع موثق|verified seller\b/i);
    expect(copy()).not.toMatch(/verified: "موثّقة"|verified: "Verified"/);
  });

  it('does not claim the item itself is checked', () => {
    // Reviewing a LISTING is not inspecting an ITEM. LandingView.tsx's own
    // comment already said «we do not claim to inspect every lot ourselves»,
    // while the seller step card two thousand lines away promised an expert
    // team verifies the product's accuracy.
    expect(copy()).not.toMatch(/يتأكد من دقة ووصف المنتج|verifies the accuracy/i);
    expect(copy()).not.toMatch(/certified checks|legal verification/i);
    expect(copy()).not.toMatch(/فاحصين كل التفاصيل|inspect every single detail/i);
  });

  it('promises mediation, not a refund', () => {
    // The escrow bullet promised the held money back whenever there is a
    // problem; the FAQ on the same page promised only mediation. Of the two,
    // the product can keep the second.
    expect(copy()).not.toMatch(/يرجّع لك مبلغك|returns your held payment/i);
  });

  it('does not say bidding is free on a page that sells a membership', () => {
    // «ما في وديعة للمزايدة» is about the DEPOSIT and is true. The English
    // twin generalised it to "Nothing to pay to bid" — the pay-to-bid framing
    // inverted, on the page that sells the 1 JOD membership.
    expect(copy()).not.toMatch(/nothing to pay to bid|المزايدة مجانية/i);
  });

  it('does not offer a cancellation that does not exist', () => {
    // Fixed 30/180/365-day grants against a one-off CliQ transfer. No
    // recurring billing, no cancel path, no refund path in src/ or functions/.
    expect(copy()).not.toMatch(/ألغِ اشتراكك|cancel your subscription/i);
  });

  it('calls a reviewed listing reviewed', () => {
    // The deleting half of the guard above has a matching half here, so the
    // badge cannot be quietly dropped instead of corrected.
    expect(copy()).toMatch(/مُراجَعة/);
    expect(copy()).toMatch(/"Reviewed"/);
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
