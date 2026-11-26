import React, { useEffect, useState, useCallback } from 'react';
import { API } from '../services/api.js';

export default function ApiKeysView({ showToast }) {
  const [keyInfo, setKeyInfo] = useState(null);
  const [showKey, setShowKey] = useState(false);

  const loadKey = useCallback(async () => {
    try {
      const res = await API.getApiKeys();
      setKeyInfo(res.keys?.[0] || null);
    } catch (err) {
      console.error('Failed to load API key:', err);
    }
  }, []);

  useEffect(() => {
    loadKey();
  }, [loadKey]);

  const serverUrl =
    window.location.protocol === 'file:' || !window.location.host
      ? 'http://localhost:5000'
      : `${window.location.protocol}//${window.location.host}`;

  const copyValue = (val, msg) => {
    navigator.clipboard?.writeText(val).then(() => showToast(msg), () => showToast(val));
  };

  const regenerateKey = async () => {
    if (!window.confirm('Regenerate Website API Key? You will need to update the new key in your Chrome extension.')) return;
    try {
      await API.createApiKey('Website API Key');
      showToast('Website API Key regenerated!');
      loadKey();
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  };

  const keyStatus = keyInfo?.status || (keyInfo?.active !== false ? 'active' : 'revoked');

  return (
    <section id="view-keys" className="content-view active">
      <div className="view-header">
        <div>
          <h1>Website Developer API Key</h1>
          <p>Single encrypted API key used to connect your browser extension to this web application.</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-outline" onClick={regenerateKey}>
            <i className="fa-solid fa-rotate"></i> Regenerate Key
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2><i className="fa-solid fa-key" style={{ color: 'var(--primary)' }}></i> Active Website API Key</h2>
          <span className={`badge ${keyStatus === 'active' ? 'badge-success' : 'badge-danger'}`}>
            {keyStatus.toUpperCase()}
          </span>
        </div>
        <div className="panel-body">
          <div className="form-group">
            <label>Web App Server URL (for Browser Extension)</label>
            <div className="copy-key-bar">
              <input type="text" readOnly className="form-control" value={serverUrl} style={{ fontFamily: 'monospace' }} />
              <button type="button" className="btn btn-outline" onClick={() => copyValue(serverUrl, 'Server URL copied!')}>
                <i className="fa-solid fa-copy"></i> Copy URL
              </button>
            </div>
          </div>

          <div className="form-group" style={{ marginTop: 16 }}>
            <label>Website Developer API Key</label>
            <div className="copy-key-bar">
              <input
                type={showKey ? 'text' : 'password'}
                readOnly
                className="form-control"
                value={keyInfo?.fullKey || ''}
                style={{ fontFamily: 'monospace', fontWeight: 600 }}
              />
              <button type="button" className="btn btn-outline" onClick={() => setShowKey((s) => !s)}>
                <i className={`fa-solid ${showKey ? 'fa-eye-slash' : 'fa-eye'}`}></i> {showKey ? 'Hide' : 'Show'}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => copyValue(keyInfo?.fullKey || '', 'Website API Key copied to clipboard!')}
              >
                <i className="fa-solid fa-copy"></i> Copy Key
              </button>
            </div>
          </div>

          <div className="form-row" style={{ marginTop: 16, color: 'var(--text-muted)', fontSize: 12 }}>
            <div><strong>Created By:</strong> {keyInfo ? `${keyInfo.userName || 'admin'} (${keyInfo.userRole || 'admin'})` : '-'}</div>
            <div style={{ marginLeft: 24 }}><strong>Last Used:</strong> {keyInfo?.lastUsedAt ? new Date(keyInfo.lastUsedAt).toLocaleString() : 'Never'}</div>
            <div style={{ marginLeft: 24 }}><strong>Created At:</strong> {keyInfo?.createdAt ? new Date(keyInfo.createdAt).toLocaleDateString() : '-'}</div>
          </div>
        </div>
      </div>
    </section>
  );
}
