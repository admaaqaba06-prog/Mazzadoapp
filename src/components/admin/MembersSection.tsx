import React, { useMemo, useState } from 'react';
import { Users, Search, Phone } from 'lucide-react';
import { matchesMember, memberPhone } from '../../utils/memberSearch';
import { AdminListSkeleton, EmptyState } from '../FeedbackStates';
import AdminRoleToggle from './AdminRoleToggle';

/**
 * Members (reference tab): the account-privilege moderation list —
 * behavior-preserving extraction of the former `users` tab body. Purely
 * presentational; the three moderation actions invoke the injected handlers
 * verbatim: `onVerifySeller` (=`verifySeller`), `onBan` (=`banUser`),
 * `onUnban` (=`unbanUser`). Creates NO Firestore listeners.
 */
export interface MembersSectionProps {
  isAr: boolean;
  isLoading: boolean;
  users: any[];
  onVerifySeller: (userId: string) => void; // verifySeller
  onBan: (userId: string) => void; // banUser
  onUnban: (userId: string) => void; // unbanUser
  /** The acting admin's own uid + email — used to mark their own account(s) as
   *  "You" (they can't ban themselves; the guard blocks it), so the Ban action
   *  isn't offered on a row that would just error. */
  currentUserId?: string;
  currentUserEmail?: string;
  /** True account total from getCountFromServer. The live list is capped at 200
   *  by lastSeen, so without this a search that finds nothing reads as "no such
   *  user" when it means "not in the last 200". */
  totalAccounts?: number | null;
}

export const MembersSection: React.FC<MembersSectionProps> = ({
  isAr,
  isLoading,
  users,
  onVerifySeller,
  onBan,
  onUnban,
  currentUserId,
  currentUserEmail,
  totalAccounts,
}) => {
  const [term, setTerm] = useState('');
  const shown = useMemo(() => users.filter((u) => matchesMember(u, term)), [users, term]);
  const capped = typeof totalAccounts === 'number' && totalAccounts > users.length;
  const myEmail = (currentUserEmail || '').trim().toLowerCase();
  return (
    <div className="space-y-4">
      <div className="bg-surface-raised border border-line p-5 rounded-2xl shadow-xs">
        <h3 className="text-xs font-extrabold text-fg flex items-center gap-2">
          <Users className="w-4 h-4 text-[#FF6B00]" />
          {isAr ? 'سجل الأعضاء وإدارة الصلاحيات' : 'MEMBERS PRIVILEGE CONTROL'}
        </h3>
        <p className="text-[11px] text-fg-muted mt-1">
          {isAr ? 'عاين حسابات المشتركين وقم بتوثيق حساباتهم كبائعين معتمدين أو فرض حظر مؤقت للمخالفين.' : 'Verify user identities to certify authentic merchants or apply bidding limitations.'}
        </p>

        {/* Search by name, phone, email or account id. Phone matching is on
            normalized digits, so a number copied in any format finds the
            account — see utils/memberSearch.ts. */}
        <div className="relative mt-3">
          <Search className="w-3.5 h-3.5 text-fg-muted absolute top-1/2 -translate-y-1/2 start-3 pointer-events-none" />
          <input
            type="search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={isAr ? 'ابحث بالاسم أو رقم الهاتف أو البريد…' : 'Search by name, phone or email…'}
            aria-label={isAr ? 'ابحث في الأعضاء' : 'Search members'}
            className="w-full bg-surface-sunken border border-line rounded-xl ps-9 pe-3 py-2.5 text-xs font-bold text-fg placeholder:text-fg-muted focus:outline-none focus:border-[#FF6B00] transition-colors"
          />
        </div>

        {/* THE CAP, SAID OUT LOUD. The live list is the 200 most recently active
            accounts. A directory search that silently omits everyone else reads
            as "no such user" — the same defect as the admin auction cap. */}
        {capped && (
          <p className="text-[10px] text-amber-700 font-bold mt-2 leading-snug">
            {isAr
              ? `يعرض ${users.length} من أصل ${totalAccounts} حساباً — الأحدث نشاطاً. إذا لم تجد الشخص، فقد يكون خارج هذه القائمة.`
              : `Showing ${users.length} of ${totalAccounts} accounts — the most recently active. If someone is missing, they are outside this window.`}
          </p>
        )}
      </div>

      <div className="bg-surface-raised border border-line rounded-2xl divide-y divide-line overflow-hidden shadow-xs">
        {isLoading ? (
          <div className="p-4">
            <AdminListSkeleton />
          </div>
        ) : shown.length > 0 ? (
          shown.map((profile) => {
          const isOwnAccount =
            profile.id === currentUserId ||
            (!!myEmail && (profile.email || '').trim().toLowerCase() === myEmail);
          return (
          <div key={profile.id} className="p-4 flex justify-between items-center gap-4 transition-colors hover:bg-surface-sunken/40">
            <div className="flex items-center gap-3">
              <img
                src={profile.avatar}
                alt="Avatar"
                className="w-10 h-10 rounded-xl object-cover shrink-0 border border-line shadow-xs"
              />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="font-extrabold text-xs text-fg leading-none">{profile.name}</h4>
                  {profile.role === 'admin' && (
                    <span className="bg-purple-50 text-purple-700 border border-purple-100 text-[8.5px] font-black px-1.5 py-0.5 rounded font-mono">
                      {isAr ? 'إدارة' : 'ADMIN'}
                    </span>
                  )}
                  {profile.isVerified && (
                    <span className="bg-emerald-50 text-emerald-800 border border-emerald-100 text-[8.5px] font-black px-1.5 py-0.5 rounded">
                      {isAr ? 'موثق ✓' : 'VERIFIED ✓'}
                    </span>
                  )}
                </div>
                {/* The phone is the point of this directory — an admin needing
                    to call someone had to run a script with a service-account
                    key. Admins already hold full read on `users` by rule, so
                    this reveals nothing the browser did not already have. */}
                {memberPhone(profile) ? (
                  <a
                    href={`tel:${memberPhone(profile)}`}
                    dir="ltr"
                    className="inline-flex items-center gap-1 text-[11px] font-mono font-black text-[#FF6B00] mt-1 hover:underline"
                  >
                    <Phone className="w-3 h-3 shrink-0" />
                    {memberPhone(profile)}
                  </a>
                ) : (
                  <p className="text-[10px] text-fg-muted mt-1 font-bold">
                    {isAr ? 'لا يوجد رقم على الحساب' : 'No phone on this account'}
                  </p>
                )}
                {/* `city` is genuinely optional — it is asked for at the win, not
                    at signup. It said "Jordan" when unknown, which is a fact the
                    account does not carry. Omitted instead. */}
                <p className="text-[10px] text-fg-muted mt-0.5 font-mono truncate">
                  {[profile.email, profile.city].filter(Boolean).join(' • ')}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {profile.role === 'user' && !profile.isVerified && (
                <button
                  onClick={() => onVerifySeller(profile.id)}
                  className="bg-emerald-600 font-extrabold hover:bg-emerald-700 text-white text-[10px] px-3 py-1.5 rounded-xl transition-all shadow-xs"
                >
                  {isAr ? 'توثيق العضوية' : 'VERIFY'}
                </button>
              )}

              {/* STATUS pill (state, not clickable) — removes the old ambiguity
                  where the "BAN" action button read like a status. */}
              <span
                className={`inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-lg border select-none ${
                  profile.isBlocked
                    ? 'bg-red-50 text-red-600 border-red-100'
                    : 'bg-emerald-50 text-emerald-700 border-emerald-100'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${profile.isBlocked ? 'bg-red-500' : 'bg-emerald-500'}`} />
                {/* Grant or revoke admin. The callable re-checks the caller
                  server side, so rendering this is a button, not authorisation. */}
              <AdminRoleToggle
                user={profile}
                currentUserId={currentUserId}
                isAr={isAr}
              />

              {profile.isBlocked ? (isAr ? 'محظور' : 'Banned') : (isAr ? 'نشط' : 'Active')}
              </span>

              {/* ACTION button (verb) — separate from the status pill. A banned
                  account can always be unbanned (incl. your own). Your own ACTIVE
                  account shows a muted "You" chip instead of a Ban button you
                  can't use (the self-ban guard would just reject it). */}
              {profile.isBlocked ? (
                <button
                  onClick={() => onUnban(profile.id)}
                  className="bg-emerald-600 text-white text-[10px] font-extrabold px-3 py-1.5 rounded-xl hover:bg-emerald-700 transition-all shadow-xs cursor-pointer"
                >
                  {isAr ? 'فك الحظر' : 'Unban'}
                </button>
              ) : isOwnAccount ? (
                <span className="text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-lg bg-surface-sunken text-fg-muted border border-line select-none">
                  {isAr ? 'أنت' : 'You'}
                </span>
              ) : (
                <button
                  onClick={() => onBan(profile.id)}
                  className="bg-surface-raised text-red-600 border border-red-200 text-[10px] font-bold px-3 py-1.5 rounded-xl hover:bg-red-50 transition-all cursor-pointer"
                >
                  {isAr ? 'حظر' : 'Ban'}
                </button>
              )}
            </div>
          </div>
          );
        })
      ) : (
        <EmptyState
          title={term.trim()
            ? (isAr ? 'لا نتائج ضمن هذه القائمة' : 'No match in this list')
            : (isAr ? 'لا يوجد أعضاء بعد' : 'No users yet')}
          description={
            term.trim()
              // Never say "no such user" — the list is the 200 most recently
              // active accounts, so an absent person may simply be older.
              ? (capped
                  ? (isAr
                      ? `لم نجد أحداً ضمن أحدث ${users.length} حساباً — الشخص قد يكون خارج هذه القائمة.`
                      : `No match among the ${users.length} most recently active accounts — they may be outside this window.`)
                  : (isAr ? 'لا يوجد حساب مطابق.' : 'No account matches that search.'))
              : (isAr ? 'لم يسجل أي مستخدمين بالمنصة بعد.' : 'No users have registered accounts on the network.')
          }
          language={isAr ? 'ar' : 'en'}
        />
      )}
    </div>

    </div>
  );
};

export default MembersSection;
