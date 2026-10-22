import React, { useState } from 'react';
import { ShieldCheck, ShieldOff, Loader2, AlertCircle } from 'lucide-react';
import { getCallableFunction } from '../../services/firebase';
import { isAdminUser } from '../../utils/adminAuth';
import type { User } from '../../types';

/**
 * Grant or revoke administrative access from the Members list.
 *
 * WHY IT EXISTS. grantAdminRole and revokeAdminRole shipped as callables with
 * no surface at all — the only way to reach them was the browser console of a
 * signed-in admin. An access-control mechanism nobody can operate is one people
 * route around, and routing around it means going back to editing Firestore by
 * hand, which is what produced the hardcoded identity in the first place.
 *
 * NO PRIVILEGE DECISION HAPPENS HERE. The callable re-checks the caller server
 * side with assertAdmin and writes the audit row from the verified token, so
 * this component rendering is not authorisation — it is a button. Hiding it
 * would not secure anything and showing it does not grant anything.
 *
 * A grant is not undoable by the person it lands on, so it asks twice. The
 * second click is the confirmation; there is no modal because a modal here
 * would be a third thing to dismiss on a list where the admin is already
 * scanning rows.
 */
interface Props {
  // `role` is the User union, not a bare string — the admin list passes docs
  // straight through and a widened type here would let a typo like 'Admin'
  // compile and silently never match.
  user: { id: string; name?: string; email?: string; role?: User['role']; isAdmin?: boolean };
  /** The acting admin, so the control can explain why self-revoke is refused. */
  currentUserId?: string;
  isAr: boolean;
  /** Called after a successful change so the caller can refresh its list. */
  onChanged?: () => void;
}

export default function AdminRoleToggle({ user, currentUserId, isAr, onChanged }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = isAdminUser(user);
  const isSelf = !!currentUserId && user.id === currentUserId;

  // The server refuses self-revocation — adminRoles.js canRevoke — because that
  // is how an access-control system removes its own last operator. Saying so
  // here beats letting someone click and read a permission error.
  if (isAdmin && isSelf) {
    return (
      <span className="text-[9px] font-black uppercase tracking-wider px-2 py-1 rounded-lg bg-surface-sunken text-fg-muted border border-line select-none">
        {isAr ? 'أنت' : 'You'}
      </span>
    );
  }

  const act = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const fn = await getCallableFunction(isAdmin ? 'revokeAdminRole' : 'grantAdminRole');
      await fn({ email: user.email });
      setConfirming(false);
      onChanged?.();
    } catch (e: any) {
      setError(
        e?.message ||
        (isAr ? 'تعذّر تنفيذ التغيير.' : 'Could not apply the change.')
      );
    } finally {
      setBusy(false);
    }
  };

  // Both callables identify the target by email. A phone-only account has none,
  // so the grant has to come from the bootstrap script with --uid — said here
  // rather than failing with "no account exists for ''".
  if (!user.email) {
    return (
      <span
        className="text-[9px] font-bold text-fg-muted px-2 py-1 select-none"
        title={isAr ? 'استخدم scripts/admin/grant-admin.cjs --uid' : 'Use scripts/admin/grant-admin.cjs --uid'}
      >
        {isAr ? 'لا إيميل' : 'no email'}
      </span>
    );
  }

  if (error) {
    return (
      <button
        type="button"
        onClick={() => { setError(null); setConfirming(false); }}
        className="inline-flex items-center gap-1 text-[9px] font-bold text-red-600 px-2 py-1 rounded-lg border border-red-200 cursor-pointer max-w-[180px]"
        title={error}
      >
        <AlertCircle className="w-3 h-3 shrink-0" />
        <span className="truncate">{error}</span>
      </button>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className={`inline-flex items-center gap-1 text-[10px] font-extrabold px-2.5 py-1.5 rounded-xl border transition-colors cursor-pointer ${
          isAdmin
            ? 'text-red-600 border-red-200 bg-surface-raised hover:bg-red-50'
            : 'text-fg-muted border-line bg-surface-raised hover:border-[#FF6B00] hover:text-[#FF6B00]'
        }`}
      >
        {isAdmin ? <ShieldOff className="w-3 h-3" /> : <ShieldCheck className="w-3 h-3" />}
        <span>{isAdmin ? (isAr ? 'سحب الإدارة' : 'Remove admin') : (isAr ? 'تعيين إدارياً' : 'Make admin')}</span>
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={act}
        disabled={busy}
        className={`inline-flex items-center gap-1 text-[10px] font-black px-2.5 py-1.5 rounded-xl text-white transition-all cursor-pointer disabled:opacity-50 ${
          isAdmin ? 'bg-red-600 hover:bg-red-700' : 'bg-[#FF6B00] hover:brightness-110'
        }`}
      >
        {busy && <Loader2 className="w-3 h-3 animate-spin" />}
        <span>{isAr ? 'أكّد' : 'Confirm'}</span>
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={busy}
        className="text-[10px] font-bold text-fg-muted px-2 py-1.5 rounded-xl hover:text-fg transition-colors cursor-pointer disabled:opacity-50"
      >
        {isAr ? 'إلغاء' : 'Cancel'}
      </button>
    </span>
  );
}
