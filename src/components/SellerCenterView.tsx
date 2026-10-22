import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useApp, useAuctions } from '../context/AppContext';
import { db, getFirebaseStorage } from '../services/firebase';
import { translations } from '../utils/translations';
import { sellerNet } from '../utils/bidMath';
import { secondChanceViewState } from '../utils/secondChanceOffer';
import { offerAwaitsSeller } from '../utils/reserveStatus';
import { SecondChanceCard } from './order/SecondChanceCard';
import { OrderDetailsView } from './OrderDetailsView';
import { resolveAvatarUrl } from '../utils/avatarPlaceholder';
import { AuctionDetailsModal } from './AuctionDetailsModal';
import { 
  collection, 
  doc, 
  onSnapshot, 
  query, 
  where, 
  updateDoc, 
  addDoc, 
  deleteDoc, 
  setDoc,
  Timestamp 
} from 'firebase/firestore';
import { 
  ResponsiveContainer, 
  BarChart, 
  Bar, 
  LineChart, 
  Line, 
  PieChart, 
  Pie, 
  Cell, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend,
  AreaChart,
  Area
} from 'recharts';
import { 
  TrendingUp, 
  Wallet, 
  Clock, 
  CheckCircle, 
  AlertTriangle, 
  Store, 
  ChevronRight, 
  Star, 
  MessageSquare, 
  Calendar, 
  ArrowUpRight, 
  DollarSign, 
  ArrowLeft, 
  Plus, 
  Trash2, 
  Edit, 
  Copy, 
  PlusCircle, 
  Eye, 
  Activity, 
  Bell, 
  Users, 
  BarChart3,
  Package,
  ShoppingBag,
  Send,
  X,
  CreditCard,
  Building2,
  RefreshCw,
  UserCheck,
  ShieldCheck,
  Sparkles
} from 'lucide-react';
import { AuctionItem, Order, Review, Withdrawal } from '../types';
import { deriveSellerActions, SellerAction } from './seller/sellerActions';
import { bucketListings, filterListings, ListingBucketId } from './seller/sellerListings';
import { Search, Truck, RotateCcw } from 'lucide-react';
import { getOrderStatusChip, OrderStatusTone } from '../utils/orderStatusGlossary';
import { sumPaidSalesThisMonth } from '../utils/sellerSales';
import { reviewCountLabel } from '../utils/reviewCount';
import { displayOrderRef } from '../utils/orderRef';
import { validateDescription } from '../utils/listingDescription';
import ListingImage from './ui/ListingImage';
import { rejectionPresetLabel } from '../utils/rejectionReasons';
import SellerDetailsForm from './seller/SellerDetailsForm';

/** ORDER-status pill (bg/text/border) classes per glossary tone — keeps the
 *  seller orders table's brand-orange default while the label comes from the
 *  shared glossary (no more raw codes rendered). */
const ORDER_STATUS_TONE_CHIP: Record<OrderStatusTone, string> = {
  neutral: 'bg-surface-sunken text-zinc-500',
  info: 'bg-accent-weak text-orange-700 border border-orange-100',
  warning: 'bg-accent-weak text-orange-700 border border-orange-100',
  success: 'bg-emerald-50 text-emerald-700 border border-emerald-100',
  danger: 'bg-rose-50 text-rose-700 border border-rose-100',
};

/** AUCTION-listing statuses are NOT order codes (the order glossary does not
 *  cover them). This local map keeps a clean human label so no raw code leaks
 *  onto the seller's listing badge. */
const AUCTION_STATUS_LABEL: Record<string, { ar: string; en: string }> = {
  upcoming: { ar: 'قادم', en: 'Upcoming' },
  live: { ar: 'مباشر', en: 'Live' },
  processing: { ar: 'قيد المعالجة', en: 'Processing' },
  // Not 'Rejected'. This state is editable and resubmittable — the seller
  // fixes the listing and sends it back — so the label names the action, not a
  // verdict. The STORED status value is unchanged.
  rejected: { ar: 'يحتاج تعديل', en: 'Needs editing' },
  completed: { ar: 'منتهٍ', en: 'Ended' },
  ended: { ar: 'منتهٍ', en: 'Ended' },
  reserve_not_met: { ar: 'لم يتحقق السعر', en: 'Reserve not met' },
};

const auctionStatusLabel = (status: string, isAr: boolean): string => {
  const entry = AUCTION_STATUS_LABEL[status];
  if (entry) return isAr ? entry.ar : entry.en;
  return isAr ? 'قيد المعالجة' : 'Processing';
};

/**
 * The seller's "Shipped" tab: goods have left, money has not yet moved.
 *
 * Wave 3 added `out_for_delivery` (the evidence-gated dispatch) alongside the
 * legacy relay-recorded `shipped`. Extracted because the tab's filter and the
 * tab's COUNT BADGE are two separate call sites — they had already been written
 * out twice, and a badge that disagrees with the list it opens is the exact bug
 * that shape invites.
 */
const isInTransitOrder = (o: { status?: string }): boolean =>
  o.status === 'shipped' || o.status === 'out_for_delivery' || o.status === 'delivered';

// Extend local translations for Seller Center Specific text
const sellerTranslations: Record<string, Record<string, string>> = {
  ar: {
    seller_center: 'مركز البائع',
    active_auctions: 'المزادات النشطة',
    completed_sales: 'المبيعات المكتملة',
    pending_orders: 'طلبات معلقة',
    total_revenue: 'إجمالي الإيرادات',
    wallet_balance: 'رصيد المحفظة المتاح',
    escrow_locked: 'المحجوز في الضمان',
    monthly_sales: 'مبيعات الشهر الحالي',
    avg_rating: 'متوسط التقييم',
    dashboard: 'لوحة التحكم',
    my_auctions: 'مزاداتي',
    orders: 'الطلبات والمبيعات',
    payouts: 'السحوبات والمالية',
    analytics: 'التحليلات والأداء',
    reviews: 'تقييمات المشترين',
    notifications: 'الإشعارات',
    upcoming: 'قادم',
    live: 'مباشر الآن',
    pending_approval: 'بانتظار الموافقة',
    completed: 'مكتمل',
    rejected: 'يحتاج تعديل',
    edit: 'تعديل',
    duplicate: 'نسخ مكرر',
    delete: 'حذف',
    view: 'عرض المزاد',
    no_bids_delete: 'يمكن الحذف فقط في حال عدم وجود مزايدات',
    buyer: 'المشتري',
    price: 'السعر',
    status: 'الحالة',
    payment: 'الدفع',
    shipping: 'الشحن',
    escrow: 'الضمان',
    open_details: 'فتح التفاصيل',
    withdraw_bank: 'طلب سحب مالي للبنك',
    withdraw_cliq: 'طلب سحب عبر كليك',
    available_balance: 'الرصيد المتاح',
    escrow_pending: 'الضمان المعلق',
    funds_released: 'الأموال المحررة',
    withdrawal_history: 'سجل طلبات السحب المالي',
    withdraw_placeholder: 'سيتم تقديم طلب السحب للمراجعة والتدقيق المالي من قبل الإدارة، وسيتم التواصل معك بعد مراجعة الطلب.',
    amount_jod: 'المبلغ بالدينار الأردني (JOD)',
    bank_name: 'اسم البنك',
    iban: 'رقم الآيبان الدولي (IBAN)',
    account_holder: 'اسم صاحب الحساب بالكامل',
    cliq_alias: 'اسم مستعار كليك / رقم الهاتف لـ كليك',
    submit_withdrawal: 'تقديم طلب السحب المالي',
    daily_sales: 'المبيعات اليومية',
    monthly_rev: 'الإيرادات الشهرية',
    conv_rate: 'معدل التحويل (Views vs Bids)',
    avg_selling_price: 'متوسط سعر البيع للمزادات المكتملة',
    top_categories: 'أعلى الفئات مبيعاً',
    views_vs_bids: 'المشاهدات مقابل المزايدات',
    buyer_feedback: 'تعليقات المشترين والمزايدين',
    respond: 'الرد على التقييم',
    save_response: 'حفظ الرد',
    response_placeholder: 'اكتب ردك المهني هنا...',
    no_auctions: 'لا يوجد مزادات في هذا القسم حالياً.',
    no_orders: 'لا يوجد طلبات مبيعات مسجلة بعد.',
    no_reviews: 'لا يوجد تقييمات مكتوبة بعد.',
    no_notifications: 'لا توجد إشعارات جديدة للبائع.',
    all_notifs: 'جميع إشعارات البائع',
    resubmit: 'أعد الإرسال',
    no_listings_yet: 'ما عندك مزادات بعد — أضف أول منتج',
    start_selling: 'ابدأ البيع',
    // Redesign — sections
    overview: 'نظرة عامة',
    listings: 'مزاداتي',
    money: 'المالية والسحوبات',
    // Overview — action hub
    needs_action: 'يحتاج إلى إجرائك الآن',
    all_caught_up: 'أحسنت! لا يوجد شيء يحتاج إجراءً حالياً.',
    all_caught_up_sub: 'كل مزاداتك وطلباتك تحت السيطرة.',
    recent_activity: 'آخر النشاطات',
    active_listings: 'مزادات نشطة',
    live_bids_now: 'مزايدات الآن',
    this_month_sales: 'مبيعات الشهر',
    view_details: 'عرض',
    // Action item labels + CTAs (by kind)
    act_ship_label: 'طلبات بانتظار الشحن',
    act_ship_cta: 'جهّز للشحن',
    act_relist_label: 'مزادات انتهت بدون بيع',
    act_relist_cta: 'أعد النشر',
    act_dispute_label: 'نزاعات بحاجة لحل',
    act_dispute_cta: 'راجع النزاع',
    act_payout_label: 'رصيد جاهز للسحب',
    act_payout_cta: 'اسحب الآن',
    act_verify_label: 'وثّق حسابك كبائع',
    act_verify_cta: 'قدّم الآن',
    // Listings workspace
    new_listing: 'مزاد جديد',
    search_listings: 'ابحث بعنوان المزاد...',
    all_categories: 'كل الفئات',
    bucket_live: 'مباشر',
    bucket_scheduled: 'مجدول',
    bucket_review: 'قيد المراجعة',
    bucket_ended: 'انتهى / بدون بيع',
    bucket_sold: 'مُباع',
    bucket_rejected: 'يحتاج تعديل',
    bucket_all: 'الكل',
    time_left: 'الوقت المتبقي',
    ended_label: 'منتهٍ',
    relist: 'أعد النشر',
    select_mode: 'تحديد متعدد',
    exit_select: 'إنهاء التحديد',
    selected_count: 'محدد',
    relist_selected: 'أعد نشر المحدد',
    cancel_selected: 'احذف المحدد',
    confirm_cancel_selected: 'هل تريد حذف المزادات المحددة نهائياً؟ لا يمكن حذف مزاد عليه مزايدات.',
    // Orders
    ord_to_ship: 'بانتظار الشحن',
    ord_shipped: 'تم الشحن',
    ord_completed: 'مكتمل',
    ord_disputed: 'نزاع',
    ord_all: 'كل الطلبات',
    // Analytics + reviews
    performance: 'الأداء والتحليلات',
    avg_rating_card: 'متوسط تقييم المشترين'
  },
  en: {
    seller_center: 'Seller Center',
    active_auctions: 'Active Auctions',
    completed_sales: 'Completed Sales',
    pending_orders: 'Pending',
    total_revenue: 'Total Revenue',
    wallet_balance: 'Available Wallet Balance',
    escrow_locked: 'Escrow Locked',
    monthly_sales: 'Monthly Sales',
    avg_rating: 'Average Rating',
    dashboard: 'Dashboard',
    my_auctions: 'My Auctions',
    orders: 'Orders & Sales',
    payouts: 'Payouts & Balance',
    analytics: 'Analytics & Performance',
    reviews: 'Buyer Reviews',
    notifications: 'Notifications',
    upcoming: 'Upcoming',
    live: 'Live Now',
    pending_approval: 'Pending Approval',
    completed: 'Completed',
    rejected: 'Needs editing',
    edit: 'Edit',
    duplicate: 'Duplicate',
    delete: 'Delete',
    view: 'View Auction',
    no_bids_delete: 'Can only delete if there are no bids',
    buyer: 'Buyer',
    price: 'Price',
    status: 'Status',
    payment: 'Payment',
    shipping: 'Shipping',
    escrow: 'Escrow',
    open_details: 'Open Details',
    withdraw_bank: 'Request Bank Withdrawal',
    withdraw_cliq: 'Request CliQ Withdrawal',
    available_balance: 'Available Balance',
    escrow_pending: 'Pending Escrow',
    funds_released: 'Released Funds',
    withdrawal_history: 'Withdrawal Request History',
    withdraw_placeholder: 'Your withdrawal request will be submitted to our finance desk for review. We will contact you after reviewing the request.',
    amount_jod: 'Amount in JOD',
    bank_name: 'Bank Name',
    iban: 'IBAN Code',
    account_holder: 'Full Account Holder Name',
    cliq_alias: 'CliQ Alias / Phone Number',
    submit_withdrawal: 'Submit Withdrawal Request',
    daily_sales: 'Daily Sales',
    monthly_rev: 'Monthly Revenue',
    conv_rate: 'Conversion Rate (Views vs Bids)',
    avg_selling_price: 'Average Selling Price (Completed)',
    top_categories: 'Top Categories',
    views_vs_bids: 'Views vs Bids',
    buyer_feedback: 'Buyer Feedback & Ratings',
    respond: 'Respond',
    save_response: 'Save Response',
    response_placeholder: 'Write your professional reply...',
    no_auctions: 'No auctions found in this category.',
    no_orders: 'No orders logged yet.',
    no_reviews: 'No reviews found yet.',
    no_notifications: 'No seller notifications found.',
    all_notifs: 'All Seller Notifications',
    resubmit: 'Resubmit',
    no_listings_yet: 'No listings yet — add your first',
    start_selling: 'Start selling',
    // Redesign — sections
    overview: 'Overview',
    listings: 'Listings',
    money: 'Money',
    // Overview — action hub
    needs_action: 'Needs your action',
    all_caught_up: "You're all caught up",
    all_caught_up_sub: 'Every listing and order is under control.',
    recent_activity: 'Recent activity',
    active_listings: 'Listings',
    live_bids_now: 'Live bids',
    this_month_sales: 'This month',
    view_details: 'View',
    // Action item labels + CTAs (by kind)
    act_ship_label: 'Orders to ship',
    act_ship_cta: 'Prepare shipment',
    act_relist_label: 'Auctions ended unsold',
    act_relist_cta: 'Relist',
    act_dispute_label: 'Disputes to resolve',
    act_dispute_cta: 'Review dispute',
    act_payout_label: 'Balance ready to withdraw',
    act_payout_cta: 'Withdraw',
    act_verify_label: 'Verify your seller account',
    act_verify_cta: 'Apply now',
    // Listings workspace
    new_listing: 'New Listing',
    search_listings: 'Search by title...',
    all_categories: 'All categories',
    bucket_live: 'Live',
    bucket_scheduled: 'Scheduled',
    bucket_review: 'In review',
    bucket_ended: 'Ended / Unsold',
    bucket_sold: 'Sold',
    bucket_rejected: 'Needs editing',
    bucket_all: 'All',
    time_left: 'Time left',
    ended_label: 'Ended',
    relist: 'Relist',
    select_mode: 'Select',
    exit_select: 'Done',
    selected_count: 'selected',
    relist_selected: 'Relist selected',
    cancel_selected: 'Delete selected',
    confirm_cancel_selected: 'Permanently delete the selected listings? Listings with bids cannot be deleted.',
    // Orders
    ord_to_ship: 'To ship',
    ord_shipped: 'Shipped',
    ord_completed: 'Completed',
    ord_disputed: 'Disputed',
    ord_all: 'All orders',
    // Analytics + reviews
    performance: 'Performance & Analytics',
    avg_rating_card: 'Average buyer rating'
  }
};

export const SellerCenterView: React.FC = () => {
  const {
    currentUser,
    language,
    orders,
    wallet,
    addNotification,
    sellerProfiles,
    submitVerificationRequest,
    requestWithdrawal,
    acceptBelowReserve,
    rejectBelowReserve,
    respondToSecondChance,
    setActiveView
  } = useApp();
  const { auctions, setAuctions } = useAuctions();

  const isAr = language === 'ar';

  // This seller's own public profile doc, for the details form.
  const mySellerProfile = React.useMemo(
    () => sellerProfiles.find((p: any) => p.userId === currentUser?.id || p.id === currentUser?.id),
    [sellerProfiles, currentUser?.id]
  );
  const st = isAr ? sellerTranslations.ar : sellerTranslations.en;

  const [activeTab, setActiveTab] = useState<'overview' | 'listings' | 'orders' | 'money' | 'analytics'>('overview');
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [viewAuctionId, setViewAuctionId] = useState<string | null>(null);

  // Verification states
  const [isVerRequestOpen, setIsVerRequestOpen] = useState(false);
  const [requestedStatus, setRequestedStatus] = useState<'verified' | 'premium_verified'>('verified');
  const [verNotes, setVerNotes] = useState('');
  const [isVerSubmitting, setIsVerSubmitting] = useState(false);
  const [idFrontFile, setIdFrontFile] = useState<File | null>(null);
  const [idBackFile, setIdBackFile] = useState<File | null>(null);
  const [passportFile, setPassportFile] = useState<File | null>(null);

  // States for sub-collections / seeding
  const [reviews, setReviews] = useState<Review[]>([]);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [sellerNotifications, setSellerNotifications] = useState<any[]>([]);

  // Modals / Modifiers
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingAuction, setEditingAuction] = useState<AuctionItem | null>(null);
  const [isWithdrawModalOpen, setIsWithdrawModalOpen] = useState<'bank' | 'cliq' | null>(null);

  // Redesign — Listings workspace state
  const [listingsQuery, setListingsQuery] = useState('');
  const [listingsCategory, setListingsCategory] = useState<string>('all');
  const [activeBucket, setActiveBucket] = useState<ListingBucketId | 'all'>('all');
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Redesign — Orders filter state
  const [ordersFilter, setOrdersFilter] = useState<'all' | 'to_ship' | 'shipped' | 'completed' | 'disputed'>('all');

  // Form Fields for Editing
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editStartingPrice, setEditStartingPrice] = useState(0);
  const [editCategory, setEditCategory] = useState('');
  const [editDuration, setEditDuration] = useState(3600);

  // Form Fields for Withdrawal
  const [wAmount, setWAmount] = useState('');
  const [wBankName, setWBankName] = useState('');
  const [wIban, setWIban] = useState('');
  const [wHolderName, setWHolderName] = useState('');
  const [wCliqAlias, setWCliqAlias] = useState('');

  // Seller-specific listings (where createdById === currentUser.id OR sellerId === currentUser.id)
  const myAuctions = useMemo(() => {
    if (!currentUser) return [];
    return auctions.filter(a => a.createdById === currentUser.id || a.sellerId === currentUser.id);
  }, [auctions, currentUser]);

  // Seller-specific orders
  const myOrders = useMemo(() => {
    if (!currentUser) return [];
    return orders.filter(o => o.sellerId === currentUser.id);
  }, [orders, currentUser]);

  // 1. Load reviews (no seeding — see the note below)
  useEffect(() => {
    if (!currentUser) return;

    const q = query(collection(db, 'reviews'), where('sellerId', '==', currentUser.id));
    // NOTE: this callback is deliberately NOT async.
    //
    // It used to be, and when a seller had no reviews it wrote three fabricated
    // 5-star reviews into Firestore — invented reviewer names, stock-photo
    // avatars, invented purchase histories — "to make it feel rich and genuine".
    // Every write was refused by firestore.rules (a review's buyerId must equal
    // the caller's uid), and because the awaits sat in an async snapshot handler
    // with no catch, each refusal surfaced as an UNCAUGHT rejection: ~97 of them
    // in ten seconds on the Seller Center, since the listener re-subscribes.
    //
    // The rules were the only thing standing between production and fake social
    // proof attributed to real sellers. A seller with no reviews now sees that
    // they have no reviews.
    const unsub = onSnapshot(q, (snap) => {
      if (snap.empty) {
        setReviews([]);
      } else {
        const fetched: Review[] = [];
        snap.forEach((d) => {
          fetched.push({ id: d.id, ...d.data() } as Review);
        });
        // Sort by timestamp descending
        fetched.sort((a, b) => b.timestamp - a.timestamp);
        setReviews(fetched);
      }
    }, (err) => {
      console.warn("SellerCenter reviews subscription failed:", err);
    });

    return () => unsub();
  }, [currentUser, isAr]);

  // 2. Load / Seed Withdrawals
  useEffect(() => {
    if (!currentUser) return;

    const q = query(collection(db, 'withdrawals'), where('userId', '==', currentUser.id));
    const unsub = onSnapshot(q, (snap) => {
      const fetched: Withdrawal[] = [];
      snap.forEach((d) => {
        fetched.push({ id: d.id, ...d.data() } as Withdrawal);
      });
      fetched.sort((a, b) => b.timestamp - a.timestamp);
      setWithdrawals(fetched);
    }, (err) => {
      console.warn("SellerCenter withdrawals subscription failed:", err);
    });

    return () => unsub();
  }, [currentUser]);

  // 3. Load / Filter real-time Seller Notifications only
  useEffect(() => {
    if (!currentUser) return;

    // Load from general /notifications collection where userId === currentUser.id
    const q = query(collection(db, 'notifications'), where('userId', '==', currentUser.id));
    const unsub = onSnapshot(q, (snap) => {
      const fetched: any[] = [];
      snap.forEach((d) => {
        fetched.push({ id: d.id, ...d.data() });
      });
      // Sort newest first
      fetched.sort((a, b) => b.timestamp - a.timestamp);
      setSellerNotifications(fetched);
    }, (err) => {
      console.warn("SellerCenter notifications subscription failed:", err);
    });

    return () => unsub();
  }, [currentUser]);

  // Calculates Key KPIs
  const kpis = useMemo(() => {
    const liveCount = myAuctions.filter(a => a.status === 'live').length;
    
    // Completed Sales: auctions with status 'completed' OR orders with status 'completed'
    const completedSalesCount = myOrders.filter(o => o.status === 'completed').length;
    
    // Pending Orders: waiting_payment, paid, preparing_shipment, shipped, delivered
    const pendingOrdersCount = myOrders.filter(o => 
      ['waiting_payment', 'pending_buyer_confirmation', 'paid', 'preparing_shipment', 'out_for_delivery', 'shipped', 'delivered', 'disputed'].includes(o.status)
    ).length;

    // Total Revenue: seller earnings on completed/paid orders — NET of Mazad's
    // 5% seller commission (uses the server-stamped sellerNet when present, else
    // the display helper). E1 money model: this is what the seller actually keeps.
    const totalRev = myOrders
      .filter(o => o.status === 'completed' || o.paymentStatus === 'paid')
      .reduce((sum, o) => sum + (o.sellerNet ?? sellerNet(o.winningBidAmount || 0)), 0);

    // Wallet balance
    const availableBalance = wallet?.availableBalance || 0;

    // Escrow Locked: orders with escrowStatus 'pending'
    const escrowLocked = myOrders
      .filter(o => o.status !== 'completed' && o.status !== 'cancelled' && o.status !== 'refunded' && o.escrowStatus === 'pending')
      .reduce((sum, o) => sum + (o.winningBidAmount || 0), 0);

    // Monthly Sales: this-month orders where money is actually in (status ∈
    // PAID_OR_BEYOND). waiting_payment / defaulted no longer inflate the figure.
    const now = new Date();
    const currentMonthSales = sumPaidSalesThisMonth(myOrders, now);

    // Average Rating — only a real number when there is ≥1 genuine review.
    // Sellers with zero reviews get null (honest empty state), never a fake 4.8.
    const avgRating = reviews.length > 0
      ? parseFloat((reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1))
      : null;

    return {
      liveCount,
      completedSalesCount,
      pendingOrdersCount,
      totalRev,
      availableBalance,
      escrowLocked,
      currentMonthSales,
      avgRating
    };
  }, [myAuctions, myOrders, wallet, reviews]);

  // Lifecycle bucketing for Listings now lives in the pure `bucketListings`
  // helper (src/components/seller/sellerListings.ts) — see listingBuckets below.

  // Redesign — verification status (drives the "verify" action item)
  const isVerified = useMemo(() => {
    const myProfile = sellerProfiles?.find(p => p.userId === currentUser?.id);
    const vStatus = myProfile?.verificationStatus || currentUser?.verificationStatus || 'not_verified';
    return vStatus !== 'not_verified';
  }, [sellerProfiles, currentUser]);

  // Redesign — lifecycle buckets for the Listings workspace (pure helper)
  const listingBuckets = useMemo(
    () => bucketListings(myAuctions, myOrders),
    [myAuctions, myOrders]
  );

  // Redesign — "Needs your action" hub items (pure helper)
  const actionItems = useMemo(
    () => deriveSellerActions({
      myAuctions,
      myOrders,
      availableBalance: kpis.availableBalance,
      isVerified,
    }),
    [myAuctions, myOrders, kpis.availableBalance, isVerified]
  );

  // Redesign — sum of bids on currently-live auctions (Overview metric)
  const liveBidsNow = useMemo(
    () => myAuctions.filter(a => a.status === 'live').reduce((sum, a) => sum + (a.totalBids || 0), 0),
    [myAuctions]
  );

  // Redesign — categories present in the seller's listings (Listings filter)
  const listingCategories = useMemo(() => {
    const set = new Set<string>();
    myAuctions.forEach(a => { if (a.category) set.add(a.category); });
    return Array.from(set);
  }, [myAuctions]);

  // Chart Data Generation
  const chartData = useMemo(() => {
    // 1. Daily Sales of the last 7 days
    const dailyMap: Record<string, number> = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const label = d.toLocaleDateString(isAr ? 'ar-JO' : 'en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
      dailyMap[d.toDateString()] = 0;
    }

    myOrders.forEach(o => {
      if (o.status === 'completed' || o.paymentStatus === 'paid') {
        const oDate = new Date(typeof o.createdAt === 'number' ? o.createdAt : (o.createdAt.seconds ? o.createdAt.seconds * 1000 : o.createdAt));
        const key = oDate.toDateString();
        if (dailyMap[key] !== undefined) {
          dailyMap[key] += o.winningBidAmount;
        }
      }
    });

    const dailyData = Object.keys(dailyMap).map(key => {
      const d = new Date(key);
      return {
        name: d.toLocaleDateString(isAr ? 'ar-JO' : 'en-US', { weekday: 'short' }),
        sales: dailyMap[key]
      };
    });

    // 2. Monthly Revenue
    const months = isAr 
      ? ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر']
      : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    const monthlyMap: Record<number, number> = {};
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const targetM = (now.getMonth() - i + 12) % 12;
      monthlyMap[targetM] = 0;
    }

    myOrders.forEach(o => {
      if (o.status === 'completed' || o.paymentStatus === 'paid') {
        const oDate = new Date(typeof o.createdAt === 'number' ? o.createdAt : (o.createdAt.seconds ? o.createdAt.seconds * 1000 : o.createdAt));
        const m = oDate.getMonth();
        if (monthlyMap[m] !== undefined) {
          monthlyMap[m] += o.winningBidAmount;
        }
      }
    });

    const monthlyData = Object.keys(monthlyMap).map(mKey => {
      const mIdx = parseInt(mKey);
      return {
        name: months[mIdx],
        revenue: monthlyMap[mIdx]
      };
    });

    // 3. Top Categories
    const categoryMap: Record<string, number> = {};
    myAuctions.forEach(a => {
      const cat = a.category || (isAr ? 'عام' : 'General');
      categoryMap[cat] = (categoryMap[cat] || 0) + 1;
    });

    const categoryData = Object.keys(categoryMap).map(key => ({
      name: key,
      value: categoryMap[key]
    }));

    const COLORS = ['#FF6B00', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899'];

    // 4. Views vs Bids
    const viewsVsBidsData = myAuctions.slice(0, 5).map(a => ({
      name: a.title.length > 15 ? a.title.substring(0, 15) + '...' : a.title,
      views: a.viewersCount || 0,
      bids: a.totalBids || 0
    }));

    return {
      dailyData,
      monthlyData,
      categoryData,
      viewsVsBidsData,
      COLORS
    };
  }, [myOrders, myAuctions, isAr]);

  // Actions
  const handleEditClick = (auction: AuctionItem) => {
    setEditingAuction(auction);
    setEditTitle(auction.title);
    setEditDesc(auction.description || '');
    setEditStartingPrice(auction.startingPrice);
    setEditCategory(auction.category || '');
    setEditDuration(auction.duration || 3600);
    setIsEditModalOpen(true);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAuction) return;

    // Resubmit path: editing a rejected listing sends it straight back into the
    // Mazad review queue ('processing') and clears the old rejection reason.
    // (firestore.rules allow the creator rejected→processing; approvalStatus is
    // admin-only and stays untouched.)
    const isResubmit = editingAuction.status === 'rejected';

    // The wizard's 20-character floor was a CREATION-time speed bump only: a
    // seller could publish at 20 and edit down to "a" here, because this path
    // wrote `description: editDesc` untrimmed, unvalidated and uncapped. The
    // textarea's HTML `required` is satisfied by "   ". Same rule, same
    // message, same alert idiom as the wizard — so the floor is a property of
    // the data rather than of one form.
    const descCheck = validateDescription(editDesc, isAr);
    if (!descCheck.ok) {
      alert(descCheck.message);
      return;
    }

    try {
      const docRef = doc(db, 'auctions', editingAuction.id);
      const patch: any = {
        title: editTitle,
        description: editDesc.trim(),
        startingPrice: editStartingPrice,
        category: editCategory,
        duration: editDuration,
        endsAt: Timestamp.fromMillis(Date.now() + editDuration * 1000),
        ...(isResubmit ? { status: 'processing', rejectionReason: '' } : {})
      };
      await updateDoc(docRef, patch);

      // Update locally
      setAuctions(prev => prev.map(a => a.id === editingAuction.id ? {
        ...a,
        ...patch
      } : a));

      if (isResubmit) {
        addNotification(
          isAr ? '🔄 تمت إعادة الإرسال للمراجعة' : '🔄 Resubmitted for Review',
          isAr ? `تمت إعادة إرسال "${editTitle}" لفريق مزادو للمراجعة والموافقة.` : `"${editTitle}" was resubmitted to the Mazzado team for review & approval.`,
          'info'
        );
      } else {
        addNotification(
          isAr ? '✅ تم تحديث المزاد' : '✅ Auction Updated',
          isAr ? `تم تعديل بيانات المزاد "${editTitle}" بنجاح.` : `Auction "${editTitle}" successfully updated.`,
          'info'
        );
      }
      setIsEditModalOpen(false);
      setEditingAuction(null);
    } catch (err: any) {
      console.error(err);
      alert(isAr ? 'فشل تعديل المزاد.' : 'Failed to update auction.');
    }
  };

  // E3 Slice C — seller accepts a below-reserve top bid. Delegates to the
  // money-path callable; the pending order + buyer-confirm step live server-side.
  const [acceptingOfferId, setAcceptingOfferId] = useState<string | null>(null);
  const handleAcceptBelowReserve = async (auctionId: string) => {
    if (acceptingOfferId || rejectingOfferId) return;
    setAcceptingOfferId(auctionId);
    try {
      await acceptBelowReserve(auctionId);
    } finally {
      setAcceptingOfferId(null);
    }
  };

  // Seller turns the offer down. Separate busy id from accept so one in-flight
  // decision disables BOTH buttons — the two are mutually exclusive terminal
  // actions and firing them together is a race the seller should never be able
  // to start (the server refuses the second either way; this stops the attempt).
  const [rejectingOfferId, setRejectingOfferId] = useState<string | null>(null);
  const handleRejectBelowReserve = async (auctionId: string) => {
    if (acceptingOfferId || rejectingOfferId) return;
    setRejectingOfferId(auctionId);
    try {
      await rejectBelowReserve(auctionId);
    } finally {
      setRejectingOfferId(null);
    }
  };

  const handleDuplicate = async (auction: AuctionItem) => {
    try {
      const newId = `auction-dup-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
      // Strip the source's review-gate artifacts — a copy is a fresh submission.
      // Strip the source's viewing claim too: `viewing`/`viewingPlace` are
      // admin-owned (firestore.rules rejects a non-admin create that merely
      // CARRIES either key), and a duplicate is a new lot that must re-earn its
      // physical-viewing claim from staff at approval rather than inherit one.
      const { id, rejectionReason, rejectedAt, rejectedBy, approvedAt, approvedBy,
        scheduledStartAt, winnerId, winnerName, winnerEmail, winnerPhone, winnerCity,
        viewing, viewingPlace,
        ...dataToCopy } = auction as any;
      
      const endsAtMillis = Date.now() + (auction.duration || 3600) * 1000;
      const duplicated: any = {
        ...dataToCopy,
        id: newId,
        title: isAr ? `${auction.title} (نسخة مكررة)` : `${auction.title} (Copy)`,
        currentPrice: auction.startingPrice,
        currentBidderId: null,
        currentBidderName: null,
        totalBids: 0,
        viewersCount: 0,
        // A duplicate is a NEW unapproved listing: it must re-enter the Mazad
        // review gate ('processing'), never land on a buyer surface as
        // 'upcoming'. Also matches firestore.rules for non-admin creates.
        status: 'processing',
        approvalStatus: 'pending',
        isApproved: false,
        createdAt: Date.now(),
        endsAt: Timestamp.fromMillis(endsAtMillis),
        endTime: endsAtMillis
      };

      await setDoc(doc(db, 'auctions', newId), duplicated);
      
      addNotification(
        isAr ? '📋 تم تكرار المزاد' : '📋 Auction Duplicated',
        isAr 
          ? `تم إنشاء نسخة مكررة باسم "${duplicated.title}" بانتظار الموافقة.` 
          : `Duplicated "${duplicated.title}" successfully. Awaiting approval.`,
        'info'
      );
    } catch (err) {
      console.error(err);
      alert('Failed to duplicate.');
    }
  };

  const handleDelete = async (auction: AuctionItem) => {
    if ((auction.totalBids || 0) > 0) {
      alert(st.no_bids_delete);
      return;
    }

    if (!confirm(isAr ? 'هل أنت متأكد من رغبتك في مسح هذا المزاد نهائياً؟' : 'Are you sure you want to permanently delete this listing?')) {
      return;
    }

    try {
      await deleteDoc(doc(db, 'auctions', auction.id));
      setAuctions(prev => prev.filter(a => a.id !== auction.id));

      addNotification(
        isAr ? '🗑️ تم حذف المزاد' : '🗑️ Auction Deleted',
        isAr ? `تم مسح المزاد "${auction.title}" نهائياً من حسابك.` : `Permanently deleted auction "${auction.title}".`,
        'info'
      );
    } catch (err) {
      console.error(err);
      alert('Failed to delete.');
    }
  };

  const handleWithdrawalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    const amountNum = parseFloat(wAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      alert(isAr ? 'الرجاء إدخال مبلغ صحيح.' : 'Please enter a valid amount.');
      return;
    }

    if (amountNum > kpis.availableBalance) {
      alert(isAr ? 'المبلغ المطلوب أكبر من رصيدك المتاح!' : 'Requested amount exceeds your available balance!');
      return;
    }

    try {
      const details = isWithdrawModalOpen === 'bank' ? {
        bankName: wBankName,
        iban: wIban,
        accountHolderName: wHolderName
      } : {
        cliqAlias: wCliqAlias,
        phone: currentUser.phone || '0791234567'
      };

      const result = await requestWithdrawal(amountNum, isWithdrawModalOpen!, details);

      if (result.success) {
        // Reset
        setWAmount('');
        setWBankName('');
        setWIban('');
        setWHolderName('');
        setWCliqAlias('');
        setIsWithdrawModalOpen(null);
      } else {
        alert(result.message);
      }
    } catch (err: any) {
      console.error(err);
      alert(isAr ? 'فشل تسجيل طلب السحب.' : 'Failed to log withdrawal.');
    }
  };

  const handleReviewReply = async (reviewId: string, replyText: string) => {
    if (!replyText.trim()) return;

    try {
      const ref = doc(db, 'reviews', reviewId);
      await updateDoc(ref, {
        response: replyText,
        responseAt: Date.now()
      });

      addNotification(
        isAr ? '💬 تم حفظ ردك' : '💬 Reply Posted',
        isAr ? 'تم إرسال ردك بنجاح ونشره تحت تقييم المشتري.' : 'Your professional response was saved and published.',
        'info'
      );
    } catch (err) {
      console.error(err);
      alert('Failed to reply.');
    }
  };

  // Redesign — route an Overview action item to its destination section.
  const handleActionCta = (action: SellerAction) => {
    setSelectedOrderId(null);
    switch (action.ctaSection) {
      case 'verify':
        setIsVerRequestOpen(true);
        break;
      case 'orders':
        setOrdersFilter(action.kind === 'dispute' ? 'disputed' : 'to_ship');
        setActiveTab('orders');
        break;
      case 'listings':
        setActiveBucket(action.kind === 'relist' ? 'endedUnsold' : 'all');
        setActiveTab('listings');
        break;
      case 'money':
        setActiveTab('money');
        break;
    }
  };

  // Redesign — bulk-selection helpers for the Listings workspace.
  const toggleSelected = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const exitBulkMode = () => {
    setBulkMode(false);
    setSelectedIds(new Set());
  };

  // Relist selected — loops the EXISTING per-item handleDuplicate.
  const handleRelistSelected = async () => {
    const targets = myAuctions.filter(a => selectedIds.has(a.id));
    for (const a of targets) {
      // eslint-disable-next-line no-await-in-loop
      await handleDuplicate(a);
    }
    exitBulkMode();
  };

  // Cancel selected — confirm once, then loop the EXISTING per-item handleDelete.
  const handleCancelSelected = async () => {
    if (!confirm(st.confirm_cancel_selected)) return;
    const targets = myAuctions.filter(a => selectedIds.has(a.id) && (a.totalBids || 0) === 0);
    for (const a of targets) {
      try {
        await deleteDoc(doc(db, 'auctions', a.id));
        setAuctions(prev => prev.filter(x => x.id !== a.id));
      } catch (err) {
        console.error(err);
      }
    }
    exitBulkMode();
  };

  // Redesign — the currently-shown listings after bucket + search + category filters.
  const visibleListings = useMemo(() => {
    const base = activeBucket === 'all'
      ? [...myAuctions].sort((a, b) => ((b as any).createdAt || 0) - ((a as any).createdAt || 0))
      : listingBuckets[activeBucket];
    return filterListings(base, { query: listingsQuery, category: listingsCategory });
  }, [activeBucket, myAuctions, listingBuckets, listingsQuery, listingsCategory]);

  // Redesign — orders after the status filter.
  const visibleOrders = useMemo(() => {
    switch (ordersFilter) {
      case 'to_ship':
        return myOrders.filter(o => o.status === 'paid' || o.status === 'preparing_shipment');
      case 'shipped':
        return myOrders.filter(isInTransitOrder);
      case 'completed':
        return myOrders.filter(o => o.status === 'completed');
      case 'disputed':
        return myOrders.filter(o => o.status === 'disputed');
      default:
        return myOrders;
    }
  }, [myOrders, ordersFilter]);

  // Redesign — average rating card value (folded into Analytics).
  const avgRatingDisplay = kpis.avgRating;

  // Redesign — compact time-left label for a listing row.
  const timeLeftLabel = (a: AuctionItem): string => {
    const endMs = (a as any).endTime || ((a as any).endsAt?.seconds ? (a as any).endsAt.seconds * 1000 : 0);
    if (!endMs) return '—';
    const diff = endMs - Date.now();
    if (diff <= 0) return st.ended_label;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (h >= 24) return `${Math.floor(h / 24)}${isAr ? 'ي' : 'd'} ${h % 24}${isAr ? 'س' : 'h'}`;
    if (h > 0) return `${h}${isAr ? 'س' : 'h'} ${m}${isAr ? 'د' : 'm'}`;
    return `${m}${isAr ? 'د' : 'm'}`;
  };

  // Redesign — bilingual metadata for each action-item kind.
  const actionMeta: Record<SellerAction['kind'], { icon: React.ElementType; label: string; cta: string; tone: string; iconTone: string }> = {
    dispute: { icon: AlertTriangle, label: st.act_dispute_label, cta: st.act_dispute_cta, tone: 'border-rose-200 bg-rose-50', iconTone: 'bg-rose-100 text-rose-600' },
    ship: { icon: Truck, label: st.act_ship_label, cta: st.act_ship_cta, tone: 'border-orange-200 bg-accent-weak', iconTone: 'bg-accent-weak text-[#FF6B00]' },
    relist: { icon: RotateCcw, label: st.act_relist_label, cta: st.act_relist_cta, tone: 'border-amber-200 bg-amber-50', iconTone: 'bg-amber-100 text-amber-600' },
    payout: { icon: Wallet, label: st.act_payout_label, cta: st.act_payout_cta, tone: 'border-emerald-200 bg-emerald-50', iconTone: 'bg-emerald-100 text-emerald-600' },
    verify: { icon: ShieldCheck, label: st.act_verify_label, cta: st.act_verify_cta, tone: 'border-indigo-200 bg-indigo-50', iconTone: 'bg-indigo-100 text-indigo-600' },
  };

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto w-full bg-surface h-full overflow-y-auto pb-[calc(6rem+env(safe-area-inset-bottom))] text-fg" id="seller-center-root">
      
      {/* HEADER SECTION */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-line pb-5" id="seller-header">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-accent-weak text-[#FF6B00] rounded-2xl">
            <Store className="w-7 h-7" />
          </div>
          <div className="text-left rtl:text-right">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-black text-fg leading-tight">
                {st.seller_center}
              </h1>
              {(() => {
                const myProfile = sellerProfiles?.find(p => p.userId === currentUser?.id);
                const vStatus = myProfile?.verificationStatus || currentUser?.verificationStatus || 'not_verified';

                // De-dupe the verify prompt: the "get verified" nudge lives ONLY in
                // the Overview "Needs your action" hub now. Here the badge is a
                // positive trust signal, so it renders for verified/premium/pending
                // states but stays hidden for not_verified (no third nag).
                if (vStatus === 'not_verified') return null;

                const vBadgeLabels = {
                  premium_verified: isAr ? 'توثيق متميز بلس' : 'Premium Verified +',
                  verified: isAr ? 'حساب بائع موثق' : 'Verified Seller Account',
                  pending: isAr ? 'طلب التوثيق قيد المراجعة' : 'Verification Under Review',
                  not_verified: isAr ? 'بائع غير موثق' : 'Unverified Seller Account'
                };
                
                const vBadgeColors = {
                  premium_verified: 'bg-amber-100 text-amber-800 border-amber-300',
                  verified: 'bg-emerald-100 text-[#107A48] border-emerald-300',
                  pending: 'bg-blue-100 text-blue-800 border-blue-300',
                  not_verified: 'bg-surface-sunken text-fg border-line'
                };

                return (
                  <span className={`inline-flex items-center gap-1 text-[10px] font-extrabold px-2.5 py-0.5 rounded-full border ${vBadgeColors[vStatus]}`}>
                    <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                    {vBadgeLabels[vStatus]}
                  </span>
                );
              })()}
            </div>
            <p className="text-xs text-fg-muted font-medium mt-1">
              {isAr ? 'إدارة أعمالك، المزادات والطلبات، الأرباح والمبيعات بكل سهولة.' : 'Manage listings, sales orders, payouts, reviews, and analytics.'}
            </p>
          </div>
        </div>
        {/* Wallet balance lives ONCE, in the Money section (canonical). The old
            header balance indicator was a duplicate and has been removed. */}
      </div>

      {/* TWO-COLUMN WORKSPACE FOR DESKTOP (LG+), VERTICAL FOR MOBILE (< LG) */}
      <div className="flex flex-col lg:flex-row gap-6">
        
        {/* SIDEBAR FOR LG+ */}
        <aside className="hidden lg:flex flex-col gap-1 w-[240px] shrink-0 bg-surface-raised p-3 rounded-2xl border border-line shadow-sm h-fit sticky top-20">
          {[
            { id: 'overview', label: st.overview, icon: Activity, badge: actionItems.length },
            { id: 'listings', label: st.listings, icon: Store },
            { id: 'orders', label: st.orders, icon: ShoppingBag },
            { id: 'money', label: st.money, icon: Wallet },
            { id: 'analytics', label: st.analytics, icon: BarChart3 }
          ].map((tab) => {
            const IconComponent = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => {
                  setActiveTab(tab.id as any);
                  setSelectedOrderId(null);
                }}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl text-xs font-black tracking-wide transition-all cursor-pointer w-full text-left rtl:text-right ${
                  isActive 
                    ? 'bg-accent-weak text-[#FF6B00] border border-orange-100 shadow-xs' 
                    : 'text-fg-muted hover:text-fg hover:bg-surface-sunken'
                }`}
              >
                <IconComponent className={`w-4 h-4 shrink-0 ${isActive ? 'text-[#FF6B00]' : 'text-fg-muted'}`} />
                <span className="flex-1">{tab.label}</span>
                {!!tab.badge && (
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold bg-red-500 text-white`}>
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </aside>

        {/* TOP SCROLLABLE NAVIGATION TABS FOR MOBILE/TABLET */}
        <div className="flex lg:hidden overflow-x-auto bg-surface-raised p-1.5 rounded-2xl border border-line shadow-sm scrollbar-none gap-1 w-full" id="seller-center-tabs">
          {[
            { id: 'overview', label: st.overview, icon: Activity, badge: actionItems.length },
            { id: 'listings', label: st.listings, icon: Store },
            { id: 'orders', label: st.orders, icon: ShoppingBag },
            { id: 'money', label: st.money, icon: Wallet },
            { id: 'analytics', label: st.analytics, icon: BarChart3 }
          ].map((tab) => {
            const IconComponent = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => {
                  setActiveTab(tab.id as any);
                  setSelectedOrderId(null);
                }}
                className={`flex items-center gap-2 px-4 py-3 rounded-xl text-xs font-black tracking-wide shrink-0 transition-all cursor-pointer ${
                  isActive 
                    ? 'bg-accent-weak text-[#FF6B00] border border-orange-100 shadow-xs' 
                    : 'text-fg-muted hover:text-fg hover:bg-surface-sunken'
                }`}
              >
                <IconComponent className={`w-4 h-4 shrink-0 ${isActive ? 'text-[#FF6B00]' : 'text-fg-muted'}`} />
                <span>{tab.label}</span>
                {!!tab.badge && (
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold bg-red-500 text-white`}>
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* RENDER ACTIVE TAB MAIN PANE */}
        <div className="flex-1 min-w-0 min-h-[400px]">
          {/* ======================= SECTION 1: OVERVIEW ======================= */}
          {activeTab === 'overview' && (
            <div className="space-y-6" id="tab-overview">

              {/* The seller's own details. Lives here rather than behind a tab
                  because until now the seller could not edit their public
                  shopfront at all, and their governorate was invented for them. */}
              {currentUser?.id && (
                <SellerDetailsForm
                  sellerId={currentUser.id}
                  profile={mySellerProfile}
                  isAr={isAr}
                />
              )}

              {/* NEEDS YOUR ACTION — the hub */}
              <div className="space-y-3" id="action-hub">
                <h3 className="text-xs font-black text-fg-muted uppercase tracking-wider flex items-center gap-2 px-1">
                  <Activity className="w-4 h-4 text-[#FF6B00]" />
                  <span>{st.needs_action}</span>
                </h3>

                {actionItems.length === 0 ? (
                  <div className="bg-surface-raised rounded-3xl border border-emerald-100 p-8 text-center shadow-[0_3px_10px_rgba(0,0,0,0.01)] space-y-2">
                    <div className="mx-auto w-14 h-14 rounded-2xl bg-emerald-50 flex items-center justify-center">
                      <CheckCircle className="w-7 h-7 text-emerald-500" />
                    </div>
                    <p className="text-sm font-black text-fg">{st.all_caught_up}</p>
                    <p className="text-xs text-fg-muted font-medium">{st.all_caught_up_sub}</p>
                  </div>
                ) : (
                  <div className="space-y-2.5" id="action-items">
                    {actionItems.map((action) => {
                      const meta = actionMeta[action.kind];
                      const ActionIcon = meta.icon;
                      const countText = action.kind === 'payout'
                        ? `${action.count.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} JOD`
                        : String(action.count);
                      return (
                        <button
                          key={action.kind}
                          onClick={() => handleActionCta(action)}
                          className={`w-full flex items-center gap-3 p-4 rounded-2xl border ${meta.tone} hover:shadow-sm active:scale-[0.99] transition-all cursor-pointer text-left rtl:text-right`}
                        >
                          <span className={`p-2.5 rounded-xl shrink-0 ${meta.iconTone}`}>
                            <ActionIcon className="w-5 h-5" />
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-black text-fg-on-light truncate">{meta.label}</p>
                            <p className="text-[11px] text-fg-on-light/70 font-bold tabular-nums">{countText}</p>
                          </div>
                          <span className="shrink-0 inline-flex items-center gap-1 px-3.5 py-2 rounded-xl bg-surface-on-light/80 border border-black/5 text-[11px] font-black text-fg-on-light">
                            <span>{meta.cta}</span>
                            <ChevronRight className="w-3.5 h-3.5 rtl:rotate-180" />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* TIGHT METRIC ROW — 4 */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" id="metric-row">
                {[
                  { title: st.active_listings, value: kpis.liveCount.toLocaleString(), icon: Store },
                  { title: st.live_bids_now, value: liveBidsNow.toLocaleString(), icon: Activity },
                  { title: st.this_month_sales, value: `${kpis.currentMonthSales.toLocaleString()} JOD`, icon: TrendingUp },
                  // Wallet balance is NOT duplicated here — its single home is the
                  // Money section. This slot surfaces open orders instead.
                  { title: st.pending_orders, value: kpis.pendingOrdersCount.toLocaleString(), icon: ShoppingBag },
                ].map((m, idx) => {
                  const MIcon = m.icon;
                  return (
                    <div key={idx} className="bg-surface-raised rounded-2xl p-4 border border-line shadow-sm flex items-center justify-between gap-2">
                      <div className="space-y-1 min-w-0">
                        <p className="text-[10px] text-fg-muted font-bold tracking-wide uppercase leading-none truncate">{m.title}</p>
                        <p className="text-base md:text-lg font-black text-fg leading-tight tabular-nums">{m.value}</p>
                      </div>
                      <div className="p-2 rounded-xl bg-accent-weak text-[#FF6B00] shrink-0">
                        <MIcon className="w-5 h-5 text-[#FF6B00]" />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* ONE CONSOLIDATED RECENT ACTIVITY FEED */}
              <div className="bg-surface-raised rounded-3xl border border-line p-5 shadow-[0_3px_10px_rgba(0,0,0,0.01)] space-y-4" id="recent-activity">
                <h3 className="text-sm font-black text-fg flex items-center gap-2">
                  <Bell className="w-4 h-4 text-[#FF6B00]" />
                  <span>{st.recent_activity}</span>
                </h3>
                {(() => {
                  const entries: { id: string; ts: number; title: string; sub: string; kind: 'order' | 'notif' }[] = [];
                  myOrders.forEach((o) => {
                    const ts = typeof o.createdAt === 'number' ? o.createdAt : (o.createdAt?.seconds ? o.createdAt.seconds * 1000 : 0);
                    entries.push({
                      id: `o-${o.id}`,
                      ts,
                      title: `${o.auctionTitle} · ${o.winningBidAmount} JOD`,
                      sub: `${isAr ? 'الحالة: ' : 'Status: '}${getOrderStatusChip(o.status, isAr ? 'ar' : 'en').label}`,
                      kind: 'order',
                    });
                  });
                  sellerNotifications.forEach((n) => {
                    entries.push({
                      id: `n-${n.id}`,
                      ts: n.timestamp || 0,
                      title: (isAr ? n.titleAr : n.titleEn) || (isAr ? n.titleEn : n.titleAr) || '',
                      sub: (isAr ? n.descriptionAr : n.descriptionEn) || '',
                      kind: 'notif',
                    });
                  });
                  entries.sort((a, b) => b.ts - a.ts);
                  const top = entries.slice(0, 8);
                  if (top.length === 0) {
                    return <div className="text-center py-8 text-fg-muted text-xs">{st.no_notifications}</div>;
                  }
                  return (
                    <div className="divide-y divide-line">
                      {top.map((e) => (
                        <div key={e.id} className="py-2.5 flex items-start gap-3">
                          <span className={`p-1.5 rounded-lg shrink-0 mt-0.5 ${e.kind === 'order' ? 'bg-accent-weak text-[#FF6B00]' : 'bg-blue-50 text-blue-500'}`}>
                            {e.kind === 'order' ? <Package className="w-3.5 h-3.5" /> : <Bell className="w-3.5 h-3.5" />}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs font-black text-fg truncate">{e.title}</p>
                              <span className="text-[9px] text-fg-muted font-mono shrink-0">
                                {e.ts ? new Date(e.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}
                              </span>
                            </div>
                            <p className="text-[11px] text-fg-muted truncate">{e.sub}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

          {/* ======================= SECTION 2: LISTINGS ======================= */}
          {activeTab === 'listings' && (
            <div className="space-y-4" id="tab-listings">

              {/* HEADER: + New Listing · search · category · bulk toggle */}
              <div className="flex flex-col md:flex-row md:items-center gap-3">
                <button
                  onClick={() => setActiveView('upload')}
                  className="inline-flex items-center justify-center gap-2 px-5 py-3 bg-[#FF6B00] hover:bg-orange-600 text-white font-black text-xs rounded-2xl transition-all shadow-sm active:scale-95 cursor-pointer shrink-0"
                >
                  <Plus className="w-4 h-4" />
                  <span>{st.new_listing}</span>
                </button>
                <div className="relative flex-1 min-w-0">
                  <Search className="w-4 h-4 text-fg-muted absolute top-1/2 -translate-y-1/2 left-3 rtl:left-auto rtl:right-3" />
                  <input
                    type="text"
                    value={listingsQuery}
                    onChange={(e) => setListingsQuery(e.target.value)}
                    placeholder={st.search_listings}
                    className="w-full pl-9 rtl:pl-3 rtl:pr-9 pr-3 py-3 rounded-2xl border border-line bg-surface-raised outline-none focus:border-[#FF6B00] text-xs font-semibold text-fg"
                  />
                </div>
                <select
                  value={listingsCategory}
                  onChange={(e) => setListingsCategory(e.target.value)}
                  className="px-3 py-3 rounded-2xl border border-line bg-surface-raised outline-none focus:border-[#FF6B00] text-xs font-bold text-fg cursor-pointer shrink-0"
                >
                  <option value="all">{st.all_categories}</option>
                  {listingCategories.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <button
                  onClick={() => (bulkMode ? exitBulkMode() : setBulkMode(true))}
                  className={`px-4 py-3 rounded-2xl text-xs font-black transition-all active:scale-95 cursor-pointer shrink-0 border ${
                    bulkMode ? 'bg-gray-900 text-white border-gray-900' : 'bg-surface-raised text-fg-muted border-line hover:bg-surface-sunken'
                  }`}
                >
                  {bulkMode ? st.exit_select : st.select_mode}
                </button>
              </div>

              {/* BUCKET CHIPS */}
              <div className="flex bg-surface-sunken p-1 rounded-xl border border-line gap-1 overflow-x-auto scrollbar-none">
                {[
                  { id: 'all', label: st.bucket_all, count: myAuctions.length },
                  { id: 'live', label: st.bucket_live, count: listingBuckets.live.length },
                  { id: 'scheduled', label: st.bucket_scheduled, count: listingBuckets.scheduled.length },
                  { id: 'review', label: st.bucket_review, count: listingBuckets.review.length },
                  { id: 'endedUnsold', label: st.bucket_ended, count: listingBuckets.endedUnsold.length },
                  { id: 'sold', label: st.bucket_sold, count: listingBuckets.sold.length },
                  { id: 'rejected', label: st.bucket_rejected, count: listingBuckets.rejected.length },
                ].map((chip) => (
                  <button
                    key={chip.id}
                    onClick={() => setActiveBucket(chip.id as any)}
                    className={`py-2 text-center rounded-xl text-xs font-bold shrink-0 px-3 transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                      activeBucket === chip.id ? 'bg-surface-raised text-fg shadow-xs border border-line' : 'text-fg-muted hover:text-fg'
                    }`}
                  >
                    <span>{chip.label}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${activeBucket === chip.id ? 'bg-[#FF6B00]/10 text-[#FF6B00]' : 'bg-surface-sunken text-fg-muted'}`}>
                      {chip.count}
                    </span>
                  </button>
                ))}
              </div>

              {/* LIST */}
              {myAuctions.length === 0 ? (
                <div className="bg-surface-raised rounded-3xl p-12 text-center border border-line space-y-4" id="seller-empty-state">
                  <div className="mx-auto w-14 h-14 rounded-2xl bg-accent-weak border border-orange-100 flex items-center justify-center">
                    <PlusCircle className="w-7 h-7 text-[#FF6B00]" />
                  </div>
                  <p className="text-sm font-black text-fg">{st.no_listings_yet}</p>
                  <button
                    onClick={() => setActiveView('upload')}
                    className="inline-flex items-center gap-2 px-6 py-3 bg-[#FF6B00] hover:bg-orange-600 text-white font-black text-xs rounded-2xl transition-all shadow-sm active:scale-95 cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    <span>{st.start_selling}</span>
                  </button>
                </div>
              ) : visibleListings.length === 0 ? (
                <div className="bg-surface-raised rounded-3xl p-12 text-center border border-line text-fg-muted text-sm">
                  {st.no_auctions}
                </div>
              ) : (
                <div className="bg-surface-raised rounded-3xl border border-line overflow-hidden shadow-[0_2px_8px_rgba(0,0,0,0.015)] divide-y divide-line">
                  {visibleListings.map((auction) => {
                    const canEdit = auction.status === 'processing' || (auction.status as string) === 'pending' || auction.status === 'rejected';
                    const canRelist = auction.status !== 'live' && auction.status !== 'upcoming';
                    const isSelected = selectedIds.has(auction.id);
                    // E3 Slice C — below-reserve near-miss: offer awaiting THIS
                    // seller's decision and still within its 24h window.
                    const offer = auction.belowReserveOffer;
                    // Shared with the server's own guard vocabulary via
                    // utils/reserveStatus — the inline timestamp decoding this
                    // replaces treated a MISSING expiresAt as expiry 0 and then
                    // rescued it with `!offerExpMs`, which is the same fail-open
                    // answer by accident rather than on purpose.
                    const showAcceptOffer = offerAwaitsSeller(offer, Date.now());
                    // Second Chance Offer (winner defaulted). Same pure decision
                    // the card itself makes, asked here only so the card's
                    // wrapper margin doesn't render around nothing.
                    //
                    // `currentUser`, NOT `currentUser?.id` — the viewer is a USER.
                    // An id here reads `viewer?.id === undefined`, matches neither
                    // party, and pins this gate to false forever, silently removing
                    // the seller's ONLY in-app surface for a pending_seller offer
                    // (MyOrders queries by `secondChanceOffer.bidderId`, so it shows
                    // the card to the runner-up alone). `useApp()` is implicitly
                    // `any` in this repo, so tsc will NOT catch that mistake —
                    // SecondChanceCard.wiring.test.ts is what catches it.
                    const showSecondChance = secondChanceViewState(auction, currentUser, Date.now()).visible;
                    return (
                      <div key={auction.id} className="hover:bg-surface-sunken/50 transition-colors">
                      <div className="p-3.5 flex items-center gap-3">
                        {bulkMode && (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelected(auction.id)}
                            className="w-4 h-4 accent-[#FF6B00] shrink-0 cursor-pointer"
                          />
                        )}
                        <div className="w-14 h-14 rounded-xl overflow-hidden shrink-0 border border-line bg-surface-sunken">
                          <ListingImage
                            src={auction.thumbnailUrl}
                            alt={auction.title}
                            isAr={isAr}
                            className="w-full h-full"
                            imgClassName="object-cover"
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h4 className="text-sm font-black text-fg truncate">{auction.title}</h4>
                            <span className={`px-2 py-0.5 rounded-full text-[8px] font-black tracking-wider uppercase shrink-0 ${
                              auction.status === 'live' ? 'bg-red-500 text-white' :
                              auction.status === 'upcoming' ? 'bg-blue-500 text-white' :
                              auction.status === 'completed' ? 'bg-emerald-500 text-white' :
                              auction.status === 'rejected' ? 'bg-rose-500 text-white' :
                              'bg-zinc-500 text-white'
                            }`}>
                              {auctionStatusLabel(auction.status, isAr)}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-[11px] text-fg-muted font-bold tabular-nums flex-wrap">
                            <span className="text-fg font-black">{auction.currentPrice || auction.startingPrice} JOD</span>
                            <span>{auction.totalBids || 0} {isAr ? 'مزايدة' : 'bids'}</span>
                            {auction.status === 'live' && (
                              <span className="inline-flex items-center gap-1 text-[#FF6B00]"><Clock className="w-3 h-3" />{timeLeftLabel(auction)}</span>
                            )}
                          </div>
                        </div>
                        {!bulkMode && (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              onClick={() => setViewAuctionId(auction.id)}
                              className="p-2 rounded-xl text-[#FF6B00] bg-[#FF6B00]/10 hover:bg-[#FF6B00]/20 active:scale-95 transition-all cursor-pointer"
                              title={st.view}
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                            {canEdit && (
                              <button
                                onClick={() => handleEditClick(auction)}
                                className="p-2 rounded-xl text-fg-muted hover:text-fg bg-surface-raised border border-line hover:bg-surface-sunken cursor-pointer active:scale-95 transition-all"
                                title={auction.status === 'rejected' ? st.resubmit : st.edit}
                              >
                                <Edit className="w-4 h-4" />
                              </button>
                            )}
                            {canRelist && (
                              <button
                                onClick={() => handleDuplicate(auction)}
                                className="p-2 rounded-xl text-fg-muted hover:text-fg bg-surface-raised border border-line hover:bg-surface-sunken cursor-pointer active:scale-95 transition-all"
                                title={st.relist}
                              >
                                <Copy className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      {/* What to fix. `rejectionReason` has been stored on every
                          reject since the review gate shipped and shown nowhere,
                          so a seller sent back for a wrong category was told
                          only that they had failed. Mirrors the below-reserve
                          banner's markup so the card keeps one visual language. */}
                      {auction.status === 'rejected' && auction.rejectionReason && (
                        <div className="mx-3.5 mb-3.5 rounded-2xl border border-amber-200 bg-amber-50 p-3.5" id={`needs-editing-${auction.id}`}>
                          <div className="flex items-start gap-2">
                            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                            <div className="min-w-0 space-y-0.5">
                              <p className="text-[11.5px] font-black text-amber-900 leading-snug">
                                {rejectionPresetLabel(auction.rejectionReason, isAr)}
                              </p>
                              <p className="text-[10px] text-amber-700/90 font-semibold leading-relaxed">
                                {isAr
                                  ? 'عدّل الإعلان ثم أعد إرساله للمراجعة.'
                                  : 'Edit the listing and resubmit it for review.'}
                              </p>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* E3 Slice C — below-reserve near-miss: accept the top bid */}
                      {showAcceptOffer && (
                        <div className="mx-3.5 mb-3.5 rounded-2xl border border-amber-200 bg-amber-50 p-3.5 space-y-2.5" id={`below-reserve-offer-${auction.id}`}>
                          <div className="flex items-start gap-2">
                            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                            <div className="min-w-0 space-y-0.5">
                              <p className="text-[11.5px] font-black text-amber-900 leading-snug">
                                {isAr
                                  ? `أعلى مزايدة ${(offer!.topBid).toLocaleString()} د.أ — أقل من السعر المطلوب. تقبلها؟`
                                  : `Top bid was ${(offer!.topBid).toLocaleString()} JOD — below your reserve. Accept it?`}
                              </p>
                              <p className="text-[10px] text-amber-700/90 font-semibold leading-relaxed">
                                {isAr
                                  ? 'عند القبول، يُرسل العرض للمشتري ليؤكد الشراء قبل أن يصبح طلباً نهائياً. عند الرفض، يمكنك إعادة إدراج القطعة فوراً.'
                                  : 'If you accept, the offer goes to the buyer to confirm before it becomes a final order. If you reject, you can relist the item straight away.'}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleAcceptBelowReserve(auction.id)}
                              disabled={acceptingOfferId === auction.id || rejectingOfferId === auction.id}
                              className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white font-black text-xs rounded-xl transition-all active:scale-[0.98] cursor-pointer"
                              id={`accept-below-reserve-${auction.id}`}
                            >
                              <span>
                                {acceptingOfferId === auction.id
                                  ? (isAr ? 'جارٍ...' : 'Accepting...')
                                  : (isAr ? 'اقبل آخر سعر' : 'Accept last price')}
                              </span>
                            </button>
                            <button
                              onClick={() => handleRejectBelowReserve(auction.id)}
                              disabled={acceptingOfferId === auction.id || rejectingOfferId === auction.id}
                              className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-surface-raised hover:bg-surface-sunken disabled:opacity-60 border border-amber-300 text-amber-900 font-black text-xs rounded-xl transition-all active:scale-[0.98] cursor-pointer"
                              id={`reject-below-reserve-${auction.id}`}
                            >
                              <span>
                                {rejectingOfferId === auction.id
                                  ? (isAr ? 'جارٍ...' : 'Rejecting...')
                                  : (isAr ? 'ارفض العرض' : 'Reject offer')}
                              </span>
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Second Chance Offer — the winner defaulted and the lot
                          was offered to the runner-up. Same slot, same layout as
                          the below-reserve card above; who may press what is
                          decided in utils/secondChanceOffer, NOT here. */}
                      {showSecondChance && (
                        <SecondChanceCard
                          auction={auction}
                          currentUser={currentUser}
                          isAr={isAr}
                          onRespond={respondToSecondChance}
                          compact
                          className="mx-3.5 mb-3.5"
                        />
                      )}
                    </div>
                    );
                  })}
                </div>
              )}

              {/* STICKY BULK ACTION BAR */}
              {bulkMode && selectedIds.size > 0 && (
                <div className="sticky bottom-4 z-10 bg-gray-900 text-white rounded-2xl shadow-2xl p-3 flex items-center justify-between gap-3" id="bulk-bar">
                  <span className="text-xs font-black px-2 tabular-nums">{selectedIds.size} {st.selected_count}</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleRelistSelected}
                      className="inline-flex items-center gap-1.5 px-4 py-2 bg-surface-raised text-fg rounded-xl text-xs font-black hover:bg-surface-sunken active:scale-95 transition-all cursor-pointer"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>{st.relist_selected}</span>
                    </button>
                    <button
                      onClick={handleCancelSelected}
                      className="inline-flex items-center gap-1.5 px-4 py-2 bg-rose-500 text-white rounded-xl text-xs font-black hover:bg-rose-600 active:scale-95 transition-all cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>{st.cancel_selected}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ======================= SECTION 3: ORDERS ======================= */}
          {activeTab === 'orders' && (
            <div className="space-y-4" id="tab-orders">
              {selectedOrderId ? (
                <div className="bg-surface-raised rounded-3xl p-5 border border-line shadow-[0_3px_15px_rgba(0,0,0,0.01)] relative">
                  <button
                    onClick={() => setSelectedOrderId(null)}
                    className="absolute top-4 left-4 rtl:left-auto rtl:right-4 p-2 bg-surface-sunken hover:bg-surface-sunken rounded-xl cursor-pointer text-fg-muted transition-all z-10"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <div className="pt-8">
                    <OrderDetailsView orderId={selectedOrderId} onBack={() => setSelectedOrderId(null)} />
                  </div>
                </div>
              ) : (
                <>
                  {/* STATUS FILTER CHIPS */}
                  <div className="flex bg-surface-sunken p-1 rounded-xl border border-line gap-1 overflow-x-auto scrollbar-none">
                    {[
                      { id: 'all', label: st.ord_all, count: myOrders.length },
                      { id: 'to_ship', label: st.ord_to_ship, count: myOrders.filter(o => o.status === 'paid' || o.status === 'preparing_shipment').length },
                      { id: 'shipped', label: st.ord_shipped, count: myOrders.filter(isInTransitOrder).length },
                      { id: 'completed', label: st.ord_completed, count: myOrders.filter(o => o.status === 'completed').length },
                      { id: 'disputed', label: st.ord_disputed, count: myOrders.filter(o => o.status === 'disputed').length },
                    ].map((chip) => (
                      <button
                        key={chip.id}
                        onClick={() => setOrdersFilter(chip.id as any)}
                        className={`py-2 text-center rounded-xl text-xs font-bold shrink-0 px-3 transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                          ordersFilter === chip.id ? 'bg-surface-raised text-fg shadow-xs border border-line' : 'text-fg-muted hover:text-fg'
                        }`}
                      >
                        <span>{chip.label}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${ordersFilter === chip.id ? 'bg-[#FF6B00]/10 text-[#FF6B00]' : 'bg-surface-sunken text-fg-muted'}`}>
                          {chip.count}
                        </span>
                      </button>
                    ))}
                  </div>

                  <div className="bg-surface-raised rounded-3xl border border-line overflow-hidden shadow-[0_3px_12px_rgba(0,0,0,0.01)]">
                    {myOrders.length === 0 ? (
                      <div className="text-center py-12 text-fg-muted text-sm">{st.no_orders}</div>
                    ) : visibleOrders.length === 0 ? (
                      <div className="text-center py-12 text-fg-muted text-sm">{st.no_auctions}</div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left rtl:text-right border-collapse text-xs">
                          <thead>
                            <tr className="bg-surface-sunken border-b border-line text-fg-muted font-black tracking-wider uppercase">
                              <th className="p-4">{isAr ? 'المنتج والمزاد' : 'Auction / Item'}</th>
                              <th className="p-4">{st.buyer}</th>
                              <th className="p-4">{st.price}</th>
                              <th className="p-4">{st.status}</th>
                              <th className="p-4 text-center">{isAr ? 'الإجراء' : 'Actions'}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-line font-semibold text-fg">
                            {visibleOrders.map((order) => (
                              <tr key={order.id} className="hover:bg-surface-sunken/50 transition-colors">
                                <td className="p-4">
                                  <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-xl overflow-hidden shrink-0 border border-line bg-surface-sunken">
                                      <img src={order.auctionImage || ''} className="w-full h-full object-cover" />
                                    </div>
                                    <div className="max-w-[150px] lg:max-w-[200px]">
                                      <p className="font-extrabold text-fg truncate">{order.auctionTitle}</p>
                                      <p className="text-[10px] text-fg-muted font-mono">{displayOrderRef(order)}</p>
                                    </div>
                                  </div>
                                </td>
                                <td className="p-4">
                                  <p className="text-fg font-extrabold">{order.buyerName}</p>
                                  <p className="text-[10px] text-fg-muted font-mono">ID: {order.buyerId.substring(0, 8)}</p>
                                </td>
                                <td className="p-4 font-black text-fg">{order.winningBidAmount} JOD</td>
                                <td className="p-4">
                                  <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[9px] font-black tracking-wider uppercase ${ORDER_STATUS_TONE_CHIP[getOrderStatusChip(order.status, isAr ? 'ar' : 'en').tone]} ${order.status === 'disputed' ? 'animate-pulse' : ''}`}>
                                    {getOrderStatusChip(order.status, isAr ? 'ar' : 'en').label}
                                  </span>
                                </td>
                                <td className="p-4 text-center">
                                  <button
                                    onClick={() => setSelectedOrderId(order.id)}
                                    className="px-3.5 py-2 bg-gradient-to-r from-[#FF6B00] to-orange-500 text-white rounded-xl font-bold hover:shadow-md hover:shadow-orange-500/10 active:scale-95 transition-all text-[11px] cursor-pointer"
                                  >
                                    {st.open_details}
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ======================= SECTION 4: MONEY ======================= */}
          {activeTab === 'money' && (
            <div className="space-y-6" id="tab-money">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="bg-surface-raised rounded-3xl p-6 border border-line shadow-[0_3px_10px_rgba(0,0,0,0.015)] relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-8 text-emerald-50/40 transform translate-x-2 -translate-y-2">
                    <Wallet className="w-24 h-24 stroke-[1]" />
                  </div>
                  <div className="space-y-4">
                    <span className="p-2.5 bg-emerald-50 text-emerald-600 rounded-2xl inline-block">
                      <Wallet className="w-6 h-6" />
                    </span>
                    <div className="space-y-1">
                      <p className="text-[10px] text-fg-muted font-black tracking-wider uppercase leading-none">{st.available_balance}</p>
                      <p className="text-2xl font-black text-fg tabular-nums">{kpis.availableBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })} JOD</p>
                    </div>
                    <div className="flex gap-2 pt-2">
                      <button
                        onClick={() => setIsWithdrawModalOpen('bank')}
                        className="flex-1 py-2.5 bg-gray-900 text-white rounded-xl text-xs font-black hover:bg-black active:scale-95 transition-all cursor-pointer flex items-center justify-center gap-1 shadow-md shadow-black/10"
                      >
                        <Building2 className="w-3.5 h-3.5" />
                        <span>{st.withdraw_bank}</span>
                      </button>
                      <button
                        onClick={() => setIsWithdrawModalOpen('cliq')}
                        className="flex-1 py-2.5 bg-[#FF6B00] text-white rounded-xl text-xs font-black hover:bg-orange-600 active:scale-95 transition-all cursor-pointer flex items-center justify-center gap-1 shadow-md shadow-[#FF6B00]/10"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>{st.withdraw_cliq}</span>
                      </button>
                    </div>
                  </div>
                </div>

                <div className="bg-surface-raised rounded-3xl p-6 border border-line shadow-[0_3px_10px_rgba(0,0,0,0.015)] space-y-4">
                  <span className="p-2.5 bg-amber-50 text-amber-600 rounded-2xl inline-block">
                    <Clock className="w-6 h-6" />
                  </span>
                  <div className="space-y-1">
                    <p className="text-[10px] text-fg-muted font-black tracking-wider uppercase leading-none">{st.escrow_pending}</p>
                    <p className="text-2xl font-black text-fg tabular-nums">{kpis.escrowLocked.toLocaleString(undefined, { minimumFractionDigits: 2 })} JOD</p>
                    <p className="text-[10px] text-fg-muted">
                      {isAr ? 'أموال مبيعاتك المحتجزة بأمان في حساب الضمان لحين تأكيد التسليم — ستستلم صافي بعد عمولة ٥٪.' : 'Funds held securely in Escrow until buyer inspection completed — you receive the net after 5% commission.'}
                    </p>
                  </div>
                </div>

                <div className="bg-surface-raised rounded-3xl p-6 border border-line shadow-[0_3px_10px_rgba(0,0,0,0.015)] space-y-4">
                  <span className="p-2.5 bg-indigo-50 text-indigo-600 rounded-2xl inline-block">
                    <CheckCircle className="w-6 h-6" />
                  </span>
                  <div className="space-y-1">
                    <p className="text-[10px] text-fg-muted font-black tracking-wider uppercase leading-none">{st.funds_released}</p>
                    <p className="text-2xl font-black text-fg tabular-nums">
                      {myOrders.filter(o => o.escrowStatus === 'released').reduce((sum, o) => sum + (o.sellerNet ?? sellerNet(o.winningBidAmount)), 0).toLocaleString(undefined, { minimumFractionDigits: 2 })} JOD
                    </p>
                    <p className="text-[10px] text-fg-muted">
                      {isAr ? 'إجمالي الأموال التي تم تحريرها بالكامل من الضمان وإيداعها بنجاح — صافي بعد عمولة ٥٪.' : 'Total historical assets released and deposited successfully — net of 5% commission.'}
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-surface-raised rounded-3xl border border-line overflow-hidden shadow-[0_3px_12px_rgba(0,0,0,0.01)] space-y-4 p-5">
                <div className="flex items-center justify-between border-b border-line pb-4">
                  <h3 className="text-sm font-black text-fg flex items-center gap-2">
                    <Wallet className="w-4 h-4 text-[#FF6B00]" />
                    <span>{st.withdrawal_history}</span>
                  </h3>
                </div>

                {withdrawals.length === 0 ? (
                  <div className="text-center py-8 text-fg-muted text-xs">
                    {isAr ? 'لا يوجد عمليات سحب مالي مسجلة بعد.' : 'No withdrawals recorded yet.'}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left rtl:text-right border-collapse text-xs">
                      <thead>
                        <tr className="bg-surface-sunken border-b border-line text-fg-muted font-black uppercase tracking-wider">
                          <th className="p-4">{isAr ? 'رقم المعاملة' : 'Reference ID'}</th>
                          <th className="p-4">{isAr ? 'التاريخ والوقت' : 'Date & Time'}</th>
                          <th className="p-4">{isAr ? 'المبلغ' : 'Amount'}</th>
                          <th className="p-4">{isAr ? 'وسيلة السحب' : 'Method'}</th>
                          <th className="p-4">{isAr ? 'التفاصيل والوجهة' : 'Recipient Details'}</th>
                          <th className="p-4">{isAr ? 'حالة الطلب' : 'Status'}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line font-semibold text-fg">
                        {withdrawals.map((w) => (
                          <tr key={w.id} className="hover:bg-surface-sunken/30 transition-colors">
                            <td className="p-4 font-mono font-black text-fg">{w.referenceId}</td>
                            <td className="p-4 text-fg-muted">
                              {new Date(w.timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                            </td>
                            <td className="p-4 font-black text-fg tabular-nums">{w.amount} JOD</td>
                            <td className="p-4">
                              <span className="capitalize font-extrabold">{w.method === 'bank' ? (isAr ? 'تحويل بنكي' : 'Bank Wire') : 'CliQ'}</span>
                            </td>
                            <td className="p-4 text-fg-muted font-mono text-[11px] max-w-[200px] truncate">
                              {w.method === 'bank' ? (
                                <span>{w.details?.bankName} - {w.details?.iban}</span>
                              ) : (
                                <span>CliQ: {w.details?.cliqAlias || w.details?.phone}</span>
                              )}
                            </td>
                            <td className="p-4">
                              <span className={`px-2 py-0.5 rounded-full text-[9px] font-black uppercase ${
                                w.status === 'completed' ? 'bg-emerald-50 text-emerald-700' :
                                w.status === 'rejected' ? 'bg-rose-50 text-rose-700' :
                                'bg-amber-50 text-amber-700'
                              }`}>
                                {w.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ======================= SECTION 5: ANALYTICS (+ REVIEWS) ======================= */}
          {activeTab === 'analytics' && (
            <div className="space-y-6" id="tab-analytics">
              {/* SUMMARY: avg rating card */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-surface-raised rounded-3xl p-5 border border-line shadow-[0_3px_10px_rgba(0,0,0,0.015)] flex items-center gap-4">
                  <span className="p-3 bg-yellow-50 text-yellow-500 rounded-2xl inline-block">
                    <Star className="w-6 h-6 fill-current" />
                  </span>
                  <div>
                    <p className="text-[10px] text-fg-muted font-black tracking-wider uppercase leading-none">{st.avg_rating_card}</p>
                    {avgRatingDisplay === null ? (
                      <>
                        <p className="text-base font-black text-fg-muted leading-tight mt-0.5">{isAr ? 'لا تقييمات بعد' : 'No reviews yet'}</p>
                        <p className="text-[10px] text-fg-muted font-bold tabular-nums">{reviewCountLabel(0, isAr ? 'ar' : 'en')}</p>
                      </>
                    ) : (
                      <>
                        <p className="text-2xl font-black text-fg tabular-nums">{avgRatingDisplay} <span className="text-sm text-fg-muted">/ 5.0</span></p>
                        <p className="text-[10px] text-fg-muted font-bold tabular-nums">{reviewCountLabel(reviews.length, isAr ? 'ar' : 'en')}</p>
                      </>
                    )}
                  </div>
                </div>
                <div className="bg-surface-raised rounded-3xl p-5 border border-line shadow-[0_3px_10px_rgba(0,0,0,0.015)] flex items-center gap-4">
                  <span className="p-3 bg-emerald-50 text-emerald-600 rounded-2xl inline-block">
                    <CheckCircle className="w-6 h-6" />
                  </span>
                  <div>
                    <p className="text-[10px] text-fg-muted font-black tracking-wider uppercase leading-none">{st.completed_sales}</p>
                    <p className="text-2xl font-black text-fg tabular-nums">{kpis.completedSalesCount}</p>
                  </div>
                </div>
                <div className="bg-surface-raised rounded-3xl p-5 border border-line shadow-[0_3px_10px_rgba(0,0,0,0.015)] flex items-center gap-4">
                  <span className="p-3 bg-accent-weak text-[#FF6B00] rounded-2xl inline-block">
                    <DollarSign className="w-6 h-6" />
                  </span>
                  <div>
                    <p className="text-[10px] text-fg-muted font-black tracking-wider uppercase leading-none">{st.total_revenue}</p>
                    <p className="text-2xl font-black text-fg tabular-nums">{kpis.totalRev.toLocaleString(undefined, { maximumFractionDigits: 2 })} JOD</p>
                    <p className="text-[9.5px] text-fg-muted font-bold">{isAr ? 'صافي بعد عمولة ٥٪' : 'net of 5% commission'}</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-surface-raised rounded-3xl border border-line p-5 shadow-[0_3px_10px_rgba(0,0,0,0.015)] space-y-4">
                  <h4 className="text-xs font-black text-fg uppercase tracking-wider border-b border-line pb-2">{st.daily_sales}</h4>
                  {chartData.dailyData.some(d => d.sales > 0) ? (
                    <div className="h-64 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={chartData.dailyData}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} />
                          <XAxis dataKey="name" stroke="#94a3b8" fontSize={11} fontStyle="bold" />
                          <YAxis stroke="#94a3b8" fontSize={11} />
                          <Tooltip formatter={(value) => [`${value} JOD`, isAr ? 'المبيعات' : 'Sales']} />
                          <Bar dataKey="sales" fill="#FF6B00" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="h-64 w-full flex items-center justify-center">
                      <p className="text-xs text-fg-muted">{isAr ? 'لا توجد بيانات بعد' : 'No data yet'}</p>
                    </div>
                  )}
                </div>

                <div className="bg-surface-raised rounded-3xl border border-line p-5 shadow-[0_3px_10px_rgba(0,0,0,0.015)] space-y-4">
                  <h4 className="text-xs font-black text-fg uppercase tracking-wider border-b border-line pb-2">{st.monthly_rev}</h4>
                  {chartData.monthlyData.some(d => d.revenue > 0) ? (
                    <div className="h-64 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData.monthlyData}>
                          <defs>
                            <linearGradient id="colorRev" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#FF6B00" stopOpacity={0.4}/>
                              <stop offset="95%" stopColor="#FF6B00" stopOpacity={0}/>
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} />
                          <XAxis dataKey="name" stroke="#94a3b8" fontSize={11} fontStyle="bold" />
                          <YAxis stroke="#94a3b8" fontSize={11} />
                          <Tooltip formatter={(value) => [`${value} JOD`, isAr ? 'الإيرادات' : 'Revenue']} />
                          <Area type="monotone" dataKey="revenue" stroke="#FF6B00" fillOpacity={1} fill="url(#colorRev)" strokeWidth={3} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="h-64 w-full flex items-center justify-center">
                      <p className="text-xs text-fg-muted">{isAr ? 'لا توجد بيانات بعد' : 'No data yet'}</p>
                    </div>
                  )}
                </div>

                <div className="bg-surface-raised rounded-3xl border border-line p-5 shadow-[0_3px_10px_rgba(0,0,0,0.015)] space-y-4">
                  <h4 className="text-xs font-black text-fg uppercase tracking-wider border-b border-line pb-2">{st.views_vs_bids}</h4>
                  {chartData.viewsVsBidsData.some(d => d.views > 0 || d.bids > 0) ? (
                    <div className="h-64 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={chartData.viewsVsBidsData}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} />
                          <XAxis dataKey="name" stroke="#94a3b8" fontSize={10} />
                          <YAxis stroke="#94a3b8" fontSize={11} />
                          <Tooltip />
                          <Legend />
                          <Bar dataKey="views" name={isAr ? 'المشاهدات' : 'Views'} fill="#94a3b8" radius={[4, 4, 0, 0]} />
                          <Bar dataKey="bids" name={isAr ? 'المزايدات' : 'Bids'} fill="#FF6B00" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="h-64 w-full flex items-center justify-center">
                      <p className="text-xs text-fg-muted">{isAr ? 'لا توجد بيانات بعد' : 'No data yet'}</p>
                    </div>
                  )}
                </div>

                <div className="bg-surface-raised rounded-3xl border border-line p-5 shadow-[0_3px_10px_rgba(0,0,0,0.015)] space-y-4">
                  <h4 className="text-xs font-black text-fg uppercase tracking-wider border-b border-line pb-2">{st.top_categories}</h4>
                  <div className="h-64 w-full flex items-center justify-center">
                    {chartData.categoryData.length === 0 ? (
                      <p className="text-xs text-fg-muted">{isAr ? 'لا يوجد بيانات كافية للفئات.' : 'No categories data.'}</p>
                    ) : (
                      <div className="flex flex-col md:flex-row items-center justify-around w-full">
                        <div className="h-48 w-48 shrink-0">
                          <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                              <Pie data={chartData.categoryData} cx="50%" cy="50%" innerRadius={60} outerRadius={80} paddingAngle={5} dataKey="value">
                                {chartData.categoryData.map((entry, index) => (
                                  <Cell key={`cell-${index}`} fill={chartData.COLORS[index % chartData.COLORS.length]} />
                                ))}
                              </Pie>
                              <Tooltip formatter={(value) => [`${value} ${isAr ? 'مزاد' : 'Auctions'}`, 'Count']} />
                            </PieChart>
                          </ResponsiveContainer>
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-fg-muted font-bold max-w-[200px] py-4">
                          {chartData.categoryData.map((entry, index) => (
                            <div key={entry.name} className="flex items-center gap-1.5">
                              <span className="w-3 h-3 rounded" style={{ backgroundColor: chartData.COLORS[index % chartData.COLORS.length] }}></span>
                              <span className="truncate max-w-[80px]">{entry.name}: {entry.value}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* BUYER REVIEWS — folded in from the old Reviews tab */}
              <div className="bg-surface-raised rounded-3xl border border-line p-5 shadow-[0_3px_10px_rgba(0,0,0,0.01)]">
                <h3 className="text-sm font-black text-fg border-b border-line pb-4 mb-4 flex items-center gap-2">
                  <Star className="w-4 h-4 text-[#FF6B00]" />
                  <span>{st.buyer_feedback}</span>
                </h3>

                {reviews.length === 0 ? (
                  <div className="text-center py-12 text-fg-muted text-sm">{st.no_reviews}</div>
                ) : (
                  <div className="space-y-5">
                    {reviews.map((rev) => (
                      <div key={rev.id} className="p-4 rounded-2xl border border-line bg-surface-sunken/30 flex flex-col gap-3">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                          <div className="flex items-center gap-3">
                            <img src={resolveAvatarUrl(rev.buyerAvatar, rev.buyerId)} alt={rev.buyerName} className="w-10 h-10 rounded-full border border-line" />
                            <div>
                              <p className="font-extrabold text-xs text-fg">{rev.buyerName}</p>
                              <p className="text-[10px] text-fg-muted font-mono">
                                {new Date(rev.timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                              </p>
                            </div>
                          </div>
                          <div className="flex flex-col items-start md:items-end gap-1">
                            <div className="flex items-center gap-1 text-yellow-500">
                              {Array.from({ length: 5 }).map((_, i) => (
                                <Star key={i} className={`w-3.5 h-3.5 ${i < rev.rating ? 'fill-current' : 'text-gray-200'}`} />
                              ))}
                            </div>
                            <p className="text-[10px] text-fg-muted font-medium">
                              {isAr ? 'المعاملة:' : 'Item:'} <span className="font-bold text-fg-muted font-mono">{rev.auctionTitle}</span>
                            </p>
                          </div>
                        </div>

                        <p className="text-xs text-fg leading-relaxed font-semibold italic bg-surface-raised p-3 rounded-xl border border-line shadow-[0_2px_8px_rgba(0,0,0,0.005)]">
                          "{rev.comment}"
                        </p>

                        {rev.response ? (
                          <div className="ml-6 rtl:ml-0 rtl:mr-6 p-3 bg-[#FF6B00]/5 rounded-xl border border-[#FF6B00]/10 space-y-1">
                            <div className="flex items-center gap-1.5 text-[10px] text-[#FF6B00] font-black tracking-wider uppercase">
                              <Store className="w-3.5 h-3.5" />
                              <span>{isAr ? 'ردك المهني:' : 'Your Response:'}</span>
                            </div>
                            <p className="text-xs text-fg leading-relaxed font-semibold">{rev.response}</p>
                          </div>
                        ) : (
                          <ReviewResponseForm reviewId={rev.id} onReply={(text) => handleReviewReply(rev.id, text)} isAr={isAr} st={st} />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
      </div>
    </div>

      {/* RENDER DYNAMIC REUSABLE VIEW MODALS — resolve the lot from the admin
          auctions list (admin listener out of 1b scope), off the broad array
          for the modal itself (1b Task 4). Mount only when the lot is in hand. */}
      {(() => {
        if (!viewAuctionId) return null;
        const detailsLot = auctions.find(a => a.id === viewAuctionId);
        if (!detailsLot) return null;
        return (
          <AuctionDetailsModal auction={detailsLot} onClose={() => setViewAuctionId(null)} />
        );
      })()}

      {/* WITHDRAWAL FORM MODAL */}
      {isWithdrawModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in" id="withdrawal-modal">
          <div className="bg-surface-raised rounded-3xl p-6 max-w-md w-full border border-line shadow-2xl relative space-y-4">
            <button 
              onClick={() => setIsWithdrawModalOpen(null)}
              className="absolute top-4 right-4 rtl:right-auto rtl:left-4 p-2 text-fg-muted hover:text-fg bg-surface-sunken rounded-xl cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="flex items-center gap-2 border-b border-line pb-3">
              <Wallet className="w-5 h-5 text-[#FF6B00]" />
              <h3 className="text-sm font-black text-fg">
                {isWithdrawModalOpen === 'bank' ? st.withdraw_bank : st.withdraw_cliq}
              </h3>
            </div>

            <p className="text-[11px] text-fg-muted font-bold bg-amber-50 text-amber-800 p-3 rounded-xl border border-amber-100 leading-normal">
              {st.withdraw_placeholder}
            </p>

            <form onSubmit={handleWithdrawalSubmit} className="space-y-4 text-xs font-bold text-fg">
              <div>
                <label className="block mb-1 text-fg-muted">{st.amount_jod}</label>
                <input
                  type="number"
                  required
                  step="0.01"
                  min="1"
                  max={kpis.availableBalance}
                  value={wAmount}
                  onChange={(e) => setWAmount(e.target.value)}
                  className="w-full p-3 rounded-xl border border-line outline-none focus:border-[#FF6B00]"
                  placeholder={`Max: ${kpis.availableBalance} JOD`}
                />
              </div>

              {isWithdrawModalOpen === 'bank' ? (
                <>
                  <div>
                    <label className="block mb-1 text-fg-muted">{st.bank_name}</label>
                    <input
                      type="text"
                      required
                      value={wBankName}
                      onChange={(e) => setWBankName(e.target.value)}
                      className="w-full p-3 rounded-xl border border-line outline-none focus:border-[#FF6B00]"
                      placeholder={isAr ? 'مثال: البنك العربي' : 'e.g. Arab Bank'}
                    />
                  </div>
                  <div>
                    <label className="block mb-1 text-fg-muted">{st.iban}</label>
                    <input
                      type="text"
                      required
                      value={wIban}
                      onChange={(e) => setWIban(e.target.value)}
                      className="w-full p-3 rounded-xl border border-line outline-none focus:border-[#FF6B00] font-mono"
                      placeholder="JO83 ARAB 1020 ..."
                    />
                  </div>
                  <div>
                    <label className="block mb-1 text-fg-muted">{st.account_holder}</label>
                    <input
                      type="text"
                      required
                      value={wHolderName}
                      onChange={(e) => setWHolderName(e.target.value)}
                      className="w-full p-3 rounded-xl border border-line outline-none focus:border-[#FF6B00]"
                      placeholder={currentUser?.name}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block mb-1 text-fg-muted">{st.cliq_alias}</label>
                    <input
                      type="text"
                      required
                      value={wCliqAlias}
                      onChange={(e) => setWCliqAlias(e.target.value)}
                      className="w-full p-3 rounded-xl border border-line outline-none focus:border-[#FF6B00] font-mono"
                      placeholder={isAr ? 'اسم مستعار كليك أو رقم الموبايل' : 'CliQ Alias or Mobile'}
                    />
                  </div>
                </>
              )}

              <button
                type="submit"
                className="w-full py-3.5 bg-gradient-to-r from-[#FF6B00] to-orange-500 hover:from-orange-600 hover:to-orange-600 text-white font-black rounded-xl cursor-pointer active:scale-95 transition-all shadow-md shadow-orange-500/15 text-center mt-2"
              >
                {st.submit_withdrawal}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* EDIT LISTING MODAL */}
      {isEditModalOpen && editingAuction && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in" id="edit-listing-modal">
          <div className="bg-surface-raised rounded-3xl p-6 max-w-md w-full border border-line shadow-2xl relative space-y-4">
            <button 
              onClick={() => {
                setIsEditModalOpen(false);
                setEditingAuction(null);
              }}
              className="absolute top-4 right-4 rtl:right-auto rtl:left-4 p-2 text-fg-muted hover:text-fg bg-surface-sunken rounded-xl cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="flex items-center gap-2 border-b border-line pb-3">
              <Edit className="w-5 h-5 text-[#FF6B00]" />
              <h3 className="text-sm font-black text-fg">
                {editingAuction.status === 'rejected'
                  ? (isAr ? 'عدّل وأعد الإرسال للمراجعة' : 'Edit & Resubmit for Review')
                  : (isAr ? 'تعديل بيانات المزاد' : 'Edit Auction Details')}
              </h3>
            </div>

            <form onSubmit={handleEditSubmit} className="space-y-4 text-xs font-bold text-fg">
              <div>
                <label className="block mb-1 text-fg-muted">{isAr ? 'عنوان المزاد' : 'Auction Title'}</label>
                <input
                  type="text"
                  required
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full p-3 rounded-xl border border-line outline-none focus:border-[#FF6B00]"
                />
              </div>

              <div>
                <label className="block mb-1 text-fg-muted">{isAr ? 'الوصف' : 'Description'}</label>
                <textarea
                  maxLength={1000}
                  required
                  rows={3}
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  className="w-full p-3 rounded-xl border border-line outline-none focus:border-[#FF6B00] resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block mb-1 text-fg-muted">{isAr ? 'السعر الابتدائي' : 'Starting Price'}</label>
                  <input
                    type="number"
                    required
                    value={editStartingPrice}
                    onChange={(e) => setEditStartingPrice(parseFloat(e.target.value))}
                    className="w-full p-3 rounded-xl border border-line outline-none focus:border-[#FF6B00]"
                  />
                </div>
                <div>
                  <label className="block mb-1 text-fg-muted">{isAr ? 'المدة الزمنية (بالثواني)' : 'Duration (seconds)'}</label>
                  <input
                    type="number"
                    required
                    value={editDuration}
                    onChange={(e) => setEditDuration(parseInt(e.target.value))}
                    className="w-full p-3 rounded-xl border border-line outline-none focus:border-[#FF6B00]"
                  />
                </div>
              </div>

              <div>
                <label className="block mb-1 text-fg-muted">{isAr ? 'الفئة' : 'Category'}</label>
                <input
                  type="text"
                  required
                  value={editCategory}
                  onChange={(e) => setEditCategory(e.target.value)}
                  className="w-full p-3 rounded-xl border border-line outline-none focus:border-[#FF6B00]"
                />
              </div>

              <button
                type="submit"
                className="w-full py-3.5 bg-gradient-to-r from-[#FF6B00] to-orange-500 hover:from-orange-600 hover:to-orange-600 text-white font-black rounded-xl cursor-pointer active:scale-95 transition-all shadow-md shadow-orange-500/15 text-center mt-2"
              >
                {editingAuction.status === 'rejected'
                  ? (isAr ? 'أعد الإرسال للمراجعة' : 'Resubmit for Review')
                  : (isAr ? 'حفظ التعديلات' : 'Save Modifications')}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* VERIFICATION APPLY MODAL */}
      {isVerRequestOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in" id="ver-apply-modal">
          <div className="bg-surface-raised rounded-3xl p-6 max-w-md w-full border border-line shadow-2xl relative space-y-4 text-left rtl:text-right">
            <button 
              onClick={() => setIsVerRequestOpen(false)}
              className="absolute top-4 right-4 rtl:right-auto rtl:left-4 p-2 text-fg-muted hover:text-fg bg-surface-sunken rounded-xl cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="flex items-center gap-2 border-b border-line pb-3">
              <ShieldCheck className="w-5 h-5 text-[#FF6B00]" />
              <h3 className="text-sm font-black text-fg">
                {isAr ? 'توثيق حساب التاجر الرسمي' : 'Apply for Merchant Verification'}
              </h3>
            </div>

            <form onSubmit={async (e) => {
              e.preventDefault();
              // ID documents are OPTIONAL. A seller may apply with no documents
              // and attach them later (or be asked for them by a reviewer) —
              // a missing upload must not block an otherwise valid application.
              // The uploads themselves are unchanged; only the requirement is
              // gone. An admin still approves or rejects every request.
              setIsVerSubmitting(true);
              try {
                const userId = currentUser?.id || 'unknown';
                const timestamp = Date.now();
                
                // Dynamic import of firebase/storage
                const { ref, uploadBytes, getDownloadURL } = await import('firebase/storage');
                const storageInstance = await getFirebaseStorage();
                
                // 1. Upload ID Front file (if provided)
                let idFrontUrl = '';
                if (idFrontFile) {
                  const frontRef = ref(storageInstance, `verification-documents/${userId}/${timestamp}_front_${idFrontFile.name}`);
                  const frontSnap = await uploadBytes(frontRef, idFrontFile);
                  idFrontUrl = await getDownloadURL(frontSnap.ref);
                }

                // 2. Upload ID Back file (if provided)
                let idBackUrl = '';
                if (idBackFile) {
                  const backRef = ref(storageInstance, `verification-documents/${userId}/${timestamp}_back_${idBackFile.name}`);
                  const backSnap = await uploadBytes(backRef, idBackFile);
                  idBackUrl = await getDownloadURL(backSnap.ref);
                }
                
                // 3. Upload Passport file if selected
                let passportUrl = '';
                if (passportFile) {
                  const passRef = ref(storageInstance, `verification-documents/${userId}/${timestamp}_passport_${passportFile.name}`);
                  const passSnap = await uploadBytes(passRef, passportFile);
                  passportUrl = await getDownloadURL(passSnap.ref);
                }
                
                const res = await submitVerificationRequest(
                  requestedStatus, 
                  verNotes, 
                  idFrontUrl, 
                  idBackUrl, 
                  passportUrl
                );
                
                setIsVerSubmitting(false);
                if (res.success) {
                  setIsVerRequestOpen(false);
                  setVerNotes('');
                  setIdFrontFile(null);
                  setIdBackFile(null);
                  setPassportFile(null);
                }
              } catch (err: any) {
                console.error("Error submitting verification documents:", err);
                setIsVerSubmitting(false);
                alert(isAr ? `حدث خطأ أثناء رفع المستندات: ${err.message}` : `An error occurred while uploading documents: ${err.message}`);
              }
            }} className="space-y-4">
              
              <div>
                <label className="block text-fg text-xs font-black uppercase tracking-wider mb-2">
                  {isAr ? 'رتبة التوثيق المطلوبة' : 'Requested Status Rank'}
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button 
                    type="button"
                    onClick={() => setRequestedStatus('verified')}
                    className={`p-3.5 rounded-2xl border text-center flex flex-col items-center justify-center cursor-pointer transition-all ${
                      requestedStatus === 'verified' 
                        ? 'border-[#FF6B00] bg-orange-500/5 text-[#FF6B00]' 
                        : 'border-line bg-surface-raised text-fg-muted hover:bg-surface-sunken'
                    }`}
                  >
                    <ShieldCheck className="w-6 h-6 mb-1" />
                    <span className="text-xs font-black">{isAr ? 'بائع موثق' : 'Verified'}</span>
                    <span className="text-[9px] opacity-75 font-semibold mt-0.5">{isAr ? 'شارات ورتبة قياسية' : 'Standard verified badge'}</span>
                  </button>

                  <button 
                    type="button"
                    onClick={() => setRequestedStatus('premium_verified')}
                    className={`p-3.5 rounded-2xl border text-center flex flex-col items-center justify-center cursor-pointer transition-all ${
                      requestedStatus === 'premium_verified' 
                        ? 'border-[#FF6B00] bg-orange-500/5 text-[#FF6B00]' 
                        : 'border-line bg-surface-raised text-fg-muted hover:bg-surface-sunken'
                    }`}
                  >
                    <Sparkles className="w-6 h-6 mb-1" />
                    <span className="text-xs font-black">{isAr ? 'موثق متميز' : 'Premium'}</span>
                    <span className="text-[9px] opacity-75 font-semibold mt-0.5">{isAr ? 'حساب بائع VIP ذهبي' : 'Exclusive Gold VIP status'}</span>
                  </button>
                </div>
              </div>

              <div className="space-y-3">
                <label className="block text-fg text-xs font-black uppercase tracking-wider">
                  {isAr ? 'مستندات التحقق من الهوية الوطنية' : 'Identity Verification Documents'}
                </label>
                
                {/* ID FRONT */}
                <div className="space-y-1">
                  <span className="block text-[11px] text-fg-muted font-bold">
                    {isAr ? 'صورة الوجه الأمامي للهوية الوطنية (اختياري)' : 'National ID - Front Image (Optional)'}
                  </span>
                  <input 
                    type="file" 
                    accept="image/*" 
                    id="id-front-upload" 
                    className="hidden" 
                    onChange={(e) => {
                      if (e.target.files && e.target.files[0]) {
                        setIdFrontFile(e.target.files[0]);
                      }
                    }} 
                  />
                  <label 
                    htmlFor="id-front-upload"
                    className="flex items-center justify-between p-3 border border-line rounded-xl bg-surface-sunken hover:bg-surface-sunken cursor-pointer transition-all text-xs"
                  >
                    <span className="text-fg-muted font-medium truncate max-w-[200px]">
                      {idFrontFile ? idFrontFile.name : (isAr ? 'اختر صورة الوجه الأمامي...' : 'Select front side image...')}
                    </span>
                    {idFrontFile ? (
                      <span className="text-emerald-500 font-bold flex items-center gap-1">
                        ✅ {isAr ? 'جاهز' : 'Ready'}
                      </span>
                    ) : (
                      <span className="text-[#FF6B00] font-bold">
                        {isAr ? 'رفع ملف' : 'Upload File'}
                      </span>
                    )}
                  </label>
                </div>

                {/* ID BACK */}
                <div className="space-y-1">
                  <span className="block text-[11px] text-fg-muted font-bold">
                    {isAr ? 'صورة الوجه الخلفي للهوية الوطنية (اختياري)' : 'National ID - Back Image (Optional)'}
                  </span>
                  <input 
                    type="file" 
                    accept="image/*" 
                    id="id-back-upload" 
                    className="hidden" 
                    onChange={(e) => {
                      if (e.target.files && e.target.files[0]) {
                        setIdBackFile(e.target.files[0]);
                      }
                    }} 
                  />
                  <label 
                    htmlFor="id-back-upload"
                    className="flex items-center justify-between p-3 border border-line rounded-xl bg-surface-sunken hover:bg-surface-sunken cursor-pointer transition-all text-xs"
                  >
                    <span className="text-fg-muted font-medium truncate max-w-[200px]">
                      {idBackFile ? idBackFile.name : (isAr ? 'اختر صورة الوجه الخلفي...' : 'Select back side image...')}
                    </span>
                    {idBackFile ? (
                      <span className="text-emerald-500 font-bold flex items-center gap-1">
                        ✅ {isAr ? 'جاهز' : 'Ready'}
                      </span>
                    ) : (
                      <span className="text-[#FF6B00] font-bold">
                        {isAr ? 'رفع ملف' : 'Upload File'}
                      </span>
                    )}
                  </label>
                </div>

                {/* PASSPORT (OPTIONAL) */}
                <div className="space-y-1">
                  <span className="block text-[11px] text-fg-muted font-bold">
                    {isAr ? 'صورة جواز السفر (اختياري كبديل)' : 'Passport Image (Optional)'}
                  </span>
                  <input 
                    type="file" 
                    accept="image/*" 
                    id="passport-upload" 
                    className="hidden" 
                    onChange={(e) => {
                      if (e.target.files && e.target.files[0]) {
                        setPassportFile(e.target.files[0]);
                      }
                    }} 
                  />
                  <label 
                    htmlFor="passport-upload"
                    className="flex items-center justify-between p-3 border border-line rounded-xl bg-surface-sunken hover:bg-surface-sunken cursor-pointer transition-all text-xs"
                  >
                    <span className="text-fg-muted font-medium truncate max-w-[200px]">
                      {passportFile ? passportFile.name : (isAr ? 'اختر صورة جواز السفر...' : 'Select passport image...')}
                    </span>
                    {passportFile ? (
                      <span className="text-emerald-500 font-bold flex items-center gap-1">
                        ✅ {isAr ? 'جاهز' : 'Ready'}
                      </span>
                    ) : (
                      <span className="text-fg-muted font-bold">
                        {isAr ? 'رفع ملف' : 'Upload File'}
                      </span>
                    )}
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-fg-muted text-xs font-black mb-1.5">
                  {isAr ? 'ملاحظات إضافية لإدارة المنصة' : 'Additional Remarks'}
                </label>
                <textarea 
                  rows={3}
                  value={verNotes}
                  onChange={(e) => setVerNotes(e.target.value)}
                  placeholder={isAr ? 'يرجى تقديم نبذة قصيرة عن طبيعة أعمالك أو أي روابط لتوثيق جودة معروضاتك...' : 'Brief description of your business activity...'}
                  className="w-full p-3 text-xs border border-line rounded-xl outline-none focus:border-[#FF6B00] font-sans font-medium text-fg"
                />
              </div>

              <button 
                type="submit"
                disabled={isVerSubmitting}
                className="w-full py-3.5 bg-gradient-to-r from-[#FF6B00] to-orange-500 hover:from-orange-600 hover:to-orange-600 text-white font-black rounded-xl cursor-pointer active:scale-95 transition-all shadow-md shadow-orange-500/15 text-center flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 disabled:from-gray-300 disabled:to-gray-400"
              >
                <ShieldCheck className="w-4 h-4" />
                <span>{isVerSubmitting ? (isAr ? 'جاري الرفع والإرسال...' : 'Uploading & Submitting...') : (isAr ? 'إرسال طلب التوثيق الرسمي' : 'Submit Official Request')}</span>
              </button>

            </form>
          </div>
        </div>
      )}

    </div>
  );
};

// Subcomponent helper for writing review response professionally
interface ReviewResponseProps {
  reviewId: string;
  onReply: (text: string) => Promise<void>;
  isAr: boolean;
  st: any;
}

const ReviewResponseForm: React.FC<ReviewResponseProps> = ({ onReply, isAr, st }) => {
  const [replyText, setReplyText] = useState('');
  const [isReplying, setIsReplying] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyText.trim()) return;

    setIsSubmitting(true);
    await onReply(replyText);
    setIsSubmitting(false);
    setReplyText('');
    setIsReplying(false);
  };

  if (!isReplying) {
    return (
      <button
        onClick={() => setIsReplying(true)}
        className="self-start px-3.5 py-1.5 rounded-xl border border-line hover:border-[#FF6B00] text-fg-muted hover:text-[#FF6B00] transition-colors flex items-center gap-1 text-[11px] font-black cursor-pointer"
      >
        <MessageSquare className="w-3.5 h-3.5" />
        <span>{st.respond}</span>
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 mt-2" id={`reply-form-${Math.random()}`}>
      <textarea
        required
        rows={2}
        value={replyText}
        onChange={(e) => setReplyText(e.target.value)}
        placeholder={st.response_placeholder}
        className="w-full p-3 text-xs border border-line rounded-xl outline-none focus:border-[#FF6B00] font-semibold text-fg"
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isSubmitting}
          className="px-4 py-2 bg-[#FF6B00] text-white text-[11px] font-black rounded-xl hover:bg-orange-600 transition-colors flex items-center gap-1 cursor-pointer active:scale-95"
        >
          <Send className="w-3.5 h-3.5" />
          <span>{isSubmitting ? '...' : st.save_response}</span>
        </button>
        <button
          type="button"
          onClick={() => setIsReplying(false)}
          className="px-4 py-2 bg-surface-sunken text-fg-muted text-[11px] font-black rounded-xl hover:bg-surface-sunken transition-colors cursor-pointer active:scale-95"
        >
          {isAr ? 'إلغاء' : 'Cancel'}
        </button>
      </div>
    </form>
  );
};
