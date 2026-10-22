// The membership paywall must stay counted.
//
// WHAT WENT WRONG BEFORE. `membership_submitted` fired after the payment proof
// upload and was the ONLY recorded moment in the entire membership flow. The
// product could count who finished paying and could not count who saw the ask.
// That missing denominator is exactly what the keep-or-remove decision needs,
// and its absence is why a removal test would have been uninterpretable.
//
// THE TRAP THIS GUARDS. The paywall is opened from FIVE places, and one of them
// is not a call site: `applyNavNode` opens it straight from the URL
// (`?modal=subscription`) on a deep link or a Back/Forward pop. An audit that
// instrumented "the four call sites" would have produced a number that looked
// complete and silently missed the fifth. So the events fire from the modal —
// the one place every path must pass through — and this test pins both halves:
// the modal still fires, and nothing opens the prompt without declaring why.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, sourceFiles, stripComments, assertNonEmpty } from '../constants/sourceFiles';

const TS_TSX = /\.(ts|tsx)$/;
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('the gate view is recorded', () => {
  const modal = () => read('src/components/SubscriptionPromptModal.tsx');

  it('fires membership_gate_shown from the modal, not from the callers', () => {
    const src = modal();
    expect(src).toMatch(/membership_gate_shown/);
    // From an effect, so it is tied to the modal appearing rather than to any
    // one path deciding to open it.
    expect(src).toMatch(/useEffect/);
  });

  it('records an outcome in both directions', () => {
    const src = modal();
    expect(src).toMatch(/membership_gate_cta/);
    expect(src).toMatch(/membership_gate_dismissed/);
  });

  it('guards against double-counting a single open', () => {
    // StrictMode double-invokes effects in development. A gate view counted
    // twice understates the conversion rate it exists to measure.
    const src = modal();
    expect(src).toMatch(/shownRef/);
    expect(src).toMatch(/outcomeRecordedRef/);
  });

  it('does not write an event the rules will refuse', () => {
    expect(modal()).toMatch(/canRecordGateEvent/);
  });
});

describe('every path that opens the paywall declares why', () => {
  it('has no un-sourced opener anywhere in src/', () => {
    // `setShowSubscriptionPrompt(true)` is the raw, un-sourced form. Closing
    // with `false` is fine. The ONE legitimate `true` is inside
    // `openSubscriptionPrompt`, which sets the source immediately before it —
    // so a call is allowed only when a source assignment sits directly above.
    // Anything else opens the gate blind, which is the regression.
    const offenders: string[] = [];
    const files = sourceFiles(join(ROOT, 'src'), TS_TSX);
    assertNonEmpty(files, 'membership gate sweep');

    for (const file of files) {
      const rel = file.replace(/\\/g, '/').replace(ROOT.replace(/\\/g, '/') + '/', '');
      if (rel.includes('.test.')) continue;
      const lines = stripComments(readFileSync(file, 'utf8'), file).split('\n');
      lines.forEach((line, i) => {
        if (!/setShowSubscriptionPrompt\s*\(\s*true\s*\)/.test(line)) return;
        const above = lines.slice(Math.max(0, i - 2), i).join('\n');
        if (/setSubscriptionPromptSource\s*\(/.test(above)) return;
        offenders.push(`${rel}:${i + 1}`);
      });
    }

    expect(
      offenders,
      'these open the paywall without a source, so the gate view lands as "unknown": ' + offenders.join(', '),
    ).toEqual([]);
  });

  it('the URL path — the one an audit of call sites misses — sets a source', () => {
    const ctx = read('src/context/AppContext.tsx');
    // applyNavNode opens the modal from `?modal=subscription`.
    expect(ctx).toMatch(/setSubscriptionPromptSource\('deeplink'\)/);
  });

  it('the four in-app paths each name a distinct entry point', () => {
    const ctx = read('src/context/AppContext.tsx');
    const bidFlow = read('src/hooks/useBidFlow.ts');
    const profile = read('src/components/ProfileView.tsx');

    expect(bidFlow).toMatch(/openSubscriptionPrompt\('bid_gate'\)/);
    expect(ctx).toMatch(/openSubscriptionPrompt\('bid_client_gate'\)/);
    expect(ctx).toMatch(/openSubscriptionPrompt\('bid_server_refused'\)/);
    expect(profile).toMatch(/openSubscriptionPrompt\('profile_upgrade'\)/);
  });
});

describe('the funnel has both ends', () => {
  it('declares the start events alongside the end event that already existed', () => {
    const svc = read('src/services/analyticsService.ts');
    for (const e of [
      'membership_gate_shown',
      'membership_gate_dismissed',
      'membership_gate_cta',
      'membership_submitted',
    ]) {
      expect(svc, `${e} must be a declared analytics event`).toContain(`'${e}'`);
    }
  });
});
