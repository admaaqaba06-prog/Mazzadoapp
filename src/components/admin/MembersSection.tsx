import React from 'react';
import { Users } from 'lucide-react';
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
}) => {
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
      </div>

      <div className="bg-surface-raised border border-line rounded-2xl divide-y divide-line overflow-hidden shadow-xs">
        {isLoading ? (
          <div className="p-4">
            <AdminListSkeleton />
          </div>
        ) : users.length > 0 ? (
          users.map((profile) => {
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
                <p className="text-[10px] text-fg-muted mt-1 font-mono">
                  {profile.email} • {profile.city || 'Jordan'}
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
          title={isAr ? 'لا يوجد أعضاء بعد' : 'No users yet'}
          description={isAr ? 'لم يسجل أي مستخدمين بالمنصة بعد.' : 'No users have registered accounts on the network.'}
          language={isAr ? 'ar' : 'en'}
        />
      )}
    </div>

    </div>
  );
};

export default MembersSection;
