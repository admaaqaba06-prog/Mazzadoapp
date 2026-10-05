import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { db, auth, getCallableFunction, OperationType, handleFirestoreError } from '../services/firebase';
import { logAnalyticsEvent } from '../services/analyticsService';
import { isFirstBidDone, markFirstBidDone } from '../components/feedback/FirstBidCoach';
// Direct file import (not the feedback barrel) to avoid a circular import:
// other feedback components consume useApp from this module.
import { useToast } from '../components/feedback/Toast';
import { resolveVideoUrl } from '../utils/videoDb';
import { minNextBid } from '../utils/bidMath';
import { nextHeartbeatDelayMs } from '../utils/heartbeat';
import { resizeImage } from '../utils/resizeImage';
import { mapAuthError } from '../utils/authErrors';
import { isAdminUser, isAdminOrSeller } from '../utils/adminAuth';
import { ADMIN_AUCTIONS_CAP } from '../utils/adminDirectory';
import { blockedApprovalReason, approvalClockFields } from '../utils/approvalGuard';
import { restoreLocalAuction } from '../utils/localAuctionRollback';
import { MAZAD_STORE_NAME, MAZAD_STORE_LOGO } from '../constants/mazadStore';
import { filterSimulated } from '../utils/simVisibility';
import type { SecondChanceAction } from '../utils/secondChanceOffer';
import { mapAuctionDocFull, PLACEHOLDER_MEDIA } from '../utils/auctionDocMap';
import { useSimulatorEnabled } from '../hooks/useSimulatorEnabled';
import { useThrottledLocalStorageSync } from '../hooks/useThrottledLocalStorageSync';
import { isValidCityId } from '../utils/jordanCities';
import { stripReserve } from '../utils/reserveStrip';
import { toE164Jordan } from '../utils/phoneNumber';
import { serializeNav, parseNav, isModalCloseTransition, type NavNode } from '../utils/navUrl';
import { trackPageView, trackRegistration, trackBid, trackListItem } from '../lib/pixel';
import type { SaveInterestsInput } from '../utils/interests';
import { computeServerOffset, setServerOffset, serverNow } from '../utils/serverTime';
import { isActiveMember } from '../utils/membership';
import { distinctSellerIds, nextMissingSellerIds } from '../utils/sellerPrefetch';
import { isExpectedBidFailure } from '../utils/bidErrors';
import { isRateLimited, cooldownUntil, rateLimitMessage } from '../utils/bidRateLimitNotice';
import { syncAuctionsFromSnapshot } from '../utils/auctionsSync';
import { readGuestBrowsingFlag } from '../utils/guestGate';
import { isEffectivelyBlocked } from '../utils/banStatus';
import { resolveNotificationContent } from '../utils/notificationContent';
import type { ViewingMode } from '../utils/viewing';
import { viewingWritePayload } from '../utils/viewing';
import { persistLanguagePreference, shouldAdoptLocalLanguage } from '../utils/languagePersistence';
import {
  DEFAULT_THEME, THEME_STORAGE_KEY, normalizeTheme, shouldAdoptLocalTheme,
  persistThemePreference, storedDocTheme, type Theme,
} from '../utils/themePersistence';
import { applyThemeAttribute, readStoredTheme } from '../utils/themeBoot';

// Cache of resolved video URLs to prevent excessive IndexedDB reads and performance degradation during rapid real-time updates
const videoUrlCache = new Map<string, { rawUrl: string; resolvedUrl: string }>();

// Negative cache for the seller-profile prefetch (PF1). Holds sellerIds whose
// fetch came back a GENUINE miss (no profile doc existed at read time) so a
// profile-less seller — including the `seller-system` sentinel — is never
// re-fetched on every auctions snapshot. Module-level so it survives re-renders
// and never becomes an effect dependency. Tradeoff: a profile created AFTER a
// cached miss won't be re-prefetched here, but the authoritative sellerProfiles
// listener still delivers it — the cache only suppresses the redundant prefetch.
const attemptedSellerIds = new Set<string>();

// Local, bundled "media unavailable" poster. Used as the thumbnail fallback for
// auctions with no image. Previously these fallbacks pointed at third-party hosts
// (Unsplash images / Google `gtv-videos` sample MP4s) which added uncontrolled
// per-render bandwidth and latency (bad for load and for a load test). A single
// local asset is cached after first paint and never leaves the origin.
// NOTE: the constant now lives in `utils/auctionDocMap` (single source of truth,
// shared with the pure mapper) and is re-imported above.

import { 
  GoogleAuthProvider, 
  signInWithPopup, 
  signInWithRedirect,
  getRedirectResult,
  onAuthStateChanged, 
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updateProfile,
  PhoneAuthProvider,
  linkWithCredential
} from 'firebase/auth';
import { doc, setDoc, onSnapshot, collection, addDoc, getDoc, getDocs, serverTimestamp, updateDoc, deleteDoc, deleteField, Timestamp, query, where, orderBy, limit, getCountFromServer, getDocFromServer, writeBatch, type QueryDocumentSnapshot } from 'firebase/firestore';
import { postSignInView, type SignInIntent } from '../utils/signInIntent';
import { 
  User, SellerProfile, AuctionItem, Bid, Wallet, 
  EscrowTransaction, ChatMessage, Notification, AdminAction, Order,
  Review, VerificationRequest, SellerReport, Dispute, OrderReview, ReturnReason
} from '../types';

// Maps a raw Firestore auction doc → AuctionItem (thumbnail/video fallbacks,
// fils→JOD conversion, timestamp normalisation). Shared by the main
// live/upcoming subscription and the seller's own-pending targeted read so both
// surfaces render identical shapes. Any doc whose video needs async blob
// resolution is pushed onto `itemsToResolve` for the caller to resolve.
const mapAuctionDoc = (
  docSnap: any,
  itemsToResolve: { id: string; rawUrl: string; category: string }[]
): AuctionItem => {
  const data = docSnap.data();
  const itemId = docSnap.id;

  // Pure synchronous base (every static/live/timestamp/fils field) — shared with
  // the upcoming per-doc `useAuctionDoc` hook so a room lot maps identically to
  // the broad feed. Byte-identical to the old inline object (same fallbacks, same
  // trailing `...data` override, same post-spread thumbnail/image assignment).
  const item = mapAuctionDocFull(itemId, data);

  // Async storage video-URL resolution side effects — INTENTIONALLY kept in this
  // wrapper (not in the pure mapper). This block only writes the resolved-URL
  // cache and queues blob videos onto `itemsToResolve` for the caller's async
  // pass; it does NOT change `item.videoUrl` here. That matches the prior
  // behavior exactly: the old inline object also had its computed `finalVideoUrl`
  // overridden by the trailing `...data` spread (→ `data.videoUrl` when present,
  // else ''), so the synchronous `videoUrl` never depended on the cache — the
  // cache lookup only governed whether a lot was queued for async resolution.
  const rawVideoUrl = data.videoUrl || '';
  const cached = videoUrlCache.get(itemId);
  if (cached && cached.rawUrl === rawVideoUrl) {
    // Already resolved & cached — nothing to queue.
  } else if (rawVideoUrl && !rawVideoUrl.startsWith('blob:')) {
    // Direct network URL — cache it as its own resolution; no async work needed.
    videoUrlCache.set(itemId, { rawUrl: rawVideoUrl, resolvedUrl: rawVideoUrl });
  } else {
    // No resolvable network URL yet (blob:/empty). Queue for async blob resolution
    // so the resolver may fill the video in later via setState.
    itemsToResolve.push({ id: itemId, rawUrl: rawVideoUrl, category: data.category || 'Luxury' });
  }

  return item;
};

interface AppContextProps {
  currentUser: User;
  setCurrentUser: React.Dispatch<React.SetStateAction<User>>;
  sellerProfile: SellerProfile | null;
  setSellerProfile: React.Dispatch<React.SetStateAction<SellerProfile | null>>;
  
  // Lists
  users: User[];
  setUsers: React.Dispatch<React.SetStateAction<User[]>>;
  // True account total from a server aggregation (the `users` listener is capped);
  // null until the count query resolves. Use for total-account stats, not users.length.
  theme: Theme;
  setTheme: (t: Theme) => void;
  usersTotalCount: number | null;
  // True auction total from a server aggregation (the `auctions` listener is
  // capped at ADMIN_AUCTIONS_CAP); null until the count query resolves. Use for
  // "showing X of Y", never auctions.length.
  auctionsTotalCount: number | null;
  sellerProfiles: SellerProfile[];
  setSellerProfiles: React.Dispatch<React.SetStateAction<SellerProfile[]>>;
  // NOTE (Wave 3c / PF2): `auctions` / `setAuctions` / `auctionsLoaded` moved
  // to their own AuctionsContext (useAuctions) — see the split below ChatContext.
  bids: Bid[];
  setBids: React.Dispatch<React.SetStateAction<Bid[]>>;
  wallet: Wallet;
  setWallet: React.Dispatch<React.SetStateAction<Wallet>>;
  escrows: EscrowTransaction[];
  setEscrows: React.Dispatch<React.SetStateAction<EscrowTransaction[]>>;
  orders: Order[];
  setOrders: React.Dispatch<React.SetStateAction<Order[]>>;
  notifications: Notification[];
  setNotifications: React.Dispatch<React.SetStateAction<Notification[]>>;
  adminActions: AdminAction[];
  setAdminActions: React.Dispatch<React.SetStateAction<AdminAction[]>>;
  adminActionsError?: string;

  // Trust System Lists
  reviews: Review[];
  verificationRequests: VerificationRequest[];
  sellerReports: SellerReport[];
  disputes: Dispute[];

  // Post-win review loop (Track C2)
  myReviews: OrderReview[];
  pendingReviewOrder: Order | null;
  reviewPromptOrderId: string | null;
  setReviewPromptOrderId: (id: string | null) => void;

  // Active View State
  activeAuctionId: string | null;
  setActiveAuctionId: (id: string | null) => void;
  activeView: 'landing' | 'discovery' | 'live' | 'wallet' | 'orders' | 'admin' | 'upload' | 'about' | 'seller-center' | 'profile' | 'drop-builder' | 'auction-drop-builder' | 'prohibited-items';
  setActiveView: (view: 'landing' | 'discovery' | 'live' | 'wallet' | 'orders' | 'admin' | 'upload' | 'about' | 'seller-center' | 'profile' | 'drop-builder' | 'auction-drop-builder' | 'prohibited-items') => void;
  showNotifications: boolean;
  setShowNotifications: (show: boolean) => void;
  // Wave 2b: 'add-funds' and 'withdraw' sub-views were removed — the wallet
  // is a read-only record (bidding is free; seller payouts are off-platform).
  globalWalletSubView: 'wallet-home' | 'transactions' | 'orders';
  setGlobalWalletSubView: (subView: 'wallet-home' | 'transactions' | 'orders') => void;
  globalSelectedOrderId: string | null;
  setGlobalSelectedOrderId: (id: string | null) => void;

  // Real-time Event Actions
  placeBid: (auctionId: string, amount: number) => Promise<{ success: boolean; message: string }>;
  /**
   * Epoch ms until the SERVER's bidding cooldown lifts; 0 when not limited.
   * Display/disable only — see utils/bidRateLimitNotice.
   */
  bidCooldownUntil: number;
  requestWithdrawal: (amount: number, method: string, accountDetails: any) => Promise<{ success: boolean; message: string }>;
  // E3 Slice C — below-reserve near-miss
  acceptBelowReserve: (auctionId: string) => Promise<{ success: boolean; message: string }>;
  /** Seller/admin turns down a still-pending below-reserve offer. */
  rejectBelowReserve: (auctionId: string) => Promise<{ success: boolean; message: string }>;
  confirmBelowReserve: (auctionId: string) => Promise<{ success: boolean; message: string }>;
  declineBelowReserve: (auctionId: string) => Promise<{ success: boolean; message: string }>;
  // Second Chance Offer — seller/runner-up act on a defaulted lot's offer
  respondToSecondChance: (
    auctionId: string,
    action: SecondChanceAction
  ) => Promise<{ success: boolean; message: string }>;
  // E6 — buyer return flow
  requestReturn: (
    orderId: string,
    input: { reason: ReturnReason; description: string; photoUrls: string[] }
  ) => Promise<{ success: boolean; message: string }>;
  // E6 B1 — seller responds to an open return claim (advisory; no money)
  sellerRespondToReturn: (
    orderId: string,
    input: { accept: boolean; note?: string }
  ) => Promise<{ success: boolean; message: string }>;
  // E7 — seller rates the buyer after a completed order (no money)
  rateBuyer: (
    orderId: string,
    input: { stars: number; comment?: string }
  ) => Promise<{ success: boolean; message: string }>;
  // Buyer rates the seller/auction after a completed order (order-verified callable, no money)
  rateAuction: (
    orderId: string,
    input: { stars: number; comment?: string }
  ) => Promise<{ ok?: boolean }>;
  addNotification: (title: string, description: string, type: Notification['type'], priority?: 'high' | 'medium' | 'low', auctionId?: string) => void;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  
  // Admin Operations
  /**
   * Resolves to the WRITE'S OUTCOME, never to `undefined`. The Action Center
   * hides the row optimistically and un-hides it only on `success: false`, so a
   * swallowed failure would make the lot vanish until reload.
   */
  approveListing: (id: string, viewing?: ViewingMode, viewingPlace?: string) => Promise<{ success: boolean }>;
  /**
   * Correct a lot's viewing AFTER approval. `approveListing` can only set it at
   * the moment of approval, and a live lot has already left the pending queue —
   * so without this a wrong place (typo, shop moved) was only fixable from the
   * Firebase console. Passing '' CLEARS the claim back to "not stated".
   */
  setAuctionViewing: (id: string, viewing: ViewingMode | '', viewingPlace: string) => Promise<{ success: boolean; message?: string }>;
  /** Reports the write's outcome — see approveListing. */
  rejectListing: (id: string, reason?: string) => Promise<{ success: boolean }>;
  verifySeller: (userId: string) => void;
  banUser: (userId: string) => void;
  unbanUser: (userId: string) => void;
  releaseEscrow: (escrowId: string) => void;
  refundEscrow: (escrowId: string) => void;
  deleteAuction: (id: string) => void;
  repairEndedAuctionOrder: (auctionId: string) => Promise<{ success: boolean; message: string }>;
  repairStuckEscrowsForEndedAuction: (auctionId: string) => Promise<{ success: boolean; message: string; refundedCount?: number; totalRefundedAmount?: number; keptWinnerEscrow?: boolean }>;
  approveWithdrawal: (withdrawalId: string, transferRef: string) => Promise<{ success: boolean; message: string }>;
  rejectWithdrawal: (withdrawalId: string, reason?: string) => Promise<{ success: boolean; message: string }>;

  // Trust System Operations
  submitVerificationRequest: (
    requestedStatus: 'verified' | 'premium_verified', 
    notes?: string,
    idFrontUrl?: string,
    idBackUrl?: string,
    passportUrl?: string
  ) => Promise<{ success: boolean; message: string }>;
  submitSellerReview: (sellerId: string, auctionId: string, auctionTitle: string, rating: number, comment: string, photos?: string[]) => Promise<{ success: boolean; message: string }>;
  submitSellerReport: (sellerId: string, sellerName: string, reason: SellerReport['reason'], description: string) => Promise<{ success: boolean; message: string }>;
  submitDispute: (orderId: string, description: string, photos: string[], videos: string[]) => Promise<{ success: boolean; message: string }>;
  respondToDispute: (disputeId: string, response: string) => Promise<{ success: boolean; message: string }>;
  respondToReview: (reviewId: string, response: string) => Promise<{ success: boolean; message: string }>;
  approveVerificationRequest: (requestId: string) => Promise<{ success: boolean; message: string }>;
  rejectVerificationRequest: (requestId: string) => Promise<{ success: boolean; message: string }>;
  suspendSeller: (userId: string, suspend: boolean) => Promise<{ success: boolean; message: string }>;
  removeSellerBadge: (userId: string, badgeName: string) => Promise<{ success: boolean; message: string }>;
  resetSellerTrustScore: (userId: string) => Promise<{ success: boolean; message: string }>;
  
  // Seller Listing Creation
  createListing: (
    listingData: Omit<AuctionItem, 'id' | 'currentPrice' | 'sellerId' | 'sellerName' | 'sellerLogo' | 'status' | 'isFeatured' | 'totalBids' | 'viewersCount'>,
    videoFile?: File | Blob | null,
    thumbnailFile?: File | Blob | null,
    onProgress?: (progress: number, stage: 'video' | 'thumbnail' | 'saving') => void,
    initialStatus?: string,
  ) => Promise<string>;

  // AUTH & MULTILINGUAL & SUBSCRIPTION ADDITIONS
  language: 'en' | 'ar';
  setLanguage: (lang: 'en' | 'ar') => void;
  isAuthenticated: boolean;
  authReady: boolean;
  // Guest browsing: a resolved logged-out session (authReady && !isAuthenticated).
  isGuest: boolean;
  // Latched when a guest taps a gated action (bid/chat/save/...). App.tsx swaps
  // the guest browse shell for the login flow; activeView/activeAuctionId stay
  // latched, so after signup the visitor lands back on that exact listing.
  signInRequested: boolean;
  /** Why the visitor is being asked to sign in — drives the screen's copy. */
  signInIntent: SignInIntent | null;
  requestSignIn: (intent?: SignInIntent) => void;
  dismissSignIn: () => void;
  login: (email: string, pass: string) => Promise<{ success: boolean; message: string }>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  registerUser: (name: string, email: string, password?: string, phone?: string) => Promise<{ success: boolean; message: string }>;
  loginWithPhone: (phoneE164: string, appVerifier: import('firebase/auth').ApplicationVerifier) => Promise<import('firebase/auth').ConfirmationResult>;
  confirmPhoneCode: (confirmation: import('firebase/auth').ConfirmationResult, code: string) => Promise<{ success: boolean; message: string }>;

  // WhatsApp OTP — PRIMARY phone sign-in (loginWithPhone/confirmPhoneCode SMS is the
  // fallback). requestWhatsappOtp sends a 6-digit code over WhatsApp; verifyWhatsappOtp
  // returns a Firebase custom token; signInWhatsapp exchanges it for a session.
  requestWhatsappOtp: (phone: string) => Promise<{ ok: boolean; delivered?: boolean; retryAfterSec?: number }>;
  verifyWhatsappOtp: (phone: string, code: string) => Promise<{ ok: boolean; token?: string }>;
  signInWhatsapp: (token: string) => Promise<void>;

  // Contact completion (E5): ATTACH a missing phone/email to the CURRENT signed-in
  // account (same uid — never sign into a separate phone account, which would orphan
  // the user's wallet/history). Consumed by ContactCompletionModal.
  linkPhoneSendCode: (e164Phone: string, appVerifier: import('firebase/auth').ApplicationVerifier) => Promise<string>;
  linkPhoneToAccount: (verificationId: string, code: string) => Promise<void>;
  // WhatsApp-OTP attach: verifies the code and attaches the phone to the CURRENT
  // uid (same account — no token, no wallet writes). Throws HttpsError on failure
  // (e.g. err.code === 'functions/already-exists' when the number is on another account).
  attachWhatsappPhone: (phone: string, code: string) => Promise<{ ok: boolean }>;
  saveEmail: (email: string) => Promise<void>;
  // Whether the contact-completion modal is open (mounted by the bid/sell gates in A4).
  /**
   * Which single profile field a gate is currently asking for, or null.
   *
   * Replaces the non-dismissible profile wall that used to sit after signup:
   * the fields are now requested at the moment they are used — the name when a
   * bid needs someone to attribute, the city when a won lot needs somewhere to
   * go — one at a time rather than as a form.
   */
  profileFieldPrompt: 'name' | 'city' | null;
  setProfileFieldPrompt: (f: 'name' | 'city' | null) => void;
  contactModalOpen: boolean;
  setContactModalOpen: (open: boolean) => void;
  subscribeUser: (jd: number, paymentProofImage?: string, transferFullName?: string, transferPhone?: string, planId?: string) => Promise<boolean>;
  
  // Profile Completion (Auth/KYC Wave 2)
  updateOwnProfile: (fields: { name?: string; city?: string; email?: string }) => Promise<{ success: boolean; message: string; emailSaved?: boolean }>;

  // Onboarding Additions
  completeOnboarding: () => Promise<void>;
  /** CR-01 — one atomic write for the interests + notification consent step. */
  saveInterests: (input: SaveInterestsInput) => Promise<void>;
  resetOnboarding: (userId?: string) => Promise<void>;
  markHintAsShown: (hintKey: string) => Promise<void>;

  // Watch list & Auto-bid attributes
  watchlist: string[];
  toggleWatchlist: (auctionId: string) => void;
  autoBids: { [auctionId: string]: number };
  setAutoBid: (auctionId: string, maxBid: number) => void;
  removeAutoBid: (auctionId: string) => void;

  // Subscription Renewal Prompt
  showSubscriptionPrompt: boolean;
  setShowSubscriptionPrompt: (show: boolean) => void;

  // Trust gate: "add a real photo to bid/sell" prompt
  showPhotoGate: boolean;
  setShowPhotoGate: (show: boolean) => void;

  // E2 ban ladder: opens the BanNoticeModal when an effectively-blocked user taps
  // a bid action (reason + when the restriction lifts, or "permanent").
  showBanNotice: boolean;
  setShowBanNotice: (show: boolean) => void;

  // Live Chat Comments System
  sendChatMessage: (text: string) => void;

  // Maintenance & Operational Flags & Health logs
  maintenanceMode: {
    enabled: boolean;
    messageAr?: string;
    messageEn?: string;
    expectedDuration?: string;
  };
  featureFlags: {
    enableLiveAuctions: boolean;
    enableSubscriptions: boolean;
    enableWallets: boolean;
    enablePushNotifications: boolean;
    // Guest browsing kill switch (default ENABLED; flip siteSettings/featureFlags
    // .enableGuestBrowsing to false to restore the login-gated front door
    // instantly in production, no redeploy).
    enableGuestBrowsing: boolean;
    // Algolia-backed Discovery search (Slice 2). Default OFF — reads
    // siteSettings/featureFlags.enableAlgoliaSearch === true to opt in. Stays
    // dormant until the index is backfilled; OFF = today's client-side search.
    enableAlgoliaSearch: boolean;
    // Embedded CliQ (Bank al Etihad) checkout. Default OFF and FAIL-CLOSED
    // (=== true), same convention as enableAlgoliaSearch above and the
    // opposite of enableGuestBrowsing.
    //
    // OFF IS THE CORRECT DEFAULT UNTIL THE BAE INTEGRATION IS LIVE. With the
    // rail visible but no gateway behind it, a real buyer picks CliQ, is told
    // "we sent the request to your bank" — which is not true, nothing was sent
    // — and is then locked out of retrying for 90 minutes by the duplicate
    // guard while their payment deadline runs down.
    enableCliqGateway: boolean;
  };
  updateMaintenanceMode: (enabled: boolean, messageAr?: string, messageEn?: string, expectedDuration?: string) => Promise<void>;
  updateFeatureFlag: (flag: string, value: boolean) => Promise<void>;
  systemHealthLogs: any[];
  logSystemHealth: (type: 'error' | 'payment_fail' | 'bid_fail' | 'wallet_fail', title: string, details: string) => Promise<void>;
}

const AppContext = createContext<AppContextProps | undefined>(undefined);

// Perf (Wave 3c / P0-1): `chatMessages` lives in its OWN context, split out of
// the main AppContext value object. A chat doc is written on every bid, so a
// bidding war spams setChatMessages; when chatMessages was a field on the giant
// AppContext value, each write recreated that value object and re-rendered ALL
// ~39 useApp() consumers (incl. every Discovery card). Isolating it here means
// a chat write only re-renders the two in-room components that read it
// (LiveStreamView / ReelsDesktopRightPanel) via useChat(). The state itself
// still lives in AppProvider (so the chats onSnapshot effect can setChatMessages);
// it's merely PROVIDED through a separate, independently-memoized Context below.
interface ChatContextProps {
  chatMessages: ChatMessage[];
  setChatMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
}

const ChatContext = createContext<ChatContextProps | undefined>(undefined);

// Perf (Wave 3c / PF2): `auctions` lives in its OWN context, split out of the
// main AppContext value object — the same isolation pattern as ChatContext
// above. The auctions onSnapshot fires on EVERY bid in the room, so when
// `auctions` (visibleAuctions) was a field on the giant AppContext value, each
// bid recreated that value object and re-rendered ALL ~39 useApp() consumers —
// wallet, notifications, admin lists — even though only auction surfaces care.
// Now a bid invalidates only useAuctions() consumers. The state itself still
// lives in AppProvider (the auctions onSnapshot effect calls setAuctions); it
// is merely PROVIDED through this separate, independently-memoized Context.
// `auctions` here is the FILTERED visibleAuctions (sim-visibility + own-pending
// merge), exactly what the old appValue.auctions exposed.
interface AuctionsContextProps {
  auctions: AuctionItem[];
  setAuctions: React.Dispatch<React.SetStateAction<AuctionItem[]>>;
  /** True once the first auctions snapshot (or an error) has arrived for the current view. */
  auctionsLoaded: boolean;
}

const AuctionsContext = createContext<AuctionsContextProps | undefined>(undefined);

// Clean Initial Production States (No Demo/Mock Data)
const DEFAULT_UNAUTHENTICATED_USER: User = {
  id: 'unauthenticated',
  name: 'User',
  email: '',
  avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&q=80',
  role: 'user',
  isVerified: false,
  isBlocked: false,
  subscriptionStatus: 'none',
  createdAt: ''
};

const INITIAL_USERS: User[] = [];
const INITIAL_SELLERS: SellerProfile[] = [];
const INITIAL_AUCTIONS: AuctionItem[] = [];
const INITIAL_CHATS: ChatMessage[] = [];
const INITIAL_ESCROWS: EscrowTransaction[] = [];
const INITIAL_NOTIFICATIONS: Notification[] = [];

// Bell state contains PRIVATE, cross-user Firestore verdicts (incl. rejection
// reasons), so it is persisted PER-USER — never under a shared key a later
// account on the same device could read (Wave E1 review fix).
const NOTIF_STORE_PREFIX = 'mazad_notifications_';
const DISMISSED_STORE_PREFIX = 'mazad_dismissed_notif_ids_';
// Pre-fix shared keys — purged on boot and on logout.
const LEGACY_NOTIF_KEY = 'mazad_notifications';
const LEGACY_DISMISSED_KEY = 'mazad_dismissed_notif_ids';

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Transient error feedback: the bell only shows the bidder-relevant
  // allowlist (Wave D), so user-facing failures must ALSO toast.
  const { showToast } = useToast();
  // Core user states
  const [currentUser, setCurrentUser] = useState<User>(() => {
    const localCompleted = localStorage.getItem('mazad_local_onboarding_completed') === 'true';
    let localHints = {};
    try {
      const stored = localStorage.getItem('mazad_local_shown_hints');
      if (stored) localHints = JSON.parse(stored);
    } catch (_) {}
    return {
      ...DEFAULT_UNAUTHENTICATED_USER,
      onboardingCompleted: localCompleted,
      shownHints: localHints
    };
  });
  const [sellerProfile, setSellerProfile] = useState<SellerProfile | null>(null);

  // Maintenance & Operations States
  const [maintenanceMode, setMaintenanceMode] = useState({
    enabled: false,
    messageAr: 'المنصة خاضعة للصيانة المجدولة حالياً لتحديث أنظمة التشفير وحسابات الضمان بنظام كليك.',
    messageEn: 'The platform is currently undergoing scheduled maintenance to upgrade security protocols and CliQ escrow systems.',
    expectedDuration: '1 hr'
  });

  const [featureFlags, setFeatureFlags] = useState({
    enableLiveAuctions: true,
    enableSubscriptions: true,
    enableWallets: true,
    enablePushNotifications: true,
    enableGuestBrowsing: true,
    enableAlgoliaSearch: false,
    enableCliqGateway: false
  });

  const [systemHealthLogs, setSystemHealthLogs] = useState<any[]>([]);

  // Sliding window rate limiters for fraud prevention
  const lastBidTimestampRef = useRef<number>(0);
  const bidTimestampsRef = useRef<number[]>([]);
  // Server-issued bidding cooldown deadline (epoch ms, 0 = none). The ref is
  // what placeBid reads synchronously (state would be a render behind on a fast
  // double-tap); the state is what the UI subscribes to. Both are a MIRROR of a
  // server decision — the authority is functions/bidRateLimit.js, and this
  // resets to 0 on reload, which is exactly why it cannot be the enforcement.
  const bidCooldownUntilRef = useRef<number>(0);
  const [bidCooldownUntil, setBidCooldownUntil] = useState<number>(0);
  // Live mirror of the auctions array for stable callbacks (placeBid) that
  // must read CURRENT auction flags (isSimulated) without taking `auctions`
  // as a dep — which would re-memoize on every snapshot. Synced below.
  const auctionsStateRef = useRef<AuctionItem[]>([]);
  
  // Single Session check tracking refs
  const sessionCheckInProgressRef = useRef<boolean>(false);
  const lastSessionCheckTimeRef = useRef<number>(0);
  const redirectResultProcessingRef = useRef<boolean>(true);
  
  // Lists persistent initialization
  const [users, setUsers] = useState<User[]>(INITIAL_USERS);
  // PF4 part 1: the admin `users` listener is capped (see effect below), so
  // `users.length` is NOT the true account total. This holds the real count from
  // a server-side aggregation query so admin stats don't undercount. null = unknown.
  const [usersTotalCount, setUsersTotalCount] = useState<number | null>(null);
  const [auctionsTotalCount, setAuctionsTotalCount] = useState<number | null>(null);
  const [sellerProfiles, setSellerProfiles] = useState<SellerProfile[]>(() => {
    const saved = localStorage.getItem('mazad_seller_profiles');
    return saved ? JSON.parse(saved) : INITIAL_SELLERS;
  });
  const [auctions, setAuctions] = useState<AuctionItem[]>([]);
  // The current user's OWN 'processing' listings. The public grid query no
  // longer includes 'processing', so this targeted read is what keeps a
  // seller's own under-review lot visible to them in the feed (E1 behavior)
  // without leaking anyone else's pending lots. Merged into `visibleAuctions`.
  const [ownPendingAuctions, setOwnPendingAuctions] = useState<AuctionItem[]>([]);
  // Real loading signal for the first auctions fetch — replaces the old
  // synthetic 550ms skeleton delay in the Discover feed.
  const [auctionsLoaded, setAuctionsLoaded] = useState(false);
  // Wave 3 (simulator visibility): master toggle, read reactively so the
  // filters below re-run the instant an admin flips it — no resubscribe needed.
  const [simEnabled] = useSimulatorEnabled();
  useEffect(() => {
    auctionsStateRef.current = auctions;
  }, [auctions]);
  const [bids, setBids] = useState<Bid[]>(() => {
    const saved = localStorage.getItem('mazad_bids');
    return saved ? JSON.parse(saved) : [];
  });
  const [wallet, setWallet] = useState<Wallet>(() => {
    const saved = localStorage.getItem('mazad_wallet');
    return saved ? JSON.parse(saved) : {
      userId: 'user-current',
      totalBalance: 0,
      availableBalance: 0,
      escrowBalance: 0,
      pendingWithdrawalBalance: 0
    };
  });
  const [escrows, setEscrows] = useState<EscrowTransaction[]>(() => {
    const saved = localStorage.getItem('mazad_escrows');
    return saved ? JSON.parse(saved) : INITIAL_ESCROWS;
  });
  const [orders, setOrders] = useState<Order[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  // The signed-in user's own order reviews (lightweight listener) + the
  // "please rate this before bidding again" modal target.
  const [myReviews, setMyReviews] = useState<OrderReview[]>([]);
  const [myReviewsLoaded, setMyReviewsLoaded] = useState(false);
  const [reviewPromptOrderId, setReviewPromptOrderId] = useState<string | null>(null);
  const [verificationRequests, setVerificationRequests] = useState<VerificationRequest[]>([]);
  const [sellerReports, setSellerReports] = useState<SellerReport[]>([]);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => {
    const saved = localStorage.getItem('mazad_chat_messages');
    return saved ? JSON.parse(saved) : INITIAL_CHATS;
  });
  // Starts empty; the signed-in user's persisted bell is loaded from the
  // uid-keyed localStorage entry once auth resolves (see effect below).
  const [notifications, setNotifications] = useState<Notification[]>(INITIAL_NOTIFICATIONS);
  // Which uid the keyed bell store has been hydrated for — guards the persist
  // effect from clobbering another user's entry before hydration.
  const notifStoreUidRef = useRef<string | null>(null);
  // IDs of bell entries that were merged from the Firestore /notifications
  // collection (vs session-local addNotification). Declared here so logout()
  // can purge it on shared devices.
  const firestoreNotifIdsRef = useRef<Set<string>>(new Set());
  const [adminActions, setAdminActions] = useState<AdminAction[]>([]);
  const [adminActionsError, setAdminActionsError] = useState<string | undefined>(undefined);

  const [deletedAuctionIds, setDeletedAuctionIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('mazad_deleted_auctions');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [isDeferredReady, setIsDeferredReady] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsDeferredReady(true);
    }, 1500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem('mazad_deleted_auctions', JSON.stringify(deletedAuctionIds));
  }, [deletedAuctionIds]);

  // Sync state changes with localStorage.
  //
  // `users`, `auctions` and `adminActions` are write-only here (nothing
  // reads `mazad_users` / `mazad_auctions` / `mazad_admin_actions` back —
  // they're populated straight from Firestore snapshots on boot), so
  // per-delta persistence was pure overhead: a synchronous JSON.stringify of
  // an 80-doc auctions array on every bid, on every lot. Firestore's own
  // client cache already survives reloads, so these writes were removed
  // outright rather than throttled.
  //
  // `sellerProfiles`, `bids`, `wallet`, `escrows` and `chatMessages` ARE read
  // back from localStorage as an instant-paint seed on init, so they still
  // need to persist — just not synchronously on every delta. Throttled to
  // at most once every few seconds (flushed on tab-hide/unmount too).
  useThrottledLocalStorageSync('mazad_seller_profiles', sellerProfiles);
  useThrottledLocalStorageSync('mazad_bids', bids);
  useThrottledLocalStorageSync('mazad_wallet', wallet);
  useThrottledLocalStorageSync('mazad_escrows', escrows);
  useThrottledLocalStorageSync('mazad_chat_messages', chatMessages);

  // One-time purge of the pre-fix SHARED bell keys: they leaked one user's
  // private verdicts (incl. rejection reasons) to the next account on the
  // same device. Per-user persistence lives further down (uid-keyed).
  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_NOTIF_KEY);
      localStorage.removeItem(LEGACY_DISMISSED_KEY);
    } catch { /* storage unavailable — nothing leaked then */ }
  }, []);

  // Revive custom blob videos on load from IndexedDB (Disabled as we use permanent Firebase Storage uploads now)
  /*
  useEffect(() => {
    const reviveCustomVideos = async () => {
      let updatedAny = false;
      const revivedAuctions = await Promise.all(auctions.map(async (auction) => {
        if (auction.videoUrl && auction.videoUrl.startsWith('blob:')) {
          try {
            const { getVideoBlob } = await import('../utils/videoDb');
            const blob = await getVideoBlob(auction.id);
            if (blob) {
              const newBlobUrl = URL.createObjectURL(blob);
              updatedAny = true;
              return {
                ...auction,
                videoUrl: newBlobUrl
              };
            }
          } catch (e) {
            console.error('Failed to revive video blob:', e);
          }
        }
        return auction;
      }));

      if (updatedAny) {
        setAuctions(revivedAuctions);
      }
    };

    reviveCustomVideos();
  }, []);
  */

  // Navigation / views
  //
  // Seed the initial nav node from the entry URL so a deep-link / refresh lands
  // on the right view in the FIRST render — the History-API sync effect below
  // then replaceState()s it (no phantom entry). parseNav normalizes a Firebase
  // auth-redirect callback to a neutral discovery so OAuth is never routed.
  const initialNav = parseNav(typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/');
  const [activeAuctionId, setActiveAuctionId] = useState<string | null>(initialNav.auctionId ?? 'auction-rolex');
  const [activeView, setActiveView] = useState<'landing' | 'discovery' | 'live' | 'wallet' | 'orders' | 'admin' | 'upload' | 'about' | 'seller-center' | 'profile' | 'drop-builder' | 'auction-drop-builder' | 'prohibited-items'>(initialNav.view);
  const [showSubscriptionPrompt, setShowSubscriptionPrompt] = useState<boolean>(false);
  // Trust gate: a member without a real profile photo who taps bid/sell is shown
  // the "add a photo" sheet (mirrors the subscription prompt plumbing).
  const [showPhotoGate, setShowPhotoGate] = useState<boolean>(false);
  // E2 ban ladder: a blocked bid tap opens the BanNoticeModal (rendered at App root).
  const [showBanNotice, setShowBanNotice] = useState<boolean>(false);
  // E5 contact completion: a member with a photo but a missing contact channel
  // (phone or email) who taps bid/sell is shown the ContactCompletionModal (A4 mounts it).
  const [profileFieldPrompt, setProfileFieldPrompt] = useState<'name' | 'city' | null>(null);
  const [contactModalOpen, setContactModalOpen] = useState<boolean>(false);
  const [showNotifications, setShowNotifications] = useState<boolean>(false);
  const [globalWalletSubView, setGlobalWalletSubView] = useState<'wallet-home' | 'transactions' | 'orders'>('wallet-home');
  const [globalSelectedOrderId, setGlobalSelectedOrderId] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // History-API sync layer
  // ---------------------------------------------------------------------------
  // The router is state-based (activeView / activeAuctionId + overlay flags), so
  // the browser never had more than one history entry and hardware/gesture Back
  // exited the app. This mirrors the nav node into window.history:
  //   - a real in-app navigation -> pushState (adds a Back target)
  //   - initial mount / deep-link entry -> replaceState (no phantom entry)
  //   - Back/Forward (popstate) -> apply the popped node WITHOUT re-pushing
  //
  // Overlays wired to Back (each pushes its own entry so Back closes it first
  // instead of leaving the app): post-win review prompt, subscription prompt,
  // notifications panel, and the global order-details modal.

  // Serialized search string currently reflected in the top history entry. The
  // sync effect only pushes when the derived node differs from this; the popstate
  // handler pre-sets it to the popped node so applying that node never re-pushes
  // (breaks the push<->pop loop).
  const historyNodeRef = useRef<string | null>(null);
  const historyInitRef = useRef<boolean>(false);

  const deriveNavNode = useCallback((): NavNode => {
    const node: NavNode = { view: activeView };
    if (activeView === 'live' && activeAuctionId) node.auctionId = activeAuctionId;

    // Top-most overlay (only one is meaningfully open at a time; priority order
    // is a blocking review gate, then subscription, notifications, order).
    if (reviewPromptOrderId) {
      node.modal = 'review';
      node.modalParam = { key: 'order', value: reviewPromptOrderId };
    } else if (showSubscriptionPrompt) {
      node.modal = 'subscription';
    } else if (showNotifications) {
      node.modal = 'notifications';
    } else if (globalSelectedOrderId) {
      node.modal = 'order';
      node.modalParam = { key: 'order', value: globalSelectedOrderId };
    }
    return node;
  }, [activeView, activeAuctionId, reviewPromptOrderId, showSubscriptionPrompt, showNotifications, globalSelectedOrderId]);

  // Apply a nav node coming from Back/Forward to app state. auctionId is only set
  // when present so a discovery pop doesn't nuke the live-view default.
  const applyNavNode = useCallback((node: NavNode) => {
    setActiveView(node.view);
    if (node.auctionId) setActiveAuctionId(node.auctionId);
    setShowNotifications(node.modal === 'notifications');
    setShowSubscriptionPrompt(node.modal === 'subscription');
    setReviewPromptOrderId(node.modal === 'review' ? (node.modalParam?.value ?? null) : null);
    setGlobalSelectedOrderId(node.modal === 'order' ? (node.modalParam?.value ?? null) : null);
  }, []);

  // Push/replace on real navigation (skips no-op / popstate-applied changes).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const node = deriveNavNode();
    const url = serializeNav(node); // a real path, e.g. '/discover' or '/auction/x'
    const prevUrl = historyNodeRef.current;
    if (prevUrl === url) return; // already in history (e.g. from a pop)
    if (!historyInitRef.current) {
      // Initial mount / deep-link entry: seed the top entry, no phantom push.
      historyInitRef.current = true;
      window.history.replaceState(node, '', url);
    } else if (prevUrl !== null && isModalCloseTransition(parseNav(prevUrl), node)) {
      // A wired modal was closed by its X/close button (view/auction unchanged).
      // Collapse the modal entry in place instead of pushing a new clean one —
      // otherwise history becomes [view, modal, view'] and Back reopens the modal.
      window.history.replaceState(node, '', url);
    } else {
      // Real in-app navigation (view change, or opening a modal): add a Back target.
      window.history.pushState(node, '', url);
    }
    historyNodeRef.current = url;
  }, [deriveNavNode]);

  // Meta Pixel PageView. index.html deliberately omits it: this is an SPA, so
  // the document loads once and a PageView there would fire once per session.
  //
  // DECLARED IMMEDIATELY AFTER THE SYNC EFFECT ON PURPOSE. React runs a
  // component's effects in declaration order, so by the time this one runs the
  // push/replaceState above has already committed and `fbq` — which reads
  // document.location itself — reports the page the user actually landed on.
  // Firing from a child component instead would report the PREVIOUS URL, since
  // child effects flush before the parent's.
  //
  // IT KEEPS ITS OWN REF rather than reusing historyNodeRef, and that is what
  // makes Back/Forward work. The popstate handler below pre-sets
  // historyNodeRef to the popped URL precisely so the sync effect does NOT
  // re-push — so anything keyed on that ref, or placed inside that effect after
  // its early return, would silently miss every browser navigation. This ref is
  // only ever written here, so a pop still reads as a change.
  //
  // One event per navigation: the whole node (view + auction + modal) collapses
  // into a single serialized URL, so a change of view AND auction together is
  // one string comparison and one PageView, not two.
  const lastPixelUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = serializeNav(deriveNavNode());
    if (lastPixelUrlRef.current === url) return;
    lastPixelUrlRef.current = url;
    trackPageView();
  }, [deriveNavNode]);

  // Second source for the SAME event, listening to the navigation itself rather
  // than to the state it produces.
  //
  // The effect above only sees a route change if it round-trips through the six
  // values deriveNavNode depends on. That is true for ordinary navigation, and
  // browser Back/Forward was verified firing correctly through it on the live
  // site. It is NOT guaranteed on a screen whose view is forced by a gate
  // effect rather than set by navigation (the onboarding gate in MainAppShell
  // is one): there, a pop can land on a URL whose state is immediately
  // overwritten, and the PageView is lost with no trace.
  //
  // Reading `window.location` here is what makes this robust — at popstate time
  // the browser has ALREADY applied the new URL, so this is the destination,
  // never the previous page, and it does not depend on React having re-rendered
  // yet. Normalised through parseNav/serializeNav so it is byte-identical to
  // what the effect above produces; a raw location string would differ whenever
  // an unmodelled param (an ad click id, say) is present and would then
  // double-count.
  //
  // NO DOUBLE-FIRE: both paths write and check the same lastPixelUrlRef, so
  // whichever observes a given navigation first claims it and the other returns
  // early. Back-navigation matters here — open a listing, go back, open another
  // is the core browsing loop of an auction site, and losing it would leave the
  // retargeting audiences missing a large share of real views.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPixelPop = () => {
      const url = serializeNav(parseNav(window.location.pathname + window.location.search));
      if (lastPixelUrlRef.current === url) return;
      lastPixelUrlRef.current = url;
      trackPageView();
    };
    window.addEventListener('popstate', onPixelPop);
    return () => window.removeEventListener('popstate', onPixelPop);
  }, []);

  // Single popstate listener (mounted once). Reads the popped node from
  // event.state (fallback: parse the current URL) and applies it. Pre-setting
  // historyNodeRef guards the sync effect above from re-pushing.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPopState = (event: PopStateEvent) => {
      const raw = event.state as NavNode | null;
      const node: NavNode = raw && raw.view ? raw : parseNav(window.location.pathname + window.location.search);
      historyNodeRef.current = serializeNav(node);
      applyNavNode(node);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyNavNode]);

  // Watchlist & Auto-bid state hooks
  const [watchlist, setWatchlist] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('mazad_watchlist');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [autoBids, setAutoBids] = useState<{ [auctionId: string]: number }>(() => {
    try {
      const saved = localStorage.getItem('mazad_autobids');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    localStorage.setItem('mazad_watchlist', JSON.stringify(watchlist));
  }, [watchlist]);

  useEffect(() => {
    localStorage.setItem('mazad_autobids', JSON.stringify(autoBids));
  }, [autoBids]);

  // AUTH, MULTILINGUAL, & SUBSCRIPTION ADDITIONS
  // Seeded from the attribute the pre-paint script ALREADY set, not from a
  // fresh default: re-deriving here would flip the theme on hydration and undo
  // the entire point of the inline script.
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof document === 'undefined') return DEFAULT_THEME;
    return normalizeTheme(document.documentElement.getAttribute('data-theme'));
  });
  const themeAdoptedRef = useRef(false);

  const [language, setLanguageState] = useState<'en' | 'ar'>(() => {
    return (localStorage.getItem('mazad_language') as 'en' | 'ar') || 'ar';
  });
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  // One pre-login language adoption per signed-in session. Reset on sign-out so
  // a second account in the same tab still gets its own chance; a ref rather
  // than state because flipping it must not re-render, and because the user-doc
  // snapshot that reads it fires on every profile change.
  const languageAdoptedRef = useRef<boolean>(false);
  // authReady gates the app boot: it flips true only once the async
  // onAuthStateChanged chain (token + Firestore doc load) has resolved in
  // EITHER direction. Until then App.tsx shows the loading splash instead of
  // flashing Login while a valid session is still restoring.
  const [authReady, setAuthReady] = useState<boolean>(false);

  // Guest browsing: latched when a logged-out visitor taps a gated action
  // (bid / chat / save / a members-only nav item). Read ONLY by the
  // unauthenticated branch in App.tsx, which then shows the login flow while
  // activeView/activeAuctionId stay latched for the post-signup return.
  const [signInRequested, setSignInRequested] = useState<boolean>(false);
  // The intent is captured at the TAP, not inferred at the screen: by the time
  // LoginView renders, the only clue left was the URL, which is why a seller
  // tapping Sell was asked to sign in to bid.
  const [signInIntent, setSignInIntent] = useState<SignInIntent | null>(null);
  const requestSignIn = useCallback((intent?: SignInIntent) => {
    setSignInIntent(intent ?? null);
    setSignInRequested(true);
  }, []);
  const dismissSignIn = useCallback(() => setSignInRequested(false), []);
  // Reset the latch once signed in, so a later logout lands back on the guest
  // browse shell instead of a stale login screen.
  //
  // A 'sell' intent also names a destination. Every other intent must NOT:
  // activeView/activeAuctionId stay latched across signup precisely so a bidder
  // returns to the lot they were watching, and overriding that would undo it.
  // 'sell' is the exception because 'upload' is not a guest-allowed view, so
  // there is nothing latched to return to.
  useEffect(() => {
    if (!isAuthenticated) return;
    setSignInRequested(false);
    const target = postSignInView(signInIntent);
    if (target) setActiveView(target as any);
    setSignInIntent(null);
  }, [isAuthenticated, signInIntent]);

  // Session Heartbeat (PF4 part 2) - updates lastSeen, deviceInfo, and appVersion.
  // Every write fans out to the admin's live `users` listener, so instead of a
  // fixed 5-min setInterval (which makes many clients write in lockstep) we use a
  // recursive setTimeout re-jittered to 8-12 min on each tick so the writes spread out.
  useEffect(() => {
    if (!isAuthenticated || !currentUser || currentUser.id === 'user-current') return;

    let timer: ReturnType<typeof setTimeout>;

    const scheduleNext = () => {
      timer = setTimeout(async () => {
        try {
          const userRef = doc(db, 'users', currentUser.id);
          const dev = getDeviceInfo();
          await updateDoc(userRef, {
            lastSeen: new Date().toISOString(),
            deviceInfo: `${dev.browser} on ${dev.platform} (${dev.deviceType})`,
            appVersion: dev.appVersion
          });
          console.log("Session heartbeat updated for user:", currentUser.id);
        } catch (error) {
          console.error("Heartbeat error:", error);
        } finally {
          scheduleNext(); // re-jitter the next interval
        }
      }, nextHeartbeatDelayMs());
    };

    scheduleNext();

    return () => clearTimeout(timer);
  }, [isAuthenticated, currentUser?.id]);

  const addNotificationRef = useRef<any>(null);
  useEffect(() => {
    addNotificationRef.current = addNotification;
  });

  // Handle Auth Redirect Results (e.g. Google/Facebook redirects) on app mount
  useEffect(() => {
    const handleRedirectResultFlow = async () => {
      redirectResultProcessingRef.current = true;
      try {
        const result = await getRedirectResult(auth);
        if (result && result.user) {
          const user = result.user;
          console.log("[Auth Redirect] Redirect login success for user:", user.email);
          
          const newSessionId = generateSessionId();
          localStorage.setItem('mazad_session_id', newSessionId);
          localStorage.setItem('mazad_last_login_time', String(Date.now()));
          
          const dev = getDeviceInfo();
          const ip = await fetchIP();
          const userRef = doc(db, 'users', user.uid);
          const userSnap = await getDoc(userRef);
          
          let fbData: any = {};
          if (!userSnap.exists()) {
            const freshUserDoc = {
              id: user.uid,
              uid: user.uid,
              name: user.displayName || (user.email ? user.email.split('@')[0] : 'User'),
              email: user.email || '', // phone/email-less providers: write '' (never a fabricated email) so the users create rule passes
              avatar: user.photoURL || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&q=80',
              role: 'user',
              phoneNumber: user.phoneNumber || '',
              phone: user.phoneNumber || '',
              city: '',
              createdAt: new Date().toISOString(),
              sessionId: newSessionId,
              lastLoginAt: new Date().toISOString(),
              deviceInfo: `${dev.browser} on ${dev.platform} (${dev.deviceType})`,
              platform: dev.platform,
              browser: dev.browser,
              deviceType: dev.deviceType,
              appVersion: dev.appVersion,
              lastLoginIP: ip,
              lastSeen: new Date().toISOString()
            };
            await setDoc(userRef, freshUserDoc);
            fbData = freshUserDoc;
          } else {
            const updates = {
              sessionId: newSessionId,
              lastLoginAt: new Date().toISOString(),
              deviceInfo: `${dev.browser} on ${dev.platform} (${dev.deviceType})`,
              platform: dev.platform,
              browser: dev.browser,
              deviceType: dev.deviceType,
              appVersion: dev.appVersion,
              lastLoginIP: ip,
              lastSeen: new Date().toISOString()
            };
            await updateDoc(userRef, updates);
            fbData = { ...userSnap.data(), ...updates };
          }

          // Build user state object mimicking post-login steps exactly
          // THE STORED ROLE IS THE ONLY INPUT.
            //
            // This was OR-ed with a hardcoded email address and with a Firebase
            // custom claim. The email could not be revoked without a deploy; the
            // claim was never set by anything, and had it been, it would have been
            // a second store that can disagree with the first. users/{uid}.role is
            // now the single answer here, in the Cloud Functions, and in both
            // rules files.
            let loadedRole: 'admin' | 'user' | 'seller' =
              (fbData.role === 'admin' || fbData.isAdmin === true)
                ? 'admin'
                : ((fbData.role === 'seller' || fbData.isSeller === true) ? 'seller' : 'user');

          const loadedUser: User = {
            id: user.uid,
            uid: user.uid,
            name: fbData.name || user.displayName || 'User',
            email: fbData.email || user.email || '',
            avatar: fbData.avatar || user.photoURL || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&q=80',
            role: loadedRole,
            isAdmin: fbData.isAdmin === true || fbData.role === 'admin',
            accountStatus: fbData.accountStatus || 'active',
            isVerified: fbData.isVerified !== undefined ? fbData.isVerified : true,
            isBlocked: fbData.isBlocked !== undefined ? fbData.isBlocked : false,
            subscriptionStatus: fbData.subscriptionStatus || 'none',
            subscriptionExpiry: fbData.subscriptionExpiry || null,
            phoneNumber: fbData.phoneNumber || '',
            phone: fbData.phone || fbData.phoneNumber || '',
            city: fbData.city || '',
            createdAt: fbData.createdAt || new Date().toISOString(),
            isSeller: fbData.isSeller || false,
            sellerStatus: fbData.sellerStatus || '',
            sellerActivatedAt: fbData.sellerActivatedAt || null,
            sellerProfile: fbData.sellerProfile || null,
            onboardingCompleted: fbData.onboardingCompleted !== undefined ? fbData.onboardingCompleted : false,
            shownHints: fbData.shownHints || {}
          };

          setCurrentUser(loadedUser);
          setIsAuthenticated(true);
          setActiveView('discovery');
          if (addNotificationRef.current) {
            addNotificationRef.current(
              language === 'ar' ? 'تسجيل الدخول' : 'Sign In',
              language === 'ar' ? 'تم تسجيل الدخول بنجاح عبر جوجل!' : 'Successfully signed in via Google!',
              'admin'
            );
          }
        }
      } catch (err) {
        console.warn("[Auth Redirect] Handle redirect result error:", err);
        // Surface via toast — the 'alert' notification below is now filtered from the
        // user bell (Wave D), so without this the sign-in failure would be silent.
        showToast({
          title: language === 'ar' ? 'فشل تسجيل الدخول' : 'Sign In Failed',
          message: language === 'ar' ? 'ما زبط تسجيل الدخول عبر جوجل أو فيسبوك — جرّب مرة ثانية.' : 'Google/Facebook sign-in failed — please try again.',
          type: 'warn',
        });
        if (addNotificationRef.current) {
          addNotificationRef.current(
            language === 'ar' ? 'فشل تسجيل الدخول' : 'Sign In Failed',
            language === 'ar' ? 'فشل تسجيل الدخول عبر جوجل أو فيسبوك.' : 'Sign-In via Google or Facebook failed.',
            'alert'
          );
        }
      } finally {
        redirectResultProcessingRef.current = false;
      }
    };
    handleRedirectResultFlow();
  }, [language]);

  // 1. Listen to Firebase Authentication Auth State changes
  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      // Wait for redirect handler to finish resolving if active
      while (redirectResultProcessingRef.current) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      if (firebaseUser) {
        const uid = firebaseUser.uid;
        const userRef = doc(db, 'users', uid);
        
        try {
          // A NEW ACCOUNT IS NEVER AN ADMINISTRATOR. These two are only the
          // values written for a user doc that does not exist yet; the
          // existing-user branch below reads the STORED role. They used to be
          // seeded from a hardcoded address, which is how one email became a
          // superuser that no amount of role management could take back.
          const currentRole: 'admin' | 'user' = 'user';
          const isAdminField = false;
 
          let userSnap;
          try {
            userSnap = await getDoc(userRef);
          } catch (error) {
            handleFirestoreError(error, OperationType.GET, `users/${uid}`);
          }
          
          let loadedUser: User;
          
          if (!userSnap.exists()) {
            // Phone signups have no displayName/email — NEVER fall back to the
            // phone number as the public bidder name (it would leak into chat/
            // bids and defeat the profile-completion gate). 'User' matches the
            // server onUserCreated placeholder, so no double-prompt later.
            const nameFromEmail = firebaseUser.email ? firebaseUser.email.split('@')[0] : 'User';
            const capitalizedName = nameFromEmail.charAt(0).toUpperCase() + nameFromEmail.slice(1);
            
            const newSessionId = generateSessionId();
            localStorage.setItem('mazad_session_id', newSessionId);
            const dev = getDeviceInfo();
            const ip = await fetchIP();

            loadedUser = {
              id: uid,
              uid: uid,
              name: firebaseUser.displayName || capitalizedName,
              email: firebaseUser.email || '',
              avatar: firebaseUser.photoURL || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&q=80',
              role: currentRole,
              isAdmin: isAdminField,
              accountStatus: 'active',
              isVerified: true,
              isBlocked: false,
              subscriptionStatus: 'none',
              subscriptionExpiry: null,
              phoneNumber: firebaseUser.phoneNumber || '',
              phone: firebaseUser.phoneNumber || '',
              city: '',
              createdAt: new Date().toISOString(),
              onboardingCompleted: false,
              shownHints: {}
            };
            try {
              await setDoc(userRef, {
                id: uid,
                uid: uid,
                name: loadedUser.name,
                email: loadedUser.email,
                avatar: loadedUser.avatar,
                role: currentRole,
                accountStatus: 'active',
                phoneNumber: firebaseUser.phoneNumber || '',
                phone: firebaseUser.phoneNumber || '',
                normalizedPhone: (firebaseUser.phoneNumber || '').replace(/\D/g, ''),
                city: '',
                createdAt: new Date().toISOString(),
                onboardingCompleted: false,
                shownHints: {},
                sessionId: newSessionId,
                lastLoginAt: new Date().toISOString(),
                deviceInfo: `${dev.browser} on ${dev.platform} (${dev.deviceType})`,
                platform: dev.platform,
                browser: dev.browser,
                deviceType: dev.deviceType,
                appVersion: dev.appVersion,
                lastLoginIP: ip,
                lastSeen: new Date().toISOString()
              }, { merge: true }); // (review SF1) server onUserCreated trigger also creates this doc; merge avoids clobbering server-set fields
              // Meta Pixel: the account now exists. INSIDE the try, after the
              // write resolves — a rejected setDoc must not be counted as a
              // registration. This branch is provider-agnostic (phone OTP,
              // Google, email), so it is the one place that sees every signup;
              // registerUser alone would miss phone signups, which are the
              // primary path here.
              trackRegistration();
            } catch (error) {
              handleFirestoreError(error, OperationType.WRITE, `users/${uid}`);
            }
          } else {
            const fbData = userSnap.data();

            // SECURITY CHECK: Duplicate Session Protection
            const localSessionId = localStorage.getItem('mazad_session_id');
            const firestoreSessionId = fbData.sessionId;

            const lastLoginTime = localStorage.getItem('mazad_last_login_time');
            const lastLoginTimestamp = lastLoginTime ? parseInt(lastLoginTime, 10) : 0;
            const now = Date.now();
            const isGracePeriod = (now - lastLoginTimestamp) < 10000;

            if (isGracePeriod) {
              console.log("[Single Session Check] Skipping verification check during login grace period.");
            } else if (firestoreSessionId && localSessionId && localSessionId !== firestoreSessionId) {
              if (sessionCheckInProgressRef.current) {
                console.log("[Single Session Check] Session verification check already in progress. Skipping.");
              } else {
                const lastCheckTime = lastSessionCheckTimeRef.current;
                const timeSinceLastCheck = now - lastCheckTime;
                if (timeSinceLastCheck < 30000) {
                  console.log(`[Single Session Check] Verification check rate-limited. Skipping (last check was ${Math.round(timeSinceLastCheck / 1000)}s ago).`);
                } else {
                  console.warn("Potential session conflict detected (cache read). Verifying with server...");
                  sessionCheckInProgressRef.current = true;
                  lastSessionCheckTimeRef.current = now;

                  (async () => {
                    let freshSessionId: string | null = null;
                    try {
                      const freshSnap = await getDocFromServer(userRef);
                      if (freshSnap.exists()) {
                        freshSessionId = freshSnap.data()?.sessionId || null;
                      } else {
                        // Fail-open if server document doesn't exist
                        freshSessionId = localSessionId;
                      }
                    } catch (serverErr) {
                      console.warn("Failed to read user document from server for session verification (Fail-Open):", serverErr);
                      // Fail-Open: Ignore check for this cycle and let user proceed
                      freshSessionId = localSessionId; // simulate match to bypass logout
                    } finally {
                      sessionCheckInProgressRef.current = false;
                    }

                    if (freshSessionId && freshSessionId !== localSessionId) {
                      console.warn("Session conflict confirmed by server: local session ID", localSessionId, "does not match Firestore session ID", freshSessionId);
                      // SOFT notice: this audience hops between WhatsApp/mobile
                      // devices constantly, so we no longer force-logout on a
                      // duplicate session. Adopt the server's session id locally
                      // so the check stops re-firing every cycle, keep the user
                      // signed in on THIS device, and surface a dismissible heads-up.
                      localStorage.setItem('mazad_session_id', freshSessionId);
                      const dupTitle = language === 'ar' ? 'تنبيه' : 'Notice';
                      const dupMsg = language === 'ar' ? 'تم تسجيل دخولك من جهاز آخر' : "You're signed in on another device.";
                      if (addNotificationRef.current) {
                        addNotificationRef.current(dupTitle, dupMsg, 'admin');
                      }
                      showToast({ title: dupTitle, message: dupMsg, type: 'info' });
                    }
                  })();
                }
              }
            }

            // If local session ID is empty, generate a new one and bootstrap
            if (!localSessionId) {
              const newSessionId = generateSessionId();
              localStorage.setItem('mazad_session_id', newSessionId);
              const dev = getDeviceInfo();
              const ip = await fetchIP();
              try {
                await updateDoc(userRef, {
                  sessionId: newSessionId,
                  lastLoginAt: new Date().toISOString(),
                  deviceInfo: `${dev.browser} on ${dev.platform} (${dev.deviceType})`,
                  platform: dev.platform,
                  browser: dev.browser,
                  deviceType: dev.deviceType,
                  appVersion: dev.appVersion,
                  lastLoginIP: ip,
                  lastSeen: new Date().toISOString()
                });
              } catch (err) {
                console.warn("Failed to bootstrap session in firestore:", err);
              }
              fbData.sessionId = newSessionId;
            }

            // THE STORED ROLE IS THE ONLY INPUT — see the matching note in the
            // redirect path above.
            const loadedRole: 'admin' | 'user' | 'seller' =
              (fbData.role === 'admin' || fbData.isAdmin === true)
                ? 'admin'
                : ((fbData.role === 'seller' || fbData.isSeller === true) ? 'seller' : 'user');

            // ⚠️ THE BROWSER NO LONGER PROMOTES ANYONE, EITHER.
            //
            // This used to write `role:'admin', isAdmin:true` whenever the
            // signed-in address matched the hardcoded one: a client granting
            // itself privilege. firestore.rules had to carve out an explicit
            // exception to let that write through — an exception that, by
            // construction, was a self-promotion path for whoever held the
            // address. The write and the exception are both gone. A role is
            // granted by grantAdminRole or the bootstrap script, to a uid.
            // ⚠️ THE BROWSER NO LONGER DEMOTES ANYONE.
            //
            // This used to be an `else if` that, for any account whose email is
            // not the hardcoded one, wrote `role:'user', isAdmin:false` over a
            // stored `role:'admin'`. It protected nothing: firestore.rules puts
            // `role` and `isAdmin` on the denylist for a user updating their own
            // document, so nobody can self-promote — the only way that field
            // says 'admin' is that an administrator or a Cloud Function put it
            // there. The branch existed to undo an attack the rules already make
            // impossible.
            //
            // What it DID do was demote real administrators. Every admin granted
            // by role rather than by the literal would be silently downgraded by
            // their own browser on sign-in, and the write succeeded because at
            // evaluation time the document still said 'admin'. Authorization is
            // the rules' job; a client that writes privilege fields is a bug
            // whatever it writes.
            
            loadedUser = {
              id: uid,
              uid: uid,
              name: fbData.name || firebaseUser.displayName || 'User',
              email: fbData.email || firebaseUser.email || '',
              avatar: fbData.avatar || firebaseUser.photoURL || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&q=80',
              role: loadedRole,
              isAdmin: fbData.isAdmin === true || fbData.role === 'admin',
              accountStatus: fbData.accountStatus || 'active',
              isVerified: fbData.isVerified !== undefined ? fbData.isVerified : true,
              isBlocked: fbData.isBlocked !== undefined ? fbData.isBlocked : false,
              subscriptionStatus: fbData.subscriptionStatus || 'none',
              subscriptionExpiry: fbData.subscriptionExpiry || null,
              phoneNumber: fbData.phoneNumber || '',
              phone: fbData.phone || fbData.phoneNumber || '',
              city: fbData.city || '',
              createdAt: fbData.createdAt || new Date().toISOString(),
              isSeller: fbData.isSeller || false,
              sellerStatus: fbData.sellerStatus || '',
              sellerActivatedAt: fbData.sellerActivatedAt || null,
              sellerProfile: fbData.sellerProfile || null,
              onboardingCompleted: fbData.onboardingCompleted !== undefined ? fbData.onboardingCompleted : false,
              shownHints: fbData.shownHints || {}
            };
          }
          
          setCurrentUser(loadedUser);
          setIsAuthenticated(true);
          setAuthReady(true);
        } catch (error) {
          console.error("Error setting up user profile in auth change:", error);
          const fallbackUser: User = {
            id: uid,
            uid: uid,
            name: firebaseUser.displayName || 'User',
            email: firebaseUser.email || '',
            avatar: firebaseUser.photoURL || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&q=80',
            // Fails CLOSED: this object is built when hydration THREW, so the
            // stored role could not be read. Guessing 'admin' from an address
            // was the one branch that handed out privilege on an error path.
            role: 'user',
            isAdmin: false,
            accountStatus: 'active',
            isVerified: true,
            isBlocked: false,
            subscriptionStatus: 'none',
            subscriptionExpiry: null,
            phoneNumber: '',
            phone: '',
            city: '',
          };
          setCurrentUser(fallbackUser);
          setIsAuthenticated(true);
          // Resolve the boot gate even when the Firestore doc load failed —
          // a fallback session is still authenticated, and the splash must
          // never hang forever on an error path.
          setAuthReady(true);
        }
      } else {
        setCurrentUser(DEFAULT_UNAUTHENTICATED_USER);
        setIsAuthenticated(false);
        // Signed out — the next account to sign in on this tab gets its own
        // pre-login language adoption. Reset here rather than inside logout()
        // because this branch also covers an expired or revoked session.
        languageAdoptedRef.current = false;
        setAuthReady(true);
      }
    });

    return () => unsubAuth();
  }, []);

  // 1.5. Real-time site settings, maintenance mode, and feature flags syncing
  useEffect(() => {
    const maintenanceRef = doc(db, 'siteSettings', 'maintenanceMode');
    const flagsRef = doc(db, 'siteSettings', 'featureFlags');

    const unsubMaint = onSnapshot(maintenanceRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setMaintenanceMode({
          enabled: data.enabled === true,
          messageAr: data.messageAr || 'المنصة خاضعة للصيانة المجدولة حالياً لتحديث أنظمة التشفير وحسابات الضمان بنظام كليك.',
          messageEn: data.messageEn || 'The platform is currently undergoing scheduled maintenance to upgrade security protocols and CliQ escrow systems.',
          expectedDuration: data.expectedDuration || '1 hr'
        });
      } else {
        setMaintenanceMode({
          enabled: false,
          messageAr: 'المنصة خاضعة للصيانة المجدولة حالياً لتحديث أنظمة التشفير وحسابات الضمان بنظام كليك.',
          messageEn: 'The platform is currently undergoing scheduled maintenance to upgrade security protocols and CliQ escrow systems.',
          expectedDuration: '1 hr'
        });
      }
    }, (err) => {
      console.warn("Error subscribing to maintenanceMode:", err);
    });

    const unsubFlags = onSnapshot(flagsRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setFeatureFlags({
          enableLiveAuctions: data.enableLiveAuctions !== false,
          enableSubscriptions: data.enableSubscriptions !== false,
          enableWallets: data.enableWallets !== false,
          enablePushNotifications: data.enablePushNotifications !== false,
          enableGuestBrowsing: readGuestBrowsingFlag(data),
          enableAlgoliaSearch: data.enableAlgoliaSearch === true,
          enableCliqGateway: data.enableCliqGateway === true,
        });
      } else {
        setFeatureFlags({
          enableLiveAuctions: true,
          enableSubscriptions: true,
          enableWallets: true,
          enablePushNotifications: true,
          enableGuestBrowsing: true,
          enableAlgoliaSearch: false,
          enableCliqGateway: false,
        });
      }
    }, (err) => {
      console.warn("Error subscribing to featureFlags:", err);
    });

    return () => {
      unsubMaint();
      unsubFlags();
    };
  }, []);

  // Sync System Health logs (For admins)
  useEffect(() => {
    const isStrictAdmin = isAdminUser(currentUser);
    if (!isStrictAdmin) {
      setSystemHealthLogs([]);
      return;
    }

    const q = query(
      collection(db, 'system_health'),
      orderBy('timestamp', 'desc'),
      limit(50)
    );

    const unsubHealth = onSnapshot(q, (snap) => {
      const logs: any[] = [];
      snap.forEach((doc) => {
        logs.push({ id: doc.id, ...doc.data() });
      });
      setSystemHealthLogs(logs);
    }, (err) => {
      console.warn("Error subscribing to system_health logs:", err);
    });

    return () => unsubHealth();
  }, [currentUser]);

  // Sync adminActions collection in real-time (For admins)
  useEffect(() => {
    const isStrictAdmin = isAdminUser(currentUser);
    if (!isStrictAdmin) {
      setAdminActions([]);
      setAdminActionsError(undefined);
      return;
    }

    const q = query(
      collection(db, 'adminActions'),
      orderBy('timestamp', 'desc'),
      limit(50)
    );

    const unsubAdminActions = onSnapshot(q, (snap) => {
      const actions: AdminAction[] = [];
      snap.forEach((doc) => {
        actions.push({ id: doc.id, ...doc.data() } as AdminAction);
      });
      setAdminActions(actions);
      setAdminActionsError(undefined);
    }, (err) => {
      console.error("Error subscribing to adminActions logs:", err);
      setAdminActions([]);
      setAdminActionsError("Unable to load admin actions");
    });

    return () => unsubAdminActions();
  }, [currentUser]);

  // 2. Real-time synchronizations of logged-in User profile and Wallet with Firestore
  useEffect(() => {
    if (!isAuthenticated || !currentUser?.id || currentUser.id === 'user-current') return;

    // A. Real-time user profile sync
    const userRef = doc(db, 'users', currentUser.id);
    const unsubUser = onSnapshot(userRef, (snap) => {
      if (snap.exists()) {
        const fbData = snap.data();

        // Adopt a language chosen BEFORE signing in. `setLanguage` can only
        // write the user document once a session exists, so a visitor who
        // switched the landing page to English and then signed up kept that
        // choice in localStorage alone — and every WhatsApp, email and
        // notification kept arriving in Arabic until they toggled a SECOND
        // time while logged in. Only fills an ABSENT field: a document that
        // already names a language holds a real choice, possibly newer and
        // made on another device.
        if (shouldAdoptLocalLanguage({
          session: { isAuthenticated, userId: currentUser.id },
          storedLanguage: localStorage.getItem('mazad_language'),
          docLanguage: fbData.language,
          alreadyAdopted: languageAdoptedRef.current,
        })) {
          // A ref, not state: this must fire once per session and a snapshot
          // arrives on every profile change. Set BEFORE the write so the next
          // snapshot cannot duplicate an in-flight one.
          languageAdoptedRef.current = true;
          persistLanguagePreference(
            { isAuthenticated, userId: currentUser.id },
            localStorage.getItem('mazad_language'),
            (uid, patch) => updateDoc(doc(db, 'users', uid), patch),
            (err) => console.warn('[language] pre-login preference not adopted:', err)
          );
        }

        const mergedUser: User = {
          id: currentUser.id,
          name: fbData.name || currentUser.name,
          email: fbData.email || currentUser.email,
          avatar: fbData.avatar || currentUser.avatar,
          role: (fbData.isSeller === true || fbData.role === 'seller') ? 'seller' : (fbData.role || currentUser.role),
          isVerified: fbData.isVerified !== undefined ? fbData.isVerified : currentUser.isVerified,
          isBlocked: fbData.isBlocked !== undefined ? fbData.isBlocked : currentUser.isBlocked,
          // E2 ban ladder: carry the graduated/auto-expiring block fields through
          // live sync so a ban, unban, or cooldown expiry reflects WITHOUT a refresh.
          blockedUntil: fbData.blockedUntil !== undefined ? fbData.blockedUntil : currentUser.blockedUntil,
          blockedReason: fbData.blockedReason !== undefined ? fbData.blockedReason : currentUser.blockedReason,
          strikeCount: fbData.strikeCount !== undefined ? fbData.strikeCount : currentUser.strikeCount,
          subscriptionStatus: fbData.subscriptionStatus || currentUser.subscriptionStatus || 'none',
          subscriptionExpiry: fbData.subscriptionExpiry || currentUser.subscriptionExpiry || null,
          phoneNumber: fbData.phoneNumber || currentUser.phoneNumber || '',
          city: fbData.city || currentUser.city || '',
          isSeller: fbData.isSeller !== undefined ? fbData.isSeller : currentUser.isSeller,
          sellerStatus: fbData.sellerStatus || currentUser.sellerStatus || '',
          sellerActivatedAt: fbData.sellerActivatedAt || currentUser.sellerActivatedAt || null,
          sellerProfile: fbData.sellerProfile || currentUser.sellerProfile || null,
          // Carry admin + onboarding flags through live sync — omitting them
          // silently stripped console-granted admins and resurrected onboarding
          isAdmin: fbData.isAdmin !== undefined ? fbData.isAdmin === true : currentUser.isAdmin,
          onboardingCompleted: fbData.onboardingCompleted !== undefined ? fbData.onboardingCompleted : currentUser.onboardingCompleted,
          // ⚠️ THE INTERESTS SCREEN CAME BACK ON EVERY SNAPSHOT WITHOUT THESE.
          //
          // This object is an ALLOWLIST built from scratch, not a spread: a
          // field that is not named here is DROPPED. saveInterests wrote
          // `interests`/`interestsSkipped` to Firestore and mirrored them into
          // local state correctly — and then the very snapshot that write
          // triggered rebuilt currentUser without them, needsInterestsOnboarding
          // saw no interests again, and the user was sent back to
          // /onboarding/interests. Every single time, forever.
          //
          // That is the third time this allowlist has eaten a field; the line
          // above records the last two. Anything saveInterests writes must be
          // named here — interestsMergeSurvival.test.ts now asserts exactly
          // that, so the next field added to that save cannot be forgotten.
          interests: fbData.interests !== undefined ? fbData.interests : currentUser.interests,
          interestsSkipped: fbData.interestsSkipped !== undefined ? fbData.interestsSkipped : currentUser.interestsSkipped,
          // Saved in the same batch, and just as silently dropped: a user who
          // turned WhatsApp alerts on saw the toggle flip back.
          notifyDaily: fbData.notifyDaily !== undefined ? fbData.notifyDaily : currentUser.notifyDaily,
          notifyFeatured: fbData.notifyFeatured !== undefined ? fbData.notifyFeatured : currentUser.notifyFeatured,
          notifyChannel: fbData.notifyChannel !== undefined ? fbData.notifyChannel : currentUser.notifyChannel,
        };
        if (JSON.stringify(mergedUser) !== JSON.stringify(currentUser)) {
          setCurrentUser(mergedUser);
        }
      }
    }, (err) => {
      console.warn("Firestore 'users' snapshot subscription error:", err);
    });

    // B. Real-time wallet sync with self-healing check and retries to avoid race conditions with Auth trigger
    const walletRef = doc(db, 'wallets', currentUser.id);
    const checkAndInitWallet = async (attempt = 1) => {
      try {
        const snap = await getDoc(walletRef);
        if (!snap.exists()) {
          if (attempt < 3) {
            // Wait 1.5 seconds and retry to let the server Auth trigger finish writing
            setTimeout(() => {
              checkAndInitWallet(attempt + 1);
            }, 1500);
          } else {
            // If still doesn't exist after retries, trigger the cloud function
            const initWalletCallable = await getCallableFunction('initializeUserWallet');
            await initWalletCallable();
            console.log("Wallet successfully initialized via Cloud Function on fallback.");
          }
        }
      } catch (e: any) {
        console.warn("Wallet init check attempt " + attempt + " failed:", e);
      }
    };
    checkAndInitWallet();

    const unsubWallet = onSnapshot(walletRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        const rawAvail = data.availableBalance ?? 0;
        const rawEscrow = data.escrowBalance ?? 0;
        const rawPending = data.pendingWithdrawalBalance ?? 0;
        // Divide by 1000 dynamically to convert fils (integers) to JOD (decimals) representation for the UI.
        const availableBalance = rawAvail / 1000;
        const escrowBalance = rawEscrow / 1000;
        const pendingWithdrawalBalance = rawPending / 1000;
        setWallet({
          userId: data.userId || currentUser.id,
          availableBalance,
          escrowBalance,
          pendingWithdrawalBalance,
          totalBalance: availableBalance + escrowBalance + pendingWithdrawalBalance
        });
      }
    }, (err) => {
      console.warn("Firestore 'wallets' subscription failure:", err);
    });

    return () => {
      unsubUser();
      unsubWallet();
    };
  }, [isAuthenticated, currentUser?.id]);

  // Real-time auctions synchronization with Firestore (ADMIN mode only).
  //
  // PERF (Wave 4 → 1b Task 5b): this effect keys off a derived SUBSCRIPTION
  // MODE, not the raw activeView, so the listener only re-subscribes when the
  // mode genuinely changes (admin ↔ none) rather than on every view swipe.
  // Task 5b removed the broad PUBLIC buyer listener entirely — buyer surfaces
  // (discovery/live) now map to 'none' and read the paginated `useDiscoverFeed`
  // (feed grid) + `useAuctionDoc` (bidding room) instead, so realtime read-cost
  // scales with attention, not the whole ~80-lot inventory. The ONLY remaining
  // broad read is the admin approval/management list below.
  //
  // 'admin' IS required ('admin' mode): the AdminDashboardView approval queue
  // (pendingListingDrops) filters this context state — without the
  // subscription the queue is always empty and the reject-with-reason
  // gate UI never renders.
  // CORR1: derive the client↔server clock offset once (early) and re-sync on
  // reconnect / tab-foreground, so every serverNow() consumer — countdowns,
  // finish checks, and the LiveStreamView bid gate — reads a latency-compensated
  // server clock instead of a possibly-skewed device clock. SAFETY: on any
  // failure the offset stays at its prior value (0 by default → identical to raw
  // Date.now()), and computeServerOffset rejects non-finite/absurd samples, so a
  // failed or noisy probe can never make a live lot show "ended" early or block a
  // legitimate final bid. The client gate is advisory anyway — placeBid re-checks
  // endTime with the real server clock inside its transaction.
  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      try {
        const sentAtMs = Date.now();
        const getServerTime = await getCallableFunction<Record<string, never>, { now: number }>('getServerTime');
        const res = await getServerTime({});
        const receivedAtMs = Date.now();
        if (cancelled) return;
        const offset = computeServerOffset({
          serverEpochMs: res.data?.now ?? NaN,
          sentAtMs,
          receivedAtMs,
        });
        if (offset !== null) setServerOffset(offset);
      } catch {
        // Probe failed (offline, or callable not yet deployed) — keep the prior
        // offset. Never poison the clock on a failed fetch.
      }
    };
    sync();
    const onOnline = () => { void sync(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void sync(); };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // 1b Task 5b: buyer surfaces (discovery/live) no longer open a broad
  // `auctions` subscription — the feed reads `useDiscoverFeed` and the bidding
  // room reads `useAuctionDoc` (Task 5a), so realtime cost scales with
  // attention, not inventory. Only the admin tooling still needs the broad
  // list; everything else maps to 'none' (opens nothing, clears the state).
  const auctionSubMode: 'admin' | 'none' =
    activeView === 'seller-center' || activeView === 'drop-builder' || activeView === 'admin' || activeView === 'auction-drop-builder'
      ? 'admin'
      : 'none';

  // PF5: the previous output of the auctions-snapshot sync below — NOT a mirror
  // of the `auctions` state (other, optimistic writers touch that). Keeping the
  // last synced list here lets each snapshot reuse the prior object reference
  // for every lot that did NOT change, so one bid no longer hands all ~80 lots
  // a fresh identity (which churned every downstream memo and countdown).
  const auctionsSnapSyncRef = useRef<AuctionItem[]>([]);

  useEffect(() => {
    if (auctionSubMode === 'none') {
      auctionsSnapSyncRef.current = [];
      setAuctions([]);
      setAuctionsLoaded(false);
      return;
    }

    // Fresh subscription (first mount or buyer<->admin flip): drop the prior
    // identity map. The new listener's initial snapshot lists every doc as
    // 'added', so everything is remapped fresh regardless — this reset just
    // guarantees no stale reference can ever leak across query windows.
    auctionsSnapSyncRef.current = [];

    const auctionsRefCol = collection(db, 'auctions');
    // Only ADMIN mode reaches here (buyer surfaces map to 'none' and returned
    // above — 1b Task 5b removed the broad public buyer listener). In Seller
    // Center, Drop Builder & Admin dashboard, fetch auctions of EVERY status
    // (incl. 'processing'/'rejected'/'completed') capped at 100 — the admin
    // approval queue and winners panel need the full set. Order by newest first
    // so a fresh 'processing' listing always lands inside the window: with no
    // ordering, an unbounded read past 100 auctions could strand a new listing
    // outside the cap and it would never surface for approval.
    const q = query(auctionsRefCol, orderBy('createdAt', 'desc'), limit(ADMIN_AUCTIONS_CAP));

    // True total, so the cap above stops being SILENT. The admin directory used
    // to render this capped array whole with nothing saying 141 of 241 lots
    // were missing — a silent cap reads as "this is everything", which is the
    // same class of bug as #202. Best-effort and one-shot, exactly like the
    // users count; a failure leaves it null and the UI claims nothing.
    getCountFromServer(auctionsRefCol)
      .then(res => setAuctionsTotalCount(res.data().count))
      .catch(err => console.warn('Firestore auctions count query failed:', err));

    const unsub = onSnapshot(q, (snap) => {
      setAuctionsLoaded(true);
      if (snap.empty) {
        auctionsSnapSyncRef.current = [];
        setAuctions([]);
      } else {
        const itemsToResolve: { id: string; rawUrl: string; category: string }[] = [];

        // PF5 (⚠️ money-adjacent): identity-preserving sync instead of the old
        // full `snap.forEach(mapAuctionDoc)` remap. Docs named in docChanges()
        // ('added'/'modified') are re-mapped IN FULL by the same mapAuctionDoc
        // as before — never a hand-picked field merge — so a changed lot
        // carries every field the room reads (currentPrice, currentBidderId,
        // endTime/endsAt, status, totalBids, winnerId, …) with the exact same
        // values the old handler produced. Only lots the snapshot did NOT
        // change reuse their previous object reference, and 'removed' docs are
        // dropped. Membership + order come from snap.docs (the query's
        // orderBy createdAt desc), identical to the old forEach output.
        const fetchedList = syncAuctionsFromSnapshot<AuctionItem, QueryDocumentSnapshot>({
          prev: auctionsSnapSyncRef.current,
          docs: snap.docs,
          changes: snap.docChanges(),
          getId: (docSnap) => docSnap.id,
          mapDoc: (docSnap) => mapAuctionDoc(docSnap, itemsToResolve),
        });
        auctionsSnapSyncRef.current = fetchedList;

        // Set the auctions synchronously so viewer counts, bids and clock ticks feel butter-smooth!
        setAuctions(fetchedList);

        // Resolve unresolved or new custom blob videos in the background
        if (itemsToResolve.length > 0) {
          Promise.all(
            itemsToResolve.map(async ({ id, rawUrl, category }) => {
              const resolvedUrl = await resolveVideoUrl(id, rawUrl, category);
              videoUrlCache.set(id, { rawUrl, resolvedUrl });
              return { id, resolvedUrl };
            })
          ).then((results) => {
            // Smoothly swap fallback video URLs with the resolved custom blob
            // URLs. The canonical patch goes through the sync ref so the NEXT
            // snapshot's unchanged-lot reuse hands back the patched object
            // (otherwise the resolved URL would flip back to the fallback on
            // the next bid). State is patched FUNCTIONALLY and ONLY on
            // videoUrl — spreading the state's OWN item, never substituting
            // the ref-derived object — so an optimistic per-item state write
            // that landed between the snapshot and this async resolution
            // (e.g. admin approve/reject flipping status, the seller edit)
            // is never clobbered back to the stale snapshot object.
            const resolvedById = new Map(results.map((r) => [r.id, r.resolvedUrl]));
            auctionsSnapSyncRef.current = auctionsSnapSyncRef.current.map((item) => {
              const resolvedUrl = resolvedById.get(item.id);
              if (resolvedUrl === undefined) return item;
              return { ...item, videoUrl: resolvedUrl };
            });
            setAuctions((prev) =>
              prev.map((item) => {
                const resolvedUrl = resolvedById.get(item.id);
                return resolvedUrl === undefined ? item : { ...item, videoUrl: resolvedUrl };
              })
            );
          }).catch((err) => {
            console.error("Async video resolution background task failed:", err);
          });
        }
      }
    }, (err) => {
      console.warn("Firestore 'auctions' collection sync error:", err);
      auctionsSnapSyncRef.current = [];
      setAuctions([]);
      setAuctionsLoaded(true);
    });
    return () => unsub();
  }, [auctionSubMode]);

  // Seller-own pending: targeted read of THIS user's own 'processing' listings,
  // merged into visibleAuctions so a seller still sees their under-review lot in
  // the feed even though the public grid query dropped 'processing' (E1).
  // 1b Task 5b: `auctionSubMode` no longer has a 'buyer' value (the broad buyer
  // listener was removed), so this is re-gated on the actual condition it needs
  // — a signed-in user on a buyer surface (discovery/live) — preserving its
  // prior trigger exactly. Kept OFF in admin mode (which fetches every status,
  // so it would otherwise double-render the seller's own lot) and everywhere
  // else. Tiny per-user query; the broad public read is what Task 5b removed.
  const isBuyerSurface = activeView === 'discovery' || activeView === 'live';
  useEffect(() => {
    if (!isBuyerSurface || !isAuthenticated || !currentUser?.id) {
      setOwnPendingAuctions([]);
      return;
    }
    const qOwn = query(
      collection(db, 'auctions'),
      where('createdById', '==', currentUser.id),
      where('status', '==', 'processing'),
      limit(20)
    );
    const unsubOwn = onSnapshot(qOwn, (snap) => {
      const itemsToResolve: { id: string; rawUrl: string; category: string }[] = [];
      const list = snap.docs.map((docSnap) => mapAuctionDoc(docSnap, itemsToResolve));
      setOwnPendingAuctions(list);
      if (itemsToResolve.length > 0) {
        Promise.all(
          itemsToResolve.map(async ({ id, rawUrl, category }) => {
            const resolvedUrl = await resolveVideoUrl(id, rawUrl, category);
            videoUrlCache.set(id, { rawUrl, resolvedUrl });
            return { id, resolvedUrl };
          })
        ).then((results) => {
          setOwnPendingAuctions((prev) =>
            prev.map((item) => {
              const matched = results.find((r) => r.id === item.id);
              return matched ? { ...item, videoUrl: matched.resolvedUrl } : item;
            })
          );
        }).catch((err) => {
          console.error("Own-pending video resolution failed:", err);
        });
      }
    }, (err) => {
      console.warn("Firestore own-pending auctions sync error:", err);
      setOwnPendingAuctions([]);
    });
    return () => unsubOwn();
  }, [isBuyerSurface, isAuthenticated, currentUser?.id]);

  // Real-time escrows synchronization with Firestore
  useEffect(() => {
    if (!isAuthenticated || !currentUser?.id || !isDeferredReady) {
      return;
    }

    const isStrictAdmin = isAdminUser(currentUser);
    if (isStrictAdmin) {
      const escrowsRefCol = collection(db, 'escrows');
      const q = query(escrowsRefCol, orderBy('timestamp', 'desc'), limit(100));
      const unsub = onSnapshot(q, (snap) => {
        const fetchedEscrows: EscrowTransaction[] = [];
        snap.forEach((docSnap) => {
          const rawData = docSnap.data();
          const amount = (rawData.amountFils !== undefined ? rawData.amountFils / 1000 : (rawData.amount ?? 0));
          fetchedEscrows.push({
            id: docSnap.id,
            ...rawData,
            amount
          } as EscrowTransaction);
        });
        fetchedEscrows.sort((a, b) => b.timestamp - a.timestamp);
        setEscrows(fetchedEscrows.length > 0 ? fetchedEscrows : INITIAL_ESCROWS);
      }, (err) => {
        console.warn("Firestore 'escrows' collection sync error:", err);
      });
      return () => unsub();
    } else {
      // Standard user: listen to escrows where bidderId == userId or sellerId == userId (limit 100)
      const bidderEscrowsQuery = query(collection(db, 'escrows'), where('bidderId', '==', currentUser.id), limit(100));

      let bidderEscrows: EscrowTransaction[] = [];
      let sellerEscrows: EscrowTransaction[] = [];

      const updateMergedEscrows = () => {
        const mergedMap = new Map<string, EscrowTransaction>();
        bidderEscrows.forEach(e => mergedMap.set(e.id, e));
        sellerEscrows.forEach(e => mergedMap.set(e.id, e));
        const mergedList = Array.from(mergedMap.values());
        mergedList.sort((a, b) => b.timestamp - a.timestamp);
        setEscrows(mergedList.length > 0 ? mergedList : INITIAL_ESCROWS);
      };

      const unsubBidder = onSnapshot(bidderEscrowsQuery, (snap) => {
        const list: EscrowTransaction[] = [];
        snap.forEach((docSnap) => {
          const rawData = docSnap.data();
          const amount = (rawData.amountFils !== undefined ? rawData.amountFils / 1000 : (rawData.amount ?? 0));
          list.push({
            id: docSnap.id,
            ...rawData,
            amount
          } as EscrowTransaction);
        });
        bidderEscrows = list;
        updateMergedEscrows();
      }, (err) => {
        console.warn("Firestore 'escrows' (bidder) sync error:", err);
      });

      // ALWAYS subscribe — same reasoning as the seller-orders subscription
      // below: an unflagged seller (and until now every self-serve seller was
      // unflagged) would otherwise never see the escrow holding their own
      // sale's money. An empty filtered listener is the cheaper mistake.
      let unsubSeller = () => {};
      {
        const sellerEscrowsQuery = query(collection(db, 'escrows'), where('sellerId', '==', currentUser.id), limit(100));
        unsubSeller = onSnapshot(sellerEscrowsQuery, (snap) => {
          const list: EscrowTransaction[] = [];
          snap.forEach((docSnap) => {
            const rawData = docSnap.data();
            const amount = (rawData.amountFils !== undefined ? rawData.amountFils / 1000 : (rawData.amount ?? 0));
            list.push({
              id: docSnap.id,
              ...rawData,
              amount
            } as EscrowTransaction);
          });
          sellerEscrows = list;
          updateMergedEscrows();
        }, (err) => {
          console.warn("Firestore 'escrows' (seller) sync error:", err);
        });
      }

      return () => {
        unsubBidder();
        unsubSeller();
      };
    }
  }, [isAuthenticated, currentUser?.id, currentUser?.role, currentUser?.isAdmin, currentUser?.isSeller, isDeferredReady]);

  // Real-time chats synchronization with Firestore.
  //
  // Gated on activeView === 'live': chatMessages is only ever read by
  // LiveStreamView / ReelsDesktopRightPanel, both of which only mount for
  // activeView === 'live' (see App.tsx's ActiveViewRenderer) — so there's
  // no other screen depending on this being populated. Previously this
  // subscription stayed open on every view, pinned to a default auction.
  //
  // NOTE (corrected): an earlier version of this fix removed the `limit(100)`
  // cap and argued the read was "bounded in practice" because only one
  // room's listener is open at a time. That conflates listener COUNT (always
  // 1, thanks to the activeView gate) with per-listener DOC count — a single
  // listener on a busy room with zero limit still reads every message in
  // that room's entire history on every snapshot, which is an unbounded and
  // growing read cost, not a bounded one. The actual fix is a server-side
  // `orderBy('timestamp','desc').limit(100)`, backed by the (auctionId,
  // timestamp) composite index in firestore.indexes.json — newest 100 only,
  // then reversed below to the ascending order the UI expects.
  useEffect(() => {
    if (!isAuthenticated || !isDeferredReady || activeView !== 'live') {
      return;
    }
    const targetAuctionId = activeAuctionId || 'auction-rolex';
    const chatsRefCol = collection(db, 'chats');
    const q = query(
      chatsRefCol,
      where('auctionId', '==', targetAuctionId),
      orderBy('timestamp', 'desc'),
      limit(100)
    );
    const unsub = onSnapshot(q, (snap) => {
      if (!snap.empty) {
        const fetchedChats: ChatMessage[] = [];
        snap.forEach((docSnap) => {
          fetchedChats.push({
            id: docSnap.id,
            ...docSnap.data()
          } as ChatMessage);
        });
        // Query returns newest-first (desc); LiveStreamView/ReelsDesktopRightPanel
        // render chatMessages oldest→newest (they treat the last array element
        // as "latest"), so reverse to ascending order before publishing.
        fetchedChats.reverse();
        setChatMessages(fetchedChats);
      } else {
        setChatMessages([]);
      }
    }, (err) => {
      console.warn("Firestore 'chats' collection sync error:", err);
    });
    return () => unsub();
  }, [isAuthenticated, isDeferredReady, activeAuctionId, activeView]);

  // Real-time users synchronization with Firestore (admin only).
  // PF4 part 1: cap the listener to the most-recently-active users instead of the
  // whole collection. The old unbounded onSnapshot re-ran an O(N) merge over every
  // user doc on every single per-bid `lastBidAt` write, hammering the admin browser.
  // orderBy('lastSeen','desc') + limit keeps the live-activity views (sessions table,
  // user list) fed with the users who actually matter while bounding the fan-out.
  // Trade-off: this is display-only and the admin now sees at most ADMIN_USERS_CAP
  // users live; the true account total is fetched separately via getCountFromServer.
  useEffect(() => {
    if (!isAuthenticated || !isAdminUser(currentUser)) {
      return;
    }
    const ADMIN_USERS_CAP = 200;
    const usersQuery = query(
      collection(db, 'users'),
      orderBy('lastSeen', 'desc'),
      limit(ADMIN_USERS_CAP)
    );

    // True total (unaffected by the cap) for admin count stats. Best-effort, one-shot.
    getCountFromServer(collection(db, 'users'))
      .then(res => setUsersTotalCount(res.data().count))
      .catch(err => console.warn("Firestore users count query failed:", err));

    const unsub = onSnapshot(usersQuery, (snap) => {
      if (!snap.empty) {
        const fetchedUsers: User[] = [];
        snap.forEach((docSnap) => {
          fetchedUsers.push({
            id: docSnap.id,
            ...docSnap.data()
          } as User);
        });
        setUsers(prev => {
          // Merge lists, preferring Firestore data
          const merged = [...prev];
          fetchedUsers.forEach(fu => {
            const idx = merged.findIndex(u => u.id === fu.id);
            if (idx > -1) {
              merged[idx] = { ...merged[idx], ...fu };
            } else {
              merged.push(fu);
            }
          });
          return merged;
        });
      }
    }, (err) => {
      console.warn("Firestore 'users' collection sync error:", err);
    });
    return () => unsub();
  }, [isAuthenticated, currentUser?.role, currentUser?.isAdmin]);

  // Real-time sellerProfiles synchronization with Firestore
  useEffect(() => {
    if (!isAuthenticated || !isDeferredReady || !currentUser?.id) return;

    const isStrictAdmin = isAdminUser(currentUser);

    if (isStrictAdmin) {
      // Admins get up to 100 profiles
      const q = query(collection(db, 'sellerProfiles'), limit(100));
      const unsub = onSnapshot(q, (snap) => {
        if (!snap.empty) {
          const fetchedProfiles: SellerProfile[] = [];
          snap.forEach((docSnap) => {
            fetchedProfiles.push({
              id: docSnap.id,
              ...docSnap.data()
            } as SellerProfile);
          });
          setSellerProfiles(prev => {
            const merged = [...prev];
            fetchedProfiles.forEach(fp => {
              const idx = merged.findIndex(p => p.id === fp.id || p.userId === fp.userId);
              if (idx > -1) {
                merged[idx] = { ...merged[idx], ...fp };
              } else {
                merged.push(fp);
              }
            });
            return merged;
          });
        }
      }, (err) => {
        console.warn("Firestore 'sellerProfiles' collection sync error:", err);
      });
      return () => unsub();
    } else {
      // Normal user: ONLY subscribe to their own seller profile
      const q = query(collection(db, 'sellerProfiles'), where('userId', '==', currentUser.id), limit(1));
      const unsub = onSnapshot(q, (snap) => {
        if (!snap.empty) {
          const fetchedProfiles: SellerProfile[] = [];
          snap.forEach((docSnap) => {
            fetchedProfiles.push({
              id: docSnap.id,
              ...docSnap.data()
            } as SellerProfile);
          });
          setSellerProfiles(prev => {
            const merged = [...prev];
            fetchedProfiles.forEach(fp => {
              const idx = merged.findIndex(p => p.id === fp.id || p.userId === fp.userId);
              if (idx > -1) {
                merged[idx] = { ...merged[idx], ...fp };
              } else {
                merged.push(fp);
              }
            });
            return merged;
          });
        }
      }, (err) => {
        console.warn("Firestore 'sellerProfiles' (own) sync error:", err);
      });
      return () => unsub();
    }
  }, [isAuthenticated, isDeferredReady, currentUser?.id, currentUser?.role, currentUser?.isAdmin]);

  // Lightweight listener on the user's OWN reviews (buyerId == uid) — powers the
  // post-win review prompt and the unreviewed-order bid gate without a global reviews sync.
  useEffect(() => {
    if (!isAuthenticated || !isDeferredReady || !currentUser?.id || currentUser.id === 'unauthenticated') {
      setMyReviews([]);
      return;
    }
    const q = query(collection(db, 'reviews'), where('buyerId', '==', currentUser.id), limit(200));
    const unsub = onSnapshot(q, (snap) => {
      const list: OrderReview[] = [];
      snap.forEach((docSnap) => {
        list.push({ id: docSnap.id, ...docSnap.data() } as OrderReview);
      });
      setMyReviews(list);
        setMyReviewsLoaded(true);
    }, (err) => {
      console.warn("Firestore 'reviews' (own) sync error:", err);
    });
    return () => unsub();
  }, [isAuthenticated, isDeferredReady, currentUser?.id]);

  // Oldest completed buyer order this user has NOT rated yet — gates the next bid (client-side v1).
  const pendingReviewOrder = useMemo<Order | null>(() => {
    // Never gate bidding before the user's reviews have actually loaded —
    // an empty-but-unloaded list would false-positive on reviewed orders.
    if (!myReviewsLoaded) return null;
    if (!currentUser?.id || currentUser.id === 'unauthenticated') return null;
    const toMs = (raw: any): number => {
      if (!raw) return 0;
      if (typeof raw?.toMillis === 'function') return raw.toMillis();
      if (raw?.seconds) return raw.seconds * 1000;
      const t = new Date(raw).getTime();
      return Number.isNaN(t) ? 0 : t;
    };
    const reviewedOrderIds = new Set(
      myReviews.filter(r => r.direction === 'buyer_rates_auction').map(r => r.orderId)
    );
    const candidates = (orders || []).filter(o =>
      o.buyerId === currentUser.id &&
      o.status === 'completed' &&
      !reviewedOrderIds.has(o.id)
    );
    if (candidates.length === 0) return null;
    return [...candidates].sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt))[0];
  }, [orders, myReviews, myReviewsLoaded, currentUser?.id]);

  // Distinct, non-sentinel seller ids across the current auctions. Memoized on
  // a stable STRING key so the prefetch effect below runs when the SET of
  // sellers changes — not on every auctions-snapshot object churn (PF1).
  const distinctAuctionSellerIds = useMemo(
    () => distinctSellerIds(auctions.map(a => a.sellerId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [auctions.map(a => a.sellerId).join('|')]
  );

  // Latest sellerProfiles read via a ref so the prefetch effect can check
  // "already loaded?" without taking sellerProfiles as a dependency (which would
  // re-fire it on every profile merge).
  const sellerProfilesRef = useRef(sellerProfiles);
  sellerProfilesRef.current = sellerProfiles;

  // Automated pre-fetching of seller profiles for all active/upcoming auctions.
  // PF1: a module-level negative cache (attemptedSellerIds) records GENUINE
  // misses so a profile-less seller is never re-fetched, collapsing what used to
  // be an unbounded read loop firing on every bid/snapshot into a single pass
  // per newly-seen seller.
  useEffect(() => {
    if (distinctAuctionSellerIds.length === 0) return;

    const hasProfile = (id: string) =>
      sellerProfilesRef.current.some(p => p.userId === id || p.id === id);
    const missingIds = nextMissingSellerIds(distinctAuctionSellerIds, attemptedSellerIds, hasProfile);
    if (missingIds.length === 0) return;

    const fetchMissing = async () => {
      const fetched: SellerProfile[] = [];
      for (const id of missingIds) {
        try {
          const q = query(collection(db, 'sellerProfiles'), where('userId', '==', id), limit(1));
          const snap = await getDocs(q);
          if (!snap.empty) {
            fetched.push({ id: snap.docs[0].id, ...snap.docs[0].data() } as SellerProfile);
          } else {
            const docSnap = await getDoc(doc(db, 'sellerProfiles', id));
            if (docSnap.exists()) {
              fetched.push({ id: docSnap.id, ...docSnap.data() } as SellerProfile);
            } else {
              // Genuine miss: no profile doc existed at read time. Cache it so we
              // never re-fetch. If this seller creates a profile LATER, the
              // authoritative sellerProfiles listener still surfaces it — we only
              // suppress the redundant prefetch, accepting eventual-consistency
              // staleness for the prefetch path (documented tradeoff).
              attemptedSellerIds.add(id);
            }
          }
        } catch (e) {
          // Do NOT cache on error — the miss is unconfirmed, so allow a retry.
          console.warn(`Error pre-fetching profile for seller ${id}:`, e);
        }
      }
      if (fetched.length > 0) {
        setSellerProfiles(prev => {
          const merged = [...prev];
          fetched.forEach(fp => {
            if (!merged.some(p => p.id === fp.id || p.userId === fp.userId)) {
              merged.push(fp);
            }
          });
          return merged;
        });
      }
    };

    fetchMissing();
  }, [distinctAuctionSellerIds]);

  // Sync singular current user's sellerProfile whenever sellerProfiles list or current user changes
  useEffect(() => {
    if (currentUser?.id && sellerProfiles.length > 0) {
      const profile = sellerProfiles.find(p => p.userId === currentUser.id);
      if (profile) {
        setSellerProfile(profile);
      }
    } else {
      setSellerProfile(null);
    }
  }, [currentUser?.id, sellerProfiles]);

  // Real-time orders synchronization with Firestore
  useEffect(() => {
    if (!isAuthenticated || !currentUser?.id || !isDeferredReady) {
      setOrders([]);
      return;
    }

    const isStrictAdmin = isAdminUser(currentUser);
    if (isStrictAdmin) {
      const ordersRefCol = collection(db, 'orders');
      const q = query(ordersRefCol, orderBy('createdAt', 'desc'), limit(100));
      const unsub = onSnapshot(q, (snap) => {
        const fetchedOrders: Order[] = [];
        snap.forEach((docSnap) => {
          fetchedOrders.push({
            id: docSnap.id,
            ...docSnap.data()
          } as Order);
        });
        fetchedOrders.sort((a, b) => {
          const aTime = a.createdAt?.seconds ? a.createdAt.seconds * 1000 : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
          const bTime = b.createdAt?.seconds ? b.createdAt.seconds * 1000 : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
          return bTime - aTime;
        });
        setOrders(fetchedOrders);
      }, (err) => {
        console.warn("Firestore 'orders' collection sync error:", err);
      });
      return () => unsub();
    } else {
      // Standard user: listen to orders where buyerId == userId or sellerId == userId (limit 100)
      const buyerQuery = query(collection(db, 'orders'), where('buyerId', '==', currentUser.id), limit(100));

      let buyerOrders: Order[] = [];
      let sellerOrders: Order[] = [];

      const updateMergedOrders = () => {
        const mergedMap = new Map<string, Order>();
        buyerOrders.forEach(o => mergedMap.set(o.id, o));
        sellerOrders.forEach(o => mergedMap.set(o.id, o));
        const mergedList = Array.from(mergedMap.values());
        mergedList.sort((a, b) => {
          const aTime = a.createdAt?.seconds ? a.createdAt.seconds * 1000 : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
          const bTime = b.createdAt?.seconds ? b.createdAt.seconds * 1000 : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
          return bTime - aTime;
        });
        setOrders(mergedList);
      };

      const unsubBuyer = onSnapshot(buyerQuery, (snap) => {
        const list: Order[] = [];
        snap.forEach((docSnap) => {
          list.push({
            id: docSnap.id,
            ...docSnap.data()
          } as Order);
        });
        buyerOrders = list;
        updateMergedOrders();
      }, (err) => {
        console.warn("Firestore 'orders' (buyer) sync error:", err);
      });

      // ALWAYS subscribe, for every signed-in user.
      //
      // This used to be gated on `isAdminOrSeller(currentUser)` as an
      // optimization ("pure buyers have no seller-side orders"). That gate was
      // wrong, and it cost real sellers their sales: nothing in the app could
      // grant `isSeller` (the only code that wrote it was both dead AND blocked
      // by the firestore.rules self-write denylist), so a self-serve seller who
      // listed an item and sold it stayed unflagged forever. DesktopFrame shows
      // them the Seller Center nav — it ORs in `ownsListing` — and then the
      // page reads "No orders logged yet", because this subscription never
      // opened. Five production accounts were in exactly that state.
      //
      // Gating it on `ownsListing` instead would fix those five and re-break
      // the next person whose first sale arrives before that listener resolves.
      // The query is `where sellerId == me` with limit 100; for a pure buyer it
      // matches nothing, and an empty filtered listener is far cheaper than a
      // seller who cannot see — or now, under Wave 3, cannot fulfil — their own
      // order. Correctness over a micro-optimization.
      let unsubSeller = () => {};
      {
        const sellerQuery = query(collection(db, 'orders'), where('sellerId', '==', currentUser.id), limit(100));
        unsubSeller = onSnapshot(sellerQuery, (snap) => {
          const list: Order[] = [];
          snap.forEach((docSnap) => {
            list.push({
              id: docSnap.id,
              ...docSnap.data()
            } as Order);
          });
          sellerOrders = list;
          updateMergedOrders();
        }, (err) => {
          console.warn("Firestore 'orders' (seller) sync error:", err);
        });
      }

      return () => {
        unsubBuyer();
        unsubSeller();
      };
    }
  }, [isAuthenticated, currentUser?.id, currentUser?.isAdmin, currentUser?.role, currentUser?.isSeller, isDeferredReady]);

  // Real-time synchronization for trust system collections
  useEffect(() => {
    if (!isAuthenticated || !currentUser?.id || !isDeferredReady) {
      setReviews([]);
      setVerificationRequests([]);
      setSellerReports([]);
      setDisputes([]);
      return;
    }

    const isStrictAdmin = isAdminUser(currentUser);

    // 1. Reviews (Removed global real-time listener to optimize read cost. Loaded on-demand instead)
    const unsubReviews = () => {};

    // 2. Verification Requests
    let unsubVerifications = () => {};
    if (isStrictAdmin) {
      const q = query(collection(db, 'sellerVerificationRequests'), orderBy('submittedAt', 'desc'), limit(100));
      unsubVerifications = onSnapshot(q, (snap) => {
        const list: VerificationRequest[] = [];
        snap.forEach((d) => {
          list.push({ id: d.id, ...d.data() } as VerificationRequest);
        });
        setVerificationRequests(list.sort((a, b) => b.submittedAt - a.submittedAt));
      }, (err) => console.warn("Verification requests sync error:", err));
    } else {
      const qVer = query(collection(db, 'sellerVerificationRequests'), where('userId', '==', currentUser.id), limit(10));
      unsubVerifications = onSnapshot(qVer, (snap) => {
        const list: VerificationRequest[] = [];
        snap.forEach((d) => {
          list.push({ id: d.id, ...d.data() } as VerificationRequest);
        });
        setVerificationRequests(list.sort((a, b) => b.submittedAt - a.submittedAt));
      }, (err) => console.warn("Verification requests sync error:", err));
    }

    // 3. Reports
    let unsubReports = () => {};
    if (isStrictAdmin) {
      const q = query(collection(db, 'sellerReports'), orderBy('timestamp', 'desc'), limit(100));
      unsubReports = onSnapshot(q, (snap) => {
        const list: SellerReport[] = [];
        snap.forEach((d) => {
          list.push({ id: d.id, ...d.data() } as SellerReport);
        });
        setSellerReports(list.sort((a, b) => b.timestamp - a.timestamp));
      }, (err) => console.warn("Seller reports sync error:", err));
    }

    // 4. Disputes
    let unsubDisputes = () => {};
    if (isStrictAdmin) {
      const q = query(collection(db, 'disputes'), orderBy('timestamp', 'desc'), limit(100));
      unsubDisputes = onSnapshot(q, (snap) => {
        const list: Dispute[] = [];
        snap.forEach((d) => {
          list.push({ id: d.id, ...d.data() } as Dispute);
        });
        setDisputes(list.sort((a, b) => b.timestamp - a.timestamp));
      }, (err) => console.warn("Disputes sync error:", err));
    } else {
      // Buyer/Seller: Merge disputes where buyerId == currentUser.id OR sellerId == currentUser.id (limit 50)
      const qBuyerDisp = query(collection(db, 'disputes'), where('buyerId', '==', currentUser.id), limit(50));

      let bDisps: Dispute[] = [];
      let sDisps: Dispute[] = [];

      const updateDisputes = () => {
        const merged = new Map<string, Dispute>();
        bDisps.forEach(d => merged.set(d.id, d));
        sDisps.forEach(d => merged.set(d.id, d));
        setDisputes(Array.from(merged.values()).sort((a, b) => b.timestamp - a.timestamp));
      };

      const unsubBuyerDisp = onSnapshot(qBuyerDisp, (snap) => {
        const list: Dispute[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() } as Dispute));
        bDisps = list;
        updateDisputes();
      }, (err) => console.warn("Buyer disputes sync error:", err));

      // ALWAYS subscribe. This one is the sharpest of the three: gated on a
      // flag nothing could grant, a seller never saw a dispute raised AGAINST
      // them — they simply had no idea it existed while it was being
      // adjudicated. Same reasoning as the orders subscription.
      let unsubSellerDisp = () => {};
      {
        const qSellerDisp = query(collection(db, 'disputes'), where('sellerId', '==', currentUser.id), limit(50));
        unsubSellerDisp = onSnapshot(qSellerDisp, (snap) => {
          const list: Dispute[] = [];
          snap.forEach((d) => list.push({ id: d.id, ...d.data() } as Dispute));
          sDisps = list;
          updateDisputes();
        }, (err) => console.warn("Seller disputes sync error:", err));
      }

      unsubDisputes = () => {
        unsubBuyerDisp();
        unsubSellerDisp();
      };
    }

    return () => {
      unsubReviews();
      unsubVerifications();
      unsubReports();
      unsubDisputes();
    };
  }, [isAuthenticated, currentUser?.id, currentUser?.isAdmin, currentUser?.role, currentUser?.isSeller, isDeferredReady]);

const generateSessionId = () => {
  if (typeof window !== 'undefined' && window.crypto && window.crypto.randomUUID) {
    return window.crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

const getDeviceInfo = () => {
  if (typeof navigator === 'undefined') {
    return { browser: 'Unknown', platform: 'Unknown', deviceType: 'Unknown', userAgent: '', appVersion: '1.13.0' };
  }
  const ua = navigator.userAgent;
  let browser = "Unknown";
  if (ua.indexOf("Firefox") > -1) browser = "Firefox";
  else if (ua.indexOf("SamsungBrowser") > -1) browser = "Samsung Browser";
  else if (ua.indexOf("Opera") > -1 || ua.indexOf("OPR") > -1) browser = "Opera";
  else if (ua.indexOf("Trident") > -1) browser = "Internet Explorer";
  else if (ua.indexOf("Edge") > -1) browser = "Edge";
  else if (ua.indexOf("Chrome") > -1) browser = "Chrome";
  else if (ua.indexOf("Safari") > -1) browser = "Safari";

  let platform = "Web";
  if (ua.indexOf("Windows") > -1) platform = "Windows";
  else if (ua.indexOf("Macintosh") > -1) platform = "macOS";
  else if (ua.indexOf("Linux") > -1) platform = "Linux";
  else if (ua.indexOf("Android") > -1) platform = "Android";
  else if (ua.indexOf("iPhone") > -1 || ua.indexOf("iPad") > -1) platform = "iOS";

  const isMobile = /Mobi|Android/i.test(ua);

  return {
    browser,
    platform,
    deviceType: isMobile ? "Mobile" : "Desktop",
    userAgent: ua,
    appVersion: "1.13.0"
  };
};

const fetchIP = async () => {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 1200);
    const res = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
    clearTimeout(id);
    const data = await res.json();
    return data.ip || 'not_available';
  } catch (err) {
    return 'not_available';
  }
};

  const setLanguage = useCallback((lang: 'en' | 'ar') => {
    // Local first and unconditionally: the toggle is instant, and a signed-out
    // visitor keeps their choice (LandingView reads the same key directly).
    setLanguageState(lang);
    localStorage.setItem('mazad_language', lang);
    // Then the server's copy. Cloud Functions read users/{uid}.language to pick
    // the language for in-app notifications, WhatsApp and email; without this
    // write every recipient falls back to Arabic. Fire-and-forget and never
    // awaited — the UI has already switched, so a failed write is non-fatal and
    // the next toggle retries.
    persistLanguagePreference(
      { isAuthenticated, userId: currentUser?.id },
      lang,
      (uid, patch) => updateDoc(doc(db, 'users', uid), patch),
      (err) => console.warn('[setLanguage] language preference not persisted:', err)
    );
  }, [isAuthenticated, currentUser?.id]);

  const setTheme = useCallback((next: Theme) => {
    const value = normalizeTheme(next);
    // Local and immediate — the toggle must not wait on the network.
    setThemeState(value);
    applyThemeAttribute(value);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, value);
    } catch (_) {
      // Private mode / embedded webview. The theme still applies for this
      // session; only its persistence across reloads is lost.
    }
    // setDoc+merge rather than updateDoc: a user document that predates this
    // field must gain it rather than throwing not-found.
    persistThemePreference(
      { isAuthenticated, userId: currentUser?.id },
      value,
      (uid, patch) => setDoc(doc(db, 'users', uid), patch, { merge: true }),
      (err) => console.warn('[setTheme] theme preference not persisted:', err)
    );
  }, [isAuthenticated, currentUser?.id]);

  // Two directions, one effect:
  //  - the account HAS a theme -> follow it. It may have been set on another
  //    device more recently than this browser's localStorage.
  //  - the account has NONE and this browser holds an explicit choice -> adopt
  //    it, so a theme picked before signing up is not silently lost. Exactly the
  //    gap shouldAdoptLocalLanguage closes for language.
  useEffect(() => {
    if (!currentUser?.id) {
      themeAdoptedRef.current = false;
      return;
    }
    const session = { isAuthenticated: true, userId: currentUser.id };
    const docThemeRaw = (currentUser as any).theme;
    const docTheme = storedDocTheme(docThemeRaw);
    if (docTheme) {
      if (docTheme !== theme) {
        setThemeState(docTheme);
        applyThemeAttribute(docTheme);
      }
      return;
    }
    if (shouldAdoptLocalTheme({
      session,
      storedTheme: readStoredTheme(),
      docTheme: docThemeRaw,
      alreadyAdopted: themeAdoptedRef.current,
    })) {
      themeAdoptedRef.current = true;
      persistThemePreference(
        session, theme,
        (uid, patch) => setDoc(doc(db, 'users', uid), patch, { merge: true }),
        (err) => console.warn('[theme] adoption not persisted:', err)
      );
    }
  }, [currentUser?.id, (currentUser as any)?.theme, theme]);

  const login = useCallback(async (email: string, pass: string) => {
    const cleanEmail = email.toLowerCase().trim();
    try {
      const newSessionId = generateSessionId();
      localStorage.setItem('mazad_session_id', newSessionId);
      localStorage.setItem('mazad_last_login_time', String(Date.now()));
      const userCredential = await signInWithEmailAndPassword(auth, cleanEmail, pass);
      const user = userCredential.user;

      const userRef = doc(db, 'users', user.uid);
      const dev = getDeviceInfo();
      const ip = await fetchIP();
      await updateDoc(userRef, {
        sessionId: newSessionId,
        lastLoginAt: new Date().toISOString(),
        deviceInfo: `${dev.browser} on ${dev.platform} (${dev.deviceType})`,
        platform: dev.platform,
        browser: dev.browser,
        deviceType: dev.deviceType,
        appVersion: dev.appVersion,
        lastLoginIP: ip,
        lastSeen: new Date().toISOString()
      });

      return { 
        success: true, 
        message: language === 'ar' ? 'تم تسجيل الدخول بنجاح!' : 'Logged in successfully!' 
      };
    } catch (error: any) {
      console.error("Firebase auth login error:", error);

      // Attempt self-healing auto-registration if user is not found or credential was wrong (likely unregistered)
      if (error.code === 'auth/invalid-credential' || error.code === 'auth/user-not-found') {
        try {
          console.log("[Auto-register] Email not found or invalid credential in clear environment; attempting fallback auto-registration...", cleanEmail);
          const newSessionId = generateSessionId();
          localStorage.setItem('mazad_session_id', newSessionId);
          localStorage.setItem('mazad_last_login_time', String(Date.now()));
          const userCredential = await createUserWithEmailAndPassword(auth, cleanEmail, pass);
          const user = userCredential.user;
          
          const nameFromEmail = cleanEmail.split('@')[0];
          const name = nameFromEmail.charAt(0).toUpperCase() + nameFromEmail.slice(1);
          await updateProfile(user, { displayName: name });
          
          const userRef = doc(db, 'users', user.uid);
          const dev = getDeviceInfo();
          const ip = await fetchIP();
          const freshUserDoc = {
            id: user.uid,
            uid: user.uid,
            name: name,
            email: cleanEmail,
            avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&q=80',
            role: 'user',
            phoneNumber: '',
            phone: '',
            city: '',
            createdAt: new Date().toISOString(),
            sessionId: newSessionId,
            lastLoginAt: new Date().toISOString(),
            deviceInfo: `${dev.browser} on ${dev.platform} (${dev.deviceType})`,
            platform: dev.platform,
            browser: dev.browser,
            deviceType: dev.deviceType,
            appVersion: dev.appVersion,
            lastLoginIP: ip,
            lastSeen: new Date().toISOString()
          };
          await setDoc(userRef, freshUserDoc);
          
          return { 
            success: true, 
            message: language === 'ar' 
              ? 'تم إنشاء الحساب وتسجيل الدخول بنجاح!' 
              : 'Account auto-registered and logged in successfully!' 
          };
        } catch (regError: any) {
          console.warn("[Auto-register] Fail fallback:", regError);
          // If already in use, it was indeed a wrong password
          if (regError.code === 'auth/email-already-in-use') {
            let errorMsg = language === 'ar' 
              ? 'خطأ في البريد الإلكتروني أو كلمة المرور، يرجى المحاولة مرة أخرى.' 
              : 'Incorrect email or password, please try again.';
            return { success: false, message: errorMsg };
          }
        }
      }

      let errorMsg = error.message;
      if (error.code === 'auth/wrong-password' || error.code === 'auth/user-not-found' || error.code === 'auth/invalid-credential') {
        errorMsg = language === 'ar' 
          ? 'خطأ في البريد الإلكتروني أو كلمة المرور، يرجى المحاولة مرة أخرى.' 
          : 'Incorrect email or password, please try again.';
      } else if (error.code === 'auth/invalid-email') {
        errorMsg = language === 'ar' 
          ? 'البريد الإلكتروني المكتوب غير صالح.' 
          : 'The email address is invalid.';
      } else {
        errorMsg = error.message || errorMsg;
      }
      return { success: false, message: errorMsg };
    }
  }, [language]);

  const loginWithGoogle = useCallback(async () => {
    const provider = new GoogleAuthProvider();
    
    const newSessionId = generateSessionId();
    localStorage.setItem('mazad_session_id', newSessionId);
    localStorage.setItem('mazad_last_login_time', String(Date.now()));
    
    try {
      console.log("Attempting Google Auth via signInWithPopup first...");
      await signInWithPopup(auth, provider);
    } catch (popupError: any) {
      console.warn("Google Auth popup failed, falling back to redirect:", popupError);
      // Fallback to redirect
      try {
        await signInWithRedirect(auth, provider);
      } catch (redirectError: any) {
        console.error("Google Auth completely failed:", redirectError);
        throw redirectError;
      }
    }
  }, []);

  const loginWithPhone = useCallback(async (phoneE164: string, appVerifier: import('firebase/auth').ApplicationVerifier) => {
    const { signInWithPhoneNumber } = await import('firebase/auth');
    const newSessionId = generateSessionId();
    localStorage.setItem('mazad_session_id', newSessionId);
    localStorage.setItem('mazad_last_login_time', String(Date.now()));
    // Returns a ConfirmationResult; the UI then calls confirmPhoneCode with the SMS code.
    return signInWithPhoneNumber(auth, phoneE164, appVerifier);
  }, []);

  // WhatsApp OTP — primary phone sign-in. The backend callables send/verify a 6-digit
  // code over WhatsApp; verify returns a Firebase custom token on success.
  const requestWhatsappOtp = useCallback(async (phone: string) => {
    const callable = await getCallableFunction<{ phone: string }, { ok: boolean; delivered?: boolean; retryAfterSec?: number }>('requestWhatsappOtp');
    const result = await callable({ phone });
    return result.data;
  }, []);

  const verifyWhatsappOtp = useCallback(async (phone: string, code: string) => {
    const callable = await getCallableFunction<{ phone: string; code: string }, { ok: boolean; token?: string }>('verifyWhatsappOtp');
    const result = await callable({ phone, code });
    return result.data;
  }, []);

  // Mirror loginWithPhone's sessionId bookkeeping BEFORE sign-in, then exchange the
  // custom token. onAuthStateChanged then flips the app into the authenticated shell.
  const signInWhatsapp = useCallback(async (token: string) => {
    const { signInWithCustomToken } = await import('firebase/auth');
    const newSessionId = generateSessionId();
    localStorage.setItem('mazad_session_id', newSessionId);
    localStorage.setItem('mazad_last_login_time', String(Date.now()));
    await signInWithCustomToken(auth, token);
  }, []);

  const confirmPhoneCode = useCallback(async (confirmation: import('firebase/auth').ConfirmationResult, code: string) => {
    try {
      // (review B2) OTP entry takes longer than the 10s session grace window used by the
      // onAuthStateChanged session-conflict check (~:674-680). Refresh the timestamp
      // IMMEDIATELY before confirm() so a returning phone user isn't force-logged-out.
      localStorage.setItem('mazad_last_login_time', String(Date.now()));
      const cred = await confirmation.confirm(code); // signs the user in
      // (review B2) Mirror email login(): persist the new sessionId onto the EXISTING user
      // doc so the session-conflict check passes. New users get their sessionId written by
      // the onAuthStateChanged new-user path.
      const uid = cred?.user?.uid;
      if (uid) {
        const userRef = doc(db, 'users', uid);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
          const dev = getDeviceInfo();
          const ip = await fetchIP();
          await updateDoc(userRef, {
            sessionId: localStorage.getItem('mazad_session_id') || '',
            lastLoginAt: new Date().toISOString(),
            deviceInfo: `${dev.browser} on ${dev.platform} (${dev.deviceType})`,
            platform: dev.platform,
            browser: dev.browser,
            deviceType: dev.deviceType,
            appVersion: dev.appVersion,
            lastLoginIP: ip,
            lastSeen: new Date().toISOString()
          });
        }
      }
      return { success: true, message: '' };
    } catch (e: any) {
      // Never surface raw Firebase strings — map to a friendly AR/EN message.
      return { success: false, message: mapAuthError(e, language === 'ar') };
    }
  }, [language]);

  // --- E5 contact completion -------------------------------------------------
  // These ATTACH a missing contact channel to the CURRENT account. Phone uses
  // PhoneAuthProvider + linkWithCredential (NOT signInWithPhoneNumber) so the
  // uid — and therefore the wallet/history — is preserved. reCAPTCHA plumbing
  // mirrors LoginView: the modal builds the invisible verifier and hands it in.

  // Step 1 (send code): reuse the invisible-reCAPTCHA verifier the modal built
  // and return the verificationId for the confirm step.
  const linkPhoneSendCode = useCallback(async (
    e164Phone: string,
    appVerifier: import('firebase/auth').ApplicationVerifier
  ): Promise<string> => {
    const provider = new PhoneAuthProvider(auth);
    const verificationId = await provider.verifyPhoneNumber(e164Phone, appVerifier);
    return verificationId; // hand back to the modal for the confirm step
  }, []);

  // Step 2 (verify + link to THIS uid, not a new phone account). Throws on
  // failure so the modal can inspect err.code (e.g. auth/credential-already-in-use).
  const linkPhoneToAccount = useCallback(async (verificationId: string, code: string): Promise<void> => {
    const cred = PhoneAuthProvider.credential(verificationId, code);
    await linkWithCredential(auth.currentUser!, cred); // same UID keeps wallet/history
    const digits = auth.currentUser!.phoneNumber || '';
    const normalizedPhone = digits.replace(/\D/g, '');
    await setDoc(doc(db, 'users', auth.currentUser!.uid), {
      phoneNumber: digits, phone: digits, normalizedPhone,
    }, { merge: true });
    // Mirror into local state so resolveMissingContact(currentUser) clears the
    // phone requirement immediately and the modal can call onComplete().
    setCurrentUser(prev => ({ ...prev, phoneNumber: digits, phone: digits }));
    setUsers(prev => prev.map(u => (u.id === auth.currentUser!.uid ? { ...u, phoneNumber: digits, phone: digits } : u)));
  }, []);

  // WhatsApp-OTP attach (replaces the reCAPTCHA linkPhone flow for E5). The callable
  // verifies the code and attaches the number to THIS uid server-side (no token —
  // already authed). On success we mirror linkPhoneToAccount's user-doc write so
  // resolveMissingContact(currentUser) clears the phone requirement immediately.
  // Rethrows the callable's HttpsError (e.g. functions/already-exists) for the modal.
  const attachWhatsappPhone = useCallback(async (phone: string, code: string): Promise<{ ok: boolean }> => {
    const callable = await getCallableFunction<{ phone: string; code: string }, { ok: boolean }>('attachWhatsappPhone');
    const result = await callable({ phone, code });
    if (result.data.ok) {
      const e164 = toE164Jordan(phone) || phone;
      const normalizedPhone = e164.replace(/\D/g, '');
      const uid = auth.currentUser!.uid;
      await setDoc(doc(db, 'users', uid), {
        phoneNumber: e164, phone: e164, normalizedPhone,
      }, { merge: true });
      setCurrentUser(prev => ({ ...prev, phoneNumber: e164, phone: e164 }));
      setUsers(prev => prev.map(u => (u.id === uid ? { ...u, phoneNumber: e164, phone: e164 } : u)));
    }
    return result.data;
  }, []);

  const saveEmail = useCallback(async (email: string): Promise<void> => {
    const trimmed = email.trim();
    await setDoc(doc(db, 'users', auth.currentUser!.uid), { email: trimmed }, { merge: true });
    setCurrentUser(prev => ({ ...prev, email: trimmed }));
    setUsers(prev => prev.map(u => (u.id === auth.currentUser!.uid ? { ...u, email: trimmed } : u)));
  }, []);

  const logout = useCallback(async () => {
    try {
      const uid = currentUser?.id;
      await signOut(auth);
      setCurrentUser(DEFAULT_UNAUTHENTICATED_USER);
      setIsAuthenticated(false);
      // Shared-device privacy (Wave E1 review fix): the bell holds PRIVATE
      // cross-user verdicts (incl. rejection reasons) — purge the in-memory
      // list, the persisted per-user entries, the dismissed-ids cache and the
      // Firestore-merge bookkeeping so the next account sees nothing.
      setNotifications([]);
      firestoreNotifIdsRef.current = new Set();
      notifStoreUidRef.current = null;
      try {
        if (uid) {
          localStorage.removeItem(`${NOTIF_STORE_PREFIX}${uid}`);
          localStorage.removeItem(`${DISMISSED_STORE_PREFIX}${uid}`);
        }
        localStorage.removeItem(LEGACY_NOTIF_KEY);
        localStorage.removeItem(LEGACY_DISMISSED_KEY);
      } catch { /* storage unavailable — nothing persisted then */ }
      setWallet({
        userId: 'user-current',
        totalBalance: 0,
        availableBalance: 0,
        escrowBalance: 0
      });
    } catch (error) {
      console.error("Logout error:", error);
    }
  }, [currentUser?.id]);

  const registerUser = useCallback(async (name: string, email: string, password = '', phone = '') => {
    const cleanEmail = email.toLowerCase().trim();
    const cleanPhone = phone.trim();
    const cleanName = name.trim();

    // Duplicate Account & Sybil / Fraud Protection Validation via Cloud Function
    try {
      const checkDuplicate = await getCallableFunction<{ phone: string; name: string }, { phoneExists: boolean; nameExists: boolean; duplicate: boolean }>(
        'checkDuplicateAccount'
      );
      const dupResult = await checkDuplicate({ phone: cleanPhone, name: cleanName });
      
      if (dupResult.data && dupResult.data.duplicate) {
        await logAnalyticsEvent('rate_limit_triggered', null, cleanEmail, { 
          reason: 'duplicate_account_blocked', 
          attemptedPhone: cleanPhone,
          attemptedName: cleanName 
        });
        return {
          success: false,
          message: language === 'ar'
            ? 'يوجد حساب مسجل مسبقاً بنفس رقم الهاتف أو الاسم. تواصل مع الدعم.'
            : 'An account with the same phone number or name already exists. Please contact support.'
        };
      }
    } catch (dupErr) {
      console.error("Duplicate verification check failed: ", dupErr);
      return {
        success: false,
        message: language === 'ar'
          ? 'تعذر التحقق من صحة الحساب حالياً، يرجى المحاولة مرة أخرى بعد قليل'
          : 'Could not validate account security at this time, please try again shortly.'
      };
    }

    try {
      const newSessionId = generateSessionId();
      localStorage.setItem('mazad_session_id', newSessionId);
      localStorage.setItem('mazad_last_login_time', String(Date.now()));
      const dev = getDeviceInfo();
      const ip = await fetchIP();

      const userCredential = await createUserWithEmailAndPassword(auth, cleanEmail, password);
      const user = userCredential.user;
      
      await updateProfile(user, { displayName: cleanName });
      
      const userRef = doc(db, 'users', user.uid);
      const freshUserDoc = {
        id: user.uid,
        uid: user.uid,
        name: cleanName,
        normalizedName: cleanName.toLowerCase().trim(),
        email: cleanEmail,
        avatar: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=150&q=80',
        role: 'user',
        accountStatus: 'active',
        phoneNumber: cleanPhone || '',
        phone: cleanPhone || '',
        normalizedPhone: cleanPhone.replace(/\D/g, ''),
        city: '',
        createdAt: new Date().toISOString(),
        onboardingCompleted: false,
        shownHints: {},
        sessionId: newSessionId,
        lastLoginAt: new Date().toISOString(),
        deviceInfo: `${dev.browser} on ${dev.platform} (${dev.deviceType})`,
        platform: dev.platform,
        browser: dev.browser,
        deviceType: dev.deviceType,
        appVersion: dev.appVersion,
        lastLoginIP: ip,
        lastSeen: new Date().toISOString()
      };
      await setDoc(userRef, freshUserDoc);

      // Track successful registration in Analytics
      await logAnalyticsEvent('user_registration', user.uid, cleanEmail, {
        method: 'email_password',
        name: cleanName
      });

      return { 
        success: true, 
        message: language === 'ar' 
          ? 'تم إنشاء الحساب وتسجيل الدخول بنجاح!' 
          : 'Account registered successfully!' 
      };
    } catch (error: any) {
      console.error("Firebase auth registration error:", error);
      let errorMsg = error.message;
      if (error.code === 'auth/email-already-in-use') {
        errorMsg = language === 'ar' 
          ? 'عذراً، هذا البريد الإلكتروني مسجل بالفعل.' 
          : 'Sorry, this email is already registered.';
      } else if (error.code === 'auth/weak-password') {
        errorMsg = language === 'ar' 
          ? 'يجب أن تكون كلمة المرور 6 أحرف على الأقل.' 
          : 'Password must be at least 6 characters.';
      } else if (error.code === 'auth/invalid-email') {
        errorMsg = language === 'ar' 
          ? 'البريد الإلكتروني المكتوب غير صالح.' 
          : 'The email address is invalid.';
      } else {
        errorMsg = error.message || errorMsg;
      }
      return { success: false, message: errorMsg };
    }
  }, [language]);

  // General Notification Handler
  const addNotification = useCallback((
    title: string,
    description: string,
    type: Notification['type'],
    priority?: 'high' | 'medium' | 'low',
    auctionId?: string
  ) => {
    // 1. Determine group/type mapping
    let inferredType: Notification['type'] = type;
    
    // Explicit map standard legacy types to the 7 clean groups.
    // 'outbid' intentionally survives as-is: it is one of the four
    // bidder-relevant alert kinds (Wave D, spec §5) and must stay
    // distinguishable from generic 'bid' chatter at display time.
    if (type === 'refund') inferredType = 'loss';
    if (type === 'verify') inferredType = 'subscription';
    if (type === 'alert') inferredType = 'admin';

    const lowerTitle = title.toLowerCase();
    const lowerDesc = description.toLowerCase();

    // Contextual type mapping — outbid first so it never collapses into 'bid'
    if (
      lowerTitle.includes('outbid') ||
      lowerTitle.includes('تجاوز عرضك')
    ) {
      inferredType = 'outbid';
    } else if (
      lowerTitle.includes('مزايدة مضادة') ||
      lowerTitle.includes('خسارة مزايدة') ||
      lowerTitle.includes('winning') ||
      lowerTitle.includes('متقدم') ||
      lowerTitle.includes('bid') ||
      lowerTitle.includes('مزايدة')
    ) {
      inferredType = 'bid';
    } else if (
      lowerTitle.includes('won') || 
      lowerTitle.includes('فوز') || 
      lowerTitle.includes('ربحت')
    ) {
      inferredType = 'win';
    } else if (
      lowerTitle.includes('lost') || 
      lowerTitle.includes('خسارة') || 
      lowerTitle.includes('لم تفز') ||
      lowerTitle.includes('refund') ||
      lowerTitle.includes('استرداد')
    ) {
      inferredType = 'loss';
    } else if (
      lowerTitle.includes('wallet') || 
      lowerTitle.includes('محفظة') || 
      lowerTitle.includes('top-up') || 
      lowerTitle.includes('شحن') ||
      lowerTitle.includes('cliq') || 
      lowerTitle.includes('كليك') ||
      lowerTitle.includes('deposit') || 
      lowerTitle.includes('إيداع') ||
      lowerTitle.includes('withdrawal') || 
      lowerTitle.includes('سحب')
    ) {
      inferredType = 'wallet';
    } else if (
      lowerTitle.includes('order') || 
      lowerTitle.includes('طلب') || 
      lowerTitle.includes('shipment') || 
      lowerTitle.includes('شحن') ||
      lowerTitle.includes('waybill') || 
      lowerTitle.includes('بوليصة') ||
      lowerTitle.includes('delivery') || 
      lowerTitle.includes('توصيل')
    ) {
      inferredType = 'order';
    } else if (
      lowerTitle.includes('subscription') || 
      lowerTitle.includes('اشتراك') || 
      lowerTitle.includes('pass') || 
      lowerTitle.includes('بطاقة')
    ) {
      inferredType = 'subscription';
    } else if (
      lowerTitle.includes('admin') || 
      lowerTitle.includes('إدارة') || 
      lowerTitle.includes('system') || 
      lowerTitle.includes('نظام') ||
      lowerTitle.includes('maintenance') || 
      lowerTitle.includes('صيانة')
    ) {
      inferredType = 'admin';
    }

    // 2. Set default priority levels based on requirement
    let inferredPriority: 'high' | 'medium' | 'low' = priority || 'low';
    
    // Someone outbid you -> High
    if (lowerTitle.includes('outbid') || lowerTitle.includes('تجاوز عرضك')) {
      inferredPriority = 'high';
    }
    // You are winning -> Medium
    else if (lowerTitle.includes('winning') || lowerTitle.includes('متقدم')) {
      inferredPriority = 'medium';
    }
    // Auction ended -> Medium
    else if (lowerTitle.includes('ended') || lowerTitle.includes('انتهى المزاد') || lowerTitle.includes('انتهاء')) {
      inferredPriority = 'medium';
    }
    // You won -> High
    else if (lowerTitle.includes('won') || lowerTitle.includes('فوز') || lowerTitle.includes('مبروك')) {
      inferredPriority = 'high';
    }
    // You lost and money returned -> High
    else if (lowerTitle.includes('lost') || (lowerTitle.includes('outbid') && (lowerTitle.includes('returned') || lowerTitle.includes('إرجاع')))) {
      inferredPriority = 'high';
    }
    // Wallet top-up approved -> High
    else if (lowerTitle.includes('top-up approved') || lowerTitle.includes('تمت الموافقة على الشحن') || (lowerTitle.includes('deposit') && lowerTitle.includes('approved'))) {
      inferredPriority = 'high';
    }
    // Withdrawal request under review -> Medium
    else if (lowerTitle.includes('withdrawal') || lowerTitle.includes('سحب')) {
      inferredPriority = 'medium';
    }
    // Subscription approved / expired -> High
    else if (lowerTitle.includes('subscription') || lowerTitle.includes('اشتراك')) {
      if (lowerTitle.includes('approved') || lowerTitle.includes('مقبول') || lowerTitle.includes('expired') || lowerTitle.includes('منتهي') || lowerTitle.includes('تفعيل')) {
        inferredPriority = 'high';
      } else {
        inferredPriority = 'medium';
      }
    }
    // Default fallback based on type
    else if (inferredType === 'win' || inferredType === 'loss' || inferredType === 'outbid') {
      inferredPriority = 'high';
    } else if (inferredType === 'bid' || inferredType === 'order' || inferredType === 'wallet') {
      inferredPriority = 'medium';
    }

    const newNotif: Notification = {
      id: `notif-${Date.now()}-${Math.random()}`,
      userId: 'user-current',
      title,
      description,
      type: inferredType,
      priority: inferredPriority,
      timestamp: Date.now(),
      read: false,
      auctionId
    };

    // Duplicate Prevention: Keep only the latest outbid alert for the same auction title
    let auctionTitle: string | null = null;
    const match = description.match(/"([^"]+)"/);
    if (match) {
      auctionTitle = match[1];
    }

    setNotifications(prev => {
      let filtered = prev;
      if ((inferredType === 'bid' || inferredType === 'outbid') && auctionTitle) {
        filtered = prev.filter(n => {
          if (n.type !== inferredType) return true;
          const prevMatch = n.description.match(/"([^"]+)"/);
          const prevTitle = prevMatch ? prevMatch[1] : null;
          return prevTitle !== auctionTitle;
        });
      }
      return [newNotif, ...filtered];
    });

    // Native HTML5 Web Push Notification Fallback
    if (featureFlags.enablePushNotifications && 'Notification' in window && window.Notification.permission === 'granted') {
      try {
        new window.Notification(title, {
          body: description,
          icon: '/icon-192.png',
          tag: newNotif.id,
          silent: false
        });
      } catch (e) {
        console.warn('Native push notification error: ', e);
      }
    }
  }, [featureFlags.enablePushNotifications]);

  // --- Cross-user notification delivery (bell) ---
  // Notifications written to /notifications by ANOTHER session — e.g. the
  // admin approving/rejecting a seller's listing — must reach THIS user's
  // bell. addNotification is session-local (localStorage), so we merge the
  // user's Firestore notification docs into the bell state, mapped to the
  // device language. Locally-removed ones are remembered in localStorage so
  // the live subscription doesn't resurrect them.
  // (firestoreNotifIdsRef is declared next to the notifications state so
  // logout() can purge it — shared-device privacy.)
  const notificationsStateRef = useRef<Notification[]>(notifications);
  useEffect(() => {
    notificationsStateRef.current = notifications;
  }, [notifications]);

  // Hydrate the bell from the CURRENT user's uid-keyed store on sign-in.
  useEffect(() => {
    if (!isAuthenticated || !currentUser?.id || currentUser.id === DEFAULT_UNAUTHENTICATED_USER.id) {
      notifStoreUidRef.current = null;
      return;
    }
    if (notifStoreUidRef.current === currentUser.id) return;
    let hydrated: Notification[] = INITIAL_NOTIFICATIONS;
    try {
      const saved = localStorage.getItem(`${NOTIF_STORE_PREFIX}${currentUser.id}`);
      if (saved) hydrated = JSON.parse(saved);
    } catch { /* corrupted entry — start clean */ }
    notifStoreUidRef.current = currentUser.id;
    setNotifications(hydrated);
  }, [isAuthenticated, currentUser?.id]);

  // Persist the bell PER-USER (uid-keyed) — never under a shared key.
  useEffect(() => {
    if (!isAuthenticated || !currentUser?.id || notifStoreUidRef.current !== currentUser.id) return;
    try {
      localStorage.setItem(`${NOTIF_STORE_PREFIX}${currentUser.id}`, JSON.stringify(notifications));
    } catch { /* storage full/unavailable — bell simply won't persist */ }
  }, [notifications, isAuthenticated, currentUser?.id]);

  useEffect(() => {
    if (!isAuthenticated || !currentUser?.id) return;

    // uid-keyed for the same reason as the bell store: dismissals must not
    // bleed across accounts on a shared device.
    const DISMISSED_KEY = `${DISMISSED_STORE_PREFIX}${currentUser.id}`;
    const readDismissed = (): Set<string> => {
      try {
        return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]'));
      } catch {
        return new Set();
      }
    };
    const persistDismissed = (s: Set<string>) => {
      try {
        localStorage.setItem(DISMISSED_KEY, JSON.stringify(Array.from(s).slice(-300)));
      } catch { /* storage full/unavailable — resurrection is tolerable */ }
    };

    // Bounded server-side to the newest 50 (backed by the composite index on
    // (userId ASC, timestamp DESC) in firestore.indexes.json) so a long-lived
    // account never re-reads its entire notification history on every app open.
    const q = query(
      collection(db, 'notifications'),
      where('userId', '==', currentUser.id),
      orderBy('timestamp', 'desc'),
      limit(50)
    );
    const unsub = onSnapshot(q, (snap) => {
      const dismissed = readDismissed();
      const currentIds = new Set(notificationsStateRef.current.map(n => n.id));
      let dismissedChanged = false;
      const incoming: Notification[] = [];

      snap.forEach(d => {
        if (dismissed.has(d.id)) return;
        if (firestoreNotifIdsRef.current.has(d.id) && !currentIds.has(d.id)) {
          // Was merged earlier this session and the user removed it — don't resurrect.
          dismissed.add(d.id);
          dismissedChanged = true;
          return;
        }
        const data: any = d.data();
        firestoreNotifIdsRef.current.add(d.id);
        const ts = typeof data.timestamp === 'number'
          ? data.timestamp
          : (data.timestamp?.seconds ? data.timestamp.seconds * 1000 : Date.now());
        // Resolve content in the recipient's language, falling back to the other
        // language when a field is missing (so an Arabic-only doc still shows for
        // an English user, and vice versa) rather than defaulting to Arabic.
        const { title, body } = resolveNotificationContent(data, language);
        // Drop docs with no resolvable content — they'd render as blank bell rows.
        if (!title && !body) return;
        incoming.push({
          id: d.id,
          userId: data.userId,
          title,
          description: body,
          type: data.type || 'info',
          priority: data.priority || 'medium',
          timestamp: ts,
          read: !!data.read,
          auctionId: data.auctionId
        });
      });

      if (dismissedChanged) persistDismissed(dismissed);
      if (incoming.length === 0) return;

      setNotifications(prev => {
        const incomingIds = new Set(incoming.map(n => n.id));
        const rest = prev.filter(n => !incomingIds.has(n.id));
        // Query is already bounded to the newest 50 server-side; the sort +
        // slice here are belt-and-suspenders across the merge with prior state.
        return [...incoming, ...rest].sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
      });
    }, (err: any) => {
      console.warn('Bell notifications subscription failed:', err?.code, err?.message);
    });

    return () => unsub();
  }, [isAuthenticated, currentUser?.id, language]);

  const markAsRead = useCallback((id: string) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    // Firestore-delivered notifications keep read-state on the server so the
    // live subscription (and other devices) don't flip them back to unread.
    if (firestoreNotifIdsRef.current.has(id)) {
      updateDoc(doc(db, 'notifications', id), { read: true }).catch(() => { /* non-fatal */ });
    }
  }, []);

  const markAllAsRead = useCallback(() => {
    notificationsStateRef.current.forEach(n => {
      if (!n.read && firestoreNotifIdsRef.current.has(n.id)) {
        updateDoc(doc(db, 'notifications', n.id), { read: true }).catch(() => { /* non-fatal */ });
      }
    });
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  }, []);

  const logSystemHealth = useCallback(async (type: 'error' | 'payment_fail' | 'bid_fail' | 'wallet_fail', title: string, details: string) => {
    try {
      await addDoc(collection(db, 'system_health'), {
        type,
        title,
        details,
        userId: currentUser?.id || 'anonymous',
        userEmail: currentUser?.email || 'anonymous',
        timestamp: new Date().toISOString(),
        browser: navigator.userAgent
      });
    } catch (err) {
      console.warn("Failed to write to system_health collection:", err);
    }
  }, [currentUser]);

  const subscribeUser = useCallback(async (price: number, paymentProofImage?: string, transferFullName?: string, transferPhone?: string, planId?: string): Promise<boolean> => {
    // Prefer the explicit plan id from the UI. The price-based fallback is a
    // safety net only — and it must NOT re-introduce the Wave C bug where the
    // 4 JD tier fell through to 'annual' (365 days). Tiers: 1 JD/mo · 4 JD/6mo · 7 JD/yr.
    const plan = planId || (price === 1 ? 'monthly' : price === 7 ? 'annual' : 'semiannual');

    if (!currentUser) {
      const loginTitle = language === 'ar' ? '❌ خطأ' : '❌ Error';
      const loginMsg = language === 'ar' ? 'يجب تسجيل الدخول أولاً.' : 'You must be logged in first.';
      addNotification(loginTitle, loginMsg, 'alert');
      showToast({ title: loginTitle, message: loginMsg, type: 'warn' });
      return false;
    }

    if (!featureFlags.enableSubscriptions) {
      const disabledTitle = language === 'ar' ? '⚠️ الاشتراكات معطلة' : '⚠️ Subscriptions Disabled';
      const disabledMsg = language === 'ar' ? 'عمليات ترقية الاشتراكات معطلة مؤقتاً للصيانة المجدولة.' : 'Subscription upgrades are temporarily disabled for system maintenance.';
      addNotification(disabledTitle, disabledMsg, 'alert');
      showToast({ title: disabledTitle, message: disabledMsg, type: 'warn' });
      return false;
    }

    try {
      let downloadURL = '';

      if (paymentProofImage && paymentProofImage.startsWith('data:')) {
        try {
          // Upload payment proof screenshot directly to Firebase Storage inside payment-proofs/{userId}/{timestamp-fileName}
          const { getStorage, ref, uploadString, getDownloadURL } = await import('firebase/storage');
          const storage = getStorage();
          const fileName = `${Date.now()}_proof.png`;
          const proofRef = ref(storage, `payment-proofs/${currentUser.id}/${fileName}`);
          
          const uploadResult = await uploadString(proofRef, paymentProofImage, 'data_url');
          downloadURL = await getDownloadURL(uploadResult.ref);
        } catch (storageErr: any) {
          console.error("Firebase Storage write failure during payment proof upload. Code:", storageErr.code, "Message:", storageErr.message);
          const proofFailTitle = language === 'ar' ? '❌ فشل رفع الإثبات' : '❌ Storage Upload Failed';
          const proofFailMsg = language === 'ar' ? `لم نتمكن من رفع صورة إثبات الدفع. رمز الخطأ: ${storageErr.code || 'unknown'}` : `Failed to upload payment proof. Code: ${storageErr.code || 'unknown'}`;
          addNotification(proofFailTitle, proofFailMsg, 'alert');
          showToast({ title: proofFailTitle, message: proofFailMsg, type: 'warn' });
          await logSystemHealth('payment_fail', 'Subscription Proof Upload Error', `Amount: ${price} JOD, Name: ${transferFullName || ''}, Error: ${storageErr.message || String(storageErr)}`);
          return false;
        }
      } else {
        downloadURL = paymentProofImage || '';
      }

      // Single write path: the `requestSubscription` callable is the sole creator of the
      // subscriptionRequests doc (server-authoritative; it also sets the user to pending).
      // A failure here is a REAL failure — surface it, don't swallow it.
      const requestSubCallable = await getCallableFunction<{
        price: number;
        plan: string;
        paymentProofUrl: string;
        paymentProofImage: string;
        transferFullName: string;
        transferPhone: string;
       }, { success: boolean; message: string }>('requestSubscription');

      await requestSubCallable({
        price,
        plan,
        paymentProofUrl: downloadURL,
        paymentProofImage: downloadURL,
        transferFullName: transferFullName || '',
        transferPhone: transferPhone || ''
      });

      // Funnel metric — fire-and-forget (service handles its own errors)
      logAnalyticsEvent('membership_submitted', currentUser.id, currentUser.email, {
        plan,
        price
      });

      // E4 — record the Auction Rules acceptance captured at the pay-to-bid gate.
      // Owner-writable fields on the user's own doc (NOT subscription-grant fields,
      // so no rules change is required). Non-fatal: a failure here must never fail
      // the subscribe flow — the request itself already succeeded above.
      try {
        const { RULES_VERSION } = await import('../content/auctionRules');
        await updateDoc(doc(db, 'users', currentUser.id), {
          acceptedAuctionRulesAt: Date.now(),
          acceptedAuctionRulesVersion: RULES_VERSION,
        });
      } catch (rulesErr) {
        console.warn('[subscribeUser] Auction Rules acceptance persist failed (non-fatal):', rulesErr);
      }

      // Mirror the server helper (userStatusForSubscriptionRequest): an already-
      // active member submitting an UPGRADE must NOT be downgraded to 'pending'
      // — bidding is gated on this LOCAL subscriptionStatus, so flipping it would
      // revoke their access until the Firestore listener re-synced. Replicated
      // inline because that helper is a Cloud Function (CJS) module and cannot be
      // imported into client src/ across the ESM boundary.
      setCurrentUser(prev => {
        if (!prev) return prev;
        const keepActive = prev.subscriptionStatus === 'active';
        return {
          ...prev,
          subscriptionStatus: keepActive ? ('active' as const) : ('pending' as const),
          subscriptionExpiry: keepActive ? prev.subscriptionExpiry : null,
          paymentProofImage: downloadURL,
          transferFullName,
          transferPhone
        };
      });

      setUsers(prev => prev.map(u => {
        if (currentUser && u.id === currentUser.id) {
          // Same server-mirroring rule as above: an active member upgrading keeps
          // 'active' + their existing expiry so bidding (gated on local status)
          // isn't revoked; everyone else flips to pending with null expiry.
          const keepActive = u.subscriptionStatus === 'active';
          return {
            ...u,
            subscriptionStatus: keepActive ? ('active' as const) : ('pending' as const),
            subscriptionExpiry: keepActive ? u.subscriptionExpiry : null,
            paymentProofImage: downloadURL,
            transferFullName,
            transferPhone
          };
        }
        return u;
      }));

      setShowSubscriptionPrompt(false);
      addNotification(
        language === 'ar' ? '⏳ الاشتراك قيد المراجعة' : '⏳ Subscription Pending',
        language === 'ar'
          ? 'شكراً! تم استلام طلب اشتراكك. سيتم مراجعته من الإدارة وتفعيله خلال دقائق.'
          : 'Thanks! We received your subscription request. It will be reviewed and activated within minutes.',
        'verify'
      );
      return true;
    } catch (error: any) {
      console.error("[requestSubscription] Overall process failure. Code:", error.code, "Message:", error.message, "error:", error);
      await logSystemHealth('payment_fail', 'Subscription Request Error', `Amount: ${price} JOD, Name: ${transferFullName || ''}, Error: ${error.message || String(error)}`);
      const subFailTitle = language === 'ar' ? '❌ لم يتم إرسال الطلب' : '❌ Request Not Sent';
      const subFailMsg = language === 'ar'
        ? 'تعذّر إرسال طلب الاشتراك — تحقق من اتصالك وحاول مرة أخرى.'
        : 'We could not submit your subscription request — check your connection and try again.';
      addNotification(subFailTitle, subFailMsg, 'alert');
      showToast({ title: subFailTitle, message: subFailMsg, type: 'warn' });
      return false;
    }
  }, [currentUser, addNotification, showToast, logSystemHealth, featureFlags, language]);

  // BIDDING ENGINE BUSINESS LOGIC (CRITICAL RULES)
  const placeBid = useCallback(async (auctionId: string, amount: number): Promise<{ success: boolean; message: string }> => {
    // 0. Feature flag check
    if (!featureFlags.enableLiveAuctions) {
      return { 
        success: false, 
        message: language === 'ar' 
          ? '⚠️ المزايدة على المعروضات معطلة مؤقتاً للصيانة المجدولة.' 
          : '🚫 Live Bidding is temporarily disabled for scheduled maintenance.' 
      };
    }

    const now = Date.now();

    // 0.5. Serving a server-issued cooldown — don't spend a round-trip on a
    // refusal we already know the answer to. Purely an optimisation: if this ref
    // is cleared (reload, devtools) the request goes through and the SERVER
    // refuses it, which is where the limit actually lives.
    if (bidCooldownUntilRef.current > now) {
      return {
        success: false,
        message: rateLimitMessage(bidCooldownUntilRef.current, now, language === 'ar'),
      };
    }

    // 1. Double check blocking status. E2: an EXPIRED cooldown no longer blocks
    // (matches the server placeBid gate); a permanent/active block still does and
    // opens the BanNoticeModal instead of a terse toast.
    if (isEffectivelyBlocked(currentUser, now)) {
      setShowBanNotice(true);
      return { success: false, message: '🚫 Account restricted. Bidding disabled.' };
    }
    // DERIVED, not the stored flag. The server's placeBid gate compares the
    // expiry to the clock, so testing the latch here waved a lapsed member
    // through the client check only to have the server refuse them a
    // round-trip later. Same predicate both sides now.
    if (!isActiveMember(currentUser, serverNow())) {
      setShowSubscriptionPrompt(true);
      return {
        success: false,
        message: language === 'ar'
          ? 'المزايدة تتطلب عضوية — انضم بـ ١ دينار فقط'
          : 'Membership required to bid — join for 1 JD'
      };
    }

    // 1.5. Unreviewed-order bid gate (client-side v1): an unreviewed completed
    // order blocks the next bid — open the review prompt instead of calling the server.
    if (pendingReviewOrder) {
      addNotification(
        language === 'ar' ? '⭐ قيّم مشترياتك السابقة للمتابعة' : '⭐ Rate your previous purchases to continue',
        language === 'ar'
          ? 'لديك طلب مكتمل بانتظار تقييمك — قيّمه (١٠ ثوانٍ) ثم تابع المزايدة.'
          : 'A completed order is waiting for your rating — rate it (10 seconds), then keep bidding.',
        'info'
      );
      setReviewPromptOrderId(pendingReviewOrder.id);
      return {
        success: false,
        message: language === 'ar'
          ? 'قيّم مشترياتك السابقة للمتابعة'
          : 'Rate your previous purchases to continue'
      };
    }

    // 2. Bid Spam & Timing Protection (Min 1.5 seconds cooldown between bids)
    const lastBidTime = lastBidTimestampRef.current;
    if (now - lastBidTime < 1500) {
      // PF6: fire-and-forget — an observability write must never add a round-trip
      // to the user's rejection. Expected outcome, so it is NOT a health incident.
      void logAnalyticsEvent('bid_spam_blocked', currentUser.id, currentUser.email, {
        auctionId,
        bidAmount: amount,
        timeSinceLastBidMs: now - lastBidTime,
        type: 'bot_spam_protection'
      }).catch(() => {});
      return {
        success: false,
        message: language === 'ar'
          ? '⚠️ تم حظر المزايدة السريعة! يرجى الانتظار 1.5 ثانية بين المزايدات لحماية استقرار المزاد.'
          : '🚫 Spam Protection: Please wait at least 1.5 seconds between bids.'
      };
    }

    // 3. Sliding Window Rate Limiting (Max 10 bids per 60 seconds)
    const updatedWindow = bidTimestampsRef.current.filter(ts => now - ts < 60000);
    if (updatedWindow.length >= 10) {
      // PF6: fire-and-forget — see spam-block note above. Expected outcome.
      void logAnalyticsEvent('rate_limit_triggered', currentUser.id, currentUser.email, {
        auctionId,
        windowSizeSec: 60,
        requestCount: updatedWindow.length,
        type: 'bidding_rate_limit'
      }).catch(() => {});
      return {
        success: false,
        message: language === 'ar'
          ? '⚠️ تم تجاوز حد المزايدات المسموح به (10 مزايدات في الدقيقة). يرجى الانتظار دقيقة واحدة.'
          : '🚫 Rate Limit Exceeded: Max 10 bids per minute. Please pause for a moment.'
      };
    }

    try {
      const placeBidCallable = await getCallableFunction<{ auctionId: string; amount: number }, { success: boolean; message: string; code?: string; retryAfterMs?: number }>('placeBid');
      const result = await placeBidCallable({ auctionId, amount });
      if (result.data.success) {
        // Update security refs
        lastBidTimestampRef.current = Date.now();
        bidTimestampsRef.current = [...updatedWindow, Date.now()];
        // A bid the server accepted proves no cooldown is in force — clear any
        // stale local deadline (e.g. one whose window elapsed while idle).
        if (bidCooldownUntilRef.current !== 0) {
          bidCooldownUntilRef.current = 0;
          setBidCooldownUntil(0);
        }

        // Record analytical conversion metrics — fire-and-forget (service
        // handles its own errors). Wave 3 metric hygiene: an admin bidding on
        // a SIMULATED lot must not write funnel events (analytics_events has
        // no isSimulated flag, so hygiene here is skip-at-write, not
        // filter-at-read).
        const isSimTarget = auctionsStateRef.current.find(a => a.id === auctionId)?.isSimulated === true;
        if (!isSimTarget) {
          // Meta Pixel: the SERVER accepted this bid — we are inside
          // `if (result.data.success)`, past the callable, so this counts a
          // completed action rather than an attempt. Behind the same
          // isSimulated gate as the funnel events below: an admin testing on a
          // simulated lot must not train ad delivery on fake conversions.
          trackBid(auctionId, amount);
          logAnalyticsEvent('bid_placed', currentUser.id, currentUser.email, {
            auctionId,
            amount
          });
          if (!isFirstBidDone()) {
            logAnalyticsEvent('first_bid', currentUser.id, currentUser.email, {
              auctionId,
              amount
            });
          }
        }
        markFirstBidDone(); // idempotent — layouts also call this after a successful bid

        addNotification(
          '🏆 Winning Bid Placed',
          language === 'ar'
            ? 'تم تسجيل مزايدتك بنجاح — أنت الأعلى الآن!'
            : "Bid placed — you're the highest bidder!",
          'win'
        );
      } else {
        // PF6: only genuinely-unexpected rejections are health incidents; routine
        // "no" answers (below-min, membership, funds…) are not. Fire-and-forget.
        if (!isExpectedBidFailure(result.data.message)) {
          void logSystemHealth('bid_fail', 'Bid Placement Failed', `Auction: ${auctionId}, Amount: ${amount} JOD, Message: ${result.data.message}`).catch(() => {});
        }
        if (result.data.message === 'MEMBERSHIP_REQUIRED') {
          setShowSubscriptionPrompt(true);
          return {
            success: false,
            message: language === 'ar'
              ? 'المزايدة تتطلب عضوية — انضم بـ ١ دينار فقط'
              : 'Membership required to bid — join for 1 JD'
          };
        }
        // SERVER rate limit. Record the deadline so the UI can hold the button
        // down for the cooldown instead of firing refusals the server will
        // reject anyway. This ref is a courtesy, not a control: clearing it
        // changes nothing, the server refuses regardless.
        if (isRateLimited(result.data)) {
          const until = cooldownUntil(result.data, Date.now());
          bidCooldownUntilRef.current = until;
          setBidCooldownUntil(until);
          const msg = rateLimitMessage(until, Date.now(), language === 'ar');
          showToast({ title: language === 'ar' ? '⏳ مهلة مؤقتة' : '⏳ Cooldown', message: msg, type: 'warn' });
          return { success: false, message: msg };
        }
      }
      return {
        success: result.data.success,
        message: result.data.message
      };
    } catch (error: any) {
      const errorMsg = error.message || String(error);
      const errorCode = error.code || '';

      // Server-side transaction contention/deadline on the hot auction doc →
      // the bid didn't fail on the merits, the price just moved or the room is
      // busy. Surface a FRIENDLY, retriable message (not a scary generic error)
      // and let the user immediately re-bid — the next confirm recomputes the
      // min from live state. Distinct from the client-side "price moved" confirm
      // reprompt, which handles a rival outbid DURING the confirm window.
      const isContention =
        errorCode === 'functions/aborted' ||
        errorCode === 'aborted' ||
        errorMsg.includes('PRICE_MOVED_RETRY');
      if (isContention) {
        console.warn("Cloud function placeBid contention — retriable:", errorMsg);
        return {
          success: false,
          message: language === 'ar'
            ? 'السعر تغيّر أو الضغط عالي — حاول مرة أخرى'
            : 'Price moved or high demand — try again'
        };
      }

      const isExpectedError = isExpectedBidFailure(errorMsg);

      if (isExpectedError) {
        console.warn("Cloud function placeBid expected warning:", errorMsg);
      } else {
        console.error("Cloud function placeBid error:", error);
      }
      // PF6: don't log EXPECTED rejections (ended/Minimum/Funds/subscription…) as
      // health incidents — a normal bid war would flood system_health. Only
      // genuinely-unexpected errors are logged, fire-and-forget so the rejection
      // returns without an extra round-trip.
      if (!isExpectedError) {
        void logSystemHealth('bid_fail', 'Bid Placement Error', `Auction: ${auctionId}, Amount: ${amount} JOD, Error: ${errorMsg}`).catch(() => {});
      }
      return {
        success: false,
        message: errorMsg || 'Bidding failed.'
      };
    }
  }, [currentUser, language, addNotification, logSystemHealth, featureFlags, pendingReviewOrder]);

  // Wave 2b: customer CliQ top-up entry (triggerCliQTopUp -> requestTopUp)
  // was removed from the client — bidding is free (pay-after-win), so there
  // is nothing to pre-fund. The `requestTopUp` Cloud Function itself stays.

  const requestWithdrawal = useCallback(async (amount: number, method: string, accountDetails: any) => {
    try {
      const withdrawalCallable = await getCallableFunction<
        { amount: number; method: string; accountDetails: any },
        { success: boolean; message: string }
      >('requestWithdrawal');
      const result = await withdrawalCallable({ amount, method, accountDetails });
      if (result.data.success) {
        addNotification(
          language === 'ar' ? '💸 تم تقديم طلب السحب' : '💸 Withdrawal Request Logged',
          result.data.message || (language === 'ar' ? 'تم تسجيل طلب السحب بنجاح وهو قيد المراجعة.' : 'Withdrawal request registered successfully. Pending review.'),
          'info'
        );
        return { success: true, message: result.data.message };
      }
      return { success: false, message: result.data.message || 'Failed to request withdrawal.' };
    } catch (error: any) {
      console.error("Cloud function requestWithdrawal failed:", error);
      const withdrawFailTitle = language === 'ar' ? '❌ خطأ في تقديم طلب السحب' : '❌ Withdrawal Error';
      const withdrawFailMsg = error.message || (language === 'ar' ? 'فشل تقديم طلب السحب.' : 'Failed to request withdrawal.');
      addNotification(withdrawFailTitle, withdrawFailMsg, 'alert');
      showToast({ title: withdrawFailTitle, message: withdrawFailMsg, type: 'warn' });
      return { success: false, message: error.message || 'Failed to request withdrawal.' };
    }
  }, [currentUser, addNotification, showToast, language]);

  // E3 Slice C — below-reserve near-miss callables. Thin wrappers over the
  // money-path Cloud Functions (mirroring requestWithdrawal / placeBid): all
  // validation, order creation and escrow status live server-side.
  const acceptBelowReserve = useCallback(async (auctionId: string) => {
    try {
      const callable = await getCallableFunction<{ auctionId: string }, { success: boolean; message: string; alreadyAccepted?: boolean }>('acceptBelowReserve');
      const result = await callable({ auctionId });
      if (result.data?.success) {
        addNotification(
          language === 'ar' ? '✅ تم قبول العرض' : '✅ Offer Accepted',
          result.data.message || (language === 'ar' ? 'تم قبول العرض. بانتظار تأكيد المشتري.' : 'Offer accepted. Awaiting buyer confirmation.'),
          'info'
        );
        return { success: true, message: result.data.message };
      }
      return { success: false, message: result.data?.message || 'Failed to accept offer.' };
    } catch (error: any) {
      console.error('Cloud function acceptBelowReserve failed:', error);
      const msg = error.message || (language === 'ar' ? 'تعذر قبول العرض.' : 'Failed to accept offer.');
      showToast({ title: language === 'ar' ? '❌ خطأ' : '❌ Error', message: msg, type: 'warn' });
      return { success: false, message: msg };
    }
  }, [addNotification, showToast, language]);

  // Seller-side REJECT. Mirrors acceptBelowReserve exactly; every permission
  // check and the terminal status live server-side in rejectBelowReserve.
  const rejectBelowReserve = useCallback(async (auctionId: string) => {
    try {
      const callable = await getCallableFunction<{ auctionId: string }, { success: boolean; message: string; alreadyRejected?: boolean; offerStatus?: string }>('rejectBelowReserve');
      const result = await callable({ auctionId });
      if (result.data?.success) {
        addNotification(
          language === 'ar' ? 'تم رفض العرض' : 'Offer Rejected',
          result.data.message || (language === 'ar' ? 'تم رفض العرض. يمكنك إعادة إدراج القطعة.' : 'Offer rejected. You can relist the item.'),
          'info'
        );
        return { success: true, message: result.data.message };
      }
      return { success: false, message: result.data?.message || 'Failed to reject offer.' };
    } catch (error: any) {
      console.error('Cloud function rejectBelowReserve failed:', error);
      const msg = error.message || (language === 'ar' ? 'تعذر رفض العرض.' : 'Failed to reject offer.');
      showToast({ title: language === 'ar' ? '❌ خطأ' : '❌ Error', message: msg, type: 'warn' });
      return { success: false, message: msg };
    }
  }, [addNotification, showToast, language]);

  const confirmBelowReserve = useCallback(async (auctionId: string) => {
    try {
      const callable = await getCallableFunction<{ auctionId: string }, { success: boolean; message: string; alreadyConfirmed?: boolean }>('confirmBelowReserve');
      const result = await callable({ auctionId });
      if (result.data?.success) {
        addNotification(
          language === 'ar' ? '🛒 تم تأكيد الشراء' : '🛒 Purchase Confirmed',
          result.data.message || (language === 'ar' ? 'تم تأكيد الشراء. يرجى إتمام الدفع.' : 'Purchase confirmed. Please complete payment.'),
          'info'
        );
        return { success: true, message: result.data.message };
      }
      return { success: false, message: result.data?.message || 'Failed to confirm purchase.' };
    } catch (error: any) {
      console.error('Cloud function confirmBelowReserve failed:', error);
      const msg = error.message || (language === 'ar' ? 'تعذر تأكيد الشراء.' : 'Failed to confirm purchase.');
      showToast({ title: language === 'ar' ? '❌ خطأ' : '❌ Error', message: msg, type: 'warn' });
      return { success: false, message: msg };
    }
  }, [addNotification, showToast, language]);

  const declineBelowReserve = useCallback(async (auctionId: string) => {
    try {
      const callable = await getCallableFunction<{ auctionId: string }, { success: boolean; message: string; alreadyDeclined?: boolean }>('declineBelowReserve');
      const result = await callable({ auctionId });
      if (result.data?.success) {
        addNotification(
          language === 'ar' ? 'تم رفض العرض' : 'Offer Declined',
          result.data.message || (language === 'ar' ? 'تم رفض العرض.' : 'Offer declined.'),
          'info'
        );
        return { success: true, message: result.data.message };
      }
      return { success: false, message: result.data?.message || 'Failed to decline offer.' };
    } catch (error: any) {
      console.error('Cloud function declineBelowReserve failed:', error);
      const msg = error.message || (language === 'ar' ? 'تعذر رفض العرض.' : 'Failed to decline offer.');
      showToast({ title: language === 'ar' ? '❌ خطأ' : '❌ Error', message: msg, type: 'warn' });
      return { success: false, message: msg };
    }
  }, [addNotification, showToast, language]);

  /**
   * Second Chance Offer — seller_accept / buyer_accept / decline on a lot whose
   * winner failed to pay. Thin wrapper over `respondToSecondChance`, mirroring
   * the below-reserve trio above: every permission check, the money and the
   * order creation live server-side in functions/secondChanceRespond.js.
   */
  const respondToSecondChance = useCallback(async (auctionId: string, action: SecondChanceAction) => {
    try {
      const callable = await getCallableFunction<
        { auctionId: string; action: SecondChanceAction },
        { success: boolean; message: string; orderId?: string; alreadyCreated?: boolean }
      >('respondToSecondChance');
      const result = await callable({ auctionId, action });
      if (result.data?.success) {
        const title = action === 'decline'
          ? (language === 'ar' ? 'تم إغلاق العرض' : 'Offer Closed')
          : action === 'seller_accept'
            ? (language === 'ar' ? '✅ تم قبول العرض' : '✅ Offer Accepted')
            : (language === 'ar' ? '🛒 تم تأكيد الشراء' : '🛒 Purchase Confirmed');
        addNotification(title, result.data.message || title, 'info');
        return { success: true, message: result.data.message };
      }
      return { success: false, message: result.data?.message || 'Failed to respond to the offer.' };
    } catch (error: any) {
      console.error('Cloud function respondToSecondChance failed:', error);
      const msg = error.message || (language === 'ar' ? 'تعذر تنفيذ العملية.' : 'Failed to respond to the offer.');
      showToast({ title: language === 'ar' ? '❌ خطأ' : '❌ Error', message: msg, type: 'warn' });
      return { success: false, message: msg };
    }
  }, [addNotification, showToast, language]);

  // E6 — buyer opens a return claim on a shipped order. The callable is
  // buyer-only and freezes the order into a return-typed dispute.
  const requestReturn = useCallback(async (
    orderId: string,
    input: { reason: ReturnReason; description: string; photoUrls: string[] }
  ) => {
    try {
      const callable = await getCallableFunction<
        { orderId: string; reason: ReturnReason; description: string; photoUrls: string[] },
        { success: boolean; message: string }
      >('requestReturn');
      const result = await callable({ orderId, ...input });
      if (result.data?.success) {
        addNotification(
          language === 'ar' ? 'تم تقديم طلب الإرجاع' : 'Return Requested',
          result.data.message || (language === 'ar' ? 'تم تجميد الطلب ريثما يراجع الفريق طلب الإرجاع.' : 'The order is frozen while the team reviews your return.'),
          'info'
        );
        return { success: true, message: result.data.message };
      }
      return { success: false, message: result.data?.message || 'Failed to submit return.' };
    } catch (error: any) {
      console.error('Cloud function requestReturn failed:', error);
      const msg = error.message || (language === 'ar' ? 'تعذر تقديم طلب الإرجاع.' : 'Failed to submit return.');
      showToast({ title: language === 'ar' ? '❌ خطأ' : '❌ Error', message: msg, type: 'warn' });
      return { success: false, message: msg };
    }
  }, [addNotification, showToast, language]);

  // E6 B1 — seller accepts or contests an open return claim. Advisory only: the
  // callable writes only the returnClaim sub-fields; no money moves (admin still
  // executes any refund via the escrow callables).
  const sellerRespondToReturn = useCallback(async (
    orderId: string,
    input: { accept: boolean; note?: string }
  ) => {
    try {
      const callable = await getCallableFunction<
        { orderId: string; accept: boolean; note?: string },
        { success: boolean; message: string }
      >('respondToReturn');
      const result = await callable({ orderId, accept: input.accept, note: input.note });
      if (result.data?.success) {
        addNotification(
          input.accept
            ? (language === 'ar' ? 'تم قبول طلب الإرجاع' : 'Return Accepted')
            : (language === 'ar' ? 'تم إرسال ردك' : 'Response Sent'),
          result.data.message || (language === 'ar' ? 'تم تسجيل ردك على طلب الإرجاع.' : 'Your response to the return has been recorded.'),
          'info'
        );
        return { success: true, message: result.data.message };
      }
      return { success: false, message: result.data?.message || 'Failed to respond to return.' };
    } catch (error: any) {
      console.error('Cloud function respondToReturn failed:', error);
      const msg = error.message || (language === 'ar' ? 'تعذر إرسال الرد على طلب الإرجاع.' : 'Failed to respond to return.');
      showToast({ title: language === 'ar' ? '❌ خطأ' : '❌ Error', message: msg, type: 'warn' });
      return { success: false, message: msg };
    }
  }, [addNotification, showToast, language]);

  // E7 — seller rates the buyer on a completed order. The callable is seller-only,
  // one-per-order (deterministic review id), and never moves money.
  const rateBuyer = useCallback(async (
    orderId: string,
    input: { stars: number; comment?: string }
  ) => {
    try {
      const callable = await getCallableFunction<
        { orderId: string; stars: number; comment?: string },
        { success: boolean; message: string }
      >('rateBuyer');
      const result = await callable({ orderId, stars: input.stars, comment: input.comment });
      if (result.data?.success) {
        addNotification(
          language === 'ar' ? 'تم تقييم المشتري' : 'Buyer Rated',
          result.data.message || (language === 'ar' ? 'تم حفظ تقييمك للمشتري.' : 'Your rating of the buyer has been saved.'),
          'info'
        );
        return { success: true, message: result.data.message };
      }
      return { success: false, message: result.data?.message || 'Failed to rate buyer.' };
    } catch (error: any) {
      console.error('Cloud function rateBuyer failed:', error);
      const msg = error.message || (language === 'ar' ? 'تعذر حفظ التقييم.' : 'Failed to rate buyer.');
      showToast({ title: language === 'ar' ? '❌ خطأ' : '❌ Error', message: msg, type: 'warn' });
      return { success: false, message: msg };
    }
  }, [addNotification, showToast, language]);

  // Buyer rates the seller/auction on a completed order. The callable is buyer-only,
  // order-verified, one-per-order (deterministic review id), and never moves money.
  // Client can no longer write buyer_rates_auction reviews directly (firestore.rules).
  const rateAuction = useCallback(async (
    orderId: string,
    input: { stars: number; comment?: string }
  ): Promise<{ ok?: boolean }> => {
    const callable = await getCallableFunction<
      { orderId: string; stars: number; comment?: string },
      { success: boolean; message: string }
    >('rateAuction');
    const result = await callable({ orderId, stars: input.stars, comment: input.comment });
    return { ok: result.data?.success };
  }, []);

  const sendChatMessage = useCallback(async (text: string) => {
    if (!currentUser) return;
    const newMsg: ChatMessage = {
      id: `chat-${Date.now()}-${Math.random()}`,
      auctionId: activeAuctionId || 'auction-rolex',
      userId: currentUser.id,
      userName: currentUser.name,
      userAvatar: currentUser.avatar,
      text: text,
      timestamp: Date.now(),
      isSystem: false,
      isBid: false
    };

    // Save to Firestore
    try {
      await setDoc(doc(db, 'chats', newMsg.id), newMsg);
    } catch (e) {
      console.warn("Firestore chat write error, saving locally:", e);
      setChatMessages(prev => [...prev, newMsg]);
    }
  }, [currentUser, activeAuctionId]);

  // Seller registration wizard submission
  const createListing = useCallback(async (
    listingData: Omit<AuctionItem, 'id' | 'currentPrice' | 'sellerId' | 'sellerName' | 'sellerLogo' | 'status' | 'isFeatured' | 'totalBids' | 'viewersCount'>,
    videoFile?: File | Blob | null,
    thumbnailFile?: File | Blob | null,
    onProgress?: (progress: number, stage: 'video' | 'thumbnail' | 'saving') => void,
    initialStatus: string = 'processing'
  ) => {
    if (!currentUser) {
      const errMsg = language === 'ar' ? 'يجب تسجيل الدخول لرفع المزاد.' : 'User must be logged in to upload a listing.';
      addNotification(language === 'ar' ? '❌ خطأ' : '❌ Error', errMsg, 'alert');
      // No toast here: the thrown error is displayed by the listing UIs.
      throw new Error(errMsg);
    }

    // Reserve must NOT be written to the world-readable auction doc.
    const { reservePrice, auctionInput } = stripReserve(listingData as typeof listingData & { reservePrice?: number });

    const newListingId = `auction-new-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    
    // رفع الفيديو لـ Firebase Storage أولاً
    let finalVideoUrl = listingData.videoUrl || '';
    let finalThumbnailUrl = listingData.thumbnailUrl || '';

    // Helper to upload files with robust self-healing fallback retry
    const uploadWithFallback = async (
      file: File | Blob,
      pathPrefix: 'auction-videos' | 'auction-thumbnails',
      defaultName: string,
      contentTypeDefault: string,
      onProgressLocal?: (progress: number) => void
    ): Promise<string> => {
      const { ref, uploadBytesResumable, getDownloadURL, getStorage } = await import('firebase/storage');
      const { getFirebaseStorage } = await import('../services/firebase');

      // Thumbnails (never video) get shrunk to a card-friendly size before
      // upload — raw 12MP phone photos as small-card thumbnails is pure
      // waste, and every Discovery card downloads one of these.
      // resizeImage() never throws and falls back to the original file
      // whenever it isn't a clear win, so this is always safe to await.
      const uploadFile: File | Blob = pathPrefix === 'auction-thumbnails'
        ? await resizeImage(file)
        : file;

      const storage = await getFirebaseStorage();
      const fileName = (file as any).name || defaultName;
      const cleanPath = `${pathPrefix}/${Date.now()}_${fileName}`;
      const metadata = {
        contentType: (uploadFile as any).type && (uploadFile as any).type.trim() !== ''
          ? (uploadFile as any).type
          : ((file as any).type && (file as any).type.trim() !== '' ? (file as any).type : contentTypeDefault)
      };

      // Try primary bucket first
      try {
        console.log(`Attempting upload to primary bucket at path: ${cleanPath}...`);
        const primaryRef = ref(storage, cleanPath);
        const uploadTask = uploadBytesResumable(primaryRef, uploadFile, metadata);
        
        await new Promise<void>((resolve, reject) => {
          uploadTask.on('state_changed',
            (snapshot) => {
              const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
              if (onProgressLocal) onProgressLocal(progress);
            },
            (error) => reject(error),
            () => resolve()
          );
        });
        return await getDownloadURL(uploadTask.snapshot.ref);
      } catch (primaryErr: any) {
        console.warn(`Primary storage bucket upload failed (Code: ${primaryErr.code || 'unknown'}). Retrying with older fallback bucket gs://mazadjoapp.appspot.com...`);
        
        try {
          // Initialize storage instance with fallback bucket
          const fallbackStorage = getStorage(storage.app, "gs://mazadjoapp.appspot.com");
          const fallbackRef = ref(fallbackStorage, cleanPath);
          const uploadTaskFallback = uploadBytesResumable(fallbackRef, uploadFile, metadata);
          
          if (onProgressLocal) onProgressLocal(0); // Reset progress for retry
          
          await new Promise<void>((resolve, reject) => {
            uploadTaskFallback.on('state_changed',
              (snapshot) => {
                const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                if (onProgressLocal) onProgressLocal(progress);
              },
              (error) => reject(error),
              () => resolve()
            );
          });
          return await getDownloadURL(uploadTaskFallback.snapshot.ref);
        } catch (fallbackErr: any) {
          console.error("Firebase Storage write failure during upload retry:", fallbackErr.code, fallbackErr.message);
          throw fallbackErr;
        }
      }
    };

    if (videoFile) {
      try {
        if (onProgress) onProgress(0, 'video');
        finalVideoUrl = await uploadWithFallback(
          videoFile,
          'auction-videos',
          `${Date.now()}_video.mp4`,
          'video/mp4',
          (progress) => {
            if (onProgress) onProgress(progress, 'video');
          }
        );
      } catch (videoErr: any) {
        console.error("Final Firebase Storage write failure during video upload. Code:", videoErr.code, "Message:", videoErr.message);
        const code = videoErr.code || 'storage/unknown';
        const errorMsg = language === 'ar'
          ? `فشل رفع الفيديو (${code}). لم يُنشر المزاد — حاول مجدداً.`
          : `Video upload failed (${code}). Auction not published — please try again.`;

        addNotification(
          language === 'ar' ? '❌ فشل الرفع' : '❌ Upload Failed',
          errorMsg,
          'alert'
        );
        throw new Error(errorMsg);
      }
    }

    if (thumbnailFile) {
      try {
        if (onProgress) onProgress(0, 'thumbnail');
        finalThumbnailUrl = await uploadWithFallback(
          thumbnailFile,
          'auction-thumbnails',
          `${Date.now()}_thumbnail.jpg`,
          'image/jpeg',
          (progress) => {
            if (onProgress) onProgress(progress, 'thumbnail');
          }
        );
      } catch (thumbErr: any) {
        console.error("Final Firebase Storage write failure during thumbnail upload. Code:", thumbErr.code, "Message:", thumbErr.message);
        const code = thumbErr.code || 'storage/unknown';
        const errorMsg = language === 'ar'
          ? `فشل رفع الصورة المصغرة (${code}). لم يُنشر المزاد — حاول مجدداً.`
          : `Thumbnail upload failed (${code}). Auction not published — please try again.`;

        addNotification(
          language === 'ar' ? '❌ فشل الرفع' : '❌ Upload Failed',
          errorMsg,
          'alert'
        );
        throw new Error(errorMsg);
      }
    }

    // A stock-photo fallback used to sit here: when no thumbnail was uploaded
    // it guessed a category from a keyword and assigned a matching Unsplash
    // photograph, with a red-sneakers image as the else-branch. Since the drop
    // builder filed every non-phone, non-car lot under the 'Fashion' catch-all,
    // a television matched nothing and shipped wearing the shoe. That was
    // reported as broken image links; nothing was linked, the app wrote a photo
    // it was never given.
    //
    // `finalThumbnailUrl` therefore stays '' when nothing was uploaded, and the
    // surfaces render <ListingImage>'s labelled blank. Both publish paths now
    // require media (utils/listingMedia.ts), so only historical lots reach that
    // state.

    if (onProgress) onProgress(100, 'saving');

    const endTimeMs = (listingData as any).endTime || (listingData as any).endsAt || (Date.now() + 3600 * 1000);

    // E3 Slice A — first-bid start mode: the listing goes live immediately with
    // NO endTime/endsAt (the duration clock starts on the first bid, server-side
    // in applyBidWrites). scheduledStartAt = now so the opener cron flips it live
    // on its next run. Scheduled listings keep their computed end time.
    const isFirstBid = (listingData as any).startMode === 'first_bid';

    // Admin drop-builder auctions get a sequential number from the atomic counter.
    // (Seller-wizard 'processing' submissions don't — they're numbered at approval time, later slice.)
    let assignedAuctionNumber: number | undefined;
    if (initialStatus === 'upcoming') {
      try {
        const { allocateAuctionNumber } = await import('../utils/auctionNumber');
        assignedAuctionNumber = await allocateAuctionNumber(db);
      } catch (numErr) {
        console.warn('[createListing] auction number allocation failed (continuing without):', numErr);
      }
    }

    // Is this one of Mazad's OWN drops? Only the admin drop-builder sets
    // soldByMazad, and the isAdminUser gate means a forged flag on a
    // seller-facing path cannot dress a third-party lot up as Mazad's.
    const sellsAsMazad = (listingData as any).soldByMazad === true && isAdminUser(currentUser);

    const newListing: any = {
      ...auctionInput,
      ...(assignedAuctionNumber != null ? { auctionNumber: assignedAuctionNumber } : {}),
      // Initialize the buyer-visible "reserve not yet met" flag to false when a
      // reserve is actually set. Only the boolean crosses onto the world-readable
      // auction doc — never the amount (that lives in auctionSecrets, see below).
      // onBidCreated flips this to true once a qualifying bid lands.
      ...(reservePrice && reservePrice > 0 ? { reserveMet: false } : {}),
      id: newListingId,
      currentPrice: listingData.startingPrice,
      // sellerId stays the REAL creating uid even for Mazad's own drops: orders,
      // payouts, seller notifications, reviews and the firestore.rules ownership
      // checks are all keyed on it. Only the buyer-facing DISPLAY identity below
      // changes. Same for createdById further down.
      sellerId: currentUser.id,
      // Mazad's own drops (admin drop-builder, soldByMazad) sell as the Mazzado
      // store, not as the individual admin who happened to build them — that is
      // what a buyer is actually transacting with. Gated on isAdminUser so a
      // forged flag from a seller-facing path cannot claim Mazad's identity.
      sellerName: sellsAsMazad
        ? MAZAD_STORE_NAME
        : (currentUser.name || sellerProfile?.storeName || 'Custom Merchant'),
      sellerLogo: sellsAsMazad
        ? MAZAD_STORE_LOGO
        : (currentUser.avatar || sellerProfile?.storeLogo || 'https://images.unsplash.com/photo-1547996165-f823e595aa?auto=format&fit=crop&w=150&q=80'),
      status: initialStatus, // Save under the requested status (default 'processing' = awaiting Mazad review) so Admin can approve/reject
      // Concierge flag (a.k.a. listedByMazad): true only when the seller asked
      // Mazad to build the listing — the admin queue badges these so the team
      // completes details before approving. Defaults to false.
      isConcierge: (listingData as any).isConcierge === true,
      channel: listingData.channel ?? 'misc',
      scheduledStartAt: isFirstBid ? Date.now() : (listingData.scheduledStartAt ?? null),
      // Wave 4 (seller-KYC groundwork): listing-time ownership + legality
      // attestation. Both sell paths (wizard + concierge) require the checkbox
      // before submit can reach here; the stamp survives on the doc for audit.
      // Extra keys pass the auctions create rule (no hasOnly / no blocked-key
      // check on these fields).
      ownershipAttested: true,
      attestedAt: serverTimestamp(),
      approvalStatus: 'pending',
      isApproved: false,
      isFeatured: false,
      totalBids: 0,
      viewersCount: 0,
      createdAt: new Date().getTime(),
      createdById: currentUser.id, // Strictly match currentUser.id to comply with firestore.rules
      createdByName: currentUser.name || 'Seller JO',
      videoUrl: finalVideoUrl,
      thumbnailUrl: finalThumbnailUrl,
      // first_bid: omit endTime/endsAt entirely (the clock starts on the first bid).
      ...(isFirstBid ? {} : { endTime: endTimeMs, endsAt: Timestamp.fromMillis(endTimeMs) })
    };

    // first_bid: the caller (drop-builder) still passes an `endTime`/`endsAt` in
    // listingData, which the `...auctionInput` spread above would carry onto the
    // doc. Strip them so a first_bid lot truly has NO end until the first bid.
    if (isFirstBid) {
      delete newListing.endTime;
      delete newListing.endsAt;
    }

    // Save directly to Firestore for real-time synchronization
    const docRef = doc(db, 'auctions', newListingId);
    try {
      await setDoc(docRef, newListing);
      console.log("Auction created", newListing);
      // Log auction created event to Firestore Analytics
      logAnalyticsEvent('auction_created', currentUser.id, currentUser.email || null, {
        auctionId: newListingId,
        title: listingData.title,
        startingPrice: listingData.startingPrice,
        category: listingData.category
      });
    } catch (dbErr: any) {
      console.error("Direct auction write to Firestore failed. Code:", dbErr.code, "Message:", dbErr.message);
      const saveFailTitle = language === 'ar' ? '❌ فشل حفظ المزاد' : '❌ Auction Save Failed';
      const saveFailMsg = language === 'ar' ? `فشل تسجيل المزاد الجديد بقاعدة البيانات. رمز الخطأ: ${dbErr.code || 'unknown'}` : `Failed to create auction. Code: ${dbErr.code || 'unknown'}`;
      addNotification(saveFailTitle, saveFailMsg, 'alert');
      showToast({ title: saveFailTitle, message: saveFailMsg, type: 'warn' });
      handleFirestoreError(dbErr, OperationType.CREATE, `auctions/${newListingId}`);
    }

    /**
     * Reserve is stored server-side only, never on the auction doc.
     *
     * This USED to be `setDoc(doc(db, 'auctionSecrets', ...))` — a write from
     * the browser, as the seller, to a collection whose rules are
     * `allow write: if isAdmin()`. Firestore denied it for every non-admin
     * seller and the error was swallowed into a console.warn, so the seller was
     * told the auction had been created while the reserve existed nowhere. The
     * lot then settled as if it had no reserve and sold at the top bid.
     *
     * The callable writes it from a trusted context and checks ownership
     * itself; the rules stay shut.
     */
    if (reservePrice && reservePrice > 0) {
      try {
        const setReserve = await getCallableFunction<
          { auctionId: string; reservePrice: number },
          { success: boolean }
        >('setAuctionReserve');
        await setReserve({ auctionId: newListingId, reservePrice });
      } catch (resErr: any) {
        /**
         * LOUD, because the quiet version is what caused the bug.
         *
         * The auction write directly above this raises a notification, a toast
         * AND handleFirestoreError on failure. This one raised nothing, which
         * is precisely why nobody noticed that no reserve was ever being
         * stored. The lot is already live at this point and cannot be unwound
         * from here, so the seller has to be told plainly that it is live
         * WITHOUT the protection they asked for.
         *
         * Settlement will not award such a lot — it refuses when a reserve was
         * intended but its amount is unreadable — so the money is safe either
         * way. This message exists so the seller finds out now rather than when
         * the auction fails to complete.
         */
        console.error('[createListing] reserve write failed:', resErr);
        const reserveFailTitle = language === 'ar'
          ? '⚠️ لم يُحفظ سعر الحد الأدنى'
          : '⚠️ Reserve price was not saved';
        const reserveFailMsg = language === 'ar'
          ? 'المزاد نُشر، لكن سعر الحد الأدنى لم يُحفظ. لن يُرسى المزاد تلقائياً قبل مراجعتنا — تواصل معنا لضبط السعر.'
          : 'The auction is live, but its reserve price was not saved. It will not be awarded automatically until we review it — contact us to set the reserve.';
        addNotification(reserveFailTitle, reserveFailMsg, 'alert');
        showToast({ title: reserveFailTitle, message: reserveFailMsg, type: 'warn' });
      }
    }

    // De-dupe by id. Firestore latency-compensates: the local onSnapshot fires
    // the moment the write is issued, so by the time the awaited setDoc above
    // resolves `prev` USUALLY ALREADY CONTAINS this lot. Unconditionally
    // unshifting it produced two entries sharing one id — the drop-builder list
    // rendered the same lot twice, both showing the same auction number, until
    // the next snapshot rebuilt the array. The optimistic insert still matters
    // for the case where the snapshot has not landed yet.
    setAuctions(prev => (prev.some(a => a.id === newListingId) ? prev : [newListing, ...prev]));
    
    if (language === 'ar') {
      addNotification(
        '⏳ المزاد بانتظار موافقة الإدارة',
        `تم رفع "${listingData.title}" بنجاح وهو الآن بانتظار مراجعة الإدارة والموافقة عليه قبل البث العام.`,
        'win'
      );
    } else {
      addNotification(
        '⏳ Auction Awaiting Review',
        `"${listingData.title}" has been successfully uploaded and is pending admin approval before public release.`,
        'win'
      );
    }

    // Meta Pixel: the listing document has been written. Placed at the single
    // success return, after every write and gate above it — every failure path
    // in createListing throws or returns before reaching here, so this cannot
    // count a listing that was not created.
    trackListItem(newListingId);

    return newListingId;
  }, [sellerProfile, currentUser, addNotification, showToast, language]);

  // --- ADMIN ACTIONS ---

  // Approval-gate verdicts must reach the SELLER, not the admin who clicked.
  // Local addNotification only feeds the current session's bell, so verdicts
  // are written to the cross-user /notifications collection (the same
  // mechanism orderWorkflow uses; Seller Center + the bell subscribe to it).
  // Bilingual fields are stored so the seller's device renders its own language.
  const notifySellerOfListingDecision = useCallback((
    sellerId: string | undefined,
    auctionId: string,
    strings: { titleAr: string; titleEn: string; descAr: string; descEn: string }
  ) => {
    if (!sellerId) return;
    const notifId = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    // firestore.rules caps notification titles at 300 and descriptions at 500
    // chars (anti-phishing) — clamp defensively so an extreme title/reason
    // combination can never make the verdict write bounce off the rules.
    const clampT = (s: string) => s.slice(0, 300);
    const clampD = (s: string) => s.slice(0, 500);
    // Type 'order' — a user-facing type from the Wave D allowlist, so the
    // verdict actually reaches the seller's bell ('admin'/'alert' are filtered).
    setDoc(doc(db, 'notifications', notifId), {
      id: notifId,
      userId: sellerId,
      title: clampT(strings.titleAr),
      titleAr: clampT(strings.titleAr),
      titleEn: clampT(strings.titleEn),
      description: clampD(strings.descAr),
      descriptionAr: clampD(strings.descAr),
      descriptionEn: clampD(strings.descEn),
      type: 'order',
      priority: 'high',
      timestamp: Date.now(),
      read: false,
      auctionId
    }).catch(err => {
      console.warn('Failed to write seller listing-decision notification:', err?.code, err?.message);
    });
  }, []);

  /**
   * Correct a lot's viewing after it has been approved.
   *
   * `approveListing` writes viewing only at the moment of approval, and once a
   * lot is live it has left the pending queue entirely — so a wrong place (a
   * typo, or a shop that moved) had no in-product fix at all and needed the
   * Firebase console. This is that fix.
   *
   * Deliberately NOT routed through `viewingWritePayload`: that helper returns
   * `{}` for an empty mode, meaning "leave untouched", which is right for an
   * approval that states nothing but makes clearing impossible here. An admin
   * correcting a claim must be able to REMOVE it, so '' writes '' — which
   * `resolveViewing` treats as not-stated and renders as nothing.
   */
  const setAuctionViewing = useCallback(async (
    id: string,
    viewing: ViewingMode | '',
    viewingPlace: string,
  ): Promise<{ success: boolean; message?: string }> => {
    if (!isAdminUser(currentUser)) {
      return { success: false, message: 'Admins only.' };
    }
    try {
      // Always write both keys so a stale place can never outlive a mode change
      // (the same revival hazard viewingWritePayload guards on the approval path).
      // Place is only meaningful for 'store'; anything else clears it.
      await updateDoc(doc(db, 'auctions', id), {
        viewing,
        viewingPlace: viewing === 'store' ? (viewingPlace || '').trim() : '',
      });
      return { success: true };
    } catch (err: any) {
      console.error('[setAuctionViewing] failed:', err);
      return { success: false, message: err?.message || 'Update failed.' };
    }
  }, [currentUser]);

  const approveListing = useCallback(async (id: string, viewing?: ViewingMode, viewingPlace?: string) => {
    // Find the target auction to respect its duration (e.g. 6 hours / 10 minutes etc.)
    // Fall back to a direct Firestore read for admin surfaces (e.g. AdminPanel)
    // that render outside the context auctions subscription.
    let targetA: any = auctions.find(a => a.id === id);
    if (!targetA) {
      try {
        const snap = await getDoc(doc(db, 'auctions', id));
        if (snap.exists()) targetA = { id: snap.id, ...snap.data() };
      } catch { /* defaults below still apply */ }
    }
    // REFUSE to re-open an auction that already settled. A winner defaulting
    // leaves a dead lot in the queue and "Approve & go live" is the obvious
    // button — but re-approving recalculates endTime and flips status back to
    // 'live' while leaving settledAt, currentPrice and currentBidderId intact,
    // so new bidders have to outbid the defaulter's phantom bid. Worse, orders
    // are keyed by the AUCTION id and settleAuctionTxn only creates one
    // `if (!orderSnap.exists)` — the defaulted order still occupies that id, so
    // the next winner would get NO order at all. Re-running has to mean a NEW
    // auction doc, which is what the relist paths already do.
    if (blockedApprovalReason(targetA) === 'already_settled') {
      addNotification(
        language === 'ar' ? '⚠️ هذا المزاد انتهى بالفعل' : '⚠️ This auction has already settled',
        language === 'ar'
          ? 'لا يمكن إعادة تشغيل مزاد منتهٍ — أعد إدراجه كمزاد جديد بدلاً من ذلك.'
          : 'A settled auction cannot be re-opened — relist it as a new auction instead.',
        'error'
      );
      // MUST report failure: nothing was written, so an optimistic hide of this
      // row has to be rolled back or the settled lot vanishes from the queue.
      return { success: false };
    }

    const durationSec = targetA?.duration ? Number(targetA.duration) : 600; // fallback to 10 minutes (600s)
    const freshEndTime = Date.now() + durationSec * 1000;
    const endsAtTimestamp = Timestamp.fromMillis(freshEndTime);

    // Re-baseline the live price to the (possibly corrected) starting price.
    // A seller who resubmits a rejected item with a fixed price only changes
    // startingPrice — currentPrice is frozen by the rules for non-admins — so
    // without this the auction would go live showing the stale old price.
    // Only the admin path can write currentPrice, and only before any bids exist.
    const startBaseline = Number(targetA?.startingPrice);
    const priceReset =
      Number.isFinite(startBaseline) && Number(targetA?.totalBids || 0) === 0
        ? { currentPrice: startBaseline }
        : {};

    // The Action Center hides this lot's row the moment the button is pressed
    // and un-hides it only if this call REPORTS a failure. A swallowed
    // rejection therefore reads as success: the row stays hidden, the badge
    // under-counts, and the lot is gone until reload. So the write promise is
    // returned, not fired and forgotten, and the local optimistic flip below is
    // rolled back too — the doc never changed on a failed write, so the
    // snapshot listener will not fire and correct us.
    const localBefore = auctions.find(a => a.id === id);

    const docRef = doc(db, 'auctions', id);
    const writeResult = updateDoc(docRef, {
      // Per-lot viewing, set by the admin on the approval card. An approval that
      // does not set viewing spreads nothing, leaving the lot UNSET (renders
      // nothing). When a mode IS chosen the helper always writes viewingPlace
      // too — updateDoc merges, so omitting the place would let one from an
      // earlier approval survive and advertise a shop nobody entered for this
      // lot. Never emits `undefined`, which Firestore rejects.
      ...viewingWritePayload(viewing, viewingPlace),
      status: 'live',
      approvalStatus: 'approved',
      isApproved: true,
      approvedAt: serverTimestamp(),
      approvedBy: currentUser?.id || 'admin-system',
      // The countdown, re-baselined from the lot's real `duration` (e.g. 6
      // hours) so it starts when the lot actually goes live. A first_bid lot
      // gets NEITHER key: the helper returns {} for one, so the write carries no
      // endTime and no endsAt and the lot goes live clockless — the server
      // stamps both on the first bid. Omitting keys does not clear them:
      // updateDoc merges, so an endTime already on the doc survives this write.
      // Same rule as scheduledAuctionOpener and the autoRelistSweep child in
      // functions/index.js.
      ...approvalClockFields(targetA, freshEndTime, endsAtTimestamp),
      ...priceReset
    }).then(() => {
      // Tell the seller their listing passed the gate — ONLY once the status
      // write actually settled (a failed write must not claim "now live").
      notifySellerOfListingDecision(targetA?.sellerId || targetA?.createdById, id, {
        titleAr: 'تمت الموافقة على مزادك ✅',
        titleEn: 'Your auction is approved ✅',
        descAr: `مزادك "${targetA?.title || ''}" صار مباشر الآن — بالتوفيق!`,
        descEn: `Your auction "${targetA?.title || ''}" is now live — good luck!`
      });
      return { success: true };
    }).catch(err => {
      // NOTE: this .catch is chained AFTER the .then, so it also sees anything
      // the .then throws. Everything in there is safe today
      // (notifySellerOfListingDecision early-returns without a seller id, does
      // string work, then swallows its own write) — but a statement that threw
      // SYNCHRONOUSLY there would make a SUCCESSFUL write report
      // { success: false }, roll local state back and raise the failure toast.
      // The snapshot listener heals the state within a round trip, so the
      // residue would be a wrong toast. Do not add a throwing statement above.
      console.error("Firestore approve write failed. Code:", err.code, "Message:", err.message, err);
      addNotification(
        language === 'ar' ? '❌ فشل اعتماد المزاد' : '❌ Approve Listing Failed',
        `Code: ${err.code || 'unknown'}. Message: ${err.message || 'unknown'}`,
        'alert'
      );
      // Undo the local flip below. `localBefore` was captured from the
      // render-time `auctions` closure, so this restores the lot as it looked
      // WHEN THE BUTTON WAS PRESSED, not as of now: if a snapshot updated this
      // lot between that moment and the write failing, those newer fields are
      // reverted too. The next snapshot heals it. Bounded and self-correcting,
      // but not the same claim as "exactly as it was".
      //
      // This notification is the ONE report of the failure — callers must not
      // raise a second one.
      setAuctions(prev => restoreLocalAuction(prev, id, localBefore));
      return { success: false };
    });

    // Local optimistic flip. The clock spread is the same helper call on the same
    // `targetA`, so local state and the write agree by construction: on a
    // first_bid lot neither one sets endTime/endsAt, and the row keeps whatever
    // it already had rather than showing a countdown until the snapshot lands.
    setAuctions(prev => prev.map(a => {
      if (a.id === id) {
        return { ...a, status: 'live', approvalStatus: 'approved', isApproved: true, ...approvalClockFields(targetA, freshEndTime, endsAtTimestamp), ...priceReset };
      }
      return a;
    }));

    const action: AdminAction = {
      id: `admin-act-${Date.now()}-${Math.random()}`,
      actionType: 'approve_listing',
      targetId: id,
      targetName: targetA?.title || 'Unknown Item',
      adminName: currentUser?.name || 'Admin',
      timestamp: Date.now(),
      details: 'Visual stream quality & price guide certified.'
    };
    setAdminActions(prev => [action, ...prev]);

    // Returned LAST so every existing side effect keeps firing at the moment it
    // always did — awaiting here would have delayed the local flip by the write.
    return writeResult;
  }, [auctions, currentUser, addNotification, language, notifySellerOfListingDecision]);

  const rejectListing = useCallback(async (id: string, reason?: string) => {
    const trimmedReason = (reason || '').trim();
    // Resolve the target for the seller notification — direct read fallback
    // for admin surfaces rendered outside the context auctions subscription.
    let targetA: any = auctions.find(a => a.id === id);
    if (!targetA) {
      try {
        const snap = await getDoc(doc(db, 'auctions', id));
        if (snap.exists()) targetA = { id: snap.id, ...snap.data() };
      } catch { /* notification falls back to empty title */ }
    }

    // Same contract as approveListing: the write promise is RETURNED so the
    // Action Center's optimistic hide can be rolled back, and the local flip
    // below is undone on failure because no snapshot will arrive to correct it.
    const localBefore = auctions.find(a => a.id === id);

    // Write reject properties directly to Firestore database
    const docRef = doc(db, 'auctions', id);
    const writeResult = updateDoc(docRef, {
      status: 'rejected',
      approvalStatus: 'rejected',
      isApproved: false,
      rejectionReason: trimmedReason,
      rejectedAt: serverTimestamp(),
      rejectedBy: currentUser?.id || 'admin-system'
    }).then(() => {
      // Tell the seller their listing was declined — including why — ONLY
      // after the status write settled (no verdict on a failed write).
      notifySellerOfListingDecision(targetA?.sellerId || targetA?.createdById, id, {
        titleAr: 'مزادك ما تم قبوله',
        titleEn: "Your listing wasn't approved",
        descAr: `للأسف ما تمت الموافقة على "${targetA?.title || ''}".${trimmedReason ? ` السبب: ${trimmedReason}` : ''}`,
        descEn: `Unfortunately "${targetA?.title || ''}" wasn't approved.${trimmedReason ? ` Reason: ${trimmedReason}` : ''}`
      });
      return { success: true };
    }).catch(err => {
      // Also catches a synchronous throw from the .then above — see
      // approveListing.
      console.error("Firestore reject write failed. Code:", err.code, "Message:", err.message, err);
      addNotification(
        language === 'ar' ? '❌ فشل رفض المزاد' : '❌ Reject Listing Failed',
        `Code: ${err.code || 'unknown'}. Message: ${err.message || 'unknown'}`,
        'alert'
      );
      // Undo the local flip — see approveListing for what `localBefore` does
      // and does not guarantee. This notification is the ONE failure report.
      setAuctions(prev => restoreLocalAuction(prev, id, localBefore));
      return { success: false };
    });

    setAuctions(prev => prev.map(a => {
      if (a.id === id) {
        return { ...a, status: 'rejected', approvalStatus: 'rejected', isApproved: false, rejectionReason: trimmedReason };
      }
      return a;
    }));

    const action: AdminAction = {
      id: `admin-act-${Date.now()}-${Math.random()}`,
      actionType: 'reject_listing',
      targetId: id,
      targetName: targetA?.title || 'Unknown Item',
      adminName: currentUser?.name || 'Admin',
      timestamp: Date.now(),
      details: trimmedReason ? `Rejected: ${trimmedReason}` : 'Rejected without a stated reason.'
    };
    setAdminActions(prev => [action, ...prev]);

    // Returned LAST — see approveListing.
    return writeResult;
  }, [auctions, currentUser, addNotification, language, notifySellerOfListingDecision]);

  const verifySeller = useCallback(async (userId: string) => {
    try {
      await updateDoc(doc(db, 'users', userId), { isVerified: true });
      
      const profileQuery = query(collection(db, 'sellerProfiles'), where('userId', '==', userId), limit(1));
      const profileSnap = await getDocs(profileQuery);
      if (!profileSnap.empty) {
        await updateDoc(profileSnap.docs[0].ref, { isVerifiedMerchant: true });
      }
    } catch (err: any) {
      console.error("Failed to persist seller verification:", err.code, err.message);
      addNotification('❌ Error', 'Failed to verify seller. Please try again.', 'alert');
      return;
    }

    setUsers(prev => prev.map(u => {
      if (u.id === userId) {
        return { ...u, isVerified: true };
      }
      return u;
    }));
    setSellerProfiles(prev => prev.map(p => {
      if (p.userId === userId) {
        return { ...p, isVerifiedMerchant: true };
      }
      return p;
    }));

    const targetU = users.find(u => u.id === userId);
    const action: AdminAction = {
      id: `admin-act-${Date.now()}-${Math.random()}`,
      actionType: 'verify_seller',
      targetId: userId,
      targetName: targetU?.name || 'Unknown User',
      adminName: currentUser?.name || 'Admin',
      timestamp: Date.now(),
      details: 'Submited company license validated.'
    };
    setAdminActions(prev => [action, ...prev]);
  }, [users, currentUser, addNotification]);

  const banUser = useCallback(async (userId: string) => {
    // Self-ban guard: an admin must never block their OWN account — by uid, or
    // by a shared email (an admin can hold both a phone-signup and an email/
    // Google-signup doc under one email; banning the sibling account locks
    // themselves out of bidding). Blocked before any optimistic write.
    const target = users.find(u => u.id === userId);
    const myEmail = (currentUser?.email || '').trim().toLowerCase();
    const targetEmail = (target?.email || '').trim().toLowerCase();
    const isOwnAccount = userId === currentUser?.id || (!!myEmail && myEmail === targetEmail);
    if (isOwnAccount) {
      showToast({
        title: language === 'ar' ? 'لا يمكنك حظر حسابك' : "Can't ban your own account",
        message: language === 'ar' ? 'هذا الحساب مرتبط بك.' : 'This account is linked to you.',
        type: 'warn',
      });
      return;
    }
    // Optimistic local update for instant UI…
    setUsers(prev => prev.map(u => (u.id === userId ? { ...u, isBlocked: true } : u)));
    if (userId === currentUser.id) {
      setCurrentUser(prev => ({ ...prev, isBlocked: true }));
    }
    // …then PERSIST to Firestore (rules allow an admin to write isBlocked). The
    // bid path reads isBlocked server-side, so without this write the ban never
    // took effect (it was a local-only stub).
    try {
      await updateDoc(doc(db, 'users', userId), { isBlocked: true, blockedReason: 'admin_ban' });
    } catch (err: any) {
      console.error('banUser: failed to persist block', err);
      // roll back the optimistic UI so it doesn't lie about a block that didn't save
      setUsers(prev => prev.map(u => (u.id === userId ? { ...u, isBlocked: false } : u)));
      if (userId === currentUser.id) setCurrentUser(prev => ({ ...prev, isBlocked: false }));
      showToast({ title: language === 'ar' ? 'تعذّر حظر العضو' : 'Could not block user', message: err?.message || '', type: 'warn' });
      return;
    }

    const targetU = users.find(u => u.id === userId);
    const action: AdminAction = {
      id: `admin-act-${Date.now()}-${Math.random()}`,
      actionType: 'ban_user',
      targetId: userId,
      targetName: targetU?.name || 'Unknown User',
      adminName: currentUser?.name || 'Admin',
      timestamp: Date.now(),
      details: 'Banned due to bidding spam / non-payment.'
    };
    setAdminActions(prev => [action, ...prev]);
  }, [users, currentUser, showToast, language]);

  const unbanUser = useCallback(async (userId: string) => {
    // Optimistic local update…
    setUsers(prev => prev.map(u => (u.id === userId ? { ...u, isBlocked: false } : u)));
    if (userId === currentUser.id) {
      setCurrentUser(prev => ({ ...prev, isBlocked: false }));
    }
    // …then PERSIST: clear isBlocked AND remove blockedReason so the account is
    // fully un-restricted (e.g. a 'payment_default' block set by the enforcer).
    // Without this write the UNBAN button was a local-only stub — the user stayed
    // blocked server-side (placeBid reads isBlocked from Firestore).
    // Note: if a defaulted order is still in `waiting_payment` past its deadline,
    // the paymentDefaultEnforcer cron can re-block within 30 min — resolve/cancel
    // that order too to make the unban stick.
    try {
      await updateDoc(doc(db, 'users', userId), { isBlocked: false, blockedReason: deleteField() });
    } catch (err: any) {
      console.error('unbanUser: failed to persist unblock', err);
      setUsers(prev => prev.map(u => (u.id === userId ? { ...u, isBlocked: true } : u)));
      if (userId === currentUser.id) setCurrentUser(prev => ({ ...prev, isBlocked: true }));
      showToast({ title: language === 'ar' ? 'تعذّر فك الحظر' : 'Could not unblock user', message: err?.message || '', type: 'warn' });
    }
  }, [currentUser, showToast, language]);

  // ESCROW RELEASES (CRITICAL MONEY FLOW SYSTEM)
  const releaseEscrow = useCallback(async (escrowId: string) => {
    try {
      const releaseCallable = await getCallableFunction<{ escrowId: string }, { success: boolean; message: string }>('releaseEscrow');
      const result = await releaseCallable({ escrowId });
      if (result.data.success) {
        addNotification(
          '🤝 Escrow Funds Released',
          `The escrow transaction has been approved and settled successfully.`,
          'info'
        );
      }
    } catch (error: any) {
      console.error("Cloud function releaseEscrow failed:", error);
      addNotification('❌ Release Error', error.message || 'Failed to release escrow.', 'alert');
    }
  }, [addNotification]);

  const refundEscrow = useCallback(async (escrowId: string) => {
    try {
      const refundCallable = await getCallableFunction<{ escrowId: string }, { success: boolean; message: string }>('refundEscrow');
      const result = await refundCallable({ escrowId });
      if (result.data.success) {
        addNotification(
          '🛡️ Escrow Refunded Successfully',
          `Secured funds have been returned to user's available balance.`,
          'refund'
        );
      }
    } catch (error: any) {
      console.error("Cloud function refundEscrow failed:", error);
      addNotification('❌ Refund Error', error.message || 'Failed to refund escrow.', 'alert');
    }
  }, [addNotification]);

  const repairEndedAuctionOrder = useCallback(async (auctionId: string) => {
    try {
      const repairCallable = await getCallableFunction<{ auctionId: string }, { success: boolean; message: string }>('repairEndedAuctionOrder');
      const result = await repairCallable({ auctionId });
      if (result.data.success) {
        addNotification(
          '🔧 Order Repaired Successfully',
          result.data.message || `Order created for auction ${auctionId}.`,
          'info'
        );
        return { success: true, message: result.data.message };
      }
      return { success: false, message: result.data.message || 'Failed to repair order.' };
    } catch (error: any) {
      console.error("Cloud function repairEndedAuctionOrder failed:", error);
      addNotification('❌ Repair Error', error.message || 'Failed to repair ended auction order.', 'alert');
      return { success: false, message: error.message || 'Failed to repair order.' };
    }
  }, [addNotification]);

  const repairStuckEscrowsForEndedAuction = useCallback(async (auctionId: string) => {
    try {
      const repairCallable = await getCallableFunction<{ auctionId: string }, { success: boolean; message: string; refundedCount?: number; totalRefundedAmount?: number; keptWinnerEscrow?: boolean }>('repairStuckEscrowsForEndedAuction');
      const result = await repairCallable({ auctionId });
      if (result.data.success) {
        addNotification(
          '🔒 Escrows Repaired Successfully',
          result.data.message || `Stuck escrows processed for auction ${auctionId}.`,
          'info'
        );
        return { 
          success: true, 
          message: result.data.message,
          refundedCount: result.data.refundedCount,
          totalRefundedAmount: result.data.totalRefundedAmount,
          keptWinnerEscrow: result.data.keptWinnerEscrow
        };
      }
      return { success: false, message: result.data.message || 'تعذر تنفيذ العملية حالياً، حاول مرة أخرى لاحقاً' };
    } catch (error: any) {
      console.error("Cloud function repairStuckEscrowsForEndedAuction failed:", error);
      addNotification('❌ Escrow Repair Error', 'تعذر تنفيذ العملية حالياً، حاول مرة أخرى لاحقاً', 'alert');
      return { success: false, message: 'تعذر تنفيذ العملية حالياً، حاول مرة أخرى لاحقاً' };
    }
  }, [addNotification]);

  const approveWithdrawal = useCallback(async (withdrawalId: string, transferRef: string) => {
    try {
      // transferRef is REQUIRED server-side: a payout cannot be marked complete
      // without recording the CliQ transfer that was actually made.
      const approveCallable = await getCallableFunction<{ withdrawalId: string; transferRef: string }, { success: boolean; message: string }>('approveWithdrawal');
      const result = await approveCallable({ withdrawalId, transferRef });
      if (result.data.success) {
        addNotification(
          language === 'ar' ? '💸 تم قبول طلب السحب' : '💸 Withdrawal Approved',
          result.data.message || (language === 'ar' ? 'تمت الموافقة على طلب السحب بنجاح.' : 'Withdrawal approved successfully.'),
          'info'
        );
        return { success: true, message: result.data.message };
      }
      return { success: false, message: result.data.message || 'Failed to approve withdrawal.' };
    } catch (error: any) {
      console.error("Cloud function approveWithdrawal failed:", error);
      addNotification(
        language === 'ar' ? '❌ خطأ في الموافقة على طلب السحب' : '❌ Approval Error',
        error.message || 'Failed to approve withdrawal.',
        'alert'
      );
      return { success: false, message: error.message || 'Failed to approve withdrawal.' };
    }
  }, [addNotification, language]);

  const rejectWithdrawal = useCallback(async (withdrawalId: string, reason?: string) => {
    try {
      const rejectCallable = await getCallableFunction<{ withdrawalId: string; reason?: string }, { success: boolean; message: string }>('rejectWithdrawal');
      const result = await rejectCallable({ withdrawalId, reason });
      if (result.data.success) {
        addNotification(
          language === 'ar' ? '❌ تم رفض طلب السحب' : '❌ Withdrawal Rejected',
          result.data.message || (language === 'ar' ? 'تم رفض طلب السحب.' : 'Withdrawal rejected successfully.'),
          'info'
        );
        return { success: true, message: result.data.message };
      }
      return { success: false, message: result.data.message || 'Failed to reject withdrawal.' };
    } catch (error: any) {
      console.error("Cloud function rejectWithdrawal failed:", error);
      addNotification(
        language === 'ar' ? '❌ خطأ في رفض طلب السحب' : '❌ Rejection Error',
        error.message || 'Failed to reject withdrawal.',
        'alert'
      );
      return { success: false, message: error.message || 'Failed to reject withdrawal.' };
    }
  }, [addNotification, language]);

  const deleteAuction = useCallback(async (id: string) => {
    const targetA = auctions.find(a => a.id === id);
    
    // Optimistic instant local-only hiding to guarantee immediate disappearance
    setDeletedAuctionIds(prev => prev.includes(id) ? prev : [...prev, id]);

    try {
      await deleteDoc(doc(db, 'auctions', id));
    } catch (e) {
      console.warn("Firestore delete auction error:", e);
    }
    
    setAuctions(prev => prev.filter(a => a.id !== id));

    const action: AdminAction = {
      id: `admin-act-${Date.now()}-${Math.random()}`,
      actionType: 'delete_auction',
      targetId: id,
      targetName: targetA?.title || 'Unknown Item',
      adminName: currentUser?.name || 'Admin',
      timestamp: Date.now(),
      details: 'Administrator permanently removed listing from system.'
    };
    setAdminActions(prev => [action, ...prev]);

    addNotification(
      language === 'ar' ? '🗑️ تم مسح المزاد' : '🗑️ Auction Deleted',
      language === 'ar' 
        ? `قام المسؤول بمسح المزاد "${targetA?.title || ''}" نهائياً من المنصة.` 
        : `Administrator permanently deleted "${targetA?.title || ''}".`,
      'info'
    );
  }, [auctions, currentUser, language, addNotification, setDeletedAuctionIds]);


  // Wave 2b: the legacy "outbid refund checker" (client-side bid-deposit
  // escrow release simulation) was removed. Bids never lock wallet funds —
  // bidding is free and you only pay after winning — so there is nothing to
  // "release when outbid". Real outbid alerts come from the notifications
  // pipeline; real escrows (order payments) are settled server-side.


  // 1. Watchlist and Auto-bid callback handles
  const toggleWatchlist = useCallback((auctionId: string) => {
    setWatchlist(prev => {
      const exists = prev.includes(auctionId);
      const updated = exists ? prev.filter(id => id !== auctionId) : [...prev, auctionId];
      return updated;
    });
  }, []);

  const setAutoBid = useCallback((auctionId: string, maxBid: number) => {
    setAutoBids(prev => ({
      ...prev,
      [auctionId]: maxBid
    }));
  }, []);

  const removeAutoBid = useCallback((auctionId: string) => {
    setAutoBids(prev => {
      const copy = { ...prev };
      delete copy[auctionId];
      return copy;
    });
  }, []);

  // 2. Watch list - 5 minutes remaining alerts engine
  const notifiedEndingSoonRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const checkTimer = setInterval(() => {
      const now = Date.now();
      watchlist.forEach(id => {
        const item = auctions.find(a => a.id === id);
        if (item && item.status === 'live') {
          const diff = item.endTime - now;
          if (diff > 0 && diff <= 5 * 60 * 1000) {
            // Check if we already triggered an alert for this specific item cycle
            const alertKey = `${id}-${Math.floor(item.endTime / 60000)}`;
            if (!notifiedEndingSoonRef.current.has(alertKey)) {
              notifiedEndingSoonRef.current.add(alertKey);
              // Typed 'outbid' (not 'alert'): a followed drop needing action is
              // one of the four bidder-relevant alert kinds (Wave D, spec §5) —
              // 'alert' collapses into the hidden internal 'admin' bucket.
              addNotification(
                language === 'ar' ? '⏳ الوقت يداهمك!' : '⏳ Watched Item Closing Soon!',
                language === 'ar'
                  ? `المزاد المتابع "${item.title}" ينتهي في أقل من 5 دقائق! قدم عرضاً الآن لتضمن الصدارة.`
                  : `Your watched item "${item.title}" ends in less than 5 minutes! Place a bid quickly!`,
                'outbid'
              );
            }
          }
        }
      });
    }, 12000); // stable 12 sec check

    return () => clearInterval(checkTimer);
  }, [watchlist, auctions, addNotification, language]);

  // 3. Centralized Auto-Bid engine
  const isAutoBiddingRef = useRef<boolean>(false);
  useEffect(() => {
    if (isAutoBiddingRef.current) return;

    const activeUserId = currentUser?.id || 'user-current';
    const triggerable = auctions.find(auction => {
      if (auction.status !== 'live') return false;
      if (auction.currentBidderId === activeUserId) return false;
      
      const maxBid = autoBids[auction.id];
      if (!maxBid) return false;

      const nextRequiredBid = minNextBid(auction.currentPrice, auction.minIncrement, auction.totalBids);
      return nextRequiredBid <= maxBid;
    });

    if (triggerable) {
      isAutoBiddingRef.current = true;
      const nextBid = minNextBid(triggerable.currentPrice, triggerable.minIncrement, triggerable.totalBids);
      
      // PF9: jitter the delay (0.8-2.0s) so many auto-bidders on one lot don't
      // fire in lockstep and thundering-herd the single-doc bid transaction.
      const jitteredDelay = 800 + Math.floor(Math.random() * 1200);
      const timer = setTimeout(() => {
        const res = placeBid(triggerable.id, nextBid);
        if (res) {
          // The guard MUST stay held until the bid's outcome is known, not
          // just for the duration of issuing it. This effect depends on
          // `auctions`, which changes on every snapshot for the whole live
          // collection — not just this lot — so it can re-run while this
          // bid's server round trip is still in flight. Clearing the ref
          // right after the call (previously here, unconditionally) let a
          // re-run see the guard already open and fire a second, redundant
          // auto-bid on the same lot before the first one's result had even
          // been reflected in `auction.currentBidderId`.
          res.finally(() => {
            isAutoBiddingRef.current = false;
          }).then(result => {
            if (result.success) {
              addNotification(
                language === 'ar' ? '🤖 نظام المزايد التلقائي' : '🤖 Auto-Bid system',
                language === 'ar'
                  ? `تم تقديم مزايدة تلقائية بقيمة ${nextBid} JOD للحفاظ على صدارتك في المزاد "${triggerable.title}".`
                  : `Auto-bid placed a counter-bid of ${nextBid} JOD on "${triggerable.title}" to secure your lead.`,
                'info'
              );
            }
          });
        } else {
          isAutoBiddingRef.current = false;
        }
      }, jitteredDelay);

      return () => {
        clearTimeout(timer);
        isAutoBiddingRef.current = false;
      };
    }
  }, [auctions, autoBids, placeBid, addNotification, language, currentUser]);

  const updateMaintenanceMode = useCallback(async (enabled: boolean, messageAr?: string, messageEn?: string, expectedDuration?: string) => {
    const maintenanceRef = doc(db, 'siteSettings', 'maintenanceMode');
    try {
      await setDoc(maintenanceRef, {
        enabled,
        messageAr: messageAr || 'المنصة خاضعة للصيانة المجدولة حالياً لتحديث أنظمة التشفير وحسابات الضمان بنظام كليك.',
        messageEn: messageEn || 'The platform is currently undergoing scheduled maintenance to upgrade security protocols and CliQ escrow systems.',
        expectedDuration: expectedDuration || '1 hr',
        updatedAt: new Date().toISOString(),
        updatedBy: currentUser?.email || 'admin'
      }, { merge: true });

      addNotification(
        '🔧 Maintenance Status Updated',
        `Maintenance mode is now ${enabled ? 'ENABLED' : 'DISABLED'}.`,
        'success'
      );
    } catch (err) {
      console.error("Error updating maintenance mode:", err);
      logSystemHealth('error', 'Failed to update Maintenance Mode', err instanceof Error ? err.message : String(err));
    }
  }, [currentUser, addNotification, logSystemHealth]);

  const updateFeatureFlag = useCallback(async (flag: string, value: boolean) => {
    const flagsRef = doc(db, 'siteSettings', 'featureFlags');
    try {
      await setDoc(flagsRef, {
        [flag]: value,
        updatedAt: new Date().toISOString(),
        updatedBy: currentUser?.email || 'admin'
      }, { merge: true });

      addNotification(
        '⚙️ Feature Flag Updated',
        `${flag} has been set to ${value ? 'ENABLED' : 'DISABLED'}.`,
        'success'
      );
    } catch (err) {
      console.error("Error updating feature flag:", err);
      logSystemHealth('error', `Failed to update Feature Flag: ${flag}`, err instanceof Error ? err.message : String(err));
    }
  }, [currentUser, addNotification, logSystemHealth]);

  // Wave 2 (profile completion): partial self-profile update. Writes ONLY the
  // provided keys to the user's Firestore doc and mirrors them into local
  // currentUser + users. Email is write-once from the client (mirrors the
  // Wave 3 server rule): it is included ONLY when the current email is empty.
  const updateOwnProfile = useCallback(async (
    fields: { name?: string; city?: string; email?: string }
  ): Promise<{ success: boolean; message: string; emailSaved?: boolean }> => {
    if (!currentUser || currentUser.id === 'unauthenticated') {
      return { success: false, message: 'Not authenticated' };
    }

    const updates: { name?: string; city?: string } = {};
    if (typeof fields.name === 'string' && fields.name.trim()) {
      updates.name = fields.name.trim();
    }
    // Only persist a known governorate id — silently skip garbage so a bad
    // caller can't write an invalid city (the modal's <select> already
    // constrains it; this guards future callers).
    if (typeof fields.city === 'string' && isValidCityId(fields.city.trim())) {
      updates.city = fields.city.trim();
    }
    // Email: only if the account has no email yet AND a non-empty one was passed.
    const emailRequested = typeof fields.email === 'string' && !!fields.email.trim();
    const emailUpdate =
      !currentUser.email && emailRequested ? fields.email!.trim() : null;

    if (Object.keys(updates).length === 0 && !emailUpdate) {
      // If a caller asked for an email write that couldn't even be attempted
      // (account already has one), report emailSaved: false so the UI doesn't
      // claim it persisted.
      return {
        success: true,
        message: 'Nothing to update',
        ...(emailRequested ? { emailSaved: false } : {}),
      };
    }

    const userRef = doc(db, 'users', currentUser.id);
    const mirrored: { name?: string; city?: string; email?: string } = { ...updates };

    try {
      // Primary write: the fields completeness depends on (name/city). Kept
      // SEPARATE from email so an email-rules denial can never block the
      // profile-completion gate from clearing.
      if (Object.keys(updates).length > 0) {
        await updateDoc(userRef, updates);
      }
    } catch (err: any) {
      console.error('updateOwnProfile error:', err);
      handleFirestoreError(err, OperationType.WRITE, `users/${currentUser.id}`);
      return { success: false, message: err?.message || 'Profile update failed' };
    }

    // Whether the optional email claim actually persisted. Undefined when no
    // email write was requested; false when it was requested but not written
    // (rules denial / offline); true only when the write resolved.
    let emailSaved: boolean | undefined = emailRequested ? false : undefined;
    if (emailUpdate) {
      // Best-effort, write-once: a rules denial (or offline failure) here is
      // swallowed so it can never block the profile-completion gate —
      // name/city already landed above — but it IS reported via emailSaved so
      // callers don't falsely confirm the email persisted.
      try {
        await updateDoc(userRef, { email: emailUpdate });
        mirrored.email = emailUpdate;
        emailSaved = true;
      } catch (err) {
        console.warn('updateOwnProfile: optional email write skipped (rules):', err);
      }
    }

    setCurrentUser(prev => ({ ...prev, ...mirrored }));
    setUsers(prev => prev.map(u => (u.id === currentUser.id ? { ...u, ...mirrored } : u)));
    return { success: true, message: 'Profile updated', ...(emailSaved !== undefined ? { emailSaved } : {}) };
  }, [currentUser]);

  const completeOnboarding = useCallback(async () => {
    if (currentUser && currentUser.id !== 'unauthenticated') {
      const userRef = doc(db, 'users', currentUser.id);
      try {
        await updateDoc(userRef, { onboardingCompleted: true });
        setCurrentUser(prev => ({ ...prev, onboardingCompleted: true }));
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, `users/${currentUser.id}`);
      }
    } else {
      localStorage.setItem('mazad_local_onboarding_completed', 'true');
      setCurrentUser(prev => ({ ...prev, onboardingCompleted: true }));
    }
  }, [currentUser]);

  const saveInterests = useCallback(async (input: SaveInterestsInput) => {
    if (!currentUser || currentUser.id === 'unauthenticated') {
      throw new Error('saveInterests requires a signed-in user');
    }
    const uid = currentUser.id;
    const consent = input.notifyChannel !== 'none' && (input.notifyDaily || input.notifyFeatured);

    // ONE batch, so the preferences and the consent record cannot land apart.
    // A half-applied save is the bad case in both directions: prefs without a
    // consent row is a send we cannot prove was agreed to, and a consent row
    // without prefs is a user who agreed and then never hears from us.
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', uid), {
      interests: input.interests,
      interestsSkipped: input.interestsSkipped,
      interestsUpdatedAt: serverTimestamp(),
      notifyDaily: input.notifyDaily,
      notifyFeatured: input.notifyFeatured,
      notifyChannel: input.notifyChannel,
      notificationConsent: {
        granted: consent,
        channel: input.notifyChannel,
        at: Timestamp.now(),
        source: input.interestsSkipped ? 'onboarding-skip' : 'onboarding',
      },
    });
    // APPEND-ONLY audit trail. `notificationConsent` above is only the latest
    // state and the owner can overwrite it, so it proves nothing on its own —
    // this subcollection is the record that a send was agreed to, and the
    // rules allow create but never update or delete.
    batch.set(doc(collection(db, 'users', uid, 'consentEvents')), {
      granted: consent,
      channel: input.notifyChannel,
      notifyDaily: input.notifyDaily,
      notifyFeatured: input.notifyFeatured,
      interests: input.interests,
      at: serverTimestamp(),
      source: input.interestsSkipped ? 'onboarding-skip' : 'onboarding',
    });

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `users/${uid}`);
      throw err;
    }

    setCurrentUser(prev => ({
      ...prev,
      interests: input.interests,
      interestsSkipped: input.interestsSkipped,
      notifyDaily: input.notifyDaily,
      notifyFeatured: input.notifyFeatured,
      notifyChannel: input.notifyChannel,
    }));
  }, [currentUser]);

  const resetOnboarding = useCallback(async (userId?: string) => {
    const targetUserId = userId || (currentUser && currentUser.id !== 'unauthenticated' ? currentUser.id : null);
    if (targetUserId) {
      const userRef = doc(db, 'users', targetUserId);
      try {
        await updateDoc(userRef, { onboardingCompleted: false });
        if (currentUser && currentUser.id === targetUserId) {
          // Clear the session latch so the modal can re-show immediately after a reset
          sessionStorage.removeItem('mazad_onboarding_dismissed');
          setCurrentUser(prev => ({ ...prev, onboardingCompleted: false }));
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, `users/${targetUserId}`);
      }
    } else {
      localStorage.removeItem('mazad_local_onboarding_completed');
      sessionStorage.removeItem('mazad_onboarding_dismissed');
      setCurrentUser(prev => ({ ...prev, onboardingCompleted: false }));
    }
  }, [currentUser]);

  const markHintAsShown = useCallback(async (hintKey: string) => {
    const updatedHints = {
      ...(currentUser?.shownHints || {}),
      [hintKey]: true
    };

    if (currentUser && currentUser.id !== 'unauthenticated') {
      const userRef = doc(db, 'users', currentUser.id);
      try {
        await updateDoc(userRef, { shownHints: updatedHints });
        setCurrentUser(prev => ({ ...prev, shownHints: updatedHints }));
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, `users/${currentUser.id}`);
      }
    } else {
      localStorage.setItem('mazad_local_shown_hints', JSON.stringify(updatedHints));
      setCurrentUser(prev => ({ ...prev, shownHints: updatedHints }));
    }
  }, [currentUser]);

  // Trust System Operations Implementation
  const submitVerificationRequest = useCallback(async (
    requestedStatus: 'verified' | 'premium_verified', 
    notes?: string,
    idFrontUrl?: string,
    idBackUrl?: string,
    passportUrl?: string
  ) => {
    try {
      const id = `ver-req-${Date.now()}`;
      const reqData: VerificationRequest = {
        id,
        userId: currentUser.id,
        sellerName: currentUser.name,
        status: 'pending',
        requestedStatus,
        submittedAt: Date.now(),
        notes: notes || '',
        idFrontUrl: idFrontUrl || '',
        idBackUrl: idBackUrl || '',
        passportUrl: passportUrl || '',
        // These two were hardcoded STOCK PHOTOS (Unsplash placeholders left over
        // from the prototype). An admin opening a verification request saw a
        // stranger's photograph rendered as this seller's national ID and
        // business licence — a reviewer could approve on the strength of an
        // image that was never uploaded by anyone. Now empty when not supplied,
        // which is also what an OPTIONAL document must look like: absent.
        businessLicenseUrl: '',
        nationalIdUrl: ''
      };
      
      await setDoc(doc(db, 'sellerVerificationRequests', id), reqData);

      // Update the user document to pending in firestore
      await updateDoc(doc(db, 'users', currentUser.id), {
        verificationStatus: 'pending'
      });

      // Update seller profile status to pending
      const profileQuery = query(collection(db, 'sellerProfiles'), where('userId', '==', currentUser.id), limit(1));
      const profileSnap = await getDocs(profileQuery);
      if (!profileSnap.empty) {
        await updateDoc(profileSnap.docs[0].ref, {
          verificationStatus: 'pending'
        });
      }
      
      addNotification(
        language === 'ar' ? '📨 تم تقديم طلب التوثيق' : '📨 Verification Request Submitted',
        language === 'ar' ? 'طلبك قيد المراجعة الآن من قبل إدارة المنصة.' : 'Your request is now pending review by platform moderators.',
        'success'
      );
      return { success: true, message: 'Submitted successfully' };
    } catch (err: any) {
      console.error("Verification submit error:", err);
      return { success: false, message: err.message };
    }
  }, [currentUser, language, addNotification]);

  const submitSellerReview = useCallback(async (sellerId: string, auctionId: string, auctionTitle: string, rating: number, comment: string, photos?: string[]) => {
    try {
      const id = `rev-${Date.now()}`;
      const revData: Review = {
        id,
        sellerId,
        buyerId: currentUser.id,
        buyerName: currentUser.name,
        buyerAvatar: currentUser.avatar,
        rating,
        comment,
        timestamp: Date.now(),
        auctionTitle,
        auctionId,
        photos: photos || []
      };

      await setDoc(doc(db, 'reviews', id), revData);

      // Recalculate average rating for seller
      const allReviewsSnap = await getDocs(query(collection(db, 'reviews'), where('sellerId', '==', sellerId)));
      const reviewsList: Review[] = [];
      allReviewsSnap.forEach(d => reviewsList.push(d.data() as Review));
      if (!reviewsList.find(r => r.id === id)) {
        reviewsList.push(revData);
      }
      const averageRating = reviewsList.reduce((sum, r) => sum + r.rating, 0) / reviewsList.length;

      // Update the seller profile in Firestore
      const profileQuery = query(collection(db, 'sellerProfiles'), where('userId', '==', sellerId), limit(1));
      const profileSnap = await getDocs(profileQuery);
      if (!profileSnap.empty) {
        await updateDoc(profileSnap.docs[0].ref, {
          rating: parseFloat(averageRating.toFixed(1)),
          reviewCount: reviewsList.length
        });
      }

      addNotification(
        language === 'ar' ? '⭐ شكراً لتقييمك!' : '⭐ Thanks for your review!',
        language === 'ar' ? 'تمت إضافة تقييمك بنجاح إلى ملف البائع.' : 'Your rating was successfully added to the seller profile.',
        'success'
      );
      return { success: true, message: 'Review added successfully' };
    } catch (err: any) {
      console.error("Review submit error:", err);
      return { success: false, message: err.message };
    }
  }, [currentUser, language, addNotification]);

  const submitSellerReport = useCallback(async (sellerId: string, sellerName: string, reason: SellerReport['reason'], description: string) => {
    try {
      const id = `rep-${Date.now()}`;
      const repData: SellerReport = {
        id,
        reporterId: currentUser.id,
        reporterName: currentUser.name,
        sellerId,
        sellerName,
        reason,
        description,
        timestamp: Date.now(),
        status: 'pending'
      };

      await setDoc(doc(db, 'sellerReports', id), repData);

      addNotification(
        language === 'ar' ? '🚨 تم تقديم البلاغ' : '🚨 Report Submitted',
        language === 'ar' ? 'شكرًا لمساعدتنا في الحفاظ على أمان المنصة. ستقوم الإدارة بمراجعته.' : 'Thank you for helping keep our platform safe. Admins will review this report.',
        'info'
      );
      return { success: true, message: 'Report submitted' };
    } catch (err: any) {
      console.error("Report submit error:", err);
      return { success: false, message: err.message };
    }
  }, [currentUser, language, addNotification]);

  const submitDispute = useCallback(async (orderId: string, description: string, photos: string[], videos: string[]) => {
    try {
      const order = orders.find(o => o.id === orderId);
      if (!order) throw new Error("Order not found");

      const id = `disp-${Date.now()}`;
      const disputeData: Dispute = {
        id,
        orderId,
        buyerId: currentUser.id,
        buyerName: currentUser.name,
        sellerId: order.sellerId,
        sellerName: order.sellerName,
        amount: order.winningBidAmount,
        description,
        photos,
        videos,
        status: 'open',
        timestamp: Date.now()
      };

      await setDoc(doc(db, 'disputes', id), disputeData);
      
      await updateDoc(doc(db, 'orders', orderId), {
        status: 'disputed'
      });

      const disputeTitle = language === 'ar' ? '⚠️ تم فتح نزاع' : '⚠️ Dispute Opened';
      const disputeMsg = language === 'ar' ? 'تم تسجيل النزاع بنجاح. سيقوم المشرف بمراجعته والبت فيه.' : 'The dispute has been registered. An admin will review and resolve it.';
      addNotification(disputeTitle, disputeMsg, 'alert');
      // The 'alert' bucket is hidden from the user bell (Wave D) — confirm transiently.
      showToast({ title: disputeTitle, message: disputeMsg, type: 'success' });
      return { success: true, message: 'Dispute opened' };
    } catch (err: any) {
      console.error("Dispute submit error:", err);
      return { success: false, message: err.message };
    }
  }, [currentUser, orders, language, addNotification, showToast]);

  const respondToDispute = useCallback(async (disputeId: string, response: string) => {
    try {
      await updateDoc(doc(db, 'disputes', disputeId), {
        sellerResponse: response,
        sellerRespondedAt: Date.now()
      });

      addNotification(
        language === 'ar' ? '💬 تم تقديم الرد' : '💬 Response Submitted',
        language === 'ar' ? 'تم إرسال ردك على النزاع بنجاح إلى الإدارة.' : 'Your dispute response has been sent to the admins.',
        'success'
      );
      return { success: true, message: 'Responded successfully' };
    } catch (err: any) {
      console.error("Dispute respond error:", err);
      return { success: false, message: err.message };
    }
  }, [language, addNotification]);

  const respondToReview = useCallback(async (reviewId: string, response: string) => {
    try {
      await updateDoc(doc(db, 'reviews', reviewId), {
        response,
        responseAt: Date.now()
      });

      addNotification(
        language === 'ar' ? '💬 تم الرد على التقييم' : '💬 Review Replied',
        language === 'ar' ? 'تم نشر ردك على التقييم.' : 'Your response to the review has been posted.',
        'success'
      );
      return { success: true, message: 'Review response submitted' };
    } catch (err: any) {
      console.error("Review respond error:", err);
      return { success: false, message: err.message };
    }
  }, [language, addNotification]);

  const approveVerificationRequest = useCallback(async (requestId: string) => {
    try {
      const req = verificationRequests.find(r => r.id === requestId);
      if (!req) throw new Error("Verification request not found");

      await updateDoc(doc(db, 'sellerVerificationRequests', requestId), {
        status: 'approved'
      });

      await updateDoc(doc(db, 'users', req.userId), {
        isVerified: true,
        verificationStatus: req.requestedStatus
      });

      const profileQuery = query(collection(db, 'sellerProfiles'), where('userId', '==', req.userId), limit(1));
      const profileSnap = await getDocs(profileQuery);
      if (!profileSnap.empty) {
        await updateDoc(profileSnap.docs[0].ref, {
          isVerifiedMerchant: true,
          verificationStatus: req.requestedStatus,
          badges: ['Verified', req.requestedStatus === 'premium_verified' ? 'Premium Seller' : 'Verified']
        });
      }

      addNotification(
        '✅ Seller Verification Approved',
        `Approved seller ${req.sellerName} as ${req.requestedStatus.toUpperCase()}.`,
        'success'
      );
      return { success: true, message: 'Approved successfully' };
    } catch (err: any) {
      console.error("Approve verification request error:", err);
      return { success: false, message: err.message };
    }
  }, [verificationRequests, addNotification]);

  const rejectVerificationRequest = useCallback(async (requestId: string) => {
    try {
      const req = verificationRequests.find(r => r.id === requestId);
      if (!req) throw new Error("Verification request not found");

      await updateDoc(doc(db, 'sellerVerificationRequests', requestId), {
        status: 'rejected'
      });

      await updateDoc(doc(db, 'users', req.userId), {
        verificationStatus: 'not_verified'
      });

      const profileQuery = query(collection(db, 'sellerProfiles'), where('userId', '==', req.userId), limit(1));
      const profileSnap = await getDocs(profileQuery);
      if (!profileSnap.empty) {
        await updateDoc(profileSnap.docs[0].ref, {
          verificationStatus: 'not_verified'
        });
      }

      addNotification(
        '❌ Seller Verification Rejected',
        `Rejected verification request for seller ${req.sellerName}.`,
        'info'
      );
      return { success: true, message: 'Rejected successfully' };
    } catch (err: any) {
      console.error("Reject verification request error:", err);
      return { success: false, message: err.message };
    }
  }, [verificationRequests, addNotification]);

  const suspendSeller = useCallback(async (userId: string, suspend: boolean) => {
    try {
      const profileQuery = query(collection(db, 'sellerProfiles'), where('userId', '==', userId), limit(1));
      const profileSnap = await getDocs(profileQuery);
      if (!profileSnap.empty) {
        await updateDoc(profileSnap.docs[0].ref, {
          isSuspended: suspend
        });
      }

      await updateDoc(doc(db, 'users', userId), {
        isBlocked: suspend,
        accountStatus: suspend ? 'blocked' : 'active'
      });

      addNotification(
        '🚫 Seller Status Updated',
        `Seller ${suspend ? 'SUSPENDED' : 'ACTIVATED'} successfully.`,
        'success'
      );
      return { success: true, message: 'Seller status updated successfully' };
    } catch (err: any) {
      console.error("Suspend seller error:", err);
      return { success: false, message: err.message };
    }
  }, [addNotification]);

  const removeSellerBadge = useCallback(async (userId: string, badgeName: string) => {
    try {
      const profileQuery = query(collection(db, 'sellerProfiles'), where('userId', '==', userId), limit(1));
      const profileSnap = await getDocs(profileQuery);
      if (!profileSnap.empty) {
        const profileData = profileSnap.docs[0].data() as SellerProfile;
        const currentBadges = profileData.badges || [];
        const updatedBadges = currentBadges.filter(b => b !== badgeName);
        await updateDoc(profileSnap.docs[0].ref, {
          badges: updatedBadges
        });
      }

      addNotification(
        '🏅 Badge Removed',
        `Badge "${badgeName}" removed from seller profile.`,
        'info'
      );
      return { success: true, message: 'Badge removed' };
    } catch (err: any) {
      console.error("Remove badge error:", err);
      return { success: false, message: err.message };
    }
  }, [addNotification]);

  const resetSellerTrustScore = useCallback(async (userId: string) => {
    try {
      const profileQuery = query(collection(db, 'sellerProfiles'), where('userId', '==', userId), limit(1));
      const profileSnap = await getDocs(profileQuery);
      if (!profileSnap.empty) {
        await updateDoc(profileSnap.docs[0].ref, {
          trustScore: 50
        });
      }

      addNotification(
        '♻️ Trust Score Reset',
        `Reset seller trust score to 50 (baseline).`,
        'success'
      );
      return { success: true, message: 'Trust score reset' };
    } catch (err: any) {
      console.error("Reset trust score error:", err);
      return { success: false, message: err.message };
    }
  }, [addNotification]);

  const visibleAuctions = useMemo(() => {
    const base = auctions.filter(a => !deletedAuctionIds.includes(a.id));
    // Merge the seller's own pending lots, de-duped by id (the optimistic
    // insert on createListing can already have it in `auctions`), so the
    // seller's under-review lot renders exactly once.
    let merged = base;
    if (ownPendingAuctions.length > 0) {
      const seen = new Set(base.map(a => a.id));
      const extras = ownPendingAuctions.filter(a => !seen.has(a.id) && !deletedAuctionIds.includes(a.id));
      if (extras.length > 0) merged = [...base, ...extras];
    }
    // Wave 3 (simulator visibility) — THE choke point for every surface that
    // consumes context `auctions` (Discovery grid/tabs, LiveStreamView,
    // auctionPhase helpers, social-proof live counts, win detection…):
    // simulated lots are dropped for everyone except an admin with the
    // simulator toggle ON. Exception: ADMIN mode (Admin dashboard / Seller
    // Center / Drop Builder subscription) for a real admin stays UNFILTERED —
    // the approval queue and admin management lists must show everything
    // regardless of the toggle (hiding is for buyer surfaces, not admin
    // tooling; admin metric cards exclude isSimulated themselves). Non-admins
    // in admin mode (sellers in Seller Center) still get the filter —
    // real users must never see simulated data through ANY path.
    if (auctionSubMode === 'admin' && isAdminUser(currentUser)) return merged;
    return filterSimulated(merged, currentUser, simEnabled);
  }, [auctions, ownPendingAuctions, deletedAuctionIds, auctionSubMode, currentUser, simEnabled]);

  // Wave 3 (simulator visibility + metric hygiene): simulated orders are
  // dropped at the source for everyone except an admin with the toggle ON —
  // a real user must never see a simulated order in My Orders / wallet /
  // review prompts, and the admin Orders tab only shows test orders while
  // the simulator is actually on (flip it off → clean real book).
  const visibleOrders = useMemo(
    () => filterSimulated(orders, currentUser, simEnabled),
    [orders, currentUser, simEnabled]
  );

  // Separate, chatMessages-only context value (see ChatContext above).
  // Memoized on [chatMessages] alone (setChatMessages is a stable useState
  // setter) so it only changes identity when the chat list actually changes.
  const chatValue = useMemo<ChatContextProps>(
    () => ({ chatMessages, setChatMessages }),
    [chatMessages]
  );

  // Separate, auctions-only context value (see AuctionsContext above).
  // Memoized on [visibleAuctions, auctionsLoaded] (setAuctions is a stable
  // useState setter) so a bid snapshot changes ONLY this context's identity —
  // the main appValue below no longer lists visibleAuctions/auctionsLoaded in
  // its deps, so its identity survives auction churn untouched.
  const auctionsValue = useMemo<AuctionsContextProps>(
    () => ({ auctions: visibleAuctions, setAuctions, auctionsLoaded }),
    [visibleAuctions, auctionsLoaded]
  );

  // Perf (Wave 3c / P0-1): memoize the main context value. Previously this
  // ~100-field object literal was recreated on EVERY AppProvider render, so
  // any state change (or a parent re-render) gave the value a new identity and
  // re-rendered all ~39 useApp() consumers even when nothing they read changed.
  // The dep array below lists every NON-stable field: all state/memo values
  // plus every useCallback. Raw useState setters are intentionally omitted —
  // React guarantees their identity is stable, so listing them adds nothing.
  // Now that chatMessages lives in its own ChatContext, a chat write touches
  // none of these deps, so the value identity is preserved across chat churn.
  const appValue = useMemo<AppContextProps>(() => ({
      currentUser, setCurrentUser,
      sellerProfile, setSellerProfile,
      users, setUsers,
      theme,
      setTheme,
      usersTotalCount,
      auctionsTotalCount,
      sellerProfiles, setSellerProfiles,
      bids, setBids,
      wallet, setWallet,
      escrows, setEscrows,
      orders: visibleOrders, setOrders,
      notifications, setNotifications,
      adminActions, setAdminActions,
      adminActionsError,
      reviews,
      verificationRequests,
      sellerReports,
      disputes,
      myReviews,
      pendingReviewOrder,
      reviewPromptOrderId,
      setReviewPromptOrderId,
      activeAuctionId, setActiveAuctionId,
      activeView, setActiveView,
      globalWalletSubView, setGlobalWalletSubView,
      globalSelectedOrderId, setGlobalSelectedOrderId,
      placeBid,
      bidCooldownUntil,
      requestWithdrawal,
      acceptBelowReserve,
      rejectBelowReserve,
      confirmBelowReserve,
      declineBelowReserve,
      respondToSecondChance,
      requestReturn,
      sellerRespondToReturn,
      rateBuyer,
      rateAuction,
      addNotification,
      markAsRead,
      markAllAsRead,
      approveListing,
      setAuctionViewing,
      rejectListing,
      verifySeller,
      banUser,
      unbanUser,
      releaseEscrow,
      refundEscrow,
      deleteAuction,
      repairEndedAuctionOrder,
      repairStuckEscrowsForEndedAuction,
      approveWithdrawal,
      rejectWithdrawal,
      createListing,
      language,
      setLanguage,
      isAuthenticated,
      authReady,
      isGuest: authReady && !isAuthenticated,
      signInRequested,
      signInIntent,
      requestSignIn,
      dismissSignIn,
      login,
      loginWithGoogle,
      loginWithPhone,
      confirmPhoneCode,
      requestWhatsappOtp,
      verifyWhatsappOtp,
      signInWhatsapp,
      linkPhoneSendCode,
      linkPhoneToAccount,
      attachWhatsappPhone,
      saveEmail,
      profileFieldPrompt,
      setProfileFieldPrompt,
      contactModalOpen,
      setContactModalOpen,
      logout,
      registerUser,
      subscribeUser,
      updateOwnProfile,
      completeOnboarding,
      saveInterests,
      resetOnboarding,
      markHintAsShown,
      watchlist,
      toggleWatchlist,
      autoBids,
      setAutoBid,
      removeAutoBid,
      showSubscriptionPrompt,
      setShowSubscriptionPrompt,
      showPhotoGate,
      setShowPhotoGate,
      showBanNotice,
      setShowBanNotice,
      showNotifications,
      setShowNotifications,
      sendChatMessage,
      maintenanceMode,
      featureFlags,
      updateMaintenanceMode,
      updateFeatureFlag,
      systemHealthLogs,
      logSystemHealth,
      submitVerificationRequest,
      submitSellerReview,
      submitSellerReport,
      submitDispute,
      respondToDispute,
      respondToReview,
      approveVerificationRequest,
      rejectVerificationRequest,
      suspendSeller,
      removeSellerBadge,
      resetSellerTrustScore
  }), [
    // State / memo values (auctions/auctionsLoaded intentionally NOT here —
    // they live in AuctionsContext so bid churn can't touch this identity)
    theme, setTheme,
    currentUser, sellerProfile, users, usersTotalCount, auctionsTotalCount, sellerProfiles,
    bids, wallet, escrows, visibleOrders, notifications,
    adminActions, adminActionsError, reviews, verificationRequests,
    sellerReports, disputes, myReviews, pendingReviewOrder, reviewPromptOrderId,
    activeAuctionId, activeView, globalWalletSubView, globalSelectedOrderId,
    language, isAuthenticated, authReady, signInRequested, signInIntent, watchlist, autoBids,
    showSubscriptionPrompt, showPhotoGate, showBanNotice, profileFieldPrompt, contactModalOpen, showNotifications, maintenanceMode, featureFlags,
    systemHealthLogs,
    // Callbacks (all useCallback — stable unless their own deps change)
    placeBid, bidCooldownUntil, requestWithdrawal, acceptBelowReserve, rejectBelowReserve, confirmBelowReserve, declineBelowReserve, respondToSecondChance, requestReturn, sellerRespondToReturn, rateBuyer, rateAuction, addNotification, markAsRead,
    markAllAsRead, approveListing, rejectListing, verifySeller, banUser,
    unbanUser, releaseEscrow, refundEscrow, deleteAuction, repairEndedAuctionOrder,
    repairStuckEscrowsForEndedAuction, approveWithdrawal, rejectWithdrawal,
    createListing, setLanguage, requestSignIn, dismissSignIn, login, loginWithGoogle, loginWithPhone,
    confirmPhoneCode, requestWhatsappOtp, verifyWhatsappOtp, signInWhatsapp, linkPhoneSendCode, linkPhoneToAccount, attachWhatsappPhone, saveEmail,
    logout, registerUser, subscribeUser, updateOwnProfile,
    completeOnboarding, saveInterests, resetOnboarding, markHintAsShown, toggleWatchlist,
    setAutoBid, removeAutoBid, sendChatMessage, updateMaintenanceMode,
    updateFeatureFlag, logSystemHealth, submitVerificationRequest,
    submitSellerReview, submitSellerReport, submitDispute, respondToDispute,
    respondToReview, approveVerificationRequest,
    rejectVerificationRequest, suspendSeller, removeSellerBadge,
    resetSellerTrustScore,
  ]);

  return (
    <AppContext.Provider value={appValue}>
      <AuctionsContext.Provider value={auctionsValue}>
        <ChatContext.Provider value={chatValue}>
          {children}
        </ChatContext.Provider>
      </AuctionsContext.Provider>
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};

// Perf (Wave 3c): read the high-churn chat list from its own context so a chat
// write only re-renders the in-room components (LiveStreamView /
// ReelsDesktopRightPanel), not every useApp() consumer. Provided from inside
// AppProvider, so the same "must be used within an AppProvider" contract holds.
// Perf (Wave 3c / PF2): read the high-churn auctions list from its own context
// so a bid snapshot only re-renders auction surfaces (Discovery, live room,
// stories bar, admin/seller lists), not every useApp() consumer. Provided from
// inside AppProvider, so the same "must be used within an AppProvider"
// contract holds. Components that read BOTH auctions and other app state
// simply subscribe to both contexts.
export const useAuctions = () => {
  const context = useContext(AuctionsContext);
  if (!context) {
    throw new Error('useAuctions must be used within an AppProvider');
  }
  return context;
};

export const useChat = () => {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used within an AppProvider');
  }
  return context;
};
