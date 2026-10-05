import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { ActionCenterSection } from './admin/ActionCenterSection';
import { buildActionQueue } from '../utils/actionQueue';
import { useAdminAction } from '../hooks/useAdminAction';
import { visibleRows } from '../utils/adminActionState';
import type { ViewingMode } from '../utils/viewing';
import { useApp, useAuctions } from '../context/AppContext';
import { translations } from '../utils/translations';
import { isAdminUser } from '../utils/adminAuth';
import { isPendingOrderPayment } from '../utils/paymentReceipt';
import { isOverdue } from '../utils/fulfillmentQueues';
import { executeOrderTransition } from '../utils/orderWorkflow';
import { nextAdvance } from '../utils/orderAdvance';
import { OrderDetailsView } from './OrderDetailsView';
import { collection, onSnapshot, doc, updateDoc, addDoc, query, where, limit, orderBy, Timestamp } from 'firebase/firestore';
import { db, getCallableFunction } from '../services/firebase';
import {
  type AdminTabId,
  ADMIN_PRIMARY_TABS,
  ADMIN_REFERENCE_TABS,
  ADMIN_TAB_DEFAULT,
  migrateStoredAdminTab,
} from '../utils/adminNav';
import { ShieldCheck } from 'lucide-react';

// Lazy: the Verify & Approve section (Slice B). The pending-count badge only needs the tiny paymentReceipt util,
// so the heavy section stays out of the main chunk until the tab opens.
const OurDropsSection = React.lazy(() => import('./admin/OurDropsSection'));
const OrdersLedgerSection = React.lazy(() => import('./admin/OrdersLedgerSection'));
const MembersSection = React.lazy(() => import('./admin/MembersSection'));
const FeaturedSection = React.lazy(() => import('./admin/FeaturedSection'));
const AuctionLookupSection = React.lazy(() => import('./admin/AuctionLookupSection'));
const AuditLogSection = React.lazy(() => import('./admin/AuditLogSection'));
const SystemSection = React.lazy(() => import('./admin/SystemSection'));

/**
 * Normalize any timestamp shape we store (Firestore Timestamp, {seconds},
 * ISO string, epoch ms) to epoch milliseconds. Returns 0 when unparseable.
 */
const tsToMillis = (v: any): number => {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v?.toMillis === 'function') return v.toMillis();
  if (typeof v?.toDate === 'function') return v.toDate().getTime();
  if (typeof v?.seconds === 'number') return v.seconds * 1000;
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
};

type StatusSeverity = 'ok' | 'warn' | 'bad' | 'neutral';

// ── Active-tab persistence ───────────────────────────────────────────────
// The dashboard occasionally remounts mid-session (live E2E finding), which
// reset the useState tab back to GENERAL METRICS. The active tab is therefore
// mirrored into sessionStorage and restored (validated) on mount.
const ADMIN_TAB_STORAGE_KEY = 'mazad_admin_tab';

function readStoredAdminTab(): AdminTabId {
  try {
    return migrateStoredAdminTab(sessionStorage.getItem(ADMIN_TAB_STORAGE_KEY));
  } catch {
    return ADMIN_TAB_DEFAULT; // storage unavailable — session-local only
  }
}

// Bilingual labels for every nav tab, keyed by AdminTabId.
const TAB_META: Record<AdminTabId, { ar: string; en: string }> = {
  'action-center': { ar: 'مركز الإجراءات', en: 'ACTION CENTER' },
  'our-drops': { ar: 'مزاداتنا', en: 'OUR DROPS' },
  orders: { ar: 'الطلبات', en: 'ORDERS' },
  members: { ar: 'الأعضاء', en: 'MEMBERS' },
  'auction-lookup': { ar: 'بحث المزادات', en: 'Auction Lookup' },
  audit: { ar: 'السجل', en: 'AUDIT LOG' },
  system: { ar: 'النظام', en: 'SYSTEM' },
};

export const AdminDashboardView: React.FC = () => {
  const {
    currentUser,
    users,
    usersTotalCount,
    auctionsTotalCount,
    escrows,
    orders,
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
    language,
    maintenanceMode,
    featureFlags,
    updateMaintenanceMode,
    updateFeatureFlag,
    systemHealthLogs,
    logSystemHealth,
    setBids,
    resetOnboarding,
    setActiveView,
    adminActions
  } = useApp();
  const { auctions } = useAuctions();

  const t = translations[language];
  const isAr = language === 'ar';

  const isRealUrl = (url?: string) => {
    if (!url) return false;
    const clean = url.trim();
    return clean.startsWith('http://') || 
           clean.startsWith('https://') || 
           clean.startsWith('data:') || 
           (clean.length > 30 && /^[A-Za-z0-9+/=]+$/.test(clean.substring(0, 30)));
  };

  const getReceiptImageSrc = (url?: string): string => {
    if (!url) return '';
    const clean = url.trim();
    if (clean.startsWith('http://') || clean.startsWith('https://') || clean.startsWith('data:')) {
      return clean;
    }
    return `data:image/png;base64,${clean}`;
  };

  const [activeTab, setActiveTab] = useState<AdminTabId>(readStoredAdminTab);
  // Every tab selection goes through here so it survives remounts.
  const selectTab = (tab: AdminTabId) => {
    setActiveTab(tab);
    try {
      sessionStorage.setItem(ADMIN_TAB_STORAGE_KEY, tab);
    } catch {
      /* storage unavailable — selection stays session-local */
    }
  };
  const [pendingWithdrawals, setPendingWithdrawals] = useState<any[]>([]);
  const [historyWithdrawals, setHistoryWithdrawals] = useState<any[]>([]);
  const allWithdrawals = [
    ...pendingWithdrawals,
    ...historyWithdrawals.filter((hw) => !pendingWithdrawals.some((pw) => pw.id === hw.id))
  ].sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0));
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState<string>('');

  const [adminOrderFilter, setAdminOrderFilter] = useState<'all' | 'waiting_payment' | 'paid' | 'preparing_shipment' | 'out_for_delivery' | 'shipped' | 'delivered' | 'completed' | 'disputed' | 'defaulted'>('all');
  const [adminSelectedOrderId, setAdminSelectedOrderId] = useState<string | null>(null);

  const filteredOrders = (orders || []).filter((o: any) => {
    if (adminOrderFilter === 'all') return true;
    return o.status === adminOrderFilter;
  });

  // ── Health status board ──────────────────────────────────────────────────
  // system_status/current is written by the pollN8nHealth Cloud Function every
  // 15 minutes; null means the doc doesn't exist yet (pre-first-poll).
  const [systemStatus, setSystemStatus] = useState<any | null>(null);
  // Ticker so the time-derived signals (stuck auctions / unpaid >48h /
  // settlement freshness) stay honest even when no snapshot fires.
  const [healthNow, setHealthNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'system_status', 'current'), (snap) => {
      setSystemStatus(snap.exists() ? snap.data() : null);
    }, (err) => {
      console.warn('[HEALTH] system_status subscription failed:', err);
    });
    const tick = setInterval(() => setHealthNow(Date.now()), 30000);
    return () => { unsub(); clearInterval(tick); };
  }, []);

  // Wave 3 metric hygiene: simulator test data must never inflate REAL
  // numbers. Context `auctions` is deliberately unfiltered in admin mode and
  // `orders` includes simulated orders while the toggle is ON, so every
  // metric/health computation below reads these sim-free views instead.
  const realAuctions = (auctions || []).filter((a: any) => a.isSimulated !== true);
  const realOrders = (orders || []).filter((o: any) => o.isSimulated !== true);
  const simOrdersCount = (orders || []).length - realOrders.length;

  // Auctions the settlement cron should already have closed: still live/active
  // but ended more than 2 minutes ago.
  const stuckAuctions = realAuctions.filter((a: any) => {
    if (a.status !== 'live' && a.status !== 'active') return false;
    const endMs = tsToMillis(a.endTime) || tsToMillis(a.endsAt);
    return endMs > 0 && endMs < healthNow - 2 * 60 * 1000;
  });

  // Orders still unpaid more than 48h after creation.
  const stuckOrders = realOrders.filter((o: any) => {
    if (o.status !== 'waiting_payment') return false;
    const createdMs = tsToMillis(o.createdAt);
    return createdMs > 0 && createdMs < healthNow - 48 * 60 * 60 * 1000;
  });

  // Coarse "settlement cron is alive" signal: either nothing was due to close,
  // or the most recent settlement happened within the last ~10 minutes of an
  // auction actually ending (no stuck auctions means the closer is keeping up).
  const anyAuctionsDue = realAuctions.some((a: any) => {
    if (a.status !== 'live' && a.status !== 'active') return false;
    const endMs = tsToMillis(a.endTime) || tsToMillis(a.endsAt);
    return endMs > 0 && endMs < healthNow;
  });
  // NOTE: a simulateSettleNow on a test lot must not fake closer-cron
  // freshness (masking a real stall), so this also reads realAuctions.
  const lastSettledMs = Math.max(0, ...realAuctions.map((a: any) => tsToMillis(a.settledAt)));
  const settlementFresh =
    (!anyAuctionsDue && stuckAuctions.length === 0) ||
    (lastSettledMs > 0 && lastSettledMs > healthNow - 10 * 60 * 1000);

  const n8nBot = systemStatus?.n8n?.bot;
  const n8nNotif = systemStatus?.n8n?.notifications;
  // The OTP relay sits on the sign-in path, so its silence is the most
  // expensive of the three — and it was the one nobody was watching.
  const n8nOtp = systemStatus?.n8n?.otp;
  const statusAsOfMs = tsToMillis(systemStatus?.updatedAt);

  /**
   * Red at 20%, matching the server's incident threshold in
   * functions/n8nHealth.js. It used to be 25% here, so a 21-25% rate wrote an
   * incident into system_health while this card still showed amber — the board
   * disagreeing with the alarm it is meant to explain.
   * healthThresholds.parity.test.ts pins the two together.
   */
  const rateSeverity = (stats: any): StatusSeverity => {
    if (!stats || typeof stats.failureRate !== 'number') return 'neutral';
    // SILENCE IS NOT HEALTH. A workflow with no executions reports
    // failureRate 0 — a number — so without this it rendered a green 0%.
    // That is exactly how a retired workflow id passed for five weeks of
    // perfect health, and reproducing it here would have undone the fix.
    if (stats.neverRan) return 'bad';
    if (stats.failureRate > 0.20) return 'bad';
    // Ran before, nothing in the window. Worth a look, not worth an alarm.
    if (stats.quiet) return 'warn';
    if (stats.failureRate >= 0.10) return 'warn';
    return 'ok';
  };
  const rateValue = (stats: any): string => {
    if (!stats || typeof stats.failureRate !== 'number') return '—';
    // "0%" next to "no executions" reads as success. Say nothing ran instead.
    if (stats.neverRan) return isAr ? 'لا شيء' : 'none';
    return `${Math.round(stats.failureRate * 100)}%`;
  };
  const rateSubtext = (stats: any): string => {
    if (!stats) return isAr ? 'بانتظار أول فحص' : 'awaiting first check';
    const asOf = statusAsOfMs || tsToMillis(stats.checkedAt);
    const asOfStr = asOf ? new Date(asOf).toLocaleTimeString(isAr ? 'ar-JO' : 'en-US') : '';
    if (stats.neverRan) {
      const none = isAr ? 'لا تنفيذات — تحقّق من المعرّف والتفعيل' : 'no executions — check the id and that it is active';
      return asOfStr ? `${none} · ${isAr ? 'حتى' : 'as of'} ${asOfStr}` : none;
    }
    // Name the window: the rate used to cover "the last 100 runs ever", which
    // is not a question anyone was asking of a health board.
    const hours = typeof stats.windowHours === 'number' ? stats.windowHours : 24;
    const runs = stats.quiet
      ? (isAr ? `ولا تشغيلة خلال ${hours} ساعة` : `no runs in ${hours}h`)
      : (isAr ? `${stats.total} تشغيلة خلال ${hours} ساعة` : `${stats.total} runs in ${hours}h`);
    return asOfStr ? `${runs} · ${isAr ? 'حتى' : 'as of'} ${asOfStr}` : runs;
  };
  // ─────────────────────────────────────────────────────────────────────────

  const [isLoading, setIsLoading] = useState<boolean>(false);

  useEffect(() => {
    setIsLoading(true);
    const timer = setTimeout(() => setIsLoading(false), 500);
    return () => clearTimeout(timer);
  }, [activeTab]);

  const [subscriptionRequests, setSubscriptionRequests] = useState<any[]>([]);
  const [viewReceiptUrl, setViewReceiptUrl] = useState<string | null>(null);

  useEffect(() => {
    const isStrictAdmin = isAdminUser(currentUser);
    if (!isStrictAdmin) {
      setSubscriptionRequests([]);
      return;
    }
    const unsub = onSnapshot(collection(db, 'subscriptionRequests'), (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setSubscriptionRequests(list.filter((r: any) => r.subscriptionStatus === 'pending' || r.status === 'pending'));
    }, (err) => {
      console.warn("Firestore subscriptionRequests query failed with permission or other error:", err);
    });
    return () => unsub();
  }, [currentUser]);

  useEffect(() => {
    const isStrictAdmin = isAdminUser(currentUser);
    if (!isStrictAdmin) {
      setPendingWithdrawals([]);
      setHistoryWithdrawals([]);
      return;
    }

    const qPending = query(
      collection(db, 'withdrawals'),
      where('status', '==', 'pending_review'),
      limit(100)
    );

    const unsubPending = onSnapshot(qPending, (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setPendingWithdrawals(list);
    }, (err) => {
      console.warn("Firestore pending withdrawals query failed with permission or other error:", err);
    });

    const qHistory = query(
      collection(db, 'withdrawals'),
      where('status', 'in', ['completed', 'rejected']),
      orderBy('timestamp', 'desc'),
      limit(50)
    );

    const unsubHistory = onSnapshot(qHistory, (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setHistoryWithdrawals(list);
    }, (err) => {
      console.warn("Firestore history withdrawals query failed with permission or other error:", err);
    });

    return () => {
      unsubPending();
      unsubHistory();
    };
  }, [currentUser]);

  // Wave 1 S3 — grants are SERVER-ONLY. The approveSubscription callable is
  // the sole writer of the user subscription fields (rules block all client
  // writes, this admin dashboard included). It re-derives the duration from
  // the request's verified amount / canonical tier and logs the conversion.
  const approveSubscription = async (request: any) => {
    try {
      const approveCallable = await getCallableFunction<
        { reqId: string },
        { success: boolean; alreadyApproved?: boolean; tier?: string; durationDays?: number }
      >('approveSubscription');
      await approveCallable({ reqId: request.id });

      alert(isAr
        ? `🎉 تم تفعيل اشتراك المستخدم (${request.userName || request.userEmail || 'المشترك'}) بنجاح!` 
        : `🎉 User subscription (${request.userName || request.userEmail || 'Subscriber'}) has been activated successfully!`
      );
    } catch (err: any) {
      console.error("Error approving subscription:", err);
      alert(isAr 
        ? `❌ فشل تفعيل الاشتراك: ${err.message || String(err)}` 
        : `❌ Failed to activate subscription: ${err.message || String(err)}`
      );
    }
  };

  // Direct (comped) activation — also server-only via the same callable
  // (defaults to the 30-day monthly tier; duration comes from the canonical
  // tier table on the server).
  const approveUserDirect = async (user: any) => {
    try {
      const approveCallable = await getCallableFunction<
        { userId: string },
        { success: boolean }
      >('approveSubscription');
      await approveCallable({ userId: user.id });

      alert(isAr
        ? `🎉 تم التفعيل الفوري لحساب العضو (${user.name || user.email}) بنجاح!` 
        : `🎉 Direct VIP status has been granted to user (${user.name || user.email}) successfully!`
      );
    } catch (err: any) {
      console.error("Error direct approving user:", err);
      alert(isAr 
        ? `❌ فشل التفعيل المباشر: ${err.message || String(err)}` 
        : `❌ Failed to directly approve user: ${err.message || String(err)}`
      );
    }
  };

  // Wave 1 S3 — the user subscription fields are locked to the server, so the
  // downgrade goes through the admin-only rejectSubscription callable.
  const rejectUserDirect = async (user: any) => {
    try {
      const rejectCallable = await getCallableFunction<
        { userId: string },
        { success: boolean }
      >('rejectSubscription');
      await rejectCallable({ userId: user.id });

      alert(isAr
        ? `⚠️ تم رفض تفعيل العضو (${user.name || user.email}).` 
        : `⚠️ User (${user.name || user.email}) activation has been rejected.`
      );
    } catch (err: any) {
      console.error("Error rejecting user:", err);
      alert(isAr 
        ? `❌ فشل رفض التفعيل: ${err.message || String(err)}` 
        : `❌ Failed to reject user activation: ${err.message || String(err)}`
      );
    }
  };

  // Wave 1 S3 — server-side reject: marks the request rejected and downgrades
  // the user ONLY if they are still pending (rejecting a duplicate/stale
  // request never wipes an already-active membership — enforced in the
  // rejectSubscription Cloud Function).
  const rejectSubscription = async (request: any, reason?: string) => {
    try {
      const rejectCallable = await getCallableFunction<
        { reqId: string; reason?: string },
        { success: boolean; userDowngraded?: boolean }
      >('rejectSubscription');
      await rejectCallable({ reqId: request.id, ...(reason ? { reason } : {}) });

      alert(isAr
        ? `⚠️ تم رفض طلب الاشتراك للعضو (${request.userName || request.userEmail}) بنجاح.` 
        : `⚠️ Subscription request for (${request.userName || request.userEmail}) has been rejected.`
      );
    } catch (err: any) {
      console.error("Error rejecting subscription:", err);
      alert(isAr 
        ? `❌ فشل رفض الطلب: ${err.message || String(err)}` 
        : `❌ Failed to reject subscription: ${err.message || String(err)}`
      );
    }
  };

  // Slice B — order-payment verification is SERVER-ONLY (rules deny client
  // writes to paymentVerified*); both actions go through the admin-only
  // verifyOrderPayment callable.
  const handleVerifyOrderPayment = async (orderId: string) => {
    try {
      const verifyCallable = await getCallableFunction<
        { orderId: string; action: 'verify' | 'reject'; reason?: string },
        { success: boolean; alreadyVerified?: boolean }
      >('verifyOrderPayment');
      await verifyCallable({ orderId, action: 'verify' });

      alert(isAr
        ? '✅ تم تأكيد استلام الدفعة وتوثيقها على الطلب.'
        : '✅ Payment marked verified on the order.'
      );
    } catch (err: any) {
      console.error('Error verifying order payment:', err);
      alert(isAr
        ? `❌ فشل تأكيد الدفع: ${err.message || String(err)}`
        : `❌ Failed to verify payment: ${err.message || String(err)}`
      );
    }
  };

  const handleRejectOrderPayment = async (orderId: string, reason: string) => {
    try {
      const verifyCallable = await getCallableFunction<
        { orderId: string; action: 'verify' | 'reject'; reason?: string },
        { success: boolean }
      >('verifyOrderPayment');
      await verifyCallable({ orderId, action: 'reject', reason });

      alert(isAr
        ? '⚠️ تم رفض إثبات الدفع وإرجاع الطلب إلى انتظار الدفع.'
        : '⚠️ Payment proof rejected — order returned to waiting for payment.'
      );
    } catch (err: any) {
      console.error('Error rejecting order payment:', err);
      alert(isAr
        ? `❌ فشل رفض إثبات الدفع: ${err.message || String(err)}`
        : `❌ Failed to reject payment proof: ${err.message || String(err)}`
      );
    }
  };

  const handleSendFulfillmentNudge = async (orderId: string, kind: 'ship' | 'confirm_delivery') => {
    try {
      const nudgeCallable = await getCallableFunction<
        { orderId: string; kind: 'ship' | 'confirm_delivery' },
        { success: boolean; targetUserName?: string }
      >('sendFulfillmentNudge');
      await nudgeCallable({ orderId, kind });
      alert(isAr ? '✅ تم إرسال التذكير.' : '✅ Nudge sent.');
    } catch (err: any) {
      console.error('Error sending fulfillment nudge:', err);
      alert(isAr ? `❌ فشل إرسال التذكير: ${err.message || String(err)}` : `❌ Failed to send nudge: ${err.message || String(err)}`);
    }
  };

  // Advance an order one stage by hand. The admin team runs this relay by
  // phone; executeOrderTransition already validates the FSM, writes the
  // activity + adminActions records, and notifies buyer and seller.
  const handleAdvanceOrder = useCallback(async (order: any, note: string) => {
    const advance = nextAdvance(order?.status);
    if (!advance) return { success: false, message: 'No next stage for this order.' };
    try {
      await executeOrderTransition(order, advance.action, currentUser as any, { note });
      return { success: true };
    } catch (err: any) {
      console.error('[handleAdvanceOrder] failed:', err);
      return { success: false, message: err?.message || 'Update failed.' };
    }
  }, [currentUser]);

  // Record a call with NO status transition. The relay is run by phone, and the
  // buckets with no next stage (awaiting_payment, awaiting_release) generate the
  // most calls of all — "buyer says he'll transfer tonight" has to be writable
  // without pretending the order moved.
  //
  // Written directly rather than through executeOrderTransition because there is
  // no transition to run: same subcollection and same shape that function's note
  // write uses, minus action/fromStatus/toStatus, which would be lies here.
  // Admin-gated locally to match it (firestore.rules gates adminNotes on
  // isAdmin() for read AND write, so this is defence in depth, not the check).
  const handleLogOrderNote = useCallback(async (orderId: string, note: string) => {
    if (!isAdminUser(currentUser)) return { success: false, message: 'Admins only.' };
    const trimmed = (note || '').trim();
    if (!trimmed) return { success: false, message: 'A note is required.' };
    try {
      await addDoc(collection(db, 'orders', orderId, 'adminNotes'), {
        note: trimmed,
        performedBy: currentUser?.id,
        performedByName: currentUser?.name || 'Admin',
        timestamp: Timestamp.now(),
      });
      return { success: true };
    } catch (err: any) {
      console.error('[handleLogOrderNote] failed:', err);
      return { success: false, message: err?.message || 'Could not save the note.' };
    }
  }, [currentUser]);

  // Assignment is admin-only bookkeeping, NOT a workflow transition: it is
  // written with its own explicit updateDoc because executeOrderTransition's
  // extraFields would silently drop these fields.
  const handleAssignOrder = useCallback(async (orderId: string, adminId: string, adminName: string) => {
    if (!isAdminUser(currentUser)) return { success: false, message: 'Admins only.' };
    try {
      await updateDoc(doc(db, 'orders', orderId), {
        assignedToId: adminId,
        assignedToName: adminName,
      });
      return { success: true };
    } catch (err: any) {
      console.error('[handleAssignOrder] failed:', err);
      return { success: false, message: err?.message || 'Assign failed.' };
    }
  }, [currentUser]);

  // Team members who can be assigned an order to chase.
  const adminUsers = useMemo(
    () => (users || []).filter((u: any) => isAdminUser(u)).map((u: any) => ({ id: u.id, name: u.name || u.email || u.id })),
    [users],
  );

  const handleFulfillmentReleaseEscrow = async (orderId: string) => {
    // Releasing escrow pays the seller and cannot be undone from this screen —
    // and the button sits in the exact position the harmless "Nudge" button
    // occupies one bucket above, so a mis-aimed click is a plausible way to
    // move real money. Name the order and the amount and make them say yes.
    const order = realOrders.find((o: any) => o.id === orderId);
    const title = order?.auctionTitle || orderId;
    const amount = typeof order?.winningBidAmount === 'number'
      ? `${order.winningBidAmount.toLocaleString()} JOD`
      : (isAr ? 'مبلغ غير معروف' : 'unknown amount');
    const confirmed = window.confirm(isAr
      ? `تحرير الضمان ودفع ${amount} للبائع مقابل «${title}»؟\nلا يمكن التراجع عن هذه العملية.`
      : `Release escrow and pay the seller ${amount} for "${title}"?\nThis cannot be undone.`
    );
    if (!confirmed) return;
    try {
      const releaseCallable = await getCallableFunction<
        { orderId: string; action: 'admin_release' },
        { success: boolean; message?: string }
      >('releaseOrderEscrow');
      await releaseCallable({ orderId, action: 'admin_release' });
      alert(isAr ? '✅ تم تحرير المبلغ.' : '✅ Escrow released.');
    } catch (err: any) {
      console.error('Error releasing escrow:', err);
      alert(isAr ? `❌ فشل تحرير المبلغ: ${err.message || String(err)}` : `❌ Failed to release escrow: ${err.message || String(err)}`);
    }
  };

  const handleResolveDispute = async (orderId: string, resolutionType: 'release' | 'refund' | 'resume', notes: string) => {
    const order = realOrders.find((o: any) => o.id === orderId);
    if (!order) {
      alert(isAr ? 'تعذر العثور على الطلب.' : 'Order not found.');
      return;
    }
    try {
      // 1. The REAL resolution — untouched, existing engine (money moves here).
      await executeOrderTransition(order, 'resolve_dispute', currentUser, { resolutionType });
      // 2. ONLY on success: record the admin's note. A failure here must never
      // read as if the resolution itself failed — it already succeeded.
      try {
        const stampCallable = await getCallableFunction<
          { orderId: string; resolutionType: 'release' | 'refund' | 'resume'; notes: string },
          { success: boolean }
        >('stampDisputeResolution');
        await stampCallable({ orderId, resolutionType, notes });
      } catch (stampErr: any) {
        console.warn('[handleResolveDispute] resolution succeeded but the note failed to save:', stampErr);
        alert(isAr
          ? '✅ تم الحل، لكن تعذر حفظ الملاحظة.'
          : '✅ Resolved, but the note could not be saved.'
        );
        return;
      }
      alert(isAr ? '✅ تم حل النزاع بنجاح.' : '✅ Dispute resolved successfully.');
    } catch (err: any) {
      console.error('Error resolving dispute:', err);
      alert(isAr ? `❌ فشل حل النزاع: ${err.message || String(err)}` : `❌ Failed to resolve dispute: ${err.message || String(err)}`);
      throw err;
    }
  };

  const pendingCliQDrops = escrows.filter(e => e.status === 'locked' && e.auctionId === 'cliq-dep');
  // Approval queue: every under-review listing ('processing' + legacy 'pending'), newest first.
  const pendingListingDrops = auctions
    .filter((a: any) => a.status === 'processing' || a.status === 'pending')
    .sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0));
  

  // Wave 4 — ONE queue.
  //
  // Declared HERE, not up with the other memos: it reads pendingListingDrops
  // and subscriptionRequests, both `const`/`useState` declared further down.
  // A useMemo callback runs during render at the line it appears on, so
  // hoisting this would hit the temporal dead zone and throw
  // "Cannot access 'pendingListingDrops' before initialization" — a crash the
  // build does not catch. Everything needing a human, ranked, from a pure
  // builder (utils/actionQueue.ts). Replaces the five separate count memos and
  // computeAttentionCounts: the queue's length is now the only answer to "how
  // much is waiting", so a badge can never disagree with the list it opens.
  const actionQueue = useMemo(
    () => buildActionQueue({
      orders: realOrders,
      pendingListings: pendingListingDrops,
      subscriptionRequests,
      withdrawals: allWithdrawals,
    }, Date.now()),
    [realOrders, pendingListingDrops, subscriptionRequests, allWithdrawals],
  );

  // ── Action latency ───────────────────────────────────────────────────────
  //
  // Six of the eleven buttons below sit behind a callable that cold-starts for
  // ~2s, and this dashboard had NO busy state at all: the button looked dead,
  // so the admin clicked it again. One hook now gates every one of them.
  //
  // PLACEMENT IS LOAD-BEARING: this block must stay BELOW the memo above — see
  // that memo's TDZ note. Hoisting it throws "Cannot access 'actionQueue'
  // before initialization" the moment the admin panel opens, by two separate
  // routes: a dependency array is an ordinary array literal built during render
  // at the line it is written on, AND a useMemo factory runs synchronously on
  // the first render, so the memo's body would throw too. Only the useEffect
  // callback is genuinely deferred. `adminDashboard.render.test.tsx` executes
  // this component to keep all of that honest.
  const adminAction = useAdminAction();

  // Forget an optimistic hide once the listener has actually dropped the row.
  // `prune` is referentially stable (useCallback with no deps), so it is safe
  // in the dependency list; `pruneHidden` returns the same state object when
  // nothing changed, so this cannot loop even though `actionQueue` is a fresh
  // array on every render.
  useEffect(() => { adminAction.prune(actionQueue); }, [actionQueue, adminAction.prune]);

  // The ONE list the Action Center renders and the tab badge counts.
  const visibleActionQueue = useMemo(
    () => visibleRows(actionQueue, adminAction.state),
    [actionQueue, adminAction.state],
  );

  // A membership row carries only the request id, but `approveSubscription`
  // wants the whole request (it re-reads `.id` and names the member in its
  // confirmation). Resolving it here is what makes the Action Center's
  // membership buttons actually work.
  const findSubscriptionRequest = (requestId: string) =>
    subscriptionRequests.find((s: any) => s?.id === requestId) || { id: requestId };

  // Every Action Center write, wrapped once.
  //
  // `actionId` and `rowId` are both `${kind}:${entityId}` — the exact form of
  // `ActionRow.id` — so a row's approve and its reject share one gate: while
  // either is in flight the whole row is busy, which is what the admin means.
  //
  // On `delivery_stalled` that same id is shared by NUDGE and ADVANCE, which is
  // a side effect of keying on the row rather than a decision — but it is the
  // safe direction and should stay: it stops "nudge the seller to ship" racing
  // "mark it shipped" on the same order. Do not split them apart for
  // tidiness.
  //
  // MONEY ACTIONS ARE NEVER OPTIMISTICALLY HIDDEN. The reversible optimism is
  // permitted at EXACTLY TWO of the call sites below — the listing approve and
  // the listing reject — and a test pins that as an allowlist, so a newly-added
  // action is confirmed-by-omission, the safe default. A listing decision moves
  // no money and is undoable from this same panel, so its row may vanish before
  // the server answers. Everything else waits, including three that look
  // reversible and are not:
  //   - resolving a dispute runs executeOrderTransition('resolve_dispute'), and
  //     that is where the money moves. The admin's note is reversible; the
  //     resolution is not, and one button does both.
  //   - advancing an order runs executeOrderTransition with a status-dependent
  //     action, and some targets release escrow. Money-class by default rather
  //     than per-row: a classification you re-derive per row is no
  //     classification at all.
  //   - a nudge moves nothing, but it sends a real WhatsApp and there is no
  //     unsend.
  //
  // NOTE TO FUTURE EDITORS: the classification test reads this file as TEXT.
  // Do not write a handler's identifier, or the literal optimism field, into a
  // comment above the object — the test's window would find the prose instead
  // of the code.
  const actionCenterHandlers = {
    onApproveListing: (auctionId: string, viewing?: ViewingMode, viewingPlace?: string) =>
      adminAction.run({
        actionId: `approve_listing:${auctionId}`,
        rowId: `approve_listing:${auctionId}`,
        optimism: 'reversible',
        fn: () => approveListing(auctionId, viewing, viewingPlace),
      }),
    onRejectListing: (auctionId: string, reason?: string) =>
      adminAction.run({
        actionId: `approve_listing:${auctionId}`,
        rowId: `approve_listing:${auctionId}`,
        optimism: 'reversible',
        fn: () => rejectListing(auctionId, reason),
      }),

    onApproveOrderPayment: (orderId: string) =>
      adminAction.run({
        actionId: `verify_order_payment:${orderId}`,
        rowId: `verify_order_payment:${orderId}`,
        optimism: 'confirmed',
        fn: () => handleVerifyOrderPayment(orderId),
      }),
    onRejectOrderPayment: (orderId: string, reason: string) =>
      adminAction.run({
        actionId: `verify_order_payment:${orderId}`,
        rowId: `verify_order_payment:${orderId}`,
        optimism: 'confirmed',
        fn: () => handleRejectOrderPayment(orderId, reason),
      }),

    onApproveMembership: (requestId: string) =>
      adminAction.run({
        actionId: `verify_membership:${requestId}`,
        rowId: `verify_membership:${requestId}`,
        optimism: 'confirmed',
        fn: () => approveSubscription(findSubscriptionRequest(requestId)),
      }),
    onRejectMembership: (requestId: string, reason: string) =>
      adminAction.run({
        actionId: `verify_membership:${requestId}`,
        rowId: `verify_membership:${requestId}`,
        optimism: 'confirmed',
        fn: () => rejectSubscription(findSubscriptionRequest(requestId), reason),
      }),

    // transferRef is NOT optional: the server refuses a payout approval without
    // it, so it has to survive the wrapper.
    onApprovePayout: (withdrawalId: string, transferRef: string) =>
      adminAction.run({
        actionId: `payout:${withdrawalId}`,
        rowId: `payout:${withdrawalId}`,
        optimism: 'confirmed',
        fn: () => approveWithdrawal(withdrawalId, transferRef),
      }),
    onRejectPayout: (withdrawalId: string, reason: string) =>
      adminAction.run({
        actionId: `payout:${withdrawalId}`,
        rowId: `payout:${withdrawalId}`,
        optimism: 'confirmed',
        fn: () => rejectWithdrawal(withdrawalId, reason),
      }),

    onResolveDispute: async (orderId: string, resolutionType: 'release' | 'refund' | 'resume', notes: string) => {
      await adminAction.run({
        actionId: `dispute:${orderId}`,
        rowId: `dispute:${orderId}`,
        optimism: 'confirmed',
        fn: () => handleResolveDispute(orderId, resolutionType, notes),
      });
    },

    onNudge: async (orderId: string, kind: 'ship' | 'confirm_delivery') => {
      await adminAction.run({
        actionId: `delivery_stalled:${orderId}`,
        rowId: `delivery_stalled:${orderId}`,
        optimism: 'confirmed',
        fn: () => handleSendFulfillmentNudge(orderId, kind),
      });
    },

    onAdvance: async (order: any, note: string) => {
      const orderId = order?.id || '';
      const result = await adminAction.run({
        actionId: `delivery_stalled:${orderId}`,
        rowId: `delivery_stalled:${orderId}`,
        optimism: 'confirmed',
        fn: () => handleAdvanceOrder(order, note),
      });
      // The ONLY handler whose failure is otherwise silent — handleAdvanceOrder
      // returns {success:false} instead of alerting, and the card ignores what
      // it returns. So report it here, and check `suppressed` FIRST: a
      // swallowed double-click sent nothing and failed at nothing, and its
      // `error` carries an internal untranslated marker that must never reach
      // an Arabic-speaking admin.
      if (result.suppressed) return { success: false };
      if (!result.ok) {
        const message = typeof result.error === 'string'
          ? result.error
          : (result.error?.message || (isAr ? 'فشل تحديث الطلب.' : 'Update failed.'));
        alert(`❌ ${message}`);
        return { success: false, message };
      }
      return { success: true };
    },

    onOpenOrder: setAdminSelectedOrderId,
  };

  const pendingByUsersOnly = users.filter((u: any) => {
    const isPending = u.subscriptionStatus === 'pending';
    const hasRequest = subscriptionRequests.some((r: any) => r.userId === u.id);
    return isPending && !hasRequest;
  });
  
  // Computations (Wave 3: from realAuctions — sim lots never inflate metrics)
  const activeAuctionsNum = realAuctions.filter(a => a.status === 'live').length;
  const totalEscrowHeld = escrows
    .filter(e => e.status === 'locked')
    .reduce((sum, e) => sum + e.amount, 0);

  if (adminSelectedOrderId) {
    return (
      <div 
        className="flex-1 min-h-0 overflow-y-auto w-full flex flex-col bg-surface-sunken/50 p-4 md:p-6 overscroll-contain select-none font-sans text-fg"
        style={{ direction: isAr ? 'rtl' : 'ltr' }}
        id="admin-order-details-pane"
      >
        <div className="max-w-4xl mx-auto w-full">
          <OrderDetailsView orderId={adminSelectedOrderId} onBack={() => setAdminSelectedOrderId(null)} />
        </div>
      </div>
    );
  }

  return (
    <div 
      className="flex-1 min-h-0 overflow-y-auto w-full flex flex-col bg-surface-sunken/50 pb-[calc(6rem+env(safe-area-inset-bottom))] overscroll-contain select-none font-sans text-fg animate-fadeIn"
      style={{ direction: isAr ? 'rtl' : 'ltr' }}
      id="admin-dashboard-root"
    >
      
      {/* Top Header - Streamlined & Elegant */}
      <div className="p-5 flex items-center justify-between border-b border-line bg-surface-raised sticky top-0 z-40 shadow-xs">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-[#E85D04]/10 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-[#E85D04]" />
          </div>
          <div>
            <h2 className="text-sm font-black text-fg leading-none">
              {isAr ? 'لوحة التحكم والإشراف' : 'Control & Administration Panel'}
            </h2>
            <p className="text-[10px] text-fg-muted mt-1">
              {isAr ? 'إدارة المزادات، الحسابات، الدفعات والضمان' : 'Manage live auctions, accounts, payouts, and escrow'}
            </p>
          </div>
        </div>
        <span className="text-[10px] bg-surface-sunken text-fg px-3 py-1 rounded-full font-bold uppercase tracking-wider">
          {isAr ? 'حساب مدير النظام' : 'SYSTEM ADMIN'}
        </span>
      </div>

      {/* Navigation Submenu - Premium Tab Buttons */}
      <div className="bg-surface-raised border-b border-line px-4 py-2 flex items-center gap-1.5 overflow-x-auto scrollbar-none shrink-0">
        {(() => {
          // Wave 4: one badge, one source. The queue's length IS how much is
          // waiting — five separate counters could disagree with the list they
          // linked to, which is what computeAttentionCounts allowed.
          const badgeFor = (tab: AdminTabId): number | null =>
            tab === 'action-center' ? visibleActionQueue.length : null;
          const renderTab = (tab: AdminTabId) => {
            const isActive = activeTab === tab;
            const badge = badgeFor(tab);
            return (
              <button
                key={tab}
                onClick={() => selectTab(tab)}
                className={`px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all flex items-center gap-2 ${
                  isActive
                    ? 'bg-gray-900 text-white shadow-sm'
                    : 'text-fg-muted hover:text-fg hover:bg-surface-sunken'
                }`}
              >
                <span>{isAr ? TAB_META[tab].ar : TAB_META[tab].en}</span>
                {badge !== null && badge > 0 && (
                  <span className="bg-red-500 text-white text-[9px] font-black rounded-full px-1.5 py-0.5 animate-pulse">
                    {badge}
                  </span>
                )}
              </button>
            );
          };
          return (
            <>
              {ADMIN_PRIMARY_TABS.map(renderTab)}
              <span className="mx-1 h-5 w-px bg-gray-200 shrink-0" />
              {ADMIN_REFERENCE_TABS.map(renderTab)}
            </>
          );
        })()}
      </div>

       {/* Main Content Area */}
      <div className="p-5 max-w-5xl mx-auto w-full space-y-5">

        {/* ==========================================
            TAB: ACTION CENTER (Wave 4 — everything needing a human)
            ========================================== */}
        {activeTab === 'action-center' && (
          <ActionCenterSection
            isAr={isAr}
            queue={visibleActionQueue}
            orders={realOrders}
            pendingListings={pendingListingDrops}
            subscriptionRequests={subscriptionRequests}
            withdrawals={allWithdrawals}
            users={users}
            isPending={adminAction.isPending}
            handlers={actionCenterHandlers}
          />
        )}

        
        
        
        {activeTab === 'audit' && (
          <React.Suspense
            fallback={
              <div className="bg-surface-raised p-5 rounded-3xl border border-line text-xs text-fg-muted font-semibold">
                {isAr ? 'جاري التحميل…' : 'Loading…'}
              </div>
            }
          >
            <AuditLogSection isAr={isAr} actions={adminActions} />
          </React.Suspense>
        )}

        {/* ==========================================
            TAB: ORDERS MANAGEMENT
            ========================================== */}
        {activeTab === 'orders' && (
          <React.Suspense
            fallback={
              <div className="bg-surface-raised p-5 rounded-3xl border border-line text-xs text-fg-muted font-semibold">
                {isAr ? 'جاري التحميل…' : 'Loading…'}
              </div>
            }
          >
            <OrdersLedgerSection
              isAr={isAr}
              orders={orders}
              filteredOrders={filteredOrders}
              realOrders={realOrders}
              simOrdersCount={simOrdersCount}
              adminOrderFilter={adminOrderFilter}
              onFilterChange={setAdminOrderFilter}
              onOpenOrder={setAdminSelectedOrderId}
            />
          </React.Suspense>
        )}

        {/* ==========================================
            TAB: LISTINGS (Lots approval and deletion)
            ========================================== */}
        {activeTab === 'our-drops' && (
          <React.Suspense
            fallback={
              <div className="bg-surface-raised p-5 rounded-3xl border border-line text-xs text-fg-muted font-semibold">
                {isAr ? 'جاري التحميل…' : 'Loading…'}
              </div>
            }
          >
            {/* Featuring is merchandising of Mazad's own inventory, so it lives
                at the top of Our drops rather than in a seventh tab — the Wave 4
                re-cut collapsed tabs deliberately. */}
            <div className="mb-4">
              <FeaturedSection isAr={isAr} />
            </div>
            <OurDropsSection
              isAr={isAr}
              isLoading={isLoading}
              auctions={auctions}
              auctionsTotalCount={auctionsTotalCount}
              orders={orders}
              users={users}
              rejectingId={rejectingId}
              setRejectingId={setRejectingId}
              rejectionReason={rejectionReason}
              setRejectionReason={setRejectionReason}
              onRepairOrder={repairEndedAuctionOrder}
              onRepairEscrow={repairStuckEscrowsForEndedAuction}
              onDeleteAuction={deleteAuction}
              onSetViewing={setAuctionViewing}
              onCreateDrop={() => setActiveView('auction-drop-builder')}
            />
          </React.Suspense>
        )}

        {/* ==========================================
            TAB: USERS (Account Security Moderation)
            ========================================== */}
        {activeTab === 'members' && (
          <React.Suspense
            fallback={
              <div className="bg-surface-raised p-5 rounded-3xl border border-line text-xs text-fg-muted font-semibold">
                {isAr ? 'جاري التحميل…' : 'Loading…'}
              </div>
            }
          >
            <MembersSection
              isAr={isAr}
              isLoading={isLoading}
              users={users}
              onVerifySeller={verifySeller}
              onBan={banUser}
              onUnban={unbanUser}
              currentUserId={currentUser?.id}
              currentUserEmail={currentUser?.email}
              totalAccounts={usersTotalCount}
            />
          </React.Suspense>
        )}

        
        {/* ==========================================
            TAB: AUCTION LOOKUP (admin search — all statuses, incl. closed)
            ========================================== */}
        {activeTab === 'auction-lookup' && (
          <React.Suspense
            fallback={
              <div className="bg-surface-raised p-5 rounded-3xl border border-line text-xs text-fg-muted font-semibold">
                {isAr ? 'جاري التحميل…' : 'Loading…'}
              </div>
            }
          >
            <AuctionLookupSection isAr={isAr} />
          </React.Suspense>
        )}

        {/* ==========================================
            TAB: SYSTEM (Operations + Monitoring + quarantined Developer tools)
            ========================================== */}
        {activeTab === 'system' && (
          <React.Suspense
            fallback={
              <div className="bg-surface-raised p-5 rounded-3xl border border-line text-xs text-fg-muted font-semibold">
                {isAr ? 'جاري التحميل…' : 'Loading…'}
              </div>
            }
          >
            <SystemSection
              isAr={isAr}
              currentUser={currentUser}
              maintenanceMode={maintenanceMode}
              featureFlags={featureFlags}
              updateMaintenanceMode={updateMaintenanceMode}
              updateFeatureFlag={updateFeatureFlag}
              systemHealthLogs={systemHealthLogs}
              logSystemHealth={logSystemHealth}
              stuckAuctions={stuckAuctions}
              stuckOrders={stuckOrders}
              settlementFresh={settlementFresh}
              n8nBot={n8nBot}
              n8nNotif={n8nNotif}
              n8nOtp={n8nOtp}
              rateValue={rateValue}
              rateSeverity={rateSeverity}
              rateSubtext={rateSubtext}
              users={users}
              resetOnboarding={resetOnboarding}
              setBids={setBids}
            />
          </React.Suspense>
        )}

      </div>

      {/* Full Preview Dialog for Receipts */}
      {viewReceiptUrl && (
        <div 
          className="fixed inset-0 bg-black/85 backdrop-blur-xs z-50 flex items-center justify-center p-4 animate-fadeIn"
          onClick={() => setViewReceiptUrl(null)}
        >
          <div className="relative max-w-lg w-full bg-surface-raised rounded-3xl p-3 shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <img 
              src={viewReceiptUrl} 
              alt="Receipt Full Preview" 
              className="w-full max-h-[70vh] object-contain rounded-2xl"
            />
            <div className="mt-3.5 flex justify-between items-center px-1">
              <span className="text-[10px] text-fg-muted font-mono uppercase">{isAr ? 'إثبات تحويل كليك' : 'CliQ Transfer Proof'}</span>
              <button 
                onClick={() => setViewReceiptUrl(null)}
                className="bg-surface-sunken hover:bg-gray-200 text-fg rounded-xl px-4 py-2 text-xs font-black uppercase transition-all"
              >
                {isAr ? 'إغلاق' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
