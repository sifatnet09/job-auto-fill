# GovJob AutoFill - Web Application & Browser Extension

An end-to-end cloud and browser automation system designed to extract structured candidate details from Bangladeshi government job application PDFs (Teletalk applicant copies e.g., DWA, BEPZA, BPSC, Railway, etc.) using Gemini AI Vision & OCR, manage customer profiles with strict photo (300x300) and signature (300x80) standards, and auto-fill online application forms across government recruitment portals via Developer API Key authentication.

---

## 🌟 System Architecture & Key Features

### 1. Web Application (`server/`)
* **Central Dashboard & PDF Parsing**:
  * Upload any government job application PDF (scanned image PDFs and digitally generated PDFs).
  * Multimodal **Google Gemini 1.5/2.0 Flash Vision OCR** integration extracts all applicant information:
    * Full Name (English & বাংলা)
    * Father & Mother Names (English & বাংলা)
    * Date of Birth (YYYY-MM-DD), Gender, Religion, Nationality
    * NID No, Birth Registration No, Passport ID
    * Marital Status & Spouse Name
    * Mobile Number & Email
    * Quota (Freedom Fighter, Disabled, Ethnic, etc.) & Departmental Status
    * Present & Permanent Addresses (Care of, Village, District, Upazila, Post Office, Post Code)
    * Educational Qualifications (Class Eight/JSC, SSC, HSC, Graduation)
  * Includes a built-in rule-based fallback parser that works offline without an external API key.
* **Customer Management**:
  * Dedicated customer profile manager.
  * Every profile automatically generates a **Unique Customer ID** (`CUST-2026-XXXX`).
  * **Strict Image Upload & Resizing Tool**:
    * **Photo**: Strictly resized, validated, and cropped to **300 x 300 pixels** (Teletalk standard).
    * **Signature**: Strictly resized, validated, and cropped to **300 x 80 pixels** (Teletalk standard).
    * Both server-side pixel header validation and client-side HTML5 canvas cropping ensure no invalid file can ever be uploaded.
* **Developer API Keys**:
  * Generate cryptographic developer API keys (`govfill_live_...`) to link browser extensions to the web application.
  * Secret key displayed once upon creation with 1-click copy.
  * View active keys, prefix, creator, last used timestamp, and revoke any key instantly.
* **Role-Based Access Control (RBAC)**:
  * Multi-user login panel supporting **Admin** and **Employee (Operator)** roles.
  * **Admin**: Complete system control, user account creation, API key management, customer profile deletion.
  * **Employee**: PDF parsing, customer management, photo/signature uploads, and profile editing.
* **End-to-End Security & Encryption**:
  * All sensitive customer records (NID, Mobile, DOB, Email, Addresses) and developer keys are encrypted at rest using **AES-256-GCM**.
  * User passwords hashed with **bcrypt (10 rounds)**.
  * Secure JWT authentication with 7-day session tokens.

---

### 2. Browser Extension (`extension/`)
* **Input Settings & Authentication**:
  * Requires the operator to enter:
    1. **Web App Server URL** (`http://localhost:5000` or production URL)
    2. **Developer API Key** (`govfill_live_...`)
    3. **Customer ID** (`CUST-2026-XXXX`)
  * One-click **Authenticate & Connect** button verifies credentials with the server.
  * Searchable dropdown populated directly from the web application's active customer database.
* **Auto-Fill Integration**:
  * Securely fetches the structured customer profile from the web application API.
  * Automatically fills out target government job applications (e.g. `bepza.teletalk.com.bd`, `dwa.teletalk.com.bd`, `railway.teletalk.com.bd`, `*.teletalk.com.bd/*`, and generic portals).
  * Accurately handles dependent dropdowns (District -> Upazila, Examination -> Group/Board/Passing Year).
  * Emits native synthetic DOM & jQuery events (`focus`, `input`, `change`, `click`, `blur`) so form validators register the state.
  * Highlights filled fields with a smooth green pulse.
  * **In-Page Floating Widget**: Non-intrusive floating button on target pages with 1-click auto-fill, plus direct download links for the candidate's 300x300 photo and 300x80 signature.

---

## 🚀 Quick Start Guide

### Step 1: Start the Web Application Server

1. Open a terminal in the project directory:
   ```bash
   cd "c:\Users\Toya Computer\Documents\Extention\Job Auto Fill\server"
   node server.js
   ```
   *(Or simply double-click the included [`Start-Server.bat`](file:///c:/Users/Toya%20Computer/Documents/Extention/Job%20Auto%20Fill/Start-Server.bat) file).*
2. The server will start on **`http://localhost:5000`**.

### Step 2: Log In to the Dashboard

1. Open your browser and navigate to **`http://localhost:5000`**.
2. Sign in using the pre-seeded default credentials:
   * **Admin Account**:
     * Username: `admin`
     * Password: `Admin@123456`
   * **Employee Account**:
     * Username: `employee`
     * Password: `Employee@123456`

### Step 3: Parse a PDF or View Customers

1. Go to the **"PDF Parser & AI"** tab.
2. Drag and drop any Teletalk applicant copy PDF (e.g., `DWA_5Q23P8ZJ.pdf`).
3. The system extracts all details and automatically generates a unique Customer ID (e.g. `CUST-2026-01001`).
4. In the **"Customer Profiles"** tab, click **View / Edit** on any candidate to inspect details or upload strictly formatted **300x300 photos** and **300x80 signatures**.

### Step 4: Generate a Developer API Key

1. Go to the **"Developer API Keys"** tab in the dashboard.
2. Click **Generate New Key**, enter a label (e.g., `Main Counter Chrome Extension`), and click Generate.
3. Copy the generated key:
   ```
   govfill_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
   *(A demo key `govfill_live_2e9494b27073a7aa7b9ab83a54f6a5e4aa692e336fd0bd8b` is already active).*

### Step 5: Install & Connect the Browser Extension

1. Open Chrome/Edge and go to `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (toggle in top-right).
3. Click **Load unpacked** and select the folder:
   ```
   c:\Users\Toya Computer\Documents\Extention\Job Auto Fill\extension
   ```
4. Click the extension icon in your browser toolbar:
   * **Server URL**: `http://localhost:5000`
   * **Developer API Key**: Paste your generated key
   * Click **🔐 Authenticate & Connect**
   * **Customer ID**: Enter or select `CUST-2026-01001` (or click the dropdown to select any customer)
5. Navigate to any government job application page (e.g., `https://bepza.teletalk.com.bd/bepza202611/application.php`) and click **⚡ Auto-Fill Application Form** (or click the in-page floating widget).
6. All fields will instantly be populated and verified with 100% accuracy!

---

## 📁 Repository Directory Structure

```
Job Auto Fill/
├── Start-Server.bat           # Windows 1-click launcher for the server
├── README.md                  # Complete documentation
│
├── server/                    # Web Application (Backend & Dashboard SPA)
│   ├── package.json
│   ├── server.js              # Express REST API & static server
│   ├── .env                   # Configuration & secret keys
│   ├── config/
│   │   ├── db.js              # Encrypted file database with atomic persistence
│   │   └── security.js        # AES-256-GCM encryption & bcrypt hashing
│   ├── middleware/
│   │   ├── auth.js            # JWT role-based access (Admin / Employee)
│   │   └── apiKeyAuth.js      # Developer API Key verification for extension
│   ├── services/
│   │   ├── pdfService.js      # PDF text & embedded image extractor
│   │   ├── geminiService.js   # Multimodal Gemini AI OCR + rule-based fallback
│   │   └── imageValidator.js  # Strict 300x300 and 300x80 pixel header inspector
│   ├── routes/
│   │   ├── authRoutes.js      # /api/auth (login, me, staff accounts)
│   │   ├── customerRoutes.js  # /api/customers (CRUD, 300x300 photo, 300x80 sign)
│   │   ├── parseRoutes.js     # /api/parse/pdf (upload & OCR extract)
│   │   ├── apiKeyRoutes.js    # /api/keys (generate, list, revoke developer keys)
│   │   └── extensionRoutes.js # /api/v1/extension (extension client API)
│   └── public/                # Modern Responsive Web App Dashboard
│       ├── index.html         # Single Page Application
│       ├── css/style.css      # Polished styling
│       └── js/
│           ├── app.js         # UI routing & modal controller
│           ├── api.js         # API client & JWT storage
│           └── imageHelper.js # Client-side 300x300 & 300x80 canvas crop/resize
│
└── extension/                 # Chrome / Edge Extension (Manifest V3)
    ├── manifest.json          # Manifest V3 configuration
    ├── popup.html             # Extension popup UI (API key, Customer ID, preview)
    ├── popup.css              # Popup styling
    ├── popup.js               # Extension authentication & autofill trigger
    ├── content.js             # Teletalk & generic form autofill engine
    ├── content.css            # Floating widget & visual highlight styles
    ├── background.js          # Service worker & context menus
    └── icons/                 # Extension icons (16px, 48px, 128px)
```
