/**
 * Admin member lookup — "who is this person and how do I call them?"
 *
 * The Members list is the admin's people directory, and until now it showed a
 * name, an email and a city, with no phone and no way to search. Finding one
 * account meant scrolling, and finding a phone number meant a script with a
 * service-account key — the same gap SellerContactReveal was built to close on
 * the listings side.
 *
 * ⚠️ THE LIST IS CAPPED. AppContext subscribes to `users` with
 * `orderBy('lastSeen','desc') limit(200)` so a per-bid `lastBidAt` write does
 * not re-run an O(N) merge in the admin's browser. So filtering the loaded
 * array searches the 200 most recently active accounts and NOTHING ELSE. For a
 * directory whose whole purpose is finding a specific person, that is the
 * silent-cap bug this codebase keeps meeting: a search that returns nothing
 * reads as "no such user", when it means "not in the last 200".
 *
 * `matchesMember` is therefore only the fast local pass. The surface that uses
 * it must say when the local set is capped and offer a server lookup — see
 * MembersSection.
 */

export interface MemberSearchable {
  name?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
  phone?: string | null;
  id?: string | null;
}

/**
 * Arabic letters that people type interchangeably. A directory search for
 * «احمد» must find «أحمد», and «عليه» must find «عليّه» — otherwise the admin
 * concludes the account does not exist because they typed a bare alef.
 */
function normalizeArabic(s: string): string {
  return s
    .replace(/[أإآٱ]/g, 'ا') // أ إ آ ٱ -> ا
    .replace(/ة/g, 'ه')                      // ة -> ه
    .replace(/[ى]/g, 'ي')                    // ى -> ي
    .replace(/[ً-ْٰ]/g, '')             // harakat
    .replace(/ـ/g, '');                           // tatweel
}

/** Arabic-Indic digits to Latin, so ٠٧٩ matches 079. */
function latinDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => {
    const c = d.charCodeAt(0);
    const base = c >= 0x06F0 ? 0x06F0 : 0x0660;
    return String(c - base);
  });
}

export function normalizeMemberTerm(term: string | null | undefined): string {
  return normalizeArabic(latinDigits((term ?? '').trim().toLowerCase()))
    .replace(/\s+/g, ' ');
}

/**
 * Just the digits of a phone, with Jordanian prefixes stripped so every way of
 * writing the same number collapses to one key.
 *
 *   +962790000000 · 00962790000000 · 0790000000 · 790000000  ->  790000000
 *
 * Without this, an admin reading "0790000000" off a WhatsApp message would find
 * nothing, because the account stores the E.164 form Firebase phone auth wrote.
 */
export function phoneKey(raw: string | null | undefined): string {
  const digits = latinDigits(String(raw ?? '')).replace(/\D/g, '');
  if (!digits) return '';
  let d = digits;
  if (d.startsWith('00962')) d = d.slice(5);
  else if (d.startsWith('962')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return d;
}

/** Every digit in the input, nothing stripped. Used for partial matching. */
function rawDigits(raw: string | null | undefined): string {
  return latinDigits(String(raw ?? '')).replace(/\D/g, '');
}

/**
 * True when the term is worth trying as a phone number.
 *
 * Three digits, not six. An admin matching a bank transfer usually has only the
 * last few digits, and a threshold that demanded a full number sent them back to
 * scrolling — which is the thing this search exists to replace. A short term
 * that is not a phone still falls through to the name/email match below, so a
 * loose threshold costs nothing.
 */
export function looksLikePhone(term: string | null | undefined): boolean {
  return rawDigits(term).length >= 3;
}

/**
 * Does this member match what the admin typed? A blank term matches everything.
 *
 * Name and email are substring matches, which is what a directory search should
 * do. A phone match is on the normalized digits, so partial numbers work too —
 * admins routinely have only the last few digits from a transfer reference.
 */
export function matchesMember(
  user: MemberSearchable | null | undefined,
  term: string | null | undefined,
): boolean {
  const q = normalizeMemberTerm(term);
  if (!q) return true;
  if (!user) return false;

  if (looksLikePhone(q)) {
    const key = phoneKey(q);      // national form — matches any way of writing it
    const raw = rawDigits(q);     // untouched digits — matches a partial tail
    const stored = [user.phoneNumber, user.phone].filter(Boolean) as string[];
    const hit = stored.some((s) => {
      // Both comparisons are needed. phoneKey collapses +962/00962/0 so a full
      // number typed in any form matches; rawDigits catches a partial like the
      // last four, where stripping a leading zero would corrupt the needle.
      const byKey = key !== '' && phoneKey(s).includes(key);
      const byRaw = raw.length >= 3 && rawDigits(s).includes(raw);
      return byKey || byRaw;
    });
    if (hit) return true;
    // Fall through: digits can also be part of a name or an id.
  }

  const haystack = normalizeMemberTerm(
    `${user.name ?? ''} ${user.email ?? ''} ${user.id ?? ''}`,
  );
  return haystack.includes(q);
}

/** The phone to display, preferring the verified auth field. */
export function memberPhone(user: MemberSearchable | null | undefined): string {
  const p = (user?.phoneNumber || user?.phone || '').trim();
  return p;
}
