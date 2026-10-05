// Admin member lookup matching.
//
// The cases here are the ones an admin actually hits: a phone number copied off
// a WhatsApp message in a different format than Firebase stored it, an Arabic
// name typed with a bare alef, and Arabic-Indic digits from a phone keyboard.
// Each of those silently returning "no such user" is the failure this guards.

import { describe, it, expect } from 'vitest';
import {
  matchesMember, phoneKey, normalizeMemberTerm, looksLikePhone, memberPhone,
} from './memberSearch';

const USER = {
  id: 'uid_1',
  name: 'أحمد الخطيب',
  email: 'ahmad@example.com',
  phoneNumber: '+962790000123',
};

describe('phoneKey — every way of writing one number collapses to one key', () => {
  it('strips Jordanian prefixes and punctuation', () => {
    for (const form of [
      '+962790000123', '00962790000123', '0790000123', '790000123',
      '+962 79 000 0123', '079-000-0123', '(079) 000 0123',
    ]) {
      expect(phoneKey(form), `failed on ${form}`).toBe('790000123');
    }
  });

  it('accepts Arabic-Indic digits', () => {
    expect(phoneKey('٠٧٩٠٠٠٠١٢٣')).toBe('790000123');
  });

  it('returns empty for junk rather than a misleading key', () => {
    expect(phoneKey('')).toBe('');
    expect(phoneKey(null)).toBe('');
    expect(phoneKey('abc')).toBe('');
  });
});

describe('matchesMember — phone', () => {
  it('finds a user by the number typed in ANY format', () => {
    // The whole point: the admin has 0790000123, Firebase stored +962790000123.
    for (const typed of ['+962790000123', '0790000123', '790000123', '٠٧٩٠٠٠٠١٢٣']) {
      expect(matchesMember(USER, typed), `failed on ${typed}`).toBe(true);
    }
  });

  it('matches a partial number — admins often have only the last digits', () => {
    expect(matchesMember(USER, '0123')).toBe(true);
    expect(matchesMember(USER, '000123')).toBe(true);
  });

  it('does not match a different number', () => {
    expect(matchesMember(USER, '0791111111')).toBe(false);
  });

  it('reads the legacy `phone` field too', () => {
    expect(matchesMember({ phone: '0790000123' }, '+962790000123')).toBe(true);
  });
});

describe('matchesMember — Arabic names', () => {
  it('finds أحمد when the admin types a bare alef', () => {
    expect(matchesMember(USER, 'احمد')).toBe(true);
  });

  it('ignores harakat and tatweel', () => {
    expect(matchesMember({ name: 'عليّ' }, 'علي')).toBe(true);
    expect(matchesMember({ name: 'محـــمد' }, 'محمد')).toBe(true);
  });

  it('treats ة and ه as the same letter', () => {
    expect(matchesMember({ name: 'فاطمة' }, 'فاطمه')).toBe(true);
  });

  it('treats ى and ي as the same letter', () => {
    expect(matchesMember({ name: 'يحيى' }, 'يحيي')).toBe(true);
  });
});

describe('matchesMember — email, id, and the empty term', () => {
  it('matches on email substring', () => {
    expect(matchesMember(USER, 'ahmad@')).toBe(true);
    expect(matchesMember(USER, 'EXAMPLE.COM')).toBe(true);
  });

  it('matches on the account id, which is what error reports quote', () => {
    expect(matchesMember(USER, 'uid_1')).toBe(true);
  });

  it('a blank term matches everything, so the list renders unfiltered', () => {
    expect(matchesMember(USER, '')).toBe(true);
    expect(matchesMember(USER, '   ')).toBe(true);
    expect(matchesMember(USER, null)).toBe(true);
  });

  it('a missing user never matches a real term', () => {
    expect(matchesMember(null, 'ahmad')).toBe(false);
  });
});

describe('looksLikePhone', () => {
  it('triggers from three digits, so a partial tail still searches phones', () => {
    // Deliberately loose. An admin matching a bank transfer often has only the
    // last few digits; demanding a full number sent them back to scrolling,
    // which is what this search replaces. A short non-phone term costs nothing
    // because it falls through to the name/email match anyway.
    expect(looksLikePhone('123')).toBe(true);
    expect(looksLikePhone('079000')).toBe(true);
    expect(looksLikePhone('0790000123')).toBe(true);
  });

  it('is false for text with no digits', () => {
    expect(looksLikePhone('أحمد')).toBe(false);
    expect(looksLikePhone('ahmad')).toBe(false);
    expect(looksLikePhone('')).toBe(false);
  });
});

describe('memberPhone', () => {
  it('prefers the verified auth field over the legacy one', () => {
    expect(memberPhone({ phoneNumber: '+962790000123', phone: '0000' })).toBe('+962790000123');
  });

  it('returns empty rather than a placeholder when there is no phone', () => {
    // A directory that invents "Jordan" or "—" teaches an admin to trust a
    // field that is not there. Empty means the caller decides what to render.
    expect(memberPhone({})).toBe('');
    expect(memberPhone(null)).toBe('');
  });
});

describe('normalizeMemberTerm', () => {
  it('collapses whitespace and lowercases', () => {
    expect(normalizeMemberTerm('  Ahmad   Khatib ')).toBe('ahmad khatib');
  });
});
