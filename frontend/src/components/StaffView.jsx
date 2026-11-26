import React, { useState, useEffect, useCallback } from 'react';
import { API } from '../services/api.js';

export default function StaffView({ currentUser, onUpdateCurrentUser, showToast }) {
  const [users, setUsers] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editId, setEditId] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [manualUser, setManualUser] = useState(false);
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('admin');

  const loadStaff = useCallback(async () => {
    try {
      const res = await API.getUsers();
      setUsers(res.users || []);
    } catch (err) {
      console.error('Failed to load staff:', err);
    }
  }, []);

  useEffect(() => {
    loadStaff();
  }, [loadStaff]);

  const openNew = () => {
    setEditId('');
    setEmail('');
    setUsername('');
    setManualUser(false);
    setFullName('');
    setPassword('');
    setRole('admin');
    setModalOpen(true);
  };

  const openEdit = (u) => {
    setEditId(u.id);
    setEmail(u.email || '');
    setUsername(u.username || '');
    setManualUser(true);
    setFullName(u.fullName || '');
    setPassword('');
    setRole(u.role || 'admin');
    setModalOpen(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        username: username.trim() || (email ? email.split('@')[0].trim() : ''),
        fullName: fullName.trim(),
        email: email.trim(),
        role
      };
      if (password) payload.password = password;

      const res = editId ? await API.updateUser(editId, payload) : await API.createUser(payload);
      if (editId && currentUser && editId === currentUser.id) {
        if (res.token) API.setToken(res.token);
        onUpdateCurrentUser(res.user);
      }
      setModalOpen(false);
      showToast(res.message);
      loadStaff();
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this user account?')) return;
    try {
      await API.deleteUser(id);
      showToast('Account deleted.');
      loadStaff();
    } catch (err) {
      alert(`Delete error: ${err.message}`);
    }
  };

  return (
    <section id="view-staff" className="content-view active">
      <div className="view-header">
        <div>
          <h1>Admin &amp; Staff Management</h1>
          <p>Manage administrator Gmail, username, and login password stored in Firebase Firestore.</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-primary" onClick={openNew}>
            <i className="fa-solid fa-user-shield"></i> Add Account
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>Registered Accounts (Firestore)</h2>
        </div>
        <div className="panel-body">
          <div className="table-responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Full Name</th>
                  <th>Role</th>
                  <th>Gmail / Email</th>
                  <th>Created Date</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td><strong>{u.username}</strong></td>
                    <td>{u.fullName || '-'}</td>
                    <td><span className={`role-badge role-${u.role}`}>{(u.role || 'admin').toUpperCase()}</span></td>
                    <td>{u.email || '-'}</td>
                    <td>{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '-'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-sm btn-outline" onClick={() => openEdit(u)}>
                        <i className="fa-solid fa-pen-to-square"></i> Edit
                      </button>
                      {currentUser && u.id !== currentUser.id && (
                        <button className="btn btn-sm btn-outline text-danger" style={{ marginLeft: 6 }} onClick={() => handleDelete(u.id)}>
                          <i className="fa-solid fa-trash"></i>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {modalOpen && (
        <div className="modal-backdrop" style={{ display: 'flex' }}>
          <div className="modal-dialog">
            <div className="modal-header">
              <h2>{editId ? `Edit Account: ${username}` : 'Add Admin / Staff Account'}</h2>
              <button className="modal-close" onClick={() => setModalOpen(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label>Gmail / Email Address *</label>
                  <input
                    type="email"
                    className="form-control"
                    placeholder="example@gmail.com"
                    required
                    value={email}
                    onChange={(e) => {
                      const val = e.target.value;
                      setEmail(val);
                      if (!editId && val.includes('@') && !manualUser) {
                        setUsername(val.split('@')[0].trim());
                      }
                    }}
                  />
                </div>
                <div className="form-group">
                  <label>Username (Optional - auto from Gmail)</label>
                  <input
                    type="text"
                    className="form-control"
                    value={username}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      setManualUser(Boolean(e.target.value.trim()));
                    }}
                  />
                </div>
                <div className="form-group">
                  <label>Full Name</label>
                  <input type="text" className="form-control" value={fullName} onChange={(e) => setFullName(e.target.value)} />
                </div>
                <div className="form-group">
                  <label>{editId ? 'New Password (Optional)' : 'Password *'}</label>
                  <input
                    type="password"
                    className="form-control"
                    required={!editId}
                    placeholder={editId ? 'Leave blank to keep current password' : ''}
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Role</label>
                  <select className="form-control" value={role} onChange={(e) => setRole(e.target.value)}>
                    <option value="admin">Administrator</option>
                    <option value="employee">Employee (Operator)</option>
                  </select>
                </div>
                <div className="modal-footer" style={{ paddingTop: 14 }}>
                  <button type="submit" className="btn btn-primary">{editId ? 'Save Changes' : 'Create Account'}</button>
                  <button type="button" className="btn btn-outline" onClick={() => setModalOpen(false)}>Cancel</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
