import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';

export default function GetFxFiles() {
  const { t } = useLanguage();
  const { user } = useAuth();

  // Track download click if user is logged in
  const trackDownloadClick = () => {
    if (user) {
      // Fire and forget - don't block the navigation
      fetch('/api/user/app-downloaded', {
        method: 'POST',
        credentials: 'include',
      }).catch(() => {
        // Silently ignore errors - tracking shouldn't block the user
      });
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 via-white to-primary-100 flex flex-col">
      {/* Main content - centered */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 sm:py-12">
        {/* App icon */}
        <div className="mb-6 sm:mb-8">
          <img
            src="/fxfiles-icon.png"
            alt="FxFiles"
            className="w-24 h-24 sm:w-32 sm:h-32 rounded-3xl shadow-xl"
          />
        </div>

        {/* Title and description */}
        <div className="text-center mb-8 sm:mb-10 max-w-md">
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3">
            {t.download?.title || 'Get FxFiles'}
          </h1>
          <p className="text-base sm:text-lg text-gray-600 leading-relaxed">
            {t.download?.subtitle || 'Secure, decentralized file storage powered by FULA network. Your files, your control.'}
          </p>
        </div>

        {/* Download buttons */}
        <div className="w-full max-w-sm space-y-4">
          {/* Google Play - Available */}
          <a
            href="https://play.google.com/store/apps/details?id=land.fx.files"
            target="_blank"
            rel="noopener noreferrer"
            onClick={trackDownloadClick}
            className="flex items-center justify-center gap-3 w-full bg-gray-900 hover:bg-gray-800 text-white rounded-xl px-6 py-4 transition-all transform hover:scale-[1.02] active:scale-[0.98] shadow-lg"
          >
            <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 0 1-.61-.92V2.734a1 1 0 0 1 .609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.198l2.807 1.626a1 1 0 0 1 0 1.73l-2.808 1.626L15.206 12l2.492-2.491zM5.864 2.658L16.8 8.99l-2.302 2.302-8.634-8.634z"/>
            </svg>
            <div className="text-left">
              <div className="text-xs opacity-80">{t.download?.getItOn || 'GET IT ON'}</div>
              <div className="text-lg font-semibold -mt-1">Google Play</div>
            </div>
          </a>

          {/* App Store - Coming Soon */}
          <div className="flex items-center justify-center gap-3 w-full bg-gray-200 text-gray-500 rounded-xl px-6 py-4 cursor-not-allowed">
            <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
            </svg>
            <div className="text-left">
              <div className="text-xs opacity-60">{t.download?.comingSoon || 'COMING SOON'}</div>
              <div className="text-lg font-semibold -mt-1">App Store</div>
            </div>
          </div>

          {/* Windows - Coming Soon */}
          <div className="flex items-center justify-center gap-3 w-full bg-gray-200 text-gray-500 rounded-xl px-6 py-4 cursor-not-allowed">
            <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 12V6.75l6-1.32v6.48L3 12zm17-9v8.75l-10 .15V5.21L20 3zM3 13l6 .09v6.81l-6-1.15V13zm17 .25V22l-10-1.91V13.1l10 .15z"/>
            </svg>
            <div className="text-left">
              <div className="text-xs opacity-60">{t.download?.comingSoon || 'COMING SOON'}</div>
              <div className="text-lg font-semibold -mt-1">Windows</div>
            </div>
          </div>
        </div>

        {/* Features */}
        <div className="mt-10 sm:mt-12 grid grid-cols-3 gap-4 sm:gap-8 max-w-md text-center">
          <div className="flex flex-col items-center">
            <div className="w-12 h-12 sm:w-14 sm:h-14 bg-primary-100 rounded-xl flex items-center justify-center mb-2">
              <svg className="w-6 h-6 sm:w-7 sm:h-7 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <span className="text-xs sm:text-sm font-medium text-gray-700">{t.download?.featureSecure || 'Secure'}</span>
          </div>
          <div className="flex flex-col items-center">
            <div className="w-12 h-12 sm:w-14 sm:h-14 bg-primary-100 rounded-xl flex items-center justify-center mb-2">
              <svg className="w-6 h-6 sm:w-7 sm:h-7 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <span className="text-xs sm:text-sm font-medium text-gray-700">{t.download?.featureDecentralized || 'Decentralized'}</span>
          </div>
          <div className="flex flex-col items-center">
            <div className="w-12 h-12 sm:w-14 sm:h-14 bg-primary-100 rounded-xl flex items-center justify-center mb-2">
              <svg className="w-6 h-6 sm:w-7 sm:h-7 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
            </div>
            <span className="text-xs sm:text-sm font-medium text-gray-700">{t.download?.featureShare || 'Easy Share'}</span>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="text-center py-6 px-4">
        <a
          href="/"
          className="text-primary-600 hover:text-primary-700 font-medium text-sm"
        >
          {t.download?.goToDashboard || 'Go to Dashboard'} →
        </a>
        <p className="text-xs text-gray-400 mt-3">
          {t.download?.poweredBy || 'Powered by FULA Network'}
        </p>
      </div>
    </div>
  );
}
