export type Language = 'en' | 'zh' | 'fa' | 'ar' | 'de' | 'es' | 'hi' | 'fr';

export interface LanguageInfo {
  code: Language;
  name: string;
  nativeName: string;
  dir: 'ltr' | 'rtl';
}

export const languages: LanguageInfo[] = [
  { code: 'en', name: 'English', nativeName: 'English', dir: 'ltr' },
  { code: 'zh', name: 'Chinese', nativeName: '中文', dir: 'ltr' },
  { code: 'fa', name: 'Farsi', nativeName: 'فارسی', dir: 'rtl' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', dir: 'rtl' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', dir: 'ltr' },
  { code: 'es', name: 'Spanish', nativeName: 'Español', dir: 'ltr' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', dir: 'ltr' },
  { code: 'fr', name: 'French', nativeName: 'Français', dir: 'ltr' },
];

export interface Translations {
  login: {
    title: string;
    subtitle: string;
    signIn: string;
    terms: string;
    totalStored: string;
    apiKeys: string;
    apiKeysDesc: string;
    pinCids: string;
    pinCidsDesc: string;
    analytics: string;
    analyticsDesc: string;
  };
  dashboard: {
    title: string;
    welcomeBack: string;
    welcomeTitle: string;
    welcomeDesc: string;
    totalPins: string;
    storageUsed: string;
    lastLogin: string;
    memberSince: string;
    quickActions: string;
    viewPins: string;
    viewPinsDesc: string;
    apiKeys: string;
    apiKeysDesc: string;
    profile: string;
    profileDesc: string;
    apiDocsTitle: string;
    apiDocsDesc: string;
  };
  apiKeys: {
    title: string;
    subtitle: string;
    createNew: string;
    creating: string;
    securityTitle: string;
    securityDesc: string;
    apiKey: string;
    created: string;
    lastUsed: string;
    actions: string;
    never: string;
    noKeys: string;
    noKeysDesc: string;
    delete: string;
    deleteConfirm: string;
    yes: string;
    no: string;
    usageTitle: string;
    usageDesc: string;
  };
  pins: {
    title: string;
    totalPins: string;
    addPin: string;
    addTitle: string;
    cidLabel: string;
    cidPlaceholder: string;
    cidHelp: string;
    nameLabel: string;
    namePlaceholder: string;
    cancel: string;
    add: string;
    adding: string;
    noPins: string;
    noPinsDesc: string;
    addFirst: string;
    cid: string;
    name: string;
    createdAt: string;
    status: string;
    requestId: string;
    page: string;
    of: string;
    previous: string;
    next: string;
  };
  profile: {
    title: string;
    subtitle: string;
    accountInfo: string;
    email: string;
    userId: string;
    auth: string;
    googleOAuth: string;
    signedWith: string;
    dangerTitle: string;
    dangerDesc: string;
    deleteAccount: string;
    deleteTitle: string;
    deleteWarning: string;
    deletePins: string;
    deleteKeys: string;
    deleteData: string;
    confirmLabel: string;
    deleting: string;
  };
  nav: {
    dashboard: string;
    apiKeys: string;
    myPins: string;
    profile: string;
    logout: string;
  };
  common: {
    loading: string;
    error: string;
    user: string;
    today: string;
  };
}
