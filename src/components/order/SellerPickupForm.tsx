import React, { useState } from 'react';
import { PackageCheck, Loader2, Check } from 'lucide-react';
import { JORDAN_GOVERNORATES } from '../../utils/jordanCities';
import { validateDeliveryAddress } from '../../utils/deliveryAddress';
import { getCallableFunction } from '../../services/firebase';
import type { Order } from '../../types';

/**
 * The seller's end of the courier handover.
 *
 * The buyer nominates a delivery address and phone at the payment step. The
 * seller had no equivalent, so a courier had a destination and no origin — and
 * a seller who signed up with Google has no account phone to fall back on
 * either.
 *
 * WHY THIS ONLY APPEARS AFTER THE PAYMENT IS VERIFIED. The order document is
 * readable by the buyer, the seller and admins, and Firestore has no
 * field-level read control: a granted read returns every field. So anything
 * saved here is visible to the BUYER the moment it lands. Showing the form
 * earlier would quietly widen the gate that revealCounterpartyContact already
 * applies to the seller's phone. The callable enforces the same rule
 * server-side — this is the UI agreeing with it, not the thing imposing it.
 *
 * Validation mirrors the buyer's form by calling the SAME validator, so the two
 * ends of one handover cannot drift into different rules about what a usable
 * Jordanian address is. The server re-checks all of it regardless.
 */
export interface SellerPickupFormProps {
  order: Order;
  isAr: boolean;
  /** Seller's account name — the default the courier asks for. */
  defaultName?: string;
  /** Seller's account phone, prefilled when there is one. */
  defaultPhone?: string;
  onSaved?: () => void;
}

export const SellerPickupForm: React.FC<SellerPickupFormProps> = ({
  order,
  isAr,
  defaultName = '',
  defaultPhone = '',
  onSaved,
}) => {
  const saved = !!order.pickupAddress && !!order.pickupPhone;

  const [governorate, setGovernorate] = useState(order.pickupAddress?.governorate ?? '');
  const [area, setArea] = useState(order.pickupAddress?.area ?? '');
  const [building, setBuilding] = useState(order.pickupAddress?.building ?? '');
  const [notes, setNotes] = useState(order.pickupAddress?.notes ?? '');
  const [phone, setPhone] = useState(order.pickupPhone ?? defaultPhone ?? '');
  const [name, setName] = useState(order.pickupName ?? defaultName ?? '');

  const [errors, setErrors] = useState<{ governorate?: boolean; area?: boolean; phone?: boolean }>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [done, setDone] = useState(saved);

  const submit = async () => {
    const check = validateDeliveryAddress({ governorate, area, building, notes }, phone);
    if (!check.valid) {
      setErrors(check.errors);
      return;
    }
    setErrors({});
    setFailure('');
    setBusy(true);
    try {
      const call = await getCallableFunction<
        {
          orderId: string;
          governorate: string;
          area: string;
          building: string;
          notes: string;
          phone: string;
          name: string;
        },
        unknown
      >('submitPickupDetails');
      await call({
        orderId: order.id,
        governorate,
        area,
        building,
        notes,
        phone: check.normalizedPhone ?? phone,
        name,
      });
      setDone(true);
      onSaved?.();
    } catch (err: any) {
      // The server's message is the useful one — it names the actual gate that
      // refused (not verified yet, order closed, not the seller). Showing a
      // generic failure here would hide the one fact that tells the seller what
      // to do next.
      setFailure(
        err?.message ||
          (isAr ? 'تعذر حفظ بيانات الاستلام. حاول مرة أخرى.' : 'Could not save the pickup details. Try again.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const field =
    'w-full bg-surface-raised border rounded-xl px-3 py-2.5 text-xs font-bold text-fg placeholder:text-gray-300 focus:outline-none focus:border-[#FF6B00] transition-colors';

  return (
    <div className="bg-accent-weak border border-[#FF6B00] rounded-2xl p-4 space-y-3" id="seller-pickup-form">
      <div className="flex items-center gap-2 pb-2 border-b border-orange-100">
        <PackageCheck className="w-4 h-4 text-[#FF6B00] shrink-0" />
        <h4 className="text-xs font-black text-fg leading-none">
          {isAr ? 'بيانات الاستلام من عندك' : 'Pickup details'}
        </h4>
      </div>

      <p className="text-[10.5px] text-fg-muted font-bold leading-snug">
        {isAr
          ? 'شركة التوصيل بتحتاج تعرف من وين تستلم القطعة ومين تتواصل معه. المشتري بيشوف هاي المعلومات لأنكم طرفَي نفس الطلب.'
          : 'The courier needs to know where to collect the item and who to call. The buyer can see these details — you are both parties to this order.'}
      </p>

      {done ? (
        <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-3 flex items-start gap-2">
          <Check className="w-3.5 h-3.5 text-emerald-700 shrink-0 mt-0.5" />
          <p className="text-[11px] text-emerald-800 font-bold leading-snug">
            {isAr ? 'تم حفظ بيانات الاستلام. بتقدر تعدّلها بإعادة الإرسال.' : 'Pickup details saved. Resubmit to change them.'}
          </p>
        </div>
      ) : null}

      <select
        value={governorate}
        onChange={(e) => { setGovernorate(e.target.value); if (errors.governorate) setErrors((p) => ({ ...p, governorate: false })); }}
        className={`${field} appearance-none cursor-pointer ${errors.governorate ? 'border-red-300' : 'border-line'}`}
        id="pickup-governorate"
        aria-label={isAr ? 'محافظة الاستلام' : 'Pickup governorate'}
      >
        <option value="" disabled>{isAr ? 'اختر المحافظة' : 'Select governorate'}</option>
        {JORDAN_GOVERNORATES.map((g) => (
          <option key={g.id} value={g.id}>{isAr ? g.ar : g.en}</option>
        ))}
      </select>

      <input
        type="text"
        value={area}
        onChange={(e) => { setArea(e.target.value); if (errors.area) setErrors((p) => ({ ...p, area: false })); }}
        placeholder={isAr ? 'المنطقة / الشارع' : 'Area / street'}
        className={`${field} ${errors.area ? 'border-red-300' : 'border-line'}`}
        id="pickup-area"
        style={{ textAlign: isAr ? 'right' : 'left' }}
      />

      <input
        type="text"
        value={building}
        onChange={(e) => setBuilding(e.target.value)}
        placeholder={isAr ? 'البناية / الطابق / المحل (اختياري)' : 'Building / floor / shop (optional)'}
        className={`${field} border-line`}
        id="pickup-building"
        style={{ textAlign: isAr ? 'right' : 'left' }}
      />

      <input
        type="text"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={isAr ? 'علامة مميزة أو وقت الاستلام (اختياري)' : 'Landmark or pickup time (optional)'}
        className={`${field} border-line`}
        id="pickup-notes"
        style={{ textAlign: isAr ? 'right' : 'left' }}
      />

      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={isAr ? 'اسم الشخص الي بيسلّم (اختياري)' : 'Who the courier asks for (optional)'}
        className={`${field} border-line`}
        id="pickup-name"
        style={{ textAlign: isAr ? 'right' : 'left' }}
      />

      <input
        type="tel"
        dir="ltr"
        inputMode="tel"
        autoComplete="tel"
        value={phone}
        onChange={(e) => { setPhone(e.target.value); if (errors.phone) setErrors((p) => ({ ...p, phone: false })); }}
        placeholder="07XXXXXXXX"
        className={`${field} font-mono ${errors.phone ? 'border-red-300' : 'border-line'}`}
        id="pickup-phone"
        aria-label={isAr ? 'رقم هاتف الاستلام' : 'Pickup phone'}
      />

      {failure ? (
        <p className="text-[10.5px] text-red-600 font-bold leading-snug" role="alert">{failure}</p>
      ) : null}

      <button
        onClick={submit}
        disabled={busy}
        className="w-full bg-[#FF6B00] text-white rounded-xl py-3 text-xs font-black flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
        id="pickup-submit"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
        <span>{done ? (isAr ? 'تحديث البيانات' : 'Update details') : (isAr ? 'حفظ بيانات الاستلام' : 'Save pickup details')}</span>
      </button>
    </div>
  );
};

export default SellerPickupForm;
