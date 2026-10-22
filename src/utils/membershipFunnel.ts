/**
 * The membership paywall funnel — the half that was never recorded.
 *
 * THE PROBLEM THIS FIXES. `membership_submitted` fires AFTER the payment proof
 * is uploaded. It was the first — and only — recorded moment in the whole
 * membership flow. So the product could count who *finished paying* and could
 * not count who *saw the ask*, which is exactly the denominator the
 * keep-or-remove-the-membership decision needs. A removal test run without it
 * is uninterpretable in either direction: a drop in revenue tells you nothing
 * if you never knew how many people the gate turned away.
 *
 * WHY THE MODAL FIRES THIS, NOT THE CALLERS. Five separate paths open the
 * prompt, and one of them is not a call site at all — `applyNavNode` opens it
 * from the URL (`?modal=subscription`) on a deep link or a Back/Forward pop.
 * Instrumenting the four call sites would have produced a number that looked
 * complete and silently missed the fifth. The modal is the one place every path
 * must pass through, so it is where the event belongs.
 */

/** Why the paywall appeared. Recorded so the funnel can be split by entry. */
export type SubscriptionPromptSource =
  /** Client-side bid gate decided membership was the next step. */
  | 'bid_gate'
  /** placeBid's own derived member check refused before the round-trip. */
  | 'bid_client_gate'
  /** The server returned MEMBERSHIP_REQUIRED. */
  | 'bid_server_refused'
  /** "Upgrade & Manage Plans" on the profile. */
  | 'profile_upgrade'
  /** Opened from the URL — deep link, refresh, or Back/Forward. */
  | 'deeplink'
  /** A path that did not declare itself. Should stay at zero. */
  | 'unknown';

export const SUBSCRIPTION_PROMPT_SOURCES: readonly SubscriptionPromptSource[] = [
  'bid_gate',
  'bid_client_gate',
  'bid_server_refused',
  'profile_upgrade',
  'deeplink',
  'unknown',
];

/**
 * Can this gate view actually be recorded?
 *
 * `analytics_events` is `allow create: if isSignedIn() && userId == auth.uid`
 * (firestore.rules), and `logAnalyticsEvent` swallows a rejection into a
 * `console.warn`. So an anonymous write is not merely lost — it is lost
 * QUIETLY, which is how a dashboard ends up reading as complete when it is not.
 *
 * Returning false here keeps us from firing writes we know the rules will
 * refuse. The gap is real and bounded: every gate that matters to the decision
 * is reached by a signed-in user, because the bid flow sends a guest to sign-in
 * BEFORE it ever reaches the membership step. The only anonymous path is
 * someone opening `?modal=subscription` directly, which is not the funnel.
 *
 * Counting anonymous views needs a store that accepts them — GA4 or the Meta
 * pixel — neither of which exists yet. Until then this undercount is known,
 * small, and written down rather than hidden.
 */
export function canRecordGateEvent(userId: string | null | undefined): boolean {
  return typeof userId === 'string' && userId.trim() !== '';
}

/**
 * Metadata for a gate event.
 *
 * `source` is always present so the funnel can be split by entry point —
 * a bid gate and a profile upgrade are not the same intent, and averaging them
 * would hide which one converts.
 */
export function gateMetadata(
  source: SubscriptionPromptSource | null | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const known = source && (SUBSCRIPTION_PROMPT_SOURCES as readonly string[]).includes(source);
  return { source: known ? source : 'unknown', ...extra };
}
