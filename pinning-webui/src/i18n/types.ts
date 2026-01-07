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
    totalPins: string;
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
    searchPlaceholder: string;
    search: string;
    clear: string;
    copy: string;
    copied: string;
    close: string;
    noResults: string;
    actions: string;
    refresh: string;
    selected: string;
    unpin: string;
    unpinConfirm: string;
    downloadDecrypted: string;
    setupDecryption: string;
    decryptionInfo: string;
    decryptionInfoText: string;
    decryptionWarning: string;
    settingUp: string;
    enableDecryption: string;
    // Tabs
    tabMyPins: string;
    tabSharedWithMe: string;
    tabSharedByMe: string;
    tabPlaylists: string;
    // Shared with me
    sharedBy: string;
    sharedOn: string;
    expires: string;
    expiresOn: string;
    noExpiry: string;
    noSharedWithMe: string;
    noSharedWithMeDesc: string;
    permissions: string;
    viewContent: string;
    items: string;
    // Shared by me
    sharedWith: string;
    publicLink: string;
    passwordLink: string;
    passwordProtected: string;
    directShare: string;
    shareType: string;
    copyLink: string;
    revoked: string;
    revokeShare: string;
    noSharedByMe: string;
    noSharedByMeDesc: string;
    // Setup decryption
    setupDecryptionRequired: string;
    setupDecryptionDesc: string;
    setupDecryptionHint: string;
    // Playlists
    tracks: string;
    noPlaylists: string;
    noPlaylistsDesc: string;
    playlists: string;
    playPlaylist: string;
  };
  view: {
    loading: string;
    errorTitle: string;
    expiredAt: string;
    goHome: string;
    passwordRequired: string;
    passwordDesc: string;
    expiresIn: string;
    password: string;
    enterPassword: string;
    decrypting: string;
    unlock: string;
    download: string;
    documentPreview: string;
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
    billing?: string;
    referrals?: string;
    profile: string;
    admin?: string;
    logout: string;
  };
  billing?: {
    title: string;
    subtitle: string;
    storageUsage: string;
    balance: string;
    status: string;
    depositTitle: string;
    claimTitle: string;
    walletsTitle: string;
    historyTitle: string;
    chainsTitle: string;
  };
  common: {
    loading: string;
    error: string;
    user: string;
    today: string;
  };
  referrals?: {
    title: string;
    subtitle: string;
    yourCode: string;
    shareLink: string;
    copyCode: string;
    copyLink: string;
    copied: string;
    stats: string;
    totalReferred: string;
    totalCredits: string;
    referredUsers: string;
    email: string;
    joinedAt: string;
    creditsPurchased: string;
    noReferrals: string;
    noReferralsDesc: string;
  };
  admin?: {
    title: string;
    subtitle: string;
    users: string;
    referrals: string;
    suspendedUsers: string;
    email: string;
    balance: string;
    storage: string;
    suspendedAt: string;
    actions: string;
    unsuspend: string;
    noSuspendedUsers: string;
    creditAdjustment: string;
    userEmail: string;
    amount: string;
    amountHint: string;
    reason: string;
    adjustCredits: string;
  };
  adminReferrals?: {
    referrers: string;
    includeZero: string;
    exportCsv: string;
    referrer: string;
    code: string;
    totalReferred: string;
    totalCredits: string;
    viewDetails: string;
    hideDetails: string;
    referredBy: string;
    email: string;
    joinedAt: string;
    referredAt: string;
    credits: string;
    noReferrers: string;
    tryIncludeZero: string;
    noReferred: string;
    actions: string;
  };
}
