import React, { useState, useEffect, useRef } from "react";
import ThemeToggle from '../components/ui/ThemeToggle';
import {
  Hammer,
  ShieldCheck,
  FileSearch,
  Zap,
  Scale,
  Camera,
  CheckCircle2,
  XCircle,
  Car,
  Home,
  Laptop,
  Wrench,
  Watch,
  Hash,
  Globe,
  Clock,
  Truck,
  Users,
  Bell,
  Menu,
  X,
  Lock,
  TrendingUp,
  Award,
  Sparkles,
  ChevronDown,
  ChevronUp,
  HelpCircle,
  MessageCircle,
  Check,
  Search,
  Eye,
  MapPin,
  Building2,
  Quote,
  Star,
  Heart,
  Share2,
  Flame,
  Instagram
} from "lucide-react";
import { motion, useScroll, useInView, useSpring, AnimatePresence, useReducedMotion } from "motion/react";
import { translations, TranslationType } from "./translations";
import { formatCountdown, stepPrice as stepPriceBy, driftWatchers, antiSnipe } from "./heroSim";
import { emitLandingEvent } from './landingAnalytics';
import { useLandingAuctions } from './useLandingAuctions';
import { priceLabel } from '../utils/bidLabels';
import { categoryLabel } from '../utils/categoryLabel';
import { SUPPORT_WHATSAPP_URL, SUPPORT_PHONE_TEL, SUPPORT_PHONE_NATIONAL, SOCIAL_INSTAGRAM_URL } from '../constants/support';
import { useApp } from "../context/AppContext";
import { IPhoneAuctionSection } from "./components/IPhoneAuctionSection";
import { Logo } from "./components/Logo";
import { LandingButton } from "./components/LandingButton";
import TermsModal from "../components/TermsModal";
import AuctionRulesModal from "../components/AuctionRulesModal";

// Reveal scroll component
function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number; key?: React.Key }) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-80px" });
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 28 }}
      animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 28 }}
      transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1], delay }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Icons for the Trust & Safety cards, positional so the table sits beside the
 * copy it illustrates instead of being spelled out inside the JSX. Indexed by
 * card order, which is the order the four cards are declared in translations.
 */
const TRUST_ICONS = [ShieldCheck, FileSearch, Zap, Scale] as const;


const translateLogTime = (timeStr: string, isAr: boolean): string => {
  if (isAr) {
    if (timeStr === "Just now" || timeStr === "الآن") return "الآن";
    if (timeStr === "10s ago") return "منذ 10 ثوانٍ";
    if (timeStr === "20s ago") return "منذ 20 ثانية";
    if (timeStr === "40s ago") return "منذ 40 ثانية";
    if (timeStr === "1m ago") return "منذ دقيقة";
    if (timeStr === "2m ago") return "منذ دقيقتين";
    if (timeStr === "3m ago") return "منذ 3 دقائق";
    if (timeStr === "4m ago") return "منذ 4 دقائق";
    if (timeStr === "5m ago") return "منذ 5 دقائق";
    if (timeStr === "8m ago") return "منذ 8 دقائق";
    return timeStr;
  } else {
    if (timeStr === "Just now" || timeStr === "الآن") return "Just now";
    if (timeStr === "منذ 10 ثوانٍ") return "10s ago";
    if (timeStr === "منذ 20 ثانية") return "20s ago";
    if (timeStr === "منذ 40 ثانية") return "40s ago";
    if (timeStr === "منذ دقيقة") return "1m ago";
    if (timeStr === "منذ دقيقتين") return "2m ago";
    if (timeStr === "منذ 3 دقائق") return "3m ago";
    if (timeStr === "منذ 4 دقائق") return "4m ago";
    if (timeStr === "منذ 5 دقائق") return "5m ago";
    if (timeStr === "منذ 8 دقائق") return "8m ago";
    return timeStr;
  }
};

const renderMixedText = (text: string, isAr: boolean) => {
  const segments = text.split(/(\d[\d,.]*)/g);
  return segments.map((seg, idx) => {
    if (/^\d[\d,.]*$/.test(seg)) {
      return (
        <span key={idx} className="font-mono" style={{ fontVariantNumeric: "tabular-nums" }}>
          {seg}
        </span>
      );
    } else {
      return (
        <span 
          key={idx} 
          className={isAr ? "font-tajawal" : ""} 
          style={isAr ? { letterSpacing: "0px" } : undefined}
        >
          {seg}
        </span>
      );
    }
  });
};

// Simulated Jordanian names for the interactive feed
/**
 * Icons for the hero proof row, positional like TRUST_ICONS. Kept beside the
 * component rather than in translations: the copy is bilingual, the icon is not.
 */
/**
 * The brand orange as a literal, for the handful of places a Tailwind class
 * cannot reach: framer-motion animates style VALUES, so it needs a colour it
 * can interpolate — a `var(--color-accent)` string is applied but never
 * animated, and an SVG `stroke` attribute takes no class either. Everything
 * else on this page uses the `accent` token and follows the theme.
 */
const ACCENT = "#F05123";

// Slot 2 was a padlock over «فلوسك محفوظة» — the escrow promise, which now
// lives in the subheadline directly above. Two statements of the same guarantee
// ~300px apart competed with each other, so this slot carries a DIFFERENT claim
// («بدون فصال — السوق بيحدد السعر») and takes the icon that matches it.
const HERO_PROOF_ICONS = [Truck, TrendingUp, Clock] as const;

const AR_NAMES = ["مصطفى القضاة", "أحمد العبادي", "سارة حداد", "خالد الشوابكة", "رانيا الفايز", "حمزة المصري", "عمر الزعبي", "هديل الخلايلة", "طارق الحسين", "زيد النابلسي"];
const EN_NAMES = ["Mustafa Al-Qudah", "Ahmad Al-Abadi", "Sarah Haddad", "Khalid Shawabkeh", "Rania Al-Fayez", "Hamzah Al-Masri", "Omar Al-Zoubi", "Hadeel Al-Khalayleh", "Tariq Al-Hussein", "Zaid Al-Nabulsi"];

// First-name-only demo list for the "🔥 <name> just bid" toast in the hero simulator
const HERO_FIRST_NAMES: Record<"ar" | "en", string[]> = {
  en: ["Omar", "Layla", "Khaled", "Sara", "Yousef", "Rania", "Tariq", "Dana"],
  ar: ["عمر", "ليلى", "خالد", "سارة", "يوسف", "رانيا", "طارق", "دانا"]
};

interface BidLog {
  id: string;
  name: string;
  amount: number;
  time: string;
  isUser?: boolean;
}

const ACTIVE_ITEMS = [
  {
    id: "car",
    icon: "🚗",
    titleAr: "تويوتا كامري 2022",
    titleEn: "Toyota Camry 2022",
    detailsAr: "صور حقيقية · عمّان · مزاد مميز",
    detailsEn: "Real photos · Amman · Premium Auction",
    image: "https://images.unsplash.com/photo-1621007947382-bb3c3994e3fb?auto=format&fit=crop&w=800&q=80",
    badgeAr: "صور حقيقية",
    badgeEn: "Real photos",
    basePrice: 14250,
    stepPrice: 250,
    timerStart: 138
  },
  {
    id: "phone",
    icon: "📱",
    titleAr: "آيفون 15 برو ماكس",
    titleEn: "iPhone 15 Pro Max",
    detailsAr: "سعة 512 جيجابايت · كفالة الوكيل · كالجديد",
    detailsEn: "512GB · Agency Warranty · Like New",
    image: "https://images.unsplash.com/photo-1592286927505-1def25115558?auto=format&fit=crop&w=800&q=80",
    badgeAr: "كفالة الوكيل",
    badgeEn: "Warranty Active",
    basePrice: 850,
    stepPrice: 25,
    timerStart: 180
  },
  {
    id: "watch",
    icon: "⌚",
    titleAr: "رولكس ديت جست 41",
    titleEn: "Rolex Datejust 41",
    detailsAr: "41 ملم · ستيل · بالكرت والعلبة · صور حقيقية",
    detailsEn: "41mm · Oystersteel · Box & Papers · Real photos",
    image: "https://images.unsplash.com/photo-1523170335258-f5ed11844a49?auto=format&fit=crop&w=800&q=80",
    badgeAr: "صور حقيقية",
    badgeEn: "Real photos",
    basePrice: 2150,
    stepPrice: 50,
    timerStart: 120
  },
  {
    id: "house",
    icon: "🏡",
    titleAr: "فيلا مودرن في دابوق",
    titleEn: "Modern Villa in Dabouq",
    detailsAr: "مساحة 450م² · 4 غرف نوم · مسبح خاص",
    detailsEn: "450 sqm · 4 Bedrooms · Private Pool",
    image: "https://images.unsplash.com/photo-1613490493576-7fde63acd811?auto=format&fit=crop&w=600&q=80",
    badgeAr: "طابو جاهز",
    badgeEn: "Title Deed Ready",
    basePrice: 320000,
    stepPrice: 5000,
    timerStart: 3600
  }
];

function LiveMarketplaceSection({ lang, t, onEnter, formatPrice }: {
  lang: 'ar' | 'en';
  t: TranslationType;
  onEnter: (target?: string) => void;
  formatPrice: (val: number) => React.ReactNode;
}) {
  const { auctions, isLoading, isEmpty, isError } = useLandingAuctions();
  const formatTimeLeft = (endTime: number, now = Date.now()): string => {
    const ms = Math.max(0, endTime - now);
    const totalMin = Math.floor(ms / 60000);
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;
    if (lang === 'ar') {
      if (days > 0) return `${days} يوم ${hours} س`;
      if (hours > 0) return `${hours} س ${mins} د`;
      return `${mins} د`;
    }
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };
  return (
    <section id="live-marketplace" className="py-20 md:py-28 bg-surface">
      <div className="max-w-7xl mx-auto px-5">
        <Reveal>
          <div className="text-center mb-12">
            {/* `accent-ink` on the WORDS, `accent` on the dot: the label is
                14px text that has to clear AA on the light surface, the dot is
                a 8px fill that has nothing to read. */}
            <span className="inline-flex items-center gap-2 text-accent-ink font-semibold text-sm">
              <span className="w-2 h-2 rounded-full bg-accent animate-pulse motion-reduce:animate-none" />
              {t.marketplace.badge}
            </span>
            <h2 className="mt-3 text-3xl md:text-4xl font-bold text-fg">{t.marketplace.title}</h2>
            <p className="mt-3 text-fg/60 max-w-xl mx-auto">{t.marketplace.subtitle}</p>
          </div>
        </Reveal>

        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-2xl bg-surface-raised border border-line h-72 animate-pulse" />
            ))}
          </div>
        ) : isError ? (
          <Reveal>
            <div className="max-w-md mx-auto text-center rounded-2xl bg-surface-raised border border-line p-10">
              <h3 className="text-xl font-bold text-fg">{t.marketplace.unavailableTitle}</h3>
              <p className="mt-2 text-fg/60">{t.marketplace.unavailableDesc}</p>
              <button
                type="button"
                onClick={() => { emitLandingEvent('seller_cta_clicked', { location: 'marketplace_error' }); onEnter('upload'); }}
                className="mt-6 inline-flex items-center justify-center px-6 py-3 rounded-full bg-accent text-white font-semibold hover:bg-accent-strong transition"
              >
                {t.marketplace.sellerCtaBtn}
              </button>
            </div>
          </Reveal>
        ) : isEmpty ? (
          <Reveal>
            <div className="max-w-md mx-auto text-center rounded-2xl bg-surface-raised border border-line p-10">
              <h3 className="text-xl font-bold text-fg">{t.marketplace.emptyTitle}</h3>
              <p className="mt-2 text-fg/60">{t.marketplace.emptyDesc}</p>
              <button
                type="button"
                onClick={() => { emitLandingEvent('seller_cta_clicked', { location: 'marketplace_empty' }); onEnter('upload'); }}
                className="mt-6 inline-flex items-center justify-center px-6 py-3 rounded-full bg-accent text-white font-semibold hover:bg-accent-strong transition"
              >
                {t.marketplace.sellerCtaBtn}
              </button>
            </div>
          </Reveal>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
              {auctions.map((a) => {
                // `endTime` is `number | null | undefined`, and curation admits every falsy
                // value as clockless. The old `a.endTime - Date.now() < 3600_000` was WRONG
                // for two of them: `null` and `0` coerce to 0, so the subtraction went large
                // and negative and the card rendered the orange "Ending soon" badge plus a
                // "0m" countdown on a lot whose clock had not started. `undefined` and `NaN`
                // gave NaN, so the comparison was false and the badge was merely absent.
                // `> 0` is what rejects `0` and `NaN`, and it keeps this predicate
                // byte-identical to `compareLandingAuctions` — so no lot is ever sorted as
                // clockless and rendered as clocked.
                const hasClock = typeof a.endTime === 'number' && a.endTime > 0;
                const endingSoon = hasClock && a.endTime - Date.now() < 3600_000;
                return (
                  <Reveal key={a.id}>
                    <button
                      type="button"
                      onClick={() => { emitLandingEvent('auction_viewed', { auctionId: a.id }); onEnter(); }}
                      className="group text-start w-full rounded-2xl bg-surface-raised border border-line overflow-hidden hover:-translate-y-1 hover:shadow-xl transition"
                    >
                      <div className="relative aspect-[4/3] bg-surface-sunken overflow-hidden">
                        {a.imageUrl ? (
                          <img src={a.imageUrl} alt={a.title} loading="lazy" className="w-full h-full object-cover group-hover:scale-105 transition" />
                        ) : null}
                        {a.isVerified ? (
                          <span className="absolute top-3 start-3 inline-flex items-center gap-1 px-2 py-1 rounded-full bg-surface-raised/90 text-xs font-semibold text-fg">
                            ✓ {t.marketplace.verified}
                          </span>
                        ) : null}
                        {endingSoon ? (
                          <span className="absolute top-3 end-3 px-2 py-1 rounded-full bg-accent text-white text-xs font-semibold">
                            {t.marketplace.endingSoon}
                          </span>
                        ) : !hasClock ? (
                          /* Same two classes as the Discover card's awaiting badge
                             (bg-amber-400 text-fg-on-light, DiscoveryFeedView.tsx:175),
                             so the card a visitor taps and the screen it opens look
                             alike. Amber also keeps it distinct from the orange
                             ending-soon badge that occupies this exact slot — the two
                             states must not read as the same chip. Black-on-amber is
                             correct in BOTH themes, which is why this badge is not
                             tokenised the way the surrounding text is. */
                          <span className="absolute top-3 end-3 px-2 py-1 rounded-full bg-amber-400 text-fg-on-light text-xs font-semibold">
                            {t.marketplace.beTheFirst}
                          </span>
                        ) : null}
                      </div>
                      <div className="p-4">
                        {/* categoryLabel(), not a landing-local map. This page
                            carried its OWN copy of the taxonomy, and it had
                            drifted from `utils/categories.ts` — the one list
                            the seller picker, the Discover chips and the admin
                            builder all share. Three ways it was wrong:
                            `Fashion` is the historical CATCH-ALL (labelled
                            "أخرى / Other" everywhere else) and read "أزياء"
                            here, so every TV, pressure cooker and deep fryer on
                            the page announced itself as clothing; `Luxury` read
                            "كماليات" instead of the "ساعات" it was absorbed
                            into; and `Phones`/`Watches`/`Cars`/`Misc` were
                            absent entirely, so they fell through to the raw
                            stored value and rendered Latin text on an Arabic
                            page. A second copy of a taxonomy has no way to stay
                            correct — so there is no second copy now. */}
                        <span className="text-xs text-fg/50">{categoryLabel(a.category, lang === 'ar')}</span>
                        <h3 className="mt-1 font-semibold text-fg line-clamp-1">{a.title}</h3>
                        <div className="mt-3 flex items-end justify-between">
                          <div>
                            <span className="block text-xs text-fg/50">{priceLabel(a.totalBids, lang === 'ar')}</span>
                            <span dir="ltr" className="block font-bold text-fg">{formatPrice(a.currentPrice)}</span>
                          </div>
                          <div className="text-end">
                            <span dir="ltr" className="block text-xs text-fg/50">{a.totalBids} {t.marketplace.bids}</span>
                            {/* Clockless lots render NOTHING here: their state is
                                already carried by the "Be the first" badge above,
                                and formatTimeLeft would emit the literal "NaNm"
                                for an absent endTime. */}
                            {hasClock ? (
                              <span dir="ltr" className="block text-sm font-semibold text-accent">{formatTimeLeft(a.endTime as number)}</span>
                            ) : null}
                          </div>
                        </div>
                        {/* `accent-ink`, not `accent`: this link is 14px on a
                            themed card, and the brand orange only clears AA
                            there in dark. Measured on clean loads — the reads
                            taken straight after a theme toggle are stale. */}
                        <span className="mt-4 block text-center text-sm font-semibold text-accent-ink">{t.marketplace.viewBtn} {lang === 'ar' ? '←' : '→'}</span>
                      </div>
                    </button>
                  </Reveal>
                );
              })}
            </div>
            <Reveal>
              <div className="mt-12 text-center">
                <p className="text-lg font-semibold text-fg">{t.marketplace.sellerCtaText}</p>
                <button
                  type="button"
                  onClick={() => { emitLandingEvent('seller_cta_clicked', { location: 'marketplace' }); onEnter('upload'); }}
                  className="mt-4 inline-flex items-center justify-center px-8 py-4 rounded-full bg-accent text-white font-bold text-lg hover:bg-accent-strong transition"
                >
                  {t.marketplace.sellerCtaBtn}
                </button>
              </div>
            </Reveal>
          </>
        )}
      </div>
    </section>
  );
}

export default function LandingView({ onEnter, whatsappUrl = SUPPORT_WHATSAPP_URL }: { onEnter: (target?: string) => void; whatsappUrl?: string }) {
  // App.tsx renders this view for SIGNED-IN users too (the logo routes here), so
  // this toggle is not a visitor-only control: it is the most prominent language
  // switch in the product and a logged-in customer reaches it. It used to write
  // localStorage alone, which the server cannot read — so switching here changed
  // the UI while `users/{uid}.language` kept its old value and every WhatsApp
  // message, email and in-app notification carried on in the previous language.
  // Delegating to the context's `setLanguage` is what closes that: it owns the
  // one persistence path (src/utils/languagePersistence.ts), including the
  // signed-out guard. Not re-implemented here — one write, one guard.
  const { setLanguage, requestSignIn } = useApp();
  const [lang, setLang] = useState<"ar" | "en">(() => (localStorage.getItem('mazad_language') === 'en' ? 'en' : 'ar'));
  const toggleLang = () => {
    const next = lang === "ar" ? "en" : "ar";
    emitLandingEvent('language_switched', { to: next });
    // Local flip and localStorage FIRST and unconditionally: this page renders
    // from its own `lang` state, and the switch must be instant and total
    // regardless of what happens next.
    setLang(next);
    localStorage.setItem('mazad_language', next);
    // Then the shared path: app-wide state + the fire-and-forget write to
    // users/{uid}.language. It writes only for a real signed-in session — a
    // logged-out visitor's currentUser.id is the truthy sentinel
    // 'unauthenticated' — never awaits, and swallows its own failures, so a
    // dead network cannot leave this toggle half-applied.
    setLanguage(next);
  };
  const t: TranslationType = translations[lang];

  useEffect(() => {
    emitLandingEvent('landing_viewed', { lang });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Active item switching states
  const [activeItemIndex, setActiveItemIndex] = useState<number>(0);
  const [isAutoCycling, setIsAutoCycling] = useState<boolean>(true);
  const [likesCount, setLikesCount] = useState<number>(1428);
  const [hasLiked, setHasLiked] = useState<boolean>(false);
  // NOTE: these parallel arrays are indexed by activeItemIndex and MUST stay
  // aligned with ACTIVE_ITEMS ([car, phone, watch, house]).
  const [prices, setPrices] = useState<number[]>([14250, 850, 2150, 320000]);
  const [timers, setTimers] = useState<number[]>([138, 180, 120, 3600]);
  const [bidLogsList, setBidLogsList] = useState<BidLog[][]>(() => [
    [
      { id: "c1", name: "أحمد العبادي", amount: 14250, time: "10s ago" },
      { id: "c2", name: "سارة حداد", amount: 14000, time: "1m ago" },
      { id: "c3", name: "خالد الشوابكة", amount: 13750, time: "3m ago" },
      { id: "c4", name: "مصطفى القضاة", amount: 13500, time: "5m ago" }
    ],
    [
      { id: "p1", name: "هديل الخلايلة", amount: 850, time: "20s ago" },
      { id: "p2", name: "طارق الحسين", amount: 825, time: "1m ago" },
      { id: "p3", name: "رائد بني هاني", amount: 800, time: "4m ago" }
    ],
    [
      { id: "w1", name: "عمر الزعبي", amount: 2150, time: "15s ago" },
      { id: "w2", name: "رانيا الفايز", amount: 2100, time: "1m ago" },
      { id: "w3", name: "زيد النابلسي", amount: 2050, time: "3m ago" }
    ],
    [
      { id: "h1", name: "حمزة المصري", amount: 320000, time: "40s ago" },
      { id: "h2", name: "عمر الزعبي", amount: 315000, time: "2m ago" },
      { id: "h3", name: "زيد النابلسي", amount: 310000, time: "8m ago" }
    ]
  ]);

  // Live-room ambient sim state (hero right column)
  const prefersReducedMotion = useReducedMotion();
  const [watchers, setWatchers] = useState<number>(1420);
  const [bidCount, setBidCount] = useState<number>(12);
  const [priceBump, setPriceBump] = useState<boolean>(false);
  const [flashHit, setFlashHit] = useState<boolean>(false);
  const [extraAvatars, setExtraAvatars] = useState<number>(0);
  const [justBidToast, setJustBidToast] = useState<{ name: string; key: number } | null>(null);

  // Derived active item fields
  const currentItem = ACTIVE_ITEMS[activeItemIndex];
  const currentPrice = prices[activeItemIndex];
  const carTimer = timers[activeItemIndex];
  const bidLogs = bidLogsList[activeItemIndex];

  // Helper for rendering localized names
  const getLogName = (log: BidLog) => {
    const arIndex = AR_NAMES.indexOf(log.name);
    if (arIndex !== -1 && lang === "en") {
      return EN_NAMES[arIndex];
    }
    const enIndex = EN_NAMES.indexOf(log.name);
    if (enIndex !== -1 && lang === "ar") {
      return AR_NAMES[enIndex];
    }
    if (log.isUser) {
      return t.interactive.bidLogYou;
    }
    return log.name;
  };
  
  // Animation pulse states
  const [pulsePrice, setPulsePrice] = useState<boolean>(false);
  const [pulseUserAction, setPulseUserAction] = useState<boolean>(false);
  const [showExtensionAlert, setShowExtensionAlert] = useState<boolean>(false);
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(null);
  const [howItWorksTab, setHowItWorksTab] = useState<"buyer" | "seller">("seller");
  const [activeEscrowStep, setActiveEscrowStep] = useState<number>(2);

  // Live competition level state
  const [compLevel, setCompLevel] = useState<number>(84);

  // Registered waitlist members from localStorage
  const [waitlist, setWaitlist] = useState<Array<{ name: string; contact: string; date: string }>>(() => {
    try {
      const stored = localStorage.getItem("mazzado_waitlist");
      return stored ? JSON.parse(stored) : [
        { name: lang === "ar" ? "رائد بني هاني" : "Raed Bani Hani", contact: "079***4512", date: "2026-07-13" },
        { name: lang === "ar" ? "أمجد المعاني" : "Amjad Al-Maani", contact: "amj***@outlook.com", date: "2026-07-13" },
        { name: lang === "ar" ? "لينا العباسي" : "Lina Al-Abbasi", contact: "078***8819", date: "2026-07-12" }
      ];
    } catch {
      return [];
    }
  });

  // Waitlist form inputs
  const [formName, setFormName] = useState<string>("");
  const [formContact, setFormContact] = useState<string>("");
  const [formSuccess, setFormSuccess] = useState<boolean>(false);
  const [formError, setFormError] = useState<string>("");

  // Terms & Privacy modal state (public legal reachability from the landing footer)
  const [isTermsOpen, setIsTermsOpen] = useState<boolean>(false);
  // E4 — plain-language Auction Rules modal (public reachability from the footer)
  const [isRulesOpen, setIsRulesOpen] = useState<boolean>(false);

  // Sticky Header state
  const [scrolled, setScrolled] = useState<boolean>(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [showStickyBar, setShowStickyBar] = useState<boolean>(false);
  const headerRef = useRef<HTMLElement | null>(null);

  /* ====================================================================
     In-page section navigation — ONE path, used by the desktop nav, the
     mobile drawer and the footer's section links.

     The `href="#…"` attributes stay exactly as they were, so these remain
     real links: focusable, announced as links, middle-clickable, and
     copyable. This only takes over the PLAIN left click.
     ==================================================================== */

  /** Breathing room between the header and the top of the section content. */
  const SECTION_TOP_GAP = 16;

  /**
   * How much of the viewport top the header actually covers at the destination.
   *
   * NOT `header.offsetHeight` unconditionally, and this is the measured part.
   * The header is `position: sticky; top: 0`, but it never sticks: the landing
   * root wrapper carries `overflow-hidden`, and an ancestor whose overflow is
   * not `visible` becomes the sticky element's scrollport. Sampled at four
   * scroll positions, the header's rect tracks `-scrollY` exactly (0 → -500 →
   * -1500 → -3000), so it scrolls away and covers nothing on arrival.
   * Subtracting its 77px anyway would drop every section 77px too low.
   *
   * So the offset is decided by the same rule that decides whether the header
   * is on screen at all. If the root's `overflow-hidden` is ever replaced with
   * something that does not establish a scrollport, this starts returning the
   * real height and the landing position corrects itself with no edit here.
   */
  const headerOverlap = (): number => {
    const header = headerRef.current;
    if (!header) return 0;
    const position = window.getComputedStyle(header).position;
    if (position === 'fixed') return header.getBoundingClientRect().height;
    if (position !== 'sticky') return 0;
    for (let el = header.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      const style = window.getComputedStyle(el);
      if (style.overflowY !== 'visible' || style.overflowX !== 'visible') return 0;
    }
    return header.getBoundingClientRect().height;
  };

  /** Scroll to a section by id. Returns false when no such section exists. */
  const scrollToSection = (id: string): boolean => {
    const target = document.getElementById(id);
    if (!target) return false;
    // Close the drawer FIRST so it cannot cover the destination on arrival.
    // No timer is needed before measuring: the drawer is `fixed`, so it never
    // contributed to layout and closing it moves nothing.
    setMobileMenuOpen(false);
    const top = target.getBoundingClientRect().top + window.scrollY
      - headerOverlap() - SECTION_TOP_GAP;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    // pushState rather than assigning `location.hash`: assigning it makes the
    // browser perform its own INSTANT jump on top of the smooth scroll, which
    // is the jitter this function exists to remove. pushState still adds the
    // history entry, so Back returns the user where they came from, and the
    // current state object is carried over rather than discarded.
    if (window.location.hash !== `#${id}`) {
      window.history.pushState(window.history.state, '', `#${id}`);
    }
    return true;
  };

  /** Click handler for the in-page section links. */
  const onSectionLinkClick = (id: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    // Leave modified and non-primary clicks to the browser: ctrl/cmd-click
    // opens a new tab and shift-click a new window, and both must keep working
    // on a real link.
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (scrollToSection(id)) e.preventDefault();
  };

  // Scroll Progress Bar Setup
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, {
    stiffness: 100,
    damping: 30,
    restDelta: 0.001
  });

  // Effects
  useEffect(() => {
    // Scroll event
    const handleScroll = () => {
      setScrolled(window.scrollY > 80);
      
      const heroEl = document.getElementById("hero-section");
      if (heroEl) {
        const heroBottom = heroEl.offsetTop + heroEl.offsetHeight;
        setShowStickyBar(window.scrollY > heroBottom - 80);
      } else {
        setShowStickyBar(window.scrollY > 600);
      }
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Update HTML dir and lang
  useEffect(() => {
    document.documentElement.dir = t.dir;
    document.documentElement.lang = t.langCode;
    // Set font style class on body
    if (lang === "ar") {
      document.body.style.fontFamily = '"IBM Plex Sans Arabic", sans-serif';
    } else {
      document.body.style.fontFamily = '"IBM Plex Sans Arabic", sans-serif';
    }
  }, [lang, t]);

  // Timers countdown ticker for all active items.
  // Reduced motion → freeze (calm static hero). Also pauses while the tab is hidden.
  useEffect(() => {
    if (prefersReducedMotion) return;
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      setTimers((prevTimers) =>
        prevTimers.map((tVal, idx) => {
          if (tVal <= 1) {
            if (idx === activeItemIndex) {
              setShowExtensionAlert(true);
              setTimeout(() => setShowExtensionAlert(false), 3000);
            }
            return ACTIVE_ITEMS[idx].timerStart; // reset to its original start
          }
          return tVal - 1;
        })
      );
    }, 1000);
    return () => clearInterval(interval);
  }, [activeItemIndex, prefersReducedMotion]);

  // Automatically cycle through items every 8 seconds (frozen under reduced motion)
  useEffect(() => {
    if (!isAutoCycling || prefersReducedMotion) return;
    const cycleInterval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      setActiveItemIndex((prev) => (prev + 1) % ACTIVE_ITEMS.length);
    }, 8000);
    return () => clearInterval(cycleInterval);
  }, [isAutoCycling, prefersReducedMotion]);

  // Watcher count gently drifts (ambient life). Reduced motion → static.
  useEffect(() => {
    if (prefersReducedMotion) return;
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      setWatchers((w) => driftWatchers(w));
    }, 2600);
    return () => clearInterval(interval);
  }, [prefersReducedMotion]);

  // Landing bids: a new bid lands every ~2.5–4.5s (single self-scheduling engine).
  // Price steps + bump, "latest bid" flash, bid count climbs, toast blips, anti-snipe.
  // Reduced motion → no landing bids at all (calm static hero).
  useEffect(() => {
    if (prefersReducedMotion) return;
    let timeoutId: ReturnType<typeof setTimeout>;
    let cancelled = false;

    const landBid = () => {
      if (cancelled) return;
      // Pause while hidden; re-check shortly.
      if (typeof document !== "undefined" && document.hidden) {
        timeoutId = setTimeout(landBid, 1500);
        return;
      }

      const fullNames = lang === "ar" ? AR_NAMES : EN_NAMES;
      const randomName = fullNames[Math.floor(Math.random() * fullNames.length)];
      const firstNames = HERO_FIRST_NAMES[lang];
      const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
      const step = ACTIVE_ITEMS[activeItemIndex].stepPrice;

      setPrices((prevPrices) => {
        const nextPrices = [...prevPrices];
        const nextPrice = stepPriceBy(nextPrices[activeItemIndex], step);
        nextPrices[activeItemIndex] = nextPrice;

        // Schedule log update outside to avoid React state loop issues
        setTimeout(() => {
          setBidLogsList((prevList) => {
            const newList = [...prevList];
            const currentItemLogs = newList[activeItemIndex];
            if (currentItemLogs.some((l) => l.amount === nextPrice)) {
              return prevList;
            }
            const newLog: BidLog = {
              id: `${Date.now()}-${Math.random()}`,
              name: randomName,
              amount: nextPrice,
              time: lang === "ar" ? "الآن" : "Just now"
            };
            newList[activeItemIndex] = [newLog, ...currentItemLogs.slice(0, 5)];
            return newList;
          });
        }, 0);

        return nextPrices;
      });

      // Anti-snipe: a late bid nudges the countdown back up so the lot never dies.
      setTimers((prevTimers) => {
        const nextTimers = [...prevTimers];
        const extended = antiSnipe(nextTimers[activeItemIndex]);
        if (extended !== nextTimers[activeItemIndex]) {
          nextTimers[activeItemIndex] = extended;
          setShowExtensionAlert(true);
          setTimeout(() => setShowExtensionAlert(false), 3000);
        }
        return nextTimers;
      });

      // Climbing bid count + occasional avatar pop
      setBidCount((c) => Math.min(60, c + 1));
      if (Math.random() < 0.4) setExtraAvatars((a) => Math.min(3, a + 1));

      // Price bump + "latest bid" flash
      setPriceBump(true);
      setTimeout(() => setPriceBump(false), 200);
      setFlashHit(true);
      setTimeout(() => setFlashHit(false), 300);

      // "🔥 <FirstName> just bid" toast
      setJustBidToast({ name: firstName, key: Date.now() });

      // Fluctuating competition level
      setCompLevel((prev) => {
        const next = prev + Math.floor(Math.random() * 3) + 1;
        return next > 99 ? 84 : next;
      });

      // Price Pulse Animation
      setPulsePrice(true);
      setTimeout(() => setPulsePrice(false), 600);

      timeoutId = setTimeout(landBid, 2500 + Math.random() * 2000);
    };

    timeoutId = setTimeout(landBid, 1400);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [lang, activeItemIndex, prefersReducedMotion]);

  // Format Helper
  const formatPrice = (val: number): React.ReactNode => {
    const numStr = val.toLocaleString("en-US");
    const currency = lang === "ar" ? "د.أ" : "JOD";
    return (
      <span className="inline-flex items-center gap-1">
        <span className="font-mono" style={{ fontVariantNumeric: "tabular-nums" }}>
          {numStr}
        </span>
        <span className={lang === "ar" ? "font-tajawal text-xs" : "font-sans text-xs"} style={lang === "ar" ? { letterSpacing: "0px" } : undefined}>
          {currency}
        </span>
      </span>
    );
  };

  // Count text in the active language's numerals (Arabic-Indic for ar).
  // `en-US` in BOTH languages. `ar-EG` renders Arabic-Indic digits AND the
  // Arabic thousands separator (١٬٤٢٠), which is the one thing on this page the
  // string sweep could not reach — it is produced at render time, not written
  // in the copy. `utils/arabicNumerals.ts` fixes the policy at
  // ARABIC_UI_DIGITS = 'western' precisely so a number does not change shape
  // with the language; the CountUp on line 691 already used en-US, so this was
  // also inconsistent with the counter sitting beside it.
  const formatCount = (n: number) => n.toLocaleString("en-US");

  // formatTimeLeft and LiveMarketplaceSection hoisted to module scope (see above export)

  // Manual User Bidding Handler
  const handleUserBid = () => {
    setIsAutoCycling(false);
    // Flash button and price
    setPulseUserAction(true);
    setPulsePrice(true);
    setTimeout(() => setPulseUserAction(false), 300);
    setTimeout(() => setPulsePrice(false), 600);

    const step = ACTIVE_ITEMS[activeItemIndex].stepPrice;

    // If timer is extremely low (e.g., less than 60s), extend it as a real auction anti-snipe feature
    if (carTimer < 60) {
      setTimers((prevTimers) => {
        const nextTimers = [...prevTimers];
        nextTimers[activeItemIndex] += 30;
        return nextTimers;
      });
      setShowExtensionAlert(true);
      setTimeout(() => setShowExtensionAlert(false), 3000);
    }

    setPrices((prevPrices) => {
      const nextPrices = [...prevPrices];
      const nextPrice = nextPrices[activeItemIndex] + step;
      nextPrices[activeItemIndex] = nextPrice;

      // Schedule log update
      setTimeout(() => {
        setBidLogsList((prevList) => {
          const newList = [...prevList];
          const currentItemLogs = newList[activeItemIndex];
          if (currentItemLogs.some((l) => l.amount === nextPrice)) {
            return prevList;
          }
          const userLog: BidLog = {
            id: `user-${Date.now()}-${Math.random()}`,
            name: t.interactive.bidLogYou,
            amount: nextPrice,
            time: lang === "ar" ? "الآن" : "Just now",
            isUser: true
          };
          newList[activeItemIndex] = [userLog, ...currentItemLogs.slice(0, 5)];
          return newList;
        });
      }, 0);

      return nextPrices;
    });

    // Bump competition level
    setCompLevel((prev) => Math.min(prev + 2, 99));
  };

  // Form Submission
  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");
    setFormSuccess(false);

    const contactClean = formContact.trim();
    if (!contactClean) {
      setFormError(t.comingSoon.formErrorEmpty);
      return;
    }

    // Contact verification regex: standard email or Jordan phone numbers
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const joPhoneRegex = /^(079|078|077|\+96279|\+96278|\+96277|96279|96278|96277)\d{7}$/;

    const isValidEmail = emailRegex.test(contactClean);
    const isValidPhone = joPhoneRegex.test(contactClean);

    if (!isValidEmail && !isValidPhone) {
      setFormError(t.comingSoon.formErrorEmailPhone);
      return;
    }

    // Save registration
    const newRegistration = {
      name: formName.trim() || (lang === "ar" ? "مستخدم مهتم" : "Interested User"),
      contact: contactClean,
      date: new Date().toISOString().split("T")[0]
    };

    const updatedWaitlist = [newRegistration, ...waitlist];
    setWaitlist(updatedWaitlist);
    try {
      localStorage.setItem("mazzado_waitlist", JSON.stringify(updatedWaitlist));
    } catch (e) {
      console.error("Local storage error", e);
    }

    setFormSuccess(true);
    setFormName("");
    setFormContact("");
  };

  const getLineIcon = (type: string, className = "w-6 h-6 text-accent") => {
    switch (type) {
      case "cat-0":
        return (
          <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.129-.504 1.129-1.125v-3.071M14 6h4a2 2 0 012 2v4H4V8a2 2 0 012-2h8z" />
          </svg>
        );
      case "cat-1":
        return (
          <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
          </svg>
        );
      case "cat-2":
        return (
          <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
            <line x1="12" y1="18" x2="12.01" y2="18" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
      case "cat-3":
        return (
          <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17L17.25 21A1.5 1.5 0 0019 21l2-2a1.5 1.5 0 000-2.12l-5.83-5.83M11.42 15.17l2.42-2.42M11.42 15.17l-4.5-4.5M13.84 12.75l-4.5-4.5M13.84 12.75L21 6a1.5 1.5 0 000-2.12l-2-2a1.5 1.5 0 00-2.12 0l-6.75 6.75M9.34 8.25L3 14.5A1.5 1.5 0 003 16.62l2 2a1.5 1.5 0 002.12 0l6.25-6.25M9.34 8.25l1.08-1.08" />
          </svg>
        );
      case "cat-4":
        return (
          <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        );
      case "cat-5":
        return (
          <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 8.25h15m-16.5 7.5h15m-1.875-12l-3 16.5m-4.5-16.5L7.875 20.25" />
          </svg>
        );
      case "item-car":
        return (
          <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 18.75a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 01-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m3 0h1.125c.621 0 1.129-.504 1.129-1.125v-3.071M14 6h4a2 2 0 012 2v4H4V8a2 2 0 012-2h8z" />
          </svg>
        );
      case "item-phone":
        return (
          <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
            <line x1="12" y1="18" x2="12.01" y2="18" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
      case "item-house":
        return (
          <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
          </svg>
        );
      default:
        return null;
    }
  };

  return (
    <div
      /* `overflow-x-clip`, NOT `overflow-hidden`. The ambient glow circles below
          are absolutely positioned past the left and right edges and need
          clipping — but `overflow-hidden` clips BOTH axes, and an element with a
          non-visible overflow is a scroll container. This root therefore held a
          second, invisible vertical scroller nested inside the document's, with
          565px of range it never showed a scrollbar for. Measured at 1280x800:
  
            fresh load         window.scrollY 0     root.scrollTop 0     hero.top  +77
            after #categories  window.scrollY 5073  root.scrollTop 565   hero.top -5561
            scrolled back up   window.scrollY 0     root.scrollTop 565   hero.top -488
  
          A fragment jump scrolls the nearest scroll container, so the browser
          moved THIS element's scrollTop to its 565px maximum. Scrolling back up
          returns `window.scrollY` to 0 — the scrollbar is visibly at the top —
          but nothing returns `root.scrollTop`, because no scrollbar was ever
          rendered for it. The hero stayed pushed 565px up and read as cropped.
  
          `overflow-x: clip` clips without establishing a scroll container, and it
          leaves the y axis `visible`. `overflow-x: hidden` would NOT do: per
          spec, `hidden` on one axis forces a `visible` other axis to compute to
          `auto`, so the element stays a scroll container and the bug survives.
          The document's scrolling element is now the page's only scroll owner. */
      className="min-h-screen font-sans bg-surface-raised text-fg flex flex-col selection:bg-accent/20 selection:text-accent relative overflow-x-clip"
    >
      
      {/* Scroll Progress Indicator at top of screen */}
      <motion.div
        className="fixed top-0 left-0 right-0 h-[2.5px] bg-accent z-[60]"
        style={{ scaleX, transformOrigin: lang === "ar" ? "right" : "left" }}
      />

      {/* Absolute Background Ambient Glows */}
      <div className="absolute top-[-10%] left-[15%] w-[600px] h-[600px] rounded-full orange-glow-bg pointer-events-none z-0 opacity-40"></div>
      <div className="absolute top-[45%] right-[-10%] w-[700px] h-[700px] rounded-full orange-glow-bg opacity-30 pointer-events-none z-0"></div>
      <div className="absolute bottom-[-5%] left-[-10%] w-[600px] h-[600px] rounded-full orange-glow-bg opacity-30 pointer-events-none z-0"></div>

      {/* 1. Header (Sticky) */}
      <header
        ref={headerRef}
        className={`sticky top-0 z-50 transition-all duration-300 border-b ${
          scrolled
            ? "bg-surface-raised/85 backdrop-blur-md py-2.5 border-line shadow-sm"
            : "bg-surface-raised/85 backdrop-blur-md py-5 border-line"
        }`}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between">
          
          {/* Logo */}
          <div className="z-50 cursor-pointer" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
            <Logo className="h-8" iconClassName="h-8 w-8" textClassName="text-xl font-black text-fg font-sans" />
          </div>

          {/* Desktop Navigation Links with gold sliding underline on hover */}
          <nav className="hidden md:flex items-center gap-8 text-sm font-medium">
            <a href="#why-mazzado" onClick={onSectionLinkClick("why-mazzado")} className={`text-fg/80 hover:text-accent transition-colors duration-200 font-tajawal relative group py-1 ${lang === "en" ? "tracking-wide" : ""}`}>
              {t.nav.whyUs}
              <span className="absolute bottom-0 left-0 w-0 h-[1.5px] bg-accent transition-all duration-300 group-hover:w-full" />
            </a>
            <a href="#categories" onClick={onSectionLinkClick("categories")} className={`text-fg/80 hover:text-accent transition-colors duration-200 font-tajawal relative group py-1 ${lang === "en" ? "tracking-wide" : ""}`}>
              {t.nav.categories}
              <span className="absolute bottom-0 left-0 w-0 h-[1.5px] bg-accent transition-all duration-300 group-hover:w-full" />
            </a>
            <a href="#pricing" onClick={onSectionLinkClick("pricing")} className={`text-fg/80 hover:text-accent transition-colors duration-200 font-tajawal relative group py-1 ${lang === "en" ? "tracking-wide" : ""}`}>
              {t.nav.pricing}
              <span className="absolute bottom-0 left-0 w-0 h-[1.5px] bg-accent transition-all duration-300 group-hover:w-full" />
            </a>
            <button type="button" onClick={() => { emitLandingEvent('browse_cta_clicked', { location: 'nav' }); onEnter(); }} className={`text-fg/80 hover:text-accent transition-colors duration-200 font-tajawal relative group py-1 cursor-pointer ${lang === "en" ? "tracking-wide" : ""}`}>
              {t.nav.comingSoon}
              <span className="absolute bottom-0 left-0 w-0 h-[1.5px] bg-accent transition-all duration-300 group-hover:w-full" />
            </button>
          </nav>

          {/* Action Buttons */}
          <div className="hidden md:flex items-center gap-4">
            {/* Language Switch */}
            <button
              onClick={toggleLang}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-[8px] border border-line hover:border-accent text-fg hover:text-accent transition-all duration-200 bg-surface-raised/60 text-xs font-semibold cursor-pointer"
            >
              <Globe className="w-3.5 h-3.5 text-accent" />
              <span className="font-tajawal">{t.nav.langBtn}</span>
            </button>

            {/* Theme switch — the same shared control the app shell uses */}
            <ThemeToggle isAr={lang !== 'en'} />

            {/* CTA Button */}
            <a
              href={SUPPORT_WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="px-5 py-2.5 rounded-[8px] bg-accent hover:bg-accent-strong text-white text-xs font-bold shadow-sm transition-all duration-300 hover:scale-[1.02] text-center font-tajawal"
            >
              {t.nav.reserveBtn}
            </a>
          </div>

          {/* Mobile Navigation controls */}
          <div className="flex md:hidden items-center gap-3">
            {/* Language switch on mobile */}
            <button
              onClick={toggleLang}
              className="flex items-center gap-1 px-3 py-1.5 rounded-[8px] border border-line text-fg bg-surface-raised text-xs"
            >
              <Globe className="w-3 h-3 text-accent" />
              <span>{t.nav.langBtn}</span>
            </button>

            <ThemeToggle isAr={lang !== 'en'} />

            {/* Hamburger button */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="p-1.5 rounded-[8px] border border-line hover:bg-surface text-fg focus:outline-none"
              aria-label={lang === 'ar' ? 'فتح القائمة' : 'Toggle menu'}
            >
              {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>

        </div>
      </header>

      {/* Mobile Drawer Menu */}
      <div
        className={`fixed inset-x-0 top-[65px] bg-surface-raised/95 backdrop-blur-xl border-b border-line z-40 transition-all duration-300 md:hidden ${
          mobileMenuOpen ? "opacity-100 translate-y-0 shadow-lg" : "opacity-0 -translate-y-4 pointer-events-none"
        }`}
      >
        <div className="px-6 py-8 space-y-5 flex flex-col bg-surface-raised">
          <a
            href="#why-mazzado"
            onClick={onSectionLinkClick("why-mazzado")}
            className="text-base font-semibold text-fg hover:text-accent py-2 border-b border-line/40 transition-colors duration-200 font-tajawal"
          >
            {t.nav.whyUs}
          </a>
          <a
            href="#categories"
            onClick={onSectionLinkClick("categories")}
            className="text-base font-semibold text-fg hover:text-accent py-2 border-b border-line/40 transition-colors duration-200 font-tajawal"
          >
            {t.nav.categories}
          </a>
          <a
            href="#pricing"
            onClick={onSectionLinkClick("pricing")}
            className="text-base font-semibold text-fg hover:text-accent py-2 border-b border-line/40 transition-colors duration-200 font-tajawal"
          >
            {t.nav.pricing}
          </a>
          <button
            type="button"
            onClick={() => { emitLandingEvent('browse_cta_clicked', { location: 'mobile_menu' }); setMobileMenuOpen(false); onEnter(); }}
            className="text-start text-base font-semibold text-fg hover:text-accent py-2 border-b border-line/40 transition-colors duration-200 font-tajawal cursor-pointer"
          >
            {t.nav.comingSoon}
          </button>
          
          <a
            href={SUPPORT_WHATSAPP_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setMobileMenuOpen(false)}
            className="w-full text-center py-3 rounded-[8px] bg-accent text-white font-bold text-sm shadow-sm font-tajawal block"
          >
            {t.nav.reserveBtn}
          </a>
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-grow z-10">

        {/* 2. Hero Section */}
        <section 
          id="hero-section"
          className="relative pt-8 pb-16 lg:pt-16 lg:pb-24 px-4 sm:px-6 lg:px-8"
          style={{ backgroundImage: "radial-gradient(circle at 50% 0%, rgba(240, 81, 35, 0.04) 0%, rgba(255, 255, 255, 0) 70%)" }}
        >
          {/* Live-room simulator motion — ALL keyframes gated behind prefers-reduced-motion: no-preference */}
          <style>{`
            .hero-phwrap { transform: rotate(-3deg); }
            @media (prefers-reduced-motion: no-preference) {
              @keyframes hero-float { 50% { transform: rotate(-3deg) translateY(-9px); } }
              .hero-phwrap { animation: hero-float 6s ease-in-out infinite; }
              .hero-sheen::after {
                content: ""; position: absolute; top: 0; left: -60%; width: 40%; height: 100%;
                background: linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent);
                animation: hero-sheen 3.4s infinite; pointer-events: none;
              }
              @keyframes hero-sheen { 0% { left: -60%; } 55%, 100% { left: 130%; } }
              @keyframes hero-toast { 0% { opacity: 0; transform: translateY(6px); } 12%, 72% { opacity: 1; transform: translateY(0); } 100% { opacity: 0; transform: translateY(-6px); } }
              .hero-toast { animation: hero-toast 2.2s ease forwards; }
              @keyframes hero-tick { 50% { opacity: 0.45; } }
              .hero-timer-tick { animation: hero-tick 1s infinite; }
              @keyframes hero-pop { 0% { transform: scale(0); } 70% { transform: scale(1.25); } 100% { transform: scale(1); } }
              .hero-avatar-pop { animation: hero-pop 0.4s; }
            }
          `}</style>
          <div className="max-w-7xl mx-auto">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-8 items-center">
              
              {/* Left Column (Main Text Copy) - Orchestrated Staggered Entrance */}
              <motion.div
                initial="hidden"
                animate="visible"
                variants={{
                  hidden: {},
                  visible: {
                    transition: {
                      staggerChildren: 0.12
                    }
                  }
                }}
                className="relative z-10 lg:col-span-7 space-y-6 text-center lg:text-start"
              >
                
                {/* Badge */}
                <motion.div
                  variants={{
                    hidden: { opacity: 0, y: 24 },
                    visible: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] } }
                  }}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-accent/10 border border-accent/20 text-xs text-accent font-semibold font-tajawal mx-auto lg:mx-0"
                >
                  <Sparkles className="w-3.5 h-3.5 text-accent" />
                  <span>{t.hero.badge}</span>
                </motion.div>

                {/* Heading with self-drawing gold line */}
                <motion.h1
                  variants={{
                    hidden: { opacity: 0, y: 24 },
                    visible: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] } }
                  }}
                  // Arabic gets more air and no negative tracking, both for the
                  // same reason: this script carries marks OUTSIDE the line box.
                  // «وبِع أسرع.» hangs a kasra below its letters and «اشترِ» one
                  // above, so at leading 1.45 with a 10px gap the two lines
                  // measured 10px apart as boxes and touched as glyphs.
                  // `tracking-[-0.03em]` is a Latin habit — tightening a cursive
                  // script pulls joined letters into each other; Arabic keeps
                  // normal tracking and only the Latin branch is tightened.
                  className={`text-4xl sm:text-5xl lg:text-5xl xl:text-6xl font-black text-fg font-alexandria flex flex-col items-center lg:items-start ${lang === 'ar' ? 'leading-[1.65] gap-4' : 'tracking-[-0.03em] leading-[1.02] gap-1'}`}
                >
                  <span className="block">{t.hero.titleFirst}</span>
                  <span className="text-accent block relative pb-1">
                    {t.hero.titleGradient}
                    <svg className={`absolute left-0 bottom-[-2px] w-full h-2 overflow-visible ${prefersReducedMotion ? "" : "animate-pulse-slow"}`} viewBox="0 0 100 10" preserveAspectRatio="none">
                      <motion.path
                        d="M0,5 Q50,0 100,5"
                        fill="none"
                        stroke={ACCENT}
                        strokeWidth="3"
                        strokeLinecap="round"
                        initial={{ pathLength: 0 }}
                        animate={{ pathLength: 1 }}
                        transition={{ delay: 0.9, duration: 1, ease: "easeInOut" }}
                      />
                    </svg>
                  </span>
                  {/* Guarded: the headline is two lines now. This h1 is a flex
                      column with a gap, so an empty third span would still be a
                      flex item and leave the gap behind as a blank line under
                      the headline. */}
                  {t.hero.titleLast && <span className="block">{t.hero.titleLast}</span>}
                </motion.h1>

                {/* Paragraph */}
                <motion.p
                  variants={{
                    hidden: { opacity: 0, y: 24 },
                    visible: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] } }
                  }}
                  className="text-fg text-base sm:text-lg max-w-xl mx-auto lg:mx-0 leading-relaxed font-tajawal font-medium pt-3"
                >
                  {t.hero.desc}
                </motion.p>

                {/* Action buttons */}
                <motion.div
                  variants={{
                    hidden: { opacity: 0, y: 24 },
                    visible: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] } }
                  }}
                  className="flex flex-col sm:flex-row items-center justify-center lg:justify-start gap-4 pt-2"
                >
                  {/* The page's one primary action. Same component, same glow,
                      same size as every other primary further down — see
                      LandingButton for why that mattered. */}
                  <LandingButton
                    onClick={() => { emitLandingEvent('browse_cta_clicked', { location: 'hero' }); onEnter(); }}
                    className="w-full sm:w-auto group"
                    trailing={
                      <span aria-hidden="true" className="inline-block transition-transform duration-300 group-hover:translate-x-1.5 rtl:group-hover:-translate-x-1.5 motion-reduce:transition-none">→</span>
                    }
                  >
                    {t.hero.ctaPrimary}
                  </LandingButton>
                  <LandingButton
                    variant="secondary"
                    onClick={() => { emitLandingEvent('seller_cta_clicked', { location: 'hero' }); onEnter('upload'); }}
                    className="w-full sm:w-auto"
                  >
                    {t.hero.ctaSecondary}
                  </LandingButton>
                </motion.div>

                {/* The seller's benefit, scannable, sitting with the seller's
                    button rather than in the buyer-facing headline.
                    «خلال دقائق», NOT «خلال 15 دقيقة»: the only 15-minute figure
                    anywhere in this codebase is `dropDuration.ts`'s 900-second
                    AUCTION LENGTH option — nothing measures how long listing
                    takes, so a number here would be invented. (That option is
                    the likely origin of the old «بِعه خلال 15 دقيقة» line, which
                    promised a completed SALE on the strength of an auction
                    duration.) */}
                <motion.p
                  variants={{
                    hidden: { opacity: 0, y: 24 },
                    visible: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] } }
                  }}
                  className="text-xs sm:text-sm text-fg-muted font-tajawal text-center lg:text-start"
                >
                  {t.hero.sellerNote}
                </motion.p>

                {/* Real proof row */}
                <motion.div
                  variants={{
                    hidden: { opacity: 0, y: 24 },
                    visible: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] } }
                  }}
                  className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-5 pt-6 border-t border-line"
                >
                  {t.hero.proof.map((s, i) => {
                    const Icon = HERO_PROOF_ICONS[i] ?? Lock;
                    return (
                      // Icon ABOVE the words, not beside them. The hero copy column is
                      // ~166px per cell at 1024, and an inline icon left too little
                      // room for «توصيل خلال 48 ساعة» — it broke across two lines while
                      // its neighbours sat on one, which read as a mistake.
                      <div key={i} className="flex flex-col items-center lg:items-start gap-2 text-center lg:text-start">
                        <span className="shrink-0 flex h-9 w-9 items-center justify-center rounded-xl border border-accent/25 bg-accent/10">
                          <Icon aria-hidden="true" strokeWidth={1.75} className="h-5 w-5 text-accent" />
                        </span>
                        <div className="min-w-0">
                          <div dir={/^[0-9]/.test(s.value) ? "ltr" : undefined} className="text-sm sm:text-base font-extrabold text-fg font-alexandria leading-tight">{s.value}</div>
                          <div className="text-[11px] sm:text-xs font-medium text-fg-muted font-tajawal leading-snug mt-0.5">{s.label}</div>
                        </div>
                      </div>
                    );
                  })}
                </motion.div>

              </motion.div>

              {/* Right Column (Interactive Live Auction Card) enters last */}
              <div className="lg:col-span-5 flex justify-center lg:justify-end relative my-auto py-4 w-full">
                
                {/* Soft blurred orange gradient blob behind the card */}
                <div className="absolute inset-0 m-auto w-[420px] h-[420px] max-w-full rounded-full bg-gradient-to-tr from-accent/25 via-accent/15 to-amber-200/20 filter blur-3xl pointer-events-none -z-10 opacity-80" />

                {/* Second/third-lot peeks — a small deck of live lots flanking the phone, balances the composition */}
                {/* Watch — upper left, pulled out so it reads clearly next to the phone */}
                <div
                  aria-hidden="true"
                  className="hidden lg:block absolute top-6 start-0 xl:start-[-76px] z-0 w-[248px] rounded-[22px] overflow-hidden shadow-[0_28px_64px_rgba(0,0,0,0.32)] -rotate-[10deg] opacity-95 pointer-events-none select-none bg-surface-raised border border-black/5"
                >
                  <img
                    src="https://images.unsplash.com/photo-1523170335258-f5ed11844a49?auto=format&fit=crop&w=600&q=80"
                    alt=""
                    referrerPolicy="no-referrer"
                    className="w-full h-[188px] object-cover block"
                    onError={(e) => {
                      const target = e.target as HTMLImageElement;
                      target.style.display = "none";
                      if (target.parentElement) {
                        target.parentElement.style.backgroundImage =
                          "radial-gradient(120% 120% at 30% 20%, #2a2a2e, #0d0d0f)";
                      }
                    }}
                  />
                  <div className="bg-[#0A0A0A] text-white px-3.5 py-3 flex items-center justify-between">
                    <div className="min-w-0">
                      <span className="block text-[12px] font-bold font-alexandria truncate">{lang === "ar" ? "رولكس ديت جست 41" : "Rolex Datejust 41"}</span>
                      <span className="block text-[9px] text-white/50 font-tajawal mt-0.5">{lang === "ar" ? "ساعات · مباشر" : "Watches · Live"}</span>
                    </div>
                    <span dir="ltr" className="text-accent font-mono font-black text-sm flex items-center gap-1 shrink-0">
                      <span className={`w-1.5 h-1.5 rounded-full bg-accent ${prefersReducedMotion ? "" : "animate-pulse"}`} />
                      2,150
                    </span>
                  </div>
                </div>
                {/* Car — lower left, overlapping below the watch to form the deck */}
                <div
                  aria-hidden="true"
                  className="hidden lg:block absolute top-[356px] start-[-28px] z-0 w-[232px] rounded-[22px] overflow-hidden shadow-[0_28px_64px_rgba(0,0,0,0.30)] rotate-[7deg] opacity-95 pointer-events-none select-none bg-surface-raised border border-black/5"
                >
                  <img
                    src="https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=600&q=80"
                    alt=""
                    referrerPolicy="no-referrer"
                    className="w-full h-[172px] object-cover block"
                    onError={(e) => {
                      const target = e.target as HTMLImageElement;
                      target.style.display = "none";
                      if (target.parentElement) {
                        target.parentElement.style.backgroundImage =
                          "radial-gradient(120% 120% at 30% 20%, #2a2a2e, #0d0d0f)";
                      }
                    }}
                  />
                  <div className="bg-[#0A0A0A] text-white px-3.5 py-3 flex items-center justify-between">
                    <div className="min-w-0">
                      <span className="block text-[12px] font-bold font-alexandria truncate">{lang === "ar" ? "بورش 911" : "Porsche 911"}</span>
                      <span className="block text-[9px] text-white/50 font-tajawal mt-0.5">{lang === "ar" ? "مركبات · مباشر" : "Vehicles · Live"}</span>
                    </div>
                    <span dir="ltr" className="text-accent font-mono font-black text-sm flex items-center gap-1 shrink-0">
                      <span className={`w-1.5 h-1.5 rounded-full bg-accent ${prefersReducedMotion ? "" : "animate-pulse"}`} />
                      42,500
                    </span>
                  </div>
                </div>

                {/* Premium Floating Reels Card Container with Phone Bezel */}
                <div className={`relative z-10 w-full max-w-[370px] ${prefersReducedMotion ? "-rotate-3" : "hero-phwrap"}`}>
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: 20 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1], delay: 0.6 }}
                  className="w-full h-[clamp(500px,62vh,640px)] sm:h-[640px] rounded-[38px] border-[5px] border-gray-900 bg-gray-950 text-white relative shadow-[0_25px_60px_-10px_rgba(240,81,35,0.35)] overflow-hidden flex flex-col justify-between p-4 selection:bg-accent select-none group"
                  id="hero-live-card"
                  onMouseEnter={() => setIsAutoCycling(false)}
                >
                  {/* Glowing warm orange aura behind card */}
                  <div className={`absolute -inset-2 bg-gradient-to-r from-accent/25 via-accent-strong/20 to-[#FF8C00]/25 rounded-[44px] blur-2xl opacity-75 ${prefersReducedMotion ? "" : "animate-pulse"} -z-10 pointer-events-none`} />

                  {/* Phone Bezel Top Notch */}
                  <div className="w-20 h-4 bg-gray-900 rounded-b-xl mx-auto absolute top-0 left-1/2 -translate-x-1/2 z-30 flex items-center justify-center gap-1.5 shadow-inner">
                    <span className="w-2.5 h-2.5 rounded-full bg-black border border-gray-800" />
                    <span className="w-4 h-1 rounded-full bg-gray-800" />
                  </div>

                  {/* FULL-BLEED REELS MEDIA BACKGROUND */}
                  <div className="absolute inset-0 z-0 overflow-hidden bg-gray-900">
                    <img
                      src={currentItem.image}
                      alt={lang === "ar" ? currentItem.titleAr : currentItem.titleEn}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover group-hover:scale-105 transition-all duration-1000 opacity-90"
                      key={currentItem.id}
                      onError={(e) => {
                        const target = e.target as HTMLImageElement;
                        if (target.dataset.fallback === "done") return;
                        if (currentItem.id === "phone") {
                          if (target.src.includes("/iphone.png")) {
                            target.src = "/iphone.jpg";
                            return;
                          }
                          if (target.src.includes("/iphone.jpg")) {
                            target.src = "/src/iphone.png";
                            return;
                          }
                        }
                        // Final fallback for any lot: warm gradient, never a broken image
                        target.dataset.fallback = "done";
                        target.style.display = "none";
                        if (target.parentElement) {
                          target.parentElement.style.backgroundImage =
                            "radial-gradient(120% 120% at 30% 20%, #2a2a2e, #0d0d0f)";
                        }
                      }}
                    />
                    {/* Top and Bottom Reels Vignette Gradients */}
                    <div className="absolute inset-0 bg-gradient-to-b from-black/85 via-black/25 to-black/95 pointer-events-none" />
                  </div>

                  {/* "🔥 <name> just bid" toast — blips in on each landing bid */}
                  {justBidToast && !prefersReducedMotion && (
                    <div
                      key={justBidToast.key}
                      className={`hero-toast absolute top-[120px] ${lang === "ar" ? "right-3" : "left-3"} z-20 bg-black/80 backdrop-blur-md border border-white/15 text-white text-[10.5px] font-bold font-tajawal px-2.5 py-1.5 rounded-full pointer-events-none shadow-lg`}
                      onAnimationEnd={() => setJustBidToast(null)}
                    >
                      🔥 {justBidToast.name} {lang === "ar" ? "زايد الآن" : "just bid"}
                    </div>
                  )}

                  {/* Z-10 TOP OVERLAY: REELS HEADER */}
                  <div className="relative z-10 pt-3">
                    {/* Reels Streamer Profile & Live Badge Row */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 bg-black/50 backdrop-blur-md px-2.5 py-1.5 rounded-full border border-white/15">
                        <div className="relative flex shrink-0">
                          <img 
                            src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=100&q=80" 
                            alt={lang === 'ar' ? 'بث مزادو' : 'Mazzado Streamer'} 
                            className="w-7 h-7 rounded-full object-cover border-2 border-accent" 
                          />
                          <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-black ${prefersReducedMotion ? "" : "animate-pulse"}`} />
                        </div>
                        <div className={`flex flex-col ${lang === "ar" ? "text-right" : "text-left"}`}>
                          <span className="text-xs font-bold text-white font-alexandria leading-none flex items-center gap-1">
                            {lang === "ar" ? "مزادو مباشر" : "Mazzado Live"}
                            <Sparkles className="w-3 h-3 text-amber-400" />
                          </span>
                          <span className="text-[9px] text-gray-300 font-tajawal flex items-center gap-1 mt-0.5">
                            <Eye className="w-2.5 h-2.5 text-emerald-400" />
                            <span dir="ltr" className="font-mono" style={{ fontVariantNumeric: "tabular-nums" }}>{formatCount(watchers)}</span>
                            {lang === "ar" ? "يشاهدون" : "watching"}
                          </span>
                        </div>
                      </div>

                      {/* Live Badge Pill */}
                      <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full bg-accent text-white text-[11px] font-bold font-tajawal shadow-lg shadow-accent/40 border border-white/20 ${prefersReducedMotion ? "" : "animate-pulse"}`}>
                        <span className={`w-2 h-2 rounded-full bg-surface-raised ${prefersReducedMotion ? "" : "animate-ping"}`} />
                        <span>{lang === "ar" ? "بث المزاد 🔴" : "LIVE 🔴"}</span>
                      </div>
                    </div>
                  </div>

                  {/* Z-10 BOTTOM OVERLAY: REELS DETAILS & INSTANT BID */}
                  <div className="relative z-10 space-y-2.5 pb-1">
                    {/* Dynamic Auto-Extension Alert Banner */}
                    {showExtensionAlert && (
                      <motion.div 
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="bg-amber-500/90 text-black backdrop-blur-md px-3 py-1.5 rounded-xl text-xs font-bold font-tajawal shadow-lg flex items-center gap-1.5 border border-amber-300"
                      >
                        <Bell className="w-3.5 h-3.5 text-black animate-ring shrink-0" />
                        <span>{lang === "ar" ? "⏱ تم تمديد الوقت دقيقة إضافية للمنافسة!" : "⏱ Extended +1 min for live bids!"}</span>
                      </motion.div>
                    )}

                    {/* "Latest bid" chip — flashes an orange ring + price bump on each landing bid */}
                    <div className={`max-w-[85%] bg-black/60 backdrop-blur-md rounded-2xl px-3 py-2.5 border border-white/15 shadow-xl flex items-center justify-between gap-3 transition-all duration-300 ${flashHit ? "ring-2 ring-accent ring-offset-0 -translate-y-0.5" : ""}`}>
                      <div className="flex items-center gap-1.5 text-[10px] text-amber-300 font-bold font-tajawal uppercase tracking-wide">
                        <Flame className={`w-3 h-3 text-accent ${prefersReducedMotion ? "" : "animate-pulse"}`} />
                        <span>{lang === "ar" ? "آخر مزايدة 🔥" : "Latest bid 🔥"}</span>
                      </div>
                      <span dir="ltr" className={`text-sm text-accent font-black font-mono inline-block transition-transform duration-200 ${priceBump ? "scale-[1.14]" : "scale-100"}`}>
                        {formatPrice(currentPrice)}
                      </span>
                    </div>

                    {/* Product Title & Badge */}
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="bg-accent/90 text-white text-[10px] font-bold px-2 py-0.5 rounded-md font-tajawal">
                          {lang === "ar" ? currentItem.badgeAr : currentItem.badgeEn}
                        </span>
                        <span className="text-[10px] text-gray-300 font-tajawal">
                          {lang === "ar" ? "الرقم المرجعي: #JO-22419" : "Ref: #JO-22419"}
                        </span>
                      </div>
                      <h3 className="text-lg font-bold text-white font-alexandria leading-snug drop-shadow-md">
                        {lang === "ar" ? currentItem.titleAr : currentItem.titleEn}
                      </h3>
                      <p className="text-xs text-gray-300 font-tajawal line-clamp-1 drop-shadow-sm">
                        {lang === "ar" ? currentItem.detailsAr : currentItem.detailsEn}
                      </p>
                    </div>

                    {/* Price & Countdown Timer Bar */}
                    <div className="bg-black/60 backdrop-blur-md rounded-2xl p-3 border border-white/15 flex items-center justify-between shadow-xl">
                      <div>
                        <span className="text-[10px] text-gray-300 font-bold uppercase font-tajawal block">
                          {lang === "ar" ? "السعر الحالي" : "Current Bid"}
                        </span>
                        <div className="overflow-hidden relative h-6">
                          <AnimatePresence mode="popLayout">
                            <motion.span
                              key={currentPrice}
                              initial={{ y: 15, opacity: 0 }}
                              animate={{ y: 0, opacity: 1 }}
                              exit={{ y: -15, opacity: 0 }}
                              transition={{ duration: 0.3 }}
                              className="text-lg sm:text-xl font-black text-amber-400 block font-mono"
                            >
                              {formatPrice(currentPrice)}
                            </motion.span>
                          </AnimatePresence>
                        </div>
                      </div>

                      <div className="text-end">
                        <span className="text-[10px] text-gray-300 font-bold uppercase font-tajawal block">
                          {lang === "ar" ? "الوقت المتبقي" : "Ends In"}
                        </span>
                        <span dir="ltr" className={`text-xs font-mono font-extrabold flex items-center gap-1 justify-end bg-black/80 border px-2.5 py-1 rounded-lg mt-0.5 shadow-inner transition-colors duration-300 ${carTimer < 12 ? "text-[#FF5A4D] border-[#FF5A4D]/50" : "text-accent border-accent/40"} ${carTimer < 12 && !prefersReducedMotion ? "hero-timer-tick" : ""}`} style={{ fontVariantNumeric: "tabular-nums" }}>
                          <Clock className={`w-3.5 h-3.5 ${carTimer < 12 ? "text-[#FF5A4D]" : "text-accent"} ${prefersReducedMotion ? "" : "animate-pulse"}`} />
                          {formatCountdown(carTimer)}
                        </span>
                      </div>
                    </div>

                    {/* Main Reels Instant Bid Button */}
                    <motion.button
                      whileTap={{ scale: 0.96 }}
                      onClick={handleUserBid}
                      className="hero-sheen w-full py-3.5 rounded-2xl bg-gradient-to-r from-accent via-accent to-accent hover:brightness-110 text-white font-extrabold text-sm shadow-[0_10px_25px_-5px_rgba(240,81,35,0.6)] transition-all duration-300 cursor-pointer flex items-center justify-center gap-2 border border-white/20 relative overflow-hidden group/bid"
                    >
                      <span className="absolute inset-0 bg-surface-raised/20 translate-x-[-100%] group-hover/bid:translate-x-[100%] transition-transform duration-700 pointer-events-none" />
                      <Hammer className={`w-4 h-4 text-white ${prefersReducedMotion ? "" : "animate-bounce"}`} />
                      <span className="font-tajawal tracking-wide text-sm">
                        {lang === "ar" 
                          /* en-US in both branches: this is money, and
                             `formatMoney` renders every other amount in the app
                             in Western digits regardless of language. `ar-JO`
                             made this the only price on the page shaped
                             differently from the rest. */
                          ? `زايد الآن (+${currentItem.stepPrice.toLocaleString("en-US")} د.أ)`
                          : `Bid Now (+${currentItem.stepPrice.toLocaleString("en-US")} JOD)`}
                      </span>
                    </motion.button>

                    {/* Active Bidders Footer Row */}
                    <div className="flex items-center justify-between text-[11px] text-gray-300 font-tajawal px-1 pt-0.5">
                      <div className="flex items-center gap-1.5">
                        <div className="flex -space-x-1.5 rtl:space-x-reverse">
                          <img src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=100&q=80" alt={lang === 'ar' ? 'مزايد' : 'Bidder'} className="w-4 h-4 rounded-full object-cover border border-black" />
                          <img src="https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=100&q=80" alt={lang === 'ar' ? 'مزايد' : 'Bidder'} className="w-4 h-4 rounded-full object-cover border border-black" />
                          <img src="https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=100&q=80" alt={lang === 'ar' ? 'مزايد' : 'Bidder'} className="w-4 h-4 rounded-full object-cover border border-black" />
                          {/* Occasional avatar pops in as bids land */}
                          {Array.from({ length: extraAvatars }).map((_, i) => (
                            <span
                              key={i}
                              aria-hidden="true"
                              className={`w-4 h-4 rounded-full border border-black bg-gradient-to-br from-gray-500 to-gray-800 ${prefersReducedMotion ? "" : "hero-avatar-pop"}`}
                            />
                          ))}
                        </div>
                        <span dir="ltr" className="text-[10px] text-gray-300 font-bold" style={{ fontVariantNumeric: "tabular-nums" }}>
                          {formatCount(bidCount)} {lang === "ar" ? "مزايد نشط" : "bidders active"}
                        </span>
                      </div>

                      <span className="text-[10px] font-bold text-emerald-400 flex items-center gap-1">
                        <span className={`w-1.5 h-1.5 rounded-full bg-emerald-400 ${prefersReducedMotion ? "" : "animate-ping"}`} />
                        {lang === "ar" ? "متواجدين الآن" : "Live Now"}
                      </span>
                    </div>
                  </div>

                </motion.div>
                </div>

              </div>

            </div>

          </div>
        </section>

        {/* 2.5 Section: How it works (كيف بيشتغل مزادو) */}
        <section id="how-it-works" className="py-[96px] bg-surface-raised border-b border-line relative overflow-hidden">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
            <Reveal>
              <div className="flex flex-col items-center text-center max-w-3xl mx-auto mb-12">
                <span className={`inline-block px-3.5 py-1 rounded-full bg-accent/10 text-accent text-xs font-bold font-tajawal border border-accent/20 mb-3 ${lang === "en" ? "tracking-wide" : ""}`}>
                  {lang === "ar" ? "خطواتنا" : "Our Process"}
                </span>
                <h2 className="text-4xl md:text-5xl font-bold text-fg font-tajawal mb-4 leading-tight">
                  {lang === "ar" ? "كيف بيشتغل مزادو؟" : "How does Mazzado work?"}
                </h2>
                <p className="text-lg text-fg-muted font-tajawal">
                  {lang === "ar" ? "أربع خطوات بسيطة وواضحة." : "Four simple, transparent steps."}
                </p>
              </div>
            </Reveal>

            {/* Tab Switcher */}
            <Reveal delay={0.1}>
              <div className="flex justify-center mb-12">
                <div className="inline-flex bg-[#0A0A0A]/5 p-1 rounded-full border border-line">
                  <button
                    onClick={() => setHowItWorksTab("buyer")}
                    className={`px-6 py-3 min-h-[44px] flex items-center justify-center rounded-full text-sm font-bold font-tajawal transition-all duration-300 ${
                      howItWorksTab === "buyer"
                        ? "bg-accent text-white shadow-sm"
                        : "text-fg-muted hover:text-fg"
                    }`}
                  >
                    {lang === "ar" ? "أنا مشتري" : "I am a Buyer"}
                  </button>
                  <button
                    onClick={() => setHowItWorksTab("seller")}
                    className={`px-6 py-3 min-h-[44px] flex items-center justify-center rounded-full text-sm font-bold font-tajawal transition-all duration-300 ${
                      howItWorksTab === "seller"
                        ? "bg-accent text-white shadow-sm"
                        : "text-fg-muted hover:text-fg"
                    }`}
                  >
                    {lang === "ar" ? "أنا بائع" : "I am a Seller"}
                  </button>
                </div>
              </div>
            </Reveal>

            {/* Steps Grid container with tab switching animations */}
            <AnimatePresence mode="wait">
              <motion.div
                key={howItWorksTab}
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -15 }}
                transition={{ duration: 0.3 }}
                className="grid grid-cols-1 md:grid-cols-4 gap-6 relative"
              >
                {howItWorksTab === "buyer" ? (
                  <>
                    {/* Buyer Step 1 */}
                    <div className="brand-card rounded-2xl shadow-sm hover:shadow-lg transition-all duration-300 hover:scale-[1.02] bg-surface-raised border border-line p-6 relative flex flex-col items-center text-center">
                      <div className="absolute top-4 left-4 w-8 h-8 rounded-full bg-accent/10 text-accent font-bold font-mono flex items-center justify-center text-sm">
                        1
                      </div>
                      <div className="w-14 h-14 rounded-xl bg-accent-weak flex items-center justify-center mb-5 text-accent">
                        <Search className="w-7 h-7" />
                      </div>
                      <h3 className="text-lg font-bold text-fg font-tajawal mb-2">
                        {lang === "ar" ? "تصفح وافحص" : "Browse & Inspect"}
                      </h3>
                      <p className="text-sm text-fg-muted font-tajawal leading-relaxed">
                        {lang === "ar" ? "شوف الصور والتفاصيل الكاملة لكل منتج قبل ما تزايد" : "See the full photos and details for each product before you bid."}
                      </p>
                      
                      <div className="hidden md:block absolute top-[2.75rem] -right-3 translate-x-1/2 z-10 text-accent/40 animate-pulse">
                        <svg className="w-5 h-5 transform rtl:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </div>

                    {/* Buyer Step 2 */}
                    <div className="brand-card rounded-2xl shadow-sm hover:shadow-lg transition-all duration-300 hover:scale-[1.02] bg-surface-raised border border-line p-6 relative flex flex-col items-center text-center">
                      <div className="absolute top-4 left-4 w-8 h-8 rounded-full bg-accent/10 text-accent font-bold font-mono flex items-center justify-center text-sm">
                        2
                      </div>
                      <div className="w-14 h-14 rounded-xl bg-accent-weak flex items-center justify-center mb-5 text-accent">
                        <Hammer className="w-7 h-7" />
                      </div>
                      <h3 className="text-lg font-bold text-fg font-tajawal mb-2">
                        {lang === "ar" ? "زايد براحتك" : "Bid with Ease"}
                      </h3>
                      <p className="text-sm text-fg-muted font-tajawal leading-relaxed">
                        {lang === "ar" ? "السعر بيرتفع أوتوماتيك، بدون تفاوض ولا مساومة" : "The price rises automatically, with no negotiations or haggling."}
                      </p>
                      
                      <div className="hidden md:block absolute top-[2.75rem] -right-3 translate-x-1/2 z-10 text-accent/40 animate-pulse">
                        <svg className="w-5 h-5 transform rtl:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </div>

                    {/* Buyer Step 3 */}
                    <div className="brand-card rounded-2xl shadow-sm hover:shadow-lg transition-all duration-300 hover:scale-[1.02] bg-surface-raised border border-line p-6 relative flex flex-col items-center text-center">
                      <div className="absolute top-4 left-4 w-8 h-8 rounded-full bg-accent/10 text-accent font-bold font-mono flex items-center justify-center text-sm">
                        3
                      </div>
                      <div className="w-14 h-14 rounded-xl bg-accent-weak flex items-center justify-center mb-5 text-accent">
                        <Lock className="w-7 h-7" />
                      </div>
                      <h3 className="text-lg font-bold text-fg font-tajawal mb-2">
                        {lang === "ar" ? "فلوسك محجوزة" : "Held Until You Confirm"}
                      </h3>
                      <p className="text-sm text-fg-muted font-tajawal leading-relaxed">
                        {lang === "ar" ? "لما تربح، فلوسك تنحجز بالضمان، ما بتوصل للبائع لسا" : "When you win, your funds are securely held in escrow and not yet sent."}
                      </p>
                      
                      <div className="hidden md:block absolute top-[2.75rem] -right-3 translate-x-1/2 z-10 text-accent/40 animate-pulse">
                        <svg className="w-5 h-5 transform rtl:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </div>

                    {/* Buyer Step 4 */}
                    <div className="brand-card rounded-2xl shadow-sm hover:shadow-lg transition-all duration-300 hover:scale-[1.02] bg-surface-raised border border-line p-6 relative flex flex-col items-center text-center">
                      <div className="absolute top-4 left-4 w-8 h-8 rounded-full bg-accent/10 text-accent font-bold font-mono flex items-center justify-center text-sm">
                        4
                      </div>
                      <div className="w-14 h-14 rounded-xl bg-accent-weak flex items-center justify-center mb-5 text-accent">
                        <CheckCircle2 className="w-7 h-7" />
                      </div>
                      <h3 className="text-lg font-bold text-fg font-tajawal mb-2">
                        {lang === "ar" ? "استلم ووافق" : "Receive & Approve"}
                      </h3>
                      <p className="text-sm text-fg-muted font-tajawal leading-relaxed">
                        {lang === "ar" ? "افحص المنتج، ولما توافق، وقتها بس تنطلق الفلوس" : "Inspect the product, and only when you approve, the funds are released."}
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    {/* Seller Step 1 */}
                    <div className="brand-card rounded-2xl shadow-sm hover:shadow-lg transition-all duration-300 hover:scale-[1.02] bg-surface-raised border border-line p-6 relative flex flex-col items-center text-center">
                      <div className="absolute top-4 left-4 w-8 h-8 rounded-full bg-accent/10 text-accent font-bold font-mono flex items-center justify-center text-sm">
                        1
                      </div>
                      <div className="w-14 h-14 rounded-xl bg-accent-weak flex items-center justify-center mb-5 text-accent">
                        <Camera className="w-7 h-7" />
                      </div>
                      <h3 className="text-lg font-bold text-fg font-tajawal mb-2">
                        {lang === "ar" ? "ارفع منتجك" : "List Your Product"}
                      </h3>
                      <p className="text-sm text-fg-muted font-tajawal leading-relaxed">
                        {lang === "ar" ? "صوّره وارفعه، بدون أي رسم عرض حالياً" : "Take photos and list your product, completely free of any listing fees right now."}
                      </p>
                      
                      <div className="hidden md:block absolute top-[2.75rem] -right-3 translate-x-1/2 z-10 text-accent/40 animate-pulse">
                        <svg className="w-5 h-5 transform rtl:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </div>

                    {/* Seller Step 2 */}
                    <div className="brand-card rounded-2xl shadow-sm hover:shadow-lg transition-all duration-300 hover:scale-[1.02] bg-surface-raised border border-line p-6 relative flex flex-col items-center text-center">
                      <div className="absolute top-4 left-4 w-8 h-8 rounded-full bg-accent/10 text-accent font-bold font-mono flex items-center justify-center text-sm">
                        2
                      </div>
                      <div className="w-14 h-14 rounded-xl bg-accent-weak flex items-center justify-center mb-5 text-accent">
                        <Wrench className="w-7 h-7" />
                      </div>
                      <h3 className="text-lg font-bold text-fg font-tajawal mb-2">
                        {lang === "ar" ? "نجهّزه ونعرضه" : "Prepare & List"}
                      </h3>
                      <p className="text-sm text-fg-muted font-tajawal leading-relaxed">
                        {lang === "ar" ? "فريقنا يتأكد من دقة ووصف المنتج" : "Our expert team verifies the accuracy and description of the product."}
                      </p>
                      
                      <div className="hidden md:block absolute top-[2.75rem] -right-3 translate-x-1/2 z-10 text-accent/40 animate-pulse">
                        <svg className="w-5 h-5 transform rtl:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </div>

                    {/* Seller Step 3 */}
                    <div className="brand-card rounded-2xl shadow-sm hover:shadow-lg transition-all duration-300 hover:scale-[1.02] bg-surface-raised border border-line p-6 relative flex flex-col items-center text-center">
                      <div className="absolute top-4 left-4 w-8 h-8 rounded-full bg-accent/10 text-accent font-bold font-mono flex items-center justify-center text-sm">
                        3
                      </div>
                      <div className="w-14 h-14 rounded-xl bg-accent-weak flex items-center justify-center mb-5 text-accent">
                        <TrendingUp className="w-7 h-7" />
                      </div>
                      <h3 className="text-lg font-bold text-fg font-tajawal mb-2">
                        {lang === "ar" ? "المزاد يفتح" : "Auction Goes Live"}
                      </h3>
                      <p className="text-sm text-fg-muted font-tajawal leading-relaxed">
                        {lang === "ar" ? "السعر يرتفع حسب الطلب الحقيقي للمشترين" : "The price climbs based on actual demand from real buyers."}
                      </p>
                      
                      <div className="hidden md:block absolute top-[2.75rem] -right-3 translate-x-1/2 z-10 text-accent/40 animate-pulse">
                        <svg className="w-5 h-5 transform rtl:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </div>

                    {/* Seller Step 4 */}
                    <div className="brand-card rounded-2xl shadow-sm hover:shadow-lg transition-all duration-300 hover:scale-[1.02] bg-surface-raised border border-line p-6 relative flex flex-col items-center text-center">
                      <div className="absolute top-4 left-4 w-8 h-8 rounded-full bg-accent/10 text-accent font-bold font-mono flex items-center justify-center text-sm">
                        4
                      </div>
                      <div className="w-14 h-14 rounded-xl bg-accent-weak flex items-center justify-center mb-5 text-accent">
                        <Award className="w-7 h-7" />
                      </div>
                      <h3 className="text-lg font-bold text-fg font-tajawal mb-2">
                        {lang === "ar" ? "استلم فلوسك" : "Get Paid"}
                      </h3>
                      <p className="text-sm text-fg-muted font-tajawal leading-relaxed">
                        {lang === "ar" ? "البائع يستلم 95٪ — عمولة 5٪ فقط عند البيع، والباقي إلك فوراً" : "Sellers keep 95% — just 5% commission on sale, and the rest is yours instantly."}
                      </p>
                    </div>
                  </>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </section>





        {/* 2. Launch announcement — directly under the hero, where paid traffic
            lands. "Register to bid" opens the EXISTING phone+OTP sign-in with
            the 'bid' intent; there is no second registration form and no new
            collection, so nothing here can write to Firestore on its own. */}
        <IPhoneAuctionSection
          isAr={lang === "ar"}
          copy={t.iphoneAuction}
          onEnter={onEnter}
          onRegister={() => {
            emitLandingEvent('auction_register_clicked', { location: 'iphone_auction' });
            requestSignIn('bid');
          }}
        />

        <LiveMarketplaceSection lang={lang} t={t} onEnter={onEnter} formatPrice={formatPrice} />

        {/* 3. Section "الأمان والثقة" (Trust & Safety) */}
        <section
          aria-labelledby="trust-heading"
          className="relative overflow-hidden py-20 sm:py-24 bg-surface-sunken border-y border-line"
        >
          {/*
            The warm arc along the section's top edge. Decorative only — it
            carries no information, so it is hidden from assistive tech and
            takes no pointer events. The section's own `overflow-hidden` clips
            it, which is what stops a 100%-wide glow from widening the document
            on narrow screens; the landing root has bitten us there before.
            Written as an arbitrary `background` because Tailwind's gradient
            utilities cannot express an elliptical radial stop.
          */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-40 [background:radial-gradient(60%_100%_at_50%_0%,rgba(240,81,35,0.26),transparent_72%)]"
          />

          <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">

            {/* Section Title */}
            <Reveal>
              <div className="flex flex-col items-center text-center max-w-3xl mx-auto mb-12 sm:mb-16 gap-4">
                <span className={`inline-block px-4 py-1.5 rounded-full bg-accent/5 text-accent text-xs font-bold font-tajawal border border-accent/40 ${lang === "en" ? "tracking-wide" : ""}`}>
                  {t.trust.badge}
                </span>
                <h2 id="trust-heading" className="text-3xl sm:text-4xl lg:text-5xl font-extrabold text-fg font-alexandria leading-[1.3]">
                  {t.trust.title}
                </h2>
                <p className="text-fg-muted text-sm sm:text-base font-tajawal max-w-2xl mx-auto leading-relaxed">
                  {t.trust.subtitle}
                </p>
              </div>
            </Reveal>

            {/*
              Four across on large desktop, 2×2 on tablet, one column on mobile.
              Card order is DOM order, so RTL lays them out right-to-left on its
              own — «بائعون موثّقون» first means first-on-the-right in Arabic and
              first-on-the-left in English, which is what both readings expect.
            */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 sm:gap-6">
              {t.trust.cards.map((card, idx) => {
                const Icon = TRUST_ICONS[idx] ?? ShieldCheck;
                return (
                  <Reveal key={card.title} delay={idx * 0.08}>
                    <article className="group relative h-full overflow-hidden rounded-2xl border border-line bg-surface-raised p-6 sm:p-7 text-center transition duration-300 hover:-translate-y-1 hover:border-accent/50 hover:shadow-[0_10px_30px_-12px_rgba(240,81,35,0.35)] motion-reduce:transform-none motion-reduce:transition-none">
                      {/* The card's own restrained glow, same idea as the section's. */}
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 top-0 h-20 [background:radial-gradient(50%_100%_at_50%_0%,rgba(240,81,35,0.20),transparent_75%)]"
                      />
                      <div className="relative flex flex-col items-center">
                        <span className="mb-5 flex h-14 w-14 items-center justify-center rounded-xl border border-accent/25 bg-accent/10 transition-colors duration-300 group-hover:bg-accent/15">
                          <Icon aria-hidden="true" strokeWidth={1.75} className="h-6 w-6 text-accent" />
                        </span>
                        <h3 className="text-base sm:text-lg font-bold text-fg font-alexandria mb-2">
                          {card.title}
                        </h3>
                        <p className="text-xs sm:text-sm text-fg-muted leading-relaxed font-tajawal">
                          {card.desc}
                        </p>
                      </div>
                    </article>
                  </Reveal>
                );
              })}
            </div>

          </div>
        </section>

        {/* 4. Section "لماذا Mazzado" (Comparison VS) */}
        <section id="why-mazzado" className="py-20 relative">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            
            {/* Section Title */}
            <Reveal>
              <div className="text-center max-w-3xl mx-auto mb-16 space-y-4">
                <h2 className="text-3xl sm:text-4xl font-extrabold text-fg font-alexandria">
                  {t.why.title}
                </h2>
                <p className="text-fg text-sm sm:text-base font-tajawal max-w-xl mx-auto">
                  {t.why.subtitle}
                </p>
              </div>
            </Reveal>

            {/* VS Comparison Container */}
            <div className="grid grid-cols-1 lg:grid-cols-11 gap-8 items-center relative">
              
              {/* Column 1: Traditional (Red cross) */}
              <div className="lg:col-span-5">
                <Reveal>
                  <motion.div
                    whileHover={{ y: -5, borderColor: "rgba(239, 68, 68, 0.3)", boxShadow: "0 12px 32px rgba(0,0,0,0.08)" }}
                    className="bg-surface-raised border border-line rounded-[10px] p-8 space-y-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)] transition-all duration-300 h-full"
                  >
                    <div className="flex items-center gap-3 pb-4 border-b border-line">
                      <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center text-red-600 font-bold shrink-0">
                        ✕
                      </div>
                      <h3 className="text-lg font-bold text-fg/90 font-alexandria">
                        {t.why.traditionalTitle}
                      </h3>
                    </div>

                    <ul className="space-y-4">
                      {t.why.traditionalPoints.map((pt, idx) => (
                        <li key={idx} className="flex items-start gap-3">
                          <XCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                          <span className="text-sm text-fg-muted font-tajawal leading-relaxed">{pt}</span>
                        </li>
                      ))}
                    </ul>
                  </motion.div>
                </Reveal>
              </div>

              {/* VS Divider in middle */}
              <div className="lg:col-span-1 flex justify-center z-10">
                <Reveal delay={0.25}>
                  <motion.div
                    whileHover={{ scale: 1.15, rotate: 12 }}
                    className="w-12 h-12 rounded-full bg-accent flex items-center justify-center font-bold text-white text-lg shadow-sm select-none cursor-pointer"
                  >
                    VS
                  </motion.div>
                </Reveal>
              </div>

              {/* Column 2: Mazzado (Smart Royal Gold hover highlights) */}
              <div className="lg:col-span-5">
                <Reveal delay={0.2}>
                  <motion.div
                    whileHover={{ 
                      y: -8, 
                      borderColor: ACCENT,
                      boxShadow: "0 12px 32px rgba(0,0,0,0.08)"
                    }}
                    className="bg-surface-raised border-2 border-accent rounded-[10px] p-8 space-y-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)] relative overflow-hidden group transition-all duration-300 h-full"
                  >
                    
                    {/* Visual highlights */}
                    <div className={`absolute top-0 right-0 bg-accent text-white text-[10px] uppercase font-black px-4 py-1 rounded-bl-lg font-tajawal shadow-sm ${lang === "en" ? "tracking-wide" : ""}`}>
                      {lang === "ar" ? "موصى به" : "RECOMMENDED"}
                    </div>

                    <div className="flex items-center gap-3 pb-4 border-b border-line">
                      <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center text-accent shrink-0">
                        <Hammer className="w-5 h-5" />
                      </div>
                      <h3 className="text-xl font-bold text-fg font-alexandria">
                        {t.why.smartTitle}
                      </h3>
                    </div>

                    <ul className="space-y-4">
                      {t.why.smartPoints.map((pt, idx) => (
                        <li key={idx} className="flex items-start gap-3">
                          <CheckCircle2 className="w-5 h-5 text-accent shrink-0 mt-0.5" />
                          <span className="text-sm text-fg font-tajawal font-medium leading-relaxed">{pt}</span>
                        </li>
                      ))}
                    </ul>
                  </motion.div>
                </Reveal>
              </div>

            </div>

          </div>
        </section>

        {/* Real Customer Testimonials Section */}
        <section id="testimonials" className="py-20 bg-surface-sunken/30 border-t border-line">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <Reveal>
              <h2 className="text-4xl font-bold text-center text-fg font-alexandria mb-12">
                {lang === "ar" ? "قصص حقيقية من ناس زيك" : "Real Stories From People Like You"}
              </h2>
            </Reveal>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {[
                {
                  ar: "بعت سيارتي خلال 3 أيام وبسعر أعلى مما توقعت. العمولة بسيطة جداً مقارنة بالراحة.",
                  en: "I sold my car in just 3 days and for a higher price than I expected. The commission is very small compared to the convenience.",
                  nameAr: "أحمد. م — عمّان",
                  nameEn: "Ahmad M. — Amman"
                },
                {
                  ar: "اشتريت آيفون واستلمته مطابق تماماً للوصف. ما دفعت للبائع إلا بعد ما تأكدت بنفسي.",
                  en: "I bought an iPhone and received it exactly matching the description. I didn't pay the seller until I verified it myself.",
                  nameAr: "سارة. ح — إربد",
                  nameEn: "Sarah H. — Irbid"
                },
                {
                  ar: "زرت المكتب قبل ما أعرض غرفة نوم، واطمنيت إنهم فاحصين كل التفاصيل.",
                  en: "I visited the office before offering a bedroom set, and felt assured knowing they inspect every single detail.",
                  nameAr: "خليل. ع — الزرقاء",
                  nameEn: "Khalil A. — Zarqa"
                }
              ].map((testi, idx) => (
                <Reveal key={idx} delay={idx * 0.15}>
                  <div className="bg-surface-raised border border-line rounded-2xl p-8 flex flex-col justify-between h-full shadow-sm hover:shadow-md transition-all duration-300 relative group">
                    <div>
                      <Quote className="w-8 h-8 text-accent mb-5 shrink-0 transform -scale-x-100" />
                      <p className="text-fg font-tajawal text-base leading-relaxed mb-6 font-medium">
                        {lang === "ar" ? testi.ar : testi.en}
                      </p>
                    </div>
                    <div>
                      <span className="block text-xs text-fg-muted font-tajawal font-semibold">
                        {lang === "ar" ? testi.nameAr : testi.nameEn}
                      </span>
                      <div className="flex gap-1 mt-2">
                        {[...Array(5)].map((_, i) => (
                          <Star key={i} className="w-4 h-4 text-accent fill-accent" />
                        ))}
                      </div>
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>

            {/* Statistics and Badges Bar */}
            <Reveal delay={0.4}>
              <div className="mt-16 bg-[#0A0A0A] text-white rounded-2xl p-8 border border-gray-800 shadow-xl">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
                  {[
                    // Terms, not counts. The three that stood here — 1,250+ sales,
                    // 3,400+ listings, 15,000+ active users — were never measured, and
                    // this bar sits directly under a heading that promises real
                    // stories. Each of these is quoted from the locked rules —
                    // `fees`, `paymentWindow` and `noDeposit` in
                    // src/content/auctionRules.ts.
                    {
                      arVal: "5% + 5%",
                      enVal: "5% + 5%",
                      arLabel: "عمولة المشتري والبائع",
                      enLabel: "Buyer + seller commission"
                    },
                    {
                      arVal: "24 ساعة",
                      enVal: "24 hours",
                      arLabel: "مهلة الدفع بعد الفوز",
                      enLabel: "To pay after you win"
                    },
                    {
                      arVal: "بدون تأمين",
                      enVal: "No deposit",
                      arLabel: "ما في وديعة للمزايدة",
                      enLabel: "Nothing to pay to bid"
                    },
                    {
                      arVal: <Lock className="w-8 h-8 sm:w-9 sm:h-9 inline-block" aria-hidden="true" />,
                      enVal: <Lock className="w-8 h-8 sm:w-9 sm:h-9 inline-block" aria-hidden="true" />,
                      arLabel: "محجوز حتى الاستلام",
                      enLabel: "Held until you confirm"
                    }
                  ].map((stat, idx) => (
                    <div key={idx} className="space-y-2 flex flex-col items-center justify-center">
                      <span className="text-3xl sm:text-4xl font-extrabold text-accent font-mono tracking-tight block">
                        {lang === "ar" ? stat.arVal : stat.enVal}
                      </span>
                      <span className="text-xs sm:text-sm text-gray-300 font-tajawal font-medium">
                        {lang === "ar" ? stat.arLabel : stat.enLabel}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* 2.6 Section: Escrow (الضمان المالي) */}
        <section id="escrow-protection" className="py-[96px] bg-surface border-b border-line relative overflow-hidden">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
              
              {/* Right/Main Column: Text content */}
              <Reveal>
                <div className="flex flex-col space-y-6">
                  <div>
                    <span className="inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full bg-accent-weak text-accent-strong text-xs font-bold font-tajawal border border-accent/20 mb-3">
                      <ShieldCheck className="w-4 h-4" />
                      {lang === "ar" ? "الأمان المالي" : "Financial Security"}
                    </span>
                    <h2 className="text-4xl md:text-5xl font-bold text-fg font-tajawal leading-tight">
                      {lang === "ar" ? "فلوسك بأمان لحد ما توافق إنت — مش قبل." : "Your money is safe until you approve — never before."}
                    </h2>
                  </div>
                  
                  <p className="text-lg text-fg-muted font-tajawal leading-relaxed">
                    {lang === "ar"
                      ? "ما في مفاجآت. فلوسك تضل محجوزة عندنا لحد ما تستلم المنتج وتتأكد إنه مطابق تماماً لما اتفقنا عليه. بس هيك بتنطلق للبائع."
                      : "No surprises. Your funds remain securely held by us until you receive the product and verify that it perfectly matches what was agreed upon. Only then is it released to the seller."}
                  </p>
                  
                  {/* Confirmatory List with Checkmarks */}
                  <div className="space-y-4 pt-2">
                    {[
                      {
                        ar: "مزاد بيحتفظ بمبلغك وما بيحوّله للبائع إلا بعد ما تستلم القطعة وتتأكد إنها مطابقة.",
                        en: "Mazad holds your payment and releases it to the seller only after you receive the item and confirm it matches."
                      },
                      {
                        ar: "الدفع لا يكتمل إلا بعد معاينة السلعة فعلياً ومطابقتها للمواصفات.",
                        en: "Payment is never disbursed until you inspect the item and approve its specifications."
                      },
                      {
                        ar: "إذا كان في مشكلة أو عدم تطابق قبل تأكيدك للاستلام، مزاد يتوسط ويرجّع لك مبلغك المحجوز.",
                        en: "If there is a problem or mismatch before you confirm receipt, Mazad mediates and returns your held payment."
                      }
                    ].map((point, idx) => (
                      <div key={idx} className="flex items-start gap-3">
                        <div className="w-5 h-5 rounded-full bg-accent/10 flex items-center justify-center shrink-0 mt-1">
                          <Check className="w-3.5 h-3.5 text-accent" />
                        </div>
                        <span className="text-fg font-tajawal text-sm sm:text-base leading-relaxed font-medium">
                          {lang === "ar" ? point.ar : point.en}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </Reveal>

              {/* Left Column: Interactive Escrow Path Diagram */}
              <Reveal delay={0.2}>
                <div className="bg-surface-raised rounded-2xl p-6 sm:p-8 border border-line shadow-sm relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-accent/5 rounded-bl-full pointer-events-none" />
                  
                  <div className="flex items-center justify-between mb-8 border-b border-line pb-4">
                    <h3 className="font-bold text-fg font-tajawal text-lg">
                      {lang === "ar" ? "مسار الضمان المالي الحي" : "How Your Payment Is Held"}
                    </h3>
                    <span className="text-xs font-bold text-fg-muted font-tajawal">
                      {lang === "ar" ? "اضغط على الخطوة للتجربة" : "Click step to interact"}
                    </span>
                  </div>

                  {/* Connecting Line Container */}
                  <div className="relative space-y-6">
                    {/* Vertical connector line */}
                    <div className="absolute right-[21px] top-4 bottom-4 w-0.5 bg-gray-200 transform translate-x-1/2 rtl:right-auto rtl:left-[21px] rtl:-translate-x-1/2" />
                    
                    {[
                      {
                        step: 1,
                        arTitle: "البائع يستلم المزايدة الفائزة",
                        enTitle: "Seller accepts the winning bid",
                        arDesc: "يتم تحديد العرض الأعلى الفائز بالمزاد رسمياً.",
                        enDesc: "The highest winning bid of the auction is officially determined."
                      },
                      {
                        step: 2,
                        arTitle: "مزادو بتحتفظ بالمبلغ",
                        enTitle: "Mazzado holds the payment",
                        arDesc: "مزادو بتحتفظ بمبلغك وما بتحوّله للبائع إلا بعد ما تستلم القطعة وتتأكد إنها مطابقة.",
                        enDesc: "Mazzado holds your payment and does not release it to the seller until you receive the item and confirm it matches."
                      },
                      {
                        step: 3,
                        arTitle: "المشتري يفحص المنتج فعلياً",
                        enTitle: "Buyer physically inspects the item",
                        arDesc: "يلتقي الطرفان للمعاينة الأخيرة ومطابقة المنتج للوصف.",
                        enDesc: "Both parties meet for physical inspection and specs verification."
                      },
                      {
                        step: 4,
                        arTitle: "عند الموافقة، الفلوس تنطلق للبائع فوراً",
                        enTitle: "Upon approval, funds release to seller",
                        arDesc: "بعد تأكيد المشتري، يتم صرف المستحقات ونقل الملكية بأمان.",
                        enDesc: "Once buyer confirms, payment is instantly released and ownership is transferred."
                      }
                    ].map((stepObj) => {
                      const isActive = activeEscrowStep === stepObj.step;
                      return (
                        <button
                          key={stepObj.step}
                          onClick={() => setActiveEscrowStep(stepObj.step)}
                          className={`w-full text-right rtl:text-right ltr:text-left flex items-start gap-4 p-3.5 rounded-xl transition-all duration-300 relative z-10 ${
                            isActive 
                              ? "bg-accent/5 border border-accent/20 shadow-sm" 
                              : "hover:bg-surface-sunken border border-transparent"
                          }`}
                        >
                          {/* Number Circle with potential pulse animation */}
                          <div className="relative shrink-0">
                            <div className={`w-10 h-10 rounded-full font-bold font-mono text-sm flex items-center justify-center transition-all duration-300 ${
                              isActive
                                ? "bg-accent text-white"
                                : "bg-surface-sunken text-fg-muted"
                            }`}>
                              <span className="font-mono" dir="ltr">{stepObj.step}</span>
                            </div>
                            
                            {/* Pulse animation for active step */}
                            {isActive && (
                              <span className="absolute -inset-1 rounded-full border border-accent animate-pulse pointer-events-none opacity-60" />
                            )}
                          </div>

                          <div className="flex-1">
                            <h4 className={`text-base font-bold font-tajawal transition-colors duration-300 ${
                              isActive ? "text-accent" : "text-fg"
                            }`}>
                              {lang === "ar" ? stepObj.arTitle : stepObj.enTitle}
                            </h4>
                            <p className="text-xs text-fg-muted font-tajawal mt-0.5 leading-relaxed">
                              {lang === "ar" ? stepObj.arDesc : stepObj.enDesc}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </Reveal>

            </div>
          </div>
        </section>

        {/* 6. Section "الفئات" (Categories) */}
        <section id="categories" className="py-20 bg-surface border-y border-line relative">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            
            {/* Section Title */}
            <Reveal>
              <div className="text-center max-w-3xl mx-auto mb-16 space-y-4">
                <h2 className="text-3xl sm:text-4xl font-extrabold text-fg font-alexandria">
                  {t.categories.title}
                </h2>
                <p className="text-fg text-sm sm:text-base font-tajawal max-w-xl mx-auto">
                  {t.categories.subtitle}
                </p>
              </div>
            </Reveal>

            {/* Categories list */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {t.categories.list.map((cat, idx) => {
                return (
                  <Reveal key={idx} delay={idx * 0.08}>
                    <motion.div
                      whileHover={{
                        scale: 1.03,
                        rotate: 1,
                        borderColor: ACCENT,
                        boxShadow: "0 12px 32px rgba(0,0,0,0.08)"
                      }}
                      transition={{ type: "spring", stiffness: 260, damping: 22 }}
                      className="bg-surface-raised border border-line hover:border-accent rounded-[10px] p-6 transition-all duration-300 group cursor-pointer shadow-[0_1px_3px_rgba(0,0,0,0.04)] h-full"
                    >
                      <div className="flex items-center gap-4 mb-4">
                        <div className="w-12 h-12 rounded-[10px] bg-accent/10 flex items-center justify-center shrink-0 group-hover:scale-110 group-hover:bg-accent/15 transition-all duration-300">
                          {getLineIcon(`cat-${idx}`, "w-6 h-6 text-accent")}
                        </div>
                        <h3 className="text-lg font-bold text-fg font-alexandria group-hover:text-accent transition-colors">
                          {cat.title}
                        </h3>
                      </div>
                      <p className="text-xs text-fg-muted leading-relaxed font-tajawal">
                        {cat.desc}
                      </p>
                    </motion.div>
                  </Reveal>
                );
              })}
            </div>

          </div>
        </section>



        {/* 8. Pricing Section (قسم الأسعار) */}
        <section id="pricing" className="py-24 bg-surface border-t border-line relative overflow-hidden">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
            
            {/* Header */}
            <Reveal>
              <div className="text-center max-w-3xl mx-auto mb-16 space-y-4">
                <h2 className="text-3xl sm:text-4xl font-extrabold text-fg font-alexandria leading-tight">
                  {lang === "ar" ? "اشتراكات بسيطة وواضحة" : "Simple and Clear Subscriptions"}
                </h2>
                <p className="text-fg text-sm sm:text-base font-tajawal max-w-xl mx-auto leading-relaxed">
                  {lang === "ar" 
                    ? "ادفع بسهولة عبر كليك. ألغِ اشتراكك في أي وقت." 
                    : "Pay easily via CliQ. Cancel your subscription at any time."}
                </p>
              </div>
            </Reveal>

            {/* Three Pricing Cards */}
            <div className="flex md:grid md:grid-cols-3 gap-6 md:gap-8 overflow-x-auto md:overflow-x-visible snap-x snap-mandatory pb-6 md:pb-0 scrollbar-none scroll-smooth -mx-4 px-4 md:mx-0 md:px-0">
              
              {/* Card 1: 1 Month */}
              <div className="snap-start min-w-[280px] xs:min-w-[320px] flex-shrink-0 md:min-w-0 w-full">
                <Reveal delay={0.05}>
                  <motion.div
                    whileHover={{ y: -6, boxShadow: "0 10px 30px rgba(0,0,0,0.05)" }}
                    className="bg-surface-raised border border-line rounded-[20px] p-8 flex flex-col justify-between h-full relative"
                  >
                    <div className="space-y-6">
                      <div className="space-y-2">
                        <span className="text-xs font-bold text-fg-muted uppercase tracking-wider font-tajawal">
                          {lang === "ar" ? "جرّبها" : "Try it out"}
                        </span>
                        <h3 className="text-xl font-bold text-fg font-alexandria">
                          {lang === "ar" ? "شهر واحد" : "1 Month"}
                        </h3>
                      </div>
                      
                      <div className="flex items-baseline gap-2">
                        <span className="text-4xl font-black text-fg font-alexandria">
                          {lang === "ar" ? "1 دينار" : "1 JOD"}
                        </span>
                        <span className="text-sm text-fg-muted font-tajawal">
                          / {lang === "ar" ? "شهرياً" : "month"}
                        </span>
                      </div>

                      <div className="border-t border-line pt-6">
                        <ul className="space-y-3.5 text-xs text-fg-muted font-tajawal">
                          <li className="flex items-center gap-2.5">
                            <Check className="w-4 h-4 text-green-500 shrink-0" />
                            <span>{lang === "ar" ? "مزايدة غير محدودة" : "Unlimited bidding"}</span>
                          </li>
                          <li className="flex items-center gap-2.5">
                            <Check className="w-4 h-4 text-green-500 shrink-0" />
                            <span>{lang === "ar" ? "دخول فوري للمزادات المباشرة" : "Instant entry to live auctions"}</span>
                          </li>
                          <li className="flex items-center gap-2.5">
                            <Check className="w-4 h-4 text-green-500 shrink-0" />
                            <span>{lang === "ar" ? "دعم فني عبر الواتساب" : "WhatsApp support"}</span>
                          </li>
                        </ul>
                      </div>
                    </div>

                    <div className="pt-8">
                      <button
                        type="button"
                        onClick={onEnter}
                        className="block w-full text-center py-3.5 px-6 rounded-xl bg-surface-sunken hover:bg-gray-200 text-fg font-bold text-sm font-tajawal transition-colors duration-200 cursor-pointer"
                      >
                        {lang === "ar" ? "اشترك الآن" : "Subscribe Now"}
                      </button>
                    </div>
                  </motion.div>
                </Reveal>
              </div>

              {/* Card 2: 6 Months (Featured, elevated middle card) */}
              <div className="snap-start min-w-[280px] xs:min-w-[320px] flex-shrink-0 md:min-w-0 w-full md:-translate-y-4">
                <Reveal delay={0.15}>
                  <motion.div
                    whileHover={{ y: -10, boxShadow: "0 20px 40px rgba(240,81,35,0.12)" }}
                    className="bg-surface-raised border-2 border-accent rounded-[20px] p-8 flex flex-col justify-between h-full relative shadow-[0_12px_40px_rgba(240,81,35,0.08)] overflow-hidden"
                  >
                    {/* Orange Badge */}
                    <div className="absolute top-0 right-0 bg-accent text-white text-[10px] font-black px-4 py-1.5 rounded-bl-lg font-tajawal uppercase tracking-wide">
                      {lang === "ar" ? "الأكثر شيوعاً" : "Most Popular"}
                    </div>

                    <div className="space-y-6">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-accent-ink uppercase tracking-wider font-tajawal">
                            {lang === "ar" ? "وفّر 33٪" : "Save 33%"}
                          </span>
                        </div>
                        <h3 className="text-2xl font-bold text-fg font-alexandria flex items-center gap-2">
                          {lang === "ar" ? "6 أشهر" : "6 Months"}
                        </h3>
                      </div>
                      
                      <div className="flex items-baseline gap-2">
                        <span className="text-4xl font-black text-accent font-alexandria">
                          {lang === "ar" ? "4 دنانير" : "4 JOD"}
                        </span>
                        <span className="text-sm text-fg-muted font-tajawal">
                          / {lang === "ar" ? "6 أشهر" : "6 months"}
                        </span>
                      </div>

                      <div className="border-t border-line pt-6">
                        <ul className="space-y-3.5 text-xs text-fg font-tajawal font-medium">
                          <li className="flex items-center gap-2.5">
                            <Check className="w-4 h-4 text-accent shrink-0" />
                            <span>{lang === "ar" ? "مزايدة غير محدودة" : "Unlimited bidding"}</span>
                          </li>
                          <li className="flex items-center gap-2.5">
                            <Check className="w-4 h-4 text-accent shrink-0" />
                            <span>{lang === "ar" ? "دخول فوري للمزادات المباشرة" : "Instant entry to live auctions"}</span>
                          </li>
                          <li className="flex items-center gap-2.5">
                            <Check className="w-4 h-4 text-accent shrink-0" />
                            <span>{lang === "ar" ? "دعم فني ذو أولوية" : "Priority WhatsApp support"}</span>
                          </li>
                          <li className="flex items-center gap-2.5">
                            <Check className="w-4 h-4 text-accent shrink-0" />
                            <span>{lang === "ar" ? "توفير مستمر" : "Ongoing savings"}</span>
                          </li>
                        </ul>
                      </div>
                    </div>

                    <div className="pt-8">
                      <button
                        type="button"
                        onClick={onEnter}
                        className="block w-full text-center py-3.5 px-6 rounded-xl bg-accent hover:bg-[#d44319] text-white font-bold text-sm font-tajawal transition-all duration-200 shadow-md shadow-accent/25 cursor-pointer"
                      >
                        {lang === "ar" ? "اشترك الآن" : "Subscribe Now"}
                      </button>
                    </div>
                  </motion.div>
                </Reveal>
              </div>

              {/* Card 3: 1 Year */}
              <div className="snap-start min-w-[280px] xs:min-w-[320px] flex-shrink-0 md:min-w-0 w-full">
                <Reveal delay={0.25}>
                  <motion.div
                    whileHover={{ y: -6, boxShadow: "0 10px 30px rgba(0,0,0,0.05)" }}
                    className="bg-surface-raised border border-line rounded-[20px] p-8 flex flex-col justify-between h-full relative"
                  >
                    <div className="space-y-6">
                      <div className="space-y-2">
                        <span className="text-xs font-bold text-fg-muted uppercase tracking-wider font-tajawal">
                          {lang === "ar" ? "أفضل قيمة — وفّر 42٪" : "Best Value — Save 42%"}
                        </span>
                        <h3 className="text-xl font-bold text-fg font-alexandria">
                          {lang === "ar" ? "سنة كاملة" : "1 Year"}
                        </h3>
                      </div>
                      
                      <div className="flex items-baseline gap-2">
                        <span className="text-4xl font-black text-fg font-alexandria">
                          {lang === "ar" ? "7 دنانير" : "7 JOD"}
                        </span>
                        <span className="text-sm text-fg-muted font-tajawal">
                          / {lang === "ar" ? "سنوياً" : "yearly"}
                        </span>
                      </div>

                      <div className="border-t border-line pt-6">
                        <ul className="space-y-3.5 text-xs text-fg-muted font-tajawal">
                          <li className="flex items-center gap-2.5">
                            <Check className="w-4 h-4 text-green-500 shrink-0" />
                            <span>{lang === "ar" ? "مزايدة غير محدودة" : "Unlimited bidding"}</span>
                          </li>
                          <li className="flex items-center gap-2.5">
                            <Check className="w-4 h-4 text-green-500 shrink-0" />
                            <span>{lang === "ar" ? "دخول فوري للمزادات المباشرة" : "Instant entry to live auctions"}</span>
                          </li>
                          <li className="flex items-center gap-2.5">
                            <Check className="w-4 h-4 text-green-500 shrink-0" />
                            <span>{lang === "ar" ? "دعم فني ذو أولوية فائقة" : "VIP WhatsApp support"}</span>
                          </li>
                        </ul>
                      </div>
                    </div>

                    <div className="pt-8">
                      <button
                        type="button"
                        onClick={onEnter}
                        className="block w-full text-center py-3.5 px-6 rounded-xl bg-surface-sunken hover:bg-gray-200 text-fg font-bold text-sm font-tajawal transition-colors duration-200 cursor-pointer"
                      >
                        {lang === "ar" ? "اشترك الآن" : "Subscribe Now"}
                      </button>
                    </div>
                  </motion.div>
                </Reveal>
              </div>

            </div>

            {/* Small Grey Line below cards */}
            <Reveal>
              <div className="text-center mt-8 text-xs text-fg-muted font-tajawal">
                {lang === "ar"
                  ? "مزايدة بلا حدود · الدفع عبر كليك · بدون رسوم خفية · + عمولة مشترٍ 5٪ عند الفوز"
                  : "Unlimited bidding · Pay via CliQ · No hidden fees · +5% buyer's premium on wins"}
              </div>
            </Reveal>

            {/* Wide Sellers Banner under cards (Black with white text replacing any previous turquoise banner) */}
            <div className="mt-16">
              <Reveal>
                <div className="relative rounded-[24px] bg-[#0A0A0A] text-white p-8 md:p-12 overflow-hidden border border-white/5 shadow-2xl">
                  
                  {/* Decorative faint grid lines or blurred glow */}
                  <div className="absolute top-0 right-0 -translate-x-1/4 -translate-y-1/4 w-[200px] h-[200px] rounded-full bg-accent/10 blur-2xl pointer-events-none" />
                  <div className="absolute bottom-0 left-0 translate-x-1/4 translate-y-1/4 w-[150px] h-[150px] rounded-full bg-surface-raised/5 blur-2xl pointer-events-none" />

                  {/* Corner Badge - Orange Gradient */}
                  <div className="absolute top-4 right-4 md:top-6 md:right-6 bg-gradient-to-r from-accent to-accent-strong text-white text-[10px] md:text-xs font-bold px-3.5 py-1.5 rounded-full font-tajawal shadow-md border border-white/10">
                    {lang === "ar" ? "اعرض منتجك مجاناً — لفترة محدودة" : "Free to list — Limited time"}
                  </div>

                  <div className="relative z-10 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-8 pt-8">
                    <div className="space-y-4 max-w-2xl">
                      <h3 className="text-xl md:text-2xl font-bold font-alexandria tracking-tight leading-tight">
                        {lang === "ar" ? "البائع يستلم 95٪ — عمولة 5٪ فقط" : "Sellers keep 95% — just 5% commission"}
                      </h3>
                      <p className="text-fg-muted text-xs md:text-sm leading-relaxed font-tajawal">
                        {lang === "ar" 
                          ? "بدون رسوم عرض حالياً. لا رسوم إذا لم يُبَع المنتج. عمولة 5٪ فقط عندما يجد منتجك مشتريه."
                          : "No listing fees right now. No fees if the product is not sold. Just 5% commission when your product finds a buyer."}
                      </p>
                    </div>

                    <div className="shrink-0">
                      <motion.button
                        type="button"
                        onClick={() => { emitLandingEvent('seller_cta_clicked', { location: 'pricing' }); onEnter('upload'); }}
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.98 }}
                        className="inline-block px-8 py-3.5 bg-surface-raised text-fg hover:bg-surface-sunken font-bold text-sm font-tajawal rounded-xl shadow-md transition-colors duration-200 text-center w-full lg:w-auto cursor-pointer"
                      >
                        {lang === "ar" ? "بيع معنا" : "Sell with Us"}
                      </motion.button>
                    </div>
                  </div>

                </div>
              </Reveal>
            </div>

          </div>
        </section>

        {/* 2.7 Section: Office Visit & Viewing (زيارة مكاتبنا) — the BUYER comes
            and inspects. We do not claim to inspect every lot ourselves. */}
        <section id="office-visit" className="py-[96px] bg-[#0A0A0A] text-white relative overflow-hidden">
          {/* Subtle abstract glow in the background */}
          <div className="absolute top-1/2 left-1/4 -translate-y-1/2 w-[400px] h-[400px] bg-accent/10 rounded-full blur-[120px] pointer-events-none" />
          <div className="absolute -bottom-20 -right-20 w-[300px] h-[300px] bg-accent/10 rounded-full blur-[100px] pointer-events-none" />

          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
            <div className="bg-gradient-to-br from-[#1A1A1A] to-[#0A0A0A] rounded-3xl p-8 md:p-12 border border-gray-800 shadow-xl relative overflow-hidden">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
                
                {/* Text Content Area */}
                <div className="lg:col-span-7 space-y-6">
                  <Reveal>
                    <div>
                      <span className="inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full bg-accent/20 text-accent text-xs font-bold font-tajawal border border-accent/30 mb-3">
                        <Building2 className="w-4 h-4" />
                        {lang === "ar" ? "المعاينة قبل المزايدة" : "Viewing before you bid"}
                      </span>
                      <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white font-tajawal leading-tight">
                        {lang === "ar" ? "مش لازم تصدقنا بالكلام بس — فلوسك محجوزة لحد ما تتأكد." : "Don't just take our word for it — your money is held until you're sure."}
                      </h2>
                    </div>
                  </Reveal>

                  <Reveal delay={0.1}>
                    <p className="text-gray-300 text-base sm:text-lg font-tajawal leading-relaxed">
                      {lang === "ar"
                        ? "بعض المنتجات بتقدر تعاينها قبل ما تزايد — إما بمكاتبنا أو عند البائع إذا كان عنده محل. وبكل الحالات، فلوسك محجوزة عندنا وما بتوصل البائع إلا بعد ما تستلم وتتأكد إن المنتج مطابق للوصف."
                        : "Some products can be viewed before you bid — at our offices, or at the seller's store where they have one. And in every case, your money is held by us and does not reach the seller until you receive the product and confirm it matches the description."}
                    </p>
                  </Reveal>

                  <Reveal delay={0.2}>
                    <div className="pt-2 flex flex-col sm:flex-row items-stretch sm:items-start md:items-center gap-4">
                      <a
                        href={SUPPORT_WHATSAPP_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center gap-2 px-8 py-4 rounded-full bg-surface-raised text-fg hover:bg-surface-sunken font-bold font-tajawal transition-all duration-300 hover:scale-105 shadow-md text-center"
                      >
                        <MapPin className="w-5 h-5 text-accent" />
                        {lang === "ar" ? "رتّب معاينة" : "Arrange a viewing"}
                      </a>
                      
                      {/* No live-status dot here: this is a visit-us invite, and the
                          office is not open around the clock. A pulsing green dot
                          read as "we are open right now" regardless of the hour. */}
                      <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-surface-raised/5 border border-white/10 self-center">
                        <span className="text-xs text-gray-300 font-tajawal">
                          {lang === "ar" ? "نسعد بزيارتكم" : "We'd be delighted to have you visit"}
                        </span>
                      </div>
                    </div>
                  </Reveal>
                </div>

                {/* Big Pin or Office Icon on the opposite side (Lg:col-span-5) */}
                <div className="lg:col-span-5 flex justify-center lg:justify-end">
                  <Reveal delay={0.3}>
                    <div className="relative group">
                      {/* Decorative glowing backdrops */}
                      <div className="absolute -inset-4 bg-gradient-to-tr from-accent/20 to-accent/20 rounded-full blur-2xl group-hover:opacity-100 transition duration-1000 opacity-70" />
                      
                      <div className="relative w-48 h-48 sm:w-56 sm:h-56 rounded-full bg-[#1A1A1A] border border-gray-800 flex items-center justify-center shadow-2xl transition-all duration-500 group-hover:scale-110">
                        {/* MapPin & Building dynamic composition */}
                        <div className="absolute text-accent animate-bounce duration-1000">
                          <MapPin className="w-20 h-20 drop-shadow-[0_10px_15px_rgba(240,81,35,0.3)]" />
                        </div>
                        <div className="absolute text-white/10 pointer-events-none">
                          <Building2 className="w-32 h-32" />
                        </div>
                      </div>
                    </div>
                  </Reveal>
                </div>

              </div>
            </div>
          </div>
        </section>

        {/* Section FAQ (الأسئلة الشائعة) */}
        <section id="faq" className="py-20 bg-surface-raised border-t border-line relative overflow-hidden">
          
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
            
            {/* Title & Header */}
            <div className="flex flex-col items-center text-center max-w-3xl mx-auto mb-16 gap-4">
              <span className={`inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full bg-accent/10 text-accent text-xs font-bold font-tajawal border border-accent/20 ${lang === "en" ? "tracking-wide" : ""}`}>
                <HelpCircle className="w-3.5 h-3.5" />
                <span>{t.faq.title}</span>
              </span>
              <h2 className="text-3xl sm:text-4xl font-extrabold text-fg font-alexandria leading-tight">
                {t.faq.title}
              </h2>
              <p className="text-fg text-sm sm:text-base font-tajawal max-w-xl mx-auto">
                {t.faq.subtitle}
              </p>
            </div>

            {/* Accordion List */}
            <div className="space-y-4">
              {t.faq.items.map((faq, idx) => {
                const isOpen = openFaqIndex === idx;
                return (
                  <div
                    key={idx}
                    className="bg-surface-raised border border-line rounded-[16px] overflow-hidden transition-all duration-300 hover:border-accent shadow-[0_4px_24px_rgba(0,0,0,0.08)] hover:shadow-[0_12px_32px_rgba(0,0,0,0.12)]"
                  >
                    <button
                      onClick={() => setOpenFaqIndex(isOpen ? null : idx)}
                      className="w-full text-start px-6 py-5 min-h-[44px] flex items-center justify-between gap-4 text-fg focus:outline-none select-none cursor-pointer rounded-[12px]"
                    >
                      <span className="text-base sm:text-lg font-bold text-fg font-alexandria leading-snug">
                        {faq.q}
                      </span>
                      <div className="shrink-0 w-8 h-8 rounded-lg bg-surface border border-line flex items-center justify-center transition-colors">
                        <ChevronDown 
                          className={`w-4 h-4 text-accent transition-transform duration-300 ${
                            isOpen ? "rotate-180" : "rotate-0"
                          }`} 
                        />
                      </div>
                    </button>

                    <div
                      className={`transition-all duration-300 ease-in-out overflow-hidden ${
                        isOpen ? "max-h-[500px] opacity-100" : "max-h-0 opacity-0"
                      }`}
                    >
                      <div className="px-6 pb-6 text-fg-muted text-sm sm:text-base font-tajawal leading-relaxed border-t border-line pt-5 space-y-3">
                        <p>{faq.a}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Direct support WhatsApp callout */}
            <div className="mt-12 p-6 rounded-[16px] bg-surface border border-line flex flex-col sm:flex-row items-center justify-between gap-6">
              <div className="flex items-center gap-3.5 text-center sm:text-start">
                <div className="w-12 h-12 rounded-[12px] bg-accent/10 flex items-center justify-center shrink-0">
                  <MessageCircle className="w-6 h-6 text-accent" />
                </div>
                <div className="space-y-1">
                  <h4 className="text-sm font-bold text-fg font-alexandria">
                    {lang === "ar" ? "لم تجد إجابة لسؤالك؟" : "Didn't find your answer?"}
                  </h4>
                  <p className="text-xs text-fg-muted font-cairo">
                    {lang === "ar" 
                      ? "تواصل معنا مباشرة عبر الواتساب وسيجيبك فريق الدعم فوراً!"
                      : "Chat with us directly on WhatsApp and our support team will answer you instantly!"}
                  </p>
                </div>
              </div>
              
              <a
                href={SUPPORT_WHATSAPP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full sm:w-auto px-6 py-3 rounded-[12px] bg-[#25D366] hover:bg-[#20ba56] text-white font-bold text-sm shadow-lg shadow-[#25D366]/10 hover:shadow-[#25D366]/20 transition-all duration-300 hover:scale-[1.03] text-center font-cairo flex items-center justify-center gap-2"
              >
                <MessageCircle className="w-4 h-4 fill-white text-transparent" />
                <span>{lang === "ar" ? "محادثة واتساب مباشرة" : "Direct WhatsApp Chat"}</span>
              </a>
            </div>

          </div>
        </section>

        {/* 8. Section "الآن في الأردن" (We're Live — CTA & Updates Signup) */}
        <section id="coming-soon" className="py-24 bg-surface border-t border-line relative overflow-hidden">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative z-10 space-y-12">

            {/* Title */}
            <div className="flex flex-col items-center gap-4 text-center">
              <span className={`inline-block px-3.5 py-1 rounded-full bg-accent/10 text-accent text-xs font-bold font-tajawal border border-accent/20 ${lang === "en" ? "tracking-wide" : ""}`}>
                {lang === "ar" ? "متاح الآن" : "NOW LIVE"}
              </span>
              <h2 className="text-4xl sm:text-5xl font-extrabold text-fg font-alexandria">
                {t.comingSoon.title}
              </h2>
              <p className="text-fg text-sm sm:text-base font-tajawal max-w-lg mx-auto">
                {t.comingSoon.subtitle}
              </p>
              {/* The same primary the hero opens with, met again at the point
                  the visitor has finished reading and is deciding. */}
              <LandingButton
                onClick={() => { emitLandingEvent('browse_cta_clicked', { location: 'coming_soon' }); onEnter(); }}
                className="mt-2 group"
                trailing={
                  <span aria-hidden="true" className="inline-block transition-transform duration-300 group-hover:translate-x-1.5 rtl:group-hover:-translate-x-1.5 motion-reduce:transition-none">→</span>
                }
              >
                {lang === "ar" ? "جرّب المزاد الحي الآن" : "Try the live auction now"}
              </LandingButton>
            </div>

            {/* Form Box with Slide Reveal and active focus states */}
            <Reveal delay={0.25}>
              <div className="max-w-2xl mx-auto bg-surface-raised border border-line rounded-[10px] p-6 sm:p-10 shadow-[0_12px_32px_rgba(0,0,0,0.08)] relative overflow-hidden">
                <div className="absolute top-0 inset-x-0 h-1 bg-accent rounded-t-[10px]"></div>
                
                <h3 className="text-lg sm:text-xl font-bold text-fg font-alexandria mb-6">
                  {t.comingSoon.formTitle}
                </h3>

                <form onSubmit={handleFormSubmit} className="space-y-4">
                  
                  {/* Full name input */}
                  <div className="text-start">
                    <label htmlFor="full-name" className="text-xs text-fg-muted font-tajawal mb-1 block">
                      {t.comingSoon.formName}
                    </label>
                    <motion.input
                      whileFocus={{ scale: 1.01, borderColor: ACCENT }}
                      type="text"
                      id="full-name"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder={lang === "ar" ? "أدخل اسمك الكريم" : "Enter your full name"}
                      className="w-full bg-surface border border-line rounded-[10px] px-4 py-3 text-sm text-fg placeholder-gray-400 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition duration-200"
                    />
                  </div>

                  {/* Contact phone/email input */}
                  <div className="text-start">
                    <label htmlFor="contact" className="text-xs text-fg-muted font-tajawal mb-1 block">
                      {t.comingSoon.formContact} <span className="text-red-500">*</span>
                    </label>
                    <motion.input
                      whileFocus={{ scale: 1.01, borderColor: ACCENT }}
                      type="text"
                      id="contact"
                      value={formContact}
                      onChange={(e) => setFormContact(e.target.value)}
                      placeholder={lang === "ar" ? "example@email.com أو 0790000000" : "example@email.com or 0790000000"}
                      className="w-full bg-surface border border-line rounded-[10px] px-4 py-3 text-sm text-fg placeholder-gray-400 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition duration-200"
                    />
                  </div>

                  {/* Error Box with AnimatePresence */}
                  <AnimatePresence>
                    {formError && (
                      <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="bg-red-50 border border-red-200 text-red-600 p-3 rounded-[10px] text-xs font-tajawal text-start"
                      >
                        {formError}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Success Box with AnimatePresence */}
                  <AnimatePresence>
                    {formSuccess && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className="bg-green-50 border border-green-200 text-emerald-700 p-3.5 rounded-[10px] text-xs font-tajawal text-start flex items-center gap-2"
                      >
                        <CheckCircle2 className="w-5 h-5 shrink-0 text-accent" />
                        <span>{t.comingSoon.formSuccess}</span>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Submit button */}
                  <motion.button
                    whileHover={{ scale: 1.01 }}
                    whileTap={{ scale: 0.98 }}
                    type="submit"
                    className="w-full py-4 rounded-[10px] bg-accent hover:bg-accent-strong text-white font-bold text-base shadow-sm transition-all duration-200 cursor-pointer font-tajawal"
                  >
                    {t.comingSoon.formSubmit}
                  </motion.button>

                </form>

                {/* Experimental notice */}
                <p className="text-[10px] text-fg-muted font-tajawal mt-5">
                  {t.comingSoon.experimentalNote}
                </p>

                {/* Dynamic local registered waitlist */}
                {waitlist.length > 0 && (
                  <div className="mt-8 pt-6 border-t border-line text-start">
                    <h4 className="text-xs font-bold text-fg font-alexandria mb-3 flex items-center gap-1.5">
                      <Users className="w-4 h-4 text-accent" />
                      <span>{t.comingSoon.registeredTitle} ({waitlist.length})</span>
                    </h4>
                    
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[120px] overflow-y-auto pr-1">
                      {waitlist.map((member, idx) => (
                      <div key={idx} className="bg-surface rounded-[10px] p-2.5 border border-line flex items-center justify-between text-xs">
                        <span className="font-semibold text-fg truncate max-w-[120px] font-tajawal">
                          {member.name}
                        </span>
                        <span className="font-mono text-fg-muted">
                          {member.contact.length > 15 ? member.contact.slice(0, 15) + "..." : member.contact}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
            </Reveal>

          </div>
        </section>

        {/* Final CTA Section (الدعوة الأخيرة للتسجيل والتفاعل) */}
        <section className="py-24 bg-[#0A0A0A] relative overflow-hidden">
          {/* Main Container */}
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
            <div className="relative rounded-3xl overflow-hidden bg-gradient-to-br from-accent to-accent-strong px-6 py-16 sm:px-12 sm:py-20 md:p-20 shadow-2xl">
              
              {/* Decorative visual elements for visual depth */}
              <div className="absolute top-0 left-0 -translate-x-1/3 -translate-y-1/3 w-[300px] sm:w-[500px] h-[300px] sm:h-[500px] rounded-full bg-surface-raised/10 blur-3xl pointer-events-none" />
              <div className="absolute bottom-0 right-0 translate-x-1/4 translate-y-1/4 w-[250px] sm:w-[400px] h-[250px] sm:h-[400px] rounded-full bg-black/20 blur-2xl pointer-events-none" />
              <div className="absolute top-1/2 right-10 -translate-y-1/2 w-24 h-24 border border-white/15 rounded-full pointer-events-none hidden md:block" />
              <div className="absolute bottom-10 left-12 w-16 h-16 border-2 border-white/10 rounded-xl rotate-45 pointer-events-none hidden md:block" />

              <div className="relative z-10 max-w-3xl mx-auto text-center space-y-8">
                <Reveal>
                  <h2 className="text-4xl md:text-5xl font-bold text-white font-alexandria leading-tight">
                    {lang === "ar" ? "جاهز تبيع بسرعة أو تشتري بأمان؟" : "Ready to sell quickly or buy safely?"}
                  </h2>
                </Reveal>

                <Reveal delay={0.15}>
                  <p className="text-white/90 text-sm sm:text-lg font-tajawal max-w-xl mx-auto leading-relaxed">
                    {lang === "ar"
                      ? "انضم اليوم واستفد من فترة بدون رسوم عرض — البائع يستلم 95٪ وعمولتنا 5٪ فقط عند البيع الفعلي، + عمولة مشترٍ 5٪ عند الفوز."
                      : "Join today and take advantage of a listing fee-free period — sellers keep 95% with just 5% commission on actual sales, +5% buyer's premium on wins."}
                  </p>
                </Reveal>

                <Reveal delay={0.3}>
                  <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
                    {/* NOTE, deliberately left alone: this button says "ابدأ
                        البيع الآن" but runs `onEnter()` and reports
                        `browse_cta_clicked` — it browses. Behaviour and
                        tracking are preserved exactly as found; only the
                        styling is unified here. The label/handler mismatch is
                        worth resolving, but silently changing either one would
                        move a funnel number under someone's feet. */}
                    <LandingButton
                      variant="inverted"
                      onClick={() => { emitLandingEvent('browse_cta_clicked', { location: 'final' }); onEnter(); }}
                      className="w-full sm:w-auto rounded-full"
                    >
                      {lang === "ar" ? "ابدأ البيع الآن" : "Start Selling Now"}
                    </LandingButton>
                    
                    <motion.button
                      type="button"
                      onClick={() => { emitLandingEvent('browse_cta_clicked', { location: 'final_secondary' }); onEnter(); }}
                      whileHover={{ scale: 1.05, backgroundColor: "rgba(255, 255, 255, 0.1)" }}
                      whileTap={{ scale: 0.98 }}
                      className="w-full sm:w-auto px-8 py-4 rounded-full border-2 border-white bg-transparent text-white font-bold font-tajawal text-base transition-colors duration-200 text-center cursor-pointer"
                    >
                      {lang === "ar" ? "تصفح المزادات" : "Browse Auctions"}
                    </motion.button>
                  </div>
                </Reveal>
              </div>
            </div>
          </div>
        </section>

      </main>

      {/* 9. Footer (الفوتر) */}
      <footer className="bg-surface border-t border-line py-12 relative z-10 text-fg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          
          <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-center pb-8 border-b border-line">
            
            {/* Logo and Tagline Column */}
            <div className="md:col-span-5 space-y-4 text-center md:text-start">
              <div className="flex items-center justify-center md:justify-start">
                <Logo className="h-8" iconClassName="h-8 w-8" textClassName="text-xl font-black text-fg font-sans" />
              </div>
              <p className="text-xs text-fg-muted font-tajawal leading-relaxed max-w-sm">
                {t.footer.desc}
              </p>
            </div>

            {/* Quick Links Column */}
            <div className="md:col-span-7 flex flex-wrap items-center justify-center md:justify-end gap-6 text-xs font-semibold text-fg-muted">
              <a href="#why-mazzado" onClick={onSectionLinkClick("why-mazzado")} className="hover:text-accent transition-colors duration-200 font-tajawal">
                {t.footer.links.whyUs}
              </a>
              <a href="#categories" onClick={onSectionLinkClick("categories")} className="hover:text-accent transition-colors duration-200 font-tajawal">
                {t.footer.links.categories}
              </a>
              <a href="#pricing" onClick={onSectionLinkClick("pricing")} className="hover:text-accent transition-colors duration-200 font-tajawal">
                {t.nav.pricing}
              </a>
              <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className="hover:text-accent transition-colors duration-200 font-tajawal font-semibold">
                {t.footer.links.contact}
              </a>
              <button
                type="button"
                onClick={() => setIsRulesOpen(true)}
                className="hover:text-accent transition-colors duration-200 font-tajawal cursor-pointer bg-transparent border-none p-0 text-xs font-semibold text-fg-muted"
              >
                {lang === "ar" ? "قواعد المزاد" : "Auction Rules"}
              </button>
              <button
                type="button"
                onClick={() => setIsTermsOpen(true)}
                className="hover:text-accent transition-colors duration-200 font-tajawal cursor-pointer bg-transparent border-none p-0 text-xs font-semibold text-fg-muted"
              >
                {lang === "ar" ? "شروط الاستخدام" : "Terms of Use"}
              </button>
              <button
                type="button"
                onClick={() => setIsTermsOpen(true)}
                className="hover:text-accent transition-colors duration-200 font-tajawal cursor-pointer bg-transparent border-none p-0 text-xs font-semibold text-fg-muted"
              >
                {lang === "ar" ? "سياسة الخصوصية" : "Privacy Policy"}
              </button>
            </div>

          </div>

          {/* Company / Contact Info */}
          <div className="pt-6 flex flex-col items-center justify-center gap-2.5 text-center text-xs text-fg-muted font-tajawal">
            
            {/* ONE line, not two. This was a customer-service number and a
                separate auctions-and-payment number; both now resolve to the
                single official line, and printing the same digits twice under
                two different labels reads as a mistake. The displayed form comes
                from the constant so it can never disagree with the tel: target
                sitting on the same element — which is exactly how the old pair
                drifted. */}
            <div className="flex items-center justify-center">
              <a href={SUPPORT_PHONE_TEL} className="flex items-center gap-1.5 hover:text-accent transition-colors duration-200">
                <span>{lang === "ar" ? "خدمة العملاء والمزادات:" : "Customer Service & Auctions:"}</span>
                <span className="font-mono" dir="ltr">{SUPPORT_PHONE_NATIONAL}</span>
              </a>
            </div>
            <span className="text-[11px] text-fg-muted">
              {lang === "ar"
                ? "ساعات العمل: 10 صباحاً – 7 مساءً · السبت إلى الخميس"
                : "Working hours: 10 AM – 7 PM · Saturday to Thursday"}
            </span>

            {/* Social. The URL is the CANONICAL profile — the link supplied
                carried an `igsi=` parameter, which is a share-session token
                Instagram appends when you tap Share in the app. It is not part
                of the address, it identifies the share that produced the link,
                and publishing it on every page would republish that token to
                every visitor. The profile resolves identically without it.

                44px target, matching the header controls; `noreferrer` so the
                profile is not handed this site's referrer, and `aria-label`
                because the icon carries no text. */}
            <div className="pt-1 flex items-center justify-center">
              <a
                href={SOCIAL_INSTAGRAM_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={lang === "ar" ? "مزادو على إنستغرام" : "MAZZADO on Instagram"}
                title={lang === "ar" ? "مزادو على إنستغرام" : "MAZZADO on Instagram"}
                className="flex h-11 w-11 items-center justify-center rounded-2xl border border-line/70 bg-surface-raised text-fg-muted shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:border-accent/40 hover:text-accent"
              >
                <Instagram className="h-[18px] w-[18px]" />
              </a>
            </div>
          </div>

          {/* The registered-entity line and the street address were REMOVED from
              the footer on request, 2026-08-26. The wrapper went with them — an
              empty div with padding leaves a silent gap in the footer rhythm. */}

          {/* Copyrights and Jordan Badge */}
          <div className="pt-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-center">
            <p className="text-xs text-fg-muted font-tajawal">
              {t.footer.rights}
            </p>

            {/* Tiny secure seal */}
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface-raised border border-line text-[10px] text-fg-muted font-tajawal shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
              <Lock className="w-3 h-3 text-accent" />
              <span>{lang === "ar" ? "مزادات تعمل في الأردن" : "Auctions operating in Jordan"}</span>
            </div>
          </div>

        </div>
      </footer>

      {/* Mobile Sticky CTA Bar */}
      <AnimatePresence>
        {showStickyBar && (
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
            className="fixed bottom-0 left-0 right-0 z-50 bg-surface-raised/95 backdrop-blur-md border-t border-line p-3 shadow-[0_-8px_24px_rgba(0,0,0,0.06)] md:hidden flex items-center justify-between gap-3"
          >
            {/* One DOMINANT action, not one action. Both buttons used to be
                `flex-1` — equal width, a filled gradient beside a 2px-outlined
                twin — so the bar asked the visitor to choose at the exact
                moment they had finished reading and were ready to act.
                The ratio is proportional, never fixed: `flex-[2]` against
                `flex-[1]` off a zero basis, so the split is 2:1 of whatever
                width the phone actually has and both labels keep their share
                when Arabic runs longer than English. `min-w-0` lets a cell
                shrink below its content instead of forcing the bar wider than
                the viewport. Selling stays a real, visible button — quieter,
                not hidden. */}
            <LandingButton
              size="sm"
              onClick={() => { emitLandingEvent('browse_cta_clicked', { location: 'sticky' }); onEnter(); }}
              className="flex-[2] basis-0 min-w-0"
            >
              {lang === "ar" ? "اشترك وزايد — العضوية 1 د.أ شهرياً" : "Subscribe to bid — 1 JOD/month"}
            </LandingButton>
            <LandingButton
              variant="secondary"
              size="sm"
              onClick={() => { emitLandingEvent('seller_cta_clicked', { location: 'sticky' }); onEnter('upload'); }}
              className="flex-[1] basis-0 min-w-0"
            >
              {lang === "ar" ? "بيع قطعتك" : "Sell"}
            </LandingButton>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Terms of Use & Privacy Policy modal (opened from the footer) */}
      <TermsModal isOpen={isTermsOpen} onClose={() => setIsTermsOpen(false)} />

      {/* E4 — plain-language Auction Rules modal (opened from the footer) */}
      <AuctionRulesModal isOpen={isRulesOpen} onClose={() => setIsRulesOpen(false)} isAr={lang === "ar"} />


    </div>
  );
}
