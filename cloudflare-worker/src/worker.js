/**
 * Toya Telecom & Computer — Cloudflare Worker Entry Point (`job-toya` / `job.toyatelecom.online`)
 * Serves Web Dashboard via Workers Assets + API via Firebase Firestore + Media/Files via Cloudflare R2 (`storage`)
 */
import { CloudStore } from './store.js';
import { signJwt, verifyJwt } from './crypto.js';
import { ImageValidator } from './imageValidator.js';
import { extractProfileFromPdf } from './pdfExtractor.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Gemini-Key'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function getJwtSecret(env) {
  return env.JWT_SECRET || 'govfill_jwt_super_secret_key_2026';
}

async function requireAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth) return null;
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : auth.trim();
  return verifyJwt(token, getJwtSecret(env));
}

async function requireApiKey(request, store, url) {
  let key = request.headers.get('X-API-Key') || '';
  if (!key) {
    const auth = request.headers.get('Authorization') || '';
    if (auth.startsWith('Bearer ')) {
      const candidate = auth.slice(7).trim();
      if (candidate.startsWith('govfill_live_')) key = candidate;
    }
  }
  if (!key) key = url.searchParams.get('apiKey') || '';
  if (!key) return null;
  return store.validateApiKey(key);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const store = new CloudStore(env);

    try {
      // ==================== 1. HEALTH CHECK ====================
      if (path === '/api/health' && method === 'GET') {
        const limits = store.getLimits();
        return json({
          status: 'OK',
          runtime: 'Cloudflare Worker',
          workerName: 'job-toya',
          customDomain: env.CUSTOM_DOMAIN || 'job.toyatelecom.online',
          r2Configured: Boolean(env.STORAGE_BUCKET),
          firestoreConfigured: store.fs.isConfigured(),
          firebaseProjectId: env.FIREBASE_PROJECT_ID || '',
          limits,
          time: new Date().toISOString()
        });
      }

      // ==================== 2. R2 MEDIA & FILE STREAMING ====================
      if ((path.startsWith('/media/') || path.startsWith('/uploads/')) && method === 'GET') {
        if (!env.STORAGE_BUCKET) return json({ success: false, message: 'R2 storage not configured.' }, 500);
        await store.checkR2ReadQuota();
        const key = decodeURIComponent(path.replace(/^\/(media|uploads)\//, ''));
        const obj = await env.STORAGE_BUCKET.get(key);
        store.recordR2Read(ctx);
        if (!obj) return new Response('File not found in R2 storage', { status: 404, headers: CORS_HEADERS });
        const headers = new Headers(CORS_HEADERS);
        obj.writeHttpMetadata(headers);
        headers.set('Cache-Control', 'public, max-age=86400');
        return new Response(obj.body, { status: 200, headers });
      }

      // ==================== 3. ADMIN AUTH ROUTES ====================
      if (path === '/api/auth/login' && method === 'POST') {
        const body = await readJson(request);
        const loginId = (body.identifier || body.email || body.username || '').trim();
        const password = body.password || '';
        if (!loginId || !password) {
          return json({ success: false, message: 'Gmail / Username and password are required.' }, 400);
        }
        const user = await store.findUserByLogin(loginId);
        if (!user || !(await store.verifyUserPassword(password, user.passwordHash))) {
          return json({ success: false, message: 'Invalid Gmail/Username or password.' }, 401);
        }
        const token = await signJwt(
          { id: user.id, username: user.username, role: user.role, fullName: user.fullName },
          getJwtSecret(env)
        );
        return json({
          success: true,
          token,
          user: { id: user.id, username: user.username, fullName: user.fullName, email: user.email, role: user.role }
        });
      }

      if (path === '/api/auth/me' && method === 'GET') {
        const decoded = await requireAuth(request, env);
        if (!decoded) return json({ success: false, message: 'Unauthorized' }, 401);
        const user = await store.findUserById(decoded.id);
        if (!user) return json({ success: false, message: 'User not found' }, 404);
        return json({
          success: true,
          user: { id: user.id, username: user.username, fullName: user.fullName, email: user.email, role: user.role }
        });
      }

      if (path === '/api/auth/users' && method === 'GET') {
        const decoded = await requireAuth(request, env);
        if (!decoded) return json({ success: false, message: 'Unauthorized' }, 401);
        const users = await store.getAllUsers();
        return json({ success: true, users });
      }

      if (path === '/api/auth/users' && method === 'POST') {
        const decoded = await requireAuth(request, env);
        if (!decoded || decoded.role !== 'admin') return json({ success: false, message: 'Admin required' }, 403);
        const body = await readJson(request);
        const email = (body.email || '').trim().toLowerCase();
        const username = (body.username || (email ? email.split('@')[0] : '')).trim();
        if (!username || !body.password) return json({ success: false, message: 'Username/Gmail and password required.' }, 400);
        const user = await store.createUser({ username, fullName: body.fullName, email, password: body.password, role: 'admin' });
        return json({ success: true, message: 'Admin user saved to Firestore.', user });
      }

      if (path.startsWith('/api/auth/users/') && method === 'PUT') {
        const decoded = await requireAuth(request, env);
        if (!decoded || decoded.role !== 'admin') return json({ success: false, message: 'Admin required' }, 403);
        const targetId = decodeURIComponent(path.split('/').pop());
        const body = await readJson(request);
        const updated = await store.updateUser(targetId, body);
        if (!updated) return json({ success: false, message: 'User not found.' }, 404);
        const res = { success: true, message: 'Account updated in Firestore.', user: updated };
        if (targetId === decoded.id) {
          res.token = await signJwt({ id: updated.id, username: updated.username, role: updated.role, fullName: updated.fullName }, getJwtSecret(env));
        }
        return json(res);
      }

      if (path.startsWith('/api/auth/users/') && method === 'DELETE') {
        const decoded = await requireAuth(request, env);
        if (!decoded || decoded.role !== 'admin') return json({ success: false, message: 'Admin required' }, 403);
        const targetId = decodeURIComponent(path.split('/').pop());
        if (targetId === decoded.id) return json({ success: false, message: 'Cannot delete logged-in Admin.' }, 400);
        await store.deleteUser(targetId);
        return json({ success: true, message: 'User deleted from Firestore.' });
      }

      // ==================== 4. DASHBOARD STATS ====================
      if (path === '/api/dashboard/stats' && method === 'GET') {
        const decoded = await requireAuth(request, env);
        if (!decoded) return json({ success: false, message: 'Unauthorized' }, 401);
        const stats = await store.getDashboardStats();
        return json({ success: true, stats });
      }

      // ==================== 5. CUSTOMERS & PER-USER R2 FILES ====================
      if (path === '/api/customers' && method === 'GET') {
        const decoded = await requireAuth(request, env);
        if (!decoded) return json({ success: false, message: 'Unauthorized' }, 401);
        const search = url.searchParams.get('search') || '';
        const customers = await store.getCustomers(search);
        return json({ success: true, count: customers.length, customers });
      }

      if (path === '/api/customers' && method === 'POST') {
        const decoded = await requireAuth(request, env);
        if (!decoded) return json({ success: false, message: 'Unauthorized' }, 401);
        const body = await readJson(request);
        const customer = await store.createCustomer(body, decoded.id);
        const msg = customer._duplicateMerged
          ? `Customer already exists (${customer.id}) — updated existing profile instead of creating duplicate!`
          : `Customer ${customer.id} saved to Firestore.`;
        return json({ success: true, duplicateMerged: Boolean(customer._duplicateMerged), message: msg, customer }, customer._duplicateMerged ? 200 : 201);
      }

      if (/^\/api\/customers\/[^/]+$/.test(path)) {
        const decoded = await requireAuth(request, env);
        if (!decoded) return json({ success: false, message: 'Unauthorized' }, 401);
        const id = decodeURIComponent(path.split('/').pop());

        if (method === 'GET') {
          const customer = await store.getCustomerByIdOrPhone(id);
          if (!customer) return json({ success: false, message: 'Customer not found.' }, 404);
          return json({ success: true, customer });
        }
        if (method === 'PUT') {
          const body = await readJson(request);
          const customer = await store.updateCustomer(id, body);
          if (!customer) return json({ success: false, message: 'Customer not found.' }, 404);
          return json({ success: true, message: 'Customer updated in Firestore.', customer });
        }
        if (method === 'DELETE') {
          if (decoded.role !== 'admin') return json({ success: false, message: 'Admin required.' }, 403);
          const result = await store.deleteCustomer(id);
          if (!result || !result.deleted) return json({ success: false, message: 'Customer not found.' }, 404);
          const msg = result.renumberedCount > 0
            ? `Customer deleted & ${result.renumberedCount} remaining customer ID(s) re-serialized.`
            : 'Customer and R2 files deleted.';
          return json({
            success: true,
            message: msg,
            renumberedCount: result.renumberedCount,
            idMap: result.idMap,
            customers: result.customers
          });
        }
      }

      // Upload 300x300 Photo -> R2 + filename in Firestore
      if (/^\/api\/customers\/[^/]+\/photo$/.test(path) && method === 'POST') {
        const decoded = await requireAuth(request, env);
        if (!decoded) return json({ success: false, message: 'Unauthorized' }, 401);
        const id = decodeURIComponent(path.split('/')[3]);
        const form = await request.formData();
        const file = form.get('photo');
        if (!file || typeof file === 'string') return json({ success: false, message: 'No photo uploaded.' }, 400);

        const bytes = new Uint8Array(await file.arrayBuffer());
        const validation = ImageValidator.validatePhoto(bytes);
        if (!validation.valid) return json({ success: false, message: validation.message }, 400);

        const mime = validation.dimensions.type === 'png' ? 'image/png' : 'image/jpeg';
        const saved = await store.saveCustomerMedia(id, 'photo', bytes, mime, file.name);
        if (!saved) return json({ success: false, message: 'Customer not found.' }, 404);

        return json({
          success: true,
          message: 'Photo uploaded to Cloudflare R2 (300x300 px) & filename saved to Firestore.',
          photoUrl: saved.url,
          photoFileName: saved.fileName,
          dimensions: validation.dimensions
        });
      }

      // Upload 300x80 Signature -> R2 + filename in Firestore
      if (/^\/api\/customers\/[^/]+\/signature$/.test(path) && method === 'POST') {
        const decoded = await requireAuth(request, env);
        if (!decoded) return json({ success: false, message: 'Unauthorized' }, 401);
        const id = decodeURIComponent(path.split('/')[3]);
        const form = await request.formData();
        const file = form.get('signature');
        if (!file || typeof file === 'string') return json({ success: false, message: 'No signature uploaded.' }, 400);

        const bytes = new Uint8Array(await file.arrayBuffer());
        const validation = ImageValidator.validateSignature(bytes);
        if (!validation.valid) return json({ success: false, message: validation.message }, 400);

        const mime = validation.dimensions.type === 'png' ? 'image/png' : 'image/jpeg';
        const saved = await store.saveCustomerMedia(id, 'signature', bytes, mime, file.name);
        if (!saved) return json({ success: false, message: 'Customer not found.' }, 404);

        return json({
          success: true,
          message: 'Signature uploaded to Cloudflare R2 (300x80 px) & filename saved to Firestore.',
          signatureUrl: saved.url,
          signatureFileName: saved.fileName,
          dimensions: validation.dimensions
        });
      }

      // Upload arbitrary per-user file/PDF/image -> R2 + filename in Firestore
      if (/^\/api\/customers\/[^/]+\/files$/.test(path) && method === 'POST') {
        const decoded = await requireAuth(request, env);
        if (!decoded) return json({ success: false, message: 'Unauthorized' }, 401);
        const id = decodeURIComponent(path.split('/')[3]);
        const form = await request.formData();
        const file = form.get('file');
        if (!file || typeof file === 'string') return json({ success: false, message: 'No file uploaded.' }, 400);

        const bytes = new Uint8Array(await file.arrayBuffer());
        const saved = await store.saveCustomerFile(id, file.name, bytes, file.type || 'application/octet-stream');
        if (!saved) return json({ success: false, message: 'Customer not found.' }, 404);

        return json({
          success: true,
          message: `File "${saved.file.fileName}" saved to Cloudflare R2.`,
          file: saved.file,
          customer: saved.customer
        });
      }

      // Delete a customer's stored R2 file
      if (/^\/api\/customers\/[^/]+\/files\/[^/]+$/.test(path) && method === 'DELETE') {
        const decoded = await requireAuth(request, env);
        if (!decoded) return json({ success: false, message: 'Unauthorized' }, 401);
        const parts = path.split('/');
        const id = decodeURIComponent(parts[3]);
        const fileId = decodeURIComponent(parts[5]);
        const customer = await store.deleteCustomerFile(id, fileId);
        if (!customer) return json({ success: false, message: 'File or customer not found.' }, 404);
        return json({ success: true, message: 'File removed from R2 & Firestore.', customer });
      }

      // ==================== 6. PDF PARSER (+ R2 ARCHIVE) ====================
      if (path === '/api/parse/pdf' && method === 'POST') {
        const decoded = await requireAuth(request, env);
        if (!decoded) return json({ success: false, message: 'Unauthorized' }, 401);
        const form = await request.formData();
        const file = form.get('pdf');
        const ocrText = String(form.get('ocrText') || '').trim();
        if ((!file || typeof file === 'string') && !ocrText) {
          return json({ success: false, message: 'No PDF uploaded.' }, 400);
        }

        const autoSave = form.get('autoSave') !== 'false';
        const customKey = String(form.get('geminiApiKey') || request.headers.get('X-Gemini-Key') || '');
        const bytes = file && typeof file !== 'string' ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array();
        const fileName = (file && typeof file !== 'string' && file.name) ? file.name : 'application.pdf';

        const extracted = await extractProfileFromPdf(bytes, customKey, env, ocrText);
        extracted.sourceFile = fileName;

        let savedCustomer = null;
        if (autoSave) {
          savedCustomer = await store.createCustomer(extracted, decoded.id);
          if (bytes.length > 0) {
            const archived = await store.saveCustomerFile(savedCustomer.id, fileName, bytes, 'application/pdf');
            if (archived?.customer) savedCustomer = archived.customer;
          }
        }

        return json({
          success: true,
          message: autoSave
            ? `Parsed & saved customer (${savedCustomer.id}) to Firestore + PDF archived on R2!`
            : 'Successfully parsed PDF data.',
          extractionMethod: extracted.extractionMethod,
          customer: savedCustomer || extracted,
          customerId: savedCustomer ? savedCustomer.id : null,
          detectedImagesCount: extracted.detectedImagesCount || 0,
          needsClientOcr: Boolean(extracted.needsClientOcr),
          extractedImages: extracted.extractedImages || []
        });
      }

      // ==================== 7. API KEYS ====================
      if (path === '/api/keys' && method === 'GET') {
        const decoded = await requireAuth(request, env);
        if (!decoded) return json({ success: false, message: 'Unauthorized' }, 401);
        const keys = await store.getApiKeys();
        return json({ success: true, count: keys.length, keys });
      }

      if (path === '/api/keys' && method === 'POST') {
        const decoded = await requireAuth(request, env);
        if (!decoded) return json({ success: false, message: 'Unauthorized' }, 401);
        const body = await readJson(request);
        const apiKey = await store.regenerateWebsiteApiKey(body.label || 'Website API Key', decoded);
        return json({ success: true, message: 'Website API Key updated.', apiKey }, 201);
      }

      if (path.startsWith('/api/keys/') && method === 'DELETE') {
        const decoded = await requireAuth(request, env);
        if (!decoded) return json({ success: false, message: 'Unauthorized' }, 401);
        const id = decodeURIComponent(path.split('/').pop());
        await store.revokeApiKey(id);
        return json({ success: true, message: 'API Key revoked.' });
      }

      // ==================== 8. EXTENSION API (`/api/v1/extension/*`) ====================
      if (path.startsWith('/api/v1/extension/')) {
        const keyRecord = await requireApiKey(request, store, url);
        if (!keyRecord) {
          return json({ success: false, message: 'Invalid or missing Developer API Key.' }, 401);
        }

        if (path === '/api/v1/extension/verify' && method === 'GET') {
          return json({
            success: true,
            message: 'Developer API Key authenticated successfully.',
            client: { label: keyRecord.label, operator: keyRecord.userName, role: keyRecord.userRole }
          });
        }

        if (path === '/api/v1/extension/customers' && method === 'GET') {
          const list = await store.getCustomers('');
          return json({
            success: true,
            customers: list.map(c => ({ id: c.id, applicantName: c.applicantName, mobile: c.mobile || '' }))
          });
        }

        // Save or update customer info pushed directly from extension -> Firestore!
        if (path === '/api/v1/extension/customer' && method === 'POST') {
          const body = await readJson(request);
          let customer = null;
          if (body.id || body.mobile) {
            const existing = await store.getCustomerByIdOrPhone(body.id || body.mobile);
            if (existing) customer = await store.updateCustomer(existing.id, body);
          }
          if (!customer) {
            customer = await store.createCustomer(body, keyRecord.userId || 'extension');
          }
          return json({ success: true, message: `Customer ${customer.id} saved to Firestore.`, customer });
        }

        if (path.startsWith('/api/v1/extension/customer/') && method === 'GET') {
          const queryId = decodeURIComponent(path.replace('/api/v1/extension/customer/', ''));
          const c = await store.getCustomerByIdOrPhone(queryId);
          if (!c) {
            return json({ success: false, message: `Customer profile "${queryId}" not found.` }, 404);
          }
          const origin = `${url.protocol}//${url.host}`;
          return json({
            success: true,
            customerId: c.id,
            data: {
              name: c.applicantName,
              name_bn: c.applicantNameBn,
              father: c.fatherName,
              father_bn: c.fatherNameBn,
              mother: c.motherName,
              mother_bn: c.motherNameBn,
              dob: c.dob,
              gender: c.gender,
              religion: c.religion,
              nationality: c.nationality,
              nid: c.nid,
              birth_reg: c.birthReg,
              passport: c.passport,
              marital_status: c.maritalStatus,
              spouse_name: c.spouseName,
              mobile: c.mobile,
              email: c.email,
              quota: c.quota,
              departmental_status: c.departmentalStatus,
              present_care_of: c.presentAddress?.careOf || '',
              present_village: c.presentAddress?.village || '',
              present_district: c.presentAddress?.district || '',
              present_upazila: c.presentAddress?.upazila || '',
              present_post_office: c.presentAddress?.postOffice || '',
              present_post_code: c.presentAddress?.postCode || '',
              same_as_present: Boolean(c.permanentAddress?.sameAsPresent),
              permanent_care_of: c.permanentAddress?.careOf || '',
              permanent_village: c.permanentAddress?.village || '',
              permanent_district: c.permanentAddress?.district || '',
              permanent_upazila: c.permanentAddress?.upazila || '',
              permanent_post_office: c.permanentAddress?.postOffice || '',
              permanent_post_code: c.permanentAddress?.postCode || '',
              education: c.education || {},
              photoUrl: c.photoUrl ? `${origin}${c.photoUrl}` : null,
              signatureUrl: c.signatureUrl ? `${origin}${c.signatureUrl}` : null
            }
          });
        }

        if (path === '/api/v1/extension/track-apply' && method === 'POST') {
          const body = await readJson(request);
          if (!body.customerId && !body.portalUrl) {
            return json({ success: false, message: 'customerId or portalUrl is required.' }, 400);
          }
          const entry = await store.trackApplication(body);
          return json({ success: true, message: 'Application tracked in Firestore.', application: entry });
        }
      }

      // ==================== 9. STATIC ASSETS & SPA FALLBACK ====================
      if (env.ASSETS) {
        const assetRes = await env.ASSETS.fetch(request);
        if (assetRes.status !== 404) return assetRes;
        // Fallback to index.html for client navigation
        return env.ASSETS.fetch(new Request(new URL('/', request.url), request));
      }

      return json({ success: false, message: 'Not Found' }, 404);
    } catch (err) {
      console.error('Worker error:', err);
      const status = Number(err.status) || 500;
      return json({ success: false, message: err.message || 'Internal Server Error' }, status);
    }
  }
};
