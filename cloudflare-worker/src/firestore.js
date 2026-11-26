/**
 * Lightweight Firebase Firestore REST API Client for Cloudflare Workers
 */
import { getGoogleAccessToken } from './crypto.js';

function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(toFirestoreValue) } };
  }
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFirestoreValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return Boolean(v.booleanValue);
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) {
    return (v.arrayValue.values || []).map(fromFirestoreValue);
  }
  if ('mapValue' in v) {
    const out = {};
    for (const [k, fv] of Object.entries(v.mapValue.fields || {})) {
      out[k] = fromFirestoreValue(fv);
    }
    return out;
  }
  return null;
}

function docToObject(doc) {
  if (!doc || !doc.name) return null;
  const out = {};
  for (const [k, fv] of Object.entries(doc.fields || {})) {
    out[k] = fromFirestoreValue(fv);
  }
  if (!out.id) {
    out.id = doc.name.split('/').pop();
  }
  return out;
}

export class FirestoreClient {
  constructor(env) {
    this.projectId = env.FIREBASE_PROJECT_ID || '';
    this.clientEmail = env.FIREBASE_CLIENT_EMAIL || '';
    this.privateKey = env.FIREBASE_PRIVATE_KEY || '';
    this.baseUrl = `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/(default)/documents`;
  }

  isConfigured() {
    return Boolean(this.projectId && this.clientEmail && this.privateKey);
  }

  async headers() {
    if (!this.isConfigured()) {
      throw new Error('Firebase Firestore credentials are not configured yet (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY).');
    }
    const token = await getGoogleAccessToken(this.clientEmail, this.privateKey);
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
  }

  async getDoc(collection, docId) {
    const res = await fetch(`${this.baseUrl}/${collection}/${encodeURIComponent(docId)}`, {
      headers: await this.headers()
    });
    if (res.status === 404) return null;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Firestore GET failed (${res.status})`);
    return docToObject(data);
  }

  async setDoc(collection, docId, payload) {
    const fields = {};
    for (const [k, v] of Object.entries(payload)) {
      if (v !== undefined) fields[k] = toFirestoreValue(v);
    }
    const res = await fetch(`${this.baseUrl}/${collection}/${encodeURIComponent(docId)}`, {
      method: 'PATCH',
      headers: await this.headers(),
      body: JSON.stringify({ fields })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Firestore SET failed (${res.status})`);
    return docToObject(data);
  }

  async deleteDoc(collection, docId) {
    const res = await fetch(`${this.baseUrl}/${collection}/${encodeURIComponent(docId)}`, {
      method: 'DELETE',
      headers: await this.headers()
    });
    if (res.status === 404) return false;
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error?.message || `Firestore DELETE failed (${res.status})`);
    }
    return true;
  }

  async listDocs(collection, pageSize = 500) {
    const items = [];
    let pageToken = '';
    const hdrs = await this.headers();

    do {
      const url = `${this.baseUrl}/${collection}?pageSize=${pageSize}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await fetch(url, { headers: hdrs });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || `Firestore LIST failed (${res.status})`);
      for (const doc of data.documents || []) {
        items.push(docToObject(doc));
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    return items;
  }

  buildDocName(collection, docId) {
    return `projects/${this.projectId}/databases/(default)/documents/${collection}/${docId}`;
  }

  buildFields(payload) {
    const fields = {};
    for (const [k, v] of Object.entries(payload)) {
      if (v !== undefined) fields[k] = toFirestoreValue(v);
    }
    return fields;
  }

  async commitWrites(writes = []) {
    if (!writes || writes.length === 0) return;
    const hdrs = await this.headers();
    for (let i = 0; i < writes.length; i += 450) {
      const batch = writes.slice(i, i + 450);
      const res = await fetch(`${this.baseUrl}:commit`, {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify({ writes: batch })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error?.message || `Firestore COMMIT failed (${res.status})`);
      }
    }
  }
}
