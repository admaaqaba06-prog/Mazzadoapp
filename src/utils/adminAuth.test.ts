import { describe, it, expect } from 'vitest';
import { isAdminUser, isAdminOrSeller } from './adminAuth';
import type { User } from '../types';

describe('isAdminUser', () => {
  it('returns true when isAdmin === true', () => {
    expect(isAdminUser({ role: 'user', isAdmin: true })).toBe(true);
  });

  it('returns true when role === "admin"', () => {
    expect(isAdminUser({ role: 'admin' })).toBe(true);
  });

  it('returns true when both role admin and isAdmin true', () => {
    expect(isAdminUser({ role: 'admin', isAdmin: true })).toBe(true);
  });

  it('returns false for role "user"', () => {
    expect(isAdminUser({ role: 'user' })).toBe(false);
  });

  it('returns false for role "seller"', () => {
    expect(isAdminUser({ role: 'seller' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isAdminUser(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isAdminUser(undefined)).toBe(false);
  });

  it('returns false for isAdmin explicitly false', () => {
    expect(isAdminUser({ role: 'user', isAdmin: false })).toBe(false);
  });

  it('SPOOF CASE: a user-writable email field does NOT grant admin', () => {
    // `email` on the user DOC is writable by that user; `role` is not. No
    // address is privileged anywhere any more, so this pins the general
    // property rather than one special case: isAdminUser reads role/isAdmin
    // and nothing else, whatever the email says.
    const spoofed = {
      email: 'someone@example.com',
      role: 'user',
    } as Pick<User, 'role' | 'isAdmin'> & { email: string };
    expect(isAdminUser(spoofed)).toBe(false);
  });
});

describe('isAdminOrSeller', () => {
  it('returns true for admin (role)', () => {
    expect(isAdminOrSeller({ role: 'admin' })).toBe(true);
  });

  it('returns true for admin (isAdmin flag) — admin implies seller access', () => {
    expect(isAdminOrSeller({ role: 'user', isAdmin: true })).toBe(true);
  });

  it('returns true for role "seller"', () => {
    expect(isAdminOrSeller({ role: 'seller' })).toBe(true);
  });

  it('returns true for isSeller === true', () => {
    expect(isAdminOrSeller({ role: 'user', isSeller: true })).toBe(true);
  });

  it('returns false for plain user', () => {
    expect(isAdminOrSeller({ role: 'user' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isAdminOrSeller(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isAdminOrSeller(undefined)).toBe(false);
  });
});
