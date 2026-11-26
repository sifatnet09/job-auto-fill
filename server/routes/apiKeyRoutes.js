const express = require('express');
const router = express.Router();
const db = require('../config/db');
const Auth = require('../middleware/auth');

/**
 * GET /api/keys
 * Returns the single Website API Key
 */
router.get('/', Auth.verifyToken, (req, res) => {
  const keys = db.getApiKeys();
  res.json({ success: true, count: keys.length, keys });
});

/**
 * POST /api/keys
 * Regenerates the single Website API Key for browser extension
 */
router.post('/', Auth.verifyToken, (req, res) => {
  try {
    const { label } = req.body;
    const newKey = db.createApiKey(label || 'Website API Key', req.user);
    db.logAudit('REGENERATE_WEBSITE_API_KEY', req.user.id, null, req.ip);

    res.status(201).json({
      success: true,
      message: 'Website API Key updated successfully.',
      apiKey: newKey
    });
  } catch (err) {
    console.error('API key generation error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate API key.' });
  }
});

/**
 * DELETE /api/keys/:id
 * Revoke an existing developer API key
 */
router.delete('/:id', Auth.verifyToken, (req, res) => {
  const success = db.revokeApiKey(req.params.id);
  if (!success) {
    return res.status(404).json({ success: false, message: 'API key not found.' });
  }
  db.logAudit('REVOKE_API_KEY', req.user.id, null, req.ip);
  res.json({ success: true, message: 'Developer API Key revoked successfully.' });
});

module.exports = router;
