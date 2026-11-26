/**
 * GovJob AutoFill - Extension Popup Controller
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const serverUrlInput = document.getElementById('server-url');
  const apiKeyInput = document.getElementById('api-key');
  const btnAuthenticate = document.getElementById('btn-authenticate');
  const btnToggleConfig = document.getElementById('btn-toggle-config');
  const configFields = document.getElementById('config-fields');
  const authSuccessBadge = document.getElementById('auth-success-badge');
  const authSuccessText = document.getElementById('auth-success-text');
  const connIndicator = document.getElementById('connection-indicator');
  const connStatusText = document.getElementById('conn-status-text');

  const customerIdInput = document.getElementById('customer-id');
  const btnFetchCustomer = document.getElementById('btn-fetch-customer');
  const customerDropdown = document.getElementById('customer-select-dropdown');
  const btnRefreshCustomers = document.getElementById('btn-refresh-customers');

  const customerPreview = document.getElementById('customer-preview');
  const custThumb = document.getElementById('cust-thumb');
  const custName = document.getElementById('cust-name');
  const custNameBn = document.getElementById('cust-name-bn');
  const custIdBadge = document.getElementById('cust-id-badge');
  const custGender = document.getElementById('cust-gender');
  const custFather = document.getElementById('cust-father');
  const custMother = document.getElementById('cust-mother');
  const custMobile = document.getElementById('cust-mobile');
  const custNid = document.getElementById('cust-nid');
  const custDob = document.getElementById('cust-dob');
  const custDistrict = document.getElementById('cust-district');
  const custGpa = document.getElementById('cust-gpa');

  const btnAutofill = document.getElementById('btn-autofill');
  const statusBanner = document.getElementById('autofill-status-banner');
  const chkFloating = document.getElementById('chk-floating-widget');
  const linkOpenDash = document.getElementById('link-open-dashboard');

  let currentLoadedCustomer = null;

  // 1. Load saved settings from Chrome Storage
  const LIVE_SERVER_URL = 'https://job.toyatelecom.online';
  const DEFAULT_API_KEY = 'govfill_live_5088084d403177d099f2649dbfb715210aa8bc0f43e2bb20';
  const btnEditApiKey = document.getElementById('btn-edit-api-key');
  const btnChangeApiKey = document.getElementById('btn-change-api-key');

  const saved = await chrome.storage.local.get([
    'serverUrl',
    'apiKey',
    'lastCustomerId',
    'showFloatingWidget',
    'cachedCustomer',
    'migratedToLiveDomainV1'
  ]);

  let serverUrl = saved.serverUrl || LIVE_SERVER_URL;
  if (!saved.migratedToLiveDomainV1 && serverUrl.includes('localhost:5000')) {
    serverUrl = LIVE_SERVER_URL;
    await chrome.storage.local.set({ serverUrl, migratedToLiveDomainV1: true });
  }
  const apiKey = saved.apiKey || DEFAULT_API_KEY;
  if (!saved.apiKey) {
    await chrome.storage.local.set({ apiKey });
  }
  const lastCustomerId = saved.lastCustomerId || 'TTC-0001';

  const lockApiKeyInput = () => {
    apiKeyInput.readOnly = true;
    apiKeyInput.type = 'password';
    apiKeyInput.style.background = '#f1f5f9';
    if (btnEditApiKey) btnEditApiKey.innerText = 'Change';
  };

  const unlockApiKeyInput = () => {
    configFields.style.display = 'block';
    apiKeyInput.readOnly = false;
    apiKeyInput.type = 'text';
    apiKeyInput.style.background = '#ffffff';
    if (btnEditApiKey) btnEditApiKey.innerText = 'Reset';
    apiKeyInput.focus();
    apiKeyInput.select();
  };

  serverUrlInput.value = serverUrl;
  apiKeyInput.value = apiKey;
  lockApiKeyInput();
  customerIdInput.value = lastCustomerId;
  linkOpenDash.href = serverUrl;
  chkFloating.checked = saved.showFloatingWidget !== false;

  // Toggle Config View
  btnToggleConfig.addEventListener('click', () => {
    configFields.style.display = configFields.style.display === 'none' ? 'block' : 'none';
  });

  btnChangeApiKey?.addEventListener('click', () => {
    unlockApiKeyInput();
  });

  btnEditApiKey?.addEventListener('click', () => {
    if (apiKeyInput.readOnly) {
      unlockApiKeyInput();
    } else {
      apiKeyInput.value = DEFAULT_API_KEY;
      apiKeyInput.focus();
      apiKeyInput.select();
    }
  });

  document.getElementById('btn-preset-cloud')?.addEventListener('click', () => {
    serverUrlInput.value = LIVE_SERVER_URL;
    linkOpenDash.href = LIVE_SERVER_URL;
  });
  document.getElementById('btn-preset-local')?.addEventListener('click', () => {
    serverUrlInput.value = 'http://localhost:5000';
    linkOpenDash.href = 'http://localhost:5000';
  });

  // Floating widget toggle
  chkFloating.addEventListener('change', async () => {
    await chrome.storage.local.set({ showFloatingWidget: chkFloating.checked });
  });

  // Always auto-verify with saved / permanent API key
  if (apiKey) {
    verifyAndConnect(serverUrl, apiKey, false);
  }

  // 2. Authenticate & Save Key Button
  btnAuthenticate.addEventListener('click', async () => {
    const sUrl = serverUrlInput.value.trim().replace(/\/+$/, '');
    const key = apiKeyInput.value.trim();

    if (!sUrl) {
      alert('Please enter your Web App Server URL (e.g. https://job.toyatelecom.online)');
      return;
    }
    if (!key) {
      alert('Please enter your Developer API Key.');
      return;
    }

    await chrome.storage.local.set({ serverUrl: sUrl, apiKey: key });
    lockApiKeyInput();
    linkOpenDash.href = sUrl;
    verifyAndConnect(sUrl, key, true);
  });

  async function verifyAndConnect(sUrl, key, showBanner = true) {
    try {
      setConnectionStatus('connecting', 'Connecting...');
      const res = await fetch(`${sUrl}/api/v1/extension/verify`, {
        headers: { 'X-API-Key': key }
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || 'Authentication failed');
      }

      setConnectionStatus('connected', 'Connected');
      authSuccessText.innerText = `Connected: ${data.client.operator} (${data.client.label})`;
      authSuccessBadge.style.display = 'block';
      configFields.style.display = 'none';

      // Load customers dropdown
      loadCustomersDropdown(sUrl, key);

      // Auto-fetch last customer
      const targetCustId = customerIdInput.value.trim();
      if (targetCustId) {
        fetchCustomerData(sUrl, key, targetCustId, false);
      }

      if (showBanner) showBannerMsg('Authenticated successfully!', 'success');
    } catch (err) {
      setConnectionStatus('disconnected', 'Disconnected');
      authSuccessBadge.style.display = 'none';
      configFields.style.display = 'block';
      if (showBanner) showBannerMsg('Connection error: ' + err.message, 'error');
    }
  }

  function setConnectionStatus(status, text) {
    connIndicator.className = `connection-pill ${status}`;
    connStatusText.innerText = text;
  }

  // 3. Load Customers for Dropdown
  async function loadCustomersDropdown(sUrl, key) {
    try {
      const res = await fetch(`${sUrl}/api/v1/extension/customers`, {
        headers: { 'X-API-Key': key }
      });
      const data = await res.json();
      if (data.success && data.customers) {
        customerDropdown.innerHTML = '<option value="">-- Choose customer from database --</option>' + 
          data.customers.map(c => `
            <option value="${c.id}">${c.id} - ${c.applicantName} (${c.mobile || 'No Mobile'})</option>
          `).join('');

        if (customerIdInput.value) {
          customerDropdown.value = customerIdInput.value;
        }
      }
    } catch (e) {
      console.warn('Could not populate customer dropdown:', e);
    }
  }

  customerDropdown.addEventListener('change', () => {
    if (customerDropdown.value) {
      customerIdInput.value = customerDropdown.value;
      const sUrl = serverUrlInput.value.trim().replace(/\/+$/, '');
      const key = apiKeyInput.value.trim();
      fetchCustomerData(sUrl, key, customerDropdown.value, true);
    }
  });

  btnRefreshCustomers.addEventListener('click', () => {
    const sUrl = serverUrlInput.value.trim().replace(/\/+$/, '');
    const key = apiKeyInput.value.trim();
    if (sUrl && key) loadCustomersDropdown(sUrl, key);
  });

  // 4. Fetch Customer by Customer ID or Phone Number
  function triggerCustomerLookup() {
    const sUrl = serverUrlInput.value.trim().replace(/\/+$/, '');
    const key = apiKeyInput.value.trim();
    const query = customerIdInput.value.trim();

    if (!query) {
      alert('Please enter a Customer ID (e.g. TTC-0001) or Phone Number (e.g. 01727518325)');
      return;
    }

    fetchCustomerData(sUrl, key, query, true);
  }

  btnFetchCustomer.addEventListener('click', triggerCustomerLookup);
  customerIdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      triggerCustomerLookup();
    }
  });
  customerIdInput.addEventListener('input', () => {
    const val = customerIdInput.value.trim();
    const sUrl = serverUrlInput.value.trim().replace(/\/+$/, '');
    const key = apiKeyInput.value.trim();
    if (sUrl && key && (/^TTC-\d{4,}$/i.test(val) || /^01[3-9]\d{8}$/.test(val.replace(/\D/g, '')))) {
      fetchCustomerData(sUrl, key, val, false);
    }
  });

  async function fetchCustomerData(sUrl, key, custId, showAlert = true) {
    try {
      showBannerMsg(`Fetching profile ${custId}...`, 'info');
      const res = await fetch(`${sUrl}/api/v1/extension/customer/${encodeURIComponent(custId)}`, {
        headers: { 'X-API-Key': key }
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || 'Customer profile not found');
      }

      currentLoadedCustomer = data;
      await chrome.storage.local.set({
        lastCustomerId: custId,
        cachedCustomer: data
      });

      // Populate preview card
      renderCustomerPreview(data.data, data.customerId);
      btnAutofill.disabled = false;
      showBannerMsg(`Profile "${data.data.name}" ready to auto-fill!`, 'success');
    } catch (err) {
      currentLoadedCustomer = null;
      customerPreview.style.display = 'none';
      btnAutofill.disabled = true;
      if (showAlert) showBannerMsg(err.message, 'error');
    }
  }

  function renderCustomerPreview(c, id) {
    custName.innerText = c.name || '-';
    custNameBn.innerText = c.name_bn || '';
    custIdBadge.innerText = id;
    custGender.innerText = c.gender || '';
    if (custFather) custFather.innerText = c.father || '-';
    if (custMother) custMother.innerText = c.mother || '-';
    custMobile.innerText = c.mobile || '-';
    custNid.innerText = c.nid || '-';
    if (custDob) custDob.innerText = c.dob || '-';
    custDistrict.innerText = [c.present_upazila, c.present_district].filter(Boolean).join(', ') || '-';

    const eduList = [];
    if (c.education?.jsc && (c.education.jsc.result || c.education.jsc.roll)) eduList.push(`JSC: ${c.education.jsc.result || ''} (${c.education.jsc.board || ''})`);
    if (c.education?.ssc && (c.education.ssc.result || c.education.ssc.roll)) eduList.push(`SSC: ${c.education.ssc.result || ''} (${c.education.ssc.board || ''})`);
    if (c.education?.hsc && (c.education.hsc.result || c.education.hsc.roll)) eduList.push(`HSC: ${c.education.hsc.result || ''}`);
    if (c.education?.graduation && (c.education.graduation.result || c.education.graduation.institute)) eduList.push(`${c.education.graduation.examination || 'Grad'}: ${c.education.graduation.result || ''}`);
    if (c.education?.masters && (c.education.masters.result || c.education.masters.institute)) eduList.push(`${c.education.masters.examination || 'Masters'}: ${c.education.masters.result || ''}`);
    custGpa.innerText = eduList.length > 0 ? eduList.join(' | ') : '-';

    if (c.photoUrl) {
      custThumb.src = c.photoUrl;
    } else {
      custThumb.src = 'icons/icon48.png';
    }

    customerPreview.style.display = 'block';
  }

  // 5. Keep Open on Page (Persistent In-Page Panel) & Close Popup
  document.getElementById('btn-close-popup')?.addEventListener('click', () => {
    window.close();
  });

  document.getElementById('btn-pin-panel')?.addEventListener('click', async () => {
    await chrome.storage.local.set({ showFloatingWidget: true, widgetExpanded: true });
    chkFloating.checked = true;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'OPEN_PERSISTENT_WIDGET',
        customer: currentLoadedCustomer?.data || null,
        customerId: currentLoadedCustomer?.customerId || null
      }, () => {
        if (chrome.runtime.lastError) {
          showBannerMsg('Refresh the job page once to show the persistent panel.', 'info');
        } else {
          showBannerMsg('📌 Panel pinned on page — stays open until you click Close!', 'success');
        }
      });
    }
  });

  // 6. Trigger Auto-Fill on Target Webpage
  btnAutofill.addEventListener('click', async () => {
    if (!currentLoadedCustomer) {
      alert('Please select and fetch a customer profile first.');
      return;
    }

    showBannerMsg('Injecting candidate data into online application...', 'info');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      showBannerMsg('Cannot access active browser tab.', 'error');
      return;
    }

    chrome.tabs.sendMessage(tab.id, {
      action: 'AUTOFILL_GOV_FORM',
      customer: currentLoadedCustomer.data,
      customerId: currentLoadedCustomer.customerId
    }, (response) => {
      if (chrome.runtime.lastError) {
        showBannerMsg('Please refresh the government job application page and try again.', 'error');
        return;
      }

      if (response && response.success) {
        showBannerMsg(`✨ Form auto-filled accurately (${response.filledCount} fields populated)!`, 'success');
      } else {
        showBannerMsg(response?.message || 'No compatible fields detected on this page.', 'error');
      }
    });
  });

  function showBannerMsg(text, type = 'info') {
    statusBanner.style.display = 'block';
    statusBanner.className = `status-banner status-${type}`;
    statusBanner.innerText = text;
    if (type !== 'info') {
      setTimeout(() => {
        statusBanner.style.display = 'none';
      }, 5000);
    }
  }
});
