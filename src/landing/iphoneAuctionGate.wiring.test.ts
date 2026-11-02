// The launch banner may not announce a lot that does not exist.
//
// WHAT HAPPENED. `AUCTION_START_DATE` was 2026-09-24 and `AUCTION_ID` was null.
// `started` was derived from the clock alone, so the moment that date passed
// the section began announcing «المزاد بدأ الآن» with a «زايد الآن» button —
// and `goToAuction` falls through to Discover when there is no id, so every
// visitor who pressed it landed on a general feed. It stayed that way for over
// a month, on the section that paid ad traffic lands on.
//
// WHY A TEST AND NOT A COMMENT. The file already carried a comment promising
// that a bad start date is safe, because `parseAuctionStart` returns null and
// the section stays pre-launch. That promise was true for a TYPO and false for
// a date that is perfectly well-formed and simply in the past. A comment cannot
// tell those apart; this can.
//
// Reads the source as data: the gate is one expression inside a component, and
// asserting on it directly costs less than mounting the page and faking a clock
// — and it fails for the right reason, naming the expression that must not be
// weakened.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AUCTION_ID, AUCTION_START_DATE } from './components/IPhoneAuctionSection';
import { parseAuctionStart } from './auctionCountdown';

const SRC = readFileSync(
  new URL('./components/IPhoneAuctionSection.tsx', import.meta.url),
  'utf8',
);

describe('the iPhone launch banner', () => {
  it('requires a real lot before it says bidding is open', () => {
    expect(SRC).toMatch(/const started = AUCTION_ID !== null && hasAuctionStarted\(/);
  });

  it('does not derive "started" from the clock alone', () => {
    // The exact line this replaced. If it comes back, so does the month of
    // announcing an auction that was never there.
    expect(SRC).not.toMatch(/const started = hasAuctionStarted\(secondsLeft\);/);
  });

  it('keeps the button fallback that makes the gate necessary', () => {
    // The gate is only load-bearing because a null id sends the visitor to
    // Discover instead of to a lot. If this ever becomes an unconditional
    // link to a real auction, revisit the gate rather than deleting it.
    expect(SRC).toMatch(/AUCTION_ID \? "live" : "discovery"/);
  });

  it('has a start date that is either in the future or harmless', () => {
    // Not "is the date correct" — nobody can test that. This asserts the pair
    // is never in the one combination that lies: a start date already passed
    // WITH no lot behind it. Setting AUCTION_ID satisfies it; so does moving
    // the date. Leaving both as they were does not.
    const startMs = parseAuctionStart(AUCTION_START_DATE);
    const passed = typeof startMs === 'number' && startMs <= Date.now();
    expect(
      !passed || AUCTION_ID !== null,
      `AUCTION_START_DATE (${AUCTION_START_DATE}) has passed while AUCTION_ID is still null — ` +
        'set the lot id, or move the date to the real launch instant.',
    ).toBe(true);
  });
});
