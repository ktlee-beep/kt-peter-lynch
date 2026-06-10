import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import BottomNav from './components/BottomNav';
import LoginPage from './pages/LoginPage';
import HomePage from './pages/HomePage';
import DiscoverPage from './pages/DiscoverPage';
import StockPage from './pages/StockPage';
import PortfolioPage from './pages/PortfolioPage';
import ToolsPage from './pages/ToolsPage';
import ReportPage from './pages/ReportPage';

function ProtectedLayout() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-dvh bg-surface-950 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="flex flex-col min-h-dvh bg-surface-950">
      <Routes>
        <Route path="/"          element={<HomePage />} />
        <Route path="/discover"  element={<DiscoverPage />} />
        <Route path="/stock"     element={<StockPage />} />
        <Route path="/portfolio" element={<PortfolioPage />} />
        <Route path="/decision"  element={<Navigate to="/tools" replace />} />
        <Route path="/report"    element={<ReportPage />} />
        <Route path="/tools"     element={<ToolsPage />} />
        <Route path="*"          element={<Navigate to="/" replace />} />
      </Routes>
      <BottomNav />
    </div>
  );
}

function AuthRoute() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) return <Navigate to="/" replace />;
  return <LoginPage />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<AuthRoute />} />
          <Route path="/*"     element={<ProtectedLayout />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
