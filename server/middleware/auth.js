const jwt = require('jsonwebtoken');
const db = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET || 'govfill_jwt_super_secret_key_2026';

const Auth = {
  generateToken(user) {
    return jwt.sign(
      {
        id: user.id,
        username: user.username,
        role: user.role,
        fullName: user.fullName
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
  },

  verifyToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ success: false, message: 'Authentication required. No token provided.' });
    }

    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      next();
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Invalid or expired session token.' });
    }
  },

  requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Access denied: Administrator privileges required.' });
    }
    next();
  },

  requireStaff(req, res, next) {
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'employee')) {
      return res.status(403).json({ success: false, message: 'Access denied: Authorized staff role required.' });
    }
    next();
  }
};

module.exports = Auth;
