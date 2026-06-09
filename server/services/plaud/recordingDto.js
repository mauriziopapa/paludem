function normalizeRecording(raw, source) {
  return {
    id:        raw.file_id || raw.id || raw.fileId || '',
    name:      raw.filename || raw.name || raw.title || 'Untitled',
    duration:  parseDuration(raw.duration),
    createdAt: parseDate(raw.start_time || raw.created_at || raw.createdAt),
    filesize:  raw.filesize || raw.size || 0,
    source,
  };
}

function normalizeRecordingList(items, source) {
  return (items || []).map(item => normalizeRecording(item, source));
}

function parseDuration(val) {
  if (!val) return 0;
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

function parseDate(val) {
  if (!val) return null;
  if (typeof val === 'string') return val;
  const n = Number(val);
  if (isNaN(n)) return null;
  if (n > 1e12) return new Date(n).toISOString();
  if (n > 1e9) return new Date(n * 1000).toISOString();
  return null;
}

module.exports = { normalizeRecording, normalizeRecordingList };
