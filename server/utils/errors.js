class AppError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message } };
  }
}

const Errors = {
  PLAUD_NOT_CONFIGURED:       (detail) => new AppError('PLAUD_NOT_CONFIGURED',       detail || 'PLAUD integration not configured', 503),
  PLAUD_CLI_NOT_FOUND:        (detail) => new AppError('PLAUD_CLI_NOT_FOUND',        detail || 'PLAUD CLI not found. Install: npm i -g @plaud-ai/cli@latest — or set PLAUD_CLI_MODE=npx', 503),
  PLAUD_CLI_NOT_AUTHENTICATED:(detail) => new AppError('PLAUD_CLI_NOT_AUTHENTICATED', detail || 'PLAUD CLI installed but not authenticated. Run: plaud login', 401),
  PLAUD_CLI_ERROR:            (detail) => new AppError('PLAUD_CLI_ERROR',             detail || 'PLAUD CLI command failed', 502),
  PLAUD_CLI_TIMEOUT:          (detail) => new AppError('PLAUD_CLI_TIMEOUT',           detail || 'PLAUD CLI command timed out', 504),
  PLAUD_NOT_LOGGED_IN:        (detail) => new AppError('PLAUD_NOT_LOGGED_IN',         detail || 'Not logged in to PLAUD CLI. Run: plaud login', 401),
  PLAUD_FILE_NOT_FOUND:       (detail) => new AppError('PLAUD_FILE_NOT_FOUND',        detail || 'Recording not found', 404),
  INVALID_FILE_ID:            (detail) => new AppError('INVALID_FILE_ID',             detail || 'Invalid file ID format', 400),
  MISSING_PARAM:              (detail) => new AppError('MISSING_PARAM',               detail || 'Missing required parameter', 400),
  NO_TRANSCRIPT:              (detail) => new AppError('NO_TRANSCRIPT',               detail || 'No transcript available for this recording', 422),
  N8N_NOT_CONFIGURED:         (detail) => new AppError('N8N_NOT_CONFIGURED',          detail || 'n8n webhook URL not configured', 503),
  LEGACY_SESSION_MISSING:     (detail) => new AppError('LEGACY_SESSION_MISSING',      detail || 'No active legacy session. Connect first.', 401),
};

module.exports = { AppError, Errors };
