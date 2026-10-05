/**
 * The seller's own details form.
 *
 * WHY IT EXISTS. `sellerProfiles` is `allow read: if true` — a public shopfront
 * — and until now the seller had no way to edit any of it. Activation seeded a
 * store name, an about line, and a LOCATION constant of «عمان، الأردن», and the
 * seller lived with whatever it chose. Every seller on the platform was
 * published as being in Amman.
 *
 * So this is not only a delivery prerequisite. It is the first surface where a
 * seller states who they are and where they are, instead of the system deciding
 * on their behalf and publishing it.
 *
 * GOVERNORATE, NOT FREE TEXT. `location` was a free string, which cannot be
 * priced, sorted or matched against a buyer's city. It is now a governorate id
 * from JORDAN_GOVERNORATES — the same twelve values `users.city` already uses
 * for delivery addresses — so a seller's origin and a buyer's destination are
 * finally the same kind of thing. Legacy free-text values still render (see
 * SellerProfileModal), they just cannot be chosen any more.
 *
 * Nothing here writes. Validation and normalisation only, so it is testable and
 * so the same rules can run again anywhere else that edits a profile.
 */
import { CITY_IDS } from './jordanCities';

export interface SellerProfileFormValues {
  storeName: string;
  bio: string;
  /** A JORDAN_GOVERNORATES id, or '' when the seller has not said. */
  location: string;
}

export interface SellerProfileFormErrors {
  storeName?: 'required' | 'too_short' | 'too_long';
  bio?: 'too_long';
  location?: 'invalid';
}

export const STORE_NAME_MIN = 2;
export const STORE_NAME_MAX = 60;
export const BIO_MAX = 300;

/** Trim and collapse runs of whitespace; never changes the characters. */
function tidy(s: unknown): string {
  return typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '';
}

export function normalizeSellerProfileForm(
  raw: Partial<SellerProfileFormValues> | null | undefined,
): SellerProfileFormValues {
  return {
    storeName: tidy(raw?.storeName),
    // Bio keeps its line breaks — a shopfront blurb is allowed paragraphs.
    bio: typeof raw?.bio === 'string' ? raw.bio.trim() : '',
    location: tidy(raw?.location).toLowerCase(),
  };
}

/**
 * Empty object means valid.
 *
 * LOCATION IS OPTIONAL, deliberately. Making it required would block a seller
 * from fixing their store name, and would push whoever wanted to skip it into
 * picking any governorate to get past the form — which puts a wrong origin in
 * the database and is worse than an absent one. Delivery pricing asks for it at
 * the point it is needed instead.
 */
export function validateSellerProfileForm(
  values: SellerProfileFormValues,
): SellerProfileFormErrors {
  const errors: SellerProfileFormErrors = {};

  if (!values.storeName) errors.storeName = 'required';
  else if (values.storeName.length < STORE_NAME_MIN) errors.storeName = 'too_short';
  else if (values.storeName.length > STORE_NAME_MAX) errors.storeName = 'too_long';

  if (values.bio.length > BIO_MAX) errors.bio = 'too_long';

  if (values.location !== '' && !CITY_IDS.includes(values.location)) {
    errors.location = 'invalid';
  }

  return errors;
}

export function isSellerProfileFormValid(values: SellerProfileFormValues): boolean {
  return Object.keys(validateSellerProfileForm(values)).length === 0;
}

/**
 * The fields to persist. Returns only what actually CHANGED, so saving a store
 * name does not rewrite `location` — a merge that always writes every field
 * turns "I edited my bio" into "I confirmed my location", which is exactly the
 * kind of implied fact this form exists to stop.
 */
export function changedSellerProfileFields(
  current: Partial<SellerProfileFormValues> | null | undefined,
  next: SellerProfileFormValues,
): Partial<SellerProfileFormValues> {
  const before = normalizeSellerProfileForm(current);
  const patch: Partial<SellerProfileFormValues> = {};
  if (before.storeName !== next.storeName) patch.storeName = next.storeName;
  if (before.bio !== next.bio) patch.bio = next.bio;
  if (before.location !== next.location) patch.location = next.location;
  return patch;
}

/**
 * The seeded value activation used to write. Treated as "not stated" so an
 * existing seller sees an empty picker rather than a pre-selected Amman they
 * never chose — and so saving does not silently confirm it.
 */
const SEEDED_LOCATIONS = new Set(['عمان، الأردن', 'amman, jordan']);

export function isSeededLocation(raw: string | null | undefined): boolean {
  return SEEDED_LOCATIONS.has(tidy(raw).toLowerCase());
}
