import React from 'react';

export default function Sidebar({ activeView, onSwitchView, currentUser, onLogout }) {
  const navItems = [
    { id: 'view-dashboard', icon: 'fa-solid fa-gauge', label: 'Dashboard' },
    { id: 'view-parse', icon: 'fa-solid fa-file-pdf', label: 'All Job Pdf' },
    { id: 'view-army-job', icon: 'fa-solid fa-person-military-rifle', label: 'Army Job' },
    { id: 'view-navy-job', icon: 'fa-solid fa-anchor', label: 'Navy Job' },
    { id: 'view-air-force-job', icon: 'fa-solid fa-jet-fighter', label: 'Air Force Job' },
    { id: 'view-nid-maker', icon: 'fa-solid fa-id-card', label: 'NID Card Maker' },
    { id: 'view-customers', icon: 'fa-solid fa-users', label: 'Customer Profiles' },
    { id: 'view-keys', icon: 'fa-solid fa-key', label: 'Developer API Keys' }
  ];

  if (currentUser?.role === 'admin') {
    navItems.push({ id: 'view-staff', icon: 'fa-solid fa-user-shield', label: 'Staff Management' });
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <div className="brand-logo-wrap">
            <img src="/images/toya_logo.jpg" alt="Toya Logo" />
          </div>
          <div>
            <div className="brand-title">Toya Telecom &amp; Computer</div>
            <div className="brand-sub">Buy Sell &amp; Exchange</div>
          </div>
        </div>
      </div>

      <nav className="sidebar-menu">
        {navItems.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${activeView === item.id ? 'active' : ''}`}
            onClick={() => onSwitchView(item.id)}
          >
            <i className={item.icon}></i> <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="user-profile-widget">
          <div className="user-avatar">
            {(currentUser?.username || 'A').charAt(0).toUpperCase()}
          </div>
          <div className="user-meta">
            <span className="user-name">{currentUser?.fullName || currentUser?.username || 'Administrator'}</span>
            <span className={`role-badge role-${currentUser?.role || 'admin'}`}>
              {(currentUser?.role || 'admin').toUpperCase()}
            </span>
          </div>
        </div>
        <button className="btn-logout" title="Sign Out" onClick={onLogout}>
          <i className="fa-solid fa-arrow-right-from-bracket"></i>
        </button>
      </div>

      <div className="sidebar-credit">
        Developed By <strong>Sifat Hossain</strong>
      </div>
    </aside>
  );
}
