const config = require('../../config');
const { runCommand, validateFileId } = require('../../utils/execCommand');
const { Errors } = require('../../utils/errors');
const { createLogger } = require('../../utils/logger');
const { normalizeRecording, normalizeRecordingList } = require('./recordingDto');

const log = createLogger('plaud-cli');
const SOURCE = 'cli';

let cliChecked = false;
let cliAvailable = false;

async function checkCli() {
  if (cliChecked) return cliAvailable;
  try {
    await runCommand(config.plaud.cliBinary, ['--version'], { timeout: 5000 });
    cliAvailable = true;
    log.info('PLAUD CLI found');
  } catch {
    cliAvailable = false;
    log.warn('PLAUD CLI not found at:', config.plaud.cliBinary);
  }
  cliChecked = true;
  return cliAvailable;
}

function resetCliCheck() {
  cliChecked = false;
  cliAvailable = false;
}

async function ensureCli() {
  if (!(await checkCli())) {
    throw Errors.PLAUD_CLI_NOT_FOUND();
  }
}

async function cli(args) {
  await ensureCli();
  try {
    const { stdout } = await runCommand(config.plaud.cliBinary, args, {
      timeout: config.plaud.cliTimeout,
    });
    return stdout.trim();
  } catch (err) {
    if (err.message.includes('timed out')) throw Errors.PLAUD_CLI_TIMEOUT(err.message);
    if (err.message.includes('not logged in') || err.message.includes('unauthorized'))
      throw Errors.PLAUD_NOT_LOGGED_IN(err.message);
    throw Errors.PLAUD_CLI_ERROR(err.message);
  }
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

async function getStatus() {
  const available = await checkCli();
  if (!available) {
    return { connected: false, mode: 'cli', reason: 'CLI not found' };
  }
  try {
    const out = await cli(['status', '--json']);
    const data = tryParseJson(out);
    return {
      connected: true,
      mode: 'cli',
      user: data?.user || data?.email || null,
      cliVersion: data?.version || null,
    };
  } catch (err) {
    if (err.code === 'PLAUD_NOT_LOGGED_IN') {
      return { connected: false, mode: 'cli', reason: 'Not logged in' };
    }
    return { connected: false, mode: 'cli', reason: err.message };
  }
}

async function listFiles({ skip = 0, limit = 20, query } = {}) {
  const args = ['files', '--json', '--skip', String(skip), '--limit', String(limit)];
  if (query) args.push('--query', String(query).substring(0, 200));

  const out = await cli(args);
  const data = tryParseJson(out);

  if (!data) {
    return { recordings: [], total: 0 };
  }

  const items = data.files || data.data_file_list || data.items || [];
  const total = data.total || data.data_file_total || items.length;

  return {
    recordings: normalizeRecordingList(items, SOURCE),
    total,
  };
}

async function getFile(fileId) {
  if (!validateFileId(fileId)) throw Errors.INVALID_FILE_ID();
  const out = await cli(['file', fileId, '--json']);
  const data = tryParseJson(out);
  if (!data) throw Errors.PLAUD_FILE_NOT_FOUND();
  const detail = data.data || data;
  return { recording: normalizeRecording(detail, SOURCE), raw: detail };
}

async function getTranscript(fileId) {
  if (!validateFileId(fileId)) throw Errors.INVALID_FILE_ID();
  const out = await cli(['transcript', fileId, '--json']);
  const data = tryParseJson(out);
  return data || { text: out };
}

async function getNote(fileId) {
  if (!validateFileId(fileId)) throw Errors.INVALID_FILE_ID();
  try {
    const out = await cli(['summary', fileId, '--json']);
    const data = tryParseJson(out);
    return data || { text: out };
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

module.exports = {
  getStatus,
  listFiles,
  getFile,
  getTranscript,
  getNote,
  getFullRecording,
  checkCli,
  resetCliCheck,
};
