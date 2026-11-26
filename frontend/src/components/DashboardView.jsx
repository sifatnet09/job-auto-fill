import React, { useEffect, useState, useCallback } from 'react';
import { API } from '../services/api.js';

export default function DashboardView({ onSwitchView, onOpenNewCustomer, onOpenCustomerModal, showToast }) {
  const [stats, setStats] = useState(() => {
    try {
      const raw = sessionStorage.getItem('govfill_dash_cache');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const [clock, setClock] = useState('');
  const [trackerPage, setTrackerPage] = useState(1);
  const TRACKER_PAGE_SIZE = 10;

  const loadStats = useCallback(async () => {
    try {
      const res = await API.getDashboardStats();
      const s = res.stats || {};
      setStats(s);
      try {
        sessionStorage.setItem('govfill_dash_cache', JSON.stringify(s));
      } catch {
        // ignore storage quota errors
      }
    } catch (e) {
      console.error('Failed to load dashboard stats:', e);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  useEffect(() => {
    const updateClock = () => {
      setClock(
        new Date().toLocaleString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })
      );
    };
    updateClock();
    const timer = setInterval(updateClock, 15000);
    return () => clearInterval(timer);
  }, []);

  const serverUrl =
    window.location.protocol === 'file:' || !window.location.host
      ? 'http://localhost:5000'
      : `${window.location.protocol}//${window.location.host}`;

  const copyServerUrl = () => {
    navigator.clipboard?.writeText(serverUrl).then(
      () => showToast(`Copied Server URL: ${serverUrl}`),
      () => showToast(serverUrl)
    );
  };

  const s = stats || {};
  const totalCust = s.totalCustomers || 0;
  const photoReady = s.photoReadyCount || 0;
  const signReady = s.signatureReadyCount || 0;
  const photoPct = totalCust > 0 ? Math.round((photoReady / totalCust) * 100) : 0;
  const signPct = totalCust > 0 ? Math.round((signReady / totalCust) * 100) : 0;

  const usage = s.usage || {};
  const maxBytes = Number(usage.maxStorageBytes || 5 * 1024 * 1024 * 1024);
  const usedBytes = Number(usage.r2BytesUsed || 0);
  const usedMb = (usedBytes / (1024 * 1024)).toFixed(2);
  const maxGb = (maxBytes / (1024 * 1024 * 1024)).toFixed(0);
  const storagePct = Math.min(100, Math.round((usedBytes / maxBytes) * 1000) / 10);

  const maxOps = Number(usage.maxMonthlyOps || 500000);
  const usedOps = Number(usage.r2OpsCount || 0);
  const opsPct = Math.min(100, Math.round((usedOps / maxOps) * 1000) / 10);

  const recentApplies = s.recentApplies || [];
  const trackerTotalPages = Math.max(1, Math.ceil(recentApplies.length / TRACKER_PAGE_SIZE));
  const safeTrackerPage = Math.min(trackerPage, trackerTotalPages);
  const trackerStart = (safeTrackerPage - 1) * TRACKER_PAGE_SIZE;
  const pagedApplies = recentApplies.slice(trackerStart, trackerStart + TRACKER_PAGE_SIZE);
  const submittedCount = recentApplies.filter((a) => a.actionType === 'submitted').length;
  const autofillCount = recentApplies.length - submittedCount;
  const recentCustomers = s.recentCustomers || [];
  const hasKey = (s.activeKeys || 0) > 0;

  return (
    <section id="view-dashboard" className="content-view active">
      <div className="dash-hero">
        <div className="dash-hero-left">
          <div className="dash-hero-badges">
            <span className="live-pill"><span className="live-dot"></span> Extension Tracking Live</span>
            <span className="date-pill" id="dash-live-clock"><i className="fa-regular fa-clock"></i> {clock}</span>
          </div>
          <h1>Toya Telecom &amp; Computer</h1>
          <p>Online Job Apply Dashboard</p>
        </div>
        <div className="dash-hero-actions">
          <button className="btn btn-hero-primary" onClick={() => onSwitchView('view-parse')}>
            <i className="fa-solid fa-file-arrow-up"></i> Parse Application PDF
          </button>
          <button className="btn btn-hero-glass" onClick={() => { onSwitchView('view-customers'); onOpenNewCustomer(); }}>
            <i className="fa-solid fa-user-plus"></i> New Customer
          </button>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card card-teal">
          <div className="stat-card-body">
            <div className="stat-top-row">
              <span className="stat-label">Total Customers</span>
              <div className="stat-icon stat-blue"><i className="fa-solid fa-users"></i></div>
            </div>
            <div className="stat-value" id="stat-total-customers">{totalCust}</div>
            <div className="stat-meta"><i className="fa-solid fa-database"></i> Registered TTC profiles</div>
          </div>
        </div>

        <div className="stat-card card-green">
          <div className="stat-card-body">
            <div className="stat-top-row">
              <span className="stat-label">Today&apos;s Customers</span>
              <div className="stat-icon stat-green"><i className="fa-solid fa-user-plus"></i></div>
            </div>
            <div className="stat-value" id="stat-today-customers">{s.todayCustomers || 0}</div>
            <div className="stat-meta"><i className="fa-solid fa-calendar-day"></i> Added today</div>
          </div>
        </div>

        <div className="stat-card card-orange">
          <div className="stat-card-body">
            <div className="stat-top-row">
              <span className="stat-label">Total Apply</span>
              <div className="stat-icon stat-orange"><i className="fa-solid fa-paper-plane"></i></div>
            </div>
            <div className="stat-value" id="stat-total-applies">{s.totalApplies || 0}</div>
            <div className="stat-meta"><i className="fa-solid fa-puzzle-piece"></i> All-time extension applies</div>
          </div>
        </div>

        <div className="stat-card card-purple">
          <div className="stat-card-body">
            <div className="stat-top-row">
              <span className="stat-label">Today Apply</span>
              <div className="stat-icon stat-purple"><i className="fa-solid fa-calendar-check"></i></div>
            </div>
            <div className="stat-value" id="stat-today-applies">{s.todayApplies || 0}</div>
            <div className="stat-meta"><i className="fa-solid fa-bolt"></i> Auto-tracked today</div>
          </div>
        </div>
      </div>

      <div className="panel panel-premium" style={{ marginBottom: 22 }}>
        <div className="panel-header">
          <div className="panel-title-group">
            <div className="panel-icon-badge"><i className="fa-solid fa-bolt"></i></div>
            <div>
              <h2>Extension Apply Tracker</h2>
              <span className="panel-subtitle">Automatic real-time log from Chrome / Edge AutoFill extension</span>
            </div>
          </div>
          <div className="panel-header-actions">
            <span className="tracker-pill tracker-submitted" id="dash-submitted-pill">{submittedCount} Submitted</span>
            <span className="tracker-pill tracker-autofill" id="dash-autofill-pill">{autofillCount} Autofilled</span>
            <button className="btn btn-sm btn-outline" onClick={loadStats}><i className="fa-solid fa-rotate"></i> Refresh</button>
          </div>
        </div>
        <div className="panel-body panel-body-flush">
          <div className="table-responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer ID</th>
                  <th>Applicant</th>
                  <th>Post / Organization</th>
                  <th>Fields Filled</th>
                  <th>Status</th>
                  <th>Applied Time</th>
                  <th style={{ textAlign: 'right' }}>Portal</th>
                </tr>
              </thead>
              <tbody id="dash-recent-applies">
                {recentApplies.length === 0 ? (
                  <tr>
                    <td colSpan="7" className="text-center text-muted" style={{ padding: 28 }}>
                      <i className="fa-solid fa-puzzle-piece" style={{ fontSize: 18, display: 'block', marginBottom: 6, color: '#94a3b8' }}></i>
                      No applications tracked from extension yet. Apply on any job portal using the extension to see live updates here.
                    </td>
                  </tr>
                ) : (
                  pagedApplies.map((a, idx) => {
                    const isSubmitted = a.actionType === 'submitted';
                    const initial = (a.applicantName || 'A').trim().charAt(0).toUpperCase();
                    return (
                      <tr key={a.id || `${trackerStart}-${idx}`}>
                        <td><strong className="code-pill">{a.customerId}</strong></td>
                        <td>
                          <div className="applicant-cell">
                            <span className="mini-avatar">{initial}</span>
                            <div>
                              <div style={{ fontWeight: 700, color: '#0f172a' }}>{a.applicantName}</div>
                              {a.mobile && <div style={{ fontSize: 11, color: '#64748b' }}>{a.mobile}</div>}
                            </div>
                          </div>
                        </td>
                        <td>
                          <div style={{ fontWeight: 600, color: '#0f172a' }}>{a.jobTitle || 'Online Application'}</div>
                          <div style={{ fontSize: 11, color: '#64748b' }}>{a.organization || ''}</div>
                        </td>
                        <td><span className="code-pill">{a.filledCount || 0} fields</span></td>
                        <td>
                          <span
                            className={`badge ${isSubmitted ? 'badge-success' : ''}`}
                            style={!isSubmitted ? { background: '#e0f2fe', color: '#0369a1' } : undefined}
                          >
                            {isSubmitted ? '✓ SUBMITTED' : '⚡ AUTOFILLED'}
                          </span>
                        </td>
                        <td style={{ fontSize: 12, color: '#475569' }}>{new Date(a.appliedAt).toLocaleString()}</td>
                        <td style={{ textAlign: 'right' }}>
                          {a.portalUrl ? (
                            <a href={a.portalUrl} target="_blank" rel="noreferrer" className="btn btn-sm btn-outline">Open ↗</a>
                          ) : '-'}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {recentApplies.length > TRACKER_PAGE_SIZE && (
            <div
              id="tracker-pagination"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '12px 18px',
                borderTop: '1px solid #e2e8f0',
                background: '#f8fafc',
                flexWrap: 'wrap'
              }}
            >
              <span style={{ fontSize: 12.5, color: '#475569', fontWeight: 600 }}>
                Showing {trackerStart + 1}–{Math.min(trackerStart + TRACKER_PAGE_SIZE, recentApplies.length)} of {recentApplies.length} entries
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  id="btn-tracker-prev"
                  className="btn btn-sm btn-outline"
                  disabled={safeTrackerPage <= 1}
                  onClick={() => setTrackerPage((p) => Math.max(1, p - 1))}
                >
                  <i className="fa-solid fa-chevron-left"></i> Prev
                </button>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: '#0f172a', padding: '0 6px' }}>
                  Page {safeTrackerPage} / {trackerTotalPages}
                </span>
                <button
                  type="button"
                  id="btn-tracker-next"
                  className="btn btn-sm btn-primary"
                  disabled={safeTrackerPage >= trackerTotalPages}
                  onClick={() => setTrackerPage((p) => Math.min(trackerTotalPages, p + 1))}
                >
                  Next Page <i className="fa-solid fa-chevron-right"></i>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="dashboard-panels-grid">
        <div className="panel panel-premium">
          <div className="panel-header">
            <div className="panel-title-group">
              <div className="panel-icon-badge badge-indigo"><i className="fa-solid fa-address-card"></i></div>
              <div>
                <h2>Recent Customer Profiles</h2>
                <span className="panel-subtitle">Latest candidates ready for application</span>
              </div>
            </div>
            <button className="btn btn-sm btn-outline" onClick={() => onSwitchView('view-customers')}>
              View All <i className="fa-solid fa-arrow-right"></i>
            </button>
          </div>
          <div className="panel-body panel-body-flush">
            <div className="table-responsive">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Customer ID</th>
                    <th>Applicant</th>
                    <th>Mobile</th>
                    <th>NID</th>
                    <th>Media Ready</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody id="dash-recent-customers">
                  {recentCustomers.length === 0 ? (
                    <tr><td colSpan="6" className="text-center text-muted" style={{ padding: 28 }}>No customer profiles added yet.</td></tr>
                  ) : (
                    recentCustomers.map((c) => {
                      const initial = (c.applicantName || 'C').trim().charAt(0).toUpperCase();
                      return (
                        <tr key={c.id}>
                          <td><strong className="code-pill">{c.id}</strong></td>
                          <td>
                            <div className="applicant-cell">
                              <span className="mini-avatar" style={{ background: '#ecfdf5', color: '#065f46' }}>{initial}</span>
                              <span style={{ fontWeight: 600 }}>{c.applicantName}</span>
                            </div>
                          </td>
                          <td>{c.mobile || '-'}</td>
                          <td>{c.nid || '-'}</td>
                          <td>
                            {c.photoUrl && <span className="media-chip chip-photo"><i className="fa-solid fa-image"></i> Photo</span>}
                            {c.signatureUrl && <span className="media-chip chip-sign"><i className="fa-solid fa-pen-nib"></i> Sign</span>}
                            {!c.photoUrl && !c.signatureUrl && <span className="media-chip chip-none">Pending</span>}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <button className="btn btn-sm btn-outline" onClick={() => onOpenCustomerModal(c.id, c)}>
                              <i className="fa-solid fa-sliders"></i> Manage
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="panel panel-premium">
          <div className="panel-header">
            <div className="panel-title-group">
              <div className="panel-icon-badge badge-emerald"><i className="fa-solid fa-sliders"></i></div>
              <div>
                <h2>System &amp; Extension Health</h2>
                <span className="panel-subtitle">Media readiness &amp; sync bridge</span>
              </div>
            </div>
          </div>
          <div className="panel-body">
            <div className="readiness-list">
              <div className="readiness-item">
                <div className="readiness-label-row">
                  <span><i className="fa-solid fa-camera text-primary"></i> 300×300 Photos Ready</span>
                  <strong id="stat-photo-ready">{photoReady} / {totalCust}</strong>
                </div>
                <div className="progress-track">
                  <div id="dash-photo-bar" className="progress-fill fill-emerald" style={{ width: `${photoPct}%` }}></div>
                </div>
              </div>

              <div className="readiness-item">
                <div className="readiness-label-row">
                  <span><i className="fa-solid fa-signature" style={{ color: '#2563eb' }}></i> 300×80 Signatures Ready</span>
                  <strong id="stat-sign-ready">{signReady} / {totalCust}</strong>
                </div>
                <div className="progress-track">
                  <div id="dash-sign-bar" className="progress-fill fill-blue" style={{ width: `${signPct}%` }}></div>
                </div>
              </div>

              <div className="readiness-item">
                <div className="readiness-label-row">
                  <span><i className="fa-solid fa-hard-drive" style={{ color: '#0d9488' }}></i> R2 Storage Quota (5 GB Max)</span>
                  <strong id="stat-r2-storage">{usedMb} MB / {maxGb} GB</strong>
                </div>
                <div className="progress-track">
                  <div id="dash-r2-storage-bar" className="progress-fill fill-emerald" style={{ width: `${storagePct}%` }}></div>
                </div>
              </div>

              <div className="readiness-item">
                <div className="readiness-label-row">
                  <span><i className="fa-solid fa-gauge-high" style={{ color: '#7c3aed' }}></i> R2 Monthly Ops (500k Max)</span>
                  <strong id="stat-r2-ops">{usedOps.toLocaleString()} / {Math.round(maxOps / 1000)}k</strong>
                </div>
                <div className="progress-track">
                  <div id="dash-r2-ops-bar" className="progress-fill fill-blue" style={{ width: `${opsPct}%` }}></div>
                </div>
              </div>

              <div className="api-status-row">
                <span><i className="fa-solid fa-key" style={{ color: '#d97706' }}></i> Website API Key</span>
                <span
                  id="stat-api-status"
                  className="status-pill-active"
                  style={!hasKey ? { background: '#fee2e2', color: '#b91c1c' } : undefined}
                >
                  {hasKey ? 'Active (1 Key)' : 'No Active Key'}
                </span>
              </div>
            </div>

            <div className="extension-connect-card">
              <div className="ext-card-title">
                <i className="fa-solid fa-plug-circle-check"></i> Extension Server Endpoint
              </div>
              <p>Use this Server URL inside your Chrome/Edge AutoFill extension settings:</p>
              <div className="ext-url-bar">
                <code id="display-server-url">{serverUrl}</code>
                <button type="button" className="btn btn-sm btn-outline" onClick={copyServerUrl} title="Copy URL">
                  <i className="fa-regular fa-copy"></i> Copy
                </button>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-primary btn-block"
                style={{ marginTop: 10 }}
                onClick={() => onSwitchView('view-keys')}
              >
                <i className="fa-solid fa-key"></i> View Developer API Key
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
