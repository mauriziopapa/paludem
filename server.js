const express = require('express');
const path = require('path');
const plaudRoutes = require('./server/routes/plaudRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──
app.use(express.json({ limit: '5mb' }));

// ── API Routes ──
app.use('/api/plaud', plaudRoutes);

// ── Health check ──
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Static files ──
app.use(express.static(path.join(__dirname, 'public')));

// ── SPA fallback ──
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[paludem] Server running on port ${PORT}`);
});
