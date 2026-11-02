import React from "react";
import { ArrowLeft, ArrowRight, Flame } from "lucide-react";
import { LandingButton } from "./LandingButton";
import { useCountdownSeconds } from "../../hooks/useCountdownSeconds";
import { splitCountdown, hasAuctionStarted, parseAuctionStart, pad2 } from "../auctionCountdown";

/* ==========================================================================
   THE THREE THINGS YOU EDIT. Everything else follows from them.
   ========================================================================== */

/**
 * When bidding opens. ISO 8601 WITH AN EXPLICIT OFFSET — `+03:00` is Amman.
 *
 * The offset is not optional. `'2026-09-24T20:00:00'` (no offset) is parsed in
 * the VISITOR'S timezone, so the same banner would count down to 20:00 local
 * for someone in Dubai and 20:00 local for someone in London — two different
 * moments, neither of them the launch. With the offset it is one instant
 * worldwide.
 *
 * A typo here is safe: parseAuctionStart returns null, the clock shows zeros
 * and the section stays in its pre-launch state rather than announcing that an
 * auction is open.
 */
/*
 * 15 November 2026, 20:00 Jordan time — the launch Karam set.
 *
 * THE DATE AND THE LOT ARE TWO SEPARATE FACTS. The previous value, 2026-09-24,
 * had quietly passed over a month before anyone noticed, and because `started`
 * was derived from the clock ALONE the section spent that month announcing
 * «المزاد بدأ الآن» with a «زايد الآن» button over a lot that does not exist —
 * on the section paid ad traffic lands on. The guard in the component now makes
 * a passed date harmless: until AUCTION_ID is set, this value only decides what
 * the countdown counts down to.
 *
 * ON 15 NOVEMBER, `iphoneAuctionGate.wiring.test.ts` STARTS FAILING if
 * AUCTION_ID is still null. That is deliberate and it is the whole point: a
 * build that stops is cheaper than another month of a promotional button that
 * leads nowhere. Set AUCTION_ID to the real lot and it passes again.
 */
export const AUCTION_START_DATE = "2026-11-15T20:00:00+03:00";

/**
 * The lot, once it exists in Firestore. Until then the buttons fall back to
 * Discover — a promotional CTA that leads nowhere is worse than one that leads
 * somewhere real but general. Set this to the auction id and both buttons
 * follow it; nothing else changes.
 */
export const AUCTION_ID: string | null = null;

/**
 * Product shot, served from `public/` so it is a plain static file — no import,
 * no bundler hashing, and it can be replaced without a rebuild.
 *
 * SAVE THE FILE AS `public/iphone-17-pro-max.png` and it appears. Until it
 * exists the card falls back to a plain device silhouette (see `onError`
 * below), so a missing file degrades to something deliberately unfinished
 * rather than to a broken-image icon.
 *
 * Set to null to force the silhouette.
 */
export const AUCTION_IMAGE_URL: string | null = "/iphone-17-pro-max.png";

/* ========================================================================== */

export interface IPhoneAuctionCopy {
  badge: string;
  titleBefore: string;
  titleAccent: string;
  titleAfter: string;
  subtitle: string;
  openingPrice: string;
  units: { days: string; hours: string; minutes: string; seconds: string };
  ctaRegister: string;
  ctaDetails: string;
  liveTitle: string;
  ctaLive: string;
  productName: string;
  productTagline: string;
}

interface Props {
  isAr: boolean;
  copy: IPhoneAuctionCopy;
  /** Same navigation callback every other landing section uses. */
  onEnter: (target?: string) => void;
  /** Opens the EXISTING phone+OTP sign-in. No new registration system. */
  onRegister: () => void;
}

/**
 * One countdown cell. Tabular numerals so the width never jitters as digits tick.
 *
 * `flex-1 min-w-0` rather than a fixed min-width. Four 62px boxes plus three
 * separators and six gaps need 302px; the card's content column on a 344px
 * phone is 255px. The boxes could not shrink, so the last one rendered at
 * x=-10 and `overflow-hidden` silently ate it — the clock read as three units
 * on a real phone. Sharing the row means they fit whatever the width is.
 */
function TimeBox({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-center flex-1 min-w-0">
      <div
        className="w-full rounded-2xl bg-surface-sunken/80 border border-line/60 px-1.5 py-2.5 sm:px-5 sm:py-3.5 text-center"
      >
        <span
          className="block text-2xl sm:text-4xl font-black text-fg tabular-nums leading-none tracking-tight"
          // Digits are Latin even in Arabic here: the rest of the app renders
          // prices and counters the same way, and mixing ٠١٢ into a card that
          // also shows "iPhone 17" reads as two different products.
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {value}
        </span>
      </div>
      <span className="mt-1.5 text-[10px] sm:text-xs font-bold text-fg-muted">{label}</span>
    </div>
  );
}

/** The ':' between cells — hidden from screen readers, which get the labels. */
function Sep() {
  return (
    <span aria-hidden="true" className="self-start pt-3 sm:pt-5 text-lg sm:text-2xl font-black text-fg-muted/40">
      :
    </span>
  );
}

/**
 * The launch announcement that sits directly under the hero.
 *
 * NO TIMER OF ITS OWN. It subscribes to the app's single shared 1s ticker via
 * useCountdownSeconds, on the server-corrected clock — the same mechanism every
 * auction card uses. A private setInterval here would be a second clock on the
 * busiest page of the site, and would disagree with the lot's own countdown for
 * any visitor whose device clock is off.
 */
export function IPhoneAuctionSection({ isAr, copy, onEnter, onRegister }: Props) {
  // A missing/blocked product shot falls back to the silhouette instead of
  // rendering a broken-image icon on the landing page.
  const [imageFailed, setImageFailed] = React.useState(false);
  const startMs = React.useMemo(() => parseAuctionStart(AUCTION_START_DATE), []);
  const secondsLeft = useCountdownSeconds(startMs, true);
  // A date that has passed is not an auction. AUCTION_ID is what makes the lot
  // real — `goToAuction` below falls through to Discover without it — so the
  // clock alone must not be allowed to announce that bidding is open.
  //
  // The header comment already explains that a TYPO in the start date is safe,
  // because the section stays pre-launch. This is the other half of that
  // promise: a date that is perfectly well-formed and simply in the past, on a
  // launch nobody wired up, was not safe at all.
  const started = AUCTION_ID !== null && hasAuctionStarted(secondsLeft);
  const { days, hours, minutes, seconds } = splitCountdown(secondsLeft);

  // Until the lot exists in Firestore, "view details" and "bid now" both go to
  // Discover. One constant switches both.
  const goToAuction = () => onEnter(AUCTION_ID ? "live" : "discovery");
  const Arrow = isAr ? ArrowLeft : ArrowRight;

  return (
    <section
      aria-labelledby="iphone-auction-heading"
      className="relative px-4 sm:px-6 lg:px-8 -mt-2 sm:-mt-4 mb-10 sm:mb-16"
    >
      <div className="max-w-6xl mx-auto">
        <div className="relative overflow-hidden rounded-3xl bg-surface-raised border border-line shadow-lg">
          {/* A single soft accent wash. Not a gradient button, not a glow — the
              hero above already owns the page's one primary action's emphasis. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-24 -start-24 w-72 h-72 rounded-full opacity-[0.07] blur-3xl"
            style={{ background: "var(--color-accent)" }}
          />

          <div className="relative grid gap-6 lg:grid-cols-[1.15fr_0.85fr] items-center p-5 sm:p-8 lg:p-10">
            {/* ---- copy + clock ---- */}
            <div className="min-w-0">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 text-accent-ink px-3 py-1.5 text-[11px] sm:text-xs font-black">
                <Flame className="w-3.5 h-3.5" aria-hidden="true" />
                {copy.badge}
              </span>

              <h2
                id="iphone-auction-heading"
                className="mt-3 sm:mt-4 text-3xl sm:text-5xl font-black text-fg leading-[1.25] tracking-tight"
              >
                {copy.titleBefore}
                <span className="text-accent">{copy.titleAccent}</span>
                {copy.titleAfter}
              </h2>

              <p className="mt-2 text-sm sm:text-lg text-fg-muted font-medium">{copy.subtitle}</p>

              {/* Approved addition — not in the original mockup. */}
              <p className="mt-1.5 text-sm sm:text-base font-black text-accent-ink">{copy.openingPrice}</p>

              {started ? (
                <div className="mt-5 sm:mt-7">
                  <p className="text-xl sm:text-3xl font-black text-fg">{copy.liveTitle}</p>
                  <div className="mt-4">
                    <LandingButton
                      variant="primary"
                      size="lg"
                      onClick={goToAuction}
                      className="w-full sm:w-auto whitespace-nowrap"
                      trailing={<Arrow className="w-4 h-4 shrink-0" aria-hidden="true" />}
                    >
                      {copy.ctaLive}
                    </LandingButton>
                  </div>
                </div>
              ) : (
                <>
                  {/* aria-live is deliberately absent: a per-second live region
                      would make a screen reader announce the clock every
                      second and bury the rest of the page. */}
                  <div className="mt-5 sm:mt-7 flex items-start gap-1 sm:gap-3 w-full max-w-md">
                    <TimeBox value={pad2(days)} label={copy.units.days} />
                    <Sep />
                    <TimeBox value={pad2(hours)} label={copy.units.hours} />
                    <Sep />
                    <TimeBox value={pad2(minutes)} label={copy.units.minutes} />
                    <Sep />
                    <TimeBox value={pad2(seconds)} label={copy.units.seconds} />
                  </div>

                  {/* Stacked below 640px, side by side above it. `flex-wrap`
                      alone was not enough: on a 344px screen the two shared a
                      row, the primary was squeezed to 158px, and «سجّل
                      للمزايدة» broke across three lines with the arrow on its
                      own. A CTA that tall reads as a layout bug on the first
                      screen paid traffic sees. */}
                  <div className="mt-6 sm:mt-8 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5">
                    {/* The arrow goes in `trailing`, not in children.
                        LandingButton renders `<span>{children}</span>{trailing}`
                        — an icon passed as a child lands INSIDE that span,
                        which is not a flex container, so it dropped onto its
                        own line and made the button 73px tall. */}
                    <LandingButton
                      variant="primary"
                      size="lg"
                      onClick={onRegister}
                      className="w-full sm:w-auto whitespace-nowrap"
                      trailing={<Arrow className="w-4 h-4 shrink-0" aria-hidden="true" />}
                    >
                      {copy.ctaRegister}
                    </LandingButton>
                    <button
                      type="button"
                      onClick={goToAuction}
                      className="self-center sm:self-auto text-sm sm:text-base font-bold text-fg underline underline-offset-[6px] decoration-line hover:decoration-accent transition-colors cursor-pointer"
                    >
                      {copy.ctaDetails}
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* ---- product ---- */}
            <div className="flex items-center justify-center gap-4 sm:gap-6">
              {AUCTION_IMAGE_URL && !imageFailed ? (
                <img
                  src={AUCTION_IMAGE_URL}
                  alt={copy.productName}
                  // Not lazy: this sits in the first screenful on mobile, and a
                  // lazily-loaded hero image is the one that arrives visibly
                  // late. The silhouette below holds the same box meanwhile, so
                  // nothing reflows when it lands.
                  decoding="async"
                  onError={() => setImageFailed(true)}
                  className="w-40 sm:w-56 lg:w-64 h-auto object-contain drop-shadow-2xl"
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="w-32 sm:w-44 lg:w-52 aspect-[9/19] rounded-[2rem] bg-gradient-to-b from-slate-800 to-slate-950 border-4 border-slate-700 shadow-2xl flex items-start justify-center pt-3"
                >
                  <span className="w-12 h-1.5 rounded-full bg-slate-600" />
                </div>
              )}

              <div className="text-center shrink-0">
                <p className="text-lg sm:text-2xl font-black text-fg leading-tight" dir="ltr">
                  {copy.productName}
                </p>
                <span aria-hidden="true" className="block mx-auto my-2 w-6 h-px bg-line" />
                <p className="text-[11px] sm:text-sm text-fg-muted font-medium leading-snug" dir="ltr">
                  {copy.productTagline}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default IPhoneAuctionSection;
