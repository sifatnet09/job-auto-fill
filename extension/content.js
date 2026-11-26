/**
 * GovJob AutoFill - Content Script Engine
 * Automatically maps and fills Bangladeshi Government job forms (Teletalk & generic portals)
 */

(function () {
  'use strict';

  if (window.__GovJobAutoFillLoaded) return;
  window.__GovJobAutoFillLoaded = true;

  let cachedProfile = null;
  let cachedCustomerId = null;
  let floatingWidgetEl = null;
  let lastFilledCount = 0;
  let didAutoFillThisPage = false;

  // Initialize from Chrome storage
  chrome.storage.local.get(['cachedCustomer', 'lastCustomerId', 'showFloatingWidget', 'widgetExpanded'], (res) => {
    if (res.cachedCustomer) {
      cachedProfile = res.cachedCustomer.data;
      cachedCustomerId = res.cachedCustomer.customerId || res.lastCustomerId;
    }

    if (res.showFloatingWidget !== false) {
      injectFloatingWidget(res.widgetExpanded === true);
    }

    // Automatically attach Customer Photo & Signature on 2nd page if Page 1 was autofilled in this tab session
    if (
      cachedProfile &&
      cachedCustomerId &&
      sessionStorage.getItem('govfill_autofill_session') === cachedCustomerId &&
      hasMediaFileInputs()
    ) {
      setTimeout(() => {
        attachMediaFilesToPage(cachedProfile, true);
      }, 500);
    }
  });

  setupSubmitTracking();

  // Listen for messages from extension popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'OPEN_PERSISTENT_WIDGET') {
      if (request.customer) cachedProfile = request.customer;
      if (request.customerId) cachedCustomerId = request.customerId;
      if (!floatingWidgetEl) injectFloatingWidget(true);
      else expandFloatingWidget();
      updateFloatingWidgetInfo();
      sendResponse({ success: true });
      return false;
    }

    if (request.action === 'AUTOFILL_GOV_FORM') {
      const data = request.customer || cachedProfile;
      const custId = request.customerId || cachedCustomerId;

      if (!data) {
        sendResponse({ success: false, message: 'No customer data loaded. Please select a customer in the extension.' });
        return false;
      }

      cachedProfile = data;
      cachedCustomerId = custId;
      updateFloatingWidgetInfo();

      const result = executeAutoFill(data);
      sendResponse(result);
      return false;
    }
  });

  /**
   * Scrapes Post Name & Organization from the target portal and notifies the Dashboard
   */
  function extractPortalMetadata() {
    const postInput = document.querySelector('input[name="post_name"]');
    const jobTitleEl = document.querySelector('[data-automation-id="jobTitle"], .job-title, h1');
    const jobTitle = (postInput && postInput.value) ||
      (jobTitleEl && jobTitleEl.innerText.trim()) ||
      (document.title || 'Govt Job Application').split('|')[0].trim();

    const orgEl = document.querySelector('.org-details h3, [data-automation-id="company"], .company-name');
    let organization = orgEl ? orgEl.innerText.trim() : '';
    if (!organization) {
      const host = window.location.hostname.replace(/^www\./, '');
      organization = host.includes('teletalk.com.bd')
        ? `${host.split('.')[0].toUpperCase()} (Teletalk)`
        : host;
    }

    return { jobTitle, organization, portalUrl: window.location.href };
  }

  function trackApplyOnServer(actionType, filledCount) {
    // Only track if AutoFill actually ran on THIS page
    if (!didAutoFillThisPage || !cachedCustomerId) return;
    const meta = extractPortalMetadata();
    try {
      chrome.runtime.sendMessage({
        action: 'TRACK_APPLY',
        payload: {
          customerId: cachedCustomerId,
          applicantName: cachedProfile?.name || '',
          mobile: cachedProfile?.mobile || '',
          jobTitle: meta.jobTitle,
          organization: meta.organization,
          portalUrl: meta.portalUrl,
          filledCount: filledCount || lastFilledCount || 0,
          actionType
        }
      });
    } catch (e) {
      // ignore if extension context invalidated
    }
  }

  function setupSubmitTracking() {
    let lastSubmitAt = 0;
    const recordSubmit = () => {
      const now = Date.now();
      if (now - lastSubmitAt < 4000) return;
      // Strict guard: never track random pages where AutoFill was NOT used
      if (!didAutoFillThisPage || !cachedCustomerId) return;
      lastSubmitAt = now;
      trackApplyOnServer('submitted', lastFilledCount);
    };

    document.addEventListener('submit', recordSubmit, true);
    document.addEventListener('click', (e) => {
      if (!didAutoFillThisPage) return;
      const btn = e.target.closest('button, input[type="submit"]');
      if (!btn) return;
      const label = (btn.innerText || btn.value || '').toLowerCase();
      if (label.includes('submit') || label.includes('apply') || label.includes('confirm')) {
        recordSubmit();
      }
    }, true);
  }

  /**
   * Main Form Auto-Fill Executor
   */
  function executeAutoFill(data) {
    let filledCount = 0;

    filledCount = fillTeletalkForm(data);
    if (filledCount === 0) {
      filledCount = fillGenericGovForm(data);
    }

    const hasFiles = hasMediaFileInputs();
    if (hasFiles && (data.photoUrl || data.signatureUrl)) {
      didAutoFillThisPage = true;
      if (cachedCustomerId) sessionStorage.setItem('govfill_autofill_session', cachedCustomerId);
      attachMediaFilesToPage(data, false);
    }

    if (filledCount > 0) {
      didAutoFillThisPage = true;
      if (cachedCustomerId) sessionStorage.setItem('govfill_autofill_session', cachedCustomerId);
      lastFilledCount = filledCount;
      trackApplyOnServer('autofill', filledCount);
      showToast(`✨ Successfully auto-filled ${filledCount} fields & tracked this page!`);
    } else if (!hasFiles) {
      showToast('⚠️ No compatible form fields found on this page.');
    }

    return { success: filledCount > 0 || hasFiles, filledCount };
  }

  /**
   * Teletalk Official Recruitment Application Form Auto-Filler
   */
  function fillTeletalkForm(d) {
    let count = 0;

    // 1. Basic Information (exact selectors OR section/label fallback)
    count += setOrLabelField('#name, [name="name"]', ['applicant\'s name', 'applicant name', 'candidate name', 'full name'], d.name, 'general', ['father', 'mother', 'spouse', 'bangla', 'বাংলা']);
    count += setOrLabelField('#name_bn, [name="name_bn"]', ['আবেদনকারীর নাম', 'name (bangla)', 'applicant name (bn)'], d.name_bn, 'general');
    count += setOrLabelField('#father, [name="father"]', ['father\'s name', 'father name'], d.father, 'general', ['bangla', 'বাংলা', 'পিতার']);
    count += setOrLabelField('#father_bn, [name="father_bn"]', ['পিতার নাম', 'father name (bn)'], d.father_bn, 'general');
    count += setOrLabelField('#mother, [name="mother"]', ['mother\'s name', 'mother name'], d.mother, 'general', ['bangla', 'বাংলা', 'মাতার']);
    count += setOrLabelField('#mother_bn, [name="mother_bn"]', ['মাতার নাম', 'mother name (bn)'], d.mother_bn, 'general');
    count += setOrLabelField('#dob, [name="dob"]', ['date of birth', 'birth date', 'dob'], d.dob, 'general');

    // 2. Nationality, Religion, Gender
    count += setOrLabelSelect('#nationality, [name="nationality"]', ['nationality'], d.nationality || 'Bangladeshi', 'general');
    count += setOrLabelSelect('#religion, [name="religion"]', ['religion'], d.religion || '1', 'general');
    count += setOrLabelSelect('#gender, [name="gender"]', ['gender', 'sex'], d.gender || 'Female', 'general');

    // 3. NID, Birth Reg, Passport
    if (d.nid) {
      count += setOrLabelSelect('#nid, [name="nid"]', ['national id'], ['1', 'Yes'], 'general');
      setTimeout(() => {
        setOrLabelField('#nid_no, [name="nid_no"], #nid_number, [name="nid_number"]', ['national id no', 'nid no', 'national id'], d.nid, 'general');
      }, 200);
    } else {
      setOrLabelSelect('#nid, [name="nid"]', ['national id'], ['0', 'No'], 'general');
    }

    setOrLabelSelect('#breg, [name="breg"]', ['birth registration'], d.birth_reg ? ['1', 'Yes'] : ['0', 'No'], 'general');
    if (d.birth_reg) {
      setTimeout(() => setOrLabelField('#breg_no, [name="breg_no"]', ['birth registration no', 'birth reg'], d.birth_reg, 'general'), 200);
    }

    setOrLabelSelect('#passport, [name="passport"]', ['passport'], d.passport ? ['1', 'Yes'] : ['0', 'No'], 'general');
    if (d.passport) {
      setTimeout(() => setOrLabelField('#passport_no, [name="passport_no"]', ['passport no', 'passport id'], d.passport, 'general'), 200);
    }

    // 4. Marital Status & Spouse
    count += setOrLabelSelect('#marital_status, [name="marital_status"]', ['marital status'], d.marital_status || 'Single', 'general');
    if (d.marital_status === 'Married' && d.spouse_name) {
      setTimeout(() => {
        setOrLabelField('#spouse_name, [name="spouse_name"]', ['spouse name', 'spouse'], d.spouse_name, 'general');
      }, 200);
    }

    // 5. Contact (Mobile & Email)
    count += setOrLabelField('#mobile, [name="mobile"]', ['mobile number', 'mobile no', 'phone number'], d.mobile, 'general', ['confirm', 're-type']);
    count += setOrLabelField('#confirm_mobile, [name="confirm_mobile"]', ['confirm mobile', 're-type mobile'], d.mobile, 'general');
    count += setOrLabelField('#email, [name="email"]', ['e-mail', 'email'], d.email, 'general');

    // 6. Quota & Departmental Status
    const quotaCandidates = /not\s*applicable/i.test(d.quota || '') ? [d.quota, 'Not Applicable', 'Non Quota', 'None', '8'] : [d.quota || '8'];
    const depCandidates = /not\s*applicable/i.test(d.departmental_status || d.dep_status || '') ? ['Not Applicable', 'None', '5'] : [d.departmental_status || d.dep_status || '5'];
    count += setOrLabelSelect('#quota, [name="quota"]', ['quota'], quotaCandidates, 'general');
    count += setOrLabelSelect('#dep_status, [name="dep_status"], #departmental_status, [name="departmental_status"]', ['departmental status'], depCandidates, 'general');

    // 7. Present Address (Section + Label aware across all Teletalk/custom table or div layouts)
    const presCareOf = d.present_care_of || d.present_careof || d.father || '';
    const presVillage = d.present_village || '';
    const presDistrict = d.present_district_code || d.present_district || '';
    const presUpazila = d.present_upazila_code || d.present_upazila || '';
    const presPostOffice = d.present_post_office || d.present_post || '';
    const presPostCode = d.present_post_code || d.present_postcode || '';

    count += setOrLabelField(
      '#present_careof, [name="present_careof"], #present_care_of, [name="present_care_of"], #pre_careof, [name="pre_careof"], #present_c_o, [name="present_c_o"], [id*="present"][id*="care"], [name*="present"][name*="care"]',
      ['care of', 'c/o'],
      presCareOf,
      'present'
    );
    count += setOrLabelField(
      '#present_village, [name="present_village"], #present_vill, [name="present_vill"], #pre_village, [name="pre_village"], #present_road, [name="present_road"], [id*="present"][id*="vill"], [name*="present"][name*="vill"], [id*="present"][id*="house"], [name*="present"][name*="house"]',
      ['village', 'vill/', 'road', 'house', 'flat'],
      presVillage,
      'present'
    );
    count += setOrLabelSelect(
      '#present_district, [name="present_district"], #pre_district, [name="pre_district"], #menu_one, [name="menu_one"], [id*="present"][id*="dist"], [name*="present"][name*="dist"]',
      ['district'],
      presDistrict,
      'present'
    );
    count += setOrLabelField(
      '#present_post, [name="present_post"], #present_postoffice, [name="present_postoffice"], #present_post_office, [name="present_post_office"], #pre_post, [name="pre_post"], [id*="present"][id*="post"]:not([id*="code"]), [name*="present"][name*="post"]:not([name*="code"])',
      ['post office'],
      presPostOffice,
      'present',
      ['post code', 'postal']
    );
    count += setOrLabelField(
      '#present_postcode, [name="present_postcode"], #present_post_code, [name="present_post_code"], #present_pcode, [name="present_pcode"], #pre_postcode, [name="pre_postcode"], [id*="present"][id*="postcode"], [name*="present"][name*="postcode"], [id*="present"][id*="post_code"], [name*="present"][name*="post_code"]',
      ['post code', 'postal code', 'postcode'],
      presPostCode,
      'present'
    );

    // Poll Upazila dropdown (Teletalk populates Upazila via AJAX after District change)
    waitAndSelectUpazila(
      '#present_upazila, [name="present_upazila"], #present_ps, [name="present_ps"], #present_thana, [name="present_thana"], #pre_upazila, [name="pre_upazila"], #menu_two, [name="menu_two"], [id*="present"][id*="upazila"], [name*="present"][name*="upazila"], [id*="present"][id*="ps"], [name*="present"][name*="ps"]',
      ['upazila', 'thana', 'p.s'],
      presUpazila,
      'present',
      () => {
        // 8. Permanent Address — run AFTER Present Upazila finishes loading!
        const permCareOf = d.permanent_care_of || d.permanent_careof || presCareOf;
        const permVillage = d.permanent_village || presVillage;
        const permDistrict = d.permanent_district || presDistrict;
        const permUpazila = d.permanent_upazila || presUpazila;
        const permPostOffice = d.permanent_post_office || d.permanent_post || presPostOffice;
        const permPostCode = d.permanent_post_code || d.permanent_postcode || presPostCode;

        const sameChk = findSameAsPresentCheckbox();
        const shouldUseSame = d.same_as_present !== false || (!d.permanent_district && !d.permanent_village);

        if (shouldUseSame && sameChk) {
          if (!sameChk.checked) {
            sameChk.click();
            if (!sameChk.checked) {
              sameChk.checked = true;
              sameChk.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
          highlight(sameChk);
        } else {
          setOrLabelField(
            '#permanent_careof, [name="permanent_careof"], #permanent_care_of, [name="permanent_care_of"], #per_careof, [name="per_careof"]',
            ['care of', 'c/o'],
            permCareOf,
            'permanent'
          );
          setOrLabelField(
            '#permanent_village, [name="permanent_village"], #permanent_vill, [name="permanent_vill"], #per_village, [name="per_village"]',
            ['village', 'vill/', 'road', 'house', 'flat'],
            permVillage,
            'permanent'
          );
          setOrLabelSelect(
            '#permanent_district, [name="permanent_district"], #per_district, [name="per_district"]',
            ['district'],
            permDistrict,
            'permanent'
          );
          waitAndSelectUpazila(
            '#permanent_upazila, [name="permanent_upazila"], #permanent_ps, [name="permanent_ps"], #per_upazila, [name="per_upazila"]',
            ['upazila', 'thana', 'p.s'],
            permUpazila,
            'permanent'
          );
          setOrLabelField(
            '#permanent_post, [name="permanent_post"], #permanent_post_office, [name="permanent_post_office"], #per_post, [name="per_post"]',
            ['post office'],
            permPostOffice,
            'permanent',
            ['post code', 'postal']
          );
          setOrLabelField(
            '#permanent_postcode, [name="permanent_postcode"], #permanent_post_code, [name="permanent_post_code"], #per_postcode, [name="per_postcode"]',
            ['post code', 'postal code', 'postcode'],
            permPostCode,
            'permanent'
          );
        }
      }
    );

    // 9. Class Eight / JSC / JDC
    if (d.education?.jsc && (d.education.jsc.examination || d.education.jsc.roll || d.education.jsc.institute)) {
      const jsc = d.education.jsc;
      const jscChk = document.querySelector('#if_applicable_jsc, [name="if_applicable_jsc"], #jsc_applicable, [name="jsc_applicable"], #jsc_if_applicable, [name="jsc_if_applicable"], #if_applicable_eight, [name="if_applicable_eight"], #eight_applicable, [name="eight_applicable"]');
      const jscToggled = Boolean(jscChk && !jscChk.checked);
      if (jscToggled) { jscChk.click(); count++; }

      const fillJsc = () => {
        count += setEduSelect(
          '#jsc_exam, [name="jsc_exam"], #eight_exam, [name="eight_exam"]',
          ['examination', 'exam'],
          [jsc.examination, 'JSC', 'Class Eight', 'J.S.C', '3', '1'],
          'jsc'
        );
        count += setEduField(
          '#jsc_roll, [name="jsc_roll"], #eight_roll, [name="eight_roll"]',
          ['roll'],
          jsc.roll,
          'jsc'
        );
        count += setEduField(
          '#jsc_institute, [name="jsc_institute"], #jsc_school, [name="jsc_school"], #eight_institute, [name="eight_institute"]',
          ['school', 'institute'],
          jsc.institute,
          'jsc'
        );
        count += setEduSelect(
          '#jsc_board, [name="jsc_board"], #eight_board, [name="eight_board"]',
          ['board'],
          [jsc.board, 'Other'],
          'jsc'
        );
        const isJscPassed = /passed/i.test(jsc.resultType || '') || /passed/i.test(jsc.result || '');
        count += setEduSelect(
          '#jsc_result_type, [name="jsc_result_type"], #jsc_result, [name="jsc_result"], #eight_result_type, [name="eight_result_type"]',
          ['result', 'gpa'],
          isJscPassed ? ['Passed', '6'] : [jsc.resultType, 'GPA(out of 5)', 'Out of 5', '5'],
          'jsc'
        );
        if (jsc.result && !isJscPassed) {
          setTimeout(() => {
            setEduField(
              '#jsc_result, [name="jsc_result"], #jsc_gpa, [name="jsc_gpa"], #eight_result, [name="eight_result"], #eight_gpa, [name="eight_gpa"]',
              ['gpa', 'result'],
              jsc.result,
              'jsc'
            );
          }, 300);
        }
        count += setEduSelectOrField(
          '#jsc_year, [name="jsc_year"], #jsc_passing_year, [name="jsc_passing_year"], #eight_year, [name="eight_year"]',
          ['passing year', 'year'],
          jsc.passingYear,
          'jsc'
        );
      };
      if (jscToggled) setTimeout(fillJsc, 150); else fillJsc();
    }

    // 10. SSC / Dakhil / Equivalent
    if (d.education?.ssc && (d.education.ssc.examination || d.education.ssc.roll || d.education.ssc.board)) {
      const ssc = d.education.ssc;
      const sscChk = document.querySelector('#if_applicable_ssc, [name="if_applicable_ssc"]');
      const sscToggled = Boolean(sscChk && !sscChk.checked);
      if (sscToggled) { sscChk.click(); count++; }

      const fillSsc = () => {
        count += setEduSelect(
          '#ssc_exam, [name="ssc_exam"], #exam1, [name="exam1"]',
          ['examination', 'exam'],
          [ssc.examination, 'S.S.C', 'SSC', '1'],
          'ssc'
        );
        count += setEduField('#ssc_roll, [name="ssc_roll"], #roll1, [name="roll1"]', ['roll'], ssc.roll, 'ssc');
        count += setEduSelect('#ssc_board, [name="ssc_board"], #institute1, [name="institute1"], #board1, [name="board1"]', ['board'], [ssc.board], 'ssc');
        setTimeout(() => {
          setEduSelect('#ssc_group, [name="ssc_group"], #subject1, [name="subject1"], #group1, [name="group1"]', ['group', 'subject'], [ssc.group], 'ssc');
        }, 300);
        count += setEduSelect('#ssc_result_type, [name="ssc_result_type"], #result1, [name="result1"]', ['result', 'gpa'], [ssc.resultType, 'GPA(out of 5)', 'Out of 5', '5'], 'ssc');
        setTimeout(() => {
          setEduField('#ssc_result, [name="ssc_result"], #ssc_gpa, [name="ssc_gpa"], #result_gpa1, [name="result_gpa1"], #gpa1, [name="gpa1"]', ['gpa', 'result'], ssc.result, 'ssc');
        }, 300);
        count += setEduSelectOrField('#ssc_year, [name="ssc_year"], #ssc_passing_year, [name="ssc_passing_year"], #year1, [name="year1"]', ['passing year', 'year'], ssc.passingYear, 'ssc');
      };
      if (sscToggled) setTimeout(fillSsc, 150); else fillSsc();
    }

    // 11. HSC / Alim / Diploma / Equivalent
    if (d.education?.hsc && (d.education.hsc.examination || d.education.hsc.roll || d.education.hsc.board)) {
      const hsc = d.education.hsc;
      const hscChk = document.querySelector('#if_applicable_hsc, [name="if_applicable_hsc"]');
      const hscToggled = Boolean(hscChk && !hscChk.checked);
      if (hscToggled) { hscChk.click(); count++; }

      const fillHsc = () => {
        count += setEduSelect(
          '#hsc_exam, [name="hsc_exam"], #exam2, [name="exam2"]',
          ['examination', 'exam'],
          [hsc.examination, 'H.S.C', 'HSC', '1'],
          'hsc'
        );
        count += setEduField('#hsc_roll, [name="hsc_roll"], #roll2, [name="roll2"]', ['roll'], hsc.roll, 'hsc');
        count += setEduSelect('#hsc_board, [name="hsc_board"], #institute2, [name="institute2"], #board2, [name="board2"]', ['board'], [hsc.board], 'hsc');
        setTimeout(() => {
          setEduSelect('#hsc_group, [name="hsc_group"], #subject2, [name="subject2"], #group2, [name="group2"]', ['group', 'subject'], [hsc.group], 'hsc');
        }, 300);
        const isHscGpa4 = /out of 4/i.test(hsc.resultType || '') || /Diploma/i.test(hsc.examination || '');
        count += setEduSelect('#hsc_result_type, [name="hsc_result_type"], #result2, [name="result2"]', ['result', 'gpa'], [hsc.resultType, isHscGpa4 ? 'CGPA(out of 4)' : 'GPA(out of 5)', isHscGpa4 ? 'Out of 4' : 'Out of 5', isHscGpa4 ? '4' : '5'], 'hsc');
        setTimeout(() => {
          setEduField('#hsc_result, [name="hsc_result"], #hsc_gpa, [name="hsc_gpa"], #result_gpa2, [name="result_gpa2"], #gpa2, [name="gpa2"]', ['gpa', 'result'], hsc.result, 'hsc');
        }, 300);
        count += setEduSelectOrField('#hsc_year, [name="hsc_year"], #hsc_passing_year, [name="hsc_passing_year"], #year2, [name="year2"]', ['passing year', 'year'], hsc.passingYear, 'hsc');
      };
      if (hscToggled) setTimeout(fillHsc, 150); else fillHsc();
    }

    // 12. Graduation / Honours / Fazil / Degree
    if (d.education?.graduation && (d.education.graduation.examination || d.education.graduation.institute || d.education.graduation.result)) {
      const gra = d.education.graduation;
      const graChk = document.querySelector('#if_applicable_gra, [name="if_applicable_gra"], #if_applicable_grad, [name="if_applicable_grad"], #if_applicable_exam3, [name="if_applicable_exam3"]');
      const graToggled = Boolean(graChk && !graChk.checked);
      if (graToggled) { graChk.click(); count++; }

      const fillGra = () => {
        count += setEduSelect(
          '#gra_exam, [name="gra_exam"], #grad_exam, [name="grad_exam"], #exam3, [name="exam3"]',
          ['examination', 'exam'],
          [gra.examination, 'Honours', 'Honors', 'Graduation', 'Bachelor'],
          'graduation'
        );
        setTimeout(() => {
          const instSel = '#gra_institute, [name="gra_institute"], #grad_institute, [name="grad_institute"], #institute3, [name="institute3"]';
          const instOk = setEduSelectOrField(instSel, ['university', 'institute'], gra.institute, 'graduation');
          if (!instOk && gra.institute) {
            setSelectValue(instSel, 'Other');
            setTimeout(() => setInputValue('#gra_institute_other, [name="gra_institute_other"], #other_institute3, [name="other_institute3"]', gra.institute), 200);
          }
          const subjSel = '#gra_subject, [name="gra_subject"], #grad_subject, [name="grad_subject"], #subject3, [name="subject3"]';
          const subjOk = setEduSelectOrField(subjSel, ['subject', 'major', 'degree'], gra.subject, 'graduation');
          if (!subjOk && gra.subject) {
            setSelectValue(subjSel, 'Other');
            setTimeout(() => setInputValue('#gra_subject_other, [name="gra_subject_other"], #other_subject3, [name="other_subject3"]', gra.subject), 200);
          }
        }, 300);
        count += setEduSelectOrField('#gra_year, [name="gra_year"], #grad_year, [name="grad_year"], #year3, [name="year3"]', ['passing year', 'year'], gra.passingYear, 'graduation');
        count += setEduSelect('#gra_result_type, [name="gra_result_type"], #grad_result_type, [name="grad_result_type"], #result3, [name="result3"]', ['result', 'cgpa'], [gra.resultType, 'CGPA(out of 4)', 'Out of 4', '4'], 'graduation');
        setTimeout(() => {
          setEduField('#gra_result, [name="gra_result"], #grad_result, [name="grad_result"], #gra_cgpa, [name="gra_cgpa"], #result_gpa3, [name="result_gpa3"], #cgpa3, [name="cgpa3"]', ['cgpa', 'gpa', 'result'], gra.result, 'graduation');
        }, 300);
        const graDurNum = String(parseInt(gra.duration || '4', 10) || 4);
        count += setEduSelectOrField('#gra_duration, [name="gra_duration"], #grad_duration, [name="grad_duration"], #duration3, [name="duration3"]', ['duration', 'course duration'], [gra.duration, `0${graDurNum} Years`, `${graDurNum} Years`, graDurNum], 'graduation');
      };
      if (graToggled) setTimeout(fillGra, 200); else fillGra();
    }

    // 13. Masters / Kamil / Equivalent
    if (d.education?.masters && (d.education.masters.examination || d.education.masters.institute || d.education.masters.result)) {
      const mas = d.education.masters;
      const masChk = document.querySelector('#if_applicable_mas, [name="if_applicable_mas"], #if_applicable_masters, [name="if_applicable_masters"], #if_applicable_exam4, [name="if_applicable_exam4"]');
      const masToggled = Boolean(masChk && !masChk.checked);
      if (masToggled) { masChk.click(); count++; }

      const fillMas = () => {
        count += setEduSelect(
          '#mas_exam, [name="mas_exam"], #masters_exam, [name="masters_exam"], #exam4, [name="exam4"]',
          ['examination', 'exam'],
          [mas.examination, 'Masters', 'Master\'s'],
          'masters'
        );
        setTimeout(() => {
          const instSel = '#mas_institute, [name="mas_institute"], #masters_institute, [name="masters_institute"], #institute4, [name="institute4"]';
          const instOk = setEduSelectOrField(instSel, ['university', 'institute'], mas.institute, 'masters');
          if (!instOk && mas.institute) {
            setSelectValue(instSel, 'Other');
            setTimeout(() => setInputValue('#mas_institute_other, [name="mas_institute_other"], #other_institute4, [name="other_institute4"]', mas.institute), 200);
          }
          const subjSel = '#mas_subject, [name="mas_subject"], #masters_subject, [name="masters_subject"], #subject4, [name="subject4"]';
          const subjOk = setEduSelectOrField(subjSel, ['subject', 'major'], mas.subject, 'masters');
          if (!subjOk && mas.subject) {
            setSelectValue(subjSel, 'Other');
            setTimeout(() => setInputValue('#mas_subject_other, [name="mas_subject_other"], #other_subject4, [name="other_subject4"]', mas.subject), 200);
          }
        }, 300);
        count += setEduSelectOrField('#mas_year, [name="mas_year"], #masters_year, [name="masters_year"], #year4, [name="year4"]', ['passing year', 'year'], mas.passingYear, 'masters');
        count += setEduSelect('#mas_result_type, [name="mas_result_type"], #masters_result_type, [name="masters_result_type"], #result4, [name="result4"]', ['result', 'cgpa'], [mas.resultType, 'CGPA(out of 4)', 'Out of 4', '4'], 'masters');
        setTimeout(() => {
          setEduField('#mas_result, [name="mas_result"], #masters_result, [name="masters_result"], #mas_cgpa, [name="mas_cgpa"], #result_gpa4, [name="result_gpa4"], #cgpa4, [name="cgpa4"]', ['cgpa', 'gpa', 'result'], mas.result, 'masters');
        }, 300);
        const masDurNum = String(parseInt(mas.duration || '1', 10) || 1);
        count += setEduSelectOrField('#mas_duration, [name="mas_duration"], #masters_duration, [name="masters_duration"], #duration4, [name="duration4"]', ['duration', 'course duration'], [mas.duration, `0${masDurNum} Year`, `0${masDurNum} Years`, `${masDurNum} Year`, `${masDurNum} Years`, masDurNum], 'masters');
      };
      if (masToggled) setTimeout(fillMas, 200); else fillMas();
    }

    // 14. Agreement declaration checkbox
    setTimeout(() => {
      const agree = document.querySelector('#agree, [name="agree"]');
      if (agree && !agree.checked) {
        agree.click();
        highlight(agree);
      }
    }, 800);

    return count;
  }

  /**
   * Fallback for Generic Job Portals
   */
  function fillGenericGovForm(d) {
    let count = 0;
    const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');

    inputs.forEach(el => {
      const name = (el.getAttribute('name') || '').toLowerCase();
      const id = (el.id || '').toLowerCase();
      const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
      const label = getNearestFieldLabel(el).toLowerCase();
      const combined = `${name} ${id} ${placeholder} ${label}`;

      if (el.type === 'checkbox' && combined.includes('same') && combined.includes('present')) {
        if (d.same_as_present !== false && !el.checked) {
          el.click();
          highlight(el);
          count++;
        }
      } else if (combined.includes('first') && combined.includes('name')) {
        count += setInputValue(el, (d.name || '').split(' ')[0] || d.name);
      } else if (combined.includes('last') && combined.includes('name')) {
        count += setInputValue(el, (d.name || '').split(' ').slice(1).join(' ') || d.name);
      } else if (combined.includes('name') && !combined.includes('father') && !combined.includes('mother')) {
        count += setInputValue(el, d.name);
      } else if (combined.includes('father')) {
        count += setInputValue(el, d.father);
      } else if (combined.includes('mother')) {
        count += setInputValue(el, d.mother);
      } else if (combined.includes('nid') || combined.includes('national')) {
        count += setInputValue(el, d.nid);
      } else if (combined.includes('mobile') || combined.includes('phone')) {
        count += setInputValue(el, d.mobile);
      } else if (combined.includes('email')) {
        count += setInputValue(el, d.email);
      } else if (combined.includes('birth') || combined.includes('dob')) {
        count += setInputValue(el, d.dob);
      } else if (combined.includes('care') || combined.includes('c/o')) {
        count += setInputValue(el, d.present_care_of || d.present_careof);
      } else if (combined.includes('village') || combined.includes('road') || combined.includes('house')) {
        count += setInputValue(el, d.present_village);
      } else if (combined.includes('district')) {
        count += el.tagName === 'SELECT' ? setSelectValue(el, d.present_district) : setInputValue(el, d.present_district);
      } else if (combined.includes('upazila') || combined.includes('thana')) {
        count += el.tagName === 'SELECT' ? setSelectValue(el, d.present_upazila) : setInputValue(el, d.present_upazila);
      } else if (combined.includes('post') && combined.includes('code')) {
        count += setInputValue(el, d.present_post_code || d.present_postcode);
      } else if (combined.includes('post') && combined.includes('office')) {
        count += setInputValue(el, d.present_post_office || d.present_post);
      }
    });

    const sameChk = findSameAsPresentCheckbox();
    if (sameChk && d.same_as_present !== false && !sameChk.checked) {
      sameChk.click();
      highlight(sameChk);
      count++;
    }

    return count;
  }

  // --- SECTION & LABEL-AWARE FIELD MATCHING ---
  function getNearestFieldLabel(el) {
    const parts = [];
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) parts.push(lbl.innerText);
    }
    const wrapLabel = el.closest('label');
    if (wrapLabel) parts.push(wrapLabel.innerText);
    if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
    if (el.getAttribute('placeholder')) parts.push(el.getAttribute('placeholder'));

    // Table cell layout: walk backwards across sibling <td>/<th> in the same <tr>
    // stopping before any previous cell that already holds a form input/select
    const cell = el.closest('td, th');
    if (cell) {
      let prev = cell.previousElementSibling;
      while (prev) {
        if (prev.querySelector('input:not([type="hidden"]), select, textarea')) break;
        const txt = (prev.innerText || prev.textContent || '').trim();
        if (txt && txt !== ':') parts.unshift(txt);
        prev = prev.previousElementSibling;
      }
    }

    // Modern div / form-group layout: preceding label/span/div text
    const group = el.closest('.form-group, .field, .row, .col, [class*="field"], [class*="input"]');
    if (group && !cell) {
      const lblEl = group.querySelector('label, .label, .control-label, span, strong');
      if (lblEl && !lblEl.contains(el)) {
        parts.push(lblEl.innerText);
      }
    }

    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function detectEduHeading(txt) {
    if (!txt) return null;
    if (/\b(?:class\s*eight|8th|j\.?\s*s\.?\s*c|j\.?\s*d\.?\s*c|education\s*1)\b/i.test(txt)) return 'jsc';
    if (/\b(?:s\.?\s*s\.?\s*c|dakhil|secondary\s*school|education\s*2)\b/i.test(txt)) return 'ssc';
    if (/\b(?:h\.?\s*s\.?\s*c|alim|diploma|higher\s*secondary|education\s*3)\b/i.test(txt)) return 'hsc';
    if (/\b(?:graduation|bachelor|honou?rs|fazil|degree|b\.?\s*s\.?\s*c|b\.?\s*a\b|b\.?\s*s\.?\s*s|b\.?\s*com|b\.?\s*b\.?\s*a|education\s*4)\b/i.test(txt)) return 'graduation';
    if (/\b(?:master(?:'s|s)?|kamil|m\.?\s*s\.?\s*c|m\.?\s*a\b|m\.?\s*s\.?\s*s|m\.?\s*com|m\.?\s*b\.?\s*a|education\s*5)\b/i.test(txt)) return 'masters';
    return null;
  }

  function detectSectionContext(el) {
    const idName = `${el.id || ''} ${el.getAttribute('name') || ''}`.toLowerCase();
    if (idName.includes('present') || idName.includes('pre_') || idName.includes('menu_')) return 'present';
    if (idName.includes('permanent') || idName.includes('per_')) return 'permanent';
    if (idName.includes('jsc') || idName.includes('eight')) return 'jsc';
    if (idName.includes('ssc') || /\b(?:exam1|board1|roll1|result1|subject1|group1|year1|gpa1)\b/.test(idName)) return 'ssc';
    if (idName.includes('hsc') || /\b(?:exam2|board2|roll2|result2|subject2|group2|year2|gpa2)\b/.test(idName)) return 'hsc';
    if (idName.includes('gra_') || idName.includes('grad') || /\b(?:exam3|institute3|result3|subject3|year3|duration3|cgpa3)\b/.test(idName)) return 'graduation';
    if (idName.includes('mas_') || idName.includes('master') || /\b(?:exam4|institute4|result4|subject4|year4|duration4|cgpa4)\b/.test(idName)) return 'masters';

    // Check enclosing fieldset / card / section heading
    const container = el.closest('fieldset, .card, .panel, section, div[id*="address"], div[class*="address"], div[id*="edu"], div[class*="edu"]');
    if (container) {
      const headEl = container.querySelector('legend, h1, h2, h3, h4, h5, .panel-header, .card-header, .section-heading, th');
      const hTxt = (headEl?.innerText || '').toLowerCase();
      if (hTxt.includes('present address') || hTxt.includes('বর্তমান ঠিকানা')) return 'present';
      if (hTxt.includes('permanent address') || hTxt.includes('স্থায়ী ঠিকানা')) return 'permanent';
      const eduSec = detectEduHeading(hTxt);
      if (eduSec) return eduSec;
    }

    // Check preceding sibling headings (e.g. <h3 class="section-heading">Education 1...</h3> before .form-row)
    let block = el.closest('.form-row, .row, tr, fieldset, .panel, .card');
    let prevNode = block ? block.previousElementSibling : el.previousElementSibling;
    let hop = 0;
    while (prevNode && hop < 6) {
      if (/^H[1-6]$/.test(prevNode.tagName) || prevNode.classList?.contains('section-heading')) {
        const t = (prevNode.innerText || '').toLowerCase();
        if (t.includes('present address')) return 'present';
        if (t.includes('permanent address')) return 'permanent';
        const eduSec = detectEduHeading(t);
        if (eduSec) return eduSec;
      }
      prevNode = prevNode.previousElementSibling;
      hop++;
    }

    // Check preceding rows in the same table for section header rows
    const tr = el.closest('tr');
    if (tr) {
      const rowEdu = detectEduHeading((tr.innerText || '').toLowerCase());
      // Handle 2-column Present (left) / Permanent (right) side-by-side table rows
      const cell = el.closest('td, th');
      if (cell) {
        const table = tr.closest('table');
        const allInputsInRow = [...tr.querySelectorAll('input:not([type="hidden"]), select, textarea')];
        const headerRow = [...(table?.querySelectorAll('tr') || [])].find(r => {
          const t = r.innerText.toLowerCase();
          return t.includes('present address') && t.includes('permanent address');
        });
        if (headerRow && allInputsInRow.length >= 2) {
          const idx = allInputsInRow.indexOf(el);
          return idx >= Math.ceil(allInputsInRow.length / 2) ? 'permanent' : 'present';
        }
      }

      let prevTr = tr.previousElementSibling;
      let steps = 0;
      while (prevTr && steps < 12) {
        const hasInput = prevTr.querySelector('input:not([type="hidden"]), select, textarea');
        const txt = (prevTr.innerText || '').toLowerCase();
        if (!hasInput && txt.trim()) {
          if (txt.includes('permanent address') || txt.includes('স্থায়ী ঠিকানা')) return 'permanent';
          if (txt.includes('present address') || txt.includes('বর্তমান ঠিকানা')) return 'present';
          const eduSec = detectEduHeading(txt);
          if (eduSec) return eduSec;
        }
        prevTr = prevTr.previousElementSibling;
        steps++;
      }
      if (rowEdu) return rowEdu;
    }

    return 'general';
  }

  function findSameAsPresentCheckbox() {
    const direct = document.querySelector(
      '#same_as_present, [name="same_as_present"], #same_present, [name="same_present"], #sameAsPresent, [name="sameAsPresent"], #copy_address, [name="copy_address"], #copy, [name="copy"], #is_same_address, [name="is_same_address"], #permanent_same, [name="permanent_same"], #same, [name="same"], input[type="checkbox"][id*="same"], input[type="checkbox"][name*="same"]'
    );
    if (direct) return direct;

    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    for (const chk of checkboxes) {
      const label = getNearestFieldLabel(chk).toLowerCase();
      const rowText = (chk.closest('td, div, label, p, tr')?.innerText || '').toLowerCase();
      const text = `${label} ${rowText} ${(chk.id || '').toLowerCase()} ${(chk.name || '').toLowerCase()}`;
      if (
        (text.includes('same') && (text.includes('present') || text.includes('above') || text.includes('address'))) ||
        text.includes('একই ঠিকানা')
      ) {
        return chk;
      }
    }
    return null;
  }

  function findFieldBySectionAndLabel(tagFilter, keywords, sectionHint = 'general', excludeKeywords = []) {
    const candidates = [...document.querySelectorAll(tagFilter)];
    const sectionMatches = [];
    const fallbackMatches = [];

    for (const el of candidates) {
      if (el.disabled || el.readOnly) continue;
      const idName = `${el.id || ''} ${el.getAttribute('name') || ''}`.toLowerCase();
      const label = getNearestFieldLabel(el).toLowerCase();
      const combined = `${idName} ${label}`;

      if (!keywords.some(kw => combined.includes(kw))) continue;
      if (excludeKeywords.some(ex => combined.includes(ex))) continue;

      const detectedSection = detectSectionContext(el);
      if (sectionHint === 'present' && detectedSection === 'permanent') continue;
      if (sectionHint === 'permanent' && detectedSection === 'present') continue;
      if (['jsc', 'ssc', 'hsc', 'graduation', 'masters'].includes(sectionHint) && detectedSection !== sectionHint) continue;

      if (detectedSection === sectionHint) {
        sectionMatches.push(el);
      } else {
        fallbackMatches.push(el);
      }
    }

    if (sectionMatches.length > 0) return sectionMatches[0];
    if (fallbackMatches.length > 0) {
      return sectionHint === 'permanent' && fallbackMatches.length > 1 ? fallbackMatches[1] : fallbackMatches[0];
    }
    return null;
  }

  function setEduField(selector, keywords, value, eduSection) {
    if (!value && value !== 0) return 0;
    const direct = document.querySelector(selector);
    if (direct && !direct.disabled && !direct.readOnly && direct.tagName !== 'SELECT') {
      return setInputValue(direct, value);
    }
    const byLabel = findFieldBySectionAndLabel(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="file"]), textarea',
      keywords,
      eduSection
    );
    return byLabel ? setInputValue(byLabel, value) : 0;
  }

  function setEduSelect(selector, keywords, candidates, eduSection) {
    const vals = (Array.isArray(candidates) ? candidates : [candidates]).filter(v => v !== undefined && v !== null && String(v).trim() !== '');
    if (vals.length === 0) return 0;
    const direct = document.querySelector(selector);
    if (direct && !direct.disabled && direct.tagName === 'SELECT') {
      for (const v of vals) {
        if (setSelectValue(direct, v)) return 1;
      }
    }
    const byLabel = findFieldBySectionAndLabel('select', keywords, eduSection);
    if (byLabel) {
      for (const v of vals) {
        if (setSelectValue(byLabel, v)) return 1;
      }
    }
    return 0;
  }

  function setEduSelectOrField(selector, keywords, candidates, eduSection) {
    const vals = (Array.isArray(candidates) ? candidates : [candidates]).filter(v => v !== undefined && v !== null && String(v).trim() !== '');
    if (vals.length === 0) return 0;
    const direct = document.querySelector(selector);
    if (direct && !direct.disabled) {
      if (direct.tagName === 'SELECT') {
        for (const v of vals) {
          if (setSelectValue(direct, v)) return 1;
        }
      } else if (!direct.readOnly) {
        return setInputValue(direct, vals[0]);
      }
    }
    return setEduSelect(selector, keywords, vals, eduSection) || setEduField(selector, keywords, vals[0], eduSection);
  }

  function setOrLabelField(selector, keywords, value, sectionHint = 'general', excludeKeywords = []) {
    if (!value && value !== 0) return 0;
    const direct = document.querySelector(selector);
    if (direct && !direct.disabled && !direct.readOnly) return setInputValue(direct, value);
    const byLabel = findFieldBySectionAndLabel(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="file"]), textarea',
      keywords,
      sectionHint,
      excludeKeywords
    );
    return byLabel ? setInputValue(byLabel, value) : 0;
  }

  function setOrLabelSelect(selector, keywords, value, sectionHint = 'general', excludeKeywords = []) {
    if (!value && value !== 0) return 0;
    const direct = document.querySelector(selector);
    if (direct && !direct.disabled) return setSelectValue(direct, value);
    const byLabel = findFieldBySectionAndLabel('select', keywords, sectionHint, excludeKeywords);
    return byLabel ? setSelectValue(byLabel, value) : 0;
  }

  function waitAndSelectUpazila(selector, keywords, value, sectionHint, onDone) {
    let attempts = 0;
    const trySelect = () => {
      attempts++;
      const ok = value ? setOrLabelSelect(selector, keywords, value, sectionHint) : 1;
      if (ok || attempts >= 12) {
        if (onDone) onDone();
        return;
      }
      setTimeout(trySelect, 250);
    };
    setTimeout(trySelect, 350);
  }

  // --- ELEMENT VALUE SETTERS WITH SYNTHETIC DISPATCH ---
  function setInputValue(selectorOrEl, val) {
    if (!val && val !== 0) return 0;
    const el = typeof selectorOrEl === 'string' ? document.querySelector(selectorOrEl) : selectorOrEl;
    if (!el) return 0;

    const strVal = String(val);
    el.value = strVal;

    // React / modern framework setter
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(el, strVal);
    }

    el.dispatchEvent(new Event('focus', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));

    highlight(el);
    return 1;
  }

  function normalizeSelectToken(s) {
    const raw = String(s || '')
      .toLowerCase()
      .replace(/\bcomilla\b/g, 'cumilla')
      .replace(/\bchittagong\b/g, 'chattogram')
      .replace(/\bjessore\b/g, 'jashore')
      .replace(/\bbarisal\b/g, 'barishal')
      .replace(/\bbogra\b/g, 'bogura')
      .replace(/\bhonors\b/g, 'honours')
      .replace(/\buniversity of (\w+)/g, '$1 university');
    return raw.replace(/[.\s'()/_-]+/g, '').replace(/^0+(\d)/, '$1');
  }

  function setSelectValue(selectorOrEl, valOrList) {
    const candidates = Array.isArray(valOrList)
      ? valOrList.filter(v => v !== undefined && v !== null && String(v).trim() !== '')
      : (valOrList !== undefined && valOrList !== null && String(valOrList).trim() !== '' ? [valOrList] : []);
    if (candidates.length === 0) return 0;

    const select = typeof selectorOrEl === 'string' ? document.querySelector(selectorOrEl) : selectorOrEl;
    if (!select || !select.options) return 0;

    let foundIndex = -1;

    for (const rawVal of candidates) {
      const searchVal = String(rawVal).toLowerCase().trim();
      const normSearch = normalizeSelectToken(rawVal);

      // 1. Exact value/text match
      for (let i = 0; i < select.options.length; i++) {
        const optVal = select.options[i].value.toLowerCase().trim();
        const optText = select.options[i].text.toLowerCase().trim();
        if (optVal === searchVal || optText === searchVal) {
          foundIndex = i;
          break;
        }
      }
      if (foundIndex !== -1) break;

      // 2. Normalized match (ignores dots, spaces, parens, legacy spelling, leading zero)
      if (normSearch) {
        for (let i = 0; i < select.options.length; i++) {
          const optText = select.options[i].text.trim();
          const optVal = select.options[i].value.trim();
          if (!optText || /select/i.test(optText)) continue;
          if (normalizeSelectToken(optText) === normSearch || normalizeSelectToken(optVal) === normSearch) {
            foundIndex = i;
            break;
          }
        }
      }
      if (foundIndex !== -1) break;

      // 3. Fuzzy substring match (skip empty/placeholder options like "Select One")
      for (let i = 0; i < select.options.length; i++) {
        const optVal = select.options[i].value.toLowerCase().trim();
        const optText = select.options[i].text.toLowerCase().trim();
        if (!optText || (!optVal && optText.includes('select')) || optText === 'select one' || optText === '-- select --') continue;
        if (optText.includes(searchVal) || (optText.length >= 2 && searchVal.includes(optText))) {
          foundIndex = i;
          break;
        }
        const normOpt = normalizeSelectToken(optText);
        if (normOpt.length >= 3 && (normOpt.includes(normSearch) || normSearch.includes(normOpt))) {
          foundIndex = i;
          break;
        }
      }
      if (foundIndex !== -1) break;
    }

    if (foundIndex !== -1) {
      select.selectedIndex = foundIndex;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      highlight(select);
      return 1;
    }

    return 0;
  }

  function highlight(el) {
    el.classList.add('govfill-highlight-filled');
    setTimeout(() => {
      el.classList.remove('govfill-highlight-filled');
    }, 4000);
  }

  function getLabelText(el) {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return l.innerText;
    }
    const parent = el.closest('label');
    if (parent) return parent.innerText;
    return '';
  }

  // --- 2ND PAGE AUTOMATIC PHOTO & SIGNATURE FILE ATTACHMENT ---
  function hasMediaFileInputs() {
    return document.querySelectorAll('input[type="file"]').length > 0;
  }

  function fetchMediaViaBackground(url) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'FETCH_MEDIA_BASE64', url }, (res) => {
        if (chrome.runtime.lastError || !res?.success) {
          resolve(null);
        } else {
          resolve(res);
        }
      });
    });
  }

  function assignFileToInput(inputEl, base64, mimeType, fileName) {
    if (!inputEl || !base64) return false;
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const file = new File([bytes], fileName, { type: mimeType || 'image/jpeg' });
      const dt = new DataTransfer();
      dt.items.add(file);
      inputEl.files = dt.files;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      highlight(inputEl);
      return true;
    } catch (e) {
      console.warn('Failed to attach media file:', e);
      return false;
    }
  }

  async function attachMediaFilesToPage(d, isAutoPage2 = false) {
    const fileInputs = [...document.querySelectorAll('input[type="file"]')];
    if (fileInputs.length === 0) return 0;

    let photoInput = document.querySelector(
      '#photo, [name="photo"], #picture, [name="picture"], #image, [name="image"], input[type="file"][id*="photo"], input[type="file"][name*="photo"], input[type="file"][id*="pic"]'
    );
    let signInput = document.querySelector(
      '#signature, [name="signature"], #sign, [name="sign"], input[type="file"][id*="sign"], input[type="file"][name*="sign"]'
    );

    if (!photoInput || !signInput) {
      for (const fi of fileInputs) {
        const lbl = `${fi.id || ''} ${fi.getAttribute('name') || ''} ${getNearestFieldLabel(fi)}`.toLowerCase();
        if (!photoInput && (lbl.includes('photo') || lbl.includes('picture') || lbl.includes('300x300') || lbl.includes('ছবি'))) {
          photoInput = fi;
        } else if (!signInput && (lbl.includes('sign') || lbl.includes('300x80') || lbl.includes('স্বাক্ষর'))) {
          signInput = fi;
        }
      }
    }

    if (!photoInput && fileInputs.length >= 1) photoInput = fileInputs[0];
    if (!signInput && fileInputs.length >= 2 && fileInputs[1] !== photoInput) signInput = fileInputs[1];

    let attached = 0;
    if (photoInput && d.photoUrl) {
      const media = await fetchMediaViaBackground(d.photoUrl);
      if (media && assignFileToInput(photoInput, media.base64, media.mimeType, 'photo_300x300.jpg')) {
        attached++;
      }
    }
    if (signInput && d.signatureUrl) {
      const media = await fetchMediaViaBackground(d.signatureUrl);
      if (media && assignFileToInput(signInput, media.base64, media.mimeType, 'signature_300x80.jpg')) {
        attached++;
      }
    }

    // Check agreement declaration if present on 2nd page
    const agree = document.querySelector('#agree, [name="agree"], input[type="checkbox"][id*="declare"], input[type="checkbox"][name*="declare"]');
    if (agree && !agree.checked) {
      agree.click();
      highlight(agree);
    }

    if (attached > 0) {
      didAutoFillThisPage = true;
      lastFilledCount = Math.max(lastFilledCount, attached);
      if (isAutoPage2) {
        trackApplyOnServer('autofill', attached);
      }
      showToast(`📷 Auto-attached ${attached} media file(s) (Photo & Signature) on 2nd page!`);
    }
    return attached;
  }

  // --- FLOATING IN-PAGE WIDGET (PERSISTENT UNTIL CLOSE CLICKED) ---
  function getWidgetCollapsedMarkup() {
    const logoUrl = chrome.runtime.getURL('icons/icon48.png');
    return `
      <div title="Toya Telecom & Computer (Click to Keep Open)" style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;">
        <img src="${logoUrl}" alt="Toya" style="width: 48px; height: 48px; border-radius: 50%; object-fit: contain; background: #fff;">
      </div>
    `;
  }

  function injectFloatingWidget(startExpanded = false) {
    if (document.getElementById('govfill-floating-widget')) return;

    floatingWidgetEl = document.createElement('div');
    floatingWidgetEl.id = 'govfill-floating-widget';
    floatingWidgetEl.className = 'govfill-collapsed';
    floatingWidgetEl.innerHTML = getWidgetCollapsedMarkup();

    floatingWidgetEl.addEventListener('click', () => {
      if (floatingWidgetEl.classList.contains('govfill-collapsed')) {
        expandFloatingWidget();
      }
    });

    document.body.appendChild(floatingWidgetEl);
    if (startExpanded) {
      expandFloatingWidget();
    }
  }

  function expandFloatingWidget() {
    if (!floatingWidgetEl) return;
    floatingWidgetEl.classList.remove('govfill-collapsed');
    chrome.storage.local.set({ widgetExpanded: true });

    floatingWidgetEl.innerHTML = `
      <div class="govfill-card">
        <div class="govfill-header">
          <span>⚡ Toya Telecom &amp; Computer</span>
          <button class="govfill-header-close" id="govfill-close-btn" title="Close Panel" style="font-size:12px;background:rgba(255,255,255,0.18);padding:2px 8px;border-radius:6px;">✕ Close</button>
        </div>
        <div class="govfill-body">
          <div class="govfill-candidate-pill">
            <strong id="gw-cust-name">${cachedProfile ? cachedProfile.name : 'No profile loaded'}</strong>
            <span id="gw-cust-id" style="color: #64748b;">${cachedCustomerId || 'Open extension popup to select'}</span>
          </div>

          <button id="gw-btn-autofill" class="govfill-btn govfill-btn-primary">
            ⚡ Auto-Fill Application Form
          </button>

          ${(cachedProfile?.photoUrl || cachedProfile?.signatureUrl) ? `
            <button id="gw-btn-media" class="govfill-btn" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;">
              📷 Attach Photo &amp; Sign (2nd Page)
            </button>
            <div class="govfill-media-actions">
              ${cachedProfile.photoUrl ? `<a href="${cachedProfile.photoUrl}" download="photo_300x300.jpg" target="_blank" class="govfill-btn-media">⬇ Photo</a>` : ''}
              ${cachedProfile.signatureUrl ? `<a href="${cachedProfile.signatureUrl}" download="sign_300x80.jpg" target="_blank" class="govfill-btn-media">⬇ Sign</a>` : ''}
            </div>
          ` : ''}

          <button id="gw-btn-close" class="govfill-btn" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;font-size:12px;">
            ✕ Close Panel
          </button>
        </div>
      </div>
    `;

    const closeHandler = (e) => {
      e.stopPropagation();
      collapseFloatingWidget();
    };
    document.getElementById('govfill-close-btn').addEventListener('click', closeHandler);
    document.getElementById('gw-btn-close').addEventListener('click', closeHandler);

    document.getElementById('gw-btn-autofill').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!cachedProfile) {
        showToast('Please open the extension popup and choose a customer profile first!');
        return;
      }
      executeAutoFill(cachedProfile);
    });

    document.getElementById('gw-btn-media')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!cachedProfile) return;
      attachMediaFilesToPage(cachedProfile, false);
    });
  }

  function collapseFloatingWidget() {
    if (!floatingWidgetEl) return;
    chrome.storage.local.set({ widgetExpanded: false });
    floatingWidgetEl.className = 'govfill-collapsed';
    floatingWidgetEl.innerHTML = getWidgetCollapsedMarkup();
  }

  function updateFloatingWidgetInfo() {
    if (floatingWidgetEl && !floatingWidgetEl.classList.contains('govfill-collapsed')) {
      expandFloatingWidget();
    }
  }

  function showToast(msg) {
    const existing = document.querySelector('.govfill-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'govfill-toast';
    toast.innerText = msg;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.4s';
      setTimeout(() => toast.remove(), 400);
    }, 4500);
  }
})();
