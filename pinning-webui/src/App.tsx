import { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LanguageProvider } from './context/LanguageContext';
import Login from './pages/Login';
import ModeBSignup from './pages/ModeBSignup';
import ModeCSignup from './pages/ModeCSignup';
import Dashboard from './pages/Dashboard';
import ApiKeys from './pages/ApiKeys';
import Pins from './pages/Pins';
import Profile from './pages/Profile';
import Billing from './pages/Billing';
import Referrals from './pages/Referrals';
import Admin from './pages/Admin';
import AdminUsers from './pages/AdminUsers';
import AdminReferrals from './pages/AdminReferrals';
import AdminCidPolicies from './pages/AdminCidPolicies';
import AdminFula from './pages/AdminFula';
import GetKey from './pages/GetKey';
import View from './pages/View';
import Collab from './pages/Collab';
import GetFxFiles from './pages/GetFxFiles';
import Stats from './pages/Stats';
import Layout from './components/Layout';

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    if (user) {
      fetch('/api/admin/check', { credentials: 'include' })
        .then(res => setIsAdmin(res.ok))
        .catch(() => setIsAdmin(false));
    }
  }, [user]);

  if (loading || isAdmin === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

function App() {
  return (
    <LanguageProvider>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/login/mode-b" element={<ModeBSignup />} />
          <Route path="/login/mode-c" element={<ModeCSignup />} />
          <Route path="/get-key" element={<GetKey />} />
          <Route path="/view/:shareId" element={<View />} />
          <Route path="/collab/:groupId" element={<Collab />} />
          <Route path="/download" element={<GetFxFiles />} />
          <Route path="/stats" element={<Stats />} />
          <Route path="/" element={
            <PrivateRoute>
              <Layout />
            </PrivateRoute>
          }>
            <Route index element={<Dashboard />} />
            <Route path="keys" element={<ApiKeys />} />
            <Route path="pins" element={<Pins />} />
            <Route path="billing" element={<Billing />} />
            <Route path="referrals" element={<Referrals />} />
            <Route path="profile" element={<Profile />} />
            {/* Admin Routes */}
            <Route path="admin" element={<AdminRoute><Admin /></AdminRoute>}>
              <Route index element={<Navigate to="/admin/users" replace />} />
              <Route path="users" element={<AdminUsers />} />
              <Route path="referrals" element={<AdminReferrals />} />
              <Route path="cid-policies" element={<AdminCidPolicies />} />
              <Route path="fula" element={<AdminFula />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </LanguageProvider>
  );
}

export default App;
