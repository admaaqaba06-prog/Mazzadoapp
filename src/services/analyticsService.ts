import { collection, addDoc } from 'firebase/firestore';
import { db } from './firebase';

export type AnalyticsEventType = 
  | 'user_registration'
  | 'auction_created'
  | 'bid_placed'
  | 'subscription_conversion'
  | 'rate_limit_triggered'
  | 'bid_spam_blocked'
  | 'membership_submitted'
  // Membership paywall funnel. `membership_submitted` above is the END of it
  // — the proof upload — and for a long time it was the ONLY recorded moment,
  // so there was no way to count who ever SAW the ask. See
  // src/utils/membershipFunnel.ts for why these fire from the modal and not
  // from the five paths that open it.
  | 'membership_gate_shown'
  | 'membership_gate_dismissed'
  | 'membership_gate_cta'
  | 'first_bid'
  | 'auction_won_seen'
  | 'payment_submitted'
  // Embedded CliQ funnel (Bank al Etihad / Staq). Metadata carries orderId,
  // auctionId, amount and payerBankName — the BANK NAME ONLY. The payer's
  // alias, mobile and IBAN must never appear here: they are banking
  // identifiers, and this collection is queried for reporting.
  | 'cliq_payment_selected'
  | 'cliq_details_entered'
  | 'cliq_confirmation_viewed'
  | 'cliq_disclaimer_acknowledged'
  | 'cliq_request_submitted'
  | 'cliq_payment_paid'
  | 'cliq_payment_rejected'
  | 'cliq_payment_expired'
  | 'cliq_duplicate_blocked';

export interface AnalyticsEvent {
  id?: string;
  eventType: AnalyticsEventType;
  userId: string | null;
  userEmail: string | null;
  timestamp: number;
  metadata: Record<string, any>;
  clientIp?: string;
}

export const logAnalyticsEvent = async (
  eventType: AnalyticsEventType,
  userId: string | null,
  userEmail: string | null,
  metadata: Record<string, any> = {}
) => {
  try {
    const eventData: AnalyticsEvent = {
      eventType,
      userId,
      userEmail,
      timestamp: Date.now(),
      metadata,
    };

    // Print to dev console in a premium structured format
    console.log(
      `%c[ANALYTICS] %c${eventType.toUpperCase()} %c- User: ${userEmail || 'Anonymous'}`,
      'color: #FF6B00; font-weight: bold;',
      'color: #0088FF; font-weight: bold;',
      'color: #888888;',
      metadata
    );

    // Save directly to the live Firestore 'analytics_events' collection for full persistence
    const analyticsRef = collection(db, 'analytics_events');
    await addDoc(analyticsRef, eventData);
  } catch (err) {
    console.warn('[ANALYTICS ERROR] Failed to record event in Firestore:', err);
  }
};
