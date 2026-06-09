const path = require('path');

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,

  plaud: {
    mode: process.env.PLAUD_INTEGRATION_MODE || 'cli',
    cliBinary: process.env.PLAUD_CLI_PATH || 'plaud',
    cliTimeout: parseInt(process.env.PLAUD_CLI_TIMEOUT, 10) || 30_000,
  },

  n8n: {
    webhookUrl: process.env.N8N_WEBHOOK_URL || '',
    apiKey: process.env.N8N_API_KEY || '',
    callbackBaseUrl: process.env.CALLBACK_BASE_URL || '',
  },

  session: {
    ttlMs: parseInt(process.env.SESSION_TTL_MS, 10) || 4 * 60 * 60 * 1000,
    cacheTtlMs: parseInt(process.env.CACHE_TTL_MS, 10) || 30 * 60 * 1000,
  },

  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',
};

module.exports = config;
