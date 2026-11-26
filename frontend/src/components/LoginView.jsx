import React, { useState } from 'react';
import { API } from '../services/api.js';

export default function LoginView({ onLoginSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function doLogin(u, p) {
    setError('');
    setLoading(true);
    try {
      const res = await API.login(u, p);
      onLoginSuccess(res.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const handleSubmit = (e) => {
    e.preventDefault();
    doLogin(username.trim(), password);
  };

  const quickFillAdmin = () => {
    setUsername('admin');
    setPassword('Admin@123456');
    doLogin('admin', 'Admin@123456');
  };

  return (
    <div id="auth-view" className="auth-wrapper">
      <div className="auth-card">
        <div className="auth-header">
          <img
            src="/images/toya_logo.jpg"
            alt="Toya Telecom & Computer Logo"
            style={{
              width: 145,
              height: 'auto',
              borderRadius: 12,
              marginBottom: 12,
              padding: 6,
              background: '#fff',
              border: '1px solid #e2e8f0',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08)'
            }}
          />
          <h1>Toya Telecom &amp; Computer</h1>
          <p>Buy Sell &amp; Exchange</p>
        </div>

        <form id="login-form" className="auth-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label><i className="fa-solid fa-envelope"></i> Gmail / Username</label>
            <input
              type="text"
              className="form-control"
              placeholder="example@gmail.com or admin"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label><i className="fa-solid fa-lock"></i> Password</label>
            <input
              type="password"
              className="form-control"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && <div className="alert alert-danger">{error}</div>}

          <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
            <i className="fa-solid fa-right-to-bracket"></i> {loading ? 'Signing In...' : 'Sign In to Dashboard'}
          </button>
        </form>

        <div className="auth-demo-bar">
          <span>Admin Access (Saved in Firestore):</span>
          <div className="demo-buttons">
            <button type="button" className="btn btn-sm btn-outline" onClick={quickFillAdmin}>
              <i className="fa-solid fa-shield-halved"></i> Quick Fill Admin
            </button>
          </div>
        </div>

        <div style={{ marginTop: 16, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>
          Developed By <strong>Sifat Hossain</strong>
        </div>
      </div>
    </div>
  );
}
