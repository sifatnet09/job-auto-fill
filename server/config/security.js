const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// 32-byte encryption key (derived from secret or environment)
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'bangladesh-gov-autofill-secure-key-2026';
const KEY = crypto.scryptSync(ENCRYPTION_SECRET, 'govfill_salt_2026', 32);
const ALGORITHM = 'aes-256-gcm';

const Security = {
  /**
   * Encrypts plaintext string using AES-256-GCM
   * @param {string} text 
   * @returns {string} iv:authTag:encrypted
   */
  encrypt(text) {
    if (!text && text !== 0) return '';
    try {
      const str = String(text);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
      let encrypted = cipher.update(str, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const authTag = cipher.getAuthTag().toString('hex');
      return `${iv.toString('hex')}:${authTag}:${encrypted}`;
    } catch (err) {
      console.error('Encryption error:', err);
      return '';
    }
  },

  /**
   * Decrypts AES-256-GCM encrypted string
   * @param {string} encryptedString 
   * @returns {string} plaintext
   */
  decrypt(encryptedString) {
    if (!encryptedString || typeof encryptedString !== 'string') return '';
    const parts = encryptedString.split(':');
    if (parts.length !== 3) return encryptedString; // not encrypted or old format

    try {
      const iv = Buffer.from(parts[0], 'hex');
      const authTag = Buffer.from(parts[1], 'hex');
      const encrypted = parts[2];

      const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (err) {
      console.error('Decryption error:', err);
      return '';
    }
  },

  /**
   * Encrypts an object's sensitive fields
   */
  encryptObject(obj, sensitiveKeys = ['nid', 'mobile', 'email', 'spouseName']) {
    if (!obj || typeof obj !== 'object') return obj;
    const cloned = { ...obj };
    for (const key of sensitiveKeys) {
      if (cloned[key]) {
        cloned[key] = this.encrypt(cloned[key]);
      }
    }
    return cloned;
  },

  /**
   * Decrypts an object's sensitive fields
   */
  decryptObject(obj, sensitiveKeys = ['nid', 'mobile', 'email', 'spouseName']) {
    if (!obj || typeof obj !== 'object') return obj;
    const cloned = { ...obj };
    for (const key of sensitiveKeys) {
      if (cloned[key]) {
        cloned[key] = this.decrypt(cloned[key]);
      }
    }
    return cloned;
  },

  /**
   * Hash password with bcrypt
   */
  async hashPassword(password) {
    return bcrypt.hash(password, 10);
  },

  /**
   * Compare password with bcrypt hash
   */
  async comparePassword(password, hash) {
    return bcrypt.compare(password, hash);
  },

  /**
   * Generates a new Developer API Key
   * Format: govfill_live_32chars
   */
  generateApiKey() {
    const randomHex = crypto.randomBytes(24).toString('hex');
    const fullKey = `govfill_live_${randomHex}`;
    const keyPrefix = fullKey.substring(0, 18); // e.g. govfill_live_a1b2c3
    const keyHash = crypto.createHash('sha256').update(fullKey).digest('hex');
    const encryptedKey = this.encrypt(fullKey);

    return {
      fullKey,
      keyPrefix,
      keyHash,
      encryptedKey
    };
  },

  /**
   * Hash an API key for verification lookup
   */
  hashApiKey(apiKey) {
    return crypto.createHash('sha256').update(apiKey.trim()).digest('hex');
  }
};

module.exports = Security;
