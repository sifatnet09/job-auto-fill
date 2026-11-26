/**
 * GovJob AutoFill - Service Worker (Manifest V3)
 */

const LIVE_SERVER_URL = 'https://job.toyatelecom.online';
const DEFAULT_API_KEY = 'govfill_live_5088084d403177d099f2649dbfb715210aa8bc0f43e2bb20';

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({
    id: 'govfill_autofill_context',
    title: '⚡ Auto-Fill BD Govt Application (Toya AutoFill)',
    contexts: ['page', 'editable']
  });

  // One-time migration from local dev URL to live custom domain & seed permanent default API key
  const cfg = await chrome.storage.local.get(['serverUrl', 'apiKey', 'migratedToLiveDomainV1']);
  const patch = {};
  if (!cfg.migratedToLiveDomainV1 && (!cfg.serverUrl || cfg.serverUrl.includes('localhost:5000'))) {
    patch.serverUrl = LIVE_SERVER_URL;
    patch.migratedToLiveDomainV1 = true;
  }
  if (!cfg.apiKey) {
    patch.apiKey = DEFAULT_API_KEY;
  }
  if (Object.keys(patch).length > 0) {
    await chrome.storage.local.set(patch);
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'govfill_autofill_context' && tab && tab.id) {
    const saved = await chrome.storage.local.get(['cachedCustomer']);
    if (saved.cachedCustomer && saved.cachedCustomer.data) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'AUTOFILL_GOV_FORM',
        customer: saved.cachedCustomer.data,
        customerId: saved.cachedCustomer.customerId
      });
    } else {
      console.warn('GovJob: No customer cached yet. Open popup to select customer.');
    }
  }
});

// Relay application tracking from content script to Toya Telecom & Computer Web App
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'TRACK_APPLY') {
    (async () => {
      try {
        const cfg = await chrome.storage.local.get(['serverUrl', 'apiKey']);
        const serverUrl = (cfg.serverUrl || LIVE_SERVER_URL).replace(/\/+$/, '');
        const apiKey = (cfg.apiKey || DEFAULT_API_KEY).trim();
        const res = await fetch(`${serverUrl}/api/v1/extension/track-apply`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': apiKey
          },
          body: JSON.stringify(request.payload)
        });
        const data = await res.json().catch(() => ({}));
        sendResponse(data);
      } catch (err) {
        console.warn('Track apply relay error:', err.message);
        sendResponse({ success: false, message: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'FETCH_MEDIA_BASE64') {
    (async () => {
      try {
        if (!request.url) {
          sendResponse({ success: false, message: 'No media URL provided.' });
          return;
        }
        const res = await fetch(request.url);
        if (!res.ok) {
          sendResponse({ success: false, message: `HTTP ${res.status}` });
          return;
        }
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        const mimeType = res.headers.get('content-type') || 'image/jpeg';
        sendResponse({ success: true, base64: btoa(binary), mimeType });
      } catch (err) {
        sendResponse({ success: false, message: err.message });
      }
    })();
    return true;
  }
});
