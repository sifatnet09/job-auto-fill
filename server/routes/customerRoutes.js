const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../config/db');
const Auth = require('../middleware/auth');
const ImageValidator = require('../services/imageValidator');

// Storage configuration for multer
const uploadDir = path.join(__dirname, '..', 'uploads');
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

/**
 * GET /api/customers
 */
router.get('/', Auth.verifyToken, (req, res) => {
  const { search } = req.query;
  const customers = db.getCustomers({ search });
  res.json({ success: true, count: customers.length, customers });
});

/**
 * GET /api/customers/:id
 */
router.get('/:id', Auth.verifyToken, (req, res) => {
  const customer = db.getCustomerById(req.params.id);
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found.' });
  }
  res.json({ success: true, customer });
});

/**
 * POST /api/customers
 */
router.post('/', Auth.verifyToken, (req, res) => {
  try {
    const customer = db.createCustomer(req.body, req.user.id);
    db.logAudit(customer._duplicateMerged ? 'MERGE_DUPLICATE_CUSTOMER' : 'CREATE_CUSTOMER', req.user.id, customer.id, req.ip);
    res.status(customer._duplicateMerged ? 200 : 201).json({
      success: true,
      duplicateMerged: Boolean(customer._duplicateMerged),
      message: customer._duplicateMerged
        ? `Customer already exists (${customer.id}) — updated existing profile instead of creating duplicate!`
        : 'Customer profile created successfully with Unique ID: ' + customer.id,
      customer
    });
  } catch (err) {
    console.error('Error creating customer:', err);
    res.status(500).json({ success: false, message: 'Failed to create customer profile.' });
  }
});

/**
 * PUT /api/customers/:id
 */
router.put('/:id', Auth.verifyToken, (req, res) => {
  try {
    const updated = db.updateCustomer(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Customer not found.' });
    }
    db.logAudit('UPDATE_CUSTOMER', req.user.id, req.params.id, req.ip);
    res.json({ success: true, message: 'Customer profile updated successfully.', customer: updated });
  } catch (err) {
    console.error('Error updating customer:', err);
    res.status(500).json({ success: false, message: 'Failed to update customer profile.' });
  }
});

/**
 * DELETE /api/customers/:id (Admin only)
 */
router.delete('/:id', Auth.verifyToken, Auth.requireAdmin, (req, res) => {
  const result = db.deleteCustomer(req.params.id);
  if (!result || !result.deleted) {
    return res.status(404).json({ success: false, message: 'Customer not found.' });
  }
  db.logAudit('DELETE_CUSTOMER', req.user.id, req.params.id, req.ip);
  const msg = result.renumberedCount > 0
    ? `Customer deleted & ${result.renumberedCount} remaining customer ID(s) re-serialized.`
    : 'Customer profile deleted.';
  res.json({
    success: true,
    message: msg,
    renumberedCount: result.renumberedCount,
    idMap: result.idMap,
    customers: result.customers
  });
});

/**
 * POST /api/customers/:id/photo
 * Strictly validates 300x300 pixels
 */
router.post('/:id/photo', Auth.verifyToken, upload.single('photo'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No photo file provided.' });
    }

    const validation = ImageValidator.validatePhoto(req.file.buffer);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: validation.message
      });
    }

    const customer = db.getCustomerRawById(req.params.id);
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found.' });
    }

    const ext = validation.dimensions.type === 'png' ? '.png' : '.jpg';
    const filename = `photo_${customer.id}_${Date.now()}${ext}`;
    const filePath = path.join(uploadDir, 'photos', filename);

    fs.writeFileSync(filePath, req.file.buffer);
    const photoUrl = `/uploads/photos/${filename}`;

    db.updateCustomer(customer.id, { photoUrl });
    db.logAudit('UPLOAD_PHOTO_300X300', req.user.id, customer.id, req.ip);

    res.json({
      success: true,
      message: 'Photo uploaded and validated successfully (300x300 px).',
      photoUrl,
      dimensions: validation.dimensions
    });
  } catch (err) {
    console.error('Photo upload error:', err);
    res.status(500).json({ success: false, message: 'Failed to upload photo.' });
  }
});

/**
 * POST /api/customers/:id/signature
 * Strictly validates 300x80 pixels
 */
router.post('/:id/signature', Auth.verifyToken, upload.single('signature'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No signature file provided.' });
    }

    const validation = ImageValidator.validateSignature(req.file.buffer);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: validation.message
      });
    }

    const customer = db.getCustomerRawById(req.params.id);
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found.' });
    }

    const ext = validation.dimensions.type === 'png' ? '.png' : '.jpg';
    const filename = `sign_${customer.id}_${Date.now()}${ext}`;
    const filePath = path.join(uploadDir, 'signatures', filename);

    fs.writeFileSync(filePath, req.file.buffer);
    const signatureUrl = `/uploads/signatures/${filename}`;

    db.updateCustomer(customer.id, { signatureUrl });
    db.logAudit('UPLOAD_SIGNATURE_300X80', req.user.id, customer.id, req.ip);

    res.json({
      success: true,
      message: 'Signature uploaded and validated successfully (300x80 px).',
      signatureUrl,
      dimensions: validation.dimensions
    });
  } catch (err) {
    console.error('Signature upload error:', err);
    res.status(500).json({ success: false, message: 'Failed to upload signature.' });
  }
});

/**
 * POST /api/customers/:id/files
 * Upload arbitrary PDF/document/image for a specific customer
 */
router.post('/:id/files', Auth.verifyToken, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file provided.' });
    }
    const customer = db.getCustomerRawById(req.params.id);
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found.' });
    }

    const custFilesDir = path.join(uploadDir, 'files', customer.id);
    if (!fs.existsSync(custFilesDir)) fs.mkdirSync(custFilesDir, { recursive: true });

    const cleanName = String(req.file.originalname || `file_${Date.now()}.bin`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const storedName = `${Date.now()}_${cleanName}`;
    fs.writeFileSync(path.join(custFilesDir, storedName), req.file.buffer);

    const fileId = `f_${Date.now()}`;
    const entry = {
      id: fileId,
      fileName: cleanName,
      url: `/uploads/files/${customer.id}/${storedName}`,
      contentType: req.file.mimetype || 'application/octet-stream',
      size: req.file.size,
      uploadedAt: new Date().toISOString()
    };

    const files = Array.isArray(customer.files) ? [...customer.files, entry] : [entry];
    const updated = db.updateCustomer(customer.id, { files });
    db.logAudit('UPLOAD_CUSTOMER_FILE', req.user.id, customer.id, req.ip);

    res.json({
      success: true,
      message: `File "${cleanName}" uploaded successfully.`,
      file: entry,
      customer: updated
    });
  } catch (err) {
    console.error('Customer file upload error:', err);
    res.status(500).json({ success: false, message: 'Failed to upload file.' });
  }
});

/**
 * DELETE /api/customers/:id/files/:fileId
 */
router.delete('/:id/files/:fileId', Auth.verifyToken, (req, res) => {
  const customer = db.getCustomerRawById(req.params.id);
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found.' });
  }
  const files = Array.isArray(customer.files) ? customer.files : [];
  const target = files.find(f => f.id === req.params.fileId);
  if (!target) {
    return res.status(404).json({ success: false, message: 'File not found.' });
  }
  if (target.url && target.url.startsWith('/uploads/')) {
    const abs = path.join(uploadDir, target.url.replace('/uploads/', ''));
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  }
  const updated = db.updateCustomer(customer.id, { files: files.filter(f => f.id !== req.params.fileId) });
  res.json({ success: true, message: 'File removed.', customer: updated });
});

module.exports = router;
