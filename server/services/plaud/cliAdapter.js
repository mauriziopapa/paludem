const config = require('../../config');
const { runCommand, validateFileId, buildCliCommand, buildCliEnv } = require('../../utils/execCommand');
const { Errors } = require('../../utils/errors');
const { createLogger } = require('../../utils/logger');
const { normalizeRecording, normalizeRecordingList } = require('./recordingDto');

const log = createLogger('plaud-cli');
const SOURCE = 'cli';

// ══════════════════════════════════════
//  CLI RESOLUTION (global vs npx)
// ══════════════════════════════════════

let resolved = null;

function resolve() {
  if (resolved) return resolved;
  const cmd = buildCliCommand(config);
  const env = buildCliEnv(config);
  resolved = { ...cmd, env };
  log.info(`CLI mode: ${config.plaud.cliMode} → ${cmd.binary} ${cmd.prefixArgs.join(' ')}`.trim());
  return resolved;
}

function resetResolution() {
  resolved = null;
  cliProbe = null;
}

// ══════════════════════════════════════
//  CLI PROBE (cached availability check)
// ══════════════════════════════════════

let cliProbe = null;

async function probeCli() {
  if (cliProbe !== null) return cliProbe;

  const { binary, prefixArgs, env } = resolve();
  const probeTimeout = config.plaud.cliMode === 'npx' ? 30_000 : 10_000;

  try {
    const { stdout } = await runCommand(binary, [...prefixArgs, 'version'], {
      timeout: probeTimeout, env,
    });
    const match = stdout.match(/plaud\s+([\d.]+)/i);
    const version = match ? match[1] : stdout.trim().substring(0, 50) || null;
    cliProbe = { available: true, version };
    log.info(`PLAUD CLI found: ${version || 'unknown version'}`);
  } catch (err) {
    // If the binary exists but "version" isn't a command, still counts as found
    if (/unknown command|unknown option/i.test(err.message)) {
      cliProbe = { available: true, version: null };
      log.info('PLAUD CLI found (version subcommand not supported)');
    } else {
      cliProbe = { available: false, version: null };
      log.warn(`PLAUD CLI not available (${config.plaud.cliMode}): ${err.message}`);
    }
  }
  return cliProbe;
}

async function ensureCli() {
  const probe = await probeCli();
  if (!probe.available) {
    throw Errors.PLAUD_CLI_NOT_FOUND(
      config.plaud.cliMode === 'npx'
        ? `npx ${config.plaud.npxPackage} failed. Check network and package name.`
        : `"${config.plaud.cliBinary}" not found in PATH. Install: npm i -g @plaud-ai/cli@latest — or set PLAUD_CLI_MODE=npx`
    );
  }
}

// ══════════════════════════════════════
//  CLI RUNNER
// ══════════════════════════════════════

async function cli(args) {
  await ensureCli();

  const { binary, prefixArgs, env } = resolve();
  const fullArgs = [...prefixArgs, ...args];

  try {
    const { stdout, stderr } = await runCommand(binary, fullArgs, {
      timeout: config.plaud.cliTimeout,
      env,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('timed out')) throw Errors.PLAUD_CLI_TIMEOUT(msg);
    if (/AUTH_FAILED|not logged in|unauthorized|unauthenticated|login required|token invalid|expired|401/i.test(msg))
      throw Errors.PLAUD_CLI_NOT_AUTHENTICATED(msg);
    throw Errors.PLAUD_CLI_ERROR(msg);
  }
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// ══════════════════════════════════════
//  STATUS (three-state)
// ══════════════════════════════════════

async function getStatus() {
  const probe = await probeCli();

  if (!probe.available) {
    return {
      connected: false,
      status: 'cli_not_found',
      mode: 'cli',
      cliMode: config.plaud.cliMode,
      reason: config.plaud.cliMode === 'npx'
        ? `npx ${config.plaud.npxPackage} not available. Check network or package name.`
        : `"${config.plaud.cliBinary}" not found in PATH. Install: npm i -g @plaud-ai/cli@latest`,
    };
  }

  // CLI found — check authentication via `plaud me`
  try {
    const { stdout } = await cli(['me']);

    // Parse "me" output for user info (text format)
    const emailMatch = stdout.match(/email[:\s]+(\S+@\S+)/i);
    const nameMatch = stdout.match(/(?:name|user)[:\s]+(.+)/i);
    const user = emailMatch ? emailMatch[1] : nameMatch ? nameMatch[1].trim() : null;

    return {
      connected: true,
      status: 'authenticated',
      mode: 'cli',
      cliMode: config.plaud.cliMode,
      cliVersion: probe.version,
      user: user || '(authenticated)',
    };
  } catch (err) {
    if (err.code === 'PLAUD_CLI_NOT_AUTHENTICATED') {
      return {
        connected: false,
        status: 'not_authenticated',
        mode: 'cli',
        cliMode: config.plaud.cliMode,
        cliVersion: probe.version,
        reason: 'PLAUD CLI installed but not authenticated. Run: plaud login',
      };
    }
    return {
      connected: false,
      status: 'error',
      mode: 'cli',
      cliMode: config.plaud.cliMode,
      cliVersion: probe.version,
      reason: err.message,
    };
  }
}

// ══════════════════════════════════════
//  FILE OPERATIONS
// ══════════════════════════════════════

async function listFiles({ skip = 0, limit = 20, query } = {}) {
  // plaud files uses --page / --page-size
  const page = Math.floor(skip / limit) + 1;
  const args = ['files', '--page', String(page), '--page-size', String(limit)];

  const { stdout } = await cli(args);

  // Try JSON parse first (future CLI versions may add JSON output)
  const jsonData = tryParseJson(stdout);
  if (jsonData) {
    const items = jsonData.files || jsonData.data_file_list || jsonData.items || [];
    const total = jsonData.total || jsonData.data_file_total || items.length;
    return { recordings: normalizeRecordingList(items, SOURCE), total };
  }

  // Parse text table output
  const recordings = parseFilesTable(stdout);
  return { recordings, total: recordings.length };
}

async function getFile(fileId) {
  if (!validateFileId(fileId)) throw Errors.INVALID_FILE_ID();

  const { stdout } = await cli(['file', fileId]);

  const jsonData = tryParseJson(stdout);
  if (jsonData) {
    const detail = jsonData.data || jsonData;
    return { recording: normalizeRecording(detail, SOURCE), raw: detail };
  }

  // Parse text output
  const parsed = parseKeyValueOutput(stdout);
  parsed.file_id = fileId;
  return { recording: normalizeRecording(parsed, SOURCE), raw: parsed };
}

async function getTranscript(fileId) {
  if (!validateFileId(fileId)) throw Errors.INVALID_FILE_ID();

  const { stdout } = await cli(['transcript', fileId]);

  const jsonData = tryParseJson(stdout);
  if (jsonData) return jsonData;

  // Return text as-is for the parser to handle
  return { text: stdout };
}

async function getNote(fileId) {
  if (!validateFileId(fileId)) throw Errors.INVALID_FILE_ID();
  try {
    const { stdout } = await cli(['summary', fileId]);

    const jsonData = tryParseJson(stdout);
    if (jsonData) return jsonData;

    return { text: stdout };
  } catch {
    return null;
  }
}

async function getFullRecording(fileId) {
  if (!validateFileId(fileId)) throw Errors.INVALID_FILE_ID();

  const [fileResult, transcriptRaw, noteRaw] = await Promise.all([
    getFile(fileId),
    getTranscript(fileId).catch(() => null),
    getNote(fileId).catch(() => null),
  ]);

  return {
    recording: fileResult.recording,
    rawDetail: fileResult.raw,
    transcriptRaw,
    noteRaw,
  };
}

// ══════════════════════════════════════
//  TEXT OUTPUT PARSERS
// ══════════════════════════════════════

function parseFilesTable(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const recordings = [];

  for (const line of lines) {
    // Skip header/separator lines
    if (/^[-=─┬┼]+$/.test(line.trim())) continue;
    if (/^\s*(ID|File|Name|#)\s/i.test(line)) continue;
    if (/Fetching|Loading|Showing/i.test(line)) continue;

    // Try to extract structured data from table rows
    // Common patterns: ID | Name | Duration | Date | Size
    const parts = line.split(/\s{2,}|\t|\|/).map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const rec = {};
      // Heuristic: first column that looks like an ID (long alphanumeric)
      for (const part of parts) {
        if (/^[a-f0-9-]{8,}$/i.test(part) && !rec.file_id) {
          rec.file_id = part;
        } else if (/^\d+[smh]?\s*([\d:]+)?$/i.test(part) && !rec.duration) {
          rec.duration = parseDurationText(part);
        } else if (/\d{4}[-/]\d{2}[-/]\d{2}/.test(part) && !rec.created_at) {
          rec.created_at = part;
        } else if (/^\d+(\.\d+)?\s*(B|KB|MB|GB)$/i.test(part) && !rec.filesize) {
          rec.filesize = parseSizeText(part);
        } else if (!rec.filename && part.length > 2) {
          rec.filename = part;
        }
      }
      if (rec.file_id || rec.filename) {
        recordings.push(normalizeRecording(rec, SOURCE));
      }
    }
  }

  return recordings;
}

function parseKeyValueOutput(text) {
  const result = {};
  const lines = text.split('\n');
  for (const line of lines) {
    const match = line.match(/^\s*([^:]+?):\s+(.+)$/);
    if (match) {
      const key = match[1].trim().toLowerCase().replace(/\s+/g, '_');
      result[key] = match[2].trim();
    }
  }
  return result;
}

function parseDurationText(text) {
  const hMatch = text.match(/(\d+)h/);
  const mMatch = text.match(/(\d+)m/);
  const sMatch = text.match(/(\d+)s/);
  let total = 0;
  if (hMatch) total += parseInt(hMatch[1]) * 3600;
  if (mMatch) total += parseInt(mMatch[1]) * 60;
  if (sMatch) total += parseInt(sMatch[1]);
  if (total === 0) {
    const parts = text.split(':').map(Number);
    if (parts.length === 3) total = parts[0] * 3600 + parts[1] * 60 + parts[2];
    else if (parts.length === 2) total = parts[0] * 60 + parts[1];
  }
  return total;
}

function parseSizeText(text) {
  const match = text.match(/([\d.]+)\s*(B|KB|MB|GB)/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  switch (match[2].toUpperCase()) {
    case 'GB': return val * 1073741824;
    case 'MB': return val * 1048576;
    case 'KB': return val * 1024;
    default: return val;
  }
}

module.exports = {
  getStatus,
  listFiles,
  getFile,
  getTranscript,
  getNote,
  getFullRecording,
  probeCli,
  resetResolution,
};
