// The seller's own details form.
//
// The behaviours worth pinning are the ones that keep a PUBLIC profile honest:
// a governorate must be a real one, an untouched field must not be rewritten,
// and the location the system invented must never look like something the
// seller chose.

import { describe, it, expect } from 'vitest';
import {
  normalizeSellerProfileForm,
  validateSellerProfileForm,
  isSellerProfileFormValid,
  changedSellerProfileFields,
  isSeededLocation,
  STORE_NAME_MAX,
  BIO_MAX,
} from './sellerProfileForm';
import { CITY_IDS } from './jordanCities';

const ok = { storeName: 'متجر أحمد', bio: 'أهلاً بكم', location: 'irbid' };

describe('normalize', () => {
  it('trims and collapses whitespace in the store name', () => {
    expect(normalizeSellerProfileForm({ storeName: '  متجر   أحمد  ' }).storeName).toBe('متجر أحمد');
  });

  it('keeps line breaks in the bio — a shopfront blurb may have paragraphs', () => {
    const bio = 'سطر أول\n\nسطر ثانٍ';
    expect(normalizeSellerProfileForm({ bio }).bio).toBe(bio);
  });

  it('lowercases the governorate id so casing cannot create a second value', () => {
    expect(normalizeSellerProfileForm({ location: 'IRBID' }).location).toBe('irbid');
  });

  it('survives missing input', () => {
    expect(normalizeSellerProfileForm(null)).toEqual({ storeName: '', bio: '', location: '' });
  });
});

describe('validate', () => {
  it('accepts a complete form', () => {
    expect(validateSellerProfileForm(ok)).toEqual({});
    expect(isSellerProfileFormValid(ok)).toBe(true);
  });

  it('requires a store name — it is the shopfront title', () => {
    expect(validateSellerProfileForm({ ...ok, storeName: '' }).storeName).toBe('required');
    expect(validateSellerProfileForm({ ...ok, storeName: 'م' }).storeName).toBe('too_short');
    expect(validateSellerProfileForm({ ...ok, storeName: 'م'.repeat(STORE_NAME_MAX + 1) }).storeName).toBe('too_long');
  });

  it('caps the bio', () => {
    expect(validateSellerProfileForm({ ...ok, bio: 'x'.repeat(BIO_MAX) })).toEqual({});
    expect(validateSellerProfileForm({ ...ok, bio: 'x'.repeat(BIO_MAX + 1) }).bio).toBe('too_long');
  });

  it('accepts every real governorate and nothing else', () => {
    for (const id of CITY_IDS) {
      expect(validateSellerProfileForm({ ...ok, location: id }), `rejected ${id}`).toEqual({});
    }
    // Free text is no longer selectable — it cannot be priced or matched.
    expect(validateSellerProfileForm({ ...ok, location: 'عمان، الأردن' }).location).toBe('invalid');
    expect(validateSellerProfileForm({ ...ok, location: 'Amman' }).location).toBe('invalid');
  });

  it('LEAVES LOCATION OPTIONAL on purpose', () => {
    // Requiring it would block a seller from fixing their store name, and would
    // push anyone wanting to skip it into picking any governorate — a wrong
    // origin in the database is worse than an absent one.
    expect(validateSellerProfileForm({ ...ok, location: '' })).toEqual({});
  });
});

describe('changedSellerProfileFields — never write what was not edited', () => {
  it('returns only the fields that actually changed', () => {
    const patch = changedSellerProfileFields(ok, { ...ok, bio: 'نص جديد' });
    expect(patch).toEqual({ bio: 'نص جديد' });
  });

  it('is empty when nothing changed, so saving twice writes nothing', () => {
    expect(changedSellerProfileFields(ok, ok)).toEqual({});
  });

  it('does NOT rewrite location when only the bio was edited', () => {
    // A merge that always writes every field turns "I edited my bio" into
    // "I confirmed my location" — the implied fact this form exists to stop.
    const patch = changedSellerProfileFields(
      { storeName: 'م', bio: 'قديم', location: '' },
      { storeName: 'م', bio: 'جديد', location: '' },
    );
    expect(patch).not.toHaveProperty('location');
  });

  it('compares against the NORMALIZED current value, so whitespace is not a change', () => {
    expect(changedSellerProfileFields({ storeName: '  متجر أحمد ' }, { ...ok, storeName: 'متجر أحمد', bio: '', location: '' }))
      .not.toHaveProperty('storeName');
  });
});

describe('isSeededLocation — the value the system invented', () => {
  it('recognises what activation used to stamp on every seller', () => {
    expect(isSeededLocation('عمان، الأردن')).toBe(true);
    expect(isSeededLocation('Amman, Jordan')).toBe(true);
    expect(isSeededLocation('  amman, jordan  ')).toBe(true);
  });

  it('does not swallow a real answer that happens to be Amman', () => {
    // A seller who genuinely picks Amman stores the id 'amman'. That is a
    // stated fact and must never be treated as the seeded placeholder.
    expect(isSeededLocation('amman')).toBe(false);
    expect(isSeededLocation('irbid')).toBe(false);
    expect(isSeededLocation('')).toBe(false);
  });
});
