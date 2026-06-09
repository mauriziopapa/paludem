const express = require('express');
const path = require('path');
const config = require('./server/config');
const { createLogger } = require('./server/utils/logger');
const { bootstrapPlaudTokens } = require('./server/services/plaud/plaudTokenBootstrap');
const plaudRoutes = require('./server/routes/plaudRoutes');
const n8nRoutes = require('./server/routes/n8nRoutes');

const log = createLogger('server');
const app = express();

app.use(express.json({ limit: '5mb' }));

// Bootstrap PLAUD tokens from env before any CLI calls
bootstrapPlaudTokens().then(result => {
  if (result.bootstrapped) {
    log.info('PLAUD token bootstrap complete');
  } else if (config.plaud.tokensJson) {
    log.warn(`PLAUD token bootstrap skipped: ${result.reason}`);
  }
}).catch(err => {
  log.error(`PLAUD token bootstrap error: ${err.message}`);
});

app.use('/api/plaud', plaudRoutes);
app.use('/api/n8n', n8nRoutes);

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    plaudMode: config.plaud.mode,
    n8n: { configured: !!config.n8n.webhookUrl },
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(config.port, '0.0.0.0', () => {
  log.info(`Server running on port ${config.port} (mode: ${config.plaud.mode})`);
});
