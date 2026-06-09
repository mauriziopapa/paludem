const { Errors } = require('../../utils/errors');
const { createLogger } = require('../../utils/logger');
const { normalizeRecording, normalizeRecordingList } = require('./recordingDto');

const log = createLogger('plaud-legacy');
const SOURCE = 'legacy';

function getCredentials() {
  const baseUrl = process.env.PLAUD_BASE_URL;
  const token = process.env.PLAUD_TOKEN;
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

async function plaudFetch(url, token) {
  log.debug(`GET ${url.substring(0, 80)}...`);
  const resp = await fetch(url, {
    headers: {
      'Authorization': token,
      'Accept': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = new Error(`PLAUD API ${resp.status}: ${body.substring(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

async function getStatus() {
  const creds = getCredentials();
  if (!creds) {
    return { connected: false, mode: 'legacy_debug', reason: 'PLAUD_BASE_URL and PLAUD_TOKEN not set' };
  }
  try {
    const data = await plaudFetch(
      `${creds.baseUrl}/file/simple/web?skip=0&limit=1&is_trash=0&sort_by=edit_time&is_desc=true`,
      creds.token
    );
    return {
      connected: true,
      mode: 'legacy_debug',
      total: data.data_file_total || data.total || 0,
    };
  } catch (err) {
    return { connected: false, mode: 'legacy_debug', reason: err.message };
  }
}

async function listFiles({ skip = 0, limit = 20 } = {}) {
  const creds = getCredentials();
  if (!creds) throw Errors.LEGACY_SESSION_MISSING('Set PLAUD_BASE_URL and PLAUD_TOKEN env vars');

  const data = await plaudFetch(
    `${creds.baseUrl}/file/simple/web?skip=${skip}&limit=${limit}&is_trash=0&sort_by=edit_time&is_desc=true`,
    creds.token
  );
  const items = data.data_file_list || data.files || [];
  const total = data.data_file_total || data.total || 0;

  return {
    recordings: normalizeRecordingList(items, SOURCE),
    total,
  };
}

async function getFile(fileId) {
  const creds = getCredentials();
  if (!creds) throw Errors.LEGACY_SESSION_MISSING();

  const data = await plaudFetch(`${creds.baseUrl}/file/detail/${fileId}`, creds.token);
  const detail = data.data || data;

  return { recording: normalizeRecording(detail, SOURCE), raw: detail };
}

async function getTranscript(fileId) {
  const { raw } = await getFile(fileId);
  return raw;
}

async function getNote(fileId) {
  const { raw } = await getFile(fileId);
  return raw;
}

async function getFullRecording(fileId) {
  const { recording, raw } = await getFile(fileId);
  return { recording, rawDetail: raw, transcriptRaw: raw, noteRaw: raw };
}

module.exports = {
  getStatus,
  listFiles,
  getFile,
  getTranscript,
  getNote,
  getFullRecording,
};
