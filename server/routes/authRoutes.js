const express = require('express');
const router = express.Router();
const db = require('../config/db');
const Security = require('../config/security');
const Auth = require('../middleware/auth');

/**
 * POST /api/auth/login
 * Supports login with either Gmail/Email or Username + Password
 */
router.post('/login', async (req, res) => {
  try {
    const loginId = (req.body.identifier || req.body.email || req.body.username || '').trim();
    const { password } = req.body;
    if (!loginId || !password) {
      return res.status(400).json({ success: false, message: 'Gmail / Username and password are required.' });
    }

    const user = db.findUserByLogin(loginId);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid Gmail/Username or password.' });
    }

    const isMatch = await Security.comparePassword(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid Gmail/Username or password.' });
    }

    const token = Auth.generateToken(user);
    db.logAudit('USER_LOGIN', user.id, null, req.ip);

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Internal server error during login.' });
  }
});

/**
 * GET /api/auth/me
 */
router.get('/me', Auth.verifyToken, (req, res) => {
  const user = db.findUserById(req.user.id);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  res.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      email: user.email,
      role: user.role
    }
  });
});

/**
 * GET /api/auth/users (Admin only)
 */
router.get('/users', Auth.verifyToken, Auth.requireAdmin, (req, res) => {
  const users = db.getAllUsers();
  res.json({ success: true, users });
});

/**
 * POST /api/auth/users (Admin only)
 */
router.post('/users', Auth.verifyToken, Auth.requireAdmin, async (req, res) => {
  try {
    const { username, fullName, email, password, role } = req.body;
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanUsername = (username || (cleanEmail ? cleanEmail.split('@')[0] : '')).trim();

    if ((!cleanUsername && !cleanEmail) || !password) {
      return res.status(400).json({ success: false, message: 'Gmail / Username and password are required.' });
    }

    if (cleanUsername && db.findUserByUsername(cleanUsername)) {
      return res.status(400).json({ success: false, message: 'Username is already taken.' });
    }
    if (cleanEmail && db.findUserByEmail(cleanEmail)) {
      return res.status(400).json({ success: false, message: 'Gmail / Email is already registered.' });
    }

    const passwordHash = await Security.hashPassword(password);
    const newUser = db.createUser({
      username: cleanUsername,
      fullName: fullName || cleanUsername,
      email: cleanEmail,
      passwordHash,
      role: role === 'admin' ? 'admin' : 'employee'
    });

    db.logAudit('CREATE_USER', req.user.id, null, req.ip);

    res.json({
      success: true,
      message: 'Staff account created successfully.',
      user: {
        id: newUser.id,
        username: newUser.username,
        fullName: newUser.fullName,
        email: newUser.email,
        role: newUser.role
      }
    });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ success: false, message: 'Failed to create user.' });
  }
});

/**
 * PUT /api/auth/users/:id (Admin only - supports editing both Staff and Admin accounts)
 */
router.put('/users/:id', Auth.verifyToken, Auth.requireAdmin, async (req, res) => {
  try {
    const targetId = req.params.id;
    const targetUser = db.findUserById(targetId);
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'Staff account not found.' });
    }

    const { username, fullName, email, password, role } = req.body;
    const cleanEmail = email !== undefined ? email.trim().toLowerCase() : targetUser.email;
    const cleanUsername = username !== undefined ? username.trim() : targetUser.username;

    if (cleanUsername && cleanUsername.toLowerCase() !== targetUser.username.toLowerCase()) {
      const conflict = db.findUserByUsername(cleanUsername);
      if (conflict && conflict.id !== targetId) {
        return res.status(400).json({ success: false, message: 'Username is already taken.' });
      }
    }

    if (cleanEmail && cleanEmail !== (targetUser.email || '').toLowerCase()) {
      const emailConflict = db.findUserByEmail(cleanEmail);
      if (emailConflict && emailConflict.id !== targetId) {
        return res.status(400).json({ success: false, message: 'Gmail / Email is already registered to another account.' });
      }
    }

    // Prevent demoting the last admin account
    if (targetUser.role === 'admin' && role && role !== 'admin') {
      const adminCount = db.getAllUsers().filter(u => u.role === 'admin').length;
      if (adminCount <= 1) {
        return res.status(400).json({ success: false, message: 'Cannot change role: at least one Admin account is required.' });
      }
    }

    const updates = { username: cleanUsername, fullName, email: cleanEmail, role };
    if (password && password.trim().length > 0) {
      if (password.trim().length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
      }
      updates.passwordHash = await Security.hashPassword(password);
    }

    const updated = db.updateUser(targetId, updates);
    db.logAudit('UPDATE_USER', req.user.id, null, req.ip);

    const responsePayload = {
      success: true,
      message: 'Account updated successfully.',
      user: {
        id: updated.id,
        username: updated.username,
        fullName: updated.fullName,
        email: updated.email,
        role: updated.role
      }
    };

    // Refresh session token if Admin updated their own account
    if (targetId === req.user.id) {
      responsePayload.token = Auth.generateToken(updated);
    }

    res.json(responsePayload);
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ success: false, message: 'Failed to update staff account.' });
  }
});

/**
 * DELETE /api/auth/users/:id (Admin only)
 */
router.delete('/users/:id', Auth.verifyToken, Auth.requireAdmin, (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.user.id) {
    return res.status(400).json({ success: false, message: 'You cannot delete your own logged-in Admin account.' });
  }
  const ok = db.deleteUser(targetId);
  if (!ok) {
    return res.status(404).json({ success: false, message: 'Staff account not found.' });
  }
  db.logAudit('DELETE_USER', req.user.id, null, req.ip);
  res.json({ success: true, message: 'Staff account deleted.' });
});

module.exports = router;
