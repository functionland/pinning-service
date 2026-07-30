import { useState, useEffect } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { FxBulkDownloadProvider } from '../context/FxBulkDownloadContext';
import FxBulkDownloadProgressPanel from './FxBulkDownloadProgressPanel';
import LanguageSelector from './LanguageSelector';

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [isAdmin, setIsAdmin] = useState(false);

  // Check admin status
  useEffect(() => {
    if (user) {
      fetch('/api/admin/check', { credentials: 'include' })
        .then(res => setIsAdmin(res.ok))
        .catch(() => setIsAdmin(false));
    }
  }, [user]);

  const navigation = [
    { name: t.nav.dashboard, href: '/' },
    { name: t.nav.apiKeys, href: '/keys' },
    { name: t.nav.myPins, href: '/pins' },
    { name: t.nav.billing || 'Billing', href: '/billing' },
    { name: t.nav.referrals || 'Referrals', href: '/referrals' },
    { name: t.nav.profile, href: '/profile' },
  ];

  // Add admin link if user is admin
  const adminNav = isAdmin ? [{ name: t.nav.admin || 'Admin', href: '/admin' }] : [];

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <FxBulkDownloadProvider>
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            {/* Logo */}
            <div className="flex items-center space-x-3">
              <img 
                src="/logo.svg" 
                alt="FULA" 
                className="h-10 w-auto"
              />
              <span className="text-lg font-semibold text-gray-900">Pinning Service</span>
            </div>

            {/* Navigation */}
            <nav className="hidden md:flex space-x-1">
              {navigation.map((item) => (
                <NavLink
                  key={item.name}
                  to={item.href}
                  className={({ isActive }) =>
                    `px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-primary-50 text-primary-700'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                    }`
                  }
                >
                  {item.name}
                </NavLink>
              ))}
              {/* Admin navigation */}
              {adminNav.map((item) => (
                <NavLink
                  key={item.name}
                  to={item.href}
                  className={({ isActive }) =>
                    `px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-red-50 text-red-700'
                        : 'text-red-600 hover:bg-red-50 hover:text-red-700'
                    }`
                  }
                >
                  {item.name}
                </NavLink>
              ))}
            </nav>

            {/* User menu */}
            <div className="flex items-center space-x-4">
              <LanguageSelector />
              <div className="flex items-center space-x-3">
                {user?.picture && (
                  <img
                    src={user.picture}
                    alt={user.name}
                    className="h-8 w-8 rounded-full"
                  />
                )}
                <span className="hidden sm:block text-sm text-gray-700">{user?.email}</span>
              </div>
              <button
                onClick={handleLogout}
                className="text-sm text-gray-500 hover:text-gray-700 font-medium"
              >
                {t.nav.logout}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile navigation */}
        <div className="md:hidden border-t border-gray-100">
          <div className="px-2 py-2 space-x-1 flex overflow-x-auto">
            {navigation.map((item) => (
              <NavLink
                key={item.name}
                to={item.href}
                className={({ isActive }) =>
                  `px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap ${
                    isActive
                      ? 'bg-primary-50 text-primary-700'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`
                }
              >
                {item.name}
              </NavLink>
            ))}
            {/* Admin navigation for mobile */}
            {adminNav.map((item) => (
              <NavLink
                key={item.name}
                to={item.href}
                className={({ isActive }) =>
                  `px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap ${
                    isActive
                      ? 'bg-red-50 text-red-700'
                      : 'text-red-600 hover:bg-red-50'
                  }`
                }
              >
                {item.name}
              </NavLink>
            ))}
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Outlet />
      </main>

      {/* Global FxFiles bulk-download progress panel — visible across pages
          so navigating away from /pins or /profile doesn't lose the UI. */}
      <FxBulkDownloadProgressPanel />
    </div>
    </FxBulkDownloadProvider>
  );
}
