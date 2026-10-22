import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { db, getCallableFunction } from '../services/firebase';
import { collection, query, where, onSnapshot, getDocs, writeBatch, Timestamp } from 'firebase/firestore';
import { Film, User, ShieldAlert, Check, X, AlertCircle, RotateCcw } from 'lucide-react';
import { isAdminUser } from '../utils/adminAuth';

export const AdminPanel: React.FC = () => {
  const { users, currentUser, setUsers, addNotification, language, escrows, setBids, approveListing, rejectListing } = useApp();
  const isAr = language === 'ar';

  const [activeTab, setActiveTab] = useState<'subscriptions' | 'auctions'>('auctions');
  const [pendingAuctions, setPendingAuctions] = useState<any[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  // Reject-with-reason mini-form: which listing is being rejected + why.
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');

  const handleResetAllAuctions = async () => {
    const confirmMsg = isAr 
      ? "هل أنت متأكد من إعادة تعيين جميع المزادات؟ سيؤدي هذا إلى إعادة تشغيل كافة المزادات وتصفير المزايدات الحالية." 
      : "Are you sure you want to reset all auctions? This will restart all auctions from the beginning.";

    if (!window.confirm(confirmMsg)) {
      return;
    }

    setIsResetting(true);
    try {
      const auctionsCol = collection(db, 'auctions');
      const snapshot = await getDocs(auctionsCol);
      if (snapshot.empty) {
        showToast(isAr ? 'لم يتم العثور على أي مزادات بقاعدة البيانات.' : 'No auctions found in the database.', 'warning');
        setIsResetting(false);
        return;
      }

      const docs = snapshot.docs;
      const resetAuctionIds = docs.map(d => d.id);

      // 1. Reset each auction back to live, and reset timer and pricing
      const chunkSize = 400;
      for (let i = 0; i < docs.length; i += chunkSize) {
        const chunk = docs.slice(i, i + chunkSize);
        const batch = writeBatch(db);
        chunk.forEach((docSnap) => {
          const data = docSnap.data();
          const durationSec = Number(data.duration) || 86400; // fallback to 24 hours if zero, NaN, or missing
          const futureTime = Date.now() + durationSec * 1000;
          const endsAtTimestamp = Timestamp.fromMillis(futureTime);
          const startPrice = data.startingPrice ?? 0;

          batch.update(docSnap.ref, {
            status: 'live',
            endsAt: endsAtTimestamp,
            endTime: futureTime,
            currentPrice: startPrice,
            currentBidderId: null,
            currentBidderName: null,
            totalBids: 0,
            // Clear highest bidder / winner data
            winnerId: null,
            winnerName: null,
            winnerEmail: null,
            winnerPhone: null,
            winnerCity: null,
          });
        });
        await batch.commit();
      }

      // 2. Clear locked escrows related only to ended test auctions via secure Cloud Function
      try {
        const resetTestAuctionDataCallable = await getCallableFunction<{ auctionIds: string[] }, { success: boolean; message: string }>('resetTestAuctionData');
        await resetTestAuctionDataCallable({ auctionIds: resetAuctionIds });
      } catch (escErr) {
        console.warn(`Failed to delete escrow transactions via Cloud Function:`, escErr);
      }

      // 3. Clear bid history for each auction
      if (setBids) {
        setBids([]);
      }
      localStorage.setItem('mazad_bids', '[]');
      localStorage.setItem('mazad_autobids', '[]');

      // 4. Alert success
      showToast(isAr 
        ? "All auctions have been restarted successfully."
        : "All auctions have been restarted successfully.",
        'success'
      );
    } catch (err: any) {
      console.error("Reset auctions error in AdminPanel:", err);
      showToast(isAr ? 'فشل إعادة تهيئة المزادات' : 'Failed to reset auctions', 'warning');
    } finally {
      setIsResetting(false);
    }
  };

  // Filter users who have uploaded payment proof and are waiting for admin review
  const pendingRequests = users.filter(u => u.paymentProofImage);

  // Read pending auctions in real-time
  useEffect(() => {
    // Listen to pending and processing auctions
    const q = query(
      collection(db, 'auctions'),
      where('status', 'in', ['pending', 'processing'])
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const list = snapshot.docs.map(docSnap => ({
        id: docSnap.id,
        ...docSnap.data()
      }));
      setPendingAuctions(list);
    }, (error) => {
      console.error("Error subscribing to pending auctions in AdminPanel:", error);
    });

    return () => unsubscribe();
  }, []);

  const showToast = (msg: string, type: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
    }, 3500);
  };

  // Both verdicts route through the context gate actions (approveListing /
  // rejectListing): they persist approvalStatus/rejectionReason AND write the
  // cross-user Firestore /notifications doc that reaches the SELLER's bell —
  // a local addNotification here would only ever reach the admin's own bell.
  // These two now resolve to the WRITE'S OUTCOME instead of `undefined`, so the
  // success toast is finally conditional — it used to fire even when the write
  // was rejected. On failure the context has ALREADY raised a detailed
  // notification, so nothing is shown here: one failure, one report.
  const handleApproveAuction = async (auctionId: string) => {
    try {
      const result = await approveListing(auctionId);
      if (!result?.success) return;
      showToast(isAr ? 'تم الموافقة على المزاد وهو الآن مباشر!' : 'Auction approved and now live!', 'success');
    } catch (error) {
      console.error("Error approving auction:", error);
      showToast(isAr ? 'حدث خطأ أثناء الموافقة' : 'Error approving auction', 'warning');
    }
  };

  const handleRejectAuction = async (auctionId: string, reason?: string) => {
    try {
      const result = await rejectListing(auctionId, reason);
      if (!result?.success) return;
      showToast(isAr ? 'تم رفض المزاد وإبلاغ البائع' : 'Auction rejected and seller notified', 'success');
      setRejectingId(null);
      setRejectionReason('');
    } catch (error) {
      console.error("Error rejecting auction:", error);
      showToast(isAr ? 'حدث خطأ أثناء رفض المزاد' : 'Error rejecting auction', 'warning');
    }
  };

  const handleApproveSubscription = (userId: string) => {
    const targetUser = users.find(u => u.id === userId);
    if (targetUser) {
      setUsers(prev => prev.map(u => {
        if (u.id === userId) {
          return { ...u, subscriptionStatus: 'active', paymentProofImage: undefined };
        }
        return u;
      }));
      addNotification(
        isAr ? '✅ تم تفعيل الاشتراك' : '✅ Subscription Approved',
        isAr ? `تم تفعيل اشتراك ${targetUser.name} بنجاح.` : `Activated subscription pass for ${targetUser.name} successfully.`,
        'win'
      );
      showToast(isAr ? 'تم تفعيل الاشتراك بنجاح' : 'Subscription approved successfully', 'success');
    }
  };

  const handleRejectSubscription = (userId: string) => {
    setUsers(prev => prev.map(u => {
      if (u.id === userId) {
        return { ...u, subscriptionStatus: 'none', paymentProofImage: undefined };
      }
      return u;
    }));
    addNotification(
      isAr ? '❌ تم رفض الاشتراك' : '❌ Subscription Rejected',
      isAr ? 'تم رفض إيصال الدفع وجار إشعار المستخدم.' : 'Subscription payment proof was rejected.',
      'error'
    );
    showToast(isAr ? 'تم رفض الاشتراك' : 'Subscription rejected', 'warning');
  };

  // isAdminUser accepts EITHER role === 'admin' or isAdmin === true. The bare
  // role check this replaced hid the panel from an administrator holding
  // isAdmin:true without role:'admin' — which is the shape a console grant
  // produces, and would have made the role migration look broken.
  if (!currentUser || !isAdminUser(currentUser)) {
    return null;
  }

  return (
    <div className="bg-surface-raised border border-line rounded-2xl p-5 flex flex-col shadow-md transition-all overflow-hidden font-sans relative" dir="rtl" id="admin-sidebar-curation-panel">
      
      {/* Toast Alert overlay */}
      {toastMessage && (
        <div className="absolute top-3 left-3 right-3 bg-zinc-900 text-white text-xs font-bold py-2.5 px-3 rounded-xl flex items-center gap-2 shadow-lg z-50 animate-bounce border border-zinc-700">
          <AlertCircle className="w-4 h-4 text-[#FF6B00] shrink-0" />
          <span className="flex-1">{toastMessage}</span>
        </div>
      )}

      {/* Modern Dashboard Curation Header */}
      <div className="flex gap-1.5 p-1 bg-surface-sunken rounded-xl mb-4 text-xs font-bold">
        <button
          onClick={() => setActiveTab('auctions')}
          className={`flex-1 py-2 px-2.5 rounded-lg flex items-center justify-center gap-1.5 transition-all ${activeTab === 'auctions' ? 'bg-surface-raised text-fg shadow-sm' : 'text-zinc-500 hover:text-fg'}`}
        >
          <Film className="w-3.5 h-3.5 text-[#FF6B00]" />
          <span>{isAr ? 'المعروضات المعلقة' : 'Pending Reels'}</span>
          {pendingAuctions.length > 0 && (
            <span className="bg-red-500 text-white text-[9px] px-1.5 py-0.5 rounded-full font-mono font-bold">
              {pendingAuctions.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('subscriptions')}
          className={`flex-1 py-2 px-2.5 rounded-lg flex items-center justify-center gap-1.5 transition-all ${activeTab === 'subscriptions' ? 'bg-surface-raised text-fg shadow-sm' : 'text-zinc-500 hover:text-fg'}`}
        >
          <User className="w-3.5 h-3.5 text-[#FF6B00]" />
          <span>{isAr ? 'الاشتراكات' : 'Subscriptions'}</span>
          {pendingRequests.length > 0 && (
            <span className="bg-[#FF6B00] text-white text-[9px] px-1.5 py-0.5 rounded-full font-mono font-bold">
              {pendingRequests.length}
            </span>
          )}
        </button>
      </div>

      <div className="space-y-4 overflow-y-auto max-h-[420px] scrollbar-none flex-1 font-sans">
        
        {/* Pending Reels/Video Auctions section */}
        {activeTab === 'auctions' && (
          pendingAuctions.length === 0 ? (
            <div className="text-xs text-zinc-500 text-center py-10">
              {isAr ? 'لا توجد مزادات معلقة للمراجعة حالياً.' : 'No pending video auctions at this moment.'}
            </div>
          ) : (
            pendingAuctions.map((item) => (
              <div key={item.id} className="p-3 bg-surface-sunken rounded-2xl border border-line space-y-3 shadow-xs">
                <div className="flex justify-between items-start">
                  <div className="min-w-0 flex-1">
                    <span className="bg-accent-weak text-[#FF6B00] text-[8px] font-black font-mono px-1.5 py-0.5 rounded uppercase">
                      {item.category || (isAr ? 'عام' : 'GENERAL')}
                    </span>
                    <h4 className="font-extrabold text-[12px] text-fg truncate mt-1">{item.title}</h4>
                    <p className="text-[10px] text-zinc-400 mt-0.5 font-mono">
                      {isAr ? 'بواسطة: ' : 'Seller: '} <span className="font-sans font-bold text-fg">{item.sellerName || item.createdByName || 'N/A'}</span>
                    </p>
                  </div>
                  <span className="text-[9px] font-black text-rose-500 bg-rose-50 px-2 py-0.5 rounded border border-rose-100 uppercase tracking-widest font-mono">
                    {item.startingPrice || 0} JOD
                  </span>
                </div>

                {/* Real-time Video Stream Player Preview */}
                {item.videoUrl && (
                  <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-black border border-line">
                    <video
                      src={item.videoUrl}
                      controls
                      playsInline
                      className="w-full h-full object-cover"
                      preload="metadata"
                    />
                  </div>
                )}

                {rejectingId === item.id ? (
                  <div className="space-y-1.5 pt-1">
                    <textarea
                      placeholder={isAr ? 'اكتب سبب الرفض ليصل للبائع...' : 'Enter a rejection reason for the seller...'}
                      value={rejectionReason}
                      onChange={(e) => setRejectionReason(e.target.value)}
                      className="w-full text-[11px] p-2 border border-rose-200 rounded-xl bg-rose-50/20 focus:outline-none focus:ring-1 focus:ring-rose-400"
                      rows={2}
                      maxLength={300}
                      autoFocus
                    />
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => handleRejectAuction(item.id, rejectionReason.trim() || undefined)}
                        className="flex-1 bg-rose-600 hover:bg-rose-700 text-white font-black text-[10.5px] py-1.5 rounded-xl transition-all shadow-sm cursor-pointer"
                      >
                        {isAr ? 'تأكيد الرفض وإبلاغ البائع' : 'CONFIRM REJECT & NOTIFY SELLER'}
                      </button>
                      <button
                        onClick={() => {
                          setRejectingId(null);
                          setRejectionReason('');
                        }}
                        className="bg-surface-sunken hover:bg-surface-sunken text-fg font-bold text-[10.5px] px-3 py-1.5 rounded-xl transition-all border border-line cursor-pointer"
                      >
                        {isAr ? 'إلغاء' : 'Cancel'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-1.5 pt-1">
                    <button
                      onClick={() => handleApproveAuction(item.id)}
                      className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-[10.5px] py-1.5 rounded-xl transition-all shadow-sm flex items-center justify-center gap-1 cursor-pointer"
                    >
                      <Check className="w-3.5 h-3.5" />
                      {isAr ? 'موافقة وإطلاق' : 'APPROVE'}
                    </button>
                    <button
                      onClick={() => {
                        setRejectingId(item.id);
                        setRejectionReason('');
                      }}
                      className="flex-1 bg-surface-sunken hover:bg-surface-sunken text-fg font-bold text-[10.5px] py-1.5 rounded-xl transition-all border border-line flex items-center justify-center gap-1 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                      {isAr ? 'رفض' : 'REJECT'}
                    </button>
                  </div>
                )}
              </div>
            ))
          )
        )}

        {/* User Subscriptions section */}
        {activeTab === 'subscriptions' && (
          pendingRequests.length === 0 ? (
            <div className="text-xs text-zinc-500 text-center py-10">
              {isAr 
                ? 'لا توجد طلبات اشتراك معلقة حالياً.' 
                : 'No pending subscriptions at the moment.'}
            </div>
          ) : (
            pendingRequests.map((u) => (
              <div key={u.id} className="p-3 bg-surface-sunken rounded-2xl border border-line space-y-3 shadow-xs">
                <div className="flex justify-between items-center text-[11px] font-bold text-fg">
                  <span>{u.name}</span>
                  <span className="text-[#FF6B00] text-[9px] font-black uppercase">
                    {isAr ? 'إيصال معلق' : 'Reviewing'}
                  </span>
                </div>

                <div className="bg-surface-raised border border-line p-2.5 rounded-xl text-[11px] space-y-1">
                  <div>
                    <span className="font-extrabold text-zinc-500">{isAr ? 'اسم المحول: ' : 'Transfer Name: '}</span>
                    <span className="font-bold text-fg">{u.transferFullName || 'N/A'}</span>
                  </div>
                  <div>
                    <span className="font-extrabold text-zinc-500">{isAr ? 'هاتف المحول: ' : 'Transfer Phone: '}</span>
                    <span className="font-mono font-bold text-fg">{u.transferPhone || 'N/A'}</span>
                  </div>
                </div>
                
                <div className="w-full rounded-xl overflow-hidden border border-line bg-surface-raised">
                  <img 
                    src={u.paymentProofImage} 
                    alt={isAr ? 'إيصال الدفع' : 'Payment Proof'} 
                    className="w-full h-auto object-contain max-h-56" 
                    referrerPolicy="no-referrer"
                  />
                </div>
                
                <div className="flex gap-1.5 pt-1">
                  <button
                    onClick={() => handleApproveSubscription(u.id)}
                    className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10.5px] py-1.5 rounded-xl transition-all cursor-pointer"
                  >
                    {isAr ? 'قبول واعتماد' : 'Approve'}
                  </button>
                  <button
                    onClick={() => handleRejectSubscription(u.id)}
                    className="flex-1 bg-red-50 hover:bg-red-100 border border-red-200 text-red-700 font-bold text-[10.5px] py-1.5 rounded-xl transition-all cursor-pointer"
                  >
                    {isAr ? 'رفض' : 'Reject'}
                  </button>
                </div>
              </div>
            ))
          )
        )}
      </div>

      {/* Reset All Auctions Engine Section */}
      <div className="mt-4 pt-4 border-t border-line">
        <button
          onClick={handleResetAllAuctions}
          disabled={isResetting}
          className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-black text-xs py-2.5 rounded-xl transition-all shadow-sm flex items-center justify-center gap-1.5 cursor-pointer active:scale-95"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>{isAr ? 'إعادة تعيين كافة المزادات' : 'RESET ALL AUCTIONS'}</span>
        </button>
      </div>
    </div>
  );
};

export default AdminPanel;
