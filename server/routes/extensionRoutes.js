const express = require('express');
const router = express.Router();
const db = require('../config/db');
const verifyApiKey = require('../middleware/apiKeyAuth');

// All extension routes require a valid Developer API Key
router.use(verifyApiKey);

/**
 * GET /api/v1/extension/verify
 * Tests connection and authentication from browser extension
 */
router.get('/verify', (req, res) => {
  res.json({
    success: true,
    message: 'Developer API Key authenticated successfully.',
    client: {
      keyPrefix: req.apiKey.keyPrefix,
      label: req.apiKey.label,
      operator: req.apiUser.username,
      role: req.apiUser.role
    },
    serverTime: new Date().toISOString()
  });
});

/**
 * GET /api/v1/extension/customers
 * Returns active customer list for extension quick-selection
 */
router.get('/customers', (req, res) => {
  const { search } = req.query;
  const customers = db.getCustomers({ search });

  const summaryList = customers.map(c => ({
    id: c.id,
    applicantName: c.applicantName,
    applicantNameBn: c.applicantNameBn,
    mobile: c.mobile,
    nid: c.nid,
    hasPhoto: Boolean(c.photoUrl),
    hasSignature: Boolean(c.signatureUrl),
    createdAt: c.createdAt
  }));

  res.json({
    success: true,
    count: summaryList.length,
    customers: summaryList
  });
});

/**
 * GET /api/v1/extension/customer/:id
 * Fetches structured customer profile by Customer ID or Phone Number
 */
router.get('/customer/:id', (req, res) => {
  const query = req.params.id.trim();
  const customer = db.getCustomerById(query);

  if (!customer) {
    return res.status(404).json({
      success: false,
      message: `Customer profile not found for "${query}". Please check the Customer ID or Phone Number.`
    });
  }

  db.logAudit('EXTENSION_FETCH_CUSTOMER', req.apiUser.id, customer.id, req.ip);

  // Return formatted payload with Teletalk & generic field mappings
  res.json({
    success: true,
    customerId: customer.id,
    data: {
      // Basic / Personal
      name: customer.applicantName,
      name_bn: customer.applicantNameBn,
      father: customer.fatherName,
      father_bn: customer.fatherNameBn,
      mother: customer.motherName,
      mother_bn: customer.motherNameBn,
      dob: customer.dob, // YYYY-MM-DD
      gender: customer.gender,
      religion: customer.religion,
      nationality: customer.nationality || 'Bangladeshi',
      
      // Verification IDs
      nid: customer.nid,
      has_nid: customer.nid ? '1' : '0',
      birth_reg: customer.birthReg,
      has_birth_reg: customer.birthReg ? '1' : '0',
      passport: customer.passport,
      has_passport: customer.passport ? '1' : '0',
      
      // Marital
      marital_status: customer.maritalStatus,
      spouse_name: customer.spouseName,

      // Contact
      mobile: customer.mobile,
      confirm_mobile: customer.mobile,
      email: customer.email,

      // Quotas
      quota: customer.quota,
      dep_status: customer.departmentalStatus,

      // Addresses
      present_careof: customer.presentAddress?.careOf || '',
      present_village: customer.presentAddress?.village || '',
      present_district: customer.presentAddress?.district || '',
      present_district_code: customer.presentAddress?.districtCode || '',
      present_upazila: customer.presentAddress?.upazila || '',
      present_upazila_code: customer.presentAddress?.upazilaCode || '',
      present_post: customer.presentAddress?.postOffice || '',
      present_postcode: customer.presentAddress?.postCode || '',

      permanent_careof: customer.permanentAddress?.careOf || customer.presentAddress?.careOf || '',
      permanent_village: customer.permanentAddress?.village || customer.presentAddress?.village || '',
      permanent_district: customer.permanentAddress?.district || customer.presentAddress?.district || '',
      permanent_upazila: customer.permanentAddress?.upazila || customer.presentAddress?.upazila || '',
      permanent_post: customer.permanentAddress?.postOffice || customer.presentAddress?.postOffice || '',
      permanent_postcode: customer.permanentAddress?.postCode || customer.presentAddress?.postCode || '',
      same_as_present: customer.permanentAddress?.sameAsPresent !== false,

      // Education
      education: customer.education || {},

      // Media
      photoUrl: customer.photoUrl ? `${req.protocol}://${req.get('host')}${customer.photoUrl}` : null,
      signatureUrl: customer.signatureUrl ? `${req.protocol}://${req.get('host')}${customer.signatureUrl}` : null
    }
  });
});

/**
 * POST /api/v1/extension/track-apply
 * Records autofilled/submitted job application from the Browser Extension
 */
router.post('/track-apply', (req, res) => {
  try {
    const { customerId, jobTitle, organization, url, portalUrl, filledCount, actionType } = req.body;
    if (!customerId) {
      return res.status(400).json({ success: false, message: 'customerId is required.' });
    }

    const customer = db.getCustomerById(customerId);
    const appRecord = db.trackApplication({
      customerId: customer ? customer.id : customerId,
      applicantName: customer ? customer.applicantName : (req.body.applicantName || 'Unknown'),
      mobile: customer ? customer.mobile : '',
      jobTitle: jobTitle || 'Govt Job Application',
      organization: organization || 'Teletalk / Web Portal',
      portalUrl: portalUrl || url || '',
      filledCount: Number(filledCount) || 0,
      actionType: actionType || 'autofill',
      operator: req.apiUser.username
    });

    db.logAudit('EXTENSION_TRACK_APPLY', req.apiUser.id, appRecord.customerId, req.ip);

    res.json({
      success: true,
      message: 'Application tracked in dashboard.',
      application: appRecord
    });
  } catch (err) {
    console.error('Track apply error:', err);
    res.status(500).json({ success: false, message: 'Failed to track application.' });
  }
});

module.exports = router;
