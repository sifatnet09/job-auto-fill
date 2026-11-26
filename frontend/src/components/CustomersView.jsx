import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { API } from '../services/api.js';

const JOB_CATEGORY_STYLES = {
  'Army Job': { bg: '#dcfce7', color: '#166534' },
  'Navy Job': { bg: '#dbeafe', color: '#1e40af' },
  'Air Force Job': { bg: '#e0f2fe', color: '#0369a1' },
  'All Job Pdf': { bg: '#f1f5f9', color: '#334155' }
};

function getCategoryStyle(category) {
  return JOB_CATEGORY_STYLES[category] || JOB_CATEGORY_STYLES['All Job Pdf'];
}

export default function CustomersView({ currentUser, refreshTrigger, onOpenNewCustomer, onOpenCustomerModal, showToast }) {
  const [search, setSearch] = useState('');
  const [allCustomers, setAllCustomers] = useState(() => {
    try {
      const raw = sessionStorage.getItem('govfill_customers_cache');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  const loadCustomers = useCallback(async () => {
    try {
      const res = await API.getCustomers('');
      const list = res.customers || [];
      setAllCustomers(list);
      try {
        sessionStorage.setItem('govfill_customers_cache', JSON.stringify(list));
      } catch {
        // ignore storage quota errors
      }
    } catch (err) {
      console.error('Failed to load customers:', err);
    }
  }, []);

  useEffect(() => {
    loadCustomers();
  }, [refreshTrigger, loadCustomers]);

  // Zero-lag instant client-side filtering (no network request per keystroke)
  const customers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allCustomers;
    const qDigits = q.replace(/\D/g, '');
    return allCustomers.filter((c) => {
      const name = (c.applicantName || '').toLowerCase();
      const id = (c.id || '').toLowerCase();
      const mob = String(c.mobile || '');
      const mobDigits = mob.replace(/\D/g, '');
      const nid = String(c.nid || '');
      const category = (c.jobCategory || 'All Job Pdf').toLowerCase();
      return (
        name.includes(q) ||
        id.includes(q) ||
        mob.includes(q) ||
        (qDigits.length >= 4 && mobDigits.includes(qDigits)) ||
        nid.includes(q) ||
        category.includes(q)
      );
    });
  }, [allCustomers, search]);

  const handleDelete = async (id) => {
    if (!window.confirm(`Are you sure you want to delete customer ${id}? Remaining customer IDs will automatically re-serial.`)) return;
    try {
      const res = await API.deleteCustomer(id);
      showToast(res.message || 'Customer deleted & IDs re-serialized.');
      sessionStorage.removeItem('govfill_dash_cache');
      if (Array.isArray(res.customers)) {
        setAllCustomers(res.customers);
        try {
          sessionStorage.setItem('govfill_customers_cache', JSON.stringify(res.customers));
        } catch {
          // ignore storage quota errors
        }
      } else {
        sessionStorage.removeItem('govfill_customers_cache');
        loadCustomers();
      }
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
  };

  const matchedDetail = search.trim() && customers.length > 0 ? customers[0] : null;

  return (
    <section id="view-customers" className="content-view active">
      <div className="view-header">
        <div>
          <h1>Customer Profiles Management</h1>
          <p>Browse, edit, and manage candidate profiles, unique Customer IDs, and Teletalk photos/signatures.</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-primary" onClick={onOpenNewCustomer}>
            <i className="fa-solid fa-user-plus"></i> Add New Profile
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div className="search-box">
            <i className="fa-solid fa-magnifying-glass"></i>
            <input
              type="text"
              id="customer-search-input"
              placeholder="Search by Name, Mobile, NID, Job Category, or TTC-0001..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <span className="text-muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
            {customers.length} profile{customers.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="panel-body">
          {matchedDetail && (
            <div
              id="customer-search-detail-card"
              style={{
                marginBottom: 16,
                background: '#f8fafc',
                border: '1px solid #cbd5e1',
                borderRadius: 10,
                padding: 14
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div>
                  <strong className="code-pill">{matchedDetail.id}</strong>{' '}
                  <strong style={{ fontSize: 15 }}>{matchedDetail.applicantName}</strong>{' '}
                  {matchedDetail.applicantNameBn && <span className="text-muted">({matchedDetail.applicantNameBn})</span>}
                </div>
                <button className="btn btn-sm btn-primary" onClick={() => onOpenCustomerModal(matchedDetail.id, matchedDetail)}>
                  <i className="fa-solid fa-pen-to-square"></i> View / Edit Full Details
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, fontSize: 12 }}>
                <div><strong>Mobile:</strong> {matchedDetail.mobile || '-'}</div>
                <div><strong>Father:</strong> {matchedDetail.fatherName || '-'}</div>
                <div><strong>Mother:</strong> {matchedDetail.motherName || '-'}</div>
                <div><strong>NID:</strong> {matchedDetail.nid || '-'}</div>
                <div><strong>DOB:</strong> {matchedDetail.dob || '-'}</div>
                <div><strong>Job Category:</strong> {matchedDetail.jobCategory || 'All Job Pdf'}</div>
                <div><strong>Gender / Religion:</strong> {matchedDetail.gender || '-'} / {matchedDetail.religion || '-'}</div>
                <div><strong>District:</strong> {[matchedDetail.presentAddress?.upazila, matchedDetail.presentAddress?.district].filter(Boolean).join(', ') || '-'}</div>
                <div><strong>Email:</strong> {matchedDetail.email || '-'}</div>
              </div>
            </div>
          )}

          <div className="table-responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer ID</th>
                  <th>Applicant Name</th>
                  <th>Phone Number</th>
                  <th>NID No</th>
                  <th>Job Category</th>
                  <th>Photo (300x300)</th>
                  <th>Signature (300x80)</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody id="customers-table-body">
                {customers.length === 0 ? (
                  <tr><td colSpan="8" className="text-center text-muted" style={{ padding: 24 }}>No customer profiles found.</td></tr>
                ) : (
                  customers.map((c) => {
                    const catLabel = c.jobCategory || 'All Job Pdf';
                    const catStyle = getCategoryStyle(catLabel);
                    return (
                      <tr key={c.id}>
                        <td><strong className="code-pill">{c.id}</strong></td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{c.applicantName}</div>
                          {c.applicantNameBn && <div style={{ fontSize: 11, color: '#64748b' }}>{c.applicantNameBn}</div>}
                        </td>
                        <td>{c.mobile || '-'}</td>
                        <td>{c.nid || '-'}</td>
                        <td>
                          <span
                            className="badge"
                            style={{ background: catStyle.bg, color: catStyle.color, fontWeight: 700 }}
                          >
                            {catLabel}
                          </span>
                        </td>
                        <td>
                          {c.photoUrl
                            ? <span className="badge badge-success">300x300 OK</span>
                            : <span className="badge badge-danger">Missing</span>}
                        </td>
                        <td>
                          {c.signatureUrl
                            ? <span className="badge badge-success">300x80 OK</span>
                            : <span className="badge badge-danger">Missing</span>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button className="btn btn-sm btn-outline" onClick={() => onOpenCustomerModal(c.id, c)}>
                            <i className="fa-solid fa-pen-to-square"></i> View / Edit
                          </button>
                          {currentUser?.role === 'admin' && (
                            <button
                              className="btn btn-sm btn-outline text-danger"
                              style={{ marginLeft: 6 }}
                              onClick={() => handleDelete(c.id)}
                            >
                              <i className="fa-solid fa-trash"></i>
                            </button>
                          )}
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
    </section>
  );
}
