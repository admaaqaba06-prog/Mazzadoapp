import type { OrderStatusCode } from './utils/orderStatusGlossary';
/**
 * Core Data Models for MAZZADO
 * Production-ready TypeScript Interfaces
 */

import type { ViewingMode } from './utils/viewing';
import type { SecondChanceOffer } from './utils/secondChanceOffer';

export interface User {
  id: string;
  uid?: string;
  name: string;
  email: string;
  avatar: string;
  role: 'user' | 'seller' | 'admin';
  isAdmin?: boolean;
  accountStatus?: 'active' | 'blocked' | string;
  isVerified: boolean;
  verificationStatus?: 'not_verified' | 'pending' | 'verified' | 'premium_verified';
  isBlocked: boolean;
  // E2 ban ladder: graduated, auto-expiring blocks. `blockedUntil` is the epoch
  // ms (or Firestore Timestamp) the block lifts; null/undefined = permanent.
  // `blockedReason` keys the ban-notice copy; `strikeCount` is the ladder rung.
  blockedUntil?: number | { toMillis?: () => number; seconds?: number } | null;
  blockedReason?: string;
  strikeCount?: number;
  phoneNumber?: string;
  phone?: string;
  city?: string;
  subscriptionStatus: 'active' | 'pending' | 'rejected' | 'expired' | 'none';
  subscriptionExpiry?: string | number | null;
  subscriptionPlan?: string;
  subscriptionTier?: string;
  subscriptionApprovedAt?: string;
  subscriptionExpiresAt?: string;
  paymentProofImage?: string;
  transferFullName?: string;
  transferPhone?: string;
  createdAt?: string;
  isSeller?: boolean;
  sellerStatus?: 'active' | 'inactive' | string;
  sellerActivatedAt?: any;
  sellerProfile?: {
    storeName: string;
    location: string;
    about: string;
    rating: number;
    completedSales: number;
  };
  onboardingCompleted?: boolean;
  /**
   * CR-01 interest capture. `interests` holds CATEGORY IDS, which are the same
   * canonical values `auctions/{id}.category` stores — see utils/interests.ts
   * for why auto-ids would have quietly broken the digest.
   *
   * Empty + `interestsSkipped` is an answered skip; empty WITHOUT it is a user
   * who has not been asked yet. The two have to stay distinguishable or every
   * skipper gets re-prompted on each login.
   */
  interests?: string[];
  interestsUpdatedAt?: any;
  interestsSkipped?: boolean;
  /** Daily "new auctions matching your interests" digest (CR-02). */
  notifyDaily?: boolean;
  /** Featured-auction alerts (CR-03). Independent of `notifyDaily`. */
  notifyFeatured?: boolean;
  notifyChannel?: "whatsapp" | "push" | "none";
  /**
   * Current consent snapshot. The AUDIT record is the append-only
   * `users/{uid}/consentEvents` subcollection — this field is only the latest
   * state, and the owner can overwrite it, so it proves nothing on its own.
   */
  notificationConsent?: {
    granted: boolean;
    channel: "whatsapp" | "push" | "none";
    at: any;
    source: string;
  };
  shownHints?: { [key: string]: boolean };
  /**
   * Reserved for future seller KYC (Wave 4 groundwork) — NOT captured or
   * enforced anywhere yet. Jordanian national number (الرقم الوطني).
   */
  nationalNumber?: string;
  /** Reserved for future seller KYC — legal name as on official ID. Unenforced. */
  legalName?: string;
}

export interface SellerProfile {
  id: string;
  userId: string;
  storeName: string;
  storeLogo: string;
  coverImage?: string;
  bio: string;
  rating: number; // average rating
  totalSales: number; // completed sales
  isVerifiedMerchant: boolean;
  joinedDate: string;
  location?: string;
  followers?: number;
  following?: number;
  verificationStatus: 'not_verified' | 'pending' | 'verified' | 'premium_verified';
  responseTime?: string;
  cancellationRate?: number;
  aboutSeller?: string;
  trustScore?: number;
  badges?: string[];
  isSuspended?: boolean;
  /**
   * Reserved for future seller KYC (Wave 4 groundwork) — NOT captured or
   * enforced anywhere yet. Jordanian national number (الرقم الوطني).
   */
  nationalNumber?: string;
  /** Reserved for future seller KYC — legal name as on official ID. Unenforced. */
  legalName?: string;
}

export interface AuctionItem {
  id: string;
  title: string;
  description: string;
  category: 'Electronics' | 'Luxury' | 'Vehicles' | 'Fashion' | 'Real Estate' | 'Appliances' | 'Home & Furniture';
  startingPrice: number;
  currentPrice: number;
  minIncrement: number;
  currentBidderId: string | null;
  currentBidderName: string | null;
  videoUrl: string;
  thumbnailUrl: string;
  /**
   * Wave 2 (media gallery): ordered extra gallery images (excludes the video).
   * Rendered after videoUrl + thumbnailUrl — see utils/auctionMedia.ts.
   */
  mediaUrls?: string[];
  /**
   * Unix timestamp (epoch millis), or null for an awaiting-first-bid lot whose
   * clock has not started — see utils/auctionPhase.isAwaitingFirstBidDoc.
   * Callers doing arithmetic MUST guard: `null - now` is a large negative
   * number and `null < now` is true, both of which read as "already ended".
   */
  endTime: number | null;
  duration: number; // in seconds
  paymentWindowHours?: number; // hours winner has to pay before default-block; defaults to 24 server-side
  antiSnipeWindowSec?: number; // final-seconds window that triggers a soft-close extension; default 30 server-side
  antiSnipeExtendSec?: number; // seconds the clock resets to on a late bid; default 30 server-side
  sellerId: string;
  sellerName: string;
  sellerLogo: string;
  status: 'upcoming' | 'live' | 'processing' | 'rejected' | 'completed' | 'ended' | 'reserve_not_met';
  /** Mazad review gate verdict ('processing' listings are 'pending'). */
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  /** Admin-entered reason shown to the seller when a listing is rejected. */
  rejectionReason?: string;
  /**
   * Where a buyer may physically view this lot before bidding. Set by an admin at
   * the approval gate (or at admin drop-create). UNSET MEANS NOT STATED — the UI
   * renders nothing rather than assuming a location. See utils/viewing.ts.
   */
  viewing?: ViewingMode;
  /** Human-readable place, shown only when viewing === 'store'. Admin-entered. */
  viewingPlace?: string;
  isFeatured: boolean;
  totalBids: number;
  viewersCount: number;
  caption?: string;
  marketPrice?: number; // retail/market reference for the "you saved X" reveal
  /** Sequential internal auction number assigned at create from the atomic counter. */
  auctionNumber?: number;
  /**
   * Reserve gate: true when there is no reserve OR the price has reached it.
   * The reserve AMOUNT never lives on this (world-readable) doc — only this boolean.
   * Maintained by onBidCreated; authoritative sale decision re-checks in settleAuctionTxn.
   */
  reserveMet?: boolean;
  /**
   * Width of the below-reserve "near miss" band, as a percentage of the hidden
   * reserve (default 10, clamped 0-50 server-side). Admin-set. Safe to carry on
   * the world-readable auction doc BECAUSE the reserve itself is not here: a
   * percentage with no base discloses nothing. The FLOOR it implies is computed
   * only inside Cloud Functions (settlement.js toleranceFloorFils) and is never
   * sent to a client. Used at SETTLEMENT to decide whether a reserve-not-met top
   * bid is close enough to put to the seller — never at bid time.
   */
  reserveTolerancePct?: number;
  channel?: 'phones' | 'cars' | 'misc';
  scheduledStartAt?: number | null;
  /**
   * E3 Slice A — start mode. 'scheduled' (default/unset): fixed window opened by
   * scheduledStartAt. 'first_bid': goes live immediately with NO endTime; the
   * duration clock starts on the first bid (endsAt = now + duration).
   */
  startMode?: 'scheduled' | 'first_bid';
  /**
   * E3 Slice B — seller opt-in: auto-relist the listing (up to MAX_AUTO_RELISTS)
   * if it ends unsold / reserve-not-met. Default false (off).
   */
  autoRelist?: boolean;
  /** E3 Slice B — how many times this listing has already been auto-relisted. */
  autoRelistCount?: number;
  /**
   * E3 Slice C — below-reserve near-miss offer. Stamped by settleAuctionTxn when
   * the auction ends `reserve_not_met` with a real top bid: the seller can accept
   * that top bid (acceptBelowReserve) and the top bidder then confirms
   * (confirmBelowReserve) or declines (declineBelowReserve). Money-path lives in
   * the callables; this is display + gating state only.
   */
  belowReserveOffer?: {
    topBid: number;
    topBidderId: string;
    topBidderName: string;
    /** Firestore Timestamp — seller/buyer decision window (24h from settlement). */
    expiresAt: any;
    /**
     * STORED vocabulary. The API/client contract uses a different one — see
     * `belowReserveOfferPublicStatus` in utils/reserveStatus.ts, which is the
     * mirror of functions/settlement.js's `belowReservePublicStatus`:
     *   pending_seller           -> 'pending_seller_decision'
     *   pending_buyer, confirmed -> 'accepted_below_reserve'
     *   declined, expired        -> 'rejected_below_reserve'
     * 'expired' is stamped by the auto-relist sweep on a lapsed offer.
     */
    status: 'pending_seller' | 'pending_buyer' | 'confirmed' | 'declined' | 'expired';
    sellerAcceptedAt?: any;
    /** Seller (or admin) turned the offer down via the rejectBelowReserve callable. */
    sellerRejectedAt?: any;
    buyerConfirmedAt?: any;
    buyerDeclinedAt?: any;
  };
  /**
   * Second Chance Offer — stamped by the payment-default enforcer when the
   * WINNER fails to pay: the lot is offered to the runner-up bidder for their
   * own bid. Same shape and status vocabulary as `belowReserveOffer` (both are
   * read by settlement.belowReserveBlocksRelist), but opened from a default
   * rather than a near-miss. `pending_seller` = the runner-up's bid is under the
   * reserve and the seller is being asked; `pending_buyer` = it cleared the
   * reserve (or the seller accepted) and the runner-up is being offered the lot.
   * Acted on via the `respondToSecondChance` callable; display + gating only
   * here. See src/utils/secondChanceOffer.ts for who may do what.
   */
  secondChanceOffer?: SecondChanceOffer;
  /** Internal vendor tracking (set in drop-builder, never shown to buyers in v1). */
  vendorId?: string | null;
  vendorName?: string;
  /**
   * Concierge submission ("Let Mazad list it for me"): the seller sent item
   * details and the Mazad team completes the listing before approving.
   * a.k.a. listedByMazad — the admin queue badges these. Default false.
   */
  isConcierge?: boolean;
  /**
   * Wave 4 (seller-KYC groundwork): seller checked the required listing-time
   * "I own this item and it is legal to sell in Jordan" attestation.
   * createListing stamps both onto every auction doc it writes.
   */
  ownershipAttested?: boolean;
  /** Firestore serverTimestamp of when the ownership/legality attestation was made. */
  attestedAt?: any;
  /** Seller-declared item condition (concierge submit form). */
  condition?: 'new' | 'used';
  /** Seller contact (phone/WhatsApp) for the concierge team to follow up. */
  conciergeContact?: string;
  /** Extra concierge photos beyond the thumbnail (up to 2 more). */
  conciergePhotos?: string[];
  /**
   * Wave 3 (simulator): created by the admin auction simulator. NEVER shown to
   * real users; admins see it only while the simulator toggle is ON. Enforced
   * client-side by utils/simVisibility at the AppContext source.
   */
  isSimulated?: boolean;
}

export interface Bid {
  id: string;
  auctionId: string;
  bidderId: string;
  bidderName: string;
  bidderAvatar: string;
  amount: number;
  timestamp: number; // Unix timestamp
  status: 'winning' | 'outbid' | 'escrowed' | 'completed' | 'refunded';
  /** Simulator-created (bid bot) — see AuctionItem.isSimulated. */
  isSimulated?: boolean;
}

export interface Wallet {
  userId: string;
  totalBalance: number;
  availableBalance: number;
  escrowBalance: number;
  pendingWithdrawalBalance?: number;
}

export interface EscrowTransaction {
  id: string;
  walletId: string;
  auctionId: string;
  auctionTitle: string;
  bidderId: string;
  bidderName: string;
  sellerId: string;
  sellerName: string;
  amount: number;
  status: 'locked' | 'released' | 'refunded';
  timestamp: number;
  paymentProofUrl?: string; // For CliQ receipt upload preview
  cliqAlias?: string;
}

export interface ChatMessage {
  id: string;
  auctionId: string;
  userId: string;
  userName: string;
  userAvatar: string;
  text: string;
  timestamp: number;
  isSystem: boolean; // System log/announcements
  isBid: boolean; // Bid announcements
  bidAmount?: number;
}

export interface Notification {
  id: string;
  userId: string;
  title: string;
  description: string;
  // 'withdrawal' is written by functions/index.js (the payout callables) and
  // was missing here — the server produced a type the client could not name.
  type: 'info' | 'outbid' | 'win' | 'refund' | 'verify' | 'alert' | 'bid' | 'loss' | 'wallet' | 'order' | 'subscription' | 'admin' | 'withdrawal';
  priority?: 'high' | 'medium' | 'low';
  timestamp: number;
  read: boolean;
  auctionId?: string;
  /** Written by every order-related server notification; used to route the
   *  notification to its Buying/Selling tab (see utils/notifications.ts). */
  orderId?: string;
}

// adminActions rows exist in two historical shapes (see src/utils/adminAudit.ts).
// Divergent fields are optional so both validate; normalizeAdminAction() unifies them.
export interface AdminAction {
  id: string;
  // OLD schema
  actionType?: string;
  targetId?: string;
  targetName?: string;
  // NEW schema
  action?: string;
  orderId?: string;
  auctionId?: string;
  adminId?: string;
  // common
  adminName: string;
  timestamp: any; // number (ms) OR Firestore Timestamp
  details?: string;
}

/**
 * E6 — buyer return claim. Raised by the buyer on a `shipped` order via the
 * `requestReturn` callable, which freezes the order into a `disputed` state
 * (disputeType: 'return') and stamps this claim onto the order.
 */
export type ReturnReason = 'not_as_described' | 'damaged';

export interface ReturnClaim {
  reason: ReturnReason;
  description: string;
  photoUrls: string[];
  sellerPaysReturnShipping: boolean;
  status: 'open' | 'accepted' | 'resolved_refunded' | 'resolved_denied';
  createdAt: number;
  sellerResponse?: string;
}

export interface Order {
  id: string;
  auctionId: string;
  auctionTitle: string;
  auctionImage: string;
  sellerId: string;
  sellerName: string;
  buyerId: string;
  buyerName: string;
  winningBidAmount: number;
  /** Single source: OrderStatusCode in utils/orderStatusGlossary.ts. See the note on OrderStatus in utils/orderWorkflow.ts. */
  status: OrderStatusCode;
  paymentStatus: "unpaid" | "paid";
  shippingStatus: "not_started" | "preparing" | "shipped" | "delivered";
  escrowStatus: "pending" | "locked" | "released" | "refunded";
  /** E3 Slice C — this order came from a below-reserve near-miss (seller accepted the top bid). */
  belowReserve?: boolean;
  /** Wave 2 — human-readable MZ order reference (e.g. "MZ-7K3QP"), assigned server-side after order creation. Globally unique; safe to read off a screen/WhatsApp. */
  orderRef?: string;
  createdAt: any;
  updatedAt: any;
  // Money model (set by Cloud Functions on order creation):
  // winner pays totalDue = winningBidAmount + 5% buyer's premium via CliQ
  // bank transfer within paymentDeadlineAt (24h), then uploads a receipt.
  buyersPremium?: number;
  totalDue?: number;
  /**
   * E1 money model — seller economics stamped server-side at settlement.
   * sellerCommission = 5% of the hammer (winningBidAmount); sellerNet = hammer
   * minus that commission (what the seller actually receives). Display only —
   * the payout math lives in functions/settlement.js.
   */
  sellerCommission?: number;
  sellerNet?: number;
  /**
   * Embedded CliQ (Bank al Etihad / Staq) — the GATEWAY payment, distinct from
   * the manual transfer above. Mazzado raises a request, the payer approves it
   * in their own banking app, and a webhook reports the outcome.
   *
   * ALL OF THESE ARE SERVER-WRITTEN. They are on the orders update denylist in
   * firestore.rules: `cliqPaymentStatus` is the paid flag, and the two
   * timestamps ARE the 90-minute duplicate lock, so a client that could write
   * them could pay for free or raise unlimited requests.
   *
   * The payer's FULL identifier is NOT here: orders are seller-readable and
   * Firestore has no field-level read denylist, so it lives in the admin-only
   * cliqPayerIdentifiers/{orderId} doc. Only the masked form is on the order.
   */
  cliqPaymentStatus?: 'none' | 'pending' | 'paid' | 'rejected' | 'expired';
  cliqRequestId?: string;
  cliqRequestCreatedAt?: any;
  cliqRequestExpiresAt?: any;
  cliqPayerIdentifierType?: 'alias' | 'mobile';
  /** MASKED only. The full value is admin-only in cliqPayerIdentifiers/{orderId}. */
  cliqPayerIdentifierMasked?: string;
  /** First 8 chars of the payer's IBAN, returned by BAE before submission. */
  cliqPayerIbanPrefix?: string | null;
  cliqAmount?: number;
  cliqFees?: number;
  cliqTotal?: number;
  cliqSettledAt?: any;
  /** Which rail settled this order. Absent on the manual-transfer path. */
  paymentMethod?: 'cliq_gateway';
  paymentDeadlineAt?: any;
  paymentProofUrl?: string;
  /**
   * E1 — the phone number the buyer's CliQ transfer is coming FROM (may differ
   * from their account number, e.g. a family member pays). Buyer-writable on
   * their own order at the pay step; surfaced to admin to match the transfer.
   */
  /** MASKED only. Full number is admin-only in cliqPaymentSenders/{orderId}. */
  cliqSenderPhoneMasked?: string;
  /** @deprecated Pre-split orders only — never written for new payments. */
  cliqSenderPhone?: string;
  /** Wave 1 — CliQ transaction reference the buyer entered at the pay step. Server-written; buyers cannot reuse a reference (hard-blocked at submit). Surfaced to admin to match the transfer. */
  txnRef?: string;
  /** Wave 1 — normalized form of txnRef (server-written) used for duplicate detection. */
  txnRefNormalized?: string;
  /** Wave 1 — number of times the buyer submitted payment on this order. */
  paymentAttempts?: number;
  /** Wave 1 — timestamp of the buyer's payment submission. */
  paymentSubmittedAt?: any;
  /** Slice B verification stamp — server-only via the verifyOrderPayment callable. */
  paymentVerified?: boolean;
  /** Slice B verification stamp — server-only via the verifyOrderPayment callable. */
  paymentVerifiedBy?: string;
  /** Slice B verification stamp — server-only via the verifyOrderPayment callable. */
  paymentVerifiedAt?: any;
  /** Slice B verification stamp — server-only via the verifyOrderPayment callable. */
  paymentRejectionReason?: string;
  /** Slice C fulfillment nudge — admin-stamped only, via sendFulfillmentNudge. Informational (no rate-limit). */
  lastNudgedAt?: any;
  /** Times an admin has nudged this order (any bucket). Admin-only. */
  nudgeCount?: number;
  /** Reason the buyer/seller gave when opening the dispute. Buyer/seller-writable (their own transition). */
  disputeReason?: string;
  /** Slice D dispute-resolution stamp — admin-only via stampDisputeResolution, recorded AFTER the real resolution (release/refund/resume) already happened. */
  resolutionNotes?: string;
  disputeResolvedBy?: string;
  disputeResolvedAt?: any;
  disputeResolutionType?: 'release' | 'refund' | 'resume';
  trackingNumber?: string;
  /**
   * Wave 3 — evidence-gated delivery. `prepPhotoUrl` and `sentPhotoUrl` are
   * SELLER-written (firestore.rules requires each before the matching status
   * write); `receivedPhotoUrl`, `deliveredAt`, `deliveryConfirmedBy` and
   * `deliveryCodeAttempts` are SERVER-only via releaseOrderEscrow.
   *
   * The delivery code itself is NEVER on this doc. The buyer can read the whole
   * order and Firestore has no field-level read denylist, so the code lives in
   * deliveryCodes/{orderId} (seller + admin read only) — see firestore.rules.
   */
  prepPhotoUrl?: string;
  sentPhotoUrl?: string;
  receivedPhotoUrl?: string;
  deliveryMethod?: 'hand' | 'courier';
  deliveryCodeAttempts?: number;
  deliveryConfirmedBy?: string;
  deliveredAt?: any;
  /**
   * Wave 2 (W4): per-order delivery address + phone the winner provides at the
   * post-win payment step (an address can differ per win). Written by the buyer
   * on the 'pay' transition; surfaced to the seller/admin ONLY after payment.
   * See utils/deliveryAddress.ts (validation) + firestore.rules orders S2.
   */
  deliveryAddress?: {
    governorate: string;
    area: string;
    building?: string;
    notes?: string;
  };
  deliveryPhone?: string;
  /**
   * The SELLER's end of the courier handover, mirroring the two fields above.
   * Written only by the `submitPickupDetails` callable, and only once
   * `paymentVerified` is true — an order doc is readable by the buyer, the
   * seller and admins, and Firestore has no field-level read control, so
   * anything here is visible to the buyer the moment it lands. That gate
   * matches the one revealCounterpartyContact applies to the seller's phone.
   * Validated server-side in functions/pickupDetails.js.
   */
  pickupAddress?: {
    governorate: string;
    area: string;
    building?: string;
    notes?: string;
  };
  pickupPhone?: string;
  /** Who the courier asks for — defaults to the seller's account name. */
  pickupName?: string | null;
  pickupSubmittedAt?: any;
  pickupSubmittedBy?: string;
  defaultedAt?: any;
  /** Internal vendor slug copied from the auction (never buyer-facing). */
  vendorId?: string | null;
  /** Simulator-created (simulateSettleNow) — see AuctionItem.isSimulated. */
  isSimulated?: boolean;
  /**
   * E6 — buyer return claim stamped by the `requestReturn` callable when the
   * buyer reports a problem on a `shipped` order. Present on `disputed` orders
   * that came through the return flow.
   */
  returnClaim?: ReturnClaim;
  /** E6 — distinguishes a return-driven dispute from a generic manual dispute. */
  disputeType?: 'return' | 'generic';
  /**
   * Which team member is accountable for chasing this order along. Admin-only:
   * both fields are on the buyer/seller denylist in firestore.rules, so a
   * seller cannot reassign or clear ownership of their own order.
   */
  assignedToId?: string;
  assignedToName?: string;
}

/**
 * Order-level review (v1 investment loop).
 * Two directions share the `reviews` collection:
 *  - buyer_rates_auction: buyer rates their won auction (buyerId == author uid, per firestore.rules)
 *  - mazad_rates_buyer:   admin one-tap buyer trust rating (buyerId = the rated buyer, ratedBy = admin uid)
 *  - seller_rates_buyer:  E7 — seller rates the buyer after a completed order
 *                         (buyerId = the rated buyer, ratedBy/sellerId = the seller uid)
 */
export interface OrderReview {
  id: string;
  orderId: string;
  auctionId: string;
  buyerId: string;
  stars: number;
  text: string;
  direction: 'buyer_rates_auction' | 'mazad_rates_buyer' | 'seller_rates_buyer';
  vendorId?: string | null;
  ratedBy?: string;
  createdAt: any;
}

export interface Review {
  id: string;
  sellerId: string;
  buyerId: string;
  buyerName: string;
  buyerAvatar: string;
  rating: number;
  comment: string;
  timestamp: number;
  response?: string;
  responseAt?: number;
  auctionTitle: string;
  auctionId: string;
  photos?: string[];
}

export interface Withdrawal {
  id: string;
  userId: string;
  amount: number;
  method: 'bank' | 'cliq';
  status: 'pending' | 'completed' | 'rejected';
  timestamp: number;
  details: {
    bankName?: string;
    iban?: string;
    accountHolderName?: string;
    cliqAlias?: string;
    phone?: string;
  };
  referenceId: string;
}

export interface VerificationRequest {
  id: string;
  userId: string;
  sellerName: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedStatus: 'verified' | 'premium_verified';
  submittedAt: number;
  businessLicenseUrl?: string;
  nationalIdUrl?: string;
  idFrontUrl?: string;
  idBackUrl?: string;
  passportUrl?: string;
  notes?: string;
}

export interface SellerReport {
  id: string;
  reporterId: string;
  reporterName: string;
  sellerId: string;
  sellerName: string;
  reason: 'counterfeit' | 'wrong_desc' | 'damaged' | 'fraud' | 'other';
  description: string;
  timestamp: number;
  status: 'pending' | 'resolved';
}

export interface Dispute {
  id: string;
  orderId: string;
  buyerId: string;
  buyerName: string;
  sellerId: string;
  sellerName: string;
  amount: number;
  description: string;
  photos: string[];
  videos: string[];
  sellerResponse?: string;
  sellerRespondedAt?: number;
  status: 'open' | 'resolved_refunded' | 'resolved_released';
  timestamp: number;
  resolvedAt?: number;
  resolverName?: string;
}


