const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../config/db');
const Auth = require('../middleware/auth');
const PdfService = require('../services/pdfService');
const GeminiService = require('../services/geminiService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB
});

/**
 * POST /api/parse/pdf
 * Upload application PDF, extract structured details via Gemini API & OCR, and auto-save or preview
 */
router.post('/pdf', Auth.verifyToken, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No PDF file uploaded.' });
    }

    const customApiKey = req.body.geminiApiKey || req.headers['x-gemini-key'] || '';
    const ocrText = req.body.ocrText || '';
    const autoSave = req.body.autoSave !== 'false';

    console.log(`Processing uploaded PDF: "${req.file.originalname}" (${req.file.size} bytes)...`);

    // Step 1: Extract text and embedded page images
    const pdfData = ocrText ? { text: ocrText, images: [] } : await PdfService.processPdf(req.file.buffer);

    // Step 2: Use Gemini API with OCR fallback
    const extractedData = await GeminiService.extractProfile(
      req.file.buffer,
      pdfData.images,
      pdfData.text,
      customApiKey
    );

    extractedData.sourceFile = req.file.originalname;

    // Step 3: If autoSave is true, save directly into customer database
    let savedCustomer = null;
    if (autoSave) {
      savedCustomer = db.createCustomer(extractedData, req.user.id);
      db.logAudit('PDF_PARSE_AND_SAVE', req.user.id, savedCustomer.id, req.ip);
    }

    res.json({
      success: true,
      message: autoSave 
        ? `Successfully parsed and saved customer profile (${savedCustomer.id})!` 
        : 'Successfully parsed PDF data.',
      extractionMethod: extractedData.extractionMethod,
      customer: savedCustomer || extractedData,
      customerId: savedCustomer ? savedCustomer.id : null,
      detectedImagesCount: pdfData.images.length
    });
  } catch (err) {
    console.error('PDF parsing endpoint error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to parse PDF: ' + err.message
    });
  }
});

module.exports = router;
