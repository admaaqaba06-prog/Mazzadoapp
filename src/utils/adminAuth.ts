import type { User } from '../types';

/**
 * Server-verified admin check.
 *
 * `role` and `isAdmin` are protected keys in firestore.rules (not
 * user-writable) and are derived from the auth TOKEN email during
 * hydration — unlike the user doc's `email` field, which any user can
 * write. Never gate admin UI on `user.email`.
 */
/**
 * `Partial`, because callers pass raw `users` documents where `role` may simply
 * be absent — an account that has never been assigned one. The body already
 * handles undefined; requiring the field only forced casts at the call sites,
 * and a cast is how a genuinely wrong shape gets in.
 */
export function isAdminUser(user?: Partial<Pick<User, 'role' | 'isAdmin'>> | null): boolean {
  return !!user && (user.isAdmin === true || user.role === 'admin');
}

/**
 * Seller-or-above check (admin implies seller access).
 */
export function isAdminOrSeller(
  user?: Pick<User, 'role' | 'isAdmin' | 'isSeller'> | null
): boolean {
  return !!user && (isAdminUser(user) || user.role === 'seller' || user.isSeller === true);
}
