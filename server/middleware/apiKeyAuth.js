const db = require('../config/db');

/**
 * Middleware for Browser Extension API Key authentication
 * Accepts either:
 *  - Header: `X-API-Key: govfill_live_...`
 *  - Header: `Authorization: Bearer govfill_live_...`
 *  - Query: `?apiKey=govfill_live_...`
 */
function verifyApiKey(req, res, next) {
  let apiKey = req.headers['x-api-key'];

  if (!apiKey && req.headers['authorization']) {
    const auth = req.headers['authorization'];
    if (auth.startsWith('Bearer ')) {
      const candidate = auth.slice(7).trim();
      if (candidate.startsWith('govfill_live_')) {
        apiKey = candidate;
      }
    }
  }

  if (!apiKey && req.query.apiKey) {
    apiKey = req.query.apiKey;
  }

  if (!apiKey) {
    return res.status(401).json({
      success: false,
      message: 'Developer API Key is missing. Please provide it via X-API-Key or Authorization header.'
    });
  }

  const keyRecord = db.validateApiKey(apiKey);
  if (!keyRecord) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or revoked Developer API Key.'
    });
  }

  req.apiKey = keyRecord;
  req.apiUser = {
    id: keyRecord.userId,
    username: keyRecord.userName,
    role: keyRecord.userRole
  };

  next();
}

module.exports = verifyApiKey;
