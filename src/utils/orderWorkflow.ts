import { db, handleFirestoreError, OperationType, getCallableFunction } from '../services/firebase';
import { collection, doc, addDoc, updateDoc, Timestamp } from 'firebase/firestore';
import { Order } from '../types';
import { isAdminUser } from './adminAuth';
import { getOrderStatusChip, type OrderStatusCode } from './orderStatusGlossary';

/**
 * ONE status enum for the whole app.
 *
 * This used to be its own 9-value union, separate from `Order['status']` in
 * types.ts — the audit's "reconcile 2 status enums". Two unions meant adding
 * `out_for_delivery` in Wave 3 required editing both and remembering to; a
 * status added to one and not the other produces a state the FSM cannot route
 * out of, which surfaces to a user as a raw "Illegal state transition" alert.
 *
 * `OrderStatusCode` in orderStatusGlossary.ts is the single source: it is the
 * superset that already had to enumerate every code for labelling, and a code
 * with no label leaks a raw string to a user.
 */
export type OrderStatus = OrderStatusCode;

// Allowed transitions mapping (Finite State Machine)
export const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  // A dispute must be openable from EVERY live state. OrderDetailsView offers
  // "File Formal Dispute" at any non-terminal status, open_dispute is not
  // intercepted by either Cloud Function block, and opening one writes no money
  // field — so a status missing 'disputed' here does not protect anything, it
  // just throws a raw `Illegal state transition` alert at the buyer. That was
  // the case in `preparing_shipment`, which is where the admin relay parks
  // orders while it phones the seller: the queue's normal resting state.
  waiting_payment: ['paid', 'cancelled', 'disputed'],
  paid: ['preparing_shipment', 'refunded', 'disputed'],
  // Wave 3 — `out_for_delivery` is the evidence flow's dispatch edge (the seller
  // uploaded a photo of it leaving with the delivery code visible). `shipped`
  // stays alongside it: that is the admin relay's phone-recorded dispatch, which
  // carries no evidence and is the fallback when a seller cannot use the app.
  preparing_shipment: ['out_for_delivery', 'shipped', 'disputed'],
  // `completed` is deliberately absent. The buyer's receipt confirmation is what
  // completes this order, and it releases money — so it belongs to
  // releaseOrderEscrow, never to a client transition.
  out_for_delivery: ['delivered', 'disputed'],
  shipped: ['delivered', 'disputed'],
  delivered: ['completed', 'disputed'],
  disputed: ['completed', 'refunded', 'paid'], // Admin resolutions
  completed: [],
  cancelled: [],
  refunded: [],
  // Present with NO outbound edges, deliberately. Both were absent before,
  // which behaved identically (an absent key throws "Illegal state transition"
  // just as an empty list does) but let the FSM and the glossary drift apart.
  // Listing them makes the parity test in orderStatusGlossary.test.ts able to
  // prove every status is accounted for. No edges are invented here: the
  // below-reserve confirmation flow and the payment-default enforcer both move
  // these server-side, and giving them client edges would be a new capability,
  // not a reconciliation.
  pending_buyer_confirmation: [],
  defaulted: [],
};

// Validate transition is legal
export function validateTransition(fromStatus: OrderStatus, toStatus: OrderStatus, escrowStatus?: string): void {
  // Check FSM allowed transitions
  const allowed = VALID_TRANSITIONS[fromStatus];
  if (!allowed || !allowed.includes(toStatus)) {
    throw new Error(`Illegal state transition from "${fromStatus}" to "${toStatus}".`);
  }

  // Prevent illegal transitions (extra rules)
  // 1. Cannot ship before payment
  if (toStatus === 'shipped' && fromStatus !== 'preparing_shipment') {
    throw new Error("Cannot ship before payment or preparation.");
  }

  // 2. Cannot release escrow before delivered (unless in disputed state where admin overrides)
  if (toStatus === 'completed' && escrowStatus === 'released' && fromStatus !== 'delivered' && fromStatus !== 'disputed') {
    throw new Error("Cannot release escrow before delivered or disputed.");
  }

  // 3. Cannot complete cancelled orders
  if (fromStatus === 'cancelled') {
    throw new Error("Cannot complete cancelled orders.");
  }

  // 4. Cannot refund completed orders
  if (fromStatus === 'completed' && toStatus === 'refunded') {
    throw new Error("Cannot refund completed orders.");
  }
}

// Check role permissions for specific actions
export function checkRolePermission(action: string, role: 'buyer' | 'seller' | 'admin'): boolean {
  // Wave 3: `confirm_receipt` is the buyer's evidence-backed acceptance. Like
  // `confirm_delivery` it is listed here as a BUYER action but executes entirely
  // inside releaseOrderEscrow — this table only decides who may ask.
  const buyerActions = ['cancel_before_payment', 'confirm_delivery', 'confirm_receipt', 'open_dispute'];
  // mark_delivered is a claim of FACT (the goods arrived), not a money move —
  // escrow release remains admin-only below. Admins inherit every action, which
  // is what lets the team advance an order on the seller's behalf.
  // Wave 3: upload_prep_photo / mark_out_for_delivery are the seller's two
  // evidence steps — the same money-free claims as prepare_shipment /
  // mark_shipped, with a required photo attached.
  const sellerActions = ['prepare_shipment', 'mark_shipped', 'mark_delivered', 'upload_tracking', 'open_dispute', 'upload_prep_photo', 'mark_out_for_delivery'];
  const adminActions = ['release_escrow', 'refund', 'resolve_dispute', 'force_close'];

  if (role === 'admin') {
    return adminActions.includes(action) || buyerActions.includes(action) || sellerActions.includes(action); // Admin can do anything
  }
  if (role === 'buyer') {
    return buyerActions.includes(action);
  }
  if (role === 'seller') {
    return sellerActions.includes(action);
  }
  return false;
}

// Central transition function
export async function executeOrderTransition(
  order: Order,
  action: 'cancel_before_payment' | 'prepare_shipment' | 'mark_shipped' | 'mark_delivered' | 'confirm_delivery' | 'open_dispute' | 'release_escrow' | 'refund' | 'resolve_dispute' | 'force_close' | 'upload_prep_photo' | 'mark_out_for_delivery' | 'confirm_receipt',
  currentUser: { id: string; email: string; name: string; role: 'user' | 'seller' | 'admin'; isAdmin?: boolean },
  extraFields?: {
    trackingNumber?: string;
    resolutionType?: 'release' | 'refund' | 'resume';
    disputeReason?: string;
    /**
     * Free-text context from whoever advanced the order — "called seller,
     * courier collects Tuesday". Additive: the canned bilingual activity
     * message still goes to the buyer and seller, this is what the TEAM reads
     * when picking the order up next.
     *
     * INTERNAL. It is written to orders/{orderId}/adminNotes, which
     * firestore.rules gates on isAdmin() for read AND write. It must never go
     * onto the activity record — OrderDetailsView onSnapshot-subscribes
     * orders/{orderId}/activity for the buyer and the seller, so anything
     * written there is transmitted to their browsers regardless of what the UI
     * chooses to render.
     */
    note?: string;
    /** Wave 3 — seller step 1: photo of the item being prepared. */
    prepPhotoUrl?: string;
    /** Wave 3 — seller step 2: photo of it sent, with the delivery code visible. */
    sentPhotoUrl?: string;
    /** Wave 3 — seller step 2: how it is travelling. */
    deliveryMethod?: 'hand' | 'courier';
    /**
     * Wave 3 — buyer step 3. Both are handed to the releaseOrderEscrow callable
     * and NEVER written from here: the receipt photo is the evidence that
     * releases money, and the code is a secret from the buyer's own order doc
     * (it lives in deliveryCodes/{orderId}, seller + admin readable only).
     */
    receivedPhotoUrl?: string;
    deliveryCode?: string;
  }
): Promise<any> {
  // Determine role
  let role: 'buyer' | 'seller' | 'admin' = 'buyer';
  if (isAdminUser(currentUser)) {
    role = 'admin';
  } else if (currentUser.id === order.sellerId) {
    role = 'seller';
  } else if (currentUser.id === order.buyerId) {
    role = 'buyer';
  }

  // Check permission
  if (!checkRolePermission(action, role)) {
    throw new Error(`Role "${role}" does not have permission to execute action "${action}".`);
  }

  // CRITICAL FIX PHASE 1 — Secure Escrow Release Cloud Function delegation
  if (
    action === 'release_escrow' || 
    action === 'force_close' || 
    (action === 'resolve_dispute' && extraFields?.resolutionType === 'release') ||
    action === 'confirm_delivery' ||
    // Wave 3 — the buyer's evidence-backed acceptance. Same destination as
    // confirm_delivery, plus the typed code and receipt photo the callable
    // verifies inside the money transaction.
    action === 'confirm_receipt'
  ) {
    const releaseCallable = await getCallableFunction<
      {
        orderId: string;
        action: 'buyer_confirm_delivery' | 'buyer_confirm_receipt' | 'admin_release' | 'admin_force_close';
        deliveryCode?: string;
        receivedPhotoUrl?: string;
      },
      { success: boolean; message: string; alreadyReleased?: boolean }
    >('releaseOrderEscrow');

    let cfAction: 'buyer_confirm_delivery' | 'buyer_confirm_receipt' | 'admin_release' | 'admin_force_close' = 'buyer_confirm_delivery';
    if (action === 'release_escrow' || (action === 'resolve_dispute' && extraFields?.resolutionType === 'release')) {
      cfAction = 'admin_release';
    } else if (action === 'force_close') {
      cfAction = 'admin_force_close';
    } else if (action === 'confirm_delivery') {
      cfAction = 'buyer_confirm_delivery';
    } else if (action === 'confirm_receipt') {
      cfAction = 'buyer_confirm_receipt';
    }

    try {
      const result = await releaseCallable({
        orderId: order.id,
        action: cfAction,
        // Conditional spread: every other caller (admin release, force close,
        // the legacy buyer confirm) has no evidence to send, and shipping stray
        // keys to a money callable is how a future guard gets confused about
        // which path it is on.
        ...(cfAction === 'buyer_confirm_receipt'
          ? {
              deliveryCode: extraFields?.deliveryCode || '',
              receivedPhotoUrl: extraFields?.receivedPhotoUrl || '',
            }
          : {})
      });
      if (!result.data || !result.data.success) {
        throw new Error(result.data?.message || 'Escrow release Cloud Function execution failed.');
      }
      return {
        success: true,
        alreadyReleased: !!result.data.alreadyReleased,
        message: result.data.message
      };
    } catch (err: any) {
      console.error('Error executing escrow release:', err);
      // PRESERVE `code` AND `details`. This used to re-throw a bare
      // `new Error(err.message)`, which silently dropped both — and callers
      // branch on them. Wave 3's buyer confirm reads `code ===
      // 'functions/invalid-argument'` to show a wrong delivery code INLINE on
      // the field (so the buyer keeps the receipt photo they already attached)
      // and reads `details.remaining` to say how many tries are left. With the
      // code stripped, every one of those fell through to the generic
      // `alert()` branch instead — caught in the 2026-07-28 production smoke
      // test, where a wrong code produced a blocking dialog rather than the
      // inline error. Anything added to this catch must keep them.
      const wrapped: any = new Error(err.message || 'تعذر تحرير المبلغ، حاول مرة أخرى');
      if (err && err.code) wrapped.code = err.code;
      if (err && err.details) wrapped.details = err.details;
      throw wrapped;
    }
  }

  // CRITICAL FIX PHASE 2 — Secure Escrow Refund Cloud Function delegation
  if (
    action === 'refund' ||
    (action === 'resolve_dispute' && extraFields?.resolutionType === 'refund')
  ) {
    const refundCallable = await getCallableFunction<
      { orderId: string; action: 'admin_refund' }, 
      { success: boolean; message: string; alreadyRefunded?: boolean }
    >('refundOrderEscrow');

    try {
      const result = await refundCallable({
        orderId: order.id,
        action: 'admin_refund'
      });
      if (!result.data || !result.data.success) {
        throw new Error(result.data?.message || 'Escrow refund Cloud Function execution failed.');
      }
      return {
        success: true,
        alreadyRefunded: !!result.data.alreadyRefunded,
        message: result.data.message
      };
    } catch (err: any) {
      console.error('Error executing escrow refund:', err);
      // Preserve `code`/`details`, same as the release catch above. This was
      // left as a bare re-throw when the release path was fixed (PR #185)
      // because nothing branched on a refund error code — which is exactly how
      // that bug survived on the release path for months, invisible until a
      // caller finally needed the code and silently got the generic alert.
      const wrapped: any = new Error(err.message || 'تعذر استرداد المبلغ، حاول مرة أخرى');
      if (err && err.code) wrapped.code = err.code;
      if (err && err.details) wrapped.details = err.details;
      throw wrapped;
    }
  }

  const fromStatus = order.status as OrderStatus;
  let toStatus: OrderStatus = fromStatus;
  let updateFields: Partial<Order> & Record<string, any> = {};

  let activityType = '';
  let activityMessageAr = '';
  let activityMessageEn = '';

  // Determine transition target and fields
  switch (action as any) {
    // 'pay' USED TO LIVE HERE, AND IT WAS DEAD CODE THAT COULD ONLY FAIL.
    //
    // Wave 1 moved payment to the submitOrderPayment callable, which reserves
    // a unique transaction reference and writes status + paymentStatus
    // atomically with the Admin SDK. Nothing has called this branch since.
    //
    // It still set the paid payment-status field from the browser, and that
    // field is on the orders update denylist in firestore.rules —
    // deliberately, so a buyer cannot mark their own order paid and skip the
    // reference-uniqueness check. So the updateDoc would have been rejected
    // whole and the buyer shown a failure. Removing it means an accidental
    // caller hits the `default:` throw below, which says plainly that the
    // action is server-side, instead of a permission error from the rules.

    case 'cancel_before_payment':
      toStatus = 'cancelled';
      // paymentStatus is intentionally NOT written here. Wave 1 made it
      // server-only (denylisted in firestore.rules); it is already 'unpaid' in
      // every state cancel is reachable from (waiting_payment), so writing it
      // would be a redundant no-op that only re-couples this client transition
      // to the rules denylist. Cancelling only changes status.
      updateFields = {
        status: 'cancelled'
      };
      activityType = 'Order Cancelled';
      activityMessageAr = 'تم إلغاء الطلب وتحرير الضمان المالي بالكامل.';
      activityMessageEn = 'Order cancelled and escrow holdings resolved successfully.';
      break;

    case 'prepare_shipment':
      toStatus = 'preparing_shipment';
      updateFields = {
        status: 'preparing_shipment',
        shippingStatus: 'preparing'
      };
      activityType = 'Seller Started Shipment';
      activityMessageAr = 'البائع يجهز المنتج والملصقات للشحن اللوجستي.';
      activityMessageEn = 'Seller started preparing items and labels for parcel fulfillment.';
      break;

    case 'upload_prep_photo': {
      // Wave 3 step 1. The photo IS the transition, not a decoration:
      // firestore.rules refuses any write that SETS status to
      // 'preparing_shipment' without prepPhotoUrl, so a missing URL here would
      // fail at the rules layer as a raw permission error the seller cannot
      // act on. Throw a legible one first.
      const prepPhoto = typeof extraFields?.prepPhotoUrl === 'string' ? extraFields.prepPhotoUrl.trim() : '';
      if (!prepPhoto) {
        throw new Error('A photo of the item being prepared is required to start this step.');
      }
      toStatus = 'preparing_shipment';
      updateFields = {
        status: 'preparing_shipment',
        shippingStatus: 'preparing',
        prepPhotoUrl: prepPhoto
      };
      activityType = 'Seller Started Shipment';
      activityMessageAr = 'رفع البائع صورة المنتج أثناء التجهيز.';
      activityMessageEn = 'Seller uploaded a photo of the item being prepared.';
      break;
    }

    case 'mark_out_for_delivery': {
      // Wave 3 step 2. Both fields are required by firestore.rules on any write
      // that sets status to 'out_for_delivery' — same reasoning as step 1.
      const sentPhoto = typeof extraFields?.sentPhotoUrl === 'string' ? extraFields.sentPhotoUrl.trim() : '';
      if (!sentPhoto) {
        throw new Error('A photo of the item sent, with the delivery code visible, is required.');
      }
      const method = extraFields?.deliveryMethod;
      if (method !== 'hand' && method !== 'courier') {
        throw new Error('Choose a delivery method: hand delivery or local courier.');
      }
      toStatus = 'out_for_delivery';
      updateFields = {
        status: 'out_for_delivery',
        // shippingStatus keeps its legacy 4-value union ('shipped' is its
        // in-transit value) — MyOrdersList / SoldOrdersList render off it.
        shippingStatus: 'shipped',
        sentPhotoUrl: sentPhoto,
        deliveryMethod: method
      };
      activityType = 'Out For Delivery';
      activityMessageAr = 'خرج المنتج للتوصيل — رفع البائع صورة الإرسال مع ظهور رمز التسليم.';
      activityMessageEn = 'Item out for delivery — seller uploaded the dispatch photo with the delivery code visible.';
      break;
    }

    case 'mark_shipped':
      toStatus = 'shipped';
      // NEVER FABRICATE A TRACKING NUMBER. This used to fall back to a random
      // `MJ-######`, which was then interpolated into the activity messages the
      // BUYER and SELLER read — a tracking ID that tracks nothing. The admin
      // relay (handleAdvanceOrder) passes only `{ note }`, so that fallback was
      // the default for every admin-driven "Out for delivery". The parcel really
      // is in transit, so say exactly that and omit the ID we do not have.
      const tracking = typeof extraFields?.trackingNumber === 'string'
        ? extraFields.trackingNumber.trim()
        : '';
      updateFields = {
        status: 'shipped',
        shippingStatus: 'shipped',
        // Conditional spread: Firestore rejects an explicit `undefined`, and
        // writing an empty string would clobber a tracking number set earlier.
        ...(tracking ? { trackingNumber: tracking } : {})
      };
      activityType = 'Package Shipped';
      activityMessageAr = tracking
        ? `تم شحن الطرد بنجاح مع شركة التوصيل. رقم التتبع: ${tracking}`
        : 'تم شحن الطرد بنجاح مع شركة التوصيل.';
      activityMessageEn = tracking
        ? `Parcel in transit with courier. Tracking ID: ${tracking}`
        : 'Parcel in transit with courier.';
      break;

    case 'mark_delivered':
      toStatus = 'delivered';
      // MONEY-FREE BY CONSTRUCTION. `confirm_delivery` above routes to the
      // releaseOrderEscrow Cloud Function, so using it to record "the goods
      // arrived" would also pay the seller. The admin relay needs those
      // separate: goods arrive -> buyer accepts or rejects -> only THEN does
      // accounting release. So this writes status/shippingStatus only, and the
      // forbiddenFields guard below still rejects any escrow key.
      updateFields = {
        status: 'delivered',
        shippingStatus: 'delivered'
      };
      activityType = 'Package Delivered';
      activityMessageAr = 'تم تسليم الطرد للمشتري — بانتظار تأكيد الاستلام قبل تحرير المبلغ.';
      activityMessageEn = 'Parcel delivered to the buyer — awaiting acceptance before funds are released.';
      break;

    case 'open_dispute':
      toStatus = 'disputed';
      updateFields = {
        status: 'disputed',
        disputeReason: extraFields?.disputeReason || ''
      };
      activityType = 'Dispute Opened';
      activityMessageAr = 'تم فتح نزاع رسمي. مزاد أوقف تحويل المبلغ للبائع لحين مراجعة الفريق.';
      activityMessageEn = 'Formal dispute logged. Mazad has paused the payout to the seller pending review.';
      break;

    case 'resolve_dispute':
      const resType = extraFields?.resolutionType || 'release';
      if (resType === 'resume') {
        toStatus = 'paid';
        updateFields = {
          status: 'paid'
        };
        activityType = 'Dispute Closed (Resumed)';
        activityMessageAr = 'تم إغلاق النزاع وإعادة الطلب للحالة النشطة المدفوعة.';
        activityMessageEn = 'Dispute closed and order set back to active Paid status.';
      } else {
        throw new Error(`Financial transitions (resolution: ${resType}) are server-only and cannot be executed client-side.`);
      }
      break;

    default:
      throw new Error(`Unknown action type or action requires server-side processing: ${action}`);
  }

  // Validate the status transition
  validateTransition(fromStatus, toStatus, updateFields.escrowStatus || order.escrowStatus);

  const orderPath = `orders/${order.id}`;

  try {
    // Financial transitions are server-only. Do not update escrow/payment settlement fields from the client.
    const forbiddenFields = [
      'escrowStatus',
      'financialStatus',
      'settlementStatus',
      'payoutStatus',
      'escrowReleasedAt',
      'escrowRefundedAt',
      'escrowReleasedBy',
      'escrowRefundedBy'
    ];
    const forbiddenStatuses = ['completed', 'refunded'];
    const forbiddenEscrows = ['released', 'refunded'];

    for (const key of Object.keys(updateFields)) {
      if (forbiddenFields.includes(key)) {
        throw new Error(`Financial transitions are server-only. Do not update escrow/payment settlement fields from the client. Forbidden field: "${key}"`);
      }
    }
    if (updateFields.status && forbiddenStatuses.includes(updateFields.status)) {
      throw new Error(`Financial transitions are server-only. Do not update escrow/payment settlement fields from the client. Forbidden status: "${updateFields.status}"`);
    }
    if (updateFields.escrowStatus && forbiddenEscrows.includes(updateFields.escrowStatus)) {
      throw new Error(`Financial transitions are server-only. Do not update escrow/payment settlement fields from the client. Forbidden escrowStatus: "${updateFields.escrowStatus}"`);
    }

    // 1. Update Order in Firestore
    const orderRef = doc(db, 'orders', order.id);
    await updateDoc(orderRef, {
      ...updateFields,
      updatedAt: Timestamp.now()
    });

    // 2. Add Order Activity record to orders/{orderId}/activity subcollection
    const activityColRef = collection(db, 'orders', order.id, 'activity');
    const activityId = `act-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const trimmedNote = typeof extraFields?.note === 'string' ? extraFields.note.trim() : '';
    await addDoc(activityColRef, {
      id: activityId,
      type: activityType,
      messageAr: activityMessageAr,
      messageEn: activityMessageEn,
      message: activityMessageEn, // English default as requested
      // NO `note` KEY HERE, EVER. The buyer and the seller can read this
      // subcollection (firestore.rules) and OrderDetailsView keeps a live
      // onSnapshot on it, so a note written here reaches their browsers even
      // though nothing renders it. The note goes to adminNotes below instead.
      performedBy: currentUser.id,
      performedByName: currentUser.name || 'User',
      timestamp: Timestamp.now()
    });

    // 3. Write adminActions log if role is Admin.
    //
    // NEVER throws — by the time we get here the order has already been moved
    // and the activity record written, so a failure in this audit entry must
    // only log. Letting it escape meant a transition that HAD committed was
    // reported to the caller as a failure; the admin would then retry and get
    // "Illegal state transition" because the order had already advanced.
    //
    // Note this write cannot currently succeed from a client AT ALL:
    // firestore.rules has `match /adminActions/{actionId} { allow write: if
    // false; }`, which denies admins too, so every admin transition takes this
    // catch. Do NOT "clean up" the try/catch — until adminActions is written
    // server-side (or the rule is deliberately changed), removing it re-breaks
    // every admin-driven order transition.
    if (role === 'admin') {
      try {
        const adminActionsColRef = collection(db, 'adminActions');
        const adminActionId = `adm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        await addDoc(adminActionsColRef, {
          id: adminActionId,
          orderId: order.id,
          action: action,
          adminId: currentUser.id,
          adminName: currentUser.name || 'System Administrator',
          timestamp: Timestamp.now(),
          details: `Transitioned order from ${fromStatus} to ${toStatus} via action: ${action}`
            + (trimmedNote ? ` — note: ${trimmedNote}` : '')
        });
      } catch (auditError: any) {
        console.warn(
          `[orderWorkflow] adminActions audit write failed for order ${order.id} (${action}):`,
          auditError && auditError.message
        );
      }
    }

    // 4. Write the internal note to orders/{orderId}/adminNotes.
    //
    // Separate subcollection, not the activity record and not the order doc:
    // buyer and seller can read BOTH of those. adminNotes is isAdmin() on read
    // and write, so this is the only channel where "seller is dodging us" is
    // genuinely internal.
    //
    // NEVER throws — same contract as the adminActions audit write above. The
    // order has already moved and the activity record is already written; a
    // note is context for the next team member, not the operation, so a failed
    // write must only log. Letting it escape would report a transition that HAD
    // committed as a failure, and the retry would then fail as "Illegal state
    // transition" because the order had already advanced.
    if (trimmedNote) {
      try {
        const adminNotesColRef = collection(db, 'orders', order.id, 'adminNotes');
        await addDoc(adminNotesColRef, {
          note: trimmedNote,
          performedBy: currentUser.id,
          performedByName: currentUser.name || 'User',
          action: action,
          fromStatus: fromStatus,
          toStatus: toStatus,
          timestamp: Timestamp.now()
        });
      } catch (noteError: any) {
        console.warn(
          `[orderWorkflow] adminNotes write failed for order ${order.id} (${action}):`,
          noteError && noteError.message
        );
      }
    }

    // 5. Send Notifications (Buyer, Seller, Admin)
    const notificationsColRef = collection(db, 'notifications');
    const timestamp = Date.now();

    // Human-readable status labels for user-facing notifications — never leak
    // the raw code (e.g. `preparing_shipment`). Transition/audit fields above
    // keep the raw codes; only these display strings are humanised.
    const fromLabelAr = getOrderStatusChip(fromStatus, 'ar').label;
    const fromLabelEn = getOrderStatusChip(fromStatus, 'en').label;
    const toLabelAr = getOrderStatusChip(toStatus, 'ar').label;
    const toLabelEn = getOrderStatusChip(toStatus, 'en').label;

    const notifyUsers = [
      {
        userId: order.buyerId,
        titleAr: 'تحديث الطلب',
        titleEn: 'Order Update',
        descAr: `الطلب الخاص بك انتقل من حالة [${fromLabelAr}] إلى [${toLabelAr}]: ${activityMessageAr}`,
        descEn: `Your order transitioned from [${fromLabelEn}] to [${toLabelEn}]: ${activityMessageEn}`
      },
      {
        userId: order.sellerId,
        titleAr: 'تحديث الطلب المبيع',
        titleEn: 'Sold Order Update',
        descAr: `طلب البيع الخاص بك انتقل من حالة [${fromLabelAr}] إلى [${toLabelAr}]: ${activityMessageAr}`,
        descEn: `Your sold order transitioned from [${fromLabelEn}] to [${toLabelEn}]: ${activityMessageEn}`
      },
      {
        userId: 'admin',
        titleAr: 'إشعار النظام والمشرف',
        titleEn: 'Admin System Notification',
        descAr: `الطلب رقم ${order.id.substring(0, 8)} انتقل إلى [${toLabelAr}] بواسطة [${currentUser.name}]`,
        descEn: `Order #${order.id.substring(0, 8)} transitioned to [${toLabelEn}] by [${currentUser.name}]`
      }
    ];

    // NEVER throws — same contract as the audit write above. The order has
    // already moved; a notification is a courtesy, not the operation, so a
    // failed fan-out must only log. The catch sits INSIDE the loop so one
    // undeliverable recipient does not silently drop the other two.
    for (const notif of notifyUsers) {
      try {
        const notifId = `notif-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        await addDoc(notificationsColRef, {
          id: notifId,
          userId: notif.userId,
          title: isAdminUser(currentUser) ? notif.titleEn : notif.titleAr, // Bilingual choice
          titleAr: notif.titleAr,
          titleEn: notif.titleEn,
          description: isAdminUser(currentUser) ? notif.descEn : notif.descAr,
          descriptionAr: notif.descAr,
          descriptionEn: notif.descEn,
          type: (toStatus as string) === 'completed' ? 'win' : 'info',
          timestamp,
          read: false,
          orderId: order.id
        });
      } catch (notifyError: any) {
        console.warn(
          `[orderWorkflow] notification write failed for order ${order.id} -> ${notif.userId}:`,
          notifyError && notifyError.message
        );
      }
    }

  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, orderPath);
  }
}
