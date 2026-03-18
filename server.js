const express = require('express');
const path = require('path');
const plaudRoutes = require('./server/routes/plaudRoutes');
const n8nRoutes = require('./server/routes/n8nRoutes');
const { getSessionInfo } = require('./server/services/sessionStore');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──
app.use(express.json({ limit: '5mb' }));

// ── API Routes ──
app.use('/api/plaud', plaudRoutes);
app.use('/api/n8n', n8nRoutes);

// ── Health check ──
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    session: getSessionInfo(),
    n8n: { configured: !!process.env.N8N_WEBHOOK_URL },
  });
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
