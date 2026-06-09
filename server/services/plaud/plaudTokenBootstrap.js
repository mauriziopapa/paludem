const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../../config');
const { createLogger } = require('../../utils/logger');

const log = createLogger('plaud-bootstrap');

let bootstrapResult = null;

function getTokensDir() {
  if (config.plaud.home) return config.plaud.home;
  return path.join(os.homedir(), '.plaud');
}

async function bootstrapPlaudTokens() {
  if (bootstrapResult !== null) return bootstrapResult;

  if (!config.plaud.tokensJson) {
    bootstrapResult = { bootstrapped: false, path: null, reason: 'PLAUD_TOKENS_JSON not set' };
    return bootstrapResult;
  }

  if (!config.plaud.autoBootstrapTokens) {
    bootstrapResult = { bootstrapped: false, path: null, reason: 'Auto-bootstrap disabled (PLAUD_AUTO_BOOTSTRAP_TOKENS=false)' };
    return bootstrapResult;
  }

  let parsed;
  try {
    parsed = JSON.parse(config.plaud.tokensJson);
  } catch {
    log.error('PLAUD_TOKENS_JSON contains invalid JSON');
    bootstrapResult = { bootstrapped: false, path: null, reason: 'PLAUD_TOKENS_JSON is not valid JSON' };
    return bootstrapResult;
  }

  if (!parsed || typeof parsed !== 'object') {
    log.error('PLAUD_TOKENS_JSON must be a JSON object');
    bootstrapResult = { bootstrapped: false, path: null, reason: 'PLAUD_TOKENS_JSON is not a JSON object' };
    return bootstrapResult;
  }

  const dir = getTokensDir();
  const tokensPath = path.join(dir, 'tokens.json');

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokensPath, JSON.stringify(parsed, null, 2), { mode: 0o600 });
    log.info(`Tokens bootstrapped to ${tokensPath}`);
    bootstrapResult = { bootstrapped: true, path: tokensPath, reason: null };
  } catch (err) {
    log.error(`Failed to write tokens: ${err.message}`);
    bootstrapResult = { bootstrapped: false, path: tokensPath, reason: `Write failed: ${err.message}` };
  }

  return bootstrapResult;
}

function getBootstrapResult() {
  return bootstrapResult;
}

module.exports = { bootstrapPlaudTokens, getBootstrapResult };
