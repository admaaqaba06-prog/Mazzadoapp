import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { CLIQ_ALIAS, CLIQ_RECIPIENT_NAME_EN, CLIQ_BANK_NAME_AR, CLIQ_BANK_NAME_EN, CLIQ_IBAN, formatIban } from '../constants/cliq';
import { db, getCallableFunction } from '../services/firebase';
import { resolveAvatarUrl } from '../utils/avatarPlaceholder';
import { arrayUnion, collection, query, orderBy, onSnapshot, addDoc, getDocs, where, limit, serverTimestamp } from 'firebase/firestore';
import { 
  ArrowLeft, 
  Check, 
  Clock, 
  CreditCard, 
  Package, 
  Truck, 
  CheckCircle2, 
  AlertTriangle, 
  FileText, 
  Download, 
  ExternalLink, 
  ShieldCheck, 
  User, 
  Copy, 
  Star, 
  BadgeCheck,
  Eye,
  FileCheck,
  XCircle,
  ShieldAlert,
  MapPin,
  Calendar,
  Building,
  Activity,
  DollarSign,
  RefreshCw,
  UploadCloud,
  Landmark,
  Mail,
  X
} from 'lucide-react';
import { Order, ReturnReason } from '../types';
import CliqPaymentFlow from './order/CliqPaymentFlow';
import CliqSenderReveal from './admin/CliqSenderReveal';
import { translations } from '../utils/translations';
import { JORDAN_GOVERNORATES, isValidCityId } from '../utils/jordanCities';
import { validateDeliveryAddress, sanitizeDeliveryAddress } from '../utils/deliveryAddress';
import { isValidPaymentRef } from '../utils/paymentReference';
import { executeOrderTransition } from '../utils/orderWorkflow';
import { deliveryStepFor } from '../utils/deliveryEvidence';
import { isValidDeliveryCode, normalizeDeliveryCodeInput } from '../utils/deliveryCode';
import { isAdminUser } from '../utils/adminAuth';
import { logAnalyticsEvent } from '../services/analyticsService';
import { CountUp, useToast, winTotalDue } from './feedback';
import { sellerNet } from '../utils/bidMath';
import { displayOrderRef } from '../utils/orderRef';
import ConfirmActionModal from './admin/ConfirmActionModal';
import { buyerReputation } from '../utils/reputation';
import { StarRating } from './ui/StarRating';

interface OrderDetailsViewProps {
  orderId: string;
  onBack: () => void;
}

export const OrderDetailsView: React.FC<OrderDetailsViewProps> = ({ orderId, onBack }) => {
  const { orders, language, currentUser, addNotification, sellerProfiles, myReviews, setReviewPromptOrderId, updateOwnProfile, requestReturn, sellerRespondToReturn, rateBuyer, featureFlags } = useApp();
  const isAr = language === 'ar';
  const t = translations[language as 'en' | 'ar'];

  const order = orders.find(o => o.id === orderId);
  const [isUpdating, setIsUpdating] = useState(false);
  const [forceCloseOpen, setForceCloseOpen] = useState(false);
  const [forceDisputeOpen, setForceDisputeOpen] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [copiedIban, setCopiedIban] = useState(false);
  const [copiedAlias, setCopiedAlias] = useState(false);
  const [copiedAmount, setCopiedAmount] = useState(false);
  /**
   * Which payment rail the buyer picked (BAE embedded-CliQ SCREEN 1).
   *
   * null = the choice has not been made and the selector is showing. The two
   * rails are genuinely different products, not a toggle on one:
   *   'manual'  — the existing flow. The buyer transfers to our public CliQ
   *               alias themselves and uploads a receipt; an admin verifies it.
   *   'gateway' — the embedded CliQ rail. We raise a request at the bank,
   *               the buyer approves it inside their own banking app, and a
   *               webhook confirms it.
   * Deliberately NOT persisted: a buyer who abandons the gateway flow must be
   * able to fall back to the manual one, and a half-finished choice is not a
   * fact about the order.
   */
  const [payRail, setPayRail] = useState<'manual' | 'gateway' | null>(null);

  /**
   * The gateway is OFF until Bank al Etihad is actually connected.
   *
   * With the rail visible but no gateway behind it, createCliqPaymentRequest
   * mints a local id, no bank ever hears about it, and the buyer is told "we
   * sent the request to your bank". They then cannot retry for 90 minutes,
   * because the duplicate guard is doing its job, while their payment deadline
   * runs down. So the flag gates the CHOICE, not just the panel.
   *
   * Fail-closed by construction (`=== true` in AppContext), and enforced again
   * in the callable — a flag that only hides a button is not a kill switch for
   * a payment rail.
   *
   * When it is off there is no choice to make, so the manual panel renders
   * directly and the buyer sees exactly what they see today.
   */
  const cliqGatewayEnabled = featureFlags?.enableCliqGateway === true;
  const activeRail = cliqGatewayEnabled ? payRail : 'manual';
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string>('');
  const [activities, setActivities] = useState<any[]>([]);
  const [loadingActivities, setLoadingActivities] = useState(true);
  const { showToast } = useToast();

  // Progressive email capture (Auth/KYC Wave 3): shown only while the account
  // has no email — the rules allow a one-time empty→set claim by the owner.
  const [receiptEmail, setReceiptEmail] = useState('');
  const [receiptEmailSaving, setReceiptEmailSaving] = useState(false);
  const [receiptEmailError, setReceiptEmailError] = useState(false);
  const [receiptEmailDismissed, setReceiptEmailDismissed] = useState(false);

  // Admin one-tap buyer rating (mazad_rates_buyer): existing stars for this order, if any.
  const [adminBuyerStars, setAdminBuyerStars] = useState<number | null>(null);
  const [adminRatingSaving, setAdminRatingSaving] = useState(false);

  // E7 — seller rates the buyer (seller_rates_buyer): existing stars for this
  // order (if already rated) + inline star-picker + comment state.
  const [sellerBuyerStars, setSellerBuyerStars] = useState<number | null>(null);
  const [sellerRatePick, setSellerRatePick] = useState(0);
  const [sellerRateComment, setSellerRateComment] = useState('');
  const [sellerRatingSaving, setSellerRatingSaving] = useState(false);

  // W4 — per-order delivery address + phone the buyer provides at the pay step.
  // Prefill governorate from the profile city and phone from the profile phone;
  // the address is per-order, so it stays editable and is NOT read back from a
  // stored profile address.
  const [deliveryGovernorate, setDeliveryGovernorate] = useState<string>(() =>
    (order?.deliveryAddress?.governorate && isValidCityId(order.deliveryAddress.governorate))
      ? order.deliveryAddress.governorate
      : (currentUser?.city && isValidCityId(currentUser.city) ? currentUser.city : '')
  );
  const [deliveryArea, setDeliveryArea] = useState<string>(order?.deliveryAddress?.area ?? '');
  const [deliveryBuilding, setDeliveryBuilding] = useState<string>(order?.deliveryAddress?.building ?? '');
  const [deliveryNotes, setDeliveryNotes] = useState<string>(order?.deliveryAddress?.notes ?? '');
  const [deliveryPhone, setDeliveryPhone] = useState<string>(
    order?.deliveryPhone ?? currentUser?.phoneNumber ?? currentUser?.phone ?? ''
  );
  const [deliveryErrors, setDeliveryErrors] = useState<{ governorate?: boolean; area?: boolean; phone?: boolean }>({});

  // E1 — the phone number the CliQ transfer is coming FROM (may differ from the
  // buyer's account number, e.g. a family member sends it). Required at the pay
  // step; persisted as cliqSenderPhone so admin can match the incoming transfer.
  const [cliqSenderPhone, setCliqSenderPhone] = useState<string>(order?.cliqSenderPhone ?? '');
  const [cliqSenderPhoneError, setCliqSenderPhoneError] = useState(false);

  // Wave 1 — the CliQ transaction / reference number from the buyer's transfer
  // confirmation. Reserved uniquely server-side (submitOrderPayment) to block
  // reused/duplicate references. Required at the pay step.
  const [txnRef, setTxnRef] = useState<string>('');
  const [txnRefError, setTxnRefError] = useState<string>('');

  // E6 — buyer "report a problem" / return claim form state.
  const [showReturnForm, setShowReturnForm] = useState(false);
  const [returnReason, setReturnReason] = useState<ReturnReason>('not_as_described');
  const [returnDescription, setReturnDescription] = useState('');
  const [returnPhotos, setReturnPhotos] = useState<File[]>([]);
  const [submittingReturn, setSubmittingReturn] = useState(false);
  // E6 B1 — seller accept/contest of a buyer return claim
  const [showSellerContest, setShowSellerContest] = useState(false);
  const [sellerContestNote, setSellerContestNote] = useState('');
  const [respondingReturn, setRespondingReturn] = useState(false);

  // Wave 3 — evidence-gated delivery. Three photos, one per step, plus the
  // delivery code the seller writes on the parcel and the buyer types back.
  const [prepPhotoFile, setPrepPhotoFile] = useState<File | null>(null);
  const [sentPhotoFile, setSentPhotoFile] = useState<File | null>(null);
  const [receivedPhotoFile, setReceivedPhotoFile] = useState<File | null>(null);
  const [deliveryMethod, setDeliveryMethod] = useState<'hand' | 'courier'>('courier');
  const [deliveryCode, setDeliveryCode] = useState<string>('');
  const [deliveryCodeLoading, setDeliveryCodeLoading] = useState(false);
  const [typedDeliveryCode, setTypedDeliveryCode] = useState<string>('');
  const [deliveryCodeError, setDeliveryCodeError] = useState<string>('');
  const [uploadingEvidence, setUploadingEvidence] = useState(false);

  // D5 — counterparty contact. Revealed on demand, never rendered from the
  // order doc: the buyer cannot read the seller's user doc (firestore.rules
  // limits `users` to owner/admin), so this only ever arrives from the
  // revealCounterpartyContact callable, which gates on payment being verified.
  const [contact, setContact] = useState<{ role: string; name: string; phone: string; waMe: string | null } | null>(null);
  const [contactLoading, setContactLoading] = useState(false);
  const [contactError, setContactError] = useState('');

  const isAdminViewer = isAdminUser(currentUser);

  useEffect(() => {
    if (!order || !isAdminViewer) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(query(
          collection(db, 'reviews'),
          where('orderId', '==', order.id),
          where('direction', '==', 'mazad_rates_buyer'),
          limit(1)
        ));
        if (!cancelled && !snap.empty) {
          setAdminBuyerStars((snap.docs[0].data() as any).stars ?? null);
        }
      } catch (err) {
        console.warn('Admin buyer-rating lookup failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [order?.id, isAdminViewer]);

  const handleAdminRateBuyer = async (starsValue: number) => {
    if (!order || adminRatingSaving || adminBuyerStars !== null) return;
    setAdminRatingSaving(true);
    try {
      await addDoc(collection(db, 'reviews'), {
        orderId: order.id,
        auctionId: order.auctionId,
        buyerId: order.buyerId,
        ratedBy: currentUser.id,
        stars: starsValue,
        text: '',
        direction: 'mazad_rates_buyer',
        createdAt: serverTimestamp()
      });
      setAdminBuyerStars(starsValue);
      showToast({
        type: 'success',
        title: isAr ? `تم تقييم المشتري ${starsValue}/5 ⭐` : `Buyer rated ${starsValue}/5 ⭐`,
      });
    } catch (err: any) {
      console.error('Admin buyer rating failed:', err);
      showToast({
        type: 'warn',
        title: isAr ? 'تعذر حفظ تقييم المشتري' : 'Could not save buyer rating',
      });
    } finally {
      setAdminRatingSaving(false);
    }
  };

  // E7 B2 — buyer reputation shown to the seller/admin on the order view. Loaded
  // on-demand: all seller_rates_buyer reviews for this buyer (aggregate rating,
  // NOT tied to this one order). Intentionally NOT rendered in any live-auction /
  // bidding surface — a buyer's rating must never leak during active bidding.
  const [buyerRepReviews, setBuyerRepReviews] = useState<any[] | null>(null);

  // E7 — look up an existing seller_rates_buyer review for this order (seller view
  // only), so a repeat visit renders the read-only "you rated" state.
  const isSellerViewer = !!order && currentUser?.id === order.sellerId;
  useEffect(() => {
    if (!order || !isSellerViewer) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(query(
          collection(db, 'reviews'),
          where('orderId', '==', order.id),
          where('direction', '==', 'seller_rates_buyer'),
          limit(1)
        ));
        if (!cancelled && !snap.empty) {
          setSellerBuyerStars((snap.docs[0].data() as any).stars ?? null);
        }
      } catch (err) {
        console.warn('Seller buyer-rating lookup failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [order?.id, isSellerViewer]);

  // Wave 3 — the seller's delivery code. It lives in deliveryCodes/{orderId},
  // which firestore.rules exposes to the seller and admins only; the buyer must
  // learn it from the parcel. Issued lazily and idempotently, so a seller whose
  // order reached `preparing_shipment` through the admin relay (which issues
  // nothing) still gets one when they open the order.
  useEffect(() => {
    if (!order || !isSellerViewer) return;
    if (order.status !== 'preparing_shipment') return;
    if (deliveryCode) return;
    let cancelled = false;
    (async () => {
      setDeliveryCodeLoading(true);
      try {
        const issue = await getCallableFunction<
          { orderId: string },
          { success: boolean; code: string; created: boolean }
        >('issueDeliveryCode');
        const res = await issue({ orderId: order.id });
        if (!cancelled && res.data?.code) setDeliveryCode(res.data.code);
      } catch (err) {
        console.warn('Delivery code issue/lookup failed:', err);
      } finally {
        if (!cancelled) setDeliveryCodeLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [order?.id, order?.status, isSellerViewer, deliveryCode]);

  // E7 B2 — load the buyer's received seller ratings (aggregate) for the
  // seller/admin viewing this order. On-demand query, same pattern as the
  // per-order lookup above.
  useEffect(() => {
    if (!order || !(isSellerViewer || isAdminViewer)) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(query(
          collection(db, 'reviews'),
          where('buyerId', '==', order.buyerId),
          where('direction', '==', 'seller_rates_buyer')
        ));
        if (!cancelled) {
          const rows: any[] = [];
          snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
          setBuyerRepReviews(rows);
        }
      } catch (err) {
        console.warn('Buyer reputation lookup failed:', err);
        if (!cancelled) setBuyerRepReviews([]);
      }
    })();
    return () => { cancelled = true; };
  }, [order?.id, order?.buyerId, isSellerViewer, isAdminViewer]);

  const handleSellerRateBuyer = async () => {
    if (!order || sellerRatingSaving || sellerBuyerStars !== null || sellerRatePick < 1) return;
    setSellerRatingSaving(true);
    const chosen = sellerRatePick;
    const result = await rateBuyer(order.id, { stars: chosen, comment: sellerRateComment.trim() || undefined });
    if (result.success) {
      setSellerBuyerStars(chosen);
    }
    setSellerRatingSaving(false);
  };

  // Subscribe to real-time order activity history from Firestore
  useEffect(() => {
    if (!order) return;
    const q = query(
      collection(db, 'orders', order.id, 'activity'),
      orderBy('timestamp', 'asc')
    );
    const unsub = onSnapshot(q, (snap) => {
      const list: any[] = [];
      snap.forEach((docSnap) => {
        list.push({ id: docSnap.id, ...docSnap.data() });
      });
      setActivities(list);
      setLoadingActivities(false);
    }, (err) => {
      console.error("Error loading activities:", err);
      setLoadingActivities(false);
    });
    return () => unsub();
  }, [order?.id]);

  if (!order) {
    return (
      <div className="bg-surface-raised border border-line rounded-3xl p-8 text-center space-y-4 max-w-lg mx-auto mt-10">
        <div className="w-16 h-16 rounded-full bg-red-50 flex items-center justify-center text-red-500 mx-auto">
          <AlertTriangle className="w-8 h-8" />
        </div>
        <h3 className="text-lg font-black text-fg uppercase font-mono">
          {isAr ? 'الطلب غير موجود' : 'Order Not Found'}
        </h3>
        <p className="text-xs text-fg-muted">
          {isAr ? 'لم نتمكن من العثور على تفاصيل هذا الطلب في قاعدة البيانات.' : 'The requested order ledger could not be retrieved.'}
        </p>
        <button 
          onClick={onBack}
          className="px-6 py-2.5 bg-[#FF6B00] text-white rounded-2xl text-xs font-black hover:bg-orange-600 transition-all uppercase flex items-center justify-center gap-1.5 mx-auto"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>{isAr ? 'العودة للخلف' : 'Go Back'}</span>
        </button>
      </div>
    );
  }

  // Identify roles
  const isBuyer = currentUser.id === order.buyerId;
  const isSeller = currentUser.id === order.sellerId;
  const isAdmin = isAdminUser(currentUser);

  // Post-win review: buyer can rate a delivered/completed order they haven't reviewed yet.
  const hasBuyerReview = (myReviews || []).some(
    r => r.direction === 'buyer_rates_auction' && r.orderId === order.id
  );
  const canRateOrder = isBuyer && (order.status === 'completed' || order.status === 'delivered') && !hasBuyerReview;

  // Status index mapping
  const timelineSteps = [
    { id: 'waiting_payment', labelAr: 'بانتظار الدفع', labelEn: 'Waiting Payment', descAr: 'المشتري يحوّل عبر كليك ويرفع الإيصال', descEn: 'Buyer pays via CliQ and uploads the receipt' },
    { id: 'paid', labelAr: 'تم الدفع', labelEn: 'Paid', descAr: 'استلمنا إثبات الدفع وتم تأكيده', descEn: 'Payment proof received and confirmed' },
    { id: 'preparing_shipment', labelAr: 'تجهيز الشحن', labelEn: 'Preparing Shipment', descAr: 'البائع يجهز المنتج والملصقات', descEn: 'Seller is preparing items and labels' },
    // Wave 3's `out_for_delivery` and the legacy relay's `shipped` are the SAME
    // stage to a buyer ("it's on its way"), so they share one timeline step via
    // altIds. Without that, findIndex returns -1 for every evidence-flow order
    // and the progress bar goes blank during the stage the buyer cares about
    // most — the one where they are being asked to do something.
    { id: 'shipped', altIds: ['out_for_delivery'], labelAr: 'خرج للتوصيل', labelEn: 'Out for delivery', descAr: 'الشحنة في الطريق إليك الآن', descEn: 'Parcel on its way to you' },
    { id: 'delivered', labelAr: 'تم التوصيل', labelEn: 'Delivered', descAr: 'تم توصيل الشحنة للمشتري', descEn: 'Delivered to buyer destination' },
    { id: 'completed', labelAr: 'مكتمل', labelEn: 'Completed', descAr: 'تم تحرير الأموال والطلب مغلق', descEn: 'Funds released to seller & order closed' }
  ];

  const currentStepIndex = timelineSteps.findIndex(
    s => s.id === order.status || (s as { altIds?: string[] }).altIds?.includes(order.status)
  );

  // W2/W4 — honest shipment status (no fabricated tracking/ETA) + address gate.
  const shipmentStatusLabel =
    // `out_for_delivery` MUST be listed here. This chain ends in an
    // "Awaiting payment" fallback, so an unhandled status tells a buyer whose
    // parcel is already en route that they never paid.
    order.status === 'out_for_delivery' ? (isAr ? 'الشحنة في الطريق إليك' : 'On the way to you')
    : order.status === 'shipped' ? (isAr ? 'الشحنة في الطريق إليك' : 'On the way to you')
    : order.status === 'delivered' ? (isAr ? 'تم التوصيل' : 'Delivered')
    : order.status === 'completed' ? (isAr ? 'مكتمل — تم إغلاق الطلب' : 'Completed — order closed')
    : order.status === 'preparing_shipment' ? (isAr ? 'البائع يجهّز طلبك' : 'Seller is preparing your order')
    : order.status === 'paid' ? (isAr ? 'تم الدفع — بانتظار تجهيز البائع' : 'Paid — waiting for the seller to prepare')
    : (isAr ? 'بانتظار الدفع' : 'Awaiting payment');

  // The buyer always sees the address they entered; the seller/admin see it
  // ONLY after payment is confirmed (never leak a buyer address on an unpaid order).
  const canSeeDeliveryAddress = !!order.deliveryAddress && (isBuyer || order.paymentStatus === 'paid');
  const deliveryGov = order.deliveryAddress
    ? JORDAN_GOVERNORATES.find(g => g.id === order.deliveryAddress!.governorate)
    : undefined;

  // Helper to format date
  const formatDate = (rawDate: any) => {
    if (!rawDate) return '';
    const dateObj = rawDate.seconds ? new Date(rawDate.seconds * 1000) : new Date(rawDate);
    return dateObj.toLocaleDateString(isAr ? 'ar-JO' : 'en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(displayOrderRef(order));
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  };

  const totalDue = order.totalDue ?? winTotalDue(order.winningBidAmount);

  const handleCopyIban = () => {
    if (!CLIQ_IBAN) return; // nothing to copy while the IBAN is suppressed
    navigator.clipboard.writeText(CLIQ_IBAN);
    setCopiedIban(true);
    setTimeout(() => setCopiedIban(false), 2000);
  };

  const handleCopyAlias = () => {
    navigator.clipboard.writeText(CLIQ_ALIAS);
    setCopiedAlias(true);
    setTimeout(() => setCopiedAlias(false), 2000);
  };

  // Copy the exact amount to the fil (3 dp) so the buyer transfers a value that
  // matches the order to the fil — mismatches stall reconciliation.
  const handleCopyAmount = () => {
    navigator.clipboard.writeText(totalDue.toFixed(3));
    setCopiedAmount(true);
    setTimeout(() => setCopiedAmount(false), 2000);
  };

  // Save the optional receipt email (write-once claim; rules allow empty→set only).
  const handleSaveReceiptEmail = async () => {
    if (receiptEmailSaving) return;
    const value = receiptEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      setReceiptEmailError(true);
      return;
    }
    setReceiptEmailError(false);
    setReceiptEmailSaving(true);
    try {
      const result = await updateOwnProfile({ email: value });
      // Only celebrate + dismiss when the email actually persisted — success
      // alone can be true while the email write was denied/offline.
      if (result.success && result.emailSaved) {
        setReceiptEmailDismissed(true);
        showToast({ type: 'success', title: t.receiptEmailSavedTitle });
      } else {
        showToast({ type: 'warn', title: t.receiptEmailFailedTitle });
      }
    } catch (err) {
      console.error('Receipt email save failed:', err);
      showToast({ type: 'warn', title: t.receiptEmailFailedTitle });
    } finally {
      setReceiptEmailSaving(false);
    }
  };

  const handleReceiptFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.match('image.*')) {
      alert(isAr ? 'الرجاء اختيار صورة فقط (jpg أو png).' : 'Please select an image file only (jpg, png).');
      return;
    }
    setReceiptFile(file);
    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target?.result) setReceiptPreview(event.target.result as string);
    };
    reader.readAsDataURL(file);
  };

  // Buyer CliQ payment: upload the transfer receipt screenshot, attach it to the
  // order, then run the existing 'pay' workflow transition (admin confirms later).
  const handleSubmitCliqPayment = async () => {
    // W4 — require a valid delivery address + phone before payment can proceed
    // (the seller needs a real destination to ship to). Validated with the same
    // canonical governorate list + JO phone normalizer as the rest of the app.
    const addressInput = {
      governorate: deliveryGovernorate,
      area: deliveryArea,
      building: deliveryBuilding,
      notes: deliveryNotes,
    };
    const addressCheck = validateDeliveryAddress(addressInput, deliveryPhone);
    if (!addressCheck.valid) {
      setDeliveryErrors(addressCheck.errors);
      showToast({
        type: 'warn',
        title: isAr ? 'أكمل عنوان التوصيل ورقم الهاتف' : 'Complete the delivery address & phone',
      });
      return;
    }
    setDeliveryErrors({});

    if (!receiptFile) {
      alert(isAr ? 'الرجاء إرفاق لقطة شاشة لإيصال حوالة كليك أولاً.' : 'Please attach your CliQ transfer receipt screenshot first.');
      return;
    }
    // E1 — the CliQ sender phone is required so admin can match the transfer.
    if (!cliqSenderPhone.trim()) {
      setCliqSenderPhoneError(true);
      alert(isAr ? 'الرجاء إدخال رقم الهاتف الذي يُرسل منه الدفع عبر كليك.' : 'Please enter the phone number the CliQ payment is coming from.');
      return;
    }
    setCliqSenderPhoneError(false);
    // Wave 1 — require a plausible CliQ transaction/reference before uploading.
    // The final uniqueness reservation happens server-side in submitOrderPayment.
    if (!isValidPaymentRef(txnRef)) {
      setTxnRefError(isAr
        ? 'أدخل رقم العملية الظاهر في إشعار الدفع'
        : 'Enter the transaction reference from your payment confirmation');
      return;
    }
    setTxnRefError('');
    setIsUpdating(true);
    try {
      const { ref: storageRef, uploadBytes, getDownloadURL } = await import('firebase/storage');
      const { getFirebaseStorage } = await import('../services/firebase');
      const storageInstance = await getFirebaseStorage();

      const storagePath = `payment-proofs/${currentUser.id}/${Date.now()}_order_${order.id}.png`;
      const fileRef = storageRef(storageInstance, storagePath);
      await uploadBytes(fileRef, receiptFile);
      const proofUrl = await getDownloadURL(fileRef);

      // Wave 1 — route the payment through the submitOrderPayment callable, which
      // reserves a unique payment reference and writes the order (status→paid /
      // paymentStatus→paid) atomically server-side, replacing the old direct
      // updateDoc + 'pay' transition pair.
      const submitPayment = await getCallableFunction<
        {
          orderId: string;
          proofUrl: string;
          cliqSenderPhone: string;
          txnRef: string;
          deliveryAddress: ReturnType<typeof sanitizeDeliveryAddress>;
          deliveryPhone: string;
        },
        unknown
      >('submitOrderPayment');
      await submitPayment({
        orderId: order.id,
        proofUrl,
        cliqSenderPhone: cliqSenderPhone.trim(),
        txnRef,
        deliveryAddress: sanitizeDeliveryAddress(addressInput),
        deliveryPhone: addressCheck.normalizedPhone,
      });

      // Funnel metric — fire-and-forget (service handles its own errors).
      // Wave 3 metric hygiene: paying a SIMULATED order (admin test run)
      // must not count as a real funnel conversion.
      if (order.isSimulated !== true) {
        logAnalyticsEvent('payment_submitted', currentUser.id, currentUser.email, {
          orderId: order.id,
          totalDue
        });
      }

      showToast({
        type: 'success',
        title: isAr ? 'استلمنا إثبات الدفع — بانتظار التأكيد' : 'Payment proof received — pending confirmation',
      });
      setReceiptFile(null);
      setReceiptPreview('');
    } catch (err: any) {
      console.error(err);
      // Match the app's callable error-mapping style (err.code === 'functions/...').
      if (err?.code === 'functions/already-exists') {
        setTxnRefError(isAr
          ? 'رقم العملية هذا مُستخدم من قبل. تأكد من إدخال رقم التحويل الصحيح من كليك.'
          : 'This transaction reference has already been used. Enter the reference from your actual CliQ transfer.');
      } else if (err?.code === 'functions/resource-exhausted') {
        setTxnRefError(isAr
          ? 'لقد تجاوزت الحد الأقصى لمحاولات الدفع لهذا الطلب. تواصل مع الدعم.'
          : "You've reached the maximum payment attempts for this order — please contact support.");
      } else if (err?.code === 'functions/invalid-argument') {
        setTxnRefError(isAr
          ? 'تحقق من التفاصيل وحاول مجددًا.'
          : 'Please check your details and try again.');
      } else {
        alert(isAr ? `تعذر إرسال إثبات الدفع: ${err.message}` : `Failed to submit payment proof: ${err.message}`);
      }
    } finally {
      setIsUpdating(false);
    }
  };

  const handleCancelOrder = async () => {
    if (confirm(isAr ? 'هل أنت متأكد من إلغاء هذا الطلب؟ لا يمكن التراجع عن هذا الإجراء.' : 'Are you sure you want to cancel this order? This action is irreversible.')) {
      setIsUpdating(true);
      try {
        await executeOrderTransition(order, 'cancel_before_payment', currentUser);
        addNotification(
          isAr ? 'تم إلغاء الطلب' : 'Order Cancelled',
          isAr ? 'تم إلغاء الطلب بنجاح — لا يوجد أي مبلغ مستحق عليك.' : 'Order cancelled successfully — nothing is due from you.',
          'info'
        );
      } catch (err: any) {
        console.error(err);
        alert(isAr ? `فشل إلغاء الطلب: ${err.message}` : `Cancel failed: ${err.message}`);
      } finally {
        setIsUpdating(false);
      }
    }
  };

  // Wave 3 — one upload path for all three evidence photos.
  // storage.rules gates `delivery-evidence/{orderId}/**` on any signed-in user,
  // image-only, ≤10MB; WHICH party may attach WHICH photo is enforced by
  // firestore.rules on the order write and by the confirm callable, not here.
  const uploadDeliveryPhoto = async (file: File, kind: 'prep' | 'sent' | 'received'): Promise<string> => {
    const { ref: storageRef, uploadBytes, getDownloadURL } = await import('firebase/storage');
    const { getFirebaseStorage } = await import('../services/firebase');
    const storageInstance = await getFirebaseStorage();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileRef = storageRef(storageInstance, `delivery-evidence/${order.id}/${kind}-${Date.now()}-${safeName}`);
    await uploadBytes(fileRef, file);
    return await getDownloadURL(fileRef);
  };

  // Wave 3 step 1 — the seller photographs the item being prepared. Replaces the
  // bare "Begin Preparing Shipment" click: the photo IS the transition.
  const handleUploadPrepPhoto = async () => {
    if (!prepPhotoFile) {
      alert(isAr ? 'أرفق صورة للمنتج أثناء التجهيز.' : 'Attach a photo of the item being prepared.');
      return;
    }
    setUploadingEvidence(true);
    try {
      const url = await uploadDeliveryPhoto(prepPhotoFile, 'prep');
      await executeOrderTransition(order, 'upload_prep_photo', currentUser, { prepPhotoUrl: url });
      setPrepPhotoFile(null);
      showToast({
        type: 'success',
        title: isAr ? 'تم تسجيل بدء التجهيز' : 'Preparation recorded',
      });
    } catch (err: any) {
      console.error(err);
      alert(isAr ? `تعذر رفع الصورة: ${err.message}` : `Could not upload the photo: ${err.message}`);
    } finally {
      setUploadingEvidence(false);
    }
  };

  // Wave 3 step 2 — the seller photographs it leaving WITH the delivery code
  // visible. The buyer's photo must show the same code; that match is the proof.
  const handleMarkOutForDelivery = async () => {
    if (!sentPhotoFile) {
      alert(isAr ? 'أرفق صورة للمنتج عند الإرسال مع ظهور رمز التسليم.' : 'Attach a photo of the item sent, with the delivery code visible.');
      return;
    }
    setUploadingEvidence(true);
    try {
      const url = await uploadDeliveryPhoto(sentPhotoFile, 'sent');
      await executeOrderTransition(order, 'mark_out_for_delivery', currentUser, {
        sentPhotoUrl: url,
        deliveryMethod,
      });
      setSentPhotoFile(null);
      showToast({
        type: 'success',
        title: isAr ? 'تم تسجيل خروج الطلب للتوصيل' : 'Marked out for delivery',
      });
    } catch (err: any) {
      console.error(err);
      alert(isAr ? `تعذر تحديث الحالة: ${err.message}` : `Could not update the order: ${err.message}`);
    } finally {
      setUploadingEvidence(false);
    }
  };

  // Wave 3 removed handlePrepareShipment and handleMarkAsShipped from this view.
  // The seller's path to those two stages is now the evidence-gated pair above
  // (handleUploadPrepPhoto / handleMarkOutForDelivery), and the photo-free
  // `prepare_shipment` / `mark_shipped` actions survive only for the ADMIN
  // relay, which drives them from the Action Center's StalledDeliveryCard
  // via nextAdvance(). Leaving the handlers here would have been dead code that
  // reads like the seller flow.

  // Wave 3 step 3 — the buyer's receipt photo (delivery code visible) plus the
  // typed code. This is the completion event: the callable verifies the code
  // inside the money transaction and releases escrow in the same commit. There
  // is no timer and no auto-complete behind it.
  const handleConfirmReceipt = async () => {
    const normalized = normalizeDeliveryCodeInput(typedDeliveryCode);
    if (!isValidDeliveryCode(normalized)) {
      setDeliveryCodeError(isAr
        ? 'أدخل رمز التسليم المكتوب على الطرد (مثال: DC-7K3QP).'
        : 'Enter the delivery code written on the parcel (e.g. DC-7K3QP).');
      return;
    }
    setDeliveryCodeError('');
    if (!receivedPhotoFile) {
      alert(isAr ? 'أرفق صورة للمنتج عند الاستلام مع ظهور رمز التسليم.' : 'Attach a photo of the item received, with the delivery code visible.');
      return;
    }
    if (!confirm(isAr
      ? 'بتأكيد الاستلام يتم تحرير المبلغ للبائع نهائياً. هل استلمت المنتج وعاينته؟'
      : 'Confirming receipt releases the payment to the seller for good. Have you received and inspected the item?')) {
      return;
    }
    setUploadingEvidence(true);
    try {
      const url = await uploadDeliveryPhoto(receivedPhotoFile, 'received');
      const result = await executeOrderTransition(order, 'confirm_receipt', currentUser, {
        receivedPhotoUrl: url,
        deliveryCode: normalized,
      });
      setReceivedPhotoFile(null);
      setTypedDeliveryCode('');
      if (result && result.alreadyReleased) {
        alert(isAr ? 'تم تحرير هذا المبلغ سابقاً' : 'This amount was already released.');
      } else {
        alert(isAr ? 'تم تأكيد الاستلام وتحويل المبلغ للبائع.' : 'Receipt confirmed — funds transferred to the seller.');
      }
      addNotification(
        isAr ? 'تم تأكيد الاستلام' : 'Receipt Confirmed',
        isAr ? 'تم تحويل المبلغ للبائع بنجاح' : 'Funds successfully transferred to the seller.',
        'info'
      );
    } catch (err: any) {
      console.error(err);
      // A wrong code comes back as invalid-argument, with the remaining-attempt
      // count in `details` (the message itself is Arabic-only, so it must not be
      // echoed into the English UI). Shown INLINE on the field rather than in an
      // alert, so the buyer can fix the code without losing the attached photo.
      if (err?.code === 'functions/invalid-argument') {
        const remaining = err?.details?.remaining;
        const hasCount = typeof remaining === 'number';
        setDeliveryCodeError(isAr
          ? (hasCount
              ? `رمز التسليم غير مطابق. المحاولات المتبقية: ${remaining}`
              : 'رمز التسليم غير مطابق. تحقق من الرمز المكتوب على الطرد.')
          : (hasCount
              ? `That delivery code doesn't match. Attempts remaining: ${remaining}`
              : "That delivery code doesn't match — check the code written on the parcel."));
      } else if (err?.code === 'functions/resource-exhausted') {
        setDeliveryCodeError(isAr
          ? 'تجاوزت عدد المحاولات المسموح بها. تواصل مع الدعم.'
          : "You've used all delivery-code attempts — please contact support.");
      } else {
        alert(isAr ? `تعذر تأكيد الاستلام: ${err.message}` : `Could not confirm receipt: ${err.message}`);
      }
    } finally {
      setUploadingEvidence(false);
    }
  };

  const handleRevealContact = async () => {
    setContactLoading(true);
    setContactError('');
    try {
      const reveal = await getCallableFunction<
        { orderId: string },
        { success: boolean; role: string; name: string; phone: string; waMe: string | null }
      >('revealCounterpartyContact');
      const res = await reveal({ orderId: order.id });
      setContact({ role: res.data.role, name: res.data.name, phone: res.data.phone, waMe: res.data.waMe });
    } catch (err: any) {
      console.error('Contact reveal failed:', err);
      setContactError(
        err?.code === 'functions/failed-precondition'
          ? (isAr ? 'تُعرض بيانات التواصل بعد تأكيد الدفع.' : 'Contact details are shared once the payment is verified.')
          : (isAr ? 'تعذر عرض بيانات التواصل.' : 'Could not load contact details.'),
      );
    } finally {
      setContactLoading(false);
    }
  };

  const handleConfirmDelivery = async () => {
    if (confirm(isAr ? 'هل تؤكد استلام الشحنة ومعاينتها بنجاح؟' : 'Do you confirm you have received and inspected the parcel?')) {
      setIsUpdating(true);
      try {
        const result = await executeOrderTransition(order, 'confirm_delivery', currentUser);
        if (result && result.alreadyReleased) {
          alert(isAr ? 'تم تحرير هذا المبلغ سابقاً' : 'This amount was already released.');
        } else {
          alert(isAr ? 'تم تحويل المبلغ للبائع بنجاح' : 'Funds successfully transferred to the seller.');
        }
        addNotification(
          isAr ? 'تم تأكيد الاستلام' : 'Delivery Confirmed',
          isAr ? 'تم تحويل المبلغ للبائع بنجاح' : 'Funds successfully transferred to the seller.',
          'info'
        );
      } catch (err: any) {
        console.error(err);
        alert(isAr ? `تعذر تحرير المبلغ، حاول مرة أخرى: ${err.message}` : `Failed to release funds, please try again: ${err.message}`);
      } finally {
        setIsUpdating(false);
      }
    }
  };

  // E6 — buyer photo picker for the return claim (1–6 images, ≤10MB each).
  const handleReturnPhotosPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files: File[] = e.target.files ? Array.from(e.target.files) : [];
    if (files.length === 0) return;
    const images = files.filter(f => f.type.startsWith('image/') && f.size <= 10 * 1024 * 1024);
    setReturnPhotos(prev => [...prev, ...images].slice(0, 6));
    // Reset the input so the same file can be re-picked after removal.
    e.target.value = '';
  };

  const handleRemoveReturnPhoto = (index: number) => {
    setReturnPhotos(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmitReturn = async () => {
    if (returnPhotos.length < 1 || returnPhotos.length > 6) {
      alert(isAr ? 'أرفق من صورة واحدة إلى ست صور.' : 'Please attach between 1 and 6 photos.');
      return;
    }
    if (!returnDescription.trim()) {
      alert(isAr ? 'يرجى وصف المشكلة.' : 'Please describe the problem.');
      return;
    }
    setSubmittingReturn(true);
    try {
      const { ref: storageRef, uploadBytes, getDownloadURL } = await import('firebase/storage');
      const { getFirebaseStorage } = await import('../services/firebase');
      const storageInstance = await getFirebaseStorage();

      const photoUrls: string[] = [];
      for (let i = 0; i < returnPhotos.length; i++) {
        const file = returnPhotos[i];
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const storagePath = `returns/${order.id}/${i}-${safeName}`;
        const fileRef = storageRef(storageInstance, storagePath);
        await uploadBytes(fileRef, file);
        photoUrls.push(await getDownloadURL(fileRef));
      }

      const result = await requestReturn(order.id, {
        reason: returnReason,
        description: returnDescription.trim(),
        photoUrls,
      });

      if (result.success) {
        setShowReturnForm(false);
        setReturnDescription('');
        setReturnPhotos([]);
        setReturnReason('not_as_described');
      } else {
        alert(result.message || (isAr ? 'تعذر تقديم طلب الإرجاع.' : 'Failed to submit return.'));
      }
    } catch (err: any) {
      console.error(err);
      alert(isAr ? `تعذر تقديم طلب الإرجاع: ${err.message}` : `Failed to submit return: ${err.message}`);
    } finally {
      setSubmittingReturn(false);
    }
  };

  // E6 B1 — seller accepts (accept=true) or contests (accept=false + note) the
  // buyer's return claim. Advisory only; the admin still executes any refund.
  const handleRespondToReturn = async (accept: boolean) => {
    if (!accept && !sellerContestNote.trim()) {
      alert(isAr ? 'يرجى كتابة سبب الاعتراض.' : 'Please add a note explaining your objection.');
      return;
    }
    setRespondingReturn(true);
    try {
      const result = await sellerRespondToReturn(order.id, {
        accept,
        note: sellerContestNote.trim() || undefined,
      });
      if (result.success) {
        setShowSellerContest(false);
        setSellerContestNote('');
      } else {
        alert(result.message || (isAr ? 'تعذر إرسال الرد.' : 'Failed to respond.'));
      }
    } catch (err: any) {
      console.error(err);
      alert(isAr ? `تعذر إرسال الرد: ${err.message}` : `Failed to respond: ${err.message}`);
    } finally {
      setRespondingReturn(false);
    }
  };

  const handleReleaseEscrow = async () => {
    if (confirm(isAr ? 'تأكيد تحرير الضمان المالي للبائع؟ سيتم قفل الطلب.' : 'Confirm release of Escrow funds directly to the seller? This closes the order.')) {
      setIsUpdating(true);
      try {
        const result = await executeOrderTransition(order, 'release_escrow', currentUser);
        if (result && result.alreadyReleased) {
          alert(isAr ? 'تم تحرير هذا المبلغ سابقاً' : 'This amount was already released.');
        } else {
          alert(isAr ? 'تم تحويل المبلغ للبائع بنجاح' : 'Funds successfully transferred to the seller.');
        }
        addNotification(
          isAr ? 'تم تحرير الضمان' : 'Escrow Released',
          isAr ? 'تم تحويل المبلغ للبائع بنجاح' : 'Funds successfully transferred to the seller.',
          'info'
        );
      } catch (err: any) {
        console.error(err);
        alert(isAr ? `تعذر تحرير المبلغ، حاول مرة أخرى: ${err.message}` : `Failed to release funds, please try again: ${err.message}`);
      } finally {
        setIsUpdating(false);
      }
    }
  };

  const handleRefundBuyer = async () => {
    if (confirm(isAr ? 'تأكيد إعادة المبالغ كاملة للمشتري؟ سيتم إغلاق الملف.' : 'Confirm refund of full Escrow balance to the buyer? This closes the order.')) {
      setIsUpdating(true);
      try {
        await executeOrderTransition(order, 'refund', currentUser);
        addNotification(
          isAr ? 'تمت إعادة الأموال' : 'Refund Completed',
          isAr ? 'تمت إعادة الأموال بالكامل لمحفظة المشتري.' : 'Escrow funds fully refunded and returned back to buyer’s balance.',
          'info'
        );
      } catch (err: any) {
        console.error(err);
        alert(isAr ? `فشل إعادة الأموال: ${err.message}` : `Refund failed: ${err.message}`);
      } finally {
        setIsUpdating(false);
      }
    }
  };

  const handleOpenDispute = async () => {
    const reason = prompt(
      isAr
        ? 'يرجى وصف المشكلة قبل فتح النزاع (مطلوب):'
        : 'Please describe the issue before opening a dispute (required):'
    );
    if (!reason || !reason.trim()) {
      if (reason !== null) {
        alert(isAr ? 'سبب النزاع مطلوب.' : 'A dispute reason is required.');
      }
      return;
    }
    if (confirm(isAr ? 'هل ترغب في فتح نزاع رسمي حول هذا الطلب؟ سيتم تجميد الضمان.' : 'Open a formal dispute for this order? Escrow assets will be locked.')) {
      setIsUpdating(true);
      try {
        await executeOrderTransition(order, 'open_dispute', currentUser, { disputeReason: reason.trim() });
        addNotification(
          isAr ? 'تم فتح نزاع رسمي' : 'Dispute Opened',
          isAr ? 'تم فتح نزاع رسمي. مزاد أوقف تحويل المبلغ للبائع لحين مراجعة الفريق.' : 'Formal dispute logged. Mazad has paused the payout to the seller pending review.',
          'info'
        );
      } catch (err: any) {
        console.error(err);
        alert(isAr ? `فشل فتح النزاع: ${err.message}` : `Failed to open dispute: ${err.message}`);
      } finally {
        setIsUpdating(false);
      }
    }
  };

  const handleCloseDispute = async () => {
    const resolution = prompt(
      isAr 
        ? 'يرجى تحديد طريقة حل النزاع:\nاكتب "release" لتحرير الأموال للبائع\nاكتب "refund" لإعادة الأموال للمشتري\nاكتب "resume" لإعادة الطلب للحالة المدفوعة المعتادة'
        : 'Select dispute resolution method:\nType "release" to release escrow to seller\nType "refund" to refund buyer\nType "resume" to resume the order as Paid'
    );
    if (!resolution) return;

    const lowerRes = resolution.trim().toLowerCase();
    if (lowerRes !== 'release' && lowerRes !== 'refund' && lowerRes !== 'resume') {
      alert(isAr ? 'خيار غير صحيح.' : 'Invalid resolution choice.');
      return;
    }

    setIsUpdating(true);
    try {
      const result = await executeOrderTransition(order, 'resolve_dispute', currentUser, { resolutionType: lowerRes as any });
      if (lowerRes === 'release') {
        if (result && result.alreadyReleased) {
          alert(isAr ? 'تم تحرير هذا المبلغ سابقاً' : 'This amount was already released.');
        } else {
          alert(isAr ? 'تم تحويل المبلغ للبائع بنجاح' : 'Funds successfully transferred to the seller.');
        }
      } else {
        alert(isAr ? 'تمت تسوية النزاع بنجاح.' : 'Dispute resolved successfully.');
      }
      addNotification(
        isAr ? 'تم حل النزاع' : 'Dispute Resolved',
        isAr ? 'تم إنهاء وحل النزاع بنجاح وتحديث قيود الضمان.' : 'Dispute resolved successfully and escrow accounts adjusted.',
        'info'
      );
    } catch (err: any) {
      console.error(err);
      if (lowerRes === 'release') {
        alert(isAr ? `تعذر تحرير المبلغ، حاول مرة أخرى: ${err.message}` : `Failed to release funds, please try again: ${err.message}`);
      } else {
        alert(isAr ? `فشل حل النزاع: ${err.message}` : `Resolution failed: ${err.message}`);
      }
    } finally {
      setIsUpdating(false);
    }
  };

  // Force actions now go through a typed-reference confirmation (ConfirmActionModal)
  // instead of a bare confirm(): the admin must type the order reference and give a
  // reason. The underlying executeOrderTransition calls are UNCHANGED (same money effect).
  const handleForceClose = () => setForceCloseOpen(true);

  const doForceClose = async (reason: string) => {
    console.log('[force_close]', displayOrderRef(order), 'reason:', reason);
    setIsUpdating(true);
    try {
      const result = await executeOrderTransition(order, 'force_close', currentUser);
      if (result && result.alreadyReleased) {
        alert(isAr ? 'تم تحرير هذا المبلغ سابقاً' : 'This amount was already released.');
      } else {
        alert(isAr ? 'تم تحويل المبلغ للبائع بنجاح' : 'Funds successfully transferred to the seller.');
      }
      addNotification(
        isAr ? 'تم فرض الإغلاق' : 'Order Force Closed',
        isAr ? 'تم تحويل المبلغ للبائع بنجاح' : 'Funds successfully transferred to the seller.',
        'info'
      );
      setForceCloseOpen(false);
    } catch (err: any) {
      console.error(err);
      alert(isAr ? `تعذر تحرير المبلغ، حاول مرة أخرى: ${err.message}` : `Failed to release funds, please try again: ${err.message}`);
    } finally {
      setIsUpdating(false);
    }
  };

  // Admin "Force Open Dispute" — typed-reference gated. The buyer/seller
  // "File Formal Dispute" buttons keep the lighter reason-prompt handler above.
  const handleAdminForceDispute = () => setForceDisputeOpen(true);

  const doForceDispute = async (reason: string) => {
    setIsUpdating(true);
    try {
      await executeOrderTransition(order, 'open_dispute', currentUser, { disputeReason: reason });
      addNotification(
        isAr ? 'تم فتح نزاع رسمي' : 'Dispute Opened',
        isAr ? 'تم فتح نزاع رسمي. مزاد أوقف تحويل المبلغ للبائع لحين مراجعة الفريق.' : 'Formal dispute logged. Mazad has paused the payout to the seller pending review.',
        'info'
      );
      setForceDisputeOpen(false);
    } catch (err: any) {
      console.error(err);
      alert(isAr ? `فشل فتح النزاع: ${err.message}` : `Failed to open dispute: ${err.message}`);
    } finally {
      setIsUpdating(false);
    }
  };

  const getActivityIcon = (type: string) => {
    const t = type.toLowerCase();
    if (t.includes('won') || t.includes('create')) return <FileText className="w-4 h-4 text-orange-500" />;
    if (t.includes('paid') || t.includes('pay')) return <CreditCard className="w-4 h-4 text-blue-500" />;
    if (t.includes('prepare') || t.includes('start')) return <Package className="w-4 h-4 text-amber-500" />;
    if (t.includes('ship') || t.includes('transit')) return <Truck className="w-4 h-4 text-orange-500" />;
    if (t.includes('deliver') || t.includes('confirm')) return <CheckCircle2 className="w-4 h-4 text-emerald-500" />;
    if (t.includes('release')) return <ShieldCheck className="w-4 h-4 text-emerald-600" />;
    if (t.includes('refund')) return <XCircle className="w-4 h-4 text-rose-500" />;
    if (t.includes('dispute') && (t.includes('open') || t.includes('initiate'))) return <ShieldAlert className="w-4 h-4 text-rose-500" />;
    return <Activity className="w-4 h-4 text-fg-muted" />;
  };

  // Generate activities for rendering
  const getDisplayActivities = () => {
    // Sort activities descending for rendering (newest first)
    const sortedActivities = [...activities].sort((a, b) => {
      const tA = a.timestamp?.seconds ? a.timestamp.seconds * 1000 : (a.timestamp ? new Date(a.timestamp).getTime() : 0);
      const tB = b.timestamp?.seconds ? b.timestamp.seconds * 1000 : (b.timestamp ? new Date(b.timestamp).getTime() : 0);
      return tB - tA;
    });

    if (sortedActivities.length > 0) {
      return sortedActivities.map(act => {
        const time = act.timestamp?.seconds ? act.timestamp.seconds * 1000 : (act.timestamp ? new Date(act.timestamp).getTime() : Date.now());
        return {
          titleAr: act.messageAr || act.type || 'نشاط الطلب',
          titleEn: act.messageEn || act.type || 'Order Activity',
          descAr: act.performedByName ? `بواسطة: ${act.performedByName}` : 'تحديث من النظام',
          descEn: act.performedByName ? `Performed by: ${act.performedByName}` : 'System Update',
          time,
          icon: getActivityIcon(act.type || '')
        };
      });
    }

    // Fallback if no activities exist yet
    const createdTime = order.createdAt?.seconds ? order.createdAt.seconds * 1000 : (order.createdAt ? new Date(order.createdAt).getTime() : Date.now() - 86400000);
    return [
      {
        titleAr: 'تأسيس وإنشاء الطلب',
        titleEn: 'Order Created',
        descAr: 'تم فتح ملف تتبع الشحن والضمان المالي',
        descEn: 'Escrow tracker and fulfillment record initiated',
        time: createdTime,
        icon: <FileText className="w-4 h-4 text-orange-500" />
      }
    ];
  };

  return (
    <div className="w-full space-y-6 pb-12 animate-fade-in text-fg leading-relaxed">
      {/* Header Back Bar */}
      <div className="flex items-center justify-between bg-surface-raised px-5 py-4 rounded-3xl border border-line shadow-[0_2px_8px_rgba(0,0,0,0.01)] shrink-0">
        <button 
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs font-black text-fg hover:text-fg transition-colors uppercase font-mono cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>{isAr ? 'العودة للقائمة' : 'Back to List'}</span>
        </button>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-fg-muted font-mono font-black uppercase">
            {isAr ? 'رقم الطلب:' : 'ORDER ID:'}
          </span>
          <span className="text-xs font-mono font-black bg-surface-sunken border border-line px-3 py-1 rounded-xl select-all flex items-center gap-1">
            <span>{displayOrderRef(order)}</span>
            <button onClick={copyToClipboard} className="text-fg-muted hover:text-[#FF6B00] transition-colors cursor-pointer">
              {copiedId ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </span>
        </div>
      </div>

      {/* Disputed Danger Banner Alert */}
      {order.status === 'disputed' && (
        <div className="bg-red-50 border border-red-200 rounded-3xl p-4 flex gap-4 items-start shadow-sm">
          <div className="p-2.5 bg-red-500 text-white rounded-2xl shrink-0 shadow-sm animate-pulse">
            <ShieldAlert className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <h4 className="font-black text-red-950 text-xs uppercase font-mono tracking-wide">
              {isAr ? 'تنبيه: يوجد نزاع نشط على هذا الطلب' : 'DISPUTE RESOLUTION PROTOCOL ACTIVE'}
            </h4>
            <p className="text-[11px] text-red-800 leading-relaxed">
              {isAr 
                ? 'مبلغك محجوز لدى مزاد حالياً. فريق النزاعات في مزاد يراجع الحالة والمستندات ويتوسّط لحلّها.'
                : 'Your payment is on hold with Mazad. Mazad\'s disputes team is reviewing the case and documents and will mediate.'}
            </p>
          </div>
        </div>
      )}

      {/* Cancelled Banner Alert */}
      {order.status === 'cancelled' && (
        <div className="bg-red-50 border border-red-200 rounded-3xl p-4 flex gap-4 items-start shadow-sm">
          <div className="p-2.5 bg-red-600 text-white rounded-2xl shrink-0 shadow-sm">
            <XCircle className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <h4 className="font-black text-red-950 text-xs uppercase font-mono tracking-wide">
              {isAr ? 'تنبيه: تم إلغاء هذا الطلب' : 'ORDER CANCELLED'}
            </h4>
            <p className="text-[11px] text-red-800 leading-relaxed">
              {isAr
                ? 'تم إلغاء هذه المعاملة بنجاح. إذا كنت قد دفعت عبر كليك فسيتم إعادة المبلغ لك بحوالة بنكية.'
                : 'This transaction has been cancelled. If you already paid via CliQ, the amount will be returned to you by bank transfer.'}
            </p>
          </div>
        </div>
      )}

      {/* Refunded Banner Alert */}
      {order.status === 'refunded' && (
        <div className="bg-amber-50 border border-amber-200 rounded-3xl p-4 flex gap-4 items-start shadow-sm">
          <div className="p-2.5 bg-amber-500 text-white rounded-2xl shrink-0 shadow-sm">
            <DollarSign className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <h4 className="font-black text-amber-950 text-xs uppercase font-mono tracking-wide">
              {isAr ? 'تنبيه: تم إرجاع قيمة هذا الطلب' : 'ORDER REFUNDED'}
            </h4>
            <p className="text-[11px] text-amber-800 leading-relaxed">
              {isAr
                ? 'تمت إعادة قيمة المعاملة بالكامل للمشتري بحوالة بنكية / كليك بناءً على قرار التحكيم.'
                : 'The entire amount has been fully refunded back to the buyer via bank/CliQ transfer based on dispute resolution/admin action.'}
            </p>
          </div>
        </div>
      )}

      {/* SECTION 1: Horizontal progress timeline */}
      <div className="bg-[#121318] text-white rounded-3xl p-6 shadow-xl border border-white/5 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-36 h-36 bg-[#FF6B00]/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative space-y-5">
          <div className="flex items-center justify-between border-b border-white/10 pb-4">
            <h3 className="text-xs font-black tracking-widest font-mono text-fg-muted uppercase flex items-center gap-1.5">
              <Activity className="w-4 h-4 text-[#FF6B00]" />
              <span>{isAr ? 'تتبع حالة الطلب الفوري' : 'ORDER STATUS TRACKER'}</span>
            </h3>
            {order.status !== 'completed' && order.status !== 'disputed' && (
              <span className="text-[9px] bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-mono font-black px-2 py-0.5 rounded-full uppercase animate-pulse">
                {isAr ? 'نشط' : 'Active'}
              </span>
            )}
          </div>

          {/* Timeline Steps layout */}
          <div className="relative">
            {/* Desktop progress line */}
            <div className="hidden md:block absolute top-[18px] left-[6%] right-[6%] h-0.5 bg-surface-raised/10" />
            <div 
              className="hidden md:block absolute top-[18px] left-[6%] h-0.5 bg-gradient-to-r from-[#FF6B00] to-orange-400 transition-all duration-500"
              style={{ width: `${currentStepIndex >= 0 ? (currentStepIndex / (timelineSteps.length - 1)) * 88 : 0}%` }}
            />

            {/* Steps map */}
            <div className="grid grid-cols-1 md:grid-cols-6 gap-6 md:gap-2 relative z-10">
              {timelineSteps.map((step, idx) => {
                const isCompleted = idx < currentStepIndex;
                const isActive = idx === currentStepIndex;
                const isUpcoming = idx > currentStepIndex;

                return (
                  <div key={step.id} className="flex md:flex-col items-center gap-4 md:gap-2 md:text-center">
                    {/* Circle */}
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center border font-mono font-black text-xs shrink-0 transition-all ${
                      isCompleted 
                        ? 'bg-[#FF6B00] border-[#FF6B00] text-white shadow-md shadow-[#FF6B00]/25'
                        : isActive
                        ? 'bg-surface-raised text-fg border-white ring-4 ring-[#FF6B00]/30 animate-pulse'
                        : 'bg-slate-900 border-white/10 text-fg-muted'
                    }`}>
                      {isCompleted ? <Check className="w-4 h-4 text-white" /> : idx + 1}
                    </div>

                    {/* Texts */}
                    <div className="space-y-0.5">
                      <p className={`text-xs font-black transition-colors ${
                        isActive ? 'text-white' : isCompleted ? 'text-gray-200 font-extrabold' : 'text-fg-muted'
                      }`}>
                        {isAr ? step.labelAr : step.labelEn}
                      </p>
                      <p className="text-[9px] text-fg-muted leading-tight block max-w-[140px] md:mx-auto">
                        {isAr ? step.descAr : step.descEn}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* RESPONSIVE LAYOUT CONTAINER */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        
        {/* LEFT COLUMN: 2 Cols span (Main Information) */}
        <div className="lg:col-span-2 space-y-6">
          
          {/* SECTION 2: Auction Information */}
          <div className="bg-surface-raised border border-line rounded-3xl p-5 shadow-[0_4px_12px_rgba(0,0,0,0.01)] space-y-4">
            <h3 className="text-xs font-black text-fg-muted tracking-wider uppercase font-mono border-b border-line pb-3 flex items-center gap-1.5">
              <Package className="w-4 h-4 text-[#FF6B00]" />
              <span>{isAr ? 'معلومات وتفاصيل المزاد المغلق' : 'AUCTION DETAILS'}</span>
            </h3>

            <div className="flex flex-col sm:flex-row gap-5 items-start">
              <img 
                src={order.auctionImage || ''} 
                alt={order.auctionTitle} 
                className="w-full sm:w-28 h-28 rounded-2xl object-cover border border-line shrink-0 shadow-xs"
                referrerPolicy="no-referrer"
              />
              <div className="space-y-2.5 flex-1 min-w-0">
                <h4 className="font-black text-fg text-base sm:text-lg tracking-tight leading-snug">
                  {order.auctionTitle}
                </h4>
                
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs font-mono">
                  <div className="space-y-0.5">
                    <span className="text-[9px] text-fg-muted uppercase font-black block">{isAr ? 'مبلغ الفوز' : 'WINNING BID'}</span>
                    <span className="text-base font-black text-[#FF6B00]">
                      {order.winningBidAmount.toLocaleString()} JOD
                    </span>
                  </div>

                  <div className="space-y-0.5">
                    <span className="text-[9px] text-fg-muted uppercase font-black block">{isAr ? 'رقم المزاد' : 'AUCTION ID'}</span>
                    <span className="font-extrabold text-fg truncate block">
                      {order.auctionId.toUpperCase()}
                    </span>
                  </div>

                  <div className="space-y-0.5">
                    <span className="text-[9px] text-fg-muted uppercase font-black block">{isAr ? 'تاريخ الترسية' : 'WON DATE'}</span>
                    <span className="font-extrabold text-fg block">
                      {formatDate(order.createdAt)}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* E1 — seller "you'll receive" = hammer net of Mazad's 5% seller
                commission. Seller-only; the buyer keeps seeing hammer + premium. */}
            {isSeller && (
              <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-4 flex items-center justify-between gap-3" id="seller-net-line">
                <div className="space-y-0.5 min-w-0">
                  <span className="text-[9px] text-emerald-700/70 uppercase font-black font-mono block">
                    {isAr ? 'ستستلم' : "YOU'LL RECEIVE"}
                  </span>
                  <span className="text-lg font-black text-emerald-700 font-mono">
                    {(order.sellerNet ?? sellerNet(order.winningBidAmount)).toLocaleString('en-US')} JOD
                  </span>
                </div>
                <p className="text-[9.5px] text-emerald-700/70 font-bold text-right shrink-0 max-w-[45%] leading-snug">
                  {isAr ? 'بعد عمولة مزاد ٥٪' : 'after 5% Mazad commission'}
                </p>
              </div>
            )}
          </div>

          {/* SECTION 5: Payment protection card — honest Mazad-holds-funds model
              (Mazad holds the buyer's payment in its own account and releases it
              to the seller only after the buyer confirms receipt; NOT regulated
              escrow, NOT audited). */}
          <div className="bg-surface border border-line rounded-3xl p-6 relative overflow-hidden">
            {/* Background luxury watermark */}
            <div className="absolute -right-10 -bottom-10 w-40 h-40 bg-orange-500/[0.02] rounded-full pointer-events-none" />

            <div className="space-y-5">
              <div className="flex items-center justify-between border-b border-line/60 pb-3">
                <h3 className="text-xs font-black text-fg-muted tracking-wider uppercase font-mono flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-[#FF6B00]" />
                  <span>{isAr ? 'حماية الدفع' : 'PAYMENT PROTECTION'}</span>
                </h3>
                <span className={`font-mono text-[10px] font-black px-2.5 py-1 rounded-full uppercase border ${
                  order.escrowStatus === 'released'
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-600'
                    : order.escrowStatus === 'refunded'
                    ? 'bg-red-50 border-red-200 text-red-600'
                    : 'bg-blue-50 border-blue-200 text-blue-600'
                }`}>
                  {order.escrowStatus === 'released' ? (isAr ? 'حُوّل للبائع' : 'Released to seller') :
                   order.escrowStatus === 'refunded' ? (isAr ? 'أُعيد للمشتري' : 'Refunded to buyer') :
                   (isAr ? 'محتجز لدى مزاد' : 'Held by Mazad')}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                <div className="bg-surface-raised border border-line p-4 rounded-2xl space-y-1">
                  <span className="text-[9px] text-fg-muted font-mono block uppercase font-black">{isAr ? 'مبلغ محتجز لدى مزاد' : 'HELD BY MAZAD'}</span>
                  <p className="text-lg font-mono font-black text-fg">
                    {order.paymentStatus === 'paid' && order.escrowStatus !== 'released' && order.escrowStatus !== 'refunded' ? `${order.winningBidAmount.toLocaleString()} JOD` : '0 JOD'}
                  </p>
                  <p className="text-[9.5px] text-fg-muted">
                    {order.paymentStatus === 'paid' ? (isAr ? 'محفوظ لدى مزاد حتى تأكيد الاستلام' : 'Held by Mazad until you confirm receipt') : (isAr ? 'بانتظار الدفع' : 'Awaiting payment')}
                  </p>
                </div>

                <div className="bg-surface-raised border border-line p-4 rounded-2xl space-y-1">
                  <span className="text-[9px] text-fg-muted font-mono block uppercase font-black">{isAr ? 'مبلغ حُوّل للبائع' : 'RELEASED TO SELLER'}</span>
                  <p className="text-lg font-mono font-black text-emerald-600">
                    {order.escrowStatus === 'released' ? `${order.winningBidAmount.toLocaleString()} JOD` : '0 JOD'}
                  </p>
                  <p className="text-[9.5px] text-fg-muted">
                    {order.escrowStatus === 'released' ? (isAr ? 'تم تحويله للبائع بعد تأكيد الاستلام' : 'Sent to the seller after you confirmed receipt') : (isAr ? 'لن يُحوّل للبائع قبل تأكيدك للاستلام' : 'Not sent to the seller until you confirm receipt')}
                  </p>
                </div>

                <div className="bg-surface-raised border border-line p-4 rounded-2xl space-y-1">
                  <span className="text-[9px] text-fg-muted font-mono block uppercase font-black">{isAr ? 'كيف تحميك' : 'HOW YOU\'RE PROTECTED'}</span>
                  <div className="flex items-center gap-1.5 mt-0.5 text-emerald-600">
                    <ShieldCheck className="w-4 h-4 text-emerald-500" />
                    <span className="font-extrabold text-xs">{isAr ? 'حماية المشتري' : 'Buyer protection'}</span>
                  </div>
                  <p className="text-[9.5px] text-fg-muted mt-1">
                    {isAr ? 'إذا لم تصل القطعة كما وُصفت، افتح نزاعاً ويُعاد لك المبلغ' : 'If the item is not as described, open a dispute and get refunded'}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* D5 — reach the other side yourself. Shown to buyer and seller once
              payment is verified. The number arrives ONLY from the gated
              callable, never from the order doc: the buyer cannot read the
              seller's user doc at all (firestore.rules limits `users` to
              owner/admin), and nothing is revealed before the money is in. */}
          {(isBuyer || isSeller) && order.paymentVerified === true && !['cancelled', 'refunded'].includes(order.status) && (
            <div className="bg-surface-raised border border-line rounded-3xl p-5 shadow-[0_4px_12px_rgba(0,0,0,0.01)] space-y-3">
              <h3 className="text-xs font-black text-fg-muted tracking-wider uppercase font-mono border-b border-line pb-3 flex items-center gap-1.5">
                <User className="w-4 h-4 text-[#FF6B00]" />
                <span>{isAr ? 'التواصل مع الطرف الآخر' : 'CONTACT THE OTHER SIDE'}</span>
              </h3>
              {!contact ? (
                <>
                  <p className="text-[11px] text-fg-muted leading-relaxed">
                    {isAr
                      ? 'نسّق التسليم مباشرة عبر واتساب بدل المرور بالدعم.'
                      : 'Coordinate the handover directly on WhatsApp instead of going through support.'}
                  </p>
                  <button
                    onClick={handleRevealContact}
                    disabled={contactLoading}
                    className="w-full bg-[#121318] hover:bg-gray-900 text-white font-black py-2.5 rounded-xl text-[11px] uppercase font-mono disabled:opacity-50 cursor-pointer"
                  >
                    {contactLoading
                      ? (isAr ? 'جارٍ التحميل…' : 'Loading…')
                      : (isAr ? 'إظهار رقم التواصل' : 'Show contact number')}
                  </button>
                  {contactError && <p className="text-[10px] text-red-500 font-bold leading-snug">{contactError}</p>}
                </>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] font-bold uppercase font-mono text-fg-muted">
                      {contact.role === 'seller' ? (isAr ? 'البائع' : 'Seller') : (isAr ? 'المشتري' : 'Buyer')}
                    </span>
                    <span className="text-xs font-bold text-fg truncate">{contact.name}</span>
                  </div>
                  <p className="text-sm font-mono text-fg" dir="ltr">{contact.phone}</p>
                  {contact.waMe && (
                    <a
                      href={contact.waMe}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block w-full text-center bg-emerald-600 hover:bg-emerald-700 text-white font-black py-2.5 rounded-xl text-[11px] uppercase font-mono"
                    >
                      {isAr ? 'مراسلة عبر واتساب' : 'Message on WhatsApp'}
                    </a>
                  )}
                </div>
              )}
            </div>
          )}

          {/* SECTION 6: Shipping status + real delivery address (no fabricated data) */}
          <div className="bg-surface-raised border border-line rounded-3xl p-5 shadow-[0_4px_12px_rgba(0,0,0,0.01)] space-y-4">
            <h3 className="text-xs font-black text-fg-muted tracking-wider uppercase font-mono border-b border-line pb-3 flex items-center gap-1.5">
              <Truck className="w-4 h-4 text-[#FF6B00]" />
              <span>{isAr ? 'الشحن والتوصيل' : 'SHIPPING & DELIVERY'}</span>
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-xs font-mono">
              <div className="space-y-3">
                {/* Honest status — no invented tracking/courier/ETA */}
                <div className="bg-surface p-3 rounded-2xl border border-line space-y-0.5">
                  <span className="text-[9px] text-fg-muted uppercase font-black block">{isAr ? 'حالة الشحن' : 'SHIPPING STATUS'}</span>
                  <span className="font-black text-fg mt-0.5 block font-sans">{shipmentStatusLabel}</span>
                </div>

                {/* Tracking number — only when the seller actually entered one */}
                {order.trackingNumber && (
                  <div className="bg-surface p-3 rounded-2xl border border-line space-y-0.5">
                    <span className="text-[9px] text-fg-muted uppercase font-black block">{isAr ? 'رقم التتبع' : 'TRACKING NUMBER'}</span>
                    <span className="font-black text-fg mt-0.5 block select-all">{order.trackingNumber}</span>
                  </div>
                )}
              </div>

              {/* Delivery address — the buyer's real per-order address. Buyer always
                  sees it; seller/admin only after payment is confirmed. */}
              <div className="bg-surface p-4 rounded-2xl border border-line space-y-2">
                <span className="text-[9px] text-fg-muted uppercase font-black block">{isAr ? 'عنوان التوصيل' : 'DELIVERY ADDRESS'}</span>
                {canSeeDeliveryAddress && order.deliveryAddress ? (
                  <div className="flex gap-2.5 items-start mt-1 text-fg">
                    <MapPin className="w-4 h-4 text-[#FF6B00] shrink-0 mt-0.5" />
                    <div className="space-y-1 font-sans text-xs">
                      <p className="font-black text-fg">{order.buyerName}</p>
                      <p>{isAr ? (deliveryGov?.ar ?? order.deliveryAddress.governorate) : (deliveryGov?.en ?? order.deliveryAddress.governorate)}{order.deliveryAddress.area ? ` — ${order.deliveryAddress.area}` : ''}</p>
                      {order.deliveryAddress.building && <p>{order.deliveryAddress.building}</p>}
                      {order.deliveryAddress.notes && <p className="text-fg-muted">{order.deliveryAddress.notes}</p>}
                      {order.deliveryPhone && <p className="font-mono text-[10px] text-fg-muted" dir="ltr">{order.deliveryPhone}</p>}
                    </div>
                  </div>
                ) : (
                  <p className="text-[10px] text-fg-muted font-sans mt-1 leading-relaxed">
                    {order.deliveryAddress
                      ? (isAr ? 'يظهر عنوان التوصيل للبائع بعد تأكيد الدفع.' : 'The delivery address becomes visible to the seller after payment is confirmed.')
                      : (isAr ? 'يقدّم المشتري عنوان التوصيل عند خطوة الدفع.' : 'The buyer provides the delivery address at the payment step.')}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* SECTION 9: Documents — only the buyer's REAL uploaded CliQ receipt.
              Fabricated waybill / POD cards with dead alert() buttons removed;
              new document controls should render only when a real URL exists. */}
          <div className="bg-surface-raised border border-line rounded-3xl p-5 shadow-[0_4px_12px_rgba(0,0,0,0.01)] space-y-4">
            <h3 className="text-xs font-black text-fg-muted tracking-wider uppercase font-mono border-b border-line pb-3 flex items-center gap-1.5">
              <FileCheck className="w-4 h-4 text-[#FF6B00]" />
              <span>{isAr ? 'المستندات' : 'DOCUMENTS'}</span>
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Receipt — real, only shows a control when a proof URL exists */}
              <div className="bg-surface border border-line hover:border-orange-200 p-4 rounded-2xl space-y-3 transition-colors flex flex-col justify-between">
                <div className="space-y-1.5">
                  <div className="p-2 bg-accent-weak text-[#FF6B00] rounded-xl w-fit">
                    <FileText className="w-4 h-4" />
                  </div>
                  <h5 className="font-black text-fg text-xs">{isAr ? 'إيصال الدفع عبر كليك' : 'CliQ Payment Receipt'}</h5>
                  <p className="text-[9px] text-fg-muted leading-tight">
                    {order.paymentProofUrl
                      ? (isAr ? 'تم رفع إيصال حوالة كليك' : 'CliQ transfer receipt uploaded')
                      : order.paymentStatus === 'paid'
                        ? (isAr ? 'تم تأكيد الدفع' : 'Payment confirmed')
                        : (isAr ? 'بانتظار الدفع عبر كليك' : 'Awaiting CliQ payment')}
                  </p>
                </div>
                {order.paymentProofUrl ? (
                  <button
                    onClick={() => window.open(order.paymentProofUrl, '_blank', 'noopener,noreferrer')}
                    className="w-full bg-surface-raised hover:bg-surface-sunken text-fg hover:text-[#FF6B00] border border-line rounded-xl py-1.5 text-[10px] font-black transition-all flex items-center justify-center gap-1 cursor-pointer mt-2"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>{isAr ? 'عرض الإيصال' : 'View Receipt'}</span>
                  </button>
                ) : (
                  <span className="text-[9px] text-fg-muted italic block text-center mt-2">{isAr ? 'غير متوفر بعد' : 'Not available yet'}</span>
                )}
              </div>

              {/* E1 — CliQ sender phone, shown to admin so they can match the
                  incoming transfer to this order (the number the money came from). */}
              {/* The full number is NOT on this document any more — it is
                  admin-only in cliqPaymentSenders/{orderId}, because orders are
                  seller-readable and a UI `isAdmin &&` is not a read rule.
                  Revealed on demand; legacy orders still carry the old field. */}
              {isAdmin && (order.cliqSenderPhoneMasked || order.cliqSenderPhone) && (
                <div className="bg-surface border border-line p-4 rounded-2xl space-y-3 flex flex-col justify-between" id="admin-cliq-sender-phone">
                  <div className="space-y-1.5">
                    <div className="p-2 bg-accent-weak text-[#FF6B00] rounded-xl w-fit">
                      <CreditCard className="w-4 h-4" />
                    </div>
                    <h5 className="font-black text-fg text-xs">{isAr ? 'هاتف مُرسِل حوالة كليك' : 'CliQ Sender Phone'}</h5>
                    <p className="text-[9px] text-fg-muted leading-tight">
                      {isAr ? 'الرقم الذي حُوّل منه الدفع — طابقه مع الحوالة الواردة' : 'The number the payment was sent from — match it to the incoming transfer'}
                    </p>
                  </div>
                  <div className="mt-2">
                    <CliqSenderReveal
                      orderId={order.id}
                      masked={order.cliqSenderPhoneMasked}
                      legacyFull={order.cliqSenderPhone}
                      isAr={isAr}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

        </div>

        {/* RIGHT COLUMN: 1 Col span (Fulfillment Sidebar) */}
        <div className="space-y-6">
          
          {/* ACTION BUTTONS (Section 8) */}
          <div className="bg-surface-raised border border-line rounded-3xl p-5 shadow-[0_4px_12px_rgba(0,0,0,0.01)] space-y-4">
            <h3 className="text-xs font-black text-fg-muted tracking-wider uppercase font-mono border-b border-line pb-3 flex items-center gap-1.5">
              <Activity className="w-4 h-4 text-[#FF6B00]" />
              <span>{isAr ? 'مركز إجراءات الضمان والتسليم' : 'FULFILLMENT INTERACTION PANEL'}</span>
            </h3>

            <div className="space-y-3">
              {/* Buyer specific operations */}
              {isBuyer && (
                <>
                  {/* SCREEN 1 — payment method. Both options settle the same
                      order for the same total; they differ in who moves the
                      money. Neither is preselected: defaulting would quietly
                      migrate every buyer onto a rail we are still onboarding. */}
                  {order.status === 'waiting_payment' && activeRail === null && (
                    <div className="bg-accent-weak border border-[#FF6B00] rounded-2xl p-4 space-y-3" id="payment-method-select">
                      <div className="text-[10px] font-black text-fg uppercase tracking-tight font-mono flex items-center gap-1.5">
                        <Landmark className="w-3.5 h-3.5 text-[#FF6B00]" />
                        <span>{isAr ? 'اختر طريقة الدفع' : 'Choose a payment method'}</span>
                      </div>

                      <button
                        type="button"
                        onClick={() => setPayRail('gateway')}
                        className="w-full text-start bg-surface-raised border border-line hover:border-[#FF6B00] rounded-xl p-3.5 cursor-pointer transition-colors"
                      >
                        {/* TODO: BAE CliQ API — swap in the official CliQ mark
                            once BAE supplies the brand assets. Until then this
                            is a text label: shipping an approximation of a
                            payment scheme's logo is worse than no logo. */}
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[13px] font-black text-fg">
                            {isAr ? 'الدفع عبر كليك (CliQ)' : 'Pay with CliQ'}
                          </span>
                          <span className="text-[9px] font-black text-white bg-[#FF6B00] rounded-full px-2 py-0.5 shrink-0">
                            {isAr ? 'الأسرع' : 'FASTEST'}
                          </span>
                        </div>
                        <p className="text-[10.5px] text-fg-muted font-bold leading-snug mt-1">
                          {isAr
                            ? 'بنرسل طلب دفع لتطبيق بنكك، وبتوافق عليه من عندك. بدون تحويل يدوي ولا صور إيصالات.'
                            : 'We send a payment request to your bank app and you approve it there. No manual transfer, no receipt screenshots.'}
                        </p>
                      </button>

                      <button
                        type="button"
                        onClick={() => setPayRail('manual')}
                        className="w-full text-start bg-surface-raised border border-line hover:border-[#FF6B00] rounded-xl p-3.5 cursor-pointer transition-colors"
                      >
                        <span className="text-[13px] font-black text-fg block">
                          {isAr ? 'تحويل يدوي عبر كليك' : 'Manual CliQ transfer'}
                        </span>
                        <p className="text-[10.5px] text-fg-muted font-bold leading-snug mt-1">
                          {isAr
                            ? 'بتحوّل بنفسك على اسم مزادو المستعار، وبترفع صورة الإيصال.'
                            : "You transfer to Mazzado's alias yourself and upload the receipt."}
                        </p>
                      </button>
                    </div>
                  )}

                  {/* SCREENS 2–7 */}
                  {order.status === 'waiting_payment' && activeRail === 'gateway' && (
                    <CliqPaymentFlow order={order} isAr={isAr} onBack={() => setPayRail(null)} />
                  )}

                  {order.status === 'waiting_payment' && activeRail === 'manual' && (
                    <div className="bg-accent-weak border border-[#FF6B00] rounded-2xl p-4 space-y-4" id="buyer-cliq-payment-panel">
                      {/* Only when there is another rail to change TO. With the
                          gateway off, activeRail is pinned to 'manual', so this
                          would be a control that visibly does nothing. */}
                      {cliqGatewayEnabled && (
                        <button
                          type="button"
                          onClick={() => setPayRail(null)}
                          className="text-[10px] font-black text-fg-muted hover:text-[#FF6B00] transition-colors cursor-pointer"
                        >
                          {isAr ? '← تغيير طريقة الدفع' : '← Change payment method'}
                        </button>
                      )}
                      {/* Amount due */}
                      <div className="text-center space-y-1 border-b border-orange-100 pb-3">
                        <span className="text-[9px] text-fg-muted uppercase font-black font-mono block">
                          {isAr ? 'المبلغ المستحق — شامل عمولة ٥٪' : 'AMOUNT DUE — INCL. 5% PREMIUM'}
                        </span>
                        <div className="flex items-center justify-center gap-2">
                          <div className="text-2xl font-black text-[#FF6B00] font-mono">
                            <CountUp value={totalDue} format={(n) => Number(n.toFixed(3)).toLocaleString('en-US')} />
                            <span className="text-xs font-sans font-bold text-fg-muted"> JOD</span>
                          </div>
                          <button
                            type="button"
                            onClick={handleCopyAmount}
                            className="p-1 bg-surface-raised border border-line rounded-xl text-fg-muted hover:text-[#FF6B00] transition-colors cursor-pointer shrink-0"
                            aria-label={isAr ? 'نسخ المبلغ' : 'Copy amount'}
                          >
                            {copiedAmount ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                        <p className="text-[9.5px] text-fg-muted font-bold">
                          {isAr ? 'لازم يطابق للفلس' : 'Must match to the fil'}
                        </p>
                        {order.paymentDeadlineAt && (
                          <p className="text-[10px] text-amber-700 font-bold flex items-center justify-center gap-1">
                            <Clock className="w-3 h-3" />
                            <span>{isAr ? `ادفع قبل: ${formatDate(order.paymentDeadlineAt)}` : `Pay before: ${formatDate(order.paymentDeadlineAt)}`}</span>
                          </p>
                        )}
                      </div>

                      {/* Buyer-protection reassurance — a dispute model backs this pay step. */}
                      <div className="flex items-start gap-2 bg-emerald-50 border border-emerald-100 rounded-xl p-2.5 -mt-1">
                        <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                        <p className="text-[10px] text-emerald-800 font-bold leading-snug">
                          {isAr
                            ? 'مبلغك محمي: إذا لم تستلم القطعة كما وُصفت، افتح نزاعاً وسنسترجع لك المبلغ وفق سياسة حماية المشتري.'
                            : 'Your payment is protected: if the item does not arrive as described, open a dispute and you are refunded under our buyer-protection policy.'}
                        </p>
                      </div>

                      {/* CliQ recipient details */}
                      <div className="space-y-2 text-xs">
                        <div className="text-[10px] font-black text-fg uppercase tracking-tight font-mono flex items-center gap-1.5">
                          <Landmark className="w-3.5 h-3.5 text-[#FF6B00]" />
                          <span>{isAr ? 'حوّل عبر كليك (CliQ) إلى:' : 'Transfer via CliQ to:'}</span>
                        </div>
                        {/* CliQ alias — PRIMARY transfer target (IBAN below stays as fallback) */}
                        <div className="border-b border-orange-100 pb-1.5 space-y-0.5">
                          <div className="flex justify-between items-center gap-2">
                            <span className="font-bold text-fg-muted">{isAr ? 'اسم مستعار كليك (CliQ Alias)' : 'CliQ Alias'}:</span>
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="font-mono font-black text-fg select-all">{CLIQ_ALIAS}</span>
                              <button
                                type="button"
                                onClick={handleCopyAlias}
                                className="p-1 bg-surface-raised border border-line rounded-xl text-fg-muted hover:text-[#FF6B00] transition-colors cursor-pointer shrink-0"
                              >
                                {copiedAlias ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                              </button>
                            </div>
                          </div>
                          <p className="text-[9.5px] text-fg-muted font-bold">
                            {isAr ? 'حوّل عبر كليك إلى هذا الاسم المستعار' : 'Send via CliQ to this alias'}
                          </p>
                        </div>
                        <div className="flex justify-between items-center border-b border-orange-100 pb-1.5">
                          <span className="font-bold text-fg-muted">{isAr ? 'اسم الحساب' : 'Account Name'}:</span>
                          <span className="font-black text-fg font-mono">{CLIQ_RECIPIENT_NAME_EN}</span>
                        </div>
                        <div className="flex justify-between items-center border-b border-orange-100 pb-1.5">
                          <span className="font-bold text-fg-muted">{isAr ? 'البنك' : 'Bank'}:</span>
                          <span className="font-black text-[#FF6B00] uppercase font-mono">{isAr ? CLIQ_BANK_NAME_AR : CLIQ_BANK_NAME_EN}</span>
                        </div>
                        {/* The IBAN is a FALLBACK destination; the alias above
                            is the primary one and is live. While CLIQ_IBAN is
                            null (account moved banks, new IBAN not yet in hand)
                            the whole row is dropped — an empty IBAN beside a
                            copy button reads as a destination that failed to
                            load, and the button would copy ''. */}
                        {CLIQ_IBAN && (
                          <div className="flex justify-between items-center gap-2">
                            <span className="font-bold text-fg-muted">IBAN:</span>
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="font-mono font-black text-fg select-all text-[10.5px] truncate">{formatIban(CLIQ_IBAN)}</span>
                              <button
                                type="button"
                                onClick={handleCopyIban}
                                className="p-1 bg-surface-raised border border-line rounded-xl text-fg-muted hover:text-[#FF6B00] transition-colors cursor-pointer shrink-0"
                              >
                                {copiedIban ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* W4 — delivery address + phone (required before payment) */}
                      <div className="space-y-2.5 border-t border-orange-100 pt-3" id="delivery-address-fields">
                        <div className="text-[10px] font-black text-fg uppercase tracking-tight font-mono flex items-center gap-1.5">
                          <MapPin className="w-3.5 h-3.5 text-[#FF6B00]" />
                          <span>{isAr ? 'عنوان التوصيل' : 'Delivery address'}</span>
                        </div>
                        <p className="text-[9.5px] text-fg-muted font-bold -mt-1">
                          {isAr ? 'وين نوصّل القطعة إذا فزت؟ لازم نعرف العنوان ورقم هاتفك قبل الدفع.' : 'Where should we deliver the item? We need your address and phone before payment.'}
                        </p>

                        {/* Governorate */}
                        <select
                          value={deliveryGovernorate}
                          onChange={e => { setDeliveryGovernorate(e.target.value); if (deliveryErrors.governorate) setDeliveryErrors(p => ({ ...p, governorate: false })); }}
                          className={`w-full bg-surface-raised border rounded-xl px-3 py-2.5 text-xs font-bold text-fg focus:outline-none focus:border-[#FF6B00] transition-colors appearance-none cursor-pointer ${deliveryErrors.governorate ? 'border-red-300' : 'border-line'}`}
                          id="delivery-governorate"
                          aria-label={isAr ? 'المحافظة' : 'Governorate'}
                        >
                          <option value="" disabled>{isAr ? 'اختر المحافظة' : 'Select governorate'}</option>
                          {JORDAN_GOVERNORATES.map(g => (
                            <option key={g.id} value={g.id}>{isAr ? g.ar : g.en}</option>
                          ))}
                        </select>

                        {/* Area / street (required) */}
                        <input
                          type="text"
                          value={deliveryArea}
                          onChange={e => { setDeliveryArea(e.target.value); if (deliveryErrors.area) setDeliveryErrors(p => ({ ...p, area: false })); }}
                          placeholder={isAr ? 'المنطقة والشارع' : 'Area & street'}
                          className={`w-full bg-surface-raised border rounded-xl px-3 py-2.5 text-xs font-bold text-fg placeholder:text-gray-300 focus:outline-none focus:border-[#FF6B00] transition-colors ${deliveryErrors.area ? 'border-red-300' : 'border-line'}`}
                          id="delivery-area"
                          style={{ textAlign: isAr ? 'right' : 'left' }}
                        />

                        {/* Building / floor (optional) */}
                        <input
                          type="text"
                          value={deliveryBuilding}
                          onChange={e => setDeliveryBuilding(e.target.value)}
                          placeholder={isAr ? 'البناية / الطابق / الشقة (اختياري)' : 'Building / floor / apt (optional)'}
                          className="w-full bg-surface-raised border border-line rounded-xl px-3 py-2.5 text-xs font-bold text-fg placeholder:text-gray-300 focus:outline-none focus:border-[#FF6B00] transition-colors"
                          id="delivery-building"
                          style={{ textAlign: isAr ? 'right' : 'left' }}
                        />

                        {/* Notes / landmark (optional) */}
                        <input
                          type="text"
                          value={deliveryNotes}
                          onChange={e => setDeliveryNotes(e.target.value)}
                          placeholder={isAr ? 'ملاحظات أو علامة مميزة (اختياري)' : 'Notes or landmark (optional)'}
                          className="w-full bg-surface-raised border border-line rounded-xl px-3 py-2.5 text-xs font-bold text-fg placeholder:text-gray-300 focus:outline-none focus:border-[#FF6B00] transition-colors"
                          id="delivery-notes"
                          style={{ textAlign: isAr ? 'right' : 'left' }}
                        />

                        {/* Phone (required, prefilled from profile) */}
                        <input
                          type="tel"
                          dir="ltr"
                          inputMode="tel"
                          autoComplete="tel"
                          value={deliveryPhone}
                          onChange={e => { setDeliveryPhone(e.target.value); if (deliveryErrors.phone) setDeliveryErrors(p => ({ ...p, phone: false })); }}
                          placeholder="07XXXXXXXX"
                          className={`w-full bg-surface-raised border rounded-xl px-3 py-2.5 text-xs font-mono font-bold text-fg placeholder:text-gray-300 focus:outline-none focus:border-[#FF6B00] transition-colors ${deliveryErrors.phone ? 'border-red-300' : 'border-line'}`}
                          id="delivery-phone"
                          aria-label={isAr ? 'رقم الهاتف للتوصيل' : 'Delivery phone'}
                        />

                        {(deliveryErrors.governorate || deliveryErrors.area || deliveryErrors.phone) && (
                          <p className="text-[9.5px] text-red-500 font-bold">
                            {isAr ? 'الرجاء إكمال المحافظة والمنطقة ورقم هاتف أردني صحيح.' : 'Please complete governorate, area, and a valid Jordanian phone.'}
                          </p>
                        )}
                      </div>

                      {/* Receipt screenshot upload */}
                      <div className="relative border-2 border-dashed border-orange-200 hover:border-[#FF6B00] transition-all rounded-xl p-4 flex flex-col items-center justify-center bg-surface-raised cursor-pointer group min-h-[110px]">
                        <input
                          type="file"
                          accept="image/png, image/jpeg, image/jpg"
                          onChange={handleReceiptFileChange}
                          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                          id="order-payment-receipt-input"
                        />
                        {receiptPreview ? (
                          <div className="w-full relative flex flex-col items-center space-y-2">
                            <img
                              src={receiptPreview}
                              alt={isAr ? 'إيصال كليك' : 'CliQ Receipt'}
                              className="max-h-40 w-auto object-contain rounded-xl border border-line shadow-sm"
                              referrerPolicy="no-referrer"
                            />
                            <span className="text-[10px] text-fg-muted font-bold group-hover:text-[#FF6B00] transition-colors">
                              {isAr ? 'اضغط لتغيير لقطة الشاشة' : 'Click to change screenshot'}
                            </span>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center text-center space-y-1.5">
                            <UploadCloud className="w-6 h-6 text-fg-muted group-hover:text-[#FF6B00] transition-colors" />
                            <p className="text-[11px] text-fg font-extrabold">
                              {isAr ? 'ارفع لقطة شاشة لإيصال حوالة كليك' : 'Upload your CliQ transfer receipt screenshot'}
                            </p>
                            <p className="text-[9px] text-fg-muted font-mono">PNG, JPG</p>
                          </div>
                        )}
                      </div>

                      {/* E1 — CliQ sender phone (required). The transfer may come
                          from a number different than the buyer's account (family
                          transfers); admin uses this to match the incoming money. */}
                      <div className="space-y-1.5" id="cliq-sender-phone-field">
                        <label
                          htmlFor="cliq-sender-phone-input"
                          className="text-[10px] font-black text-fg uppercase tracking-tight font-mono flex items-center gap-1.5"
                        >
                          <CreditCard className="w-3.5 h-3.5 text-[#FF6B00]" />
                          <span>{isAr ? 'رقم الهاتف الذي يُرسل منه الدفع عبر كليك' : 'Phone number the CliQ payment is coming from'}</span>
                        </label>
                        <input
                          type="tel"
                          dir="ltr"
                          inputMode="tel"
                          autoComplete="tel"
                          value={cliqSenderPhone}
                          onChange={e => { setCliqSenderPhone(e.target.value); if (cliqSenderPhoneError) setCliqSenderPhoneError(false); }}
                          placeholder="07XXXXXXXX"
                          className={`w-full bg-surface-raised border rounded-xl px-3 py-2.5 text-xs font-mono font-bold text-fg placeholder:text-gray-300 focus:outline-none focus:border-[#FF6B00] transition-colors ${cliqSenderPhoneError ? 'border-red-300' : 'border-line'}`}
                          id="cliq-sender-phone-input"
                          aria-label={isAr ? 'رقم الهاتف الذي يُرسل منه الدفع عبر كليك' : 'Phone number the CliQ payment is coming from'}
                        />
                        <p className="text-[9.5px] text-fg-muted font-bold">
                          {isAr
                            ? 'قد يختلف عن رقم حسابك — إذا حوّل لك أحد أفراد العائلة، اكتب الرقم الذي أرسل منه فعلياً حتى نطابق الحوالة.'
                            : 'This may differ from your account number — if a family member transfers for you, enter the number the money is actually sent from so we can match it.'}
                        </p>
                        {cliqSenderPhoneError && (
                          <p className="text-[9.5px] text-red-500 font-bold">
                            {isAr ? 'الرجاء إدخال رقم الهاتف الذي يُرسل منه الدفع.' : 'Please enter the phone number the payment is sent from.'}
                          </p>
                        )}
                      </div>

                      {/* Wave 1 — CliQ transaction / reference number (required).
                          Reserved uniquely server-side to block reused refs so
                          admin can match each incoming transfer to one order. */}
                      <div className="space-y-1.5" id="cliq-txn-ref-field">
                        <label
                          htmlFor="cliq-txn-ref-input"
                          className="text-[10px] font-black text-fg uppercase tracking-tight font-mono flex items-center gap-1.5"
                        >
                          <FileText className="w-3.5 h-3.5 text-[#FF6B00]" />
                          <span>{isAr ? 'رقم العملية / المرجع' : 'Transaction / reference number'}</span>
                        </label>
                        <input
                          type="text"
                          dir="ltr"
                          value={txnRef}
                          onChange={e => { setTxnRef(e.target.value); if (txnRefError) setTxnRefError(''); }}
                          placeholder={isAr ? 'رقم العملية' : 'Reference number'}
                          className={`w-full bg-surface-raised border rounded-xl px-3 py-2.5 text-xs font-mono font-bold text-fg placeholder:text-gray-300 focus:outline-none focus:border-[#FF6B00] transition-colors ${txnRefError ? 'border-red-300' : 'border-line'}`}
                          id="cliq-txn-ref-input"
                          aria-label={isAr ? 'رقم العملية / المرجع' : 'Transaction / reference number'}
                        />
                        <p className="text-[9.5px] text-fg-muted font-bold">
                          {isAr ? 'من إشعار تحويل كليك' : 'from your CliQ payment confirmation'}
                        </p>
                        {txnRefError && (
                          <p className="text-[9.5px] text-red-500 font-bold">
                            {txnRefError}
                          </p>
                        )}
                      </div>

                      {/* Submit */}
                      <button
                        onClick={handleSubmitCliqPayment}
                        disabled={isUpdating}
                        className="w-full bg-[#FF6B00] hover:bg-[#FF8000] text-white font-black py-3.5 rounded-2xl text-xs transition-all tracking-wider shadow-md shadow-orange-500/10 flex items-center justify-center gap-2 cursor-pointer uppercase font-mono active:scale-[0.99] disabled:opacity-50"
                        id="submit-cliq-payment-btn"
                      >
                        {isUpdating ? (
                          <RefreshCw className="w-4 h-4 animate-spin" />
                        ) : (
                          <CreditCard className="w-4 h-4" />
                        )}
                        <span>{isAr ? 'أرسل إثبات الدفع' : 'Submit Payment Proof'}</span>
                      </button>
                    </div>
                  )}

                  {order.status === 'waiting_payment' && (
                    <button
                      onClick={handleCancelOrder}
                      disabled={isUpdating}
                      className="w-full bg-surface-raised hover:bg-red-50 text-red-600 border border-red-200 font-black py-3 rounded-2xl text-xs transition-all tracking-wider flex items-center justify-center gap-2 cursor-pointer uppercase font-mono active:scale-[0.99] disabled:opacity-50"
                    >
                      <XCircle className="w-4 h-4" />
                      <span>{isAr ? 'إلغاء الطلب بالكامل' : 'Cancel Bidding Order'}</span>
                    </button>
                  )}

                  {/* Progressive email capture — only while the account has no email.
                      Optional and dismissible; persists via the write-once rules claim. */}
                  {!currentUser?.email && !receiptEmailDismissed && (
                    <div className="bg-surface-raised border border-line rounded-2xl p-3.5 space-y-2" id="receipt-email-capture">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-[11px] font-black text-fg flex items-center gap-1.5">
                          <Mail className="w-4 h-4 text-[#FF6B00] shrink-0" />
                          <span>{t.receiptEmailPromptTitle}</span>
                        </p>
                        <button
                          type="button"
                          onClick={() => setReceiptEmailDismissed(true)}
                          aria-label={t.receiptEmailSkip}
                          className="p-0.5 text-gray-300 hover:text-fg-muted transition-colors cursor-pointer shrink-0"
                          id="receipt-email-skip-btn"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <p className="text-[9.5px] text-fg-muted leading-snug">{t.receiptEmailPromptHint}</p>
                      <div className="flex items-stretch gap-2">
                        <input
                          type="email"
                          dir="ltr"
                          inputMode="email"
                          autoComplete="email"
                          value={receiptEmail}
                          onChange={e => { setReceiptEmail(e.target.value); if (receiptEmailError) setReceiptEmailError(false); }}
                          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSaveReceiptEmail(); } }}
                          placeholder={t.receiptEmailPlaceholder}
                          className={`flex-1 min-w-0 bg-surface border rounded-xl px-3 py-2 text-xs font-mono text-fg placeholder:text-gray-300 focus:outline-none focus:border-[#FF6B00] transition-colors ${receiptEmailError ? 'border-red-300' : 'border-line'}`}
                          id="receipt-email-input"
                        />
                        <button
                          type="button"
                          onClick={handleSaveReceiptEmail}
                          disabled={receiptEmailSaving}
                          className="bg-[#121318] hover:bg-gray-900 text-white font-black px-4 rounded-xl text-[10px] uppercase font-mono transition-all cursor-pointer active:scale-[0.98] disabled:opacity-50 flex items-center gap-1.5 shrink-0"
                          id="receipt-email-save-btn"
                        >
                          {receiptEmailSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <span>{t.receiptEmailSave}</span>}
                        </button>
                      </div>
                      {receiptEmailError && (
                        <p className="text-[9.5px] text-red-500 font-bold">{t.receiptEmailInvalid}</p>
                      )}
                    </div>
                  )}

                  {canRateOrder && (
                    <button
                      onClick={() => setReviewPromptOrderId(order.id)}
                      className="w-full bg-amber-400 hover:bg-amber-500 text-amber-950 font-black py-3.5 rounded-2xl text-xs transition-all tracking-wider shadow-md shadow-amber-400/20 flex items-center justify-center gap-2 cursor-pointer uppercase font-mono active:scale-[0.99]"
                      id="rate-order-details-btn"
                    >
                      <Star className="w-4 h-4 fill-amber-950" />
                      <span>{isAr ? 'قيّم تجربتك ⭐' : 'Rate Your Experience ⭐'}</span>
                    </button>
                  )}

                  {(order.status === 'shipped' || order.status === 'delivered' || order.status === 'out_for_delivery') && (
                    <div className="space-y-2.5">
                      {/* Wave 3 step 3 — receipt evidence + typed code. This is
                          the completion event; there is no timer and no
                          auto-complete behind it. */}
                      {deliveryStepFor(order, 'buyer') === 'buyer_confirm' && (
                        <div className="border border-line rounded-2xl p-4 bg-surface space-y-3">
                          <h4 className="text-xs font-black uppercase font-mono text-fg">
                            {isAr ? '٣ · أكّد استلامك' : '3 · Confirm you received it'}
                          </h4>
                          <p className="text-[11px] text-fg-muted leading-relaxed">
                            {isAr
                              ? 'صوّر المنتج بعد الاستلام مع ظهور رمز التسليم المكتوب على الطرد، وأدخل الرمز نفسه. التأكيد يحرّر المبلغ للبائع نهائياً.'
                              : 'Photograph the item after receiving it with the delivery code on the parcel visible, then type that same code. Confirming releases the payment to the seller for good.'}
                          </p>

                          <input
                            type="file"
                            accept="image/*"
                            onChange={(e) => setReceivedPhotoFile(e.target.files?.[0] || null)}
                            className="w-full text-[11px] file:mr-3 file:py-2 file:px-3 file:rounded-xl file:border-0 file:bg-gray-900 file:text-white file:text-[10px] file:font-mono file:uppercase"
                            id="received-photo-input"
                          />

                          <div className="space-y-1.5">
                            <p className="text-[10px] font-bold uppercase font-mono text-fg-muted">
                              {isAr ? 'رمز التسليم المكتوب على الطرد' : 'Delivery code on the parcel'}
                            </p>
                            <input
                              type="text"
                              dir="ltr"
                              inputMode="text"
                              autoCapitalize="characters"
                              value={typedDeliveryCode}
                              onChange={(e) => { setTypedDeliveryCode(e.target.value); if (deliveryCodeError) setDeliveryCodeError(''); }}
                              placeholder="DC-7K3QP"
                              className={`w-full bg-surface-raised border rounded-xl px-3 py-2.5 text-sm font-mono tracking-widest text-fg placeholder:text-gray-300 focus:outline-none focus:border-[#FF6B00] transition-colors ${deliveryCodeError ? 'border-red-300' : 'border-line'}`}
                              id="delivery-code-input"
                            />
                            {deliveryCodeError && (
                              <p className="text-[10px] text-red-500 font-bold leading-snug">{deliveryCodeError}</p>
                            )}
                          </div>

                          <button
                            onClick={handleConfirmReceipt}
                            disabled={uploadingEvidence || submittingReturn || !receivedPhotoFile || !typedDeliveryCode.trim()}
                            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-black py-3.5 rounded-2xl text-xs transition-all tracking-wider shadow-md shadow-emerald-500/10 flex items-center justify-center gap-2 cursor-pointer uppercase font-mono active:scale-[0.99] disabled:opacity-50"
                          >
                            <CheckCircle2 className="w-4 h-4" />
                            <span>{uploadingEvidence ? (isAr ? 'جارٍ التأكيد…' : 'Confirming…') : (isAr ? 'أكّد الاستلام وحرّر الدفعة' : 'Confirm receipt & release payment')}</span>
                          </button>
                        </div>
                      )}

                      {/* LEGACY happy-path: a one-tap release with no evidence.
                          Never offered on an `out_for_delivery` order — that
                          order has a code-gated path, and this button routes to
                          the same callable under the older
                          `buyer_confirm_delivery` action, which would otherwise
                          be a one-click way around the whole evidence chain.
                          The server refuses it there too (releaseOrderEscrow);
                          this condition just stops the app offering it. */}
                      {order.status !== 'out_for_delivery' && (
                      <button
                        onClick={handleConfirmDelivery}
                        disabled={isUpdating || submittingReturn}
                        className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-black py-3.5 rounded-2xl text-xs transition-all tracking-wider shadow-md shadow-emerald-500/10 flex items-center justify-center gap-2 cursor-pointer uppercase font-mono active:scale-[0.99] disabled:opacity-50"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        <span>{isAr ? 'كل شيء ممتاز — حرّر الدفعة' : "Everything's good — release payment"}</span>
                      </button>
                      )}

                      {/*
                        Secondary: report a problem → opens the return claim form.

                        Deliberately narrower than the block above, and it must
                        track `canRequestReturn` in functions/returns.js exactly.
                        handleSubmitReturn uploads every selected photo to Storage
                        BEFORE it calls requestReturn, so offering this entry point
                        in a status the server rejects would burn the buyer's
                        uploads on a call that can only fail and leave orphaned
                        Storage objects they cannot delete.

                        Wave 3 added `out_for_delivery` on BOTH sides: under the
                        evidence flow, raising a claim is the buyer's only
                        alternative to confirming receipt, so a buyer holding a
                        damaged item would otherwise have no path except the one
                        that pays the seller. `delivered` stays excluded (the
                        server still rejects it); a delivered buyer with a problem
                        uses the "File Formal Dispute" button below.
                      */}
                      {(order.status === 'shipped' || order.status === 'out_for_delivery') && (
                        <>
                        {!showReturnForm && (
                          <button
                            onClick={() => setShowReturnForm(true)}
                            disabled={isUpdating || submittingReturn}
                            className="w-full bg-surface-raised hover:bg-surface-sunken text-fg-muted border border-line font-bold py-3 rounded-2xl text-[11px] transition-all flex items-center justify-center gap-1.5 cursor-pointer uppercase font-mono disabled:opacity-50"
                          >
                            <AlertTriangle className="w-4 h-4 text-red-500" />
                            <span>{isAr ? 'الإبلاغ عن مشكلة' : 'Report a problem'}</span>
                          </button>
                        )}

                        {/* Return claim form */}
                        {showReturnForm && (
                          <div
                            className="border border-line rounded-2xl p-4 bg-surface space-y-4 origin-top"
                            style={{ animation: 'returnFormIn 240ms cubic-bezier(0.16, 1, 0.3, 1)' }}
                          >
                            <style>{`@keyframes returnFormIn { from { opacity: 0; transform: translateY(-6px) scale(0.99); } to { opacity: 1; transform: translateY(0) scale(1); } }`}</style>

                            <div className="flex items-center justify-between">
                              <h4 className="text-xs font-black uppercase font-mono text-fg">
                                {isAr ? 'الإبلاغ عن مشكلة' : 'Report a problem'}
                              </h4>
                              <button
                                onClick={() => setShowReturnForm(false)}
                                disabled={submittingReturn}
                                className="text-fg-muted hover:text-fg transition-colors disabled:opacity-50"
                                aria-label={isAr ? 'إغلاق' : 'Close'}
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>

                            {/* Reason radios */}
                            <div className="space-y-2">
                              <p className="text-[10px] font-bold uppercase font-mono text-fg-muted">
                                {isAr ? 'سبب الإرجاع' : 'Reason'}
                              </p>
                              {([
                                { value: 'not_as_described' as ReturnReason, en: 'Not as described', ar: 'مخالف للوصف' },
                                { value: 'damaged' as ReturnReason, en: 'Arrived damaged', ar: 'وصل تالفاً' },
                              ]).map(opt => (
                                <label
                                  key={opt.value}
                                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border cursor-pointer transition-colors ${returnReason === opt.value ? 'border-[#FF6B00] bg-accent-weak' : 'border-line bg-surface-raised hover:bg-surface-sunken'}`}
                                >
                                  <input
                                    type="radio"
                                    name="return-reason"
                                    value={opt.value}
                                    checked={returnReason === opt.value}
                                    onChange={() => setReturnReason(opt.value)}
                                    className="accent-[#FF6B00]"
                                  />
                                  <span className="text-xs font-bold text-fg">{isAr ? opt.ar : opt.en}</span>
                                </label>
                              ))}
                            </div>

                            {/* Description */}
                            <div className="space-y-1.5">
                              <p className="text-[10px] font-bold uppercase font-mono text-fg-muted">
                                {isAr ? 'وصف المشكلة' : 'Describe the problem'}
                              </p>
                              <textarea
                                value={returnDescription}
                                onChange={e => setReturnDescription(e.target.value)}
                                rows={3}
                                placeholder={isAr ? 'اشرح ما الخطأ في المنتج...' : "Explain what's wrong with the item..."}
                                className="w-full bg-surface-raised border border-line rounded-xl px-3 py-2 text-xs text-fg placeholder:text-gray-300 focus:outline-none focus:border-[#FF6B00] transition-colors resize-none"
                              />
                            </div>

                            {/* Photos */}
                            <div className="space-y-2">
                              <p className="text-[10px] font-bold uppercase font-mono text-fg-muted">
                                {isAr ? `الصور (${returnPhotos.length}/6) — مطلوبة` : `Photos (${returnPhotos.length}/6) — required`}
                              </p>
                              {returnPhotos.length > 0 && (
                                <div className="grid grid-cols-3 gap-2">
                                  {returnPhotos.map((file, i) => (
                                    <div key={i} className="relative aspect-square rounded-xl overflow-hidden border border-line">
                                      <img src={URL.createObjectURL(file)} alt="" className="w-full h-full object-cover" />
                                      <button
                                        onClick={() => handleRemoveReturnPhoto(i)}
                                        disabled={submittingReturn}
                                        className="absolute top-1 right-1 bg-black/60 hover:bg-black/80 text-white rounded-full p-0.5 transition-colors disabled:opacity-50"
                                        aria-label={isAr ? 'إزالة' : 'Remove'}
                                      >
                                        <X className="w-3 h-3" />
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {returnPhotos.length < 6 && (
                                <label className="w-full border border-dashed border-line hover:border-[#FF6B00] rounded-xl py-3 flex items-center justify-center gap-2 cursor-pointer transition-colors text-fg-muted hover:text-[#FF6B00]">
                                  <UploadCloud className="w-4 h-4" />
                                  <span className="text-[11px] font-bold uppercase font-mono">
                                    {isAr ? 'إضافة صور' : 'Add photos'}
                                  </span>
                                  <input
                                    type="file"
                                    accept="image/*"
                                    multiple
                                    onChange={handleReturnPhotosPicked}
                                    disabled={submittingReturn}
                                    className="hidden"
                                  />
                                </label>
                              )}
                            </div>

                            {/* Submit */}
                            <button
                              onClick={handleSubmitReturn}
                              disabled={submittingReturn || returnPhotos.length < 1 || !returnDescription.trim()}
                              className="w-full bg-[#121318] hover:bg-gray-900 text-white font-black py-3 rounded-2xl text-xs transition-all tracking-wider flex items-center justify-center gap-2 cursor-pointer uppercase font-mono active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {submittingReturn ? (
                                <>
                                  <RefreshCw className="w-4 h-4 animate-spin" />
                                  <span>{isAr ? 'جارٍ الإرسال...' : 'Submitting...'}</span>
                                </>
                              ) : (
                                <>
                                  <AlertTriangle className="w-4 h-4" />
                                  <span>{isAr ? 'تقديم طلب الإرجاع' : 'Submit return request'}</span>
                                </>
                              )}
                            </button>
                            <p className="text-[9.5px] text-fg-muted leading-relaxed">
                              {isAr
                                ? 'سيتم تجميد الطلب وإيقاف الدفعة للبائع ريثما يراجع الفريق طلب الإرجاع.'
                                : 'The order will be frozen and the payout paused while the team reviews your return.'}
                            </p>
                          </div>
                        )}
                        </>
                      )}
                    </div>
                  )}

                  {/* E6 — buyer's submitted return claim on a disputed order */}
                  {order.status === 'disputed' && order.returnClaim && (
                    <div className="border border-amber-200 rounded-2xl p-4 bg-amber-50/60 space-y-3">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-600" />
                        <h4 className="text-xs font-black uppercase font-mono text-amber-900">
                          {isAr ? 'طلب الإرجاع الخاص بك' : 'Your return request'}
                        </h4>
                      </div>

                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-fg-muted font-bold uppercase font-mono">{isAr ? 'السبب' : 'Reason'}</span>
                        <span className="font-bold text-fg">
                          {order.returnClaim.reason === 'damaged'
                            ? (isAr ? 'وصل تالفاً' : 'Arrived damaged')
                            : (isAr ? 'مخالف للوصف' : 'Not as described')}
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-fg-muted font-bold uppercase font-mono">{isAr ? 'الحالة' : 'Status'}</span>
                        <span className="font-black text-amber-700 uppercase font-mono">
                          {order.returnClaim.status === 'open' && (isAr ? 'قيد المراجعة' : 'Open')}
                          {order.returnClaim.status === 'accepted' && (isAr ? 'مقبول' : 'Accepted')}
                          {order.returnClaim.status === 'resolved_refunded' && (isAr ? 'تم الاسترداد' : 'Refunded')}
                          {order.returnClaim.status === 'resolved_denied' && (isAr ? 'مرفوض' : 'Denied')}
                        </span>
                      </div>

                      {order.returnClaim.description && (
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold uppercase font-mono text-fg-muted">{isAr ? 'الوصف' : 'Description'}</p>
                          <p className="text-xs text-fg leading-relaxed whitespace-pre-wrap">{order.returnClaim.description}</p>
                        </div>
                      )}

                      {order.returnClaim.photoUrls?.length > 0 && (
                        <div className="grid grid-cols-3 gap-2">
                          {order.returnClaim.photoUrls.map((url, i) => (
                            <a
                              key={i}
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="aspect-square rounded-xl overflow-hidden border border-amber-200 block"
                            >
                              <img src={url} alt="" className="w-full h-full object-cover" />
                            </a>
                          ))}
                        </div>
                      )}

                      {order.returnClaim.sellerResponse && (
                        <div className="space-y-1 pt-1 border-t border-amber-200">
                          <p className="text-[10px] font-bold uppercase font-mono text-fg-muted">{isAr ? 'رد البائع' : 'Seller response'}</p>
                          <p className="text-xs text-fg leading-relaxed whitespace-pre-wrap">{order.returnClaim.sellerResponse}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Open dispute */}
                  {order.status !== 'completed' && order.status !== 'disputed' && order.status !== 'cancelled' && order.status !== 'refunded' && (
                    <button
                      onClick={handleOpenDispute}
                      disabled={isUpdating}
                      className="w-full bg-surface-raised hover:bg-surface-sunken text-fg-muted border border-line font-bold py-3 rounded-2xl text-[11px] transition-all flex items-center justify-center gap-1.5 cursor-pointer uppercase font-mono disabled:opacity-50"
                    >
                      <ShieldAlert className="w-4 h-4 text-red-500" />
                      <span>{isAr ? 'رفع نزاع رسمي ومراجعة المشرف' : 'File Formal Dispute'}</span>
                    </button>
                  )}
                </>
              )}

              {/* Seller specific operations */}
              {isSeller && (
                <>
                  {/* E6 B1 — seller's view of the buyer's return claim + accept/contest */}
                  {order.disputeType === 'return' && order.returnClaim && (
                    <div className="border border-amber-200 rounded-2xl p-4 bg-amber-50/60 space-y-3 transition-all duration-200 ease-out">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-600" />
                        <h4 className="text-xs font-black uppercase font-mono text-amber-900">
                          {isAr ? 'طلب إرجاع من المشتري' : 'Buyer return request'}
                        </h4>
                      </div>

                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-fg-muted font-bold uppercase font-mono">{isAr ? 'السبب' : 'Reason'}</span>
                        <span className="font-bold text-fg">
                          {order.returnClaim.reason === 'damaged'
                            ? (isAr ? 'وصل تالفاً' : 'Arrived damaged')
                            : (isAr ? 'مخالف للوصف' : 'Not as described')}
                        </span>
                      </div>

                      {order.returnClaim.description && (
                        <div className="space-y-1">
                          <p className="text-[10px] font-bold uppercase font-mono text-fg-muted">{isAr ? 'الوصف' : 'Description'}</p>
                          <p className="text-xs text-fg leading-relaxed whitespace-pre-wrap">{order.returnClaim.description}</p>
                        </div>
                      )}

                      {order.returnClaim.photoUrls?.length > 0 && (
                        <div className="grid grid-cols-3 gap-2">
                          {order.returnClaim.photoUrls.map((url, i) => (
                            <a
                              key={i}
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="aspect-square rounded-xl overflow-hidden border border-amber-200 block"
                            >
                              <img src={url} alt="" className="w-full h-full object-cover" />
                            </a>
                          ))}
                        </div>
                      )}

                      <div className="flex items-start gap-2 bg-surface-raised/70 border border-amber-200 rounded-xl p-2.5">
                        <Truck className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
                        <p className="text-[11px] text-amber-900 leading-relaxed">
                          {isAr
                            ? 'أنت مسؤول عن أجور شحن الإرجاع في حال كان الطلب صحيحاً.'
                            : 'You are responsible for return shipping on a valid claim.'}
                        </p>
                      </div>

                      {order.returnClaim.status === 'open' ? (
                        <>
                          {!showSellerContest && (
                            <div className="grid grid-cols-2 gap-2">
                              <button
                                onClick={() => handleRespondToReturn(true)}
                                disabled={respondingReturn}
                                className="bg-emerald-600 hover:bg-emerald-700 text-white font-black py-3 rounded-2xl text-[11px] transition-all duration-200 ease-out flex items-center justify-center gap-1.5 cursor-pointer uppercase font-mono active:scale-[0.99] disabled:opacity-50"
                              >
                                <CheckCircle2 className="w-4 h-4" />
                                <span>{isAr ? 'قبول الإرجاع' : 'Accept return'}</span>
                              </button>
                              <button
                                onClick={() => setShowSellerContest(true)}
                                disabled={respondingReturn}
                                className="bg-surface-raised hover:bg-surface-sunken text-fg border border-line font-bold py-3 rounded-2xl text-[11px] transition-all duration-200 ease-out flex items-center justify-center gap-1.5 cursor-pointer uppercase font-mono disabled:opacity-50"
                              >
                                <ShieldAlert className="w-4 h-4 text-red-500" />
                                <span>{isAr ? 'اعتراض' : 'Contest'}</span>
                              </button>
                            </div>
                          )}

                          {showSellerContest && (
                            <div className="space-y-2.5 pt-1 transition-all duration-200 ease-out">
                              <p className="text-[10px] font-bold uppercase font-mono text-fg-muted">{isAr ? 'سبب الاعتراض' : 'Your note'}</p>
                              <textarea
                                value={sellerContestNote}
                                onChange={(e) => setSellerContestNote(e.target.value)}
                                rows={3}
                                disabled={respondingReturn}
                                placeholder={isAr ? 'اشرح سبب اعتراضك على طلب الإرجاع...' : 'Explain why you are contesting this return...'}
                                className="w-full text-xs border border-line rounded-xl p-3 focus:outline-none focus:border-[#FF6B00] resize-none"
                              />
                              <div className="grid grid-cols-2 gap-2">
                                <button
                                  onClick={() => { setShowSellerContest(false); setSellerContestNote(''); }}
                                  disabled={respondingReturn}
                                  className="bg-surface-raised hover:bg-surface-sunken text-fg-muted border border-line font-bold py-3 rounded-2xl text-[11px] transition-all duration-200 ease-out cursor-pointer uppercase font-mono disabled:opacity-50"
                                >
                                  {isAr ? 'إلغاء' : 'Cancel'}
                                </button>
                                <button
                                  onClick={() => handleRespondToReturn(false)}
                                  disabled={respondingReturn || !sellerContestNote.trim()}
                                  className="bg-[#121318] hover:bg-gray-900 text-white font-black py-3 rounded-2xl text-[11px] transition-all duration-200 ease-out flex items-center justify-center gap-1.5 cursor-pointer uppercase font-mono active:scale-[0.99] disabled:opacity-50"
                                >
                                  {respondingReturn ? (isAr ? 'جارٍ الإرسال...' : 'Sending...') : (isAr ? 'إرسال الاعتراض' : 'Submit contest')}
                                </button>
                              </div>
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="space-y-2 pt-1 border-t border-amber-200">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-fg-muted font-bold uppercase font-mono">{isAr ? 'الحالة' : 'Status'}</span>
                            <span className="font-black text-amber-700 uppercase font-mono">
                              {order.returnClaim.status === 'accepted' && (isAr ? 'مقبول' : 'Accepted')}
                              {order.returnClaim.status === 'resolved_refunded' && (isAr ? 'تم الاسترداد' : 'Refunded')}
                              {order.returnClaim.status === 'resolved_denied' && (isAr ? 'مرفوض' : 'Denied')}
                            </span>
                          </div>
                          {order.returnClaim.sellerResponse && (
                            <div className="space-y-1">
                              <p className="text-[10px] font-bold uppercase font-mono text-fg-muted">{isAr ? 'ردك' : 'Your response'}</p>
                              <p className="text-xs text-fg leading-relaxed whitespace-pre-wrap">{order.returnClaim.sellerResponse}</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Wave 3 step 1 — photo of the item being prepared. The photo
                      IS the transition: firestore.rules refuses a status write
                      to preparing_shipment without prepPhotoUrl. */}
                  {deliveryStepFor(order, 'seller') === 'seller_prep' && (
                    <div className="border border-line rounded-2xl p-4 bg-surface space-y-3">
                      <h4 className="text-xs font-black uppercase font-mono text-fg">
                        {isAr ? '١ · صوّر المنتج أثناء التجهيز' : '1 · Photograph the item being prepared'}
                      </h4>
                      <p className="text-[11px] text-fg-muted leading-relaxed">
                        {isAr
                          ? 'صورة واحدة تثبت أن المنتج بحوزتك وجاهز للإرسال. بعدها نعطيك رمز التسليم.'
                          : 'One photo showing the item is with you and ready to send. We issue your delivery code next.'}
                      </p>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => setPrepPhotoFile(e.target.files?.[0] || null)}
                        className="w-full text-[11px] file:mr-3 file:py-2 file:px-3 file:rounded-xl file:border-0 file:bg-gray-900 file:text-white file:text-[10px] file:font-mono file:uppercase"
                        id="prep-photo-input"
                      />
                      <button
                        onClick={handleUploadPrepPhoto}
                        disabled={uploadingEvidence || !prepPhotoFile}
                        className="w-full bg-[#FF6B00] hover:bg-[#FF8000] text-white font-black py-3.5 rounded-2xl text-xs transition-all tracking-wider shadow-md shadow-orange-500/10 flex items-center justify-center gap-2 cursor-pointer uppercase font-mono active:scale-[0.99] disabled:opacity-50"
                      >
                        <Package className="w-4 h-4" />
                        <span>{uploadingEvidence ? (isAr ? 'جارٍ الرفع…' : 'Uploading…') : (isAr ? 'رفع صورة التجهيز' : 'Upload preparation photo')}</span>
                      </button>
                    </div>
                  )}

                  {/* Wave 3 step 2 — dispatch photo with the delivery code visible */}
                  {deliveryStepFor(order, 'seller') === 'seller_dispatch' && (
                    <div className="border border-line rounded-2xl p-4 bg-surface space-y-3">
                      <h4 className="text-xs font-black uppercase font-mono text-fg">
                        {isAr ? '٢ · أرسل المنتج وصوّره مع رمز التسليم' : '2 · Send it and photograph it with the delivery code'}
                      </h4>

                      <div className="bg-surface-raised border border-line rounded-xl p-3 space-y-1">
                        <p className="text-[10px] font-bold uppercase font-mono text-fg-muted">
                          {isAr ? 'رمز التسليم' : 'Delivery code'}
                        </p>
                        <p className="text-2xl font-black font-mono tracking-widest text-fg" dir="ltr">
                          {deliveryCodeLoading ? '…' : (deliveryCode || '—')}
                        </p>
                        <p className="text-[11px] text-fg-muted leading-relaxed">
                          {isAr
                            ? 'اكتب هذا الرمز على الطرد بخط واضح. يجب أن يظهر في صورتك وفي صورة المشتري عند الاستلام — التطابق هو ما يحرّر مبلغك.'
                            : 'Write this code clearly on the parcel. It must be visible in your photo and in the buyer’s receipt photo — that match is what releases your money.'}
                        </p>
                      </div>

                      <div className="space-y-2">
                        <p className="text-[10px] font-bold uppercase font-mono text-fg-muted">
                          {isAr ? 'طريقة التوصيل' : 'Delivery method'}
                        </p>
                        {([
                          { value: 'courier' as const, ar: 'مندوب توصيل', en: 'Local courier' },
                          { value: 'hand' as const, ar: 'تسليم باليد', en: 'Hand delivery' },
                        ]).map(opt => (
                          <label
                            key={opt.value}
                            className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border cursor-pointer transition-colors ${deliveryMethod === opt.value ? 'border-[#FF6B00] bg-accent-weak' : 'border-line bg-surface-raised hover:bg-surface-sunken'}`}
                          >
                            <input
                              type="radio"
                              name="delivery-method"
                              checked={deliveryMethod === opt.value}
                              onChange={() => setDeliveryMethod(opt.value)}
                              className="accent-[#FF6B00]"
                            />
                            <span className="text-xs font-bold text-fg">{isAr ? opt.ar : opt.en}</span>
                          </label>
                        ))}
                      </div>

                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => setSentPhotoFile(e.target.files?.[0] || null)}
                        className="w-full text-[11px] file:mr-3 file:py-2 file:px-3 file:rounded-xl file:border-0 file:bg-gray-900 file:text-white file:text-[10px] file:font-mono file:uppercase"
                        id="sent-photo-input"
                      />
                      <button
                        onClick={handleMarkOutForDelivery}
                        disabled={uploadingEvidence || !sentPhotoFile}
                        className="w-full bg-[#121318] hover:bg-gray-900 text-white font-black py-3.5 rounded-2xl text-xs transition-all tracking-wider flex items-center justify-center gap-2 cursor-pointer uppercase font-mono active:scale-[0.99] disabled:opacity-50"
                      >
                        <Truck className="w-4 h-4" />
                        <span>{uploadingEvidence ? (isAr ? 'جارٍ الرفع…' : 'Uploading…') : (isAr ? 'خرج للتوصيل' : 'Mark out for delivery')}</span>
                      </button>
                    </div>
                  )}

                  {/* Wave 3 — waiting on the buyer's half of the chain */}
                  {order.status === 'out_for_delivery' && (
                    <div className="bg-amber-50/50 border border-amber-200/50 p-3.5 rounded-2xl text-center">
                      <p className="text-xs font-bold text-amber-700 flex items-center justify-center gap-1.5">
                        <Clock className="w-4 h-4 animate-pulse" />
                        <span>{isAr ? 'بانتظار تأكيد المشتري للاستلام — عندها يُحرَّر مبلغك.' : 'Awaiting the buyer’s receipt confirmation — that releases your funds.'}</span>
                      </p>
                    </div>
                  )}

                  {/* Legacy relay path: an order the admin advanced to `shipped`
                      by phone never got a code, so the seller sees the old
                      dispatch button rather than a code they cannot produce. */}
                  {order.status === 'shipped' && (
                    <div className="bg-surface-sunken border border-line p-3.5 rounded-2xl text-center">
                      <p className="text-xs font-bold text-fg-muted flex items-center justify-center gap-1.5">
                        <Truck className="w-4 h-4" />
                        <span>{isAr ? 'الطرد في الطريق — بانتظار تأكيد المشتري.' : 'Parcel in transit — awaiting buyer confirmation.'}</span>
                      </p>
                    </div>
                  )}

                  {order.status === 'waiting_payment' && (
                    <div className="bg-amber-50/50 border border-amber-200/50 p-3.5 rounded-2xl text-center">
                      <p className="text-xs font-bold text-amber-700 flex items-center justify-center gap-1.5">
                        <Clock className="w-4 h-4 animate-pulse" />
                        <span>{isAr ? 'بانتظار قيام المشتري بالدفع لحساب الضمان.' : 'Awaiting buyer Escrow deposit.'}</span>
                      </p>
                    </div>
                  )}

                  {/* Open dispute */}
                  {order.status !== 'completed' && order.status !== 'disputed' && order.status !== 'cancelled' && order.status !== 'refunded' && (
                    <button
                      onClick={handleOpenDispute}
                      disabled={isUpdating}
                      className="w-full bg-surface-raised hover:bg-surface-sunken text-fg-muted border border-line font-bold py-3 rounded-2xl text-[11px] transition-all flex items-center justify-center gap-1.5 cursor-pointer uppercase font-mono disabled:opacity-50"
                    >
                      <ShieldAlert className="w-4 h-4 text-red-500" />
                      <span>{isAr ? 'رفع نزاع رسمي ومشكلة الشحن' : 'File Formal Dispute'}</span>
                    </button>
                  )}

                  {/* E7 — seller rates the buyer once the order is completed */}
                  {order.status === 'completed' && (
                    <div className="bg-surface-raised border border-line rounded-2xl p-4 space-y-3 transition-all duration-200 ease-out" id="seller-rate-buyer-block">
                      <div className="flex items-center gap-2">
                        <Star className="w-4 h-4 text-amber-400 fill-amber-400" />
                        <h4 className="text-xs font-black uppercase font-mono text-fg">
                          {isAr ? 'قيّم المشتري' : 'Rate the buyer'}
                        </h4>
                      </div>

                      {sellerBuyerStars !== null ? (
                        <div className="flex items-center gap-1.5" dir="ltr">
                          {[1, 2, 3, 4, 5].map((n) => (
                            <Star
                              key={n}
                              className={`w-6 h-6 ${n <= sellerBuyerStars ? 'text-amber-400 fill-amber-400' : 'text-gray-200'}`}
                              strokeWidth={1.75}
                            />
                          ))}
                          <span className="text-[9.5px] text-fg-muted font-mono font-bold ms-1">
                            {isAr ? `قيّمتَ هذا المشتري ${sellerBuyerStars}/5` : `You rated this buyer ${sellerBuyerStars}/5`}
                          </span>
                        </div>
                      ) : (
                        <>
                          <StarRating value={sellerRatePick} onChange={setSellerRatePick} size={28} />
                          <textarea
                            value={sellerRateComment}
                            onChange={(e) => setSellerRateComment(e.target.value)}
                            disabled={sellerRatingSaving}
                            maxLength={500}
                            rows={2}
                            placeholder={isAr ? 'أضف تعليقاً (اختياري)' : 'Add a comment (optional)'}
                            className="w-full text-xs border border-line rounded-xl p-3 focus:outline-none focus:border-[#FF6B00] resize-none transition-all duration-200 ease-out"
                          />
                          <button
                            onClick={handleSellerRateBuyer}
                            disabled={sellerRatingSaving || sellerRatePick < 1}
                            className="w-full bg-[#FF6B00] hover:bg-[#FF8000] text-white font-black py-3 rounded-2xl text-[11px] transition-all duration-200 ease-out flex items-center justify-center gap-1.5 cursor-pointer uppercase font-mono active:scale-[0.99] disabled:opacity-40"
                          >
                            <Star className="w-4 h-4" />
                            <span>{sellerRatingSaving ? (isAr ? 'جارٍ الحفظ...' : 'Saving...') : (isAr ? 'إرسال التقييم' : 'Submit rating')}</span>
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* Admin specific operations (Section 8) */}
              {isAdmin && (
                <div className="space-y-2.5 bg-surface p-4 rounded-2xl border border-line">
                  <div className="flex items-center gap-1 text-[9px] text-[#FF6B00] font-mono font-black uppercase mb-1">
                    <BadgeCheck className="w-3.5 h-3.5" />
                    <span>{isAr ? 'صلاحيات المشرف الفورية' : 'SUPERADMIN OVERRIDE CONSOLE'}</span>
                  </div>

                  {order.escrowStatus === 'pending' && order.status !== 'completed' && order.status !== 'cancelled' && order.status !== 'refunded' && (
                    <button
                      onClick={handleReleaseEscrow}
                      disabled={isUpdating}
                      className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-black py-2.5 rounded-xl text-[11px] transition-all flex items-center justify-center gap-1.5 cursor-pointer uppercase font-mono disabled:opacity-50"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      <span>{isAr ? 'تحرير الضمان المالي للبائع' : 'Release Escrow to Seller'}</span>
                    </button>
                  )}

                  {order.escrowStatus === 'pending' && order.status !== 'completed' && order.status !== 'cancelled' && order.status !== 'refunded' && (
                    <button
                      onClick={handleRefundBuyer}
                      disabled={isUpdating}
                      className="w-full bg-red-600 hover:bg-red-700 text-white font-black py-2.5 rounded-xl text-[11px] transition-all flex items-center justify-center gap-1.5 cursor-pointer uppercase font-mono disabled:opacity-50"
                    >
                      <XCircle className="w-4 h-4" />
                      <span>{isAr ? 'إعادة الأموال للمشتري' : 'Refund Escrow to Buyer'}</span>
                    </button>
                  )}

                  {order.status !== 'disputed' && order.status !== 'completed' && order.status !== 'cancelled' && order.status !== 'refunded' && (
                    <button
                      onClick={handleAdminForceDispute}
                      disabled={isUpdating}
                      className="w-full bg-surface-raised hover:bg-red-50 text-red-600 border border-red-200 py-2.5 rounded-xl text-[11px] font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer uppercase font-mono disabled:opacity-50"
                    >
                      <ShieldAlert className="w-4 h-4" />
                      <span>{isAr ? 'فتح نزاع رسمي فوري' : 'Force Open Dispute'}</span>
                    </button>
                  )}

                  {order.status === 'disputed' && (
                    <button
                      onClick={handleCloseDispute}
                      disabled={isUpdating}
                      className="w-full bg-[#121318] hover:bg-slate-900 text-white font-black py-2.5 rounded-xl text-[11px] transition-all flex items-center justify-center gap-1.5 cursor-pointer uppercase font-mono disabled:opacity-50"
                    >
                      <Check className="w-4 h-4" />
                      <span>{isAr ? 'إنهاء وحل النزاع' : 'Resolve & Close Dispute'}</span>
                    </button>
                  )}

                  {order.status !== 'completed' && order.status !== 'cancelled' && order.status !== 'refunded' && (
                    <button
                      onClick={handleForceClose}
                      disabled={isUpdating}
                      className="w-full bg-slate-800 hover:bg-slate-950 text-white font-black py-2.5 rounded-xl text-[11px] transition-all flex items-center justify-center gap-1.5 cursor-pointer uppercase font-mono disabled:opacity-50"
                    >
                      <XCircle className="w-4 h-4" />
                      <span>{isAr ? 'إغلاق الطلب قسرياً' : 'Force Close Order'}</span>
                    </button>
                  )}

                  {/* One-tap buyer trust rating at close-out (mazad_rates_buyer) */}
                  {(order.status === 'completed' || order.status === 'delivered') && (
                    <div className="bg-surface-raised border border-line rounded-xl p-3 space-y-2" id="admin-rate-buyer-row">
                      <span className="text-[9px] text-fg-muted font-mono font-black uppercase block">
                        {isAr ? 'تقييم المشتري (نقرة واحدة)' : 'RATE BUYER (ONE TAP)'}
                      </span>
                      <div className="flex items-center gap-1.5" dir="ltr">
                        {[1, 2, 3, 4, 5].map((n) => {
                          const highlighted = n <= (adminBuyerStars ?? 5); // defaults to a full 5-star highlight
                          return (
                            <button
                              key={n}
                              type="button"
                              disabled={adminRatingSaving || adminBuyerStars !== null}
                              onClick={() => handleAdminRateBuyer(n)}
                              aria-label={`${n}/5`}
                              className={`p-0.5 transition-transform cursor-pointer disabled:cursor-default ${adminBuyerStars === null ? 'hover:scale-110 active:scale-95' : ''}`}
                              id={`admin-rate-buyer-star-${n}`}
                            >
                              <Star
                                className={`w-6 h-6 ${highlighted ? 'text-amber-400 fill-amber-400' : 'text-gray-200'} ${adminBuyerStars !== null && !highlighted ? 'opacity-60' : ''}`}
                                strokeWidth={1.75}
                              />
                            </button>
                          );
                        })}
                        <span className="text-[9.5px] text-fg-muted font-mono font-bold ms-1">
                          {adminBuyerStars !== null
                            ? (isAr ? `تم التقييم ${adminBuyerStars}/5` : `Rated ${adminBuyerStars}/5`)
                            : adminRatingSaving
                              ? (isAr ? 'جارٍ الحفظ...' : 'Saving...')
                              : (isAr ? 'اضغط نجمة للحفظ' : 'Tap a star to save')}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* No actions warning if completed */}
              {order.status === 'completed' && (
                <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 p-4 rounded-2xl text-center space-y-1">
                  <CheckCircle2 className="w-6 h-6 text-emerald-600 mx-auto" />
                  <p className="font-black text-xs uppercase font-mono">{isAr ? 'الصفقة مغلقة بالكامل' : 'ORDER ARCHIVED & COMPLETED'}</p>
                  <p className="text-[10px] text-emerald-700">
                    {isAr ? 'تم الانتهاء من الطلب بنجاح وتحرير حسابات الضمان المالي بالكامل.' : 'All goods arrived safely and escrow transaction accounts cleared.'}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* SECTION 3: Buyer Information */}
          <div className="bg-surface-raised border border-line rounded-3xl p-5 shadow-[0_4px_12px_rgba(0,0,0,0.01)] space-y-4">
            <h3 className="text-xs font-black text-fg-muted tracking-wider uppercase font-mono border-b border-line pb-3 flex items-center gap-1.5">
              <User className="w-4 h-4 text-[#FF6B00]" />
              <span>{isAr ? 'معلومات حساب المشتري' : 'BUYER INFORMATION'}</span>
            </h3>

            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-full bg-[#121318] text-white flex items-center justify-center font-black text-xs shadow-xs border border-white/5 font-mono">
                {order.buyerName.substring(0, 2).toUpperCase()}
              </div>
              <div className="space-y-0.5 min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <h4 className="font-black text-fg text-xs truncate leading-snug">{order.buyerName}</h4>
                  <span className="text-[10px] bg-accent-weak text-[#FF6B00] px-1.5 py-0.5 rounded-full font-sans font-black">{isAr ? 'مزايد' : 'Bidder'}</span>
                </div>
                <p className="text-[9px] text-fg-muted font-mono">
                  ID: <span className="font-bold select-all">{order.buyerId.substring(0, 8).toUpperCase()}</span>
                </p>
                {/* E7 B2 — buyer reputation, seller/admin only (never during bidding). */}
                {(isSeller || isAdmin) && (() => {
                  const rep = buyerReputation(buyerRepReviews, order.buyerId);
                  return (
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className="text-[9px] text-fg-muted font-mono font-black uppercase">
                        {isAr ? 'تقييم المشتري' : 'Buyer rating'}
                      </span>
                      {rep.average !== null ? (
                        <StarRating value={rep.average} count={rep.count} size={12} />
                      ) : (
                        <span className="text-[9px] text-fg-muted font-bold">
                          {isAr ? 'لا يوجد تقييم بعد' : 'No ratings yet'}
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>

          {/* SECTION 4: Seller Information */}
          <div className="bg-surface-raised border border-line rounded-3xl p-5 shadow-[0_4px_12px_rgba(0,0,0,0.01)] space-y-4">
            <h3 className="text-xs font-black text-fg-muted tracking-wider uppercase font-mono border-b border-line pb-3 flex items-center gap-1.5">
              <Building className="w-4 h-4 text-[#FF6B00]" />
              <span>{isAr ? 'معلومات حساب البائع' : 'SELLER PROFILE'}</span>
            </h3>

            {(() => {
              const sellerProf = sellerProfiles?.find(p => p.userId === order.sellerId || p.id === order.sellerId);
              const isPremium = sellerProf?.verificationStatus === 'premium_verified';
              const isVerified = sellerProf?.verificationStatus === 'verified' || isPremium;
              const trustScore = sellerProf?.trustScore;
              const completedSales = sellerProf?.totalSales;
              const ratingVal = sellerProf?.rating;

              return (
                <div className="flex items-center gap-3">
                  {sellerProf ? (
                    <img src={resolveAvatarUrl(sellerProf.storeLogo, sellerProf.userId || order.sellerId)} alt={isAr ? 'شعار المتجر' : 'Store logo'} className="w-11 h-11 rounded-full object-cover border border-line shadow-xs shrink-0" />
                  ) : (
                    <div className="w-11 h-11 rounded-full bg-accent-weak text-[#FF6B00] flex items-center justify-center font-black text-xs shadow-xs border border-orange-100 font-mono shrink-0">
                      {order.sellerName.substring(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div className="space-y-0.5 min-w-0 flex-1">
                    <div className="flex items-center gap-1 flex-wrap">
                      <h4 className="font-black text-fg text-xs truncate leading-snug">{sellerProf?.storeName || order.sellerName}</h4>
                      {isVerified && (
                        <ShieldCheck className={`w-4 h-4 ${isPremium ? 'text-amber-500' : 'text-emerald-500'} shrink-0`} />
                      )}
                    </div>
                    {(!!ratingVal || !!completedSales || !!trustScore) && (
                      <div className="flex items-center gap-1 font-mono text-[9.5px] text-fg-muted flex-wrap">
                        {!!ratingVal && (
                          <>
                            <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
                            <span className="font-black">{ratingVal.toFixed(1)} / 5.0</span>
                          </>
                        )}
                        {!!completedSales && (
                          <>
                            {!!ratingVal && <span className="text-gray-300">•</span>}
                            <span>({completedSales} {isAr ? 'مبيعات' : 'lots'})</span>
                          </>
                        )}
                        {!!trustScore && (
                          <>
                            {(!!ratingVal || !!completedSales) && <span className="text-gray-300">•</span>}
                            <span className="text-orange-500 font-bold">{isAr ? 'ثقة' : 'Trust'} {trustScore}%</span>
                          </>
                        )}
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={`text-[8.5px] font-sans font-extrabold px-1.5 py-0.5 rounded-full border ${
                        isPremium 
                          ? 'bg-amber-50 border-amber-200 text-amber-600' 
                          : isVerified 
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-600' 
                            : 'bg-surface-sunken border-line text-fg-muted'
                      }`}>
                        {isPremium 
                          ? (isAr ? 'موثق متميز بلس' : 'Premium Verified +') 
                          : isVerified 
                            ? (isAr ? 'بائع موثق معتمد' : 'Verified Merchant') 
                            : (isAr ? 'بائع قياسي' : 'Standard Seller')}
                      </span>
                    </div>
                    <p className="text-[9px] text-fg-muted font-mono mt-0.5">
                      ID: <span className="font-bold select-all">{order.sellerId.substring(0, 8).toUpperCase()}</span>
                    </p>
                  </div>
                </div>
              );
            })()}
          </div>

          {/* SECTION 7: Order Activity chronological history */}
          <div className="bg-surface-raised border border-line rounded-3xl p-5 shadow-[0_4px_12px_rgba(0,0,0,0.01)] space-y-4">
            <h3 className="text-xs font-black text-fg-muted tracking-wider uppercase font-mono border-b border-line pb-3 flex items-center gap-1.5">
              <Activity className="w-4 h-4 text-[#FF6B00]" />
              <span>{isAr ? 'سجل تتبع الشحنة والنشاط' : 'AUDIT LEDGER & ACTIVITY'}</span>
            </h3>

            <div className="relative pl-1.5 text-xs font-mono">
              {/* Vertical line */}
              <div className="absolute left-[13px] top-3.5 bottom-3.5 w-0.5 bg-surface-sunken" />

              <div className="space-y-5">
                {getDisplayActivities().map((act, idx) => (
                  <div key={idx} className="flex gap-3 items-start relative z-10">
                    <div className="w-7 h-7 rounded-full bg-surface-raised border border-line shadow-xs flex items-center justify-center shrink-0">
                      {act.icon}
                    </div>
                    <div className="space-y-0.5 min-w-0 flex-1">
                      <p className="font-black text-fg leading-tight text-xs">
                        {isAr ? act.titleAr : act.titleEn}
                      </p>
                      <p className="text-[10px] text-fg-muted leading-relaxed font-sans">
                        {isAr ? act.descAr : act.descEn}
                      </p>
                      <p className="text-[8.5px] text-fg-muted">
                        {new Date(act.time).toLocaleTimeString(isAr ? 'ar-JO' : 'en-US', {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit'
                        })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

        </div>

      </div>

      <ConfirmActionModal
        open={forceCloseOpen}
        isAr={isAr}
        title={isAr ? 'فرض إغلاق الطلب' : 'Force close order'}
        impactLines={[
          isAr
            ? `سيتم تحرير ${(order.sellerNet ?? sellerNet(order.winningBidAmount)).toLocaleString('en-US')} دينار من الضمان إلى البائع.`
            : `This releases ${(order.sellerNet ?? sellerNet(order.winningBidAmount)).toLocaleString('en-US')} JOD from escrow to the seller.`,
          isAr ? 'هذا الإجراء لا يمكن التراجع عنه.' : 'This action cannot be undone.',
        ]}
        confirmToken={order.orderRef || order.id.substring(0, 8).toUpperCase()}
        tokenLabel={isAr ? 'اكتب رقم الطلب للتأكيد:' : 'Type the order reference to confirm:'}
        requireReason
        busy={isUpdating}
        onConfirm={doForceClose}
        onCancel={() => setForceCloseOpen(false)}
      />
      <ConfirmActionModal
        open={forceDisputeOpen}
        isAr={isAr}
        title={isAr ? 'فتح نزاع رسمي' : 'Force open dispute'}
        impactLines={[
          isAr
            ? 'سيتم تجميد الضمان ووقف أي تحويل للبائع لحين المراجعة.'
            : 'Escrow will be locked and any payout to the seller paused pending review.',
        ]}
        confirmToken={order.orderRef || order.id.substring(0, 8).toUpperCase()}
        tokenLabel={isAr ? 'اكتب رقم الطلب للتأكيد:' : 'Type the order reference to confirm:'}
        requireReason
        busy={isUpdating}
        onConfirm={doForceDispute}
        onCancel={() => setForceDisputeOpen(false)}
      />

    </div>
  );
};
