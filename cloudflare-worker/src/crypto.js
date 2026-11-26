/**
 * Web Crypto Utilities for Cloudflare Workers
 * - HS256 JWT (Admin session tokens)
 * - PBKDF2-SHA256 Password Hashing
 * - SHA-256 API Key Hashing & Generation
 * - RS256 Google OAuth2 Service Account JWT (for Firestore REST API)
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function base64UrlEncode(input) {
  const bytes = typeof input === 'string' ? textEncoder.encode(input) : new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecodeToBytes(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function arrayBufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(byteLength = 16) {
  const arr = new Uint8Array(byteLength);
  crypto.getRandomValues(arr);
  return arrayBufferToHex(arr);
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(String(text)));
  return arrayBufferToHex(digest);
}

export async function hashPassword(password) {
  const salt = randomHex(16);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: textEncoder.encode(salt),
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );
  return `pbkdf2$${salt}$${arrayBufferToHex(derived)}`;
}

export async function verifyPassword(password, storedHash) {
  if (!storedHash || !password) return false;
  if (storedHash.startsWith('pbkdf2$')) {
    const [, salt, expectedHex] = storedHash.split('$');
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      textEncoder.encode(password),
      'PBKDF2',
      false,
      ['deriveBits']
    );
    const derived = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: textEncoder.encode(salt),
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      256
    );
    return arrayBufferToHex(derived) === expectedHex;
  }
  // Plain fallback for emergency bootstrap only
  return storedHash === password;
}

export async function signJwt(payload, secret, expiresInSeconds = 7 * 24 * 3600) {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = base64UrlEncode(JSON.stringify({ ...payload, iat: now, exp: now + expiresInSeconds }));
  const data = `${header}.${body}`;

  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(data));
  return `${data}.${base64UrlEncode(signature)}`;
}

export async function verifyJwt(token, secret) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const key = await crypto.subtle.importKey(
      'raw',
      textEncoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecodeToBytes(sig),
      textEncoder.encode(`${header}.${body}`)
    );
    if (!valid) return null;
    const decoded = JSON.parse(textDecoder.decode(base64UrlDecodeToBytes(body)));
    if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch {
    return null;
  }
}

export async function generateApiKey() {
  const fullKey = `govfill_live_${randomHex(24)}`;
  const keyPrefix = fullKey.substring(0, 18);
  const keyHash = await sha256Hex(fullKey);
  return { fullKey, keyPrefix, keyHash };
}

function pemToArrayBuffer(pem) {
  const clean = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

let cachedGoogleToken = null;

export async function getGoogleAccessToken(clientEmail, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedGoogleToken && cachedGoogleToken.exp - 60 > now) {
    return cachedGoogleToken.token;
  }

  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claimSet = base64UrlEncode(
    JSON.stringify({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    })
  );
  const unsignedJwt = `${header}.${claimSet}`;

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, textEncoder.encode(unsignedJwt));
  const assertion = `${unsignedJwt}.${base64UrlEncode(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Google OAuth error: ${data.error_description || data.error || res.status}`);
  }

  cachedGoogleToken = {
    token: data.access_token,
    exp: now + Number(data.expires_in || 3500)
  };
  return cachedGoogleToken.token;
}
