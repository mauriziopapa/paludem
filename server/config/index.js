const isRailway = !!(
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.RAILWAY_ENVIRONMENT_NAME ||
  process.env.RAILWAY_PROJECT_ID
);

const plaudHome = process.env.PLAUD_HOME || (isRailway ? '/app/.plaud' : '');

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  isRailway,

  plaud: {
    mode: process.env.PLAUD_INTEGRATION_MODE || 'cli',
    cliMode: process.env.PLAUD_CLI_MODE || 'global',
    cliBinary: process.env.PLAUD_CLI_BIN || 'plaud',
    npxPackage: process.env.PLAUD_CLI_NPX_PACKAGE || '@plaud-ai/cli@latest',
    home: plaudHome,
    cliTimeout: parseInt(process.env.PLAUD_COMMAND_TIMEOUT_MS, 10) || 60_000,
    tokensJson: process.env.PLAUD_TOKENS_JSON || '',
    autoBootstrapTokens: process.env.PLAUD_AUTO_BOOTSTRAP_TOKENS !== 'false',
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
