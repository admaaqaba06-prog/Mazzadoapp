export interface TranslationType {
  dir: "rtl" | "ltr";
  langCode: "ar" | "en";
  nav: {
    logo: string;
    whyUs: string;
    liveExp: string;
    categories: string;
    comingSoon: string;
    pricing: string;
    reserveBtn: string;
    langBtn: string;
  };
  /** Launch announcement under the hero — see components/IPhoneAuctionSection.tsx. */
  iphoneAuction: {
    badge: string;
    /** Split so "17" can carry the accent colour without markup in a string. */
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
  };
  hero: {
    badge: string;
    titleFirst: string;
    titleGradient: string;
    titleLast: string;
    desc: string;
    ctaPrimary: string;
    ctaSecondary: string;
    sellerNote: string;
    proof: Array<{ value: string; label: string }>;
    liveBadge: string;
    verifiedSeller: string;
    carTitle: string;
    carDetails: string;
    currentPrice: string;
    bidBtn: string;
    features: string[];
    seconds: string;
    minutes: string;
  };
  trust: {
    badge: string;
    title: string;
    subtitle: string;
    cards: Array<{
      icon: string;
      title: string;
      desc: string;
    }>;
  };
  why: {
    title: string;
    subtitle: string;
    traditionalTitle: string;
    traditionalPoints: string[];
    smartTitle: string;
    smartPoints: string[];
  };
  interactive: {
    title: string;
    subtitle: string;
    stats: Array<{ value: string; label: string }>;
    simulationTitle: string;
    competitionLevel: string;
    participantsLabel: string;
    bidButton: string;
    secureBadge: string;
    competitorsBadge: string;
    autoExtendBadge: string;
    bidLogYou: string;
    bidsTitle: string;
  };
  categories: {
    title: string;
    subtitle: string;
    list: Array<{
      icon: string;
      title: string;
      desc: string;
    }>;
  };
  howItWorks: {
    title: string;
    subtitle: string;
    steps: Array<{
      title: string;
      desc: string;
    }>;
  };
  comingSoon: {
    title: string;
    subtitle: string;
    days: string;
    hours: string;
    minutes: string;
    seconds: string;
    formTitle: string;
    formName: string;
    formContact: string;
    formSubmit: string;
    formSuccess: string;
    formErrorEmailPhone: string;
    formErrorEmpty: string;
    experimentalNote: string;
    registeredTitle: string;
    emptyRegistered: string;
  };
  faq: {
    title: string;
    subtitle: string;
    items: Array<{
      q: string;
      a: string;
    }>;
  };
  footer: {
    desc: string;
    links: {
      whyUs: string;
      categories: string;
      contact: string;
    };
    rights: string;
  };
  marketplace: {
    badge: string; title: string; subtitle: string; currentBid: string; bids: string;
    verified: string; endingSoon: string; beTheFirst: string; viewBtn: string; emptyTitle: string; emptyDesc: string;
    unavailableTitle: string; unavailableDesc: string;
    sellerCtaText: string; sellerCtaBtn: string;
    /* `categoryLabels` was here — a second copy of the category taxonomy,
       maintained by hand and drifted from `utils/categories.ts`. Category
       labels now come from `categoryLabel()` at the call site, so there is one
       list to keep correct instead of two. Do not add it back. */
  };
}

export const translations: Record<"ar" | "en", TranslationType> = {
  ar: {
    dir: "rtl",
    langCode: "ar",
    nav: {
      logo: "🔨 Mazzado",
      whyUs: "لماذا مزادو؟",
      liveExp: "تجربة مباشرة",
      categories: "الفئات",
      comingSoon: "ابدأ الآن",
      pricing: "اشتراكات",
      reserveBtn: "تواصل معنا",
      langBtn: "English",
    },
    iphoneAuction: {
      badge: "مزاد مميز",
      titleBefore: "آيفون ",
      titleAccent: "17",
      titleAfter: " برو ماكس",
      subtitle: "آيفون 17 برو ماكس — مزاد علني. السعر يحدده السوق.",
      openingPrice: "سعر الافتتاح يحدده البائع",
      units: { days: "أيام", hours: "ساعات", minutes: "دقائق", seconds: "ثواني" },
      ctaRegister: "سجّل للمزايدة",
      ctaDetails: "عرض التفاصيل",
      liveTitle: "المزاد بدأ الآن",
      ctaLive: "زايد الآن",
      // Name and tagline stay English in BOTH languages: it is how the device
      // is branded and how buyers actually search for it.
      productName: "iPhone 17 Pro Max",
      productTagline: "Bigger thinking. Bolder moves.",
    },
    hero: {
      badge: "منصة مزادات ذكية للسوق الأردني 🇯🇴",
      titleFirst: "السعر يحدده السوق.",
      titleGradient: "بِع أسرع.",
      // Two lines now, not three. The third span is guarded in LandingView so an
      // empty string does not leave a flex gap where a line used to be.
      titleLast: "",
      desc: "فلوسك محجوزة عند مزادو — ما توصل البائع إلا بعد ما تستلم وتتأكد.",
      ctaPrimary: "تصفّح المزادات المباشرة",
      ctaSecondary: "اعرض سلعتك للبيع",
      sellerNote: "نزّل سلعتك وابدأ مزادك خلال دقائق",
      proof: [
        { value: "استلام أو توصيل مدفوع", label: "داخل عمّان ومحيطها" },
        { value: "بدون فصال", label: "السوق بيحدد السعر" },
        { value: "تمديد تلقائي", label: "إذا زايدت بآخر الثواني" },
      ],
      liveBadge: "مباشر الآن",
      verifiedSeller: "✓ بائع موثق",
      carTitle: "تويوتا كامري 2022",
      carDetails: "مثال توضيحي · عمّان · مزاد مميز",
      currentPrice: "السعر الحالي",
      bidBtn: "زايد الآن (+250 د.أ)",
      features: ["🔒 دفع محجوز", "مزايدة علنية", "⏱ تمديد تلقائي للوقت"],
      seconds: "ثانية",
      minutes: "دقيقة",
    },
    trust: {
      badge: "الأمان والثقة",
      title: "مزادات حقيقية. تجربة آمنة وواضحة.",
      subtitle: "في مزادو، كل بائع موثّق، وكل منتج واضح، وكل مزايدة تتم بشفافية كاملة.",
      cards: [
        {
          icon: "🛡️",
          title: "كل إعلان مُراجَع",
          desc: "كل إعلان يمر بمراجعة فريقنا قبل النشر.",
        },
        {
          icon: "🔍",
          title: "تفاصيل واضحة",
          desc: "صور ومعلومات دقيقة تساعدك تعرف المنتج قبل ما تزايد.",
        },
        {
          icon: "⚡",
          title: "مزايدة لحظية",
          desc: "تابع السعر مباشرة وقدّم مزايدتك بسهولة وبدون تأخير.",
        },
        {
          icon: "⚖️",
          title: "فرصة عادلة للجميع",
          desc: "تمديد تلقائي في الثواني الأخيرة يمنح الجميع فرصة عادلة.",
        },
      ],
    },
    why: {
      title: "لماذا Mazzado؟",
      subtitle: "بدل ما تفاوض عشرات الناس… خليهم ينافسوا عليك.",
      traditionalTitle: "الطريقة التقليدية",
      traditionalPoints: [
        "مفاوضات متعبة وتكرار عبارة 'آخر سعر؟'",
        "هدر وقت مع مشترين غير جادين وهواة بخس السلع",
        "السعر يعكس توقع البائع الشخصي لا الطلب الفعلي",
        "وقت بيع غير واضح قد يمتد لأسابيع أو أشهر",
      ],
      smartTitle: "Mazzado - ذكي",
      smartPoints: [
        "منافسة منظمة وعادلة ترفع السعر تلقائياً لصالحك",
        "مزايدون موثوقون وعضوية مدفوعة تضمن جدية الجميع",
        "اكتشاف السعر الحقيقي للمنتج بدقة حسب حجم الطلب",
        "وقت بيع محدد بدقة مع إشعارات ذكية وشفافية مطلقة",
      ],
    },
    interactive: {
      title: "تجربة تفاعلية",
      subtitle: "جرّب المزاد الحي الآن.",
      stats: [
        { value: "علني", label: "كل مزايدة ظاهرة" },
        { value: "3", label: "خطوات للمزايدة" },
        { value: "7 أيام", label: "مزاد مقترح للسلعة" },
        { value: "24/7", label: "تنبيهات ومتابعة" },
      ],
      simulationTitle: "محاكاة تفاعلية مباشرة لغرفة المزاد",
      competitionLevel: "مستوى المنافسة الآن",
      participantsLabel: "المزايدون المؤهلون",
      bidButton: "زايد الآن (+250 د.أ)",
      secureBadge: "🔒 مزايدة آمنة ومحمية",
      competitorsBadge: "مزايدات مباشرة",
      autoExtendBadge: "⏱ تمديد تلقائي للوقت",
      bidLogYou: "أنت (مزايد جديد)",
      bidsTitle: "سجل المزايدة اللحظي",
    },
    categories: {
      title: "الفئات",
      subtitle: "منتجات عالية القيمة تستحق مزاداً منظماً.",
      list: [
        {
          icon: "🚗",
          title: "سيارات",
          desc: "سيارات بتفاصيل واضحة وإجراءات نقل ملكية آمنة.",
        },
        {
          icon: "🏠",
          title: "عقارات",
          desc: "شقق سكنية، أراضي استثمارية، ومحلات تجارية منظمة قانونياً.",
        },
        {
          icon: "💻",
          title: "إلكترونيات",
          desc: "موبايلات مميزة، لابتوبات احترافية، وأجهزة ذكية.",
        },
        {
          icon: "🏗️",
          title: "معدات وآلات",
          desc: "معدات صناعية، زراعية، وآلات تشغيلية للمشاريع.",
        },
        {
          icon: "⌚",
          title: "مقتنيات فاخرة",
          desc: "ساعات ثمينة، مجوهرات، تحف ونوادر لهواة التميز.",
        },
        {
          icon: "🔢",
          title: "أرقام مميزة",
          desc: "أرقام لوحات سيارات وأرقام هواتف موثقة قانونياً ومنظمة.",
        },
      ],
    },
    howItWorks: {
      title: "كيف يعمل؟",
      subtitle: "من الإدراج حتى الإغلاق — خطوات واضحة.",
      steps: [
        {
          title: "أنشئ مزادك",
          desc: "ارفع الصور الحقيقية، حدد السعر الأدنى الذي تقبله، وأدرج سلعتك في دقائق معدودة.",
        },
        {
          title: "نافس مباشرة",
          desc: "تابع المزايدين يتنافسون بجدية وشفافية في الوقت الفعلي مع نظام إشعارات ذكي وتمديد تلقائي للوقت.",
        },
        {
          title: "أغلق الصفقة",
          desc: "بمجرد انتهاء الوقت لصالح المزايد الأعلى، الدفع بيضل محجوز عند مزادو لحد ما تستلم وتتأكد، وبنرتب نقل الملكية.",
        },
      ],
    },
    comingSoon: {
      title: "الآن في الأردن",
      subtitle: "المزادات الحية انطلقت — جرّب المزاد الحي الآن.",
      days: "يوم",
      hours: "ساعة",
      minutes: "دقيقة",
      seconds: "ثانية",
      formTitle: "خلّيك على اطلاع — سجّل ليصلك جديد المزادات والقطع المميزة",
      formName: "الاسم الكامل (اختياري)",
      formContact: "البريد الإلكتروني أو رقم الهاتف الأردني (مثال: 079xxxxxxx)",
      formSubmit: "أبقني على اطلاع",
      formSuccess: "تم التسجيل بنجاح! سنرسل لك جديد المزادات والقطع المميزة 🎉",
      formErrorEmailPhone: "يرجى إدخال بريد إلكتروني صحيح أو رقم هاتف أردني صالح (مثل 079، 078، 077)",
      formErrorEmpty: "يرجى ملء حقل الاتصال (البريد أو الهاتف)",
      experimentalNote: "ملاحظة: هذا النموذج تجريبي لأغراض العرض والبيانات تخزن محلياً في متصفحك.",
      registeredTitle: "قائمة المنضمين الأوائل محلياً",
      emptyRegistered: "كن أول المنضمين في الأردن!",
    },
    faq: {
      title: "الأسئلة الشائعة",
      subtitle: "كل ما تود معرفته عن الاشتراك، المشاركة، العمولات، وحماية المشتري في Mazzado",
      items: [
        {
          q: "لماذا يوجد اشتراك للمزايدة؟",
          a: "الاشتراك خطوة صغيرة قبل المزايدة. مقابل دينار واحد شهرياً تحصل على مزايدة غير محدودة على قطع يراجعها فريقنا قبل النشر — وبيساعد على تقليل المزايدات الوهمية."
        },
        {
          q: "كيف أدفع؟",
          a: "الاشتراكات تُدفع عبر كليك. أما مدفوعات المزادات فيحتفظ بها مزادو ولا تُحوَّل للبائع إلا بعد استلامك للقطعة وتأكيدك. تُضاف عمولة مشترٍ 5٪ عند الفوز."
        },
        {
          q: "ماذا تعني \"حماية المشتري من مزادو\"؟",
          a: "نحتجز مبلغ الدفع حتى تستلم المنتج وتؤكد مطابقته للوصف، ثم نحوّله للبائع. ويمكنك عرض منتجك بنفسك أو يساعدك فريقنا في تجهيزه وعرضه."
        },
        {
          q: "ماذا يمكنني أن أبيع؟",
          a: "تقريباً أي شيء ذي قيمة — إلكترونيات، ساعات، مقتنيات، معدات وغيرها. أحضر منتجك وسيقيّمه فريقنا. ولا توجد رسوم عرض حالياً."
        },
        {
          q: "ماذا لو كانت القطعة مختلفة عن الوصف؟",
          a: "دفعتك تبقى محجوزة لدى مزادو ولا تُحوَّل للبائع إلا بعد ما تستلم القطعة وتتأكد إنها مطابقة. إذا صار أي إشكال، تواصل معنا وبنتوسّط لحلّه."
        },
        {
          q: "كم تكلفة البيع؟",
          a: "لا شيء مقدماً. البائع يستلم 95٪ — عمولة 5٪ فقط عند بيع منتجك. إذا لم يُبَع، لا تدفع شيئاً."
        }
      ]
    },
    footer: {
      desc: "منصة مزادات علنية في الأردن — السعر يحدده السوق، والرسوم معلنة.",
      links: {
        whyUs: "لماذا نحن؟",
        categories: "الفئات",
        contact: "تواصل معنا",
      },
      rights: "© 2026 Mazzado. صمم للسوق الأردني بكل فخر 🇯🇴",
    },
    marketplace: {
      badge: "مباشر الآن",
      title: "مزادات مباشرة على مزادو الآن",
      subtitle: "سلع معروضة تُباع الآن — هكذا ستظهر سلعتك أمام المشترين.",
      currentBid: "أعلى مزايدة",
      bids: "مزايدة",
      verified: "موثّقة",
      endingSoon: "ينتهي قريباً",
      beTheFirst: "كن أول مزايد",
      viewBtn: "شاهد المزاد",
      emptyTitle: "المزادات تنطلق يومياً",
      emptyDesc: "كن من أوائل البائعين — اعرض سلعتك الآن وتصدَّر الصفحة.",
      unavailableTitle: "المزادات المباشرة غير متاحة الآن",
      unavailableDesc: "يرجى تحديث الصفحة بعد قليل.",
      sellerCtaText: "جاهز لرؤية سلعتك هنا؟",
      sellerCtaBtn: "اعرض سلعتك للبيع",
    },
  },
  en: {
    dir: "ltr",
    langCode: "en",
    nav: {
      logo: "🔨 Mazzado",
      whyUs: "Why Mazzado?",
      liveExp: "Live Experience",
      categories: "Categories",
      comingSoon: "Start Now",
      pricing: "Subscriptions",
      reserveBtn: "Contact Us",
      langBtn: "العربية",
    },
    iphoneAuction: {
      badge: "Featured auction",
      titleBefore: "iPhone ",
      titleAccent: "17",
      titleAfter: " Pro Max",
      subtitle: "iPhone 17 Pro Max — a public auction. The market sets the price.",
      openingPrice: "Opening price set by the seller",
      units: { days: "Days", hours: "Hours", minutes: "Minutes", seconds: "Seconds" },
      ctaRegister: "Register to bid",
      ctaDetails: "View details",
      liveTitle: "Bidding is open",
      ctaLive: "Bid now",
      productName: "iPhone 17 Pro Max",
      productTagline: "Bigger thinking. Bolder moves.",
    },
    hero: {
      badge: "Smart Auction Platform for Jordan 🇯🇴",
      titleFirst: "The market sets the price.",
      titleGradient: "Sell faster.",
      titleLast: "",
      desc: "Your money is held by Mazzado — the seller is paid only after you receive and confirm.",
      ctaPrimary: "Browse live auctions",
      ctaSecondary: "List your item",
      sellerNote: "List your item and start your auction in minutes",
      proof: [
        { value: "Pickup or paid delivery", label: "Amman and nearby areas" },
        { value: "No haggling", label: "the market sets the price" },
        { value: "Auto-extend", label: "If you bid in the final seconds" },
      ],
      liveBadge: "Live Now",
      verifiedSeller: "✓ Verified Seller",
      carTitle: "Toyota Camry 2022",
      carDetails: "Illustrative example · Amman · Premium Auction",
      currentPrice: "Current Price",
      bidBtn: "Bid Now (+250 JOD)",
      features: ["🔒 Payment held", "Public bidding", "⏱ Auto-Extension"],
      seconds: "sec",
      minutes: "min",
    },
    trust: {
      badge: "Trust & Safety",
      title: "Real auctions. A safe and transparent experience.",
      subtitle: "At MAZZADO, every seller is verified, every product is clearly presented, and every bid is fully transparent.",
      cards: [
        {
          icon: "🛡️",
          title: "Every listing reviewed",
          desc: "Every listing is reviewed by our team before it goes live.",
        },
        {
          icon: "🔍",
          title: "Clear Details",
          desc: "Accurate photos and information help you understand the product before bidding.",
        },
        {
          icon: "⚡",
          title: "Live Bidding",
          desc: "Follow the price in real time and place your bid without delay.",
        },
        {
          icon: "⚖️",
          title: "A Fair Chance for Everyone",
          desc: "Automatic extensions in the final seconds give everyone a fair chance.",
        },
      ],
    },
    why: {
      title: "Why Mazzado?",
      subtitle: "Instead of negotiating with dozens... let them compete for you.",
      traditionalTitle: "The Traditional Way",
      traditionalPoints: [
        "Exhausting negotiations and constant 'what's your final price?'",
        "Wasted time with unserious buyers and low-ball offers",
        "Price is based on seller expectations, not real demand",
        "Unclear sales timeframe stretching to weeks or months",
      ],
      smartTitle: "Mazzado - Smart",
      smartPoints: [
        "Organized, fair competition driving prices up automatically",
        "Verified, members-only bidders to ensure serious participation",
        "Accurate price discovery based purely on actual demand",
        "Strictly set sale window, smart notifications, and full transparency",
      ],
    },
    interactive: {
      title: "Interactive Experience",
      subtitle: "The feel of a live auction — try it right now.",
      stats: [
        { value: "Public", label: "Every bid visible" },
        { value: "3", label: "Steps to Bid" },
        { value: "7 Days", label: "Suggested Listing" },
        { value: "24/7", label: "Alerts & Support" },
      ],
      simulationTitle: "Live Interactive Auction Room Simulator",
      competitionLevel: "Competition Level Now",
      participantsLabel: "Eligible Bidders",
      bidButton: "Bid Now (+250 JOD)",
      secureBadge: "🔒 Secure & Protected Bidding",
      competitorsBadge: "Live bidding",
      autoExtendBadge: "⏱ Auto-Time Extension",
      bidLogYou: "You (New Bidder)",
      bidsTitle: "Instant Bid History",
    },
    categories: {
      title: "Categories",
      subtitle: "High-value products that deserve an organized auction.",
      list: [
        {
          icon: "🚗",
          title: "Cars",
          desc: "Detailed vehicle listings with secure registration transfers.",
        },
        {
          icon: "🏠",
          title: "Real Estate",
          desc: "Apartments, investment lands, and commercial shops with legal verification.",
        },
        {
          icon: "💻",
          title: "Electronics",
          desc: "Premium phones, professional laptops, and smart devices with certified checks.",
        },
        {
          icon: "🏗️",
          title: "Equipment & Machinery",
          desc: "Industrial machinery, agricultural tools, and operational heavy equipment.",
        },
        {
          icon: "⌚",
          title: "Luxury Collectibles",
          desc: "Precious watches, fine jewelry, antiques, and rare goods for collectors.",
        },
        {
          icon: "🔢",
          title: "Special Numbers",
          desc: "Legally registered elite license plates and VIP telephone numbers.",
        },
      ],
    },
    howItWorks: {
      title: "How It Works",
      subtitle: "From listing to close — clear steps.",
      steps: [
        {
          title: "Create Your Auction",
          desc: "Upload real pictures, set your reserve price, and list in minutes.",
        },
        {
          title: "Compete Live",
          desc: "Watch buyers bid in real-time with full transparency, smart mobile notifications, and automated anti-sniping extensions.",
        },
        {
          title: "Close the Deal",
          desc: "Once the timer ends on the highest bid, we secure payment and guide both parties through seamless ownership transfer.",
        },
      ],
    },
    comingSoon: {
      title: "Now in Jordan",
      subtitle: "Live auctions are on — try the live auction now.",
      days: "Days",
      hours: "Hours",
      minutes: "Min",
      seconds: "Sec",
      formTitle: "Stay in the loop — get notified about new auctions and featured items",
      formName: "Full Name (Optional)",
      formContact: "Email or Jordanian Phone Number (e.g., 079xxxxxxx)",
      formSubmit: "Keep Me Posted",
      formSuccess: "Registered successfully! We'll keep you posted on new auctions 🎉",
      formErrorEmailPhone: "Please enter a valid email or active Jordanian phone number (079, 078, 077)",
      formErrorEmpty: "Please fill in the contact field (Email or Phone)",
      experimentalNote: "Note: This is a prototype form; data is saved locally in your browser's local storage.",
      registeredTitle: "Jordan's Early Adopters List",
      emptyRegistered: "Be the first to join from Jordan!",
    },
    faq: {
      title: "Frequently Asked Questions (FAQ)",
      subtitle: "Everything you need to know about subscriptions, bidding, commissions, and buyer protection on Mazzado",
      items: [
        {
          q: "Why is there a subscription for bidding?",
          a: "The subscription is a small commitment before bidding. For 1 JOD per month you get unlimited bidding on items reviewed by our team before they go live — and it helps reduce fake bidding."
        },
        {
          q: "How do I pay?",
          a: "Subscriptions are paid via CliQ. Auction payments are held by Mazad and are not transferred to the seller until you receive and approve the item. A 5% buyer's premium is added on winning bids."
        },
        {
          q: "What does \"buyer protection\" mean?",
          a: "Mazad holds your payment until you receive and approve the item, then releases it to the seller. You can list your item yourself, or our team can help prepare and list it for you."
        },
        {
          q: "What can I sell?",
          a: "Almost anything of value — electronics, watches, collectibles, equipment, and more. Bring your item and our team will evaluate it. There are currently no listing fees."
        },
        {
          q: "What if the item is different from the description?",
          a: "Your payment stays held by Mazad and is only released to the seller after you receive the item and confirm it matches. If anything goes wrong, contact us and we'll mediate."
        },
        {
          q: "How much does it cost to sell?",
          a: "Nothing upfront. Sellers keep 95% — just 5% commission when your item is successfully sold. If it doesn't sell, you pay absolutely nothing."
        }
      ]
    },
    footer: {
      desc: "A public auction platform in Jordan — the market sets the price, and the fees are published.",
      links: {
        whyUs: "Why Us",
        categories: "Categories",
        contact: "Contact Us",
      },
      rights: "© 2026 Mazzado. Proudly designed for the Jordanian market 🇯🇴",
    },
    marketplace: {
      badge: "Live now",
      title: "Live on Mazzado right now",
      subtitle: "Items selling now — this is where your item shows up for buyers.",
      currentBid: "Current bid",
      bids: "bids",
      verified: "Verified",
      endingSoon: "Ending soon",
      beTheFirst: "Be the first",
      viewBtn: "View auction",
      emptyTitle: "New auctions launch daily",
      emptyDesc: "Be one of the first sellers — list your item now and lead the page.",
      unavailableTitle: "Live auctions are momentarily unavailable",
      unavailableDesc: "Please refresh in a moment.",
      sellerCtaText: "Ready to see your item here?",
      sellerCtaBtn: "List your item",
    },
  },
};
