require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const authRoutes = require('./routes/authRoutes');
const customerRoutes = require('./routes/customerRoutes');
const parseRoutes = require('./routes/parseRoutes');
const apiKeyRoutes = require('./routes/apiKeyRoutes');
const extensionRoutes = require('./routes/extensionRoutes');
const Auth = require('./middleware/auth');
const db = require('./config/db');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Ensure upload directories exist
const uploadsDir = path.join(__dirname, 'uploads');
['photos', 'signatures', 'temp'].forEach(sub => {
  const p = path.join(uploadsDir, sub);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// Serve uploaded media
app.use('/uploads', express.static(uploadsDir));

// Serve SPA Frontend
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/parse', parseRoutes);
app.use('/api/keys', apiKeyRoutes);
app.use('/api/v1/extension', extensionRoutes);

// Dashboard live statistics & tracked applications
app.get('/api/dashboard/stats', Auth.verifyToken, (req, res) => {
  res.json({
    success: true,
    stats: db.getDashboardStats()
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'GovJob Autofill Cloud & Parser API',
    time: new Date().toISOString()
  });
});

// Fallback to SPA index.html for frontend client routing
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/uploads')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next();
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error'
  });
});

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`  GovJob AutoFill Server running on http://localhost:${PORT}`);
  console.log(`  Default Admin: admin / Admin@123456`);
  console.log(`  Default Employee: employee / Employee@123456`);
  console.log(`====================================================`);
});
