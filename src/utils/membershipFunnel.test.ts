import { describe, it, expect } from 'vitest';
import {
  canRecordGateEvent,
  gateMetadata,
  SUBSCRIPTION_PROMPT_SOURCES,
} from './membershipFunnel';

describe('canRecordGateEvent', () => {
  // analytics_events is `allow create: if isSignedIn() && userId == auth.uid`,
  // and logAnalyticsEvent swallows a rejection into console.warn. Firing
  // anonymously does not fail loudly — it fails invisibly, which is how a
  // dashboard ends up looking complete when it is not.
  it('refuses an anonymous view rather than writing something the rules deny', () => {
    expect(canRecordGateEvent(null)).toBe(false);
    expect(canRecordGateEvent(undefined)).toBe(false);
    expect(canRecordGateEvent('')).toBe(false);
    expect(canRecordGateEvent('   ')).toBe(false);
  });

  it('allows a signed-in view', () => {
    expect(canRecordGateEvent('uid-123')).toBe(true);
  });
});

describe('gateMetadata', () => {
  it('always carries a source', () => {
    // A gate view with no entry point is a row nobody can act on: a bid gate
    // and a profile upgrade are different intents and converting them at
    // different rates is the whole point of splitting them.
    expect(gateMetadata('bid_gate')).toEqual({ source: 'bid_gate' });
  });

  it('falls back to "unknown" rather than recording a source it cannot vouch for', () => {
    expect(gateMetadata(null)).toEqual({ source: 'unknown' });
    expect(gateMetadata(undefined)).toEqual({ source: 'unknown' });
    expect(gateMetadata('something_invented' as never)).toEqual({ source: 'unknown' });
  });

  it('merges extra fields without letting them overwrite the source', () => {
    expect(gateMetadata('profile_upgrade', { cta: 'join' })).toEqual({
      source: 'profile_upgrade',
      cta: 'join',
    });
  });

  it('accepts every declared source', () => {
    for (const s of SUBSCRIPTION_PROMPT_SOURCES) {
      expect(gateMetadata(s).source).toBe(s);
    }
  });
});
