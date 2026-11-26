import React, { useState, useRef } from 'react';
import { API } from '../services/api.js';
import { ImageHelper } from '../services/imageHelper.js';
import { runBrowserOcr, extractEmbeddedPdfMedia } from '../services/pdfOcr.js';

const emptyEdu = {
  jsc: { examination: '', board: '', roll: '', institute: '', result: '', passingYear: '' },
  ssc: { examination: '', board: '', roll: '', group: '', result: '', passingYear: '' },
  hsc: { examination: '', board: '', roll: '', group: '', result: '', passingYear: '' },
  graduation: { examination: '', institute: '', subject: '', result: '', passingYear: '', duration: '' },
  masters: { examination: '', institute: '', subject: '', result: '', passingYear: '', duration: '' }
};

function normalizeCustomer(c = {}, defaultCategory = 'All Job Pdf') {
  return {
    jobCategory: c.jobCategory || defaultCategory,
    applicantName: c.applicantName || '',
    applicantNameBn: c.applicantNameBn || '',
    fatherName: c.fatherName || '',
    fatherNameBn: c.fatherNameBn || '',
    motherName: c.motherName || '',
    motherNameBn: c.motherNameBn || '',
    dob: c.dob || '',
    gender: c.gender || 'Male',
    religion: c.religion || 'Islam',
    nationality: c.nationality || 'Bangladeshi',
    nid: c.nid || '',
    birthReg: c.birthReg || '',
    passport: c.passport || '',
    quota: c.quota || 'Not Applicable',
    departmentalStatus: c.departmentalStatus || 'Not Applicable',
    mobile: c.mobile || '',
    email: c.email || '',
    maritalStatus: c.maritalStatus || 'Single',
    spouseName: c.spouseName || '',
    presentAddress: { careOf: '', village: '', district: '', upazila: '', postOffice: '', postCode: '', ...(c.presentAddress || {}) },
    permanentAddress: { sameAsPresent: true, careOf: '', village: '', district: '', upazila: '', postOffice: '', postCode: '', ...(c.permanentAddress || {}) },
    education: {
      jsc: { ...emptyEdu.jsc, ...(c.education?.jsc || {}) },
      ssc: { ...emptyEdu.ssc, ...(c.education?.ssc || {}) },
      hsc: { ...emptyEdu.hsc, ...(c.education?.hsc || {}) },
      graduation: { ...emptyEdu.graduation, ...(c.education?.graduation || {}) },
      masters: { ...emptyEdu.masters, ...(c.education?.masters || {}) }
    }
  };
}

export default function PdfParserView({
  showToast,
  onSaved,
  viewId = 'view-parse',
  jobCategory = 'All Job Pdf',
  pageTitle = 'All Job Pdf',
  pageSubtitle = 'Upload any Bangladeshi Govt job application PDF (Teletalk, BEPZA, DWA) — works 100% automatically without AI.',
  dropHint = 'Supports Teletalk Applicant Copies, BEPZA, DWA, Railway, etc.'
}) {
  const fileInputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusText, setStatusText] = useState('Extracting PDF data cleanly without AI...');
  const [errorMsg, setErrorMsg] = useState('');
  const [methodBadge, setMethodBadge] = useState('');
  const [form, setForm] = useState(null);
  const [rawMeta, setRawMeta] = useState({});
  const [parsedPdfFile, setParsedPdfFile] = useState(null);

  const [photoPreview, setPhotoPreview] = useState('/images/placeholder_photo.png');
  const [photoStatus, setPhotoStatus] = useState('Optional: Select photo');
  const [photoBlob, setPhotoBlob] = useState(null);

  const [signPreview, setSignPreview] = useState('/images/placeholder_sign.png');
  const [signStatus, setSignStatus] = useState('Optional: Select signature');
  const [signBlob, setSignBlob] = useState(null);

  const handleFile = async (file) => {
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
      alert('Please select a valid PDF file.');
      return;
    }
    setParsedPdfFile(file);
    setErrorMsg('');
    setForm(null);
    setPhotoBlob(null);
    setSignBlob(null);
    setPhotoPreview('/images/placeholder_photo.png');
    setSignPreview('/images/placeholder_sign.png');
    setPhotoStatus('Scanning PDF for photo...');
    setSignStatus('Scanning PDF for signature...');
    setLoading(true);
    setStatusText('Extracting PDF data cleanly without AI...');

    // Extract candidate photo & signature embedded in Teletalk PDF in parallel
    const mediaPromise = extractEmbeddedPdfMedia(file)
      .then(async (media) => {
        if (media.photoBlob) {
          const resizedPhoto = await ImageHelper.resizeToExact(media.photoBlob, 300, 300);
          setPhotoBlob(resizedPhoto.blob);
          setPhotoPreview(resizedPhoto.dataUrl);
          setPhotoStatus('Auto-extracted from PDF (300x300 px Ready)');
        } else {
          setPhotoStatus('Optional: Select photo');
        }
        if (media.signatureBlob) {
          const resizedSign = await ImageHelper.resizeToExact(media.signatureBlob, 300, 80);
          setSignBlob(resizedSign.blob);
          setSignPreview(resizedSign.dataUrl);
          setSignStatus('Auto-extracted from PDF (300x80 px Ready)');
        } else {
          setSignStatus('Optional: Select signature');
        }
      })
      .catch(() => {
        setPhotoStatus('Optional: Select photo');
        setSignStatus('Optional: Select signature');
      });

    try {
      let res = await API.parsePdf(file, '', false);
      const missingKeySections =
        !res.customer?.applicantName ||
        !res.customer?.applicantNameBn ||
        !res.customer?.fatherName ||
        !res.customer?.fatherNameBn ||
        !res.customer?.motherName ||
        !res.customer?.motherNameBn ||
        !res.customer?.dob ||
        !res.customer?.mobile ||
        !res.customer?.presentAddress?.district ||
        !res.customer?.education?.jsc ||
        !res.customer?.education?.ssc;

      if (res.needsClientOcr || missingKeySections) {
        const ocr = await runBrowserOcr(file, res.extractedImages || [], (msg) => setStatusText(msg), { forceOcr: false });
        if (ocr.text && ocr.text.trim().length > 15) {
          setStatusText('Mapping extracted Bangla & English fields...');
          const res2 = await API.parsePdf(file, '', false, ocr.text);
          res2.browserMethod = ocr.method;
          res = res2;
        }

        // If any Bangla name, DOB, or all education entries are still missing, run high-DPI borderless OCR and merge non-empty values
        if ((!res.customer?.applicantNameBn || !res.customer?.fatherNameBn || !res.customer?.motherNameBn || !res.customer?.dob || (!res.customer?.education?.ssc && !res.customer?.education?.jsc)) && ocr.method !== 'tesseract-browser') {
          const ocr2 = await runBrowserOcr(file, res.extractedImages || [], (msg) => setStatusText(msg), { forceOcr: true });
          if (ocr2.text && ocr2.text.trim().length > 15) {
            setStatusText('Merging Bangla OCR fields...');
            const res3 = await API.parsePdf(file, '', false, ocr2.text);
            const c1 = res.customer || {};
            const c3 = res3.customer || {};
            const merged = { ...c3, ...c1 };
            for (const k of Object.keys(c3)) {
              if (!c1[k] && c3[k]) merged[k] = c3[k];
            }
            if (!c1.presentAddress?.district && c3.presentAddress?.district) merged.presentAddress = c3.presentAddress;
            if (!c1.permanentAddress?.district && c3.permanentAddress?.district) merged.permanentAddress = c3.permanentAddress;
            const mergeEdu = (e1, e3) => {
              if (!e1 && !e3) return null;
              if (!e1) return e3;
              if (!e3) return e1;
              const out = { ...e3, ...e1 };
              for (const k of Object.keys(e3)) {
                if (!e1[k] && e3[k]) out[k] = e3[k];
              }
              return out;
            };
            merged.education = {
              jsc: mergeEdu(c1.education?.jsc, c3.education?.jsc),
              ssc: mergeEdu(c1.education?.ssc, c3.education?.ssc),
              hsc: mergeEdu(c1.education?.hsc, c3.education?.hsc),
              graduation: mergeEdu(c1.education?.graduation, c3.education?.graduation),
              masters: mergeEdu(c1.education?.masters, c3.education?.masters)
            };
            res = { ...res, browserMethod: ocr2.method, customer: merged };
          }
        }
      }

      const cust = res.customer || {};
      setRawMeta({ sourceFile: cust.sourceFile || file.name, extractionMethod: res.extractionMethod });
      setForm(normalizeCustomer(cust, jobCategory));

      if (res.extractionMethod === 'gemini-ai') setMethodBadge('Gemini AI Vision OCR');
      else if (res.browserMethod === 'tesseract-browser' || res.extractionMethod === 'tesseract-ocr') setMethodBadge('Browser OCR (No AI)');
      else if (res.browserMethod === 'pdfjs-text') setMethodBadge('Direct PDF Text (No AI)');
      else setMethodBadge('Rule-Based Parser (No AI)');

      await mediaPromise;
      showToast('PDF parsed & auto-filled! Review and save below.');
    } catch (err) {
      setErrorMsg(`Parsing failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const updateField = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const updateAddr = (which, key, value) => setForm((f) => ({ ...f, [which]: { ...f[which], [key]: value } }));
  const updateEdu = (level, key, value) =>
    setForm((f) => ({ ...f, education: { ...f.education, [level]: { ...f.education[level], [key]: value } } }));

  const handleImagePick = async (file, width, height, kind) => {
    if (!file) return;
    try {
      showToast(`Processing ${kind} to strict ${width}x${height} px...`);
      const resized = await ImageHelper.resizeToExact(file, width, height);
      if (kind === 'photo') {
        setPhotoBlob(resized.blob);
        setPhotoPreview(resized.dataUrl);
        setPhotoStatus(`Valid: ${width}x${height} px Ready`);
      } else {
        setSignBlob(resized.blob);
        setSignPreview(resized.dataUrl);
        setSignStatus(`Valid: ${width}x${height} px Ready`);
      }
    } catch (err) {
      alert(`Image error: ${err.message}`);
    }
  };

  const resetParser = () => {
    setForm(null);
    setParsedPdfFile(null);
    setErrorMsg('');
    setPhotoBlob(null);
    setSignBlob(null);
    setPhotoPreview('/images/placeholder_photo.png');
    setSignPreview('/images/placeholder_sign.png');
    setPhotoStatus('Optional: Select photo');
    setSignStatus('Optional: Select signature');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form || saving) return;
    setSaving(true);
    const edu = {
      jsc: (form.education.jsc.examination || form.education.jsc.roll) ? { ...form.education.jsc, resultType: /passed/i.test(form.education.jsc.result) ? 'Passed' : 'GPA(out of 5)' } : null,
      ssc: (form.education.ssc.examination || form.education.ssc.roll) ? { ...form.education.ssc, resultType: 'GPA(out of 5)' } : null,
      hsc: (form.education.hsc.examination || form.education.hsc.roll) ? { ...form.education.hsc, resultType: 'GPA(out of 5)' } : null,
      graduation: (form.education.graduation.examination || form.education.graduation.institute || form.education.graduation.result) ? { ...form.education.graduation, resultType: /class/i.test(form.education.graduation.result) ? form.education.graduation.result : 'CGPA(out of 4)', duration: form.education.graduation.duration || '4 Years' } : null,
      masters: (form.education.masters.examination || form.education.masters.institute || form.education.masters.result) ? { ...form.education.masters, resultType: /class/i.test(form.education.masters.result) ? form.education.masters.result : 'CGPA(out of 4)', duration: form.education.masters.duration || '1 Year' } : null
    };

    const payload = {
      ...rawMeta,
      ...form,
      jobCategory: form.jobCategory || jobCategory,
      permanentAddress: form.permanentAddress.sameAsPresent
        ? { ...form.presentAddress, sameAsPresent: true }
        : { ...form.permanentAddress, sameAsPresent: false },
      education: edu
    };

    try {
      const res = await API.createCustomer(payload);
      const newId = res.customer.id;
      if (photoBlob) await API.uploadPhoto(newId, photoBlob);
      if (signBlob) await API.uploadSignature(newId, signBlob);
      if (parsedPdfFile) await API.uploadCustomerFile(newId, parsedPdfFile);

      sessionStorage.removeItem('govfill_customers_cache');
      sessionStorage.removeItem('govfill_dash_cache');
      showToast(res.duplicateMerged ? res.message : `Profile saved with Unique Customer ID: ${newId}`);
      resetParser();
      onSaved();
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id={viewId} className="content-view active">
      <div className="view-header">
        <div>
          <h1>{pageTitle}</h1>
          <p>{pageSubtitle}</p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>Upload Application PDF</h2>
        </div>
        <div className="panel-body">
          <div
            id="pdf-drop-zone"
            className={`drop-zone ${dragOver ? 'dragover' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files?.[0]) handleFile(e.dataTransfer.files[0]);
            }}
          >
            <i className="fa-solid fa-cloud-arrow-up drop-icon"></i>
            <div className="drop-text">
              <strong>Click to select PDF or drag &amp; drop here</strong>
              <span>{dropHint}</span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              id="pdf-file-input"
              accept=".pdf"
              style={{ display: 'none' }}
              onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
            />
          </div>

          {loading && (
            <div id="parse-loading" className="parse-status-box">
              <div className="spinner"></div>
              <div id="parse-status-text">{statusText}</div>
            </div>
          )}

          {errorMsg && <div id="parse-alert" className="alert alert-danger">{errorMsg}</div>}
        </div>
      </div>

      {form && (
        <div id="parse-result-panel" className="panel">
          <div className="panel-header">
            <h2>Extracted Customer Details (Auto-Filled)</h2>
            <span id="extraction-method-badge" className="badge badge-success">{methodBadge}</span>
          </div>
          <div className="panel-body">
            <form id="parsed-customer-form" onSubmit={handleSave}>
              <h3 className="section-heading">Basic &amp; Personal Information</h3>
              <div className="form-row">
                <div className="form-group flex-1"><label>Applicant Name (English) *</label><input className="form-control" required value={form.applicantName} onChange={(e) => updateField('applicantName', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Applicant Name (বাংলা)</label><input className="form-control" value={form.applicantNameBn} onChange={(e) => updateField('applicantNameBn', e.target.value)} /></div>
              </div>
              <div className="form-row">
                <div className="form-group flex-1"><label>Father&apos;s Name (English) *</label><input className="form-control" required value={form.fatherName} onChange={(e) => updateField('fatherName', e.target.value)} /></div>
                <div className="form-group flex-1"><label>পিতার নাম (বাংলা)</label><input className="form-control" value={form.fatherNameBn} onChange={(e) => updateField('fatherNameBn', e.target.value)} /></div>
              </div>
              <div className="form-row">
                <div className="form-group flex-1"><label>Mother&apos;s Name (English) *</label><input className="form-control" required value={form.motherName} onChange={(e) => updateField('motherName', e.target.value)} /></div>
                <div className="form-group flex-1"><label>মাতার নাম (বাংলা)</label><input className="form-control" value={form.motherNameBn} onChange={(e) => updateField('motherNameBn', e.target.value)} /></div>
              </div>
              <div className="form-row">
                <div className="form-group flex-1"><label>Date of Birth (YYYY-MM-DD) *</label><input type="date" className="form-control" required value={form.dob} onChange={(e) => updateField('dob', e.target.value)} /></div>
                <div className="form-group flex-1">
                  <label>Gender</label>
                  <select className="form-control" value={form.gender} onChange={(e) => updateField('gender', e.target.value)}>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Third Gender">Third Gender</option>
                  </select>
                </div>
                <div className="form-group flex-1">
                  <label>Religion</label>
                  <select className="form-control" value={form.religion} onChange={(e) => updateField('religion', e.target.value)}>
                    <option value="Islam">Islam</option>
                    <option value="Hinduism">Hinduism</option>
                    <option value="Buddhism">Buddhism</option>
                    <option value="Christianity">Christianity</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
                <div className="form-group flex-1"><label>Nationality</label><input className="form-control" value={form.nationality} onChange={(e) => updateField('nationality', e.target.value)} /></div>
              </div>

              <div className="form-row">
                <div className="form-group flex-1"><label>National ID (NID)</label><input className="form-control" value={form.nid} onChange={(e) => updateField('nid', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Birth Reg No</label><input className="form-control" value={form.birthReg} onChange={(e) => updateField('birthReg', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Passport No</label><input className="form-control" value={form.passport} onChange={(e) => updateField('passport', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Quota</label><input className="form-control" value={form.quota} onChange={(e) => updateField('quota', e.target.value)} /></div>
              </div>

              <div className="form-row">
                <div className="form-group flex-1"><label>Mobile Number *</label><input type="tel" className="form-control" required value={form.mobile} onChange={(e) => updateField('mobile', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Email Address</label><input type="email" className="form-control" value={form.email} onChange={(e) => updateField('email', e.target.value)} /></div>
                <div className="form-group flex-1">
                  <label>Marital Status</label>
                  <select className="form-control" value={form.maritalStatus} onChange={(e) => updateField('maritalStatus', e.target.value)}>
                    <option value="Single">Single</option>
                    <option value="Married">Married</option>
                  </select>
                </div>
                <div className="form-group flex-1"><label>Spouse Name</label><input className="form-control" value={form.spouseName} onChange={(e) => updateField('spouseName', e.target.value)} /></div>
                <div className="form-group flex-1">
                  <label>Job Category</label>
                  <select className="form-control" value={form.jobCategory || jobCategory} onChange={(e) => updateField('jobCategory', e.target.value)}>
                    <option value="All Job Pdf">All Job Pdf</option>
                    <option value="Army Job">Army Job</option>
                    <option value="Navy Job">Navy Job</option>
                    <option value="Air Force Job">Air Force Job</option>
                  </select>
                </div>
              </div>

              <h3 className="section-heading">Present Address</h3>
              <div className="form-row">
                <div className="form-group flex-1"><label>Care Of</label><input className="form-control" value={form.presentAddress.careOf} onChange={(e) => updateAddr('presentAddress', 'careOf', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Village / Road / House</label><input className="form-control" value={form.presentAddress.village} onChange={(e) => updateAddr('presentAddress', 'village', e.target.value)} /></div>
                <div className="form-group flex-1"><label>District</label><input className="form-control" value={form.presentAddress.district} onChange={(e) => updateAddr('presentAddress', 'district', e.target.value)} /></div>
              </div>
              <div className="form-row">
                <div className="form-group flex-1"><label>Upazila / Thana</label><input className="form-control" value={form.presentAddress.upazila} onChange={(e) => updateAddr('presentAddress', 'upazila', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Post Office</label><input className="form-control" value={form.presentAddress.postOffice} onChange={(e) => updateAddr('presentAddress', 'postOffice', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Post Code</label><input className="form-control" value={form.presentAddress.postCode} onChange={(e) => updateAddr('presentAddress', 'postCode', e.target.value)} /></div>
              </div>

              <div className="form-group" style={{ marginTop: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={form.permanentAddress.sameAsPresent !== false}
                    onChange={(e) => updateAddr('permanentAddress', 'sameAsPresent', e.target.checked)}
                  />
                  <span>Permanent Address is same as Present Address</span>
                </label>
              </div>
              {form.permanentAddress.sameAsPresent === false && (
                <div>
                  <h3 className="section-heading">Permanent Address</h3>
                  <div className="form-row">
                    <div className="form-group flex-1"><label>Care Of</label><input className="form-control" value={form.permanentAddress.careOf} onChange={(e) => updateAddr('permanentAddress', 'careOf', e.target.value)} /></div>
                    <div className="form-group flex-1"><label>Village / Road / House</label><input className="form-control" value={form.permanentAddress.village} onChange={(e) => updateAddr('permanentAddress', 'village', e.target.value)} /></div>
                    <div className="form-group flex-1"><label>District</label><input className="form-control" value={form.permanentAddress.district} onChange={(e) => updateAddr('permanentAddress', 'district', e.target.value)} /></div>
                  </div>
                  <div className="form-row">
                    <div className="form-group flex-1"><label>Upazila / Thana</label><input className="form-control" value={form.permanentAddress.upazila} onChange={(e) => updateAddr('permanentAddress', 'upazila', e.target.value)} /></div>
                    <div className="form-group flex-1"><label>Post Office</label><input className="form-control" value={form.permanentAddress.postOffice} onChange={(e) => updateAddr('permanentAddress', 'postOffice', e.target.value)} /></div>
                    <div className="form-group flex-1"><label>Post Code</label><input className="form-control" value={form.permanentAddress.postCode} onChange={(e) => updateAddr('permanentAddress', 'postCode', e.target.value)} /></div>
                  </div>
                </div>
              )}

              <h3 className="section-heading">Education 1: Class Eight / JSC / JDC</h3>
              <div className="form-row">
                <div className="form-group flex-1"><label>Examination</label><input className="form-control" placeholder="Class Eight / JSC" value={form.education.jsc.examination} onChange={(e) => updateEdu('jsc', 'examination', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Board</label><input className="form-control" value={form.education.jsc.board} onChange={(e) => updateEdu('jsc', 'board', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Roll</label><input className="form-control" value={form.education.jsc.roll} onChange={(e) => updateEdu('jsc', 'roll', e.target.value)} /></div>
                <div className="form-group flex-1"><label>School / Institute</label><input className="form-control" value={form.education.jsc.institute} onChange={(e) => updateEdu('jsc', 'institute', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Result / GPA</label><input className="form-control" value={form.education.jsc.result} onChange={(e) => updateEdu('jsc', 'result', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Passing Year</label><input className="form-control" value={form.education.jsc.passingYear} onChange={(e) => updateEdu('jsc', 'passingYear', e.target.value)} /></div>
              </div>

              <h3 className="section-heading">Education 2: SSC / Dakhil / Equivalent</h3>
              <div className="form-row">
                <div className="form-group flex-1"><label>Examination</label><input className="form-control" value={form.education.ssc.examination} onChange={(e) => updateEdu('ssc', 'examination', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Board</label><input className="form-control" value={form.education.ssc.board} onChange={(e) => updateEdu('ssc', 'board', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Roll No</label><input className="form-control" value={form.education.ssc.roll} onChange={(e) => updateEdu('ssc', 'roll', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Group</label><input className="form-control" value={form.education.ssc.group} onChange={(e) => updateEdu('ssc', 'group', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Result / GPA</label><input className="form-control" value={form.education.ssc.result} onChange={(e) => updateEdu('ssc', 'result', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Passing Year</label><input className="form-control" value={form.education.ssc.passingYear} onChange={(e) => updateEdu('ssc', 'passingYear', e.target.value)} /></div>
              </div>

              <h3 className="section-heading">Education 3: HSC / Alim / Diploma</h3>
              <div className="form-row">
                <div className="form-group flex-1"><label>Examination</label><input className="form-control" value={form.education.hsc.examination} onChange={(e) => updateEdu('hsc', 'examination', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Board</label><input className="form-control" value={form.education.hsc.board} onChange={(e) => updateEdu('hsc', 'board', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Roll No</label><input className="form-control" value={form.education.hsc.roll} onChange={(e) => updateEdu('hsc', 'roll', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Group</label><input className="form-control" value={form.education.hsc.group} onChange={(e) => updateEdu('hsc', 'group', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Result / GPA</label><input className="form-control" value={form.education.hsc.result} onChange={(e) => updateEdu('hsc', 'result', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Passing Year</label><input className="form-control" value={form.education.hsc.passingYear} onChange={(e) => updateEdu('hsc', 'passingYear', e.target.value)} /></div>
              </div>

              <h3 className="section-heading">Education 4: Graduation / Fazil / Honours</h3>
              <div className="form-row">
                <div className="form-group flex-1"><label>Examination</label><input className="form-control" value={form.education.graduation.examination} onChange={(e) => updateEdu('graduation', 'examination', e.target.value)} /></div>
                <div className="form-group flex-1"><label>University / Institute</label><input className="form-control" value={form.education.graduation.institute} onChange={(e) => updateEdu('graduation', 'institute', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Subject / Major</label><input className="form-control" value={form.education.graduation.subject} onChange={(e) => updateEdu('graduation', 'subject', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Result / CGPA</label><input className="form-control" value={form.education.graduation.result} onChange={(e) => updateEdu('graduation', 'result', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Passing Year</label><input className="form-control" value={form.education.graduation.passingYear} onChange={(e) => updateEdu('graduation', 'passingYear', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Duration</label><input className="form-control" placeholder="4 Years" value={form.education.graduation.duration} onChange={(e) => updateEdu('graduation', 'duration', e.target.value)} /></div>
              </div>

              <h3 className="section-heading">Education 5: Master&apos;s / Kamil / Equivalent</h3>
              <div className="form-row">
                <div className="form-group flex-1"><label>Examination</label><input className="form-control" value={form.education.masters.examination} onChange={(e) => updateEdu('masters', 'examination', e.target.value)} /></div>
                <div className="form-group flex-1"><label>University / Institute</label><input className="form-control" value={form.education.masters.institute} onChange={(e) => updateEdu('masters', 'institute', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Subject / Major</label><input className="form-control" value={form.education.masters.subject} onChange={(e) => updateEdu('masters', 'subject', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Result / CGPA</label><input className="form-control" value={form.education.masters.result} onChange={(e) => updateEdu('masters', 'result', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Passing Year</label><input className="form-control" value={form.education.masters.passingYear} onChange={(e) => updateEdu('masters', 'passingYear', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Duration</label><input className="form-control" placeholder="1 Year" value={form.education.masters.duration} onChange={(e) => updateEdu('masters', 'duration', e.target.value)} /></div>
              </div>

              <h3 className="section-heading">Photo &amp; Signature (Teletalk Standard: 300x300 &amp; 300x80 px)</h3>
              <div className="media-upload-grid" style={{ marginTop: 10 }}>
                <div className="media-card">
                  <h3><i className="fa-solid fa-image"></i> Photo (300 x 300 px)</h3>
                  <p className="media-sub">Auto-resized &amp; cropped to strict 300x300 px.</p>
                  <div className="image-preview-container photo-box">
                    <img src={photoPreview} alt="Candidate Photo" />
                  </div>
                  <label className="btn btn-outline btn-block">
                    <i className="fa-solid fa-file-image"></i> Select Photo
                    <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleImagePick(e.target.files?.[0], 300, 300, 'photo')} />
                  </label>
                  <div className={`dimension-status ${photoBlob ? 'valid' : ''}`}>{photoStatus}</div>
                </div>

                <div className="media-card">
                  <h3><i className="fa-solid fa-signature"></i> Signature (300 x 80 px)</h3>
                  <p className="media-sub">Auto-resized &amp; cropped to strict 300x80 px.</p>
                  <div className="image-preview-container sign-box">
                    <img src={signPreview} alt="Candidate Signature" />
                  </div>
                  <label className="btn btn-outline btn-block">
                    <i className="fa-solid fa-file-pen"></i> Select Signature
                    <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleImagePick(e.target.files?.[0], 300, 80, 'signature')} />
                  </label>
                  <div className={`dimension-status ${signBlob ? 'valid' : ''}`}>{signStatus}</div>
                </div>
              </div>

              <div className="form-actions" style={{ marginTop: 18 }}>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  <i className="fa-solid fa-floppy-disk"></i> {saving ? 'Saving Profile...' : 'Save Customer Profile'}
                </button>
                <button type="button" className="btn btn-outline" onClick={resetParser} disabled={saving}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
