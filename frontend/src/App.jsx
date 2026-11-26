import React, { useState, useEffect, useCallback } from 'react';
import { API } from './services/api.js';
import LoginView from './components/LoginView.jsx';
import Sidebar from './components/Sidebar.jsx';
import DashboardView from './components/DashboardView.jsx';
import PdfParserView from './components/PdfParserView.jsx';
import CustomersView from './components/CustomersView.jsx';
import CustomerModal from './components/CustomerModal.jsx';
import ApiKeysView from './components/ApiKeysView.jsx';
import StaffView from './components/StaffView.jsx';
import NidCardMakerView from './components/NidCardMakerView.jsx';

const ACTIVE_VIEW_KEY = 'govfill_active_view';
const USER_CACHE_KEY = 'govfill_user_cache';

const PDF_PARSER_VIEWS = {
  'view-parse': {
    jobCategory: 'All Job Pdf',
    pageTitle: 'All Job Pdf',
    pageSubtitle: 'Upload any Bangladeshi Govt job application PDF (Teletalk, BEPZA, DWA, Railway) — works 100% automatically without AI.',
    dropHint: 'Supports Teletalk Applicant Copies, BEPZA, DWA, Railway, etc.'
  },
  'view-army-job': {
    jobCategory: 'Army Job',
    pageTitle: 'Army Job PDF Parser & OCR',
    pageSubtitle: 'Upload Bangladesh Army job application PDF — extracts 100% personal, address, education, photo & signature automatically without AI.',
    dropHint: 'Supports Bangladesh Army (Join Bangladesh Army) PDFs & Teletalk forms.'
  },
  'view-navy-job': {
    jobCategory: 'Navy Job',
    pageTitle: 'Navy Job PDF Parser & OCR',
    pageSubtitle: 'Upload Bangladesh Navy job application PDF — extracts 100% personal, address, education, photo & signature automatically without AI.',
    dropHint: 'Supports Bangladesh Navy (Join Navy) PDFs & Teletalk forms.'
  },
  'view-air-force-job': {
    jobCategory: 'Air Force Job',
    pageTitle: 'Air Force Job PDF Parser & OCR',
    pageSubtitle: 'Upload Bangladesh Air Force job application PDF — extracts 100% personal, address, education, photo & signature automatically without AI.',
    dropHint: 'Supports Bangladesh Air Force (Join Bangladesh Air Force) PDFs & Teletalk forms.'
  }
};

const VALID_VIEWS = ['view-dashboard', ...Object.keys(PDF_PARSER_VIEWS), 'view-nid-maker', 'view-customers', 'view-keys', 'view-staff'];

function readCachedUser() {
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function App() {
  const initialCachedUser = API.isAuthenticated() ? readCachedUser() : null;
  const [booting, setBooting] = useState(Boolean(API.isAuthenticated() && !initialCachedUser));
  const [currentUser, setCurrentUser] = useState(initialCachedUser);
  const [activeView, setActiveView] = useState(() => {
    const hashView = window.location.hash.replace('#', '');
    const saved = localStorage.getItem(ACTIVE_VIEW_KEY);
    let target = hashView || saved || 'view-dashboard';
    if (!VALID_VIEWS.includes(target) || (target === 'view-staff' && initialCachedUser?.role !== 'admin')) {
      target = 'view-dashboard';
    }
    return target;
  });
  const [toastMsg, setToastMsg] = useState('');

  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [modalCustomerId, setModalCustomerId] = useState('');
  const [modalInitialCustomer, setModalInitialCustomer] = useState(null);
  const [modalIsNew, setModalIsNew] = useState(false);
  const [customersRefresh, setCustomersRefresh] = useState(0);

  const showToast = useCallback((msg) => {
    setToastMsg(msg);
  }, []);

  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(''), 3500);
    return () => clearTimeout(t);
  }, [toastMsg]);

  const resolveInitialView = (user) => {
    const hashView = window.location.hash.replace('#', '');
    const saved = localStorage.getItem(ACTIVE_VIEW_KEY);
    let target = hashView || saved || 'view-dashboard';
    if (!VALID_VIEWS.includes(target) || (target === 'view-staff' && user?.role !== 'admin')) {
      target = 'view-dashboard';
    }
    return target;
  };

  useEffect(() => {
    (async () => {
      if (API.isAuthenticated()) {
        try {
          const res = await API.getMe();
          setCurrentUser(res.user);
          localStorage.setItem(USER_CACHE_KEY, JSON.stringify(res.user));
          setActiveView(resolveInitialView(res.user));
        } catch {
          API.clearToken();
          localStorage.removeItem(USER_CACHE_KEY);
          setCurrentUser(null);
        }
      }
      setBooting(false);
    })();
  }, []);

  const switchView = useCallback((viewId) => {
    if (!VALID_VIEWS.includes(viewId)) return;
    setActiveView(viewId);
    localStorage.setItem(ACTIVE_VIEW_KEY, viewId);
    if (window.location.hash !== `#${viewId}`) {
      window.history.replaceState(null, '', `#${viewId}`);
    }
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const hashView = window.location.hash.replace('#', '');
      if (VALID_VIEWS.includes(hashView) && currentUser) {
        if (hashView === 'view-staff' && currentUser.role !== 'admin') return;
        setActiveView(hashView);
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [currentUser]);

  const handleLoginSuccess = (user) => {
    setCurrentUser(user);
    localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
    const v = resolveInitialView(user);
    switchView(v);
  };

  const handleLogout = () => {
    API.clearToken();
    localStorage.removeItem(ACTIVE_VIEW_KEY);
    localStorage.removeItem(USER_CACHE_KEY);
    sessionStorage.removeItem('govfill_dash_cache');
    sessionStorage.removeItem('govfill_customers_cache');
    window.location.hash = '';
    setCurrentUser(null);
  };

  const openCustomerModal = useCallback((id, initialCust = null) => {
    setModalIsNew(false);
    setModalCustomerId(id);
    setModalInitialCustomer(initialCust);
    setCustomerModalOpen(true);
  }, []);

  const openNewCustomerModal = useCallback(() => {
    setModalIsNew(true);
    setModalCustomerId('');
    setModalInitialCustomer(null);
    setCustomerModalOpen(true);
  }, []);

  const closeCustomerModal = useCallback(() => {
    setCustomerModalOpen(false);
  }, []);

  if (booting) {
    return (
      <div className="auth-wrapper">
        <div className="auth-card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="spinner"></div>
          <p style={{ marginTop: 10, color: 'var(--text-muted)' }}>Loading Toya Telecom &amp; Computer...</p>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return <LoginView onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <div id="app-view" className="app-layout" style={{ display: 'flex' }}>
      <Sidebar
        activeView={activeView}
        onSwitchView={switchView}
        currentUser={currentUser}
        onLogout={handleLogout}
      />

      <main className="main-body">
        {toastMsg && (
          <div id="toast-notify" className="toast" style={{ display: 'block' }}>
            {toastMsg}
          </div>
        )}

        {activeView === 'view-dashboard' && (
          <DashboardView
            onSwitchView={switchView}
            onOpenNewCustomer={openNewCustomerModal}
            onOpenCustomerModal={openCustomerModal}
            showToast={showToast}
          />
        )}

        {PDF_PARSER_VIEWS[activeView] && (
          <PdfParserView
            key={activeView}
            viewId={activeView}
            jobCategory={PDF_PARSER_VIEWS[activeView].jobCategory}
            pageTitle={PDF_PARSER_VIEWS[activeView].pageTitle}
            pageSubtitle={PDF_PARSER_VIEWS[activeView].pageSubtitle}
            dropHint={PDF_PARSER_VIEWS[activeView].dropHint}
            showToast={showToast}
            onSaved={() => switchView('view-customers')}
          />
        )}

        {activeView === 'view-nid-maker' && (
          <NidCardMakerView showToast={showToast} />
        )}

        {activeView === 'view-customers' && (
          <CustomersView
            currentUser={currentUser}
            refreshTrigger={customersRefresh}
            onOpenNewCustomer={openNewCustomerModal}
            onOpenCustomerModal={openCustomerModal}
            showToast={showToast}
          />
        )}

        {activeView === 'view-keys' && <ApiKeysView showToast={showToast} />}

        {activeView === 'view-staff' && currentUser?.role === 'admin' && (
          <StaffView
            currentUser={currentUser}
            onUpdateCurrentUser={setCurrentUser}
            showToast={showToast}
          />
        )}

        <footer style={{ marginTop: 32, paddingTop: 16, borderTop: '1px solid var(--border)', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
          Developed By <strong style={{ color: 'var(--primary)' }}>Sifat Hossain</strong>
        </footer>
      </main>

      <CustomerModal
        customerId={modalCustomerId}
        initialCustomer={modalInitialCustomer}
        isOpen={customerModalOpen}
        isNew={modalIsNew}
        onClose={closeCustomerModal}
        onSaved={() => {
          sessionStorage.removeItem('govfill_customers_cache');
          sessionStorage.removeItem('govfill_dash_cache');
          setCustomersRefresh((n) => n + 1);
        }}
        showToast={showToast}
      />
    </div>
  );
}
