# Toya Telecom & Computer — Complete Project Files & Checklist

> **System:** Online Job Apply Dashboard & Chrome Auto-Fill Extension  
> **Brand:** Toya Telecom & Computer (`Buy Sell & Exchange`)  
> **Credit:** Developed By Sifat Hossain  
> **Last Scanned:** 2026-11-25  

---

## 📁 Folder Structure Overview

```text
Job Auto Fill/
├── PROJECT_FILES_CHECKLIST.md   # This master inventory & checklist
├── README.md                    # System architecture & quick start guide
├── Start-Server.bat             # One-click Windows launcher for Express server
│
├── extension/                   # Chrome / Edge Manifest V3 Extension
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── content.css
│   ├── popup.html
│   ├── popup.js
│   ├── popup.css
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       ├── icon128.png
│       └── toya_logo.jpg
│
└── server/                      # Node.js + Express 5 Web App & API Server
    ├── server.js
    ├── package.json
    ├── package-lock.json
    ├── .env
    ├── eng.traineddata
    ├── ben.traineddata
    ├── config/
    │   ├── db.js
    │   └── security.js
    ├── middleware/
    │   ├── auth.js
    │   └── apiKeyAuth.js
    ├── routes/
    │   ├── authRoutes.js
    │   ├── customerRoutes.js
    │   ├── parseRoutes.js
    │   ├── apiKeyRoutes.js
    │   └── extensionRoutes.js
    ├── services/
    │   ├── pdfService.js
    │   ├── geminiService.js
    │   └── imageValidator.js
    ├── data/
    │   └── db.json
    ├── public/
    │   ├── index.html
    │   ├── css/style.css
    │   ├── js/api.js
    │   ├── js/app.js
    │   ├── js/imageHelper.js
    │   └── images/
    │       ├── toya_logo.jpg
    │       ├── favicon.png
    │       ├── placeholder_photo.png
    │       └── placeholder_sign.png
    └── uploads/
        ├── photos/
        └── signatures/
```

---

## ✅ Complete Workspace File Checklist

### 1. Root Files (3 files)
- [x] `README.md` — Project overview, architecture notes, and setup instructions.
- [x] `Start-Server.bat` — Windows batch script (`cd /d "%~dp0server"` -> `node server.js`) to start the server on port `5000`.
- [x] `PROJECT_FILES_CHECKLIST.md` — Master file inventory, feature map, and maintenance checklist.

---

### 2. Chrome / Edge Browser Extension (`extension/` — 11 files)
- [x] `extension/manifest.json` — Manifest V3 config (`v2.0.0`), permissions (`storage`, `activeTab`, `scripting`, `contextMenus`), `<all_urls>` content script & web-accessible resources (`icons/icon48.png`, `icons/toya_logo.jpg`).
- [x] `extension/popup.html` — Extension popup UI: Toya Telecom & Computer header, Server URL & API Key settings, Customer ID / Phone lookup (`TTC-0001` or `017...`), customer preview card, Auto-Fill trigger button, floating widget toggle.
- [x] `extension/popup.js` — Popup controller: authenticates via `/api/v1/extension/verify`, populates dropdown via `/api/v1/extension/customers`, looks up customers by ID or phone via `/api/v1/extension/customer/:id`, triggers `AUTOFILL_GOV_FORM` on active tab.
- [x] `extension/popup.css` — Styling for extension popup cards, status pills, preview grid, and buttons.
- [x] `extension/content.js` — In-page auto-fill engine: fills Teletalk (`*.teletalk.com.bd`) & generic govt job forms, handles dependent dropdowns, renders in-page floating widget, scrapes portal metadata (`extractPortalMetadata`), tracks `autofill` and `submitted` events (`trackApplyOnServer`, `setupSubmitTracking`) via `TRACK_APPLY`.
- [x] `extension/content.css` — Styling for filled-field green highlight (`.govfill-highlight-filled`) and in-page floating widget (`#govfill-floating-widget`).
- [x] `extension/background.js` — MV3 service worker: context menu launcher + `TRACK_APPLY` relay sending `POST /api/v1/extension/track-apply` with `X-API-Key` (prevents HTTPS -> HTTP localhost Mixed Content blocking).
- [x] `extension/icons/icon16.png` — 16×16 toolbar icon.
- [x] `extension/icons/icon48.png` — 48×48 extension icon & fallback avatar.
- [x] `extension/icons/icon128.png` — 128×128 extension store/management icon.
- [x] `extension/icons/toya_logo.jpg` — Toya Telecom & Computer brand logo shown in popup and floating widget.

---

### 3. Backend Server Core, Config & Security (`server/` — 11 files)
- [x] `server/server.js` — Express 5 server (`port 5000`), CORS, static SPA (`public/`), static uploads (`/uploads`), mounts API routes, serves `/api/health`, `GET /api/dashboard/stats` (JWT-protected), and SPA fallback.
- [x] `server/package.json` — Dependencies: `bcryptjs`, `cors`, `dotenv`, `express` (`^5.3.0`), `jsonwebtoken`, `multer`, `tesseract.js`.
- [x] `server/package-lock.json` — Locked npm dependency tree.
- [x] `server/.env` — Environment variables (`PORT`, `GEMINI_API_KEY`, `JWT_SECRET`, `ENCRYPTION_SECRET`, etc. — keep private).
- [x] `server/eng.traineddata` — Local Tesseract OCR English language model.
- [x] `server/ben.traineddata` — Local Tesseract OCR Bengali language model.
- [x] `server/config/db.js` — JSON file persistence (`data/db.json`) with AES-256-GCM field encryption, `TTC-0001+` customer ID generator, phone/ID lookup, single Website API Key management, user/staff CRUD (Gmail + username login), `trackApplication()` (deduplicates within 30 mins), and `getDashboardStats()`.
- [x] `server/config/security.js` — AES-256-GCM `encrypt`/`decrypt` (`encryptObject`/`decryptObject`), `bcrypt` password hashing, and `govfill_live_...` API key generator + SHA-256 hashing.
- [x] `server/data/db.json` — Local persistent JSON datastore (users, encrypted customers, API keys, tracked extension applications, audit logs).
- [x] `server/middleware/auth.js` — JWT token generation (`7d` expiry) & verification (`verifyToken`), plus `requireAdmin` and `requireStaff` RBAC guards.
- [x] `server/middleware/apiKeyAuth.js` — Extension API key middleware (`verifyApiKey`) checking `X-API-Key`, `Authorization: Bearer govfill_live_...`, or `?apiKey=...`.

---

### 4. Backend API Routes (`server/routes/` — 5 files)
- [x] `server/routes/authRoutes.js` — `/api/auth/login` (Gmail or Username + password), `/api/auth/me`, and Admin-only `/api/auth/users` (`GET`, `POST`, `PUT /:id`, `DELETE /:id`) with last-admin protection.
- [x] `server/routes/customerRoutes.js` — `/api/customers` CRUD (`GET`, `GET /:id`, `POST`, `PUT /:id`, Admin-only `DELETE /:id`) plus `POST /:id/photo` (strict 300×300) and `POST /:id/signature` (strict 300×80).
- [x] `server/routes/parseRoutes.js` — `POST /api/parse/pdf` (accepts up to 15MB PDF, runs `PdfService` + `GeminiService`, optionally auto-saves new customer profile).
- [x] `server/routes/apiKeyRoutes.js` — `GET /api/keys`, `POST /api/keys` (regenerates the single Website API Key), `DELETE /api/keys/:id` (revokes key).
- [x] `server/routes/extensionRoutes.js` — Extension API (`/api/v1/extension`): `GET /verify`, `GET /customers`, `GET /customer/:id` (supports `TTC-XXXX` or phone number), and `POST /track-apply` (records live extension applies).

---

### 5. Backend Parsing & Validation Services (`server/services/` — 3 files)
- [x] `server/services/pdfService.js` — Extracts embedded JPEGs, parses uncompressed & `FlateDecode` PDF text streams, and runs local `tesseract.js` OCR (`eng` + `ben`).
- [x] `server/services/geminiService.js` — Multimodal Gemini Flash extraction with automatic fallback to local Tesseract OCR + rule-based parser when no Gemini key is available or API fails.
- [x] `server/services/imageValidator.js` — Pure Node.js PNG/JPEG header parser strictly validating **300×300** photos and **300×80** signatures.

---

### 6. Web Dashboard Frontend (`server/public/` — 9 files)
- [x] `server/public/index.html` — Single-page application shell: Login card, premium dark sidebar, Dashboard (`Toya Telecom & Computer` / `Online Job Apply Dashboard`, 4 KPI cards, Extension Apply Tracker, Recent Customers, System & Extension Health), PDF Parser & AI, Customer Profiles, Developer API Keys, Staff Management, Customer & Staff modals.
- [x] `server/public/css/style.css` — Full UI stylesheet (`Plus Jakarta Sans`, dark emerald-slate sidebar, `.dash-hero`, KPI cards, `.panel-premium`, progress bars, responsive breakpoints, modals, tables).
- [x] `server/public/js/api.js` — Frontend fetch wrapper (`API`) managing JWT token, login, dashboard stats, PDF parsing, customers, photo/signature uploads, API keys, and staff CRUD.
- [x] `server/public/js/app.js` — SPA controller: persistent hash/localStorage view routing on reload, live dashboard clock, stats & live apply tracker rendering, customer search/edit/media upload modals, and admin/staff edit modal with Gmail auto-username sync.
- [x] `server/public/js/imageHelper.js` — Client-side HTML5 Canvas resizer cropping uploaded photos to exact `300x300` and signatures to exact `300x80` JPEG.
- [x] `server/public/images/toya_logo.jpg` — Toya Telecom & Computer logo displayed on Login screen & Sidebar.
- [x] `server/public/images/favicon.png` — Browser tab icon.
- [x] `server/public/images/placeholder_photo.png` — Default preview placeholder for 300×300 candidate photo.
- [x] `server/public/images/placeholder_sign.png` — Default preview placeholder for 300×80 candidate signature.

---

### 7. Uploaded Candidate Media (`server/uploads/` — 4 files currently stored)
- [x] `server/uploads/photos/photo_CUST-2026-01002_1795583143701.jpg` — Validated 300×300 candidate photo.
- [x] `server/uploads/photos/photo_CUST-2026-01003_1795584546971.jpg` — Validated 300×300 candidate photo.
- [x] `server/uploads/signatures/sign_CUST-2026-01002_1795583142956.jpg` — Validated 300×80 candidate signature.
- [x] `server/uploads/signatures/sign_CUST-2026-01003_1795584547028.jpg` — Validated 300×80 candidate signature.

*(Note: `server/node_modules/` contains installed npm packages and is excluded from editing/listing.)*

---

## 🛠️ Quick Edit & Maintenance Checklist (For Next Time)

- [ ] **Start / Restart Server:** Run `Start-Server.bat` or `cd server && node server.js` (`http://localhost:5000`).
- [ ] **Health Check:** Open `http://localhost:5000/api/health` → expect `{"status":"OK", ...}`.
- [ ] **Change Dashboard / UI Text or Layout:** Edit `server/public/index.html`, `server/public/css/style.css`, and `server/public/js/app.js`, then hard-reload browser (`Ctrl + Shift + R`).
- [ ] **Change Customer ID Format / Database Logic:** Edit `server/config/db.js`.
- [ ] **Change Extension Auto-Fill Rules or Apply Tracking:** Edit `extension/content.js`, `extension/background.js`, or `extension/popup.js`, then click **Reload** on `chrome://extensions`.
- [ ] **Backup Important Files:** Regularly back up `server/data/db.json`, `server/.env`, and `server/uploads/`.
