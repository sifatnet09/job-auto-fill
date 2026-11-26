import React, { useState, useEffect, useCallback } from 'react';
import { API } from '../services/api.js';
import { ImageHelper } from '../services/imageHelper.js';

function emptyCustomerForm() {
  return {
    id: '',
    jobCategory: 'All Job Pdf',
    applicantName: '',
    applicantNameBn: '',
    fatherName: '',
    fatherNameBn: '',
    motherName: '',
    motherNameBn: '',
    dob: '',
    gender: 'Male',
    religion: 'Islam',
    nid: '',
    email: '',
    mobile: '',
    maritalStatus: 'Single',
    spouseName: '',
    quota: 'Not Applicable',
    presentAddress: { careOf: '', village: '', district: '', upazila: '', postOffice: '', postCode: '' },
    ssc: { examination: '', board: '', roll: '', group: '', result: '', passingYear: '' },
    hsc: { examination: '', board: '', roll: '', group: '', result: '', passingYear: '' },
    graduation: { examination: '', institute: '', subject: '', result: '', passingYear: '', duration: '' },
    masters: { examination: '', institute: '', subject: '', result: '', passingYear: '', duration: '' }
  };
}

export default function CustomerModal({ customerId, initialCustomer = null, isOpen, isNew, onClose, onSaved, showToast }) {
  const [activeTab, setActiveTab] = useState('info');
  const [form, setForm] = useState(emptyCustomerForm());
  const [files, setFiles] = useState([]);

  const [photoPreview, setPhotoPreview] = useState('/images/placeholder_photo.png');
  const [photoStatus, setPhotoStatus] = useState('Not uploaded');
  const [pendingPhotoBlob, setPendingPhotoBlob] = useState(null);

  const [signPreview, setSignPreview] = useState('/images/placeholder_sign.png');
  const [signStatus, setSignStatus] = useState('Not uploaded');
  const [pendingSignBlob, setPendingSignBlob] = useState(null);

  const applyCustomerToState = useCallback((c) => {
    setForm({
      id: c.id,
      jobCategory: c.jobCategory || 'All Job Pdf',
      applicantName: c.applicantName || '',
      applicantNameBn: c.applicantNameBn || '',
      fatherName: c.fatherName || '',
      fatherNameBn: c.fatherNameBn || '',
      motherName: c.motherName || '',
      motherNameBn: c.motherNameBn || '',
      dob: c.dob || '',
      gender: c.gender || 'Male',
      religion: c.religion || 'Islam',
      nid: c.nid || '',
      email: c.email || '',
      mobile: c.mobile || '',
      maritalStatus: c.maritalStatus || 'Single',
      spouseName: c.spouseName || '',
      quota: c.quota || 'Not Applicable',
      presentAddress: { careOf: '', village: '', district: '', upazila: '', postOffice: '', postCode: '', ...(c.presentAddress || {}) },
      ssc: { examination: '', board: '', roll: '', group: '', result: '', passingYear: '', ...(c.education?.ssc || {}) },
      hsc: { examination: '', board: '', roll: '', group: '', result: '', passingYear: '', ...(c.education?.hsc || {}) },
      graduation: { examination: '', institute: '', subject: '', result: '', passingYear: '', duration: '', ...(c.education?.graduation || {}) },
      masters: { examination: '', institute: '', subject: '', result: '', passingYear: '', duration: '', ...(c.education?.masters || {}) }
    });
    setFiles(Array.isArray(c.files) ? c.files : []);
    setPhotoPreview(c.photoUrl || '/images/placeholder_photo.png');
    setPhotoStatus(c.photoUrl ? 'Verified: 300 x 300 px' : 'Not uploaded');
    setSignPreview(c.signatureUrl || '/images/placeholder_sign.png');
    setSignStatus(c.signatureUrl ? 'Verified: 300 x 80 px' : 'Not uploaded');
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setActiveTab('info');
    setPendingPhotoBlob(null);
    setPendingSignBlob(null);

    if (isNew || !customerId) {
      setForm(emptyCustomerForm());
      setFiles([]);
      setPhotoPreview('/images/placeholder_photo.png');
      setSignPreview('/images/placeholder_sign.png');
      setPhotoStatus('Not uploaded (Save profile first)');
      setSignStatus('Not uploaded (Save profile first)');
      return;
    }

    if (initialCustomer && initialCustomer.id === customerId) {
      applyCustomerToState(initialCustomer);
      return;
    }

    (async () => {
      try {
        const res = await API.getCustomerById(customerId);
        applyCustomerToState(res.customer);
      } catch (err) {
        alert(`Failed to load customer: ${err.message}`);
        onClose();
      }
    })();
  }, [isOpen, isNew, customerId, initialCustomer, applyCustomerToState, onClose]);

  if (!isOpen) return null;

  const updateField = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const updateAddr = (k, v) => setForm((f) => ({ ...f, presentAddress: { ...f.presentAddress, [k]: v } }));
  const updateEdu = (lvl, k, v) => setForm((f) => ({ ...f, [lvl]: { ...f[lvl], [k]: v } }));

  const handleSave = async (e) => {
    e.preventDefault();
    const payload = {
      applicantName: form.applicantName.trim(),
      applicantNameBn: form.applicantNameBn.trim(),
      fatherName: form.fatherName.trim(),
      fatherNameBn: form.fatherNameBn.trim(),
      motherName: form.motherName.trim(),
      motherNameBn: form.motherNameBn.trim(),
      dob: form.dob,
      gender: form.gender,
      religion: form.religion,
      nid: form.nid.trim(),
      email: form.email.trim(),
      mobile: form.mobile.trim(),
      maritalStatus: form.maritalStatus,
      spouseName: form.spouseName.trim(),
      quota: form.quota.trim(),
      jobCategory: form.jobCategory || 'All Job Pdf',
      presentAddress: form.presentAddress,
      permanentAddress: { ...form.presentAddress, sameAsPresent: true },
      education: {
        ssc: (form.ssc.examination || form.ssc.roll) ? { ...form.ssc, resultType: 'GPA(out of 5)' } : null,
        hsc: (form.hsc.examination || form.hsc.roll) ? { ...form.hsc, resultType: 'GPA(out of 5)' } : null,
        graduation: (form.graduation.examination || form.graduation.institute || form.graduation.result) ? { ...form.graduation, resultType: /class/i.test(form.graduation.result) ? form.graduation.result : 'CGPA(out of 4)', duration: form.graduation.duration || '4 Years' } : null,
        masters: (form.masters.examination || form.masters.institute || form.masters.result) ? { ...form.masters, resultType: /class/i.test(form.masters.result) ? form.masters.result : 'CGPA(out of 4)', duration: form.masters.duration || '1 Year' } : null
      }
    };

    try {
      if (form.id) {
        await API.updateCustomer(form.id, payload);
        showToast('Customer profile updated.');
      } else {
        const res = await API.createCustomer(payload);
        updateField('id', res.customer.id);
        showToast(`New customer profile created: ${res.customer.id}`);
      }
      onSaved();
      onClose();
    } catch (err) {
      alert(`Save error: ${err.message}`);
    }
  };

  const handleCrop = async (file, w, h, kind) => {
    if (!file) return;
    try {
      showToast(`Processing ${kind} to strict ${w}x${h} px...`);
      const resized = await ImageHelper.resizeToExact(file, w, h);
      if (kind === 'photo') {
        setPendingPhotoBlob(resized.blob);
        setPhotoPreview(resized.dataUrl);
        setPhotoStatus(`Valid: ${w}x${h} px Ready`);
      } else {
        setPendingSignBlob(resized.blob);
        setSignPreview(resized.dataUrl);
        setSignStatus(`Valid: ${w}x${h} px Ready`);
      }
    } catch (err) {
      alert(`Image error: ${err.message}`);
    }
  };

  const uploadMedia = async (kind) => {
    if (!form.id) {
      alert('Please save the profile first before uploading media.');
      return;
    }
    try {
      const res = kind === 'photo'
        ? await API.uploadPhoto(form.id, pendingPhotoBlob)
        : await API.uploadSignature(form.id, pendingSignBlob);
      showToast(res.message);
      if (kind === 'photo') setPendingPhotoBlob(null);
      else setPendingSignBlob(null);
      onSaved();
    } catch (err) {
      alert(`Upload failed: ${err.message}`);
    }
  };

  const handleFileUpload = async (file) => {
    if (!file) return;
    if (!form.id) {
      alert('Please save the customer profile first before uploading files.');
      return;
    }
    try {
      showToast(`Uploading "${file.name}" to storage...`);
      const res = await API.uploadCustomerFile(form.id, file);
      if (res.customer?.files) setFiles(res.customer.files);
      showToast(res.message || 'File saved!');
      onSaved();
    } catch (err) {
      alert(`File upload failed: ${err.message}`);
    }
  };

  const handleFileDelete = async (fileId) => {
    if (!window.confirm('Remove this file from storage?')) return;
    try {
      const res = await API.deleteCustomerFile(form.id, fileId);
      if (res.customer?.files) setFiles(res.customer.files);
      showToast('File removed successfully.');
      onSaved();
    } catch (err) {
      alert(`Failed to remove file: ${err.message}`);
    }
  };

  return (
    <div id="customer-modal" className="modal-backdrop" style={{ display: 'flex' }}>
      <div className="modal-dialog modal-large">
        <div className="modal-header">
          <h2 id="customer-modal-title">
            {form.id ? `Customer: ${form.applicantName} (${form.id})` : 'Create New Customer Profile'}
          </h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-body">
          <div className="customer-modal-tabs">
            <button
              className={`modal-tab-btn ${activeTab === 'info' ? 'active' : ''}`}
              onClick={() => setActiveTab('info')}
            >
              Profile Information
            </button>
            <button
              className={`modal-tab-btn ${activeTab === 'media' ? 'active' : ''}`}
              onClick={() => setActiveTab('media')}
            >
              Photo, Signature &amp; R2 Files
            </button>
          </div>

          {activeTab === 'info' ? (
            <form id="customer-edit-form" onSubmit={handleSave}>
              <div className="form-row">
                <div className="form-group flex-1">
                  <label>Unique Customer ID</label>
                  <input className="form-control" readOnly value={form.id || '(Auto Generated: TTC-0001+)'} style={{ fontWeight: 700, background: '#f1f5f9' }} />
                </div>
                <div className="form-group flex-1">
                  <label>Phone Number *</label>
                  <input type="tel" className="form-control" required value={form.mobile} onChange={(e) => updateField('mobile', e.target.value)} />
                </div>
                <div className="form-group flex-1">
                  <label>Job Category</label>
                  <select className="form-control" value={form.jobCategory || 'All Job Pdf'} onChange={(e) => updateField('jobCategory', e.target.value)}>
                    <option value="All Job Pdf">All Job Pdf</option>
                    <option value="Army Job">Army Job</option>
                    <option value="Navy Job">Navy Job</option>
                    <option value="Air Force Job">Air Force Job</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group flex-1"><label>Applicant Name (English) *</label><input className="form-control" required value={form.applicantName} onChange={(e) => updateField('applicantName', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Applicant Name (বাংলা)</label><input className="form-control" value={form.applicantNameBn} onChange={(e) => updateField('applicantNameBn', e.target.value)} /></div>
              </div>
              <div className="form-row">
                <div className="form-group flex-1"><label>Father&apos;s Name (English)</label><input className="form-control" value={form.fatherName} onChange={(e) => updateField('fatherName', e.target.value)} /></div>
                <div className="form-group flex-1"><label>পিতার নাম (বাংলা)</label><input className="form-control" value={form.fatherNameBn} onChange={(e) => updateField('fatherNameBn', e.target.value)} /></div>
              </div>
              <div className="form-row">
                <div className="form-group flex-1"><label>Mother&apos;s Name (English)</label><input className="form-control" value={form.motherName} onChange={(e) => updateField('motherName', e.target.value)} /></div>
                <div className="form-group flex-1"><label>মাতার নাম (বাংলা)</label><input className="form-control" value={form.motherNameBn} onChange={(e) => updateField('motherNameBn', e.target.value)} /></div>
              </div>

              <div className="form-row">
                <div className="form-group flex-1"><label>Date of Birth</label><input type="date" className="form-control" value={form.dob} onChange={(e) => updateField('dob', e.target.value)} /></div>
                <div className="form-group flex-1">
                  <label>Gender</label>
                  <select className="form-control" value={form.gender} onChange={(e) => updateField('gender', e.target.value)}>
                    <option value="Male">Male</option><option value="Female">Female</option><option value="Third Gender">Third Gender</option>
                  </select>
                </div>
                <div className="form-group flex-1">
                  <label>Religion</label>
                  <select className="form-control" value={form.religion} onChange={(e) => updateField('religion', e.target.value)}>
                    <option value="Islam">Islam</option><option value="Hinduism">Hinduism</option><option value="Buddhism">Buddhism</option><option value="Christianity">Christianity</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group flex-1"><label>NID Number</label><input className="form-control" value={form.nid} onChange={(e) => updateField('nid', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Email</label><input type="email" className="form-control" value={form.email} onChange={(e) => updateField('email', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Quota</label><input className="form-control" value={form.quota} onChange={(e) => updateField('quota', e.target.value)} /></div>
              </div>

              <h3 className="section-heading">Present Address</h3>
              <div className="form-row">
                <div className="form-group flex-1"><label>Care Of</label><input className="form-control" value={form.presentAddress.careOf} onChange={(e) => updateAddr('careOf', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Village / House</label><input className="form-control" value={form.presentAddress.village} onChange={(e) => updateAddr('village', e.target.value)} /></div>
                <div className="form-group flex-1"><label>District</label><input className="form-control" value={form.presentAddress.district} onChange={(e) => updateAddr('district', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Upazila</label><input className="form-control" value={form.presentAddress.upazila} onChange={(e) => updateAddr('upazila', e.target.value)} /></div>
              </div>
              <div className="form-row">
                <div className="form-group flex-1"><label>Post Office</label><input className="form-control" value={form.presentAddress.postOffice} onChange={(e) => updateAddr('postOffice', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Post Code</label><input className="form-control" value={form.presentAddress.postCode} onChange={(e) => updateAddr('postCode', e.target.value)} /></div>
              </div>

              <h3 className="section-heading">Education Qualifications</h3>
              <div className="form-row">
                <div className="form-group flex-1"><label>SSC Exam</label><input className="form-control" value={form.ssc.examination} onChange={(e) => updateEdu('ssc', 'examination', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Board</label><input className="form-control" value={form.ssc.board} onChange={(e) => updateEdu('ssc', 'board', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Roll</label><input className="form-control" value={form.ssc.roll} onChange={(e) => updateEdu('ssc', 'roll', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Group</label><input className="form-control" value={form.ssc.group} onChange={(e) => updateEdu('ssc', 'group', e.target.value)} /></div>
                <div className="form-group flex-1"><label>GPA</label><input className="form-control" value={form.ssc.result} onChange={(e) => updateEdu('ssc', 'result', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Year</label><input className="form-control" value={form.ssc.passingYear} onChange={(e) => updateEdu('ssc', 'passingYear', e.target.value)} /></div>
              </div>
              <div className="form-row">
                <div className="form-group flex-1"><label>HSC Exam</label><input className="form-control" value={form.hsc.examination} onChange={(e) => updateEdu('hsc', 'examination', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Board</label><input className="form-control" value={form.hsc.board} onChange={(e) => updateEdu('hsc', 'board', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Roll</label><input className="form-control" value={form.hsc.roll} onChange={(e) => updateEdu('hsc', 'roll', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Group</label><input className="form-control" value={form.hsc.group} onChange={(e) => updateEdu('hsc', 'group', e.target.value)} /></div>
                <div className="form-group flex-1"><label>GPA</label><input className="form-control" value={form.hsc.result} onChange={(e) => updateEdu('hsc', 'result', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Year</label><input className="form-control" value={form.hsc.passingYear} onChange={(e) => updateEdu('hsc', 'passingYear', e.target.value)} /></div>
              </div>
              <div className="form-row">
                <div className="form-group flex-1"><label>Graduation</label><input className="form-control" placeholder="B.Sc / B.A" value={form.graduation.examination} onChange={(e) => updateEdu('graduation', 'examination', e.target.value)} /></div>
                <div className="form-group flex-1"><label>University</label><input className="form-control" value={form.graduation.institute} onChange={(e) => updateEdu('graduation', 'institute', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Subject</label><input className="form-control" value={form.graduation.subject} onChange={(e) => updateEdu('graduation', 'subject', e.target.value)} /></div>
                <div className="form-group flex-1"><label>CGPA</label><input className="form-control" value={form.graduation.result} onChange={(e) => updateEdu('graduation', 'result', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Year</label><input className="form-control" value={form.graduation.passingYear} onChange={(e) => updateEdu('graduation', 'passingYear', e.target.value)} /></div>
                <div className="form-group flex-1"><label>Duration</label><input className="form-control" value={form.graduation.duration} onChange={(e) => updateEdu('graduation', 'duration', e.target.value)} /></div>
              </div>

              <div className="modal-footer" style={{ paddingTop: 14 }}>
                <button type="submit" className="btn btn-primary">Save Profile Changes</button>
                <button type="button" className="btn btn-outline" onClick={onClose}>Close</button>
              </div>
            </form>
          ) : (
            <div className="modal-tab-pane active">
              <div className="media-upload-grid">
                <div className="media-card">
                  <h3><i className="fa-solid fa-image"></i> Photo (Strictly 300 x 300 px)</h3>
                  <p className="media-sub">Official Teletalk &amp; BD Govt standard size.</p>
                  <div className="image-preview-container photo-box">
                    <img src={photoPreview} alt="Candidate Photo" />
                  </div>
                  <div className="image-crop-tool">
                    <label className="btn btn-outline btn-block">
                      <i className="fa-solid fa-file-image"></i> Select / Crop Photo to 300x300
                      <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleCrop(e.target.files?.[0], 300, 300, 'photo')} />
                    </label>
                    {pendingPhotoBlob && (
                      <button type="button" className="btn btn-primary btn-block" style={{ marginTop: 6 }} onClick={() => uploadMedia('photo')}>
                        <i className="fa-solid fa-cloud-arrow-up"></i> Upload 300x300 Photo
                      </button>
                    )}
                  </div>
                  <div className={`dimension-status ${pendingPhotoBlob ? 'valid' : ''}`}>{photoStatus}</div>
                </div>

                <div className="media-card">
                  <h3><i className="fa-solid fa-signature"></i> Signature (Strictly 300 x 80 px)</h3>
                  <p className="media-sub">Official Teletalk &amp; BD Govt standard size.</p>
                  <div className="image-preview-container sign-box">
                    <img src={signPreview} alt="Candidate Signature" />
                  </div>
                  <div className="image-crop-tool">
                    <label className="btn btn-outline btn-block">
                      <i className="fa-solid fa-file-pen"></i> Select / Crop Signature to 300x80
                      <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleCrop(e.target.files?.[0], 300, 80, 'signature')} />
                    </label>
                    {pendingSignBlob && (
                      <button type="button" className="btn btn-primary btn-block" style={{ marginTop: 6 }} onClick={() => uploadMedia('signature')}>
                        <i className="fa-solid fa-cloud-arrow-up"></i> Upload 300x80 Signature
                      </button>
                    )}
                  </div>
                  <div className={`dimension-status ${pendingSignBlob ? 'valid' : ''}`}>{signStatus}</div>
                </div>
              </div>

              <div style={{ marginTop: 20, border: '1px solid var(--border)', borderRadius: 12, padding: 16, background: '#f8fafc' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
                  <div>
                    <h3 style={{ fontSize: 14, fontWeight: 700 }}><i className="fa-solid fa-folder-open text-primary"></i> Customer Files &amp; Documents (Cloudflare R2)</h3>
                    <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>Upload NID, Certificates, PDFs — saved per Customer ID on R2 &amp; filename linked in Firestore.</p>
                  </div>
                  <label className="btn btn-sm btn-primary" style={{ cursor: 'pointer' }}>
                    <i className="fa-solid fa-cloud-arrow-up"></i> Upload File / PDF
                    <input
                      type="file"
                      accept=".pdf,image/*,.doc,.docx"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        if (e.target.files?.[0]) handleFileUpload(e.target.files[0]);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5 }}>
                  {files.length === 0 ? (
                    <div className="text-muted">No extra files uploaded for this customer yet.</div>
                  ) : (
                    files.map((f) => (
                      <div
                        key={f.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 10,
                          background: '#ffffff',
                          border: '1px solid var(--border)',
                          padding: '8px 12px',
                          borderRadius: 8
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <i className="fa-solid fa-file-lines text-primary"></i>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.fileName}</div>
                            <div style={{ fontSize: 11, color: '#64748b' }}>
                              {f.size ? `${Math.max(1, Math.round(f.size / 1024))} KB` : ''} {f.uploadedAt ? `• ${new Date(f.uploadedAt).toLocaleString()}` : ''}
                            </div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                          <a href={f.url} target="_blank" rel="noreferrer" className="btn btn-sm btn-outline">
                            <i className="fa-solid fa-arrow-up-right-from-square"></i> View
                          </a>
                          <button type="button" className="btn btn-sm btn-outline text-danger" onClick={() => handleFileDelete(f.id)}>
                            <i className="fa-solid fa-trash"></i>
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
