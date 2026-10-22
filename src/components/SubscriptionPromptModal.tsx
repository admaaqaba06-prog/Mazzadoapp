import React, { useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { ShieldCheck, ArrowRight, ArrowLeft, X } from 'lucide-react';
import { logAnalyticsEvent } from '../services/analyticsService';
import { canRecordGateEvent, gateMetadata } from '../utils/membershipFunnel';

interface SubscriptionPromptModalProps {
  onClose: () => void;
}

export const SubscriptionPromptModal: React.FC<SubscriptionPromptModalProps> = ({ onClose }) => {
  const { language, setActiveView, currentUser, subscriptionPromptSource } = useApp();
  const isAr = language === 'ar';

  /**
   * THE DENOMINATOR.
   *
   * Nothing recorded that this screen was ever shown. `membership_submitted`
   * fires after the payment proof is uploaded, so the product could count who
   * finished paying and not who was asked — see utils/membershipFunnel.ts.
   *
   * These fire from the MODAL rather than from the paths that open it, because
   * one of those paths is the URL and not a call site at all. The modal is
   * rendered conditionally, so mounting is opening.
   */

  /** Latest identity + source, so the unmount cleanup never logs a stale one. */
  const ctxRef = useRef({ id: currentUser?.id, email: currentUser?.email, source: subscriptionPromptSource });
  ctxRef.current = { id: currentUser?.id, email: currentUser?.email, source: subscriptionPromptSource };

  const shownRef = useRef(false);
  /** True once ANY outcome was recorded, so unmount does not double-count. */
  const outcomeRecordedRef = useRef(false);

  const record = (
    event: 'membership_gate_shown' | 'membership_gate_dismissed' | 'membership_gate_cta',
    extra: Record<string, unknown> = {},
  ) => {
    const { id, email, source } = ctxRef.current;
    if (!canRecordGateEvent(id)) return;
    void logAnalyticsEvent(event, id as string, email ?? null, gateMetadata(source, extra));
  };

  useEffect(() => {
    // Ref guard, not just an empty dep array: StrictMode double-invokes effects
    // in development, and a gate view counted twice is a denominator that
    // flatters the conversion rate.
    if (!shownRef.current) {
      shownRef.current = true;
      record('membership_gate_shown');
    }
    return () => {
      // Closed without choosing: Back/Forward, or any future path that flips
      // the flag directly. Counted, because an abandonment nobody records
      // reads afterwards as if the gate was never shown.
      if (shownRef.current && !outcomeRecordedRef.current) {
        record('membership_gate_dismissed', { via: 'unmount' });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleJoin = () => {
    outcomeRecordedRef.current = true;
    record('membership_gate_cta', { cta: 'join' });
    setActiveView('wallet');
    onClose();
  };

  const handleHowItWorks = () => {
    outcomeRecordedRef.current = true;
    record('membership_gate_cta', { cta: 'how_it_works' });
    setActiveView('about');
    onClose();
  };

  const handleDismiss = () => {
    outcomeRecordedRef.current = true;
    record('membership_gate_dismissed', { via: 'close_button' });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
      <div
        className="relative bg-surface-raised text-fg w-full max-w-sm rounded-3xl overflow-hidden flex flex-col shadow-2xl animate-in scale-in duration-200 p-6 md:p-8"
        style={{ direction: isAr ? 'rtl' : 'ltr' }}
        id="subscription-renew-modal"
      >
        {/* Close Button */}
        <button
          onClick={handleDismiss}
          className="absolute top-4 right-4 p-1 rounded-full hover:bg-surface-sunken text-fg-muted min-w-[44px] min-h-[44px] flex items-center justify-center cursor-pointer z-10"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Headline */}
        <div className="text-center space-y-3 mb-6 mt-2">
          <div className="mx-auto w-11 h-11 rounded-full bg-accent-weak border border-orange-200/50 flex items-center justify-center text-[#FF6B00]">
            <ShieldCheck className="w-6 h-6 fill-current text-white stroke-[#FF6B00]" />
          </div>
          <h2 className="text-lg md:text-xl font-black text-fg tracking-tight leading-snug">
            {isAr ? 'انضم عشان تزايد وتربح 🔨' : 'Join to bid & win 🔨'}
          </h2>
          <p className="text-xs text-fg-muted max-w-xs mx-auto leading-normal">
            {isAr
              ? 'العضوية بتبدأ من دينار بالشهر عبر كليك — بتزايد مجاناً وما بتدفع إلا إذا فزت (+٥٪). بتتفعّل خلال دقائق.'
              : 'Membership from 1 JD/month via CliQ — bid free, pay only if you win (+5%). Activated in minutes.'}
          </p>
        </div>

        {/* Primary CTA: go to the membership page */}
        <button
          onClick={handleJoin}
          className="w-full bg-[#FF6B00] text-white font-black text-xs py-3.5 rounded-xl shadow-[0_4px_16px_rgba(255,107,0,0.25)] hover:brightness-105 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
          id="membership-join-cta"
        >
          <span>{isAr ? 'انضم الآن' : 'Join now'}</span>
          {isAr ? <ArrowLeft className="w-4 h-4" /> : <ArrowRight className="w-4 h-4" />}
        </button>

        {/* Secondary: how the whole loop works */}
        <button
          onClick={handleHowItWorks}
          className="w-full mt-3 text-[11px] font-semibold text-fg-muted hover:text-fg underline underline-offset-2 decoration-gray-200 hover:decoration-gray-400 transition-colors cursor-pointer"
          id="membership-how-it-works-link"
        >
          {isAr ? 'كيف يعمل؟' : 'How it works'}
        </button>
      </div>
    </div>
  );
};
