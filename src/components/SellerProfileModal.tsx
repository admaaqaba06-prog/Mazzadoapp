import React, { useState, useMemo, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { calculateTrustScore, getSellerBadges } from '../utils/trust';
import { db } from '../services/firebase';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { Review } from '../types';
import { resolveAvatarUrl } from '../utils/avatarPlaceholder';
import { sellerReputation } from '../utils/reputation';
import { StarRating } from './ui/StarRating';
import { JORDAN_GOVERNORATES } from '../utils/jordanCities';
import {
  X, ShieldCheck, MapPin, Calendar, Award, Star, 
  Users, Percent, Clock, AlertTriangle, MessageSquare, 
  ThumbsUp, Sparkles, ShieldAlert
} from 'lucide-react';

interface SellerProfileModalProps {
  sellerId: string;
  isOpen: boolean;
  onClose: () => void;
}

export const SellerProfileModal: React.FC<SellerProfileModalProps> = ({ sellerId, isOpen, onClose }) => {
  const { 
    sellerProfiles, 
    orders, 
    submitSellerReport, 
    currentUser, 
    language 
  } = useApp();

  const isAr = language === 'ar';
  const [reportReason, setReportReason] = useState<any>('');
  const [reportDesc, setReportDesc] = useState<string>('');
  const [isReporting, setIsReporting] = useState<boolean>(false);
  const [isSubmitSuccess, setIsSubmitSuccess] = useState<boolean>(false);
  const [sellerReviews, setSellerReviews] = useState<Review[]>([]);
  const [isLoadingReviews, setIsLoadingReviews] = useState<boolean>(false);

  // Find seller profile
  const profile = useMemo(() => {
    return sellerProfiles.find(p => p.userId === sellerId) || sellerProfiles.find(p => p.id === sellerId);
  }, [sellerProfiles, sellerId]);

  /**
   * The seller's location, or null when we genuinely do not know it.
   *
   * `location` is a free-text field that nothing currently writes, so this is
   * null for every seller today and the row is hidden. It resolves a stored
   * governorate id ('irbid') to its display name so that when the field does
   * start being collected, the profile reads «إربد» and not «irbid».
   */
  const sellerLocationLabel = useMemo(() => {
    const raw = (profile?.location ?? '').trim();
    if (!raw) return null;
    const gov = JORDAN_GOVERNORATES.find(g => g.id === raw.toLowerCase());
    return gov ? (isAr ? gov.ar : gov.en) : raw;
  }, [profile?.location, isAr]);

  // Load reviews on-demand
  useEffect(() => {
    if (!isOpen || !sellerId) {
      setSellerReviews([]);
      return;
    }
    
    setIsLoadingReviews(true);
    const targetUserId = profile?.userId || sellerId;
    
    const reviewsQuery = query(
      collection(db, 'reviews'), 
      where('sellerId', '==', targetUserId)
    );
    
    getDocs(reviewsQuery)
      .then((snap) => {
        const list: Review[] = [];
        snap.forEach((d) => {
          list.push({ id: d.id, ...d.data() } as Review);
        });
        list.sort((a, b) => b.timestamp - a.timestamp);
        setSellerReviews(list.slice(0, 50));
      })
      .catch((err) => {
        console.warn("Failed to load seller reviews on-demand:", err);
      })
      .finally(() => {
        setIsLoadingReviews(false);
      });
  }, [isOpen, sellerId, profile?.userId]);

  const sellerOrders = useMemo(() => {
    if (!profile) return [];
    return orders.filter(o => o.sellerId === profile.userId);
  }, [orders, profile]);

  const completedCount = useMemo(() => {
    if (sellerOrders.length === 0) return profile?.totalSales || 0;
    return sellerOrders.filter(o => o.status === 'completed').length;
  }, [sellerOrders, profile?.totalSales]);

  const deliveredCount = useMemo(() => {
    if (sellerOrders.length === 0) return (profile?.totalSales || 0);
    return sellerOrders.filter(o => o.status === 'completed' || o.status === 'shipped' || o.status === 'out_for_delivery' || o.status === 'delivered').length;
  }, [sellerOrders, profile?.totalSales]);

  const cancelledCount = useMemo(() => {
    if (sellerOrders.length === 0) {
      const rate = profile?.cancellationRate || 0;
      const total = profile?.totalSales || 0;
      return Math.round((rate / 100) * total);
    }
    return sellerOrders.filter(o => o.status === 'cancelled').length;
  }, [sellerOrders]);

  const disputesLostCount = 0;

  // E7 B2 — prefer the real computed reputation (buyer_rates_auction reviews) when
  // there is at least one real rating; otherwise fall back to the seeded profile
  // rating so seeded/new sellers still render a sensible value.
  const realReputation = useMemo(
    () => sellerReputation(sellerReviews, profile?.userId || sellerId),
    [sellerReviews, profile?.userId, sellerId],
  );
  const averageRating = useMemo(() => {
    if (realReputation.count >= 1 && realReputation.average !== null) {
      return parseFloat(realReputation.average.toFixed(1));
    }
    if (sellerReviews.length > 0) {
      return parseFloat((sellerReviews.reduce((sum, r) => sum + r.rating, 0) / sellerReviews.length).toFixed(1));
    }
    return profile?.rating || 0;
  }, [realReputation, sellerReviews, profile]);

  // E7 B2 — the reviews query keys on sellerId, which now also matches lightweight
  // buyer_rates_auction docs ({ stars, text, buyerId, createdAt, direction }). Normalize
  // every loaded doc into the rich display shape so real ratings render (with a generic
  // buyer name) instead of malformed 0-star / "Invalid Date" cards.
  const normalizedReviews = useMemo(() => {
    return sellerReviews
      .map((rev) => {
        const r = rev as any;
        const rating = (typeof r.rating === 'number' ? r.rating : r.stars) || 0;
        const comment = r.comment ?? r.text ?? '';
        const buyerName = r.buyerName || (isAr ? 'مشترٍ' : 'Buyer');
        const buyerAvatar = r.buyerAvatar || '';
        const timestamp =
          typeof r.timestamp === 'number'
            ? r.timestamp
            : (r.createdAt?.toMillis?.() ?? (r.createdAt?.seconds ? r.createdAt.seconds * 1000 : 0));
        return {
          id: r.id as string,
          rating,
          comment,
          buyerName,
          buyerAvatar,
          buyerId: r.buyerId as string | undefined,
          auctionTitle: r.auctionTitle as string | undefined,
          photos: r.photos as string[] | undefined,
          response: r.response as string | undefined,
          responseAt: r.responseAt as number | undefined,
          timestamp,
        };
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [sellerReviews, isAr]);

  // Dynamic Trust Score
  const trustScore = useMemo(() => {
    if (!profile) return 50;
    const status = profile.verificationStatus || 'not_verified';
    return calculateTrustScore(
      status,
      completedCount,
      deliveredCount,
      cancelledCount,
      disputesLostCount,
      averageRating,
      6 // Account age in months (assumed)
    );
  }, [profile, completedCount, deliveredCount, cancelledCount, averageRating]);

  // Dynamic Badges
  const badges = useMemo(() => {
    if (!profile) return [];
    const status = profile.verificationStatus || 'not_verified';
    return getSellerBadges(
      status,
      completedCount,
      averageRating,
      profile.responseTime || 'Under 1 hour'
    );
  }, [profile, completedCount, averageRating]);

  if (!isOpen || !profile) return null;

  const statusColors = {
    premium_verified: 'bg-amber-500/10 text-amber-400 border border-amber-500/35',
    verified: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/35',
    pending: 'bg-blue-500/10 text-blue-400 border border-blue-500/35',
    not_verified: 'bg-gray-500/10 text-fg-muted border border-gray-500/35'
  };

  const statusLabels = {
    premium_verified: isAr ? 'موثق متميز' : 'Premium Verified',
    verified: isAr ? 'بائع موثق' : 'Verified Seller',
    pending: isAr ? 'قيد التوثيق' : 'Verification Pending',
    not_verified: isAr ? 'غير موثق' : 'Not Verified'
  };

  const handleReportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reportReason || !reportDesc.trim()) return;
    const res = await submitSellerReport(profile.userId, profile.storeName, reportReason, reportDesc);
    if (res.success) {
      setIsSubmitSuccess(true);
      setTimeout(() => {
        setIsReporting(false);
        setIsSubmitSuccess(false);
        setReportReason('');
        setReportDesc('');
      }, 2000);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[999] flex items-center justify-center p-4">
      <div className="bg-[#0B0B0F] w-full max-w-2xl rounded-3xl overflow-hidden border border-zinc-800 flex flex-col max-h-[90vh]">
        
        {/* Header/Cover Image Area */}
        <div className="relative h-32 bg-gradient-to-r from-orange-600 to-amber-500 shrink-0">
          {profile.coverImage ? (
            <img 
              src={profile.coverImage} 
              alt={isAr ? 'صورة الغلاف' : 'Cover image'} 
              className="w-full h-full object-cover opacity-80"
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-tr from-[#FF6B00]/30 to-[#ECA234]/10 backdrop-blur-xs"></div>
          )}
          
          {/* Close button */}
          <button 
            onClick={onClose}
            className="absolute top-4 right-4 w-8 h-8 rounded-full bg-black/60 border border-white/10 flex items-center justify-center text-white hover:bg-black/90 cursor-pointer z-10"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Profile Details Scrollable Canvas */}
        <div className="flex-1 overflow-y-auto p-6 relative">
          
          {/* Avatar and Main Info Overlay */}
          <div className="flex flex-col sm:flex-row gap-4 -mt-16 sm:-mt-20 mb-6 items-start sm:items-end">
            <img
              src={resolveAvatarUrl(profile.storeLogo, profile.userId)}
              alt={profile.storeName}
              className="w-24 h-24 sm:w-28 sm:h-28 rounded-2xl object-cover border-4 border-[#0B0B0F] shadow-xl shrink-0 bg-zinc-900"
            />
            <div className="flex-grow text-left rtl:text-right min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl sm:text-2xl font-black text-white truncate leading-none">
                  {profile.storeName}
                </h2>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-black uppercase tracking-wider ${statusColors[profile.verificationStatus || 'not_verified']}`}>
                  {statusLabels[profile.verificationStatus || 'not_verified']}
                </span>
              </div>
              <p className="text-zinc-400 text-xs mt-2 font-medium">
                @{profile.userId.substring(0, 8)}
              </p>
            </div>
          </div>

          {/* Grid of Key Trust Indicators */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            
            {/* Trust Score Card */}
            <div className="bg-zinc-900/60 p-3.5 rounded-2xl border border-white/5 flex flex-col justify-between text-left rtl:text-right">
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 text-[10px] font-black tracking-wide uppercase">
                  {isAr ? 'مؤشر الثقة' : 'Trust Score'}
                </span>
                <Sparkles className="w-4 h-4 text-orange-400" />
              </div>
              <div className="mt-2.5">
                <span className="text-2xl font-black text-white">{trustScore}</span>
                <span className="text-zinc-500 text-xs font-bold">/100</span>
              </div>
              <div className="w-full bg-zinc-800 h-1.5 rounded-full mt-2 overflow-hidden">
                <div 
                  className="bg-gradient-to-r from-[#FF6B00] to-emerald-400 h-full rounded-full transition-all duration-500"
                  style={{ width: `${trustScore}%` }}
                ></div>
              </div>
            </div>

            {/* Average Rating Card */}
            <div className="bg-zinc-900/60 p-3.5 rounded-2xl border border-white/5 flex flex-col justify-between text-left rtl:text-right">
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 text-[10px] font-black tracking-wide uppercase">
                  {isAr ? 'التقييم' : 'Rating'}
                </span>
                <Star className="w-4 h-4 text-amber-400 fill-amber-400" />
              </div>
              <div className="mt-2.5">
                <span className="text-2xl font-black text-white">{averageRating}</span>
                <span className="text-zinc-500 text-xs font-bold"> ({realReputation.count >= 1 ? realReputation.count : sellerReviews.length} {isAr ? 'تقييم' : 'reviews'})</span>
              </div>
              <div className="mt-1.5">
                <StarRating value={averageRating} size={13} showValue={false} />
              </div>
              <p className="text-[10px] text-zinc-400 font-bold mt-2">
                {realReputation.count >= 1
                  ? (isAr ? 'تقييمات حقيقية من المشترين' : 'Real buyer ratings')
                  : (isAr ? 'تحديث تلقائي فوري' : 'Dynamic Auto-Updated')}
              </p>
            </div>

            {/* Completed Sales Card */}
            <div className="bg-zinc-900/60 p-3.5 rounded-2xl border border-white/5 flex flex-col justify-between text-left rtl:text-right">
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 text-[10px] font-black tracking-wide uppercase">
                  {isAr ? 'مبيعات ناجحة' : 'Sales'}
                </span>
                <ThumbsUp className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="mt-2.5">
                <span className="text-2xl font-black text-white">{profile.totalSales + completedCount}</span>
                <span className="text-zinc-500 text-xs font-bold"> {isAr ? 'طلب' : 'orders'}</span>
              </div>
              <p className="text-[10px] text-emerald-400 font-bold mt-2">
                {isAr ? 'توصيل موثوق' : 'Reliable Deliveries'}
              </p>
            </div>

            {/* Response Time & Cancellation Card */}
            <div className="bg-zinc-900/60 p-3.5 rounded-2xl border border-white/5 flex flex-col justify-between text-left rtl:text-right">
              <div className="flex items-center justify-between">
                <span className="text-zinc-500 text-[10px] font-black tracking-wide uppercase">
                  {isAr ? 'الاستجابة / الإلغاء' : 'Response/Cancel'}
                </span>
                <Clock className="w-4 h-4 text-sky-400" />
              </div>
              <div className="mt-2.5">
                <div className="flex items-center gap-1 text-white font-black text-xs">
                  <Clock className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span>{profile.responseTime || (isAr ? 'خلال ساعة' : '1 Hour')}</span>
                </div>
                <div className="flex items-center gap-1 text-red-400 font-black text-xs mt-1">
                  <Percent className="w-3.5 h-3.5 shrink-0" />
                  <span>{profile.cancellationRate || 0}% {isAr ? 'إلغاء' : 'Cancel'}</span>
                </div>
              </div>
              <p className="text-[9px] text-zinc-500 font-bold mt-2 truncate">
                {isAr ? 'مؤشرات الأداء الفعلية' : 'Verified Platform Metrics'}
              </p>
            </div>

          </div>

          {/* Location & Dates row.
              BOTH OF THESE USED TO BE INVENTED. Location fell back to «عمان،
              الأردن» and the join date to 'June 2026', so every seller on the
              platform was shown as an Amman seller who joined in June —
              including sellers in Irbid and Aqaba, and accounts opened last
              week. `location` is in fact never written by anything, so the
              fallback was the ONLY value this line ever rendered.
              A fact we do not have is now simply not shown. */}
          <div className="flex flex-wrap items-center gap-4 text-zinc-400 text-xs mb-6 pb-4 border-b border-zinc-800">
            {sellerLocationLabel && (
              <div className="flex items-center gap-1.5 font-bold">
                <MapPin className="w-4 h-4 text-zinc-500" />
                <span>{sellerLocationLabel}</span>
              </div>
            )}
            {profile.joinedDate && (
              <div className="flex items-center gap-1.5 font-bold">
                <Calendar className="w-4 h-4 text-zinc-500" />
                <span>{isAr ? 'انضم' : 'Joined'} {profile.joinedDate}</span>
              </div>
            )}
            <div className="flex items-center gap-1.5 font-bold ml-auto">
              <Users className="w-4 h-4 text-zinc-500" />
              <span><strong>{profile.followers ?? 0}</strong> {isAr ? 'متابع' : 'followers'}</span>
              <span className="text-zinc-600">•</span>
              <span><strong>{profile.following ?? 0}</strong> {isAr ? 'يتابع' : 'following'}</span>
            </div>
          </div>

          {/* About / Bio */}
          <div className="text-left rtl:text-right mb-6">
            <h3 className="text-xs font-black text-zinc-400 uppercase tracking-wider mb-2">
              {isAr ? 'نبذة عن البائع' : 'About Seller'}
            </h3>
            <p className="bg-zinc-900/35 p-3 rounded-xl border border-white/5 text-zinc-300 text-xs leading-relaxed font-medium">
              {profile.aboutSeller || profile.bio || (isAr ? 'لا يوجد تفاصيل إضافية عن البائع.' : 'No detailed description provided by this seller.')}
            </p>
          </div>

          {/* Dynamic Badges List */}
          {badges.length > 0 && (
            <div className="mb-6 text-left rtl:text-right">
              <h3 className="text-xs font-black text-zinc-400 uppercase tracking-wider mb-2.5 flex items-center gap-1.5">
                <Award className="w-4 h-4 text-amber-400" />
                <span>{isAr ? 'شارات الجدارة المكتسبة' : 'Earned Badges'}</span>
              </h3>
              <div className="flex flex-wrap gap-2">
                {badges.map((badge, idx) => (
                  <span 
                    key={idx} 
                    className="px-3 py-1.5 rounded-xl bg-orange-600/10 border border-orange-500/25 text-[#FF6B00] text-[10.5px] font-black flex items-center gap-1.5 shadow-sm"
                  >
                    <Award className="w-3.5 h-3.5" />
                    {badge}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Reviews List */}
          <div className="text-left rtl:text-right mb-6">
            <h3 className="text-xs font-black text-zinc-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <MessageSquare className="w-4 h-4 text-sky-400" />
              <span>{isAr ? 'آراء المشترين وتقييماتهم' : 'Buyer Reviews'}</span>
            </h3>
            
            {sellerReviews.length === 0 ? (
              <p className="text-zinc-500 text-xs font-bold py-4 text-center">
                {isAr ? 'لا يوجد مراجعات مكتوبة لهذا البائع حتى الآن.' : 'No written reviews for this seller yet.'}
              </p>
            ) : (
              <div className="space-y-4">
                {normalizedReviews.map((rev) => (
                  <div key={rev.id} className="bg-zinc-900/40 p-4 rounded-2xl border border-white/5">
                    <div className="flex items-center gap-3 mb-2.5">
                      <img 
                        src={resolveAvatarUrl(rev.buyerAvatar, rev.buyerId)}
                        alt={isAr ? 'الصورة الشخصية' : 'Avatar'}
                        className="w-8 h-8 rounded-full object-cover bg-zinc-800"
                      />
                      <div>
                        <span className="text-white text-xs font-black block leading-none">{rev.buyerName}</span>
                        <span className="text-[10px] text-zinc-500 font-bold mt-1 block">
                          {new Date(rev.timestamp).toLocaleDateString()} • {rev.auctionTitle}
                        </span>
                      </div>
                      <div className="ml-auto flex items-center gap-0.5">
                        {[1, 2, 3, 4, 5].map((s) => (
                          <Star 
                            key={s} 
                            className={`w-3.5 h-3.5 ${s <= rev.rating ? 'text-amber-400 fill-amber-400' : 'text-fg'}`}
                          />
                        ))}
                      </div>
                    </div>
                    
                    <p className="text-zinc-300 text-xs leading-relaxed font-sans font-medium">
                      {rev.comment}
                    </p>

                    {/* Review photos if uploaded */}
                    {rev.photos && rev.photos.length > 0 && (
                      <div className="flex gap-2 mt-3 overflow-x-auto pb-1">
                        {rev.photos.map((pic, pIdx) => (
                          <img 
                            key={pIdx} 
                            src={pic} 
                            alt={isAr ? 'تفاصيل التقييم' : 'Review detail'} 
                            className="w-16 h-16 rounded-xl object-cover border border-white/10"
                          />
                        ))}
                      </div>
                    )}

                    {/* Seller response block */}
                    {rev.response ? (
                      <div className="mt-3.5 pl-4 rtl:pl-0 rtl:pr-4 border-l-2 rtl:border-l-0 rtl:border-r-2 border-[#FF6B00] bg-zinc-950/40 p-2.5 rounded-r-xl rtl:rounded-r-none rtl:rounded-l-xl">
                        <span className="text-[#FF6B00] text-[10.5px] font-black block mb-1">
                          {isAr ? 'رد البائع:' : 'Seller Response:'}
                        </span>
                        <p className="text-zinc-400 text-xs font-medium">
                          {rev.response}
                        </p>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Report Seller Button */}
          {currentUser && currentUser.id !== profile.userId && !isReporting && (
            <button 
              onClick={() => setIsReporting(true)}
              className="w-full mt-4 py-3 bg-red-950/20 border border-red-500/20 hover:bg-red-950/40 text-red-400 rounded-xl text-xs font-black flex items-center justify-center gap-2 transition-all cursor-pointer"
            >
              <AlertTriangle className="w-4 h-4" />
              <span>{isAr ? 'الإبلاغ عن هذا البائع' : 'Report This Seller'}</span>
            </button>
          )}

          {/* Real-time Reporting Form Panel */}
          {isReporting && (
            <div className="mt-6 bg-red-950/10 border border-red-500/15 rounded-2xl p-4 text-left rtl:text-right">
              <div className="flex items-center justify-between mb-3 pb-2 border-b border-red-500/10">
                <span className="text-red-400 text-xs font-black flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4" />
                  {isAr ? 'نموذج الإبلاغ عن البائع' : 'Report Abuse & Fraud Form'}
                </span>
                <button 
                  onClick={() => setIsReporting(false)}
                  className="text-zinc-500 hover:text-white text-xs font-bold"
                >
                  {isAr ? 'إلغاء' : 'Cancel'}
                </button>
              </div>

              {isSubmitSuccess ? (
                <div className="py-4 text-center text-emerald-400 font-bold text-xs">
                  ✓ {isAr ? 'تم إرسال بلاغك بنجاح إلى الإدارة للتحقيق.' : 'Your report has been successfully sent to admins.'}
                </div>
              ) : (
                <form onSubmit={handleReportSubmit} className="space-y-3">
                  <div>
                    <label className="block text-zinc-400 text-[10px] font-black uppercase tracking-wider mb-1.5">
                      {isAr ? 'سبب البلاغ المباشر' : 'Primary Abuse Reason'}
                    </label>
                    <select 
                      required
                      value={reportReason}
                      onChange={(e) => setReportReason(e.target.value)}
                      className="w-full bg-[#121216] border border-zinc-800 text-white rounded-xl p-2.5 text-xs focus:border-[#FF6B00] outline-none"
                    >
                      <option value="">{isAr ? '-- اختر السبب --' : '-- Choose Reason --'}</option>
                      <option value="counterfeit">{isAr ? 'منتجات مقلدة ومزيفة' : 'Counterfeit / Fake Item'}</option>
                      <option value="wrong_desc">{isAr ? 'وصف غير صحيح للمنتج' : 'Wrong / Misleading Description'}</option>
                      <option value="damaged">{isAr ? 'منتج تالف أو مكسور' : 'Damaged / Broken Product'}</option>
                      <option value="fraud">{isAr ? 'احتيال ونصب وسلوك مريب' : 'Fraud / Suspicious Behavior'}</option>
                      <option value="other">{isAr ? 'أسباب أخرى عامة' : 'Other Reasons'}</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-zinc-400 text-[10px] font-black uppercase tracking-wider mb-1.5">
                      {isAr ? 'التفاصيل والوصف' : 'Detailed Description'}
                    </label>
                    <textarea 
                      required
                      rows={3}
                      value={reportDesc}
                      onChange={(e) => setReportDesc(e.target.value)}
                      placeholder={isAr ? 'يرجى تقديم تفاصيل واضحة تساعد الإدارة في مراجعة الشكوى...' : 'Please provide any specific evidence or description...'}
                      className="w-full bg-[#121216] border border-zinc-800 text-zinc-300 rounded-xl p-2.5 text-xs focus:border-[#FF6B00] outline-none font-sans font-medium"
                    />
                  </div>

                  <button 
                    type="submit"
                    className="w-full py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-black transition-all cursor-pointer flex items-center justify-center gap-2 shadow-md shadow-red-600/10"
                  >
                    <AlertTriangle className="w-4 h-4" />
                    <span>{isAr ? 'تقديم الشكوى الآن' : 'Submit Abuse Report'}</span>
                  </button>
                </form>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
};
