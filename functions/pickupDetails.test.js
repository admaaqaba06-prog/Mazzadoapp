// Seller pickup details — the gate, the ownership check, and the validation
// the buyer's equivalent does not have.

import { describe, it, expect } from 'vitest';
import {
  CITY_IDS,
  MAX,
  normalizeJordanMobile,
  resolvePickupSubmission,
  isHandoverReady,
} from './pickupDetails.js';

const SELLER = 'seller-uid';
const BUYER = 'buyer-uid';

const okInput = {
  governorate: 'amman',
  area: 'Jabal Amman, 3rd circle',
  building: 'Bldg 12, flr 2',
  notes: 'Shop next to the pharmacy',
  phone: '0791234567',
  name: 'Mazzado Seller',
};

const paidOrder = (over = {}) => ({
  sellerId: SELLER,
  buyerId: BUYER,
  sellerName: 'Account Name',
  status: 'paid',
  paymentVerified: true,
  ...over,
});

describe('the paymentVerified gate', () => {
  // An order doc is readable by the buyer, the seller AND admins, and Firestore
  // has no field-level read control — whatever lands here is visible to the
  // buyer immediately. Writing it only after verification matches the gate
  // contactReveal already applies to the seller's phone.
  it('refuses before the payment is verified', () => {
    expect(() =>
      resolvePickupSubmission({ order: paidOrder({ paymentVerified: false }) }, SELLER, false, okInput),
    ).toThrow(/once the payment is verified/);
  });

  it('refuses when the flag is simply absent, not just false', () => {
    const order = paidOrder();
    delete order.paymentVerified;
    expect(() => resolvePickupSubmission({ order }, SELLER, false, okInput)).toThrow(
      /once the payment is verified/,
    );
  });

  it('allows it once verified', () => {
    const patch = resolvePickupSubmission({ order: paidOrder() }, SELLER, false, okInput);
    expect(patch.pickupPhone).toBe('+962791234567');
  });
});

describe('who may submit', () => {
  it('refuses the buyer — it is not their end of the handover', () => {
    expect(() => resolvePickupSubmission({ order: paidOrder() }, BUYER, false, okInput)).toThrow(
      /Only the seller/,
    );
  });

  it('refuses a stranger', () => {
    expect(() => resolvePickupSubmission({ order: paidOrder() }, 'someone-else', false, okInput)).toThrow(
      /Only the seller/,
    );
  });

  it('allows an admin, because CS fills this in by phone', () => {
    const patch = resolvePickupSubmission({ order: paidOrder() }, 'admin-uid', true, okInput);
    expect(patch.pickupSubmittedBy).toBe('admin-uid');
  });

  it('refuses a missing order rather than inventing one', () => {
    expect(() => resolvePickupSubmission({ order: null }, SELLER, false, okInput)).toThrow(/not found/i);
  });
});

describe('closed orders', () => {
  for (const status of ['cancelled', 'refunded']) {
    it(`refuses a ${status} order — there is no handover left`, () => {
      expect(() =>
        resolvePickupSubmission({ order: paidOrder({ status }) }, SELLER, false, okInput),
      ).toThrow(/closed/);
    });
  }
});

describe('validation that the buyer-side equivalent does NOT do server-side', () => {
  // orderPaymentSubmit.js persists deliveryAddress straight from the payload.
  // These assertions exist so the seller side is not built the same way.
  it('rejects a governorate that is not on the canonical list', () => {
    expect(() =>
      resolvePickupSubmission({ order: paidOrder() }, SELLER, false, { ...okInput, governorate: 'atlantis' }),
    ).toThrow(/governorate/);
  });

  it('accepts every canonical governorate id', () => {
    for (const id of CITY_IDS) {
      const patch = resolvePickupSubmission({ order: paidOrder() }, SELLER, false, { ...okInput, governorate: id });
      expect(patch.pickupAddress.governorate).toBe(id);
    }
  });

  it('requires an area', () => {
    expect(() =>
      resolvePickupSubmission({ order: paidOrder() }, SELLER, false, { ...okInput, area: '   ' }),
    ).toThrow(/area/);
  });

  it('caps every free-text field instead of storing whatever arrives', () => {
    const patch = resolvePickupSubmission({ order: paidOrder() }, SELLER, false, {
      ...okInput,
      area: 'A'.repeat(5000),
      building: 'B'.repeat(5000),
      notes: 'C'.repeat(5000),
      name: 'D'.repeat(5000),
    });
    expect(patch.pickupAddress.area).toHaveLength(MAX.area);
    expect(patch.pickupAddress.building).toHaveLength(MAX.building);
    expect(patch.pickupAddress.notes).toHaveLength(MAX.notes);
    expect(patch.pickupName).toHaveLength(MAX.name);
  });

  it('drops empty optionals rather than storing blank keys', () => {
    const patch = resolvePickupSubmission({ order: paidOrder() }, SELLER, false, {
      ...okInput,
      building: '  ',
      notes: '',
    });
    expect(patch.pickupAddress).toEqual({ governorate: 'amman', area: okInput.area });
  });
});

describe('the courier needs a number that actually dials', () => {
  it('normalises every local form to E.164', () => {
    for (const raw of ['0791234567', '791234567', '+962791234567', '00962791234567', '079 123 4567', '079-123-4567']) {
      expect(normalizeJordanMobile(raw)).toBe('+962791234567');
    }
  });

  it('accepts Arabic-Indic digits — they come straight off a phone keyboard', () => {
    expect(normalizeJordanMobile('٠٧٩١٢٣٤٥٦٧')).toBe('+962791234567');
  });

  it('rejects anything that is not a Jordanian mobile', () => {
    for (const raw of ['', '06123456', '071234567', '+9705551234', 'not a phone', '07912345678901']) {
      expect(normalizeJordanMobile(raw)).toBe('');
    }
    expect(() =>
      resolvePickupSubmission({ order: paidOrder() }, SELLER, false, { ...okInput, phone: '06123456' }),
    ).toThrow(/mobile/);
  });
});

describe('the name', () => {
  it('falls back to the account name when none is given', () => {
    const patch = resolvePickupSubmission({ order: paidOrder() }, SELLER, false, { ...okInput, name: '' });
    expect(patch.pickupName).toBe('Account Name');
  });

  it('allows an override — the person the courier meets is not always the account holder', () => {
    const patch = resolvePickupSubmission({ order: paidOrder() }, SELLER, false, { ...okInput, name: 'Warehouse desk' });
    expect(patch.pickupName).toBe('Warehouse desk');
  });
});

describe('isHandoverReady', () => {
  const dropoff = { deliveryAddress: { governorate: 'irbid' }, deliveryPhone: '+962790000000' };
  const pickup = { pickupAddress: { governorate: 'amman' }, pickupPhone: '+962791234567' };

  it('is false with only one end', () => {
    expect(isHandoverReady({ ...dropoff })).toBe(false);
    expect(isHandoverReady({ ...pickup })).toBe(false);
    expect(isHandoverReady({})).toBe(false);
    expect(isHandoverReady(null)).toBe(false);
  });

  it('is true only when a courier has both an origin and a destination', () => {
    expect(isHandoverReady({ ...dropoff, ...pickup })).toBe(true);
  });
});
