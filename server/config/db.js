const fs = require('fs');
const path = require('path');
const Security = require('./security');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

class Database {
  constructor() {
    this.data = {
      users: [],
      customers: [],
      applications: [],
      apiKeys: [],
      auditLogs: [],
      meta: {
        lastCustomerSeq: 0
      }
    };
    this.init();
  }

  init() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (fs.existsSync(DB_FILE)) {
      try {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        this.data = JSON.parse(raw);
        console.log('Database loaded successfully.');
      } catch (e) {
        console.error('Error reading db.json, creating fresh database:', e.message);
        this.save();
      }
    } else {
      this.seedDefaultUsers();
      this.save();
    }

    // Ensure admin user exists
    if (!this.data.users || this.data.users.length === 0) {
      this.seedDefaultUsers();
      this.save();
    }

    // Enforce single Website API Key policy
    if (!this.data.apiKeys || this.data.apiKeys.length === 0) {
      const adminUser = this.data.users.find(u => u.role === 'admin') || this.data.users[0];
      this.createApiKey('Website API Key', adminUser);
    } else if (this.data.apiKeys.length > 1) {
      const preferred = this.data.apiKeys.find(k => k.status === 'active') || this.data.apiKeys[0];
      preferred.label = 'Website API Key';
      this.data.apiKeys = [preferred];
      this.save();
    }

    // Migrate legacy CUST-XXXX IDs or heal any deleted-ID gaps to sequential TTC-0001 format
    const needsTtcMigration = (this.data.customers || []).some(c => !String(c.id || '').startsWith('TTC-'));
    if (needsTtcMigration) {
      const ordered = [...this.data.customers].reverse();
      let seq = 0;
      for (const cust of ordered) {
        seq += 1;
        cust.id = `TTC-${String(seq).padStart(4, '0')}`;
      }
      this.data.meta = { ...(this.data.meta || {}), lastCustomerSeq: seq };
      this.save();
      console.log(`Migrated ${seq} existing customer ID(s) to TTC-0001 format.`);
    } else if (this.resequenceCustomers(false).renumberedCount > 0) {
      console.log('Auto-resequenced existing customer IDs to contiguous TTC-0001 format.');
    }
  }

  seedDefaultUsers() {
    const adminPass = bcryptSync('Admin@123456');
    const empPass = bcryptSync('Employee@123456');

    this.data.users = [
      {
        id: 'usr_admin_001',
        username: 'admin',
        fullName: 'System Administrator',
        email: 'admin@govfill.local',
        passwordHash: adminPass,
        role: 'admin',
        createdAt: new Date().toISOString()
      },
      {
        id: 'usr_emp_001',
        username: 'employee',
        fullName: 'Office Staff Operator',
        email: 'operator@govfill.local',
        passwordHash: empPass,
        role: 'employee',
        createdAt: new Date().toISOString()
      }
    ];

    console.log('Seeded default Admin (admin / Admin@123456) and Employee (employee / Employee@123456).');
  }

  save() {
    try {
      const tempFile = DB_FILE + '.tmp';
      fs.writeFileSync(tempFile, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tempFile, DB_FILE);
    } catch (err) {
      console.error('Error saving database:', err);
    }
  }

  // --- CUSTOMER ID GENERATOR ---
  generateCustomerId() {
    if (!this.data.meta) this.data.meta = { lastCustomerSeq: 0 };
    this.data.meta.lastCustomerSeq += 1;
    const seqStr = String(this.data.meta.lastCustomerSeq).padStart(4, '0');
    return `TTC-${seqStr}`;
  }

  // --- CUSTOMERS ---
  normalizeDigits(str) {
    return String(str || '').replace(/\D/g, '').replace(/^880/, '0');
  }

  getCustomers(filter = {}) {
    return this.data.customers
      .filter(c => {
        if (filter.search) {
          const q = filter.search.trim().toLowerCase();
          const qDigits = this.normalizeDigits(q);
          const mobile = Security.decrypt(c.mobile) || c.mobile || '';
          const mobileDigits = this.normalizeDigits(mobile);
          const nid = Security.decrypt(c.nid) || c.nid || '';

          const matchesId = (c.id || '').toLowerCase().includes(q);
          const matchesName = (c.applicantName || '').toLowerCase().includes(q) || (c.applicantNameBn || '').toLowerCase().includes(q);
          const matchesMobile = mobile.toLowerCase().includes(q) || (qDigits.length >= 4 && mobileDigits.includes(qDigits));
          const matchesNid = nid.includes(q) || (qDigits.length >= 4 && nid.includes(qDigits));
          return matchesId || matchesName || matchesMobile || matchesNid;
        }
        return true;
      })
      .map(c => this.sanitizeCustomerForView(c));
  }

  getCustomerById(id) {
    const query = String(id || '').trim();
    if (!query) return null;
    const qLower = query.toLowerCase();
    const qDigits = this.normalizeDigits(query);

    const customer = this.data.customers.find(c => {
      if ((c.id || '').toLowerCase() === qLower) return true;
      if (qDigits.length >= 6) {
        const mobDigits = this.normalizeDigits(Security.decrypt(c.mobile) || c.mobile || '');
        if (mobDigits === qDigits || mobDigits.endsWith(qDigits)) return true;
        const nidDigits = Security.decrypt(c.nid) || c.nid || '';
        if (nidDigits === qDigits) return true;
      }
      return false;
    });

    if (!customer) return null;
    return this.sanitizeCustomerForView(customer);
  }

  getCustomerRawById(id) {
    return this.data.customers.find(c => c.id === id) || null;
  }

  findDuplicateCustomer(payload) {
    const nid = this.normalizeDigits(payload.nid);
    const mobileRaw = this.normalizeDigits(payload.mobile);
    const mobile = mobileRaw.length >= 11 ? mobileRaw.slice(-11) : mobileRaw;
    const birthReg = this.normalizeDigits(payload.birthReg);
    const name = String(payload.applicantName || '').toUpperCase().trim();
    const dob = String(payload.dob || '').trim();
    const father = String(payload.fatherName || '').toUpperCase().trim();

    return (this.data.customers || []).find(c => {
      const cNid = this.normalizeDigits(Security.decrypt(c.nid) || c.nid || '');
      if (nid.length >= 8 && cNid && cNid === nid) return true;

      const cMobRaw = this.normalizeDigits(Security.decrypt(c.mobile) || c.mobile || '');
      const cMob = cMobRaw.length >= 11 ? cMobRaw.slice(-11) : cMobRaw;
      if (mobile.length >= 10 && cMob && cMob === mobile) return true;

      const cBreg = this.normalizeDigits(c.birthReg || '');
      if (birthReg.length >= 10 && cBreg && cBreg === birthReg) return true;

      const cName = String(c.applicantName || '').toUpperCase().trim();
      const cDob = String(c.dob || '').trim();
      const cFather = String(c.fatherName || '').toUpperCase().trim();
      if (name && dob && father && cName === name && cDob === dob && cFather === father) return true;

      return false;
    }) || null;
  }

  createCustomer(payload, createdByUserId) {
    const existing = this.findDuplicateCustomer(payload);
    if (existing) {
      const merged = this.updateCustomer(existing.id, {
        applicantName: payload.applicantName || existing.applicantName,
        applicantNameBn: payload.applicantNameBn || existing.applicantNameBn,
        fatherName: payload.fatherName || existing.fatherName,
        fatherNameBn: payload.fatherNameBn || existing.fatherNameBn,
        motherName: payload.motherName || existing.motherName,
        motherNameBn: payload.motherNameBn || existing.motherNameBn,
        dob: payload.dob || existing.dob,
        gender: payload.gender || existing.gender,
        religion: payload.religion || existing.religion,
        nationality: payload.nationality || existing.nationality,
        nid: payload.nid || undefined,
        birthReg: payload.birthReg || existing.birthReg,
        passport: payload.passport || existing.passport,
        maritalStatus: payload.maritalStatus || existing.maritalStatus,
        spouseName: payload.spouseName || undefined,
        mobile: payload.mobile || undefined,
        email: payload.email || undefined,
        quota: payload.quota || existing.quota,
        departmentalStatus: payload.departmentalStatus || existing.departmentalStatus,
        presentAddress: (payload.presentAddress && Object.values(payload.presentAddress).some(Boolean)) ? payload.presentAddress : existing.presentAddress,
        permanentAddress: (payload.permanentAddress && Object.values(payload.permanentAddress).some(v => v && v !== true)) ? payload.permanentAddress : existing.permanentAddress,
        education: ['jsc', 'ssc', 'hsc', 'graduation', 'masters'].reduce((acc, k) => {
          const oldE = existing.education?.[k];
          const newE = payload.education?.[k];
          acc[k] = newE && Object.values(newE).some(Boolean) ? { ...(oldE || {}), ...newE } : (oldE || null);
          return acc;
        }, {}),
        sourceFile: payload.sourceFile || existing.sourceFile,
        jobCategory: payload.jobCategory || existing.jobCategory || 'All Job Pdf'
      });
      return { ...merged, _duplicateMerged: true };
    }

    const id = this.generateCustomerId();
    const now = new Date().toISOString();

    // Encrypt sensitive fields
    const encryptedNid = Security.encrypt(payload.nid || '');
    const encryptedMobile = Security.encrypt(payload.mobile || '');
    const encryptedEmail = Security.encrypt(payload.email || '');
    const encryptedSpouse = Security.encrypt(payload.spouseName || '');

    const newCustomer = {
      id,
      applicantName: (payload.applicantName || '').toUpperCase().trim(),
      applicantNameBn: (payload.applicantNameBn || '').trim(),
      fatherName: (payload.fatherName || '').toUpperCase().trim(),
      fatherNameBn: (payload.fatherNameBn || '').trim(),
      motherName: (payload.motherName || '').toUpperCase().trim(),
      motherNameBn: (payload.motherNameBn || '').trim(),
      dob: payload.dob || '', // YYYY-MM-DD
      gender: payload.gender || 'Male',
      religion: payload.religion || 'Islam',
      nationality: payload.nationality || 'Bangladeshi',
      
      // Encrypted storage
      nid: encryptedNid,
      birthReg: payload.birthReg || '',
      passport: payload.passport || '',
      maritalStatus: payload.maritalStatus || 'Single',
      spouseName: encryptedSpouse,
      mobile: encryptedMobile,
      email: encryptedEmail,
      
      quota: payload.quota || 'Not Applicable',
      departmentalStatus: payload.departmentalStatus || 'Not Applicable',
      jobCategory: payload.jobCategory || 'All Job Pdf',
      
      presentAddress: payload.presentAddress || {
        careOf: '',
        village: '',
        district: '',
        districtCode: '',
        upazila: '',
        upazilaCode: '',
        postOffice: '',
        postCode: ''
      },
      permanentAddress: payload.permanentAddress || {
        sameAsPresent: true,
        careOf: '',
        village: '',
        district: '',
        districtCode: '',
        upazila: '',
        upazilaCode: '',
        postOffice: '',
        postCode: ''
      },

      education: payload.education || {
        jsc: null,
        ssc: null,
        hsc: null,
        graduation: null,
        masters: null
      },

      photoUrl: payload.photoUrl || '',
      signatureUrl: payload.signatureUrl || '',
      
      notes: payload.notes || '',
      sourceFile: payload.sourceFile || '',
      createdBy: createdByUserId || 'system',
      createdAt: now,
      updatedAt: now
    };

    this.data.customers.unshift(newCustomer);
    this.save();
    return this.sanitizeCustomerForView(newCustomer);
  }

  updateCustomer(id, updates) {
    const index = this.data.customers.findIndex(c => c.id === id);
    if (index === -1) return null;

    const existing = this.data.customers[index];
    
    // If updating sensitive fields, encrypt them
    if (updates.nid !== undefined) updates.nid = Security.encrypt(updates.nid);
    if (updates.mobile !== undefined) updates.mobile = Security.encrypt(updates.mobile);
    if (updates.email !== undefined) updates.email = Security.encrypt(updates.email);
    if (updates.spouseName !== undefined) updates.spouseName = Security.encrypt(updates.spouseName);

    this.data.customers[index] = {
      ...existing,
      ...updates,
      id: existing.id, // cannot overwrite ID
      updatedAt: new Date().toISOString()
    };

    this.save();
    return this.sanitizeCustomerForView(this.data.customers[index]);
  }

  parseCustomerSeq(id) {
    const m = String(id || '').match(/^TTC-(\d+)$/i);
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  }

  resequenceCustomers(saveWhenEmpty = true, remaining = this.data.customers) {
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    const remainingAsc = [...remaining].sort((a, b) => {
      const seqDiff = this.parseCustomerSeq(a.id) - this.parseCustomerSeq(b.id);
      if (seqDiff !== 0) return seqDiff;
      return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
    });

    const idMap = {};
    const now = new Date().toISOString();
    remainingAsc.forEach((cust, idx) => {
      const oldId = cust.id;
      const newId = `TTC-${String(idx + 1).padStart(4, '0')}`;
      if (oldId === newId) return;

      idMap[oldId] = newId;
      const oldFilesDir = path.join(uploadsDir, 'files', oldId);
      const newFilesDir = path.join(uploadsDir, 'files', newId);
      if (fs.existsSync(oldFilesDir)) {
        if (!fs.existsSync(newFilesDir)) {
          fs.renameSync(oldFilesDir, newFilesDir);
        } else {
          for (const fName of fs.readdirSync(oldFilesDir)) {
            fs.renameSync(path.join(oldFilesDir, fName), path.join(newFilesDir, fName));
          }
          fs.rmSync(oldFilesDir, { recursive: true, force: true });
        }
      }
      if (Array.isArray(cust.files)) {
        cust.files = cust.files.map(f => ({
          ...f,
          url: typeof f.url === 'string' ? f.url.replace(`/uploads/files/${oldId}/`, `/uploads/files/${newId}/`) : f.url
        }));
      }
      cust.id = newId;
      cust.updatedAt = now;
    });

    const renumberedCount = Object.keys(idMap).length;
    if (renumberedCount > 0) {
      if (Array.isArray(this.data.applications)) {
        this.data.applications.forEach(a => {
          if (idMap[a.customerId]) a.customerId = idMap[a.customerId];
        });
      }
      if (Array.isArray(this.data.auditLogs)) {
        this.data.auditLogs.forEach(l => {
          if (idMap[l.customerId]) l.customerId = idMap[l.customerId];
        });
      }
    }

    const seqChanged = (this.data.meta?.lastCustomerSeq || 0) !== remainingAsc.length;
    if (saveWhenEmpty || renumberedCount > 0 || seqChanged) {
      this.data.customers = remaining;
      this.data.meta = { ...(this.data.meta || {}), lastCustomerSeq: remainingAsc.length };
      this.save();
    }

    return { renumberedCount, idMap };
  }

  deleteCustomer(id) {
    const q = String(id || '').trim().toLowerCase();
    const target = this.data.customers.find(c => String(c.id || '').toLowerCase() === q);
    if (!target) {
      return { deleted: false, renumberedCount: 0, idMap: {}, customers: [] };
    }

    const uploadsDir = path.join(__dirname, '..', 'uploads');
    const removeLocalUploadUrl = (u) => {
      if (!u || !u.startsWith('/uploads/')) return;
      const abs = path.join(uploadsDir, u.replace('/uploads/', ''));
      if (fs.existsSync(abs)) {
        try { fs.unlinkSync(abs); } catch {}
      }
    };
    removeLocalUploadUrl(target.photoUrl);
    removeLocalUploadUrl(target.signatureUrl);
    const targetFilesDir = path.join(uploadsDir, 'files', target.id);
    if (fs.existsSync(targetFilesDir)) {
      try { fs.rmSync(targetFilesDir, { recursive: true, force: true }); } catch {}
    }

    const remaining = this.data.customers.filter(c => c.id !== target.id);
    const { renumberedCount, idMap } = this.resequenceCustomers(true, remaining);

    return {
      deleted: true,
      renumberedCount,
      idMap,
      customers: this.getCustomers()
    };
  }

  sanitizeCustomerForView(c) {
    return {
      ...c,
      nid: Security.decrypt(c.nid),
      mobile: Security.decrypt(c.mobile),
      email: Security.decrypt(c.email),
      spouseName: Security.decrypt(c.spouseName)
    };
  }

  // --- DEVELOPER API KEYS (SINGLE WEBSITE KEY) ---
  getApiKeys() {
    return this.data.apiKeys.slice(0, 1).map(k => ({
      id: k.id,
      label: k.label || 'Website API Key',
      keyPrefix: k.keyPrefix,
      fullKey: k.encryptedKey ? Security.decrypt(k.encryptedKey) : '',
      status: k.status,
      userName: k.userName,
      userRole: k.userRole,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt
    }));
  }

  createApiKey(label, user) {
    const keyData = Security.generateApiKey();
    const id = 'key_' + Date.now();

    const record = {
      id,
      label: label || 'Website API Key',
      keyPrefix: keyData.keyPrefix,
      keyHash: keyData.keyHash,
      encryptedKey: keyData.encryptedKey,
      userId: user.id,
      userName: user.username,
      userRole: user.role,
      status: 'active',
      lastUsedAt: null,
      createdAt: new Date().toISOString()
    };

    // Keep strictly ONE Website API Key
    this.data.apiKeys = [record];
    this.save();

    return {
      id,
      label: record.label,
      fullKey: keyData.fullKey,
      keyPrefix: record.keyPrefix,
      status: record.status,
      createdAt: record.createdAt
    };
  }

  revokeApiKey(id) {
    const key = this.data.apiKeys.find(k => k.id === id);
    if (key) {
      key.status = 'revoked';
      this.save();
      return true;
    }
    return false;
  }

  validateApiKey(apiKeyString) {
    if (!apiKeyString || typeof apiKeyString !== 'string') return null;
    const hash = Security.hashApiKey(apiKeyString);
    const keyRecord = this.data.apiKeys.find(k => k.keyHash === hash && k.status === 'active');
    
    if (keyRecord) {
      keyRecord.lastUsedAt = new Date().toISOString();
      this.save();
      return keyRecord;
    }
    return null;
  }

  // --- USERS ---
  findUserByUsername(username) {
    return this.data.users.find(u => u.username.toLowerCase() === (username || '').trim().toLowerCase());
  }

  findUserByEmail(email) {
    if (!email) return null;
    const norm = email.trim().toLowerCase();
    return this.data.users.find(u => (u.email || '').trim().toLowerCase() === norm);
  }

  findUserByLogin(identifier) {
    if (!identifier) return null;
    const norm = identifier.trim().toLowerCase();
    return this.data.users.find(
      u => (u.email || '').trim().toLowerCase() === norm || (u.username || '').trim().toLowerCase() === norm
    );
  }

  findUserById(id) {
    return this.data.users.find(u => u.id === id);
  }

  getAllUsers() {
    return this.data.users.map(u => ({
      id: u.id,
      username: u.username,
      fullName: u.fullName,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt
    }));
  }

  createUser(payload) {
    const id = 'usr_' + Date.now();
    const newUser = {
      id,
      username: payload.username.trim(),
      fullName: payload.fullName || payload.username,
      email: payload.email || '',
      passwordHash: payload.passwordHash,
      role: payload.role === 'admin' ? 'admin' : 'employee',
      createdAt: new Date().toISOString()
    };
    this.data.users.push(newUser);
    this.save();
    return newUser;
  }

  updateUser(id, updates) {
    const idx = this.data.users.findIndex(u => u.id === id);
    if (idx === -1) return null;

    const existing = this.data.users[idx];
    this.data.users[idx] = {
      ...existing,
      username: updates.username ? updates.username.trim() : existing.username,
      fullName: updates.fullName !== undefined ? updates.fullName.trim() : existing.fullName,
      email: updates.email !== undefined ? updates.email.trim() : existing.email,
      role: updates.role ? (updates.role === 'admin' ? 'admin' : 'employee') : existing.role,
      passwordHash: updates.passwordHash || existing.passwordHash,
      updatedAt: new Date().toISOString()
    };
    this.save();
    return this.data.users[idx];
  }

  deleteUser(id) {
    const prev = this.data.users.length;
    this.data.users = this.data.users.filter(u => u.id !== id);
    if (this.data.users.length !== prev) {
      this.save();
      return true;
    }
    return false;
  }

  // --- APPLICATIONS TRACKER (FROM EXTENSION) ---
  trackApplication(payload) {
    if (!this.data.applications) this.data.applications = [];
    const now = new Date();
    const nowIso = now.toISOString();
    const custId = (payload.customerId || '').trim();
    const url = (payload.portalUrl || payload.url || '').trim();

    // Merge if same customer & URL within 30 minutes (e.g. autofill -> submit)
    const existingIdx = this.data.applications.findIndex(a => {
      if (a.customerId !== custId || a.portalUrl !== url) return false;
      const diffMs = now.getTime() - new Date(a.appliedAt).getTime();
      return diffMs < 30 * 60 * 1000;
    });

    if (existingIdx !== -1) {
      const ex = this.data.applications[existingIdx];
      ex.actionType = payload.actionType === 'submitted' ? 'submitted' : ex.actionType;
      ex.filledCount = Math.max(ex.filledCount || 0, payload.filledCount || 0);
      if (payload.jobTitle && payload.jobTitle !== 'Online Application') ex.jobTitle = payload.jobTitle;
      if (payload.organization) ex.organization = payload.organization;
      ex.updatedAt = nowIso;
      this.save();
      return ex;
    }

    const record = {
      id: 'app_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      customerId: custId,
      applicantName: payload.applicantName || 'Unknown',
      mobile: payload.mobile || '',
      jobTitle: payload.jobTitle || 'Online Application',
      organization: payload.organization || 'Govt Portal',
      portalUrl: url,
      filledCount: payload.filledCount || 0,
      actionType: payload.actionType === 'submitted' ? 'submitted' : 'autofill',
      operator: payload.operator || 'extension',
      appliedAt: nowIso,
      updatedAt: nowIso
    };

    this.data.applications.unshift(record);
    if (this.data.applications.length > 2000) {
      this.data.applications = this.data.applications.slice(0, 2000);
    }
    this.save();
    return record;
  }

  getDashboardStats() {
    const todayStr = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local timezone
    const isToday = (isoStr) => {
      if (!isoStr) return false;
      return new Date(isoStr).toLocaleDateString('en-CA') === todayStr;
    };

    const allCustomers = this.data.customers || [];
    const allApps = this.data.applications || [];
    const activeKeys = (this.data.apiKeys || []).filter(k => k.status === 'active').length;

    const todayCustomers = allCustomers.filter(c => isToday(c.createdAt)).length;
    const todayApplies = allApps.filter(a => isToday(a.appliedAt)).length;
    const photoReadyCount = allCustomers.filter(c => Boolean(c.photoUrl)).length;
    const signatureReadyCount = allCustomers.filter(c => Boolean(c.signatureUrl)).length;

    const getDirSize = (dir) => {
      if (!fs.existsSync(dir)) return 0;
      let bytes = 0;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        bytes += ent.isDirectory() ? getDirSize(p) : fs.statSync(p).size;
      }
      return bytes;
    };
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    const usage = {
      month: new Date().toISOString().slice(0, 7),
      r2BytesUsed: getDirSize(uploadsDir),
      maxStorageBytes: 5 * 1024 * 1024 * 1024,
      r2OpsCount: 0,
      maxMonthlyOps: 500000
    };

    return {
      totalCustomers: allCustomers.length,
      todayCustomers,
      totalApplies: allApps.length,
      todayApplies,
      activeKeys,
      photoReadyCount,
      signatureReadyCount,
      usage,
      recentCustomers: allCustomers.slice(0, 6).map(c => this.sanitizeCustomerForView(c)),
      recentApplies: allApps.slice(0, 300)
    };
  }

  logAudit(action, userId, customerId = null, ip = '') {
    if (!this.data.auditLogs) this.data.auditLogs = [];
    this.data.auditLogs.unshift({
      id: 'log_' + Date.now(),
      action,
      userId,
      customerId,
      ip,
      timestamp: new Date().toISOString()
    });
    // keep last 500 logs
    if (this.data.auditLogs.length > 500) {
      this.data.auditLogs = this.data.auditLogs.slice(0, 500);
    }
    this.save();
  }
}

function bcryptSync(password) {
  const bcrypt = require('bcryptjs');
  return bcrypt.hashSync(password, 10);
}

const db = new Database();
module.exports = db;
