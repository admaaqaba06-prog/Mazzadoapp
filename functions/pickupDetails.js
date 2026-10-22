'use strict';
/**
 * Seller pickup details — the half of the courier handover that did not exist.
 *
 * The buyer already nominates a delivery address and phone at the payment step
 * (`order.deliveryAddress` / `order.deliveryPhone`). The seller nominates
 * nothing, so a courier has a destination and no origin: `contactReveal` can
 * hand over the seller's ACCOUNT phone, but there is no pickup address anywhere
 * on the order, and a seller who signed up with Google has no account phone to
 * reveal in the first place.
 *
 * THE GATE IS `paymentVerified`, AND IT IS THE POINT.
 *
 * An order document is readable by the buyer, the seller and admins, and
 * Firestore has no field-level read control — a granted read returns every
 * field. So anything written here is visible to the BUYER the moment it lands.
 * Writing it only once payment is verified matches the gate `contactReveal`
 * already applies to the seller's phone, instead of quietly widening it.
 *
 * WHY THIS VALIDATES SERVER-SIDE WHEN THE BUYER'S EQUIVALENT DOES NOT.
 * `orderPaymentSubmit.js` persists `deliveryAddress` straight from the payload
 * (`deliveryAddress ?? o.deliveryAddress ?? null`) — the only validation on the
 * buyer's address lives in the browser. That is a gap, not a pattern to copy:
 * a crafted call can store an arbitrary object, of arbitrary size, as a
 * courier's instructions. Everything below is re-checked here, and the field
 * lengths are capped.
 *
 * Pure: the callable in index.js reads the order and passes it in, so every
 * branch is unit-tested without an emulator.
 */

function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Canonical governorate ids. MIRRORS src/utils/jordanCities.ts — the client is
 * the source of truth and `pickupDetails.parity.test.js` fails if the two
 * lists drift, which is the only way this copy stays honest.
 */
const CITY_IDS = [
  'amman', 'irbid', 'zarqa', 'balqa', 'mafraq', 'jerash',
  'ajloun', 'karak', 'tafilah', 'maan', 'aqaba', 'madaba',
];

/** Orders where there is no handover left to arrange. */
const CLOSED_STATUSES = ['cancelled', 'refunded'];

/** Caps, so a crafted call cannot store a novel as a courier instruction. */
const MAX = { area: 120, building: 80, notes: 200, name: 80 };

/** Map Arabic-Indic (٠-٩) and Persian (۰-۹) digits to ASCII. */
function normalizeDigits(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return code >= 0x0660 && code <= 0x0669
      ? String(code - 0x0660)
      : String(code - 0x06f0);
  });
}

const JO_MOBILE_RE = /^(?:\+962|00962|0)?(7[789]\d{6,7})$/;

/** Mirrors normalizeJordanMobile in cliqPayment.js. '' when unusable. */
function normalizeJordanMobile(raw) {
  if (typeof raw !== 'string') return '';
  const compact = normalizeDigits(raw).replace(/[\s\-()]/g, '');
  const m = JO_MOBILE_RE.exec(compact);
  if (!m) return '';
  const national = m[1];
  if (national.length !== 9) return '';
  return `+962${national}`;
}

function trimTo(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Build the pickup patch, or throw.
 *
 * @param {{order: object|null}} docs
 * @param {string} callerUid
 * @param {boolean} callerIsAdmin
 * @param {{governorate?: string, area?: string, building?: string, notes?: string, phone?: string, name?: string}} input
 * @returns {object} the fields to merge onto the order
 */
function resolvePickupSubmission(docs, callerUid, callerIsAdmin, input) {
  const order = docs && docs.order;
  if (!order) throw makeError('not-found', 'Order not found.');

  const isSeller = order.sellerId === callerUid;
  if (!isSeller && !callerIsAdmin) {
    throw makeError('permission-denied', 'Only the seller of this order can set its pickup details.');
  }

  // The gate. See the header: the buyer can read whatever lands here.
  if (order.paymentVerified !== true) {
    throw makeError(
      'failed-precondition',
      'Pickup details are collected once the payment is verified.',
    );
  }

  if (CLOSED_STATUSES.includes(order.status)) {
    throw makeError('failed-precondition', 'This order is closed — cancelled or refunded.');
  }

  const governorate = trimTo(input && input.governorate, 40).toLowerCase();
  if (!CITY_IDS.includes(governorate)) {
    throw makeError('invalid-argument', 'Pick the governorate the item is collected from.');
  }

  const area = trimTo(input && input.area, MAX.area);
  if (!area) {
    throw makeError('invalid-argument', 'The pickup area or street is required.');
  }

  const phone = normalizeJordanMobile(input && input.phone);
  if (!phone) {
    throw makeError('invalid-argument', 'A valid Jordanian mobile number is required for the courier.');
  }

  const address = { governorate, area };
  const building = trimTo(input && input.building, MAX.building);
  const notes = trimTo(input && input.notes, MAX.notes);
  if (building) address.building = building;
  if (notes) address.notes = notes;

  // The account name is the default; an override is allowed because the person
  // the courier meets is not always the account holder.
  const name = trimTo(input && input.name, MAX.name) || trimTo(order.sellerName, MAX.name);

  return {
    pickupAddress: address,
    pickupPhone: phone,
    pickupName: name || null,
    pickupSubmittedBy: callerUid,
  };
}

/** Is the order ready for a courier — both ends present? */
function isHandoverReady(order) {
  const o = order || {};
  const hasDrop =
    o.deliveryAddress && typeof o.deliveryAddress.governorate === 'string' &&
    typeof o.deliveryPhone === 'string' && o.deliveryPhone.trim() !== '';
  const hasPickup =
    o.pickupAddress && typeof o.pickupAddress.governorate === 'string' &&
    typeof o.pickupPhone === 'string' && o.pickupPhone.trim() !== '';
  return Boolean(hasDrop && hasPickup);
}

module.exports = {
  CITY_IDS,
  MAX,
  normalizeDigits,
  normalizeJordanMobile,
  resolvePickupSubmission,
  isHandoverReady,
};
