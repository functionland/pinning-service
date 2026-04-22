import { Outlet, NavLink } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';

export default function Admin() {
  const { t } = useLanguage();

  const adminNavigation = [
    { name: t.admin?.users || 'Users', href: '/admin/users' },
    { name: t.admin?.referrals || 'Referrals', href: '/admin/referrals' },
    { name: 'Blocked CIDs', href: '/admin/blocked-cids' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t.admin?.title || 'Admin Panel'}</h1>
        <p className="text-gray-600 mt-1">{t.admin?.subtitle || 'Manage users and system settings'}</p>
      </div>

      {/* Admin Sub-Navigation */}
      <div className="border-b border-gray-200">
        <nav className="flex space-x-8">
          {adminNavigation.map((item) => (
            <NavLink
              key={item.name}
              to={item.href}
              className={({ isActive }) =>
                `py-4 px-1 border-b-2 font-medium text-sm transition-colors ${
                  isActive
                    ? 'border-primary-500 text-primary-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`
              }
            >
              {item.name}
            </NavLink>
          ))}
        </nav>
      </div>

      {/* Content */}
      <Outlet />
    </div>
  );
}
