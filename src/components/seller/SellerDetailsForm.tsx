/**
 * "My details" — the seller's own shopfront form.
 *
 * `sellerProfiles` is `allow read: if true`, and until now a seller could not
 * edit a word of it. Activation chose a store name, an about line and a
 * location for them, and that was that — which is how every seller on the
 * platform came to be published as being in Amman.
 *
 * Writes go straight from the client, which the rules already allow:
 *   allow update: if isSignedIn() && (resource.data.userId == request.auth.uid || isAdmin())
 * No callable is needed, and nothing here can touch a field the seller does not
 * own — only the three keys the form collects are ever sent, and only the ones
 * that actually changed (see changedSellerProfileFields).
 */
import React, { useMemo, useState } from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../../services/firebase';
import { MapPin, Store, Loader2, Check, AlertCircle } from 'lucide-react';
import { JORDAN_GOVERNORATES } from '../../utils/jordanCities';
import {
  normalizeSellerProfileForm,
  validateSellerProfileForm,
  changedSellerProfileFields,
  isSeededLocation,
  STORE_NAME_MAX,
  BIO_MAX,
  type SellerProfileFormValues,
} from '../../utils/sellerProfileForm';

interface Props {
  sellerId: string;
  profile: { storeName?: string; bio?: string; location?: string } | null | undefined;
  isAr: boolean;
  /** Mirror the saved values into app state so the page updates without a reload. */
  onSaved?: (patch: Partial<SellerProfileFormValues>) => void;
}

export default function SellerDetailsForm({ sellerId, profile, isAr, onSaved }: Props) {
  const initial = useMemo<SellerProfileFormValues>(() => {
    const n = normalizeSellerProfileForm({
      storeName: profile?.storeName,
      bio: profile?.bio,
      location: profile?.location,
    });
    // A seeded «عمان، الأردن» is shown as UNSET. The seller never chose it, and
    // pre-selecting it would turn the next save into a confirmation of a fact
    // nobody stated. A legacy free-text location is dropped for the same reason
    // — it is not one of the twelve values this field now holds.
    const known = JORDAN_GOVERNORATES.some(g => g.id === n.location);
    return { ...n, location: known ? n.location : '' };
  }, [profile?.storeName, profile?.bio, profile?.location]);

  const [values, setValues] = useState<SellerProfileFormValues>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errors = validateSellerProfileForm(values);
  const patch = changedSellerProfileFields(initial, values);
  const dirty = Object.keys(patch).length > 0;
  const canSave = dirty && Object.keys(errors).length === 0 && !saving;

  const set = (k: keyof SellerProfileFormValues, v: string) => {
    setValues(p => ({ ...p, [k]: v }));
    setSaved(false);
    setError(null);
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await updateDoc(doc(db, 'sellerProfiles', sellerId), patch);
      onSaved?.(patch);
      setSaved(true);
    } catch (e: any) {
      setError(
        e?.message || (isAr ? 'تعذّر الحفظ. حاول مرة أخرى.' : 'Could not save. Please try again.')
      );
    } finally {
      setSaving(false);
    }
  };

  const label = 'text-[11px] font-black text-fg-muted uppercase tracking-tight block mb-1.5';
  const field = 'w-full bg-surface-sunken border border-line rounded-xl px-3.5 py-2.5 text-sm font-bold text-fg focus:outline-none focus:border-[#FF6B00] transition-colors';

  return (
    <div className="bg-surface-raised border border-line rounded-2xl p-5 space-y-5 shadow-xs">
      <div>
        <h3 className="text-sm font-black text-fg flex items-center gap-2">
          <Store className="w-4 h-4 text-[#FF6B00]" />
          {isAr ? 'معلومات متجري' : 'My store details'}
        </h3>
        <p className="text-[11px] text-fg-muted mt-1 leading-snug">
          {isAr
            ? 'هذي المعلومات بتظهر للمشترين على صفحة متجرك.'
            : 'This is what buyers see on your store page.'}
        </p>
      </div>

      <div>
        <label className={label} htmlFor="seller-store-name">
          {isAr ? 'اسم المتجر' : 'Store name'}
        </label>
        <input
          id="seller-store-name"
          value={values.storeName}
          onChange={e => set('storeName', e.target.value)}
          maxLength={STORE_NAME_MAX}
          className={field}
          aria-invalid={!!errors.storeName}
        />
        {errors.storeName && (
          <p className="text-[10.5px] text-red-600 font-bold mt-1">
            {errors.storeName === 'required'
              ? (isAr ? 'اسم المتجر مطلوب.' : 'A store name is required.')
              : errors.storeName === 'too_short'
                ? (isAr ? 'الاسم قصير جداً.' : 'That name is too short.')
                : (isAr ? 'الاسم طويل جداً.' : 'That name is too long.')}
          </p>
        )}
      </div>

      <div>
        <label className={label} htmlFor="seller-location">
          <span className="inline-flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5" />
            {isAr ? 'المحافظة' : 'Governorate'}
          </span>
        </label>
        <select
          id="seller-location"
          value={values.location}
          onChange={e => set('location', e.target.value)}
          className={`${field} cursor-pointer`}
        >
          <option value="">{isAr ? '— لم أحدد —' : '— Not set —'}</option>
          {JORDAN_GOVERNORATES.map(g => (
            <option key={g.id} value={g.id}>{isAr ? g.ar : g.en}</option>
          ))}
        </select>
        <p className="text-[10.5px] text-fg-muted font-bold mt-1 leading-snug">
          {isAr
            ? 'من وين بتتسلّم القطع. بنستخدمها لحساب التوصيل وترتيب البائعين القريبين من المشتري.'
            : 'Where your items are collected from. Used to work out delivery and to surface sellers near a buyer.'}
        </p>
        {/* Said plainly, because the profile has been showing a location this
            seller never chose. */}
        {isSeededLocation(profile?.location) && !values.location && (
          <p className="text-[10.5px] text-amber-700 font-bold mt-1.5 leading-snug">
            {isAr
              ? 'متجرك كان معروضاً في «عمّان» تلقائياً بدون ما تحددها. اختر محافظتك الصحيحة.'
              : 'Your store was showing "Amman" automatically without you choosing it. Please pick your real governorate.'}
          </p>
        )}
      </div>

      <div>
        <label className={label} htmlFor="seller-bio">
          {isAr ? 'نبذة عن المتجر' : 'About your store'}
        </label>
        <textarea
          id="seller-bio"
          value={values.bio}
          onChange={e => set('bio', e.target.value)}
          maxLength={BIO_MAX}
          rows={3}
          className={`${field} resize-y leading-relaxed`}
        />
        <p className="text-[10px] text-fg-muted font-mono mt-1" dir="ltr">
          {values.bio.length} / {BIO_MAX}
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-3">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
          <p className="text-[11px] text-red-800 font-bold leading-snug">{error}</p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="bg-[#FF6B00] text-white rounded-xl px-5 py-2.5 text-xs font-black cursor-pointer hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          <span>{isAr ? 'حفظ' : 'Save'}</span>
        </button>
        {saved && !dirty && (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-black text-emerald-600">
            <Check className="w-3.5 h-3.5" />
            {isAr ? 'تم الحفظ' : 'Saved'}
          </span>
        )}
      </div>
    </div>
  );
}
