/**
 * React API Client with JWT Auth, Firestore/R2 Endpoints & Error Handling
 */
export const API = {
  TOKEN_KEY: 'govfill_jwt_token',

  getToken() {
    return localStorage.getItem(this.TOKEN_KEY);
  },

  setToken(token) {
    localStorage.setItem(this.TOKEN_KEY, token);
  },

  clearToken() {
    localStorage.removeItem(this.TOKEN_KEY);
  },

  isAuthenticated() {
    return Boolean(this.getToken());
  },

  getBaseUrl() {
    if (window.location.protocol === 'file:' || !window.location.host) {
      return 'http://localhost:5000';
    }
    return '';
  },

  async request(endpoint, options = {}) {
    const headers = { ...(options.headers || {}) };
    const token = this.getToken();

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    const url = endpoint.startsWith('http') ? endpoint : `${this.getBaseUrl()}${endpoint}`;
    const res = await fetch(url, { ...options, headers });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (res.status === 401 && !endpoint.includes('/login')) {
        this.clearToken();
        window.location.reload();
      }
      throw new Error(data.message || `Request failed with status ${res.status}`);
    }

    return data;
  },

  async login(username, password) {
    const res = await this.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    if (res.token) this.setToken(res.token);
    return res;
  },

  getMe() {
    return this.request('/api/auth/me');
  },

  getUsers() {
    return this.request('/api/auth/users');
  },

  createUser(payload) {
    return this.request('/api/auth/users', { method: 'POST', body: JSON.stringify(payload) });
  },

  updateUser(id, payload) {
    return this.request(`/api/auth/users/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  },

  deleteUser(id) {
    return this.request(`/api/auth/users/${id}`, { method: 'DELETE' });
  },

  getCustomers(search = '') {
    const query = search ? `?search=${encodeURIComponent(search)}` : '';
    return this.request(`/api/customers${query}`);
  },

  getCustomerById(id) {
    return this.request(`/api/customers/${encodeURIComponent(id)}`);
  },

  createCustomer(payload) {
    return this.request('/api/customers', { method: 'POST', body: JSON.stringify(payload) });
  },

  updateCustomer(id, payload) {
    return this.request(`/api/customers/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) });
  },

  deleteCustomer(id) {
    return this.request(`/api/customers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  uploadPhoto(id, photoBlob) {
    const formData = new FormData();
    formData.append('photo', photoBlob, `photo_${id}.jpg`);
    return this.request(`/api/customers/${encodeURIComponent(id)}/photo`, { method: 'POST', body: formData });
  },

  uploadSignature(id, signBlob) {
    const formData = new FormData();
    formData.append('signature', signBlob, `signature_${id}.jpg`);
    return this.request(`/api/customers/${encodeURIComponent(id)}/signature`, { method: 'POST', body: formData });
  },

  uploadCustomerFile(id, file) {
    const formData = new FormData();
    formData.append('file', file, file.name);
    return this.request(`/api/customers/${encodeURIComponent(id)}/files`, { method: 'POST', body: formData });
  },

  deleteCustomerFile(id, fileId) {
    return this.request(`/api/customers/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
  },

  parsePdf(file, geminiApiKey = '', autoSave = false, ocrText = '') {
    const formData = new FormData();
    if (file) formData.append('pdf', file);
    formData.append('autoSave', String(autoSave));
    if (geminiApiKey) formData.append('geminiApiKey', geminiApiKey);
    if (ocrText) formData.append('ocrText', ocrText);
    return this.request('/api/parse/pdf', { method: 'POST', body: formData });
  },

  getApiKeys() {
    return this.request('/api/keys');
  },

  createApiKey(label) {
    return this.request('/api/keys', { method: 'POST', body: JSON.stringify({ label }) });
  },

  getDashboardStats() {
    return this.request('/api/dashboard/stats');
  }
};
