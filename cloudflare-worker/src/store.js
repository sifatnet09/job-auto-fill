/**
 * Cloud Data Store: Firebase Firestore (Structured Data) + Cloudflare R2 (Images & Files)
 */
import { FirestoreClient } from './firestore.js';
import { hashPassword, verifyPassword, generateApiKey, sha256Hex, randomHex } from './crypto.js';

let cachedUsageState = null;
let cachedUsageAt = 0;
let pendingReadOps = 0;

// Isolate-level fast caches (cuts Firestore round-trips by ~90%)
let seededDone = false;
let cachedCustomers = null;
let cachedCustomersAt = 0;
let cachedApps = null;
let cachedAppsAt = 0;
let cachedApiKeys = null;
let cachedApiKeysAt = 0;
let cachedUsers = null;
let cachedUsersAt = 0;

export class CloudStore {
  constructor(env) {
    this.env = env;
    this.fs = new FirestoreClient(env);
    this.bucket = env.STORAGE_BUCKET;
  }

  getLimits() {
    return {
      maxStorageBytes: Number(this.env.MAX_R2_STORAGE_BYTES || 5 * 1024 * 1024 * 1024), // 5 GB
      maxMonthlyOps: Number(this.env.MAX_R2_MONTHLY_OPS || 500000), // 500k ops/month
      maxUploadFileBytes: Number(this.env.MAX_UPLOAD_FILE_BYTES || 15 * 1024 * 1024) // 15 MB per file
    };
  }

  async calculateRealR2Bytes() {
    if (!this.bucket) return 0;
    let total = 0;
    let cursor;
    do {
      const listed = await this.bucket.list({ cursor, limit: 1000 });
      for (const obj of listed.objects || []) {
        total += Number(obj.size || 0);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return total;
  }

  async getUsage(syncR2Storage = false) {
    const limits = this.getLimits();
    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    const now = Date.now();

    if (!syncR2Storage && cachedUsageState && cachedUsageState.month === currentMonth && now - cachedUsageAt < 60000) {
      return {
        ...cachedUsageState,
        r2OpsCount: cachedUsageState.r2OpsCount + pendingReadOps,
        ...limits
      };
    }

    let doc = await this.fs.getDoc('meta', 'usage');
    let needsSave = false;

    if (!doc || doc.month !== currentMonth) {
      const existingBytes = doc?.r2BytesUsed !== undefined ? Number(doc.r2BytesUsed) : await this.calculateRealR2Bytes();
      doc = {
        month: currentMonth,
        r2BytesUsed: existingBytes,
        r2OpsCount: 0,
        r2WriteOps: 0,
        r2ReadOps: 0,
        updatedAt: new Date().toISOString()
      };
      needsSave = true;
    }

    if (syncR2Storage) {
      const realBytes = await this.calculateRealR2Bytes();
      if (realBytes !== Number(doc.r2BytesUsed || 0)) {
        doc.r2BytesUsed = realBytes;
        doc.updatedAt = new Date().toISOString();
        needsSave = true;
      }
    }

    if (needsSave) {
      await this.fs.setDoc('meta', 'usage', doc);
    }

    cachedUsageState = {
      month: doc.month,
      r2BytesUsed: Number(doc.r2BytesUsed || 0),
      r2OpsCount: Number(doc.r2OpsCount || 0),
      r2WriteOps: Number(doc.r2WriteOps || 0),
      r2ReadOps: Number(doc.r2ReadOps || 0),
      updatedAt: doc.updatedAt
    };
    cachedUsageAt = now;

    return {
      ...cachedUsageState,
      r2OpsCount: cachedUsageState.r2OpsCount + pendingReadOps,
      ...limits
    };
  }

  async assertQuotaForUpload(incomingBytes) {
    const limits = this.getLimits();
    if (incomingBytes > limits.maxUploadFileBytes) {
      const err = new Error(`File exceeds max allowed upload size of ${Math.round(limits.maxUploadFileBytes / (1024 * 1024))} MB.`);
      err.status = 413;
      throw err;
    }

    const usage = await this.getUsage(false);
    if (usage.r2BytesUsed + incomingBytes > limits.maxStorageBytes) {
      const err = new Error(`Cloudflare R2 storage limit reached (5.00 GB max). Delete unused files before uploading more.`);
      err.status = 413;
      throw err;
    }
    if (usage.r2OpsCount >= limits.maxMonthlyOps) {
      const err = new Error(`Monthly R2 operations limit reached (${limits.maxMonthlyOps.toLocaleString()} max for ${usage.month}).`);
      err.status = 429;
      throw err;
    }
    return usage;
  }

  async recordR2Write(deltaBytes, opCount = 1) {
    const usage = await this.getUsage(false);
    const nextDoc = {
      month: usage.month,
      r2BytesUsed: Math.max(0, Number(usage.r2BytesUsed || 0) + Number(deltaBytes || 0)),
      r2OpsCount: Number(usage.r2OpsCount || 0) + opCount,
      r2WriteOps: Number(usage.r2WriteOps || 0) + opCount,
      r2ReadOps: Number(usage.r2ReadOps || 0),
      updatedAt: new Date().toISOString()
    };
    pendingReadOps = 0;
    cachedUsageState = nextDoc;
    cachedUsageAt = Date.now();
    await this.fs.setDoc('meta', 'usage', nextDoc);
    return nextDoc;
  }

  async checkR2ReadQuota() {
    const usage = await this.getUsage(false);
    if (usage.r2OpsCount >= usage.maxMonthlyOps) {
      const err = new Error(`Monthly R2 operations limit reached (${usage.maxMonthlyOps.toLocaleString()} max).`);
      err.status = 429;
      throw err;
    }
    return usage;
  }

  recordR2Read(ctx) {
    pendingReadOps += 1;
    if (pendingReadOps >= 20) {
      const flushCount = pendingReadOps;
      pendingReadOps = 0;
      const flushTask = (async () => {
        try {
          const usage = await this.getUsage(false);
          const nextDoc = {
            month: usage.month,
            r2BytesUsed: Number(usage.r2BytesUsed || 0),
            r2OpsCount: Number(usage.r2OpsCount || 0) + flushCount,
            r2WriteOps: Number(usage.r2WriteOps || 0),
            r2ReadOps: Number(usage.r2ReadOps || 0) + flushCount,
            updatedAt: new Date().toISOString()
          };
          cachedUsageState = nextDoc;
          cachedUsageAt = Date.now();
          await this.fs.setDoc('meta', 'usage', nextDoc);
        } catch (e) {
          console.warn('Usage flush skipped:', e.message);
        }
      })();
      if (ctx?.waitUntil) ctx.waitUntil(flushTask);
    }
  }

  async ensureSeeded() {
    if (!this.fs.isConfigured()) {
      throw new Error('Firebase Firestore is not configured. Add FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY Worker secrets.');
    }
    if (seededDone) return;

    const [users, keys] = await Promise.all([
      this.fs.listDocs('admin_users', 50),
      this.fs.listDocs('api_keys', 20)
    ]);

    if (users.length === 0) {
      const defaultUsername = this.env.DEFAULT_ADMIN_USERNAME || 'admin';
      const defaultEmail = (this.env.DEFAULT_ADMIN_EMAIL || 'sifat.net09@gmail.com').toLowerCase();
      const passwordHash = await hashPassword('Admin@123456');
      const seededUser = {
        id: 'usr-admin-01',
        username: defaultUsername,
        fullName: 'Toya Telecom Admin',
        email: defaultEmail,
        passwordHash,
        role: 'admin',
        createdAt: new Date().toISOString()
      };
      await this.fs.setDoc('admin_users', 'usr-admin-01', seededUser);
      cachedUsers = [seededUser];
    } else {
      cachedUsers = users;
    }
    cachedUsersAt = Date.now();

    if (keys.length === 0) {
      const gen = await generateApiKey();
      const seededKey = {
        id: 'key-website-main',
        label: 'Website API Key',
        keyPrefix: gen.keyPrefix,
        keyHash: gen.keyHash,
        rawKey: gen.fullKey,
        userId: 'usr-admin-01',
        userName: 'admin',
        userRole: 'admin',
        active: true,
        lastUsedAt: null,
        createdAt: new Date().toISOString()
      };
      await this.fs.setDoc('api_keys', 'key-website-main', seededKey);
      cachedApiKeys = [seededKey];
    } else {
      cachedApiKeys = keys;
    }
    cachedApiKeysAt = Date.now();
    seededDone = true;
  }

  async listUsersCached() {
    await this.ensureSeeded();
    if (cachedUsers && Date.now() - cachedUsersAt < 120000) return cachedUsers;
    cachedUsers = await this.fs.listDocs('admin_users', 100);
    cachedUsersAt = Date.now();
    return cachedUsers;
  }

  async listCustomersCached(forceRefresh = false) {
    await this.ensureSeeded();
    if (!forceRefresh && cachedCustomers && Date.now() - cachedCustomersAt < 60000) {
      return cachedCustomers;
    }
    const list = await this.fs.listDocs('customers', 500);
    const orderedAsc = [...list].sort((a, b) => {
      const seqDiff = this.parseCustomerSeq(a.id) - this.parseCustomerSeq(b.id);
      if (seqDiff !== 0) return seqDiff;
      return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
    });
    const hasGap = orderedAsc.some((c, idx) => c.id !== `TTC-${String(idx + 1).padStart(4, '0')}`);
    if (hasGap) {
      const healed = await this.resequenceCustomers(list, list);
      return healed.customers;
    }
    list.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    cachedCustomers = list;
    cachedCustomersAt = Date.now();
    return cachedCustomers;
  }

  async listAppsCached(forceRefresh = false) {
    await this.ensureSeeded();
    if (!forceRefresh && cachedApps && Date.now() - cachedAppsAt < 30000) {
      return cachedApps;
    }
    const apps = await this.fs.listDocs('applications', 300);
    apps.sort((a, b) => new Date(b.appliedAt || 0) - new Date(a.appliedAt || 0));
    cachedApps = apps;
    cachedAppsAt = Date.now();
    return cachedApps;
  }

  async listApiKeysCached(forceRefresh = false) {
    await this.ensureSeeded();
    if (!forceRefresh && cachedApiKeys && Date.now() - cachedApiKeysAt < 120000) {
      return cachedApiKeys;
    }
    cachedApiKeys = await this.fs.listDocs('api_keys', 20);
    cachedApiKeysAt = Date.now();
    return cachedApiKeys;
  }

  // ==================== ADMIN USERS ====================
  async findUserByLogin(identifier) {
    const clean = String(identifier || '').trim().toLowerCase();
    if (!clean) return null;
    const users = await this.listUsersCached();
    return (
      users.find(
        u =>
          (u.username && u.username.toLowerCase() === clean) ||
          (u.email && u.email.toLowerCase() === clean)
      ) || null
    );
  }

  async findUserById(id) {
    const users = await this.listUsersCached();
    return users.find(u => u.id === id) || this.fs.getDoc('admin_users', id);
  }

  async getAllUsers() {
    const users = await this.listUsersCached();
    return users.map(({ passwordHash, ...safe }) => safe);
  }

  async createUser({ username, fullName, email, password, role }) {
    await this.ensureSeeded();
    const id = `usr-${randomHex(6)}`;
    const passwordHash = await hashPassword(password);
    const doc = {
      id,
      username,
      fullName: fullName || username,
      email: (email || '').toLowerCase(),
      passwordHash,
      role: role === 'admin' ? 'admin' : 'employee',
      createdAt: new Date().toISOString()
    };
    await this.fs.setDoc('admin_users', id, doc);
    cachedUsers = null;
    const { passwordHash: _, ...safe } = doc;
    return safe;
  }

  async updateUser(id, updates) {
    await this.ensureSeeded();
    const existing = await this.findUserById(id);
    if (!existing) return null;
    const next = { ...existing };
    if (updates.username !== undefined) next.username = updates.username;
    if (updates.fullName !== undefined) next.fullName = updates.fullName;
    if (updates.email !== undefined) next.email = String(updates.email || '').trim().toLowerCase();
    if (updates.role !== undefined) next.role = updates.role;
    if (updates.password && updates.password.trim()) {
      next.passwordHash = await hashPassword(updates.password);
    }
    next.updatedAt = new Date().toISOString();
    await this.fs.setDoc('admin_users', id, next);
    cachedUsers = null;
    const { passwordHash: _, ...safe } = next;
    return safe;
  }

  async deleteUser(id) {
    cachedUsers = null;
    return this.fs.deleteDoc('admin_users', id);
  }

  async verifyUserPassword(password, storedHash) {
    return verifyPassword(password, storedHash);
  }

  // ==================== CUSTOMERS ====================
  normalizeDigits(str) {
    return String(str || '').replace(/\D/g, '');
  }

  normalizeMobile(str) {
    const d = this.normalizeDigits(str);
    return d.length >= 11 ? d.slice(-11) : d;
  }

  findDuplicateCustomer(data, list) {
    const nid = this.normalizeDigits(data.nid);
    const mobile = this.normalizeMobile(data.mobile);
    const birthReg = this.normalizeDigits(data.birthReg);
    const name = String(data.applicantName || '').trim().toUpperCase();
    const dob = String(data.dob || '').trim();
    const father = String(data.fatherName || '').trim().toUpperCase();

    return list.find(c => {
      const cNid = this.normalizeDigits(c.nid);
      if (nid.length >= 8 && cNid && cNid === nid) return true;

      const cMob = this.normalizeMobile(c.mobile);
      if (mobile.length >= 10 && cMob && cMob === mobile) return true;

      const cBreg = this.normalizeDigits(c.birthReg);
      if (birthReg.length >= 10 && cBreg && cBreg === birthReg) return true;

      const cName = String(c.applicantName || '').trim().toUpperCase();
      const cDob = String(c.dob || '').trim();
      const cFather = String(c.fatherName || '').trim().toUpperCase();
      if (name && dob && father && cName === name && cDob === dob && cFather === father) return true;

      return false;
    }) || null;
  }

  async nextCustomerId(customers) {
    const counterDoc = await this.fs.getDoc('meta', 'counters');
    let nextSeq = counterDoc?.customerSeq ? Number(counterDoc.customerSeq) : 1;
    if (!customers || customers.length === 0) {
      nextSeq = 1;
    } else {
      for (const c of customers) {
        const m = String(c.id || '').match(/^TTC-(\d+)$/i);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n >= nextSeq) nextSeq = n + 1;
        }
      }
    }
    await this.fs.setDoc('meta', 'counters', { customerSeq: nextSeq + 1, updatedAt: new Date().toISOString() });
    return `TTC-${String(nextSeq).padStart(4, '0')}`;
  }

  async getCustomers(search = '') {
    let list = await this.listCustomersCached();

    if (search) {
      const q = search.toLowerCase().trim();
      const qDigits = q.replace(/\D/g, '');
      list = list.filter(c => {
        const name = (c.applicantName || '').toLowerCase();
        const id = (c.id || '').toLowerCase();
        const mob = String(c.mobile || '');
        const mobDigits = mob.replace(/\D/g, '');
        const nid = String(c.nid || '');
        return (
          name.includes(q) ||
          id.includes(q) ||
          mob.includes(q) ||
          (qDigits.length >= 4 && mobDigits.includes(qDigits)) ||
          nid.includes(q)
        );
      });
    }
    return list;
  }

  async getCustomerByIdOrPhone(queryId) {
    const raw = String(queryId || '').trim();
    if (!raw) return null;

    const all = await this.listCustomersCached();
    const lower = raw.toLowerCase();
    const digits = raw.replace(/\D/g, '');

    return (
      all.find(c => {
        if ((c.id || '').toLowerCase() === lower) return true;
        const cMob = String(c.mobile || '').replace(/\D/g, '');
        if (digits.length >= 6 && cMob && (cMob === digits || cMob.endsWith(digits) || cMob.includes(digits))) {
          return true;
        }
        return (c.nid || '') === raw;
      }) || null
    );
  }

  async createCustomer(data, createdBy = 'admin') {
    const all = await this.listCustomersCached(true);
    const existing = this.findDuplicateCustomer(data, all);
    if (existing) {
      // One person = one customer profile: merge new non-empty fields into existing record
      const merged = {
        ...existing,
        applicantName: data.applicantName || existing.applicantName,
        applicantNameBn: data.applicantNameBn || existing.applicantNameBn,
        fatherName: data.fatherName || existing.fatherName,
        fatherNameBn: data.fatherNameBn || existing.fatherNameBn,
        motherName: data.motherName || existing.motherName,
        motherNameBn: data.motherNameBn || existing.motherNameBn,
        dob: data.dob || existing.dob,
        gender: data.gender || existing.gender,
        religion: data.religion || existing.religion,
        nationality: data.nationality || existing.nationality,
        nid: data.nid || existing.nid,
        birthReg: data.birthReg || existing.birthReg,
        passport: data.passport || existing.passport,
        maritalStatus: data.maritalStatus || existing.maritalStatus,
        spouseName: data.spouseName || existing.spouseName,
        mobile: data.mobile || existing.mobile,
        email: data.email || existing.email,
        quota: data.quota || existing.quota,
        departmentalStatus: data.departmentalStatus || existing.departmentalStatus,
        presentAddress: (data.presentAddress && Object.values(data.presentAddress).some(Boolean)) ? data.presentAddress : existing.presentAddress,
        permanentAddress: (data.permanentAddress && Object.values(data.permanentAddress).some(v => v && v !== true)) ? data.permanentAddress : existing.permanentAddress,
        education: ['jsc', 'ssc', 'hsc', 'graduation', 'masters'].reduce((acc, k) => {
          const oldE = existing.education?.[k];
          const newE = data.education?.[k];
          acc[k] = newE && Object.values(newE).some(Boolean) ? { ...(oldE || {}), ...newE } : (oldE || null);
          return acc;
        }, {}),
        sourceFile: data.sourceFile || existing.sourceFile,
        jobCategory: data.jobCategory || existing.jobCategory || 'All Job Pdf',
        updatedAt: new Date().toISOString()
      };
      await this.fs.setDoc('customers', existing.id, merged);
      cachedCustomers = null;
      return { ...merged, _duplicateMerged: true };
    }

    const id = data.id && /^TTC-\d+$/i.test(data.id) ? data.id.toUpperCase() : await this.nextCustomerId(all);
    const now = new Date().toISOString();
    const customer = {
      id,
      applicantName: (data.applicantName || 'Unknown Applicant').toUpperCase().trim(),
      applicantNameBn: data.applicantNameBn || '',
      fatherName: (data.fatherName || '').toUpperCase().trim(),
      fatherNameBn: data.fatherNameBn || '',
      motherName: (data.motherName || '').toUpperCase().trim(),
      motherNameBn: data.motherNameBn || '',
      dob: data.dob || '',
      gender: data.gender || 'Male',
      religion: data.religion || 'Islam',
      nationality: data.nationality || 'Bangladeshi',
      nid: data.nid || '',
      birthReg: data.birthReg || '',
      passport: data.passport || '',
      maritalStatus: data.maritalStatus || 'Single',
      spouseName: data.spouseName || '',
      mobile: data.mobile || '',
      email: data.email || '',
      quota: data.quota || 'Not Applicable',
      departmentalStatus: data.departmentalStatus || 'Not Applicable',
      jobCategory: data.jobCategory || 'All Job Pdf',
      presentAddress: data.presentAddress || {},
      permanentAddress: data.permanentAddress || { sameAsPresent: true },
      education: data.education || {},
      photoFileName: data.photoFileName || '',
      photoKey: data.photoKey || '',
      photoUrl: data.photoUrl || '',
      signatureFileName: data.signatureFileName || '',
      signatureKey: data.signatureKey || '',
      signatureUrl: data.signatureUrl || '',
      files: Array.isArray(data.files) ? data.files : [],
      sourceFile: data.sourceFile || '',
      extractionMethod: data.extractionMethod || 'manual',
      createdBy,
      createdAt: now,
      updatedAt: now
    };
    await this.fs.setDoc('customers', id, customer);
    cachedCustomers = null;
    return customer;
  }

  async updateCustomer(id, updates) {
    await this.ensureSeeded();
    const existing = await this.getCustomerByIdOrPhone(id);
    if (!existing) return null;
    const merged = {
      ...existing,
      ...updates,
      id: existing.id,
      updatedAt: new Date().toISOString()
    };
    await this.fs.setDoc('customers', existing.id, merged);
    cachedCustomers = null;
    return merged;
  }

  parseCustomerSeq(id) {
    const m = String(id || '').match(/^TTC-(\d+)$/i);
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  }

  async listAllBucketObjects(prefix) {
    if (!this.bucket) return [];
    const objs = [];
    let cursor;
    do {
      const listed = await this.bucket.list({ prefix, cursor, limit: 1000 });
      for (const obj of listed.objects || []) objs.push(obj);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return objs;
  }

  async resequenceCustomers(remainingList, sourceBeforeChange = remainingList) {
    const remainingAsc = [...remainingList].sort((a, b) => {
      const seqDiff = this.parseCustomerSeq(a.id) - this.parseCustomerSeq(b.id);
      if (seqDiff !== 0) return seqDiff;
      return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
    });

    const idMap = {};
    const renamedDocs = [];
    const now = new Date().toISOString();
    const nextDocs = remainingAsc.map((c, idx) => {
      const oldId = c.id;
      const newId = `TTC-${String(idx + 1).padStart(4, '0')}`;
      if (oldId === newId) return c;
      idMap[oldId] = newId;
      const nextDoc = { ...c, id: newId, updatedAt: now };
      renamedDocs.push({ oldId, newId, doc: nextDoc });
      return nextDoc;
    });

    // Migrate R2 folders for renamed customers (`customers/oldId/...` -> `customers/newId/...`)
    if (this.bucket && renamedDocs.length > 0) {
      try {
        const allMediaObjs = await this.listAllBucketObjects('customers/');
        const byPrefix = new Map();
        for (const o of allMediaObjs) {
          const parts = o.key.split('/');
          const folderId = parts[1];
          if (folderId) {
            if (!byPrefix.has(folderId)) byPrefix.set(folderId, []);
            byPrefix.get(folderId).push(o);
          }
        }

        const keysToDelete = [];
        const newKeysWritten = new Set();
        let copyOps = 0;

        for (const { oldId, newId, doc } of renamedDocs) {
          const oldPrefix = `customers/${oldId}/`;
          const newPrefix = `customers/${newId}/`;
          const rewritePath = (val) =>
            typeof val === 'string' ? val.replace(oldPrefix, newPrefix) : val;

          doc.photoKey = rewritePath(doc.photoKey);
          doc.photoUrl = rewritePath(doc.photoUrl);
          doc.signatureKey = rewritePath(doc.signatureKey);
          doc.signatureUrl = rewritePath(doc.signatureUrl);
          if (Array.isArray(doc.files)) {
            doc.files = doc.files.map(f => ({
              ...f,
              r2Key: rewritePath(f.r2Key),
              url: rewritePath(f.url)
            }));
          }

          const folderObjs = byPrefix.get(oldId) || [];
          for (const objMeta of folderObjs) {
            const rel = objMeta.key.slice(oldPrefix.length);
            const destKey = `${newPrefix}${rel}`;
            const obj = await this.bucket.get(objMeta.key);
            if (obj) {
              await this.bucket.put(destKey, obj.body, { httpMetadata: obj.httpMetadata });
              newKeysWritten.add(destKey);
              keysToDelete.push(objMeta.key);
              copyOps += 2;
            }
          }
        }

        const safeDeleteKeys = keysToDelete.filter(k => !newKeysWritten.has(k));
        if (safeDeleteKeys.length > 0) {
          await this.bucket.delete(safeDeleteKeys);
          copyOps += safeDeleteKeys.length;
        }
        if (copyOps > 0) {
          await this.recordR2Write(0, copyOps);
        }
      } catch (e) {
        console.warn('R2 re-serial migration warning:', e);
      }
    }

    // Commit customer renames, obsolete ID deletes, tracker updates, and counter reset in 1 Firestore batch
    const writes = [];
    const finalIdSet = new Set(nextDocs.map(d => d.id));
    const renamedNewIdSet = new Set(renamedDocs.map(r => r.newId));

    for (const doc of nextDocs) {
      if (renamedNewIdSet.has(doc.id)) {
        writes.push({
          update: {
            name: this.fs.buildDocName('customers', doc.id),
            fields: this.fs.buildFields(doc)
          }
        });
      }
    }
    for (const prevDoc of sourceBeforeChange) {
      if (!finalIdSet.has(prevDoc.id)) {
        writes.push({
          delete: this.fs.buildDocName('customers', prevDoc.id)
        });
      }
    }

    if (renamedDocs.length > 0) {
      const apps = await this.listAppsCached(true);
      for (const a of apps) {
        if (idMap[a.customerId]) {
          writes.push({
            update: {
              name: this.fs.buildDocName('applications', a.id),
              fields: this.fs.buildFields({ ...a, customerId: idMap[a.customerId] })
            }
          });
        }
      }
    }

    writes.push({
      update: {
        name: this.fs.buildDocName('meta', 'counters'),
        fields: this.fs.buildFields({ customerSeq: nextDocs.length + 1, updatedAt: now })
      }
    });

    await this.fs.commitWrites(writes);

    const sortedNewestFirst = [...nextDocs].sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );
    cachedCustomers = sortedNewestFirst;
    cachedCustomersAt = Date.now();
    cachedApps = null;

    return {
      renumberedCount: renamedDocs.length,
      idMap,
      customers: sortedNewestFirst
    };
  }

  async deleteCustomer(id) {
    const all = await this.listCustomersCached(true);
    const q = String(id || '').trim().toLowerCase();
    const existing = all.find(c => (c.id || '').toLowerCase() === q);
    if (!existing) return { deleted: false, renumberedCount: 0, idMap: {}, customers: [] };

    // Delete R2 objects belonging to the deleted customer
    if (this.bucket) {
      try {
        const delObjs = await this.listAllBucketObjects(`customers/${existing.id}/`);
        if (delObjs.length) {
          const freedBytes = delObjs.reduce((sum, o) => sum + Number(o.size || 0), 0);
          await this.bucket.delete(delObjs.map(o => o.key));
          await this.recordR2Write(-freedBytes, delObjs.length + 1);
        }
      } catch (e) {
        console.warn('R2 cleanup error:', e);
      }
    }

    const remaining = all.filter(c => c.id !== existing.id);
    const seqRes = await this.resequenceCustomers(remaining, all);

    return {
      deleted: true,
      ...seqRes
    };
  }

  // ==================== R2 FILE STORAGE (PER USER) ====================
  async saveCustomerMedia(customerId, kind, bytes, contentType, originalName = '') {
    if (!this.bucket) {
      throw new Error('Cloudflare R2 STORAGE_BUCKET binding is missing.');
    }
    const customer = await this.getCustomerByIdOrPhone(customerId);
    if (!customer) return null;

    const size = bytes.byteLength || bytes.length || 0;
    await this.assertQuotaForUpload(size);

    const ts = Date.now();
    const ext = contentType === 'image/png' ? 'png' : 'jpg';
    const fileName = `${kind}_${customer.id}_${ts}.${ext}`;
    const r2Key = `customers/${customer.id}/${fileName}`;
    const url = `/media/${r2Key}`;

    await this.bucket.put(r2Key, bytes, {
      httpMetadata: { contentType }
    });
    await this.recordR2Write(size, 1);

    const patch =
      kind === 'photo'
        ? { photoFileName: fileName, photoKey: r2Key, photoUrl: url }
        : { signatureFileName: fileName, signatureKey: r2Key, signatureUrl: url };

    const updated = await this.updateCustomer(customer.id, patch);
    return { customer: updated, fileName, r2Key, url };
  }

  async saveCustomerFile(customerId, fileName, bytes, contentType = 'application/octet-stream') {
    if (!this.bucket) {
      throw new Error('Cloudflare R2 STORAGE_BUCKET binding is missing.');
    }
    const customer = await this.getCustomerByIdOrPhone(customerId);
    if (!customer) return null;

    const size = bytes.byteLength || bytes.length || 0;
    await this.assertQuotaForUpload(size);

    const cleanName = String(fileName || `document_${Date.now()}.bin`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileId = `f_${Date.now()}_${randomHex(3)}`;
    const r2Key = `customers/${customer.id}/files/${Date.now()}_${cleanName}`;
    const url = `/media/${r2Key}`;

    await this.bucket.put(r2Key, bytes, {
      httpMetadata: { contentType }
    });
    await this.recordR2Write(size, 1);

    const entry = {
      id: fileId,
      fileName: cleanName,
      r2Key,
      url,
      contentType,
      size,
      uploadedAt: new Date().toISOString()
    };

    const files = Array.isArray(customer.files) ? [...customer.files, entry] : [entry];
    const updated = await this.updateCustomer(customer.id, { files });
    return { customer: updated, file: entry };
  }

  async deleteCustomerFile(customerId, fileId) {
    const customer = await this.getCustomerByIdOrPhone(customerId);
    if (!customer) return null;
    const files = Array.isArray(customer.files) ? customer.files : [];
    const target = files.find(f => f.id === fileId);
    if (!target) return null;

    if (this.bucket && target.r2Key) {
      await this.bucket.delete(target.r2Key);
      await this.recordR2Write(-Number(target.size || 0), 1);
    }
    const remaining = files.filter(f => f.id !== fileId);
    return this.updateCustomer(customer.id, { files: remaining });
  }

  // ==================== API KEYS ====================
  async getApiKeys() {
    const keys = await this.listApiKeysCached();
    return keys
      .filter(k => k.active !== false)
      .map(k => ({
        id: k.id,
        label: k.label,
        keyPrefix: k.keyPrefix,
        fullKey: k.rawKey || `${k.keyPrefix}...`,
        userName: k.userName,
        userRole: k.userRole || 'admin',
        status: k.active !== false ? 'active' : 'revoked',
        active: k.active,
        lastUsedAt: k.lastUsedAt,
        createdAt: k.createdAt
      }));
  }

  async regenerateWebsiteApiKey(label = 'Website API Key', user = {}) {
    await this.ensureSeeded();
    const gen = await generateApiKey();
    const doc = {
      id: 'key-website-main',
      label: label || 'Website API Key',
      keyPrefix: gen.keyPrefix,
      keyHash: gen.keyHash,
      rawKey: gen.fullKey,
      userId: user.id || 'usr-admin-01',
      userName: user.username || 'admin',
      userRole: user.role || 'admin',
      active: true,
      lastUsedAt: null,
      createdAt: new Date().toISOString()
    };
    await this.fs.setDoc('api_keys', 'key-website-main', doc);
    cachedApiKeys = [doc];
    cachedApiKeysAt = Date.now();
    return {
      id: doc.id,
      label: doc.label,
      keyPrefix: doc.keyPrefix,
      fullKey: gen.fullKey,
      createdAt: doc.createdAt
    };
  }

  async revokeApiKey(id) {
    cachedApiKeys = null;
    return this.fs.deleteDoc('api_keys', id);
  }

  async validateApiKey(rawKey) {
    if (!rawKey) return null;
    const hash = await sha256Hex(rawKey.trim());
    const keys = await this.listApiKeysCached();
    const match = keys.find(k => k.active !== false && k.keyHash === hash);
    if (!match) return null;
    return match;
  }

  // ==================== EXTENSION APPLICATIONS TRACKER ====================
  async trackApplication(payload) {
    const now = new Date();
    const custId = String(payload.customerId || 'UNKNOWN').trim();
    const portalUrl = String(payload.portalUrl || '').trim();
    const apps = await this.listAppsCached();

    const thirtyMinsAgo = now.getTime() - 30 * 60 * 1000;
    const recentSame = apps.find(a => {
      if (a.customerId !== custId || a.portalUrl !== portalUrl) return false;
      const t = new Date(a.appliedAt || 0).getTime();
      return t >= thirtyMinsAgo;
    });

    if (recentSame) {
      const updated = {
        ...recentSame,
        actionType: payload.actionType === 'submitted' ? 'submitted' : recentSame.actionType,
        filledCount: Math.max(Number(recentSame.filledCount || 0), Number(payload.filledCount || 0)),
        jobTitle: payload.jobTitle || recentSame.jobTitle,
        organization: payload.organization || recentSame.organization,
        appliedAt: now.toISOString()
      };
      await this.fs.setDoc('applications', recentSame.id, updated);
      cachedApps = null;
      return updated;
    }

    const id = `app_${Date.now()}_${randomHex(3)}`;
    const record = {
      id,
      customerId: custId,
      applicantName: payload.applicantName || custId,
      mobile: payload.mobile || '',
      portalUrl,
      portalHost: payload.portalHost || '',
      jobTitle: payload.jobTitle || 'Online Application',
      organization: payload.organization || payload.portalHost || '',
      filledCount: Number(payload.filledCount || 0),
      actionType: payload.actionType === 'submitted' ? 'submitted' : 'autofill',
      appliedAt: now.toISOString()
    };
    await this.fs.setDoc('applications', id, record);
    cachedApps = null;
    return record;
  }

  async getDashboardStats() {
    const [customers, apps, keys, usage] = await Promise.all([
      this.listCustomersCached(),
      this.listAppsCached(),
      this.listApiKeysCached(),
      this.getUsage(false)
    ]);

    const todayStr = new Date().toISOString().slice(0, 10);
    const todayCustomers = customers.filter(c => (c.createdAt || '').startsWith(todayStr)).length;
    const todayApplies = apps.filter(a => (a.appliedAt || '').startsWith(todayStr)).length;
    const photoReadyCount = customers.filter(c => Boolean(c.photoUrl)).length;
    const signatureReadyCount = customers.filter(c => Boolean(c.signatureUrl)).length;
    const activeKeys = keys.filter(k => k.active !== false).length;

    return {
      totalCustomers: customers.length,
      todayCustomers,
      totalApplies: apps.length,
      todayApplies,
      activeKeys,
      photoReadyCount,
      signatureReadyCount,
      usage,
      recentCustomers: customers.slice(0, 5),
      recentApplies: apps
    };
  }
}
