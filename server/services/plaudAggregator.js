/**
 * plaudAggregator.js
 * Orchestrates the full pipeline:
 * file detail → resolve URLs → download+decompress → parse all → aggregate
 */
const { resolveContent } = require('./plaudResolver');
const { downloadAndParse } = require('./plaudDownloader');
const { parseTranscript } = require('../parser/plaudTranscriptParser');
const { parseSummary } = require('../parser/plaudSummaryParser');
const { parseOutline } = require('../parser/plaudOutlineParser');

/**
 * Build the complete enriched transcript from a PLAUD file detail.
 *
 * @param {Object} fileDetail - The raw file detail data from PLAUD API
 * @param {Object} options - Parser options
 * @returns {Object} Aggregated result
 */
async function buildFullTranscript(fileDetail, options = {}) {
  const log = [];
  const addLog = (msg, level = 'info') => log.push({ ts: Date.now(), level, msg });

  addLog('Starting pipeline');

  // ── Step 1: Resolve content URLs ──
  addLog('Resolving content URLs');
  const urls = resolveContent(fileDetail);
  addLog(`Found: transcript=${!!urls.transcriptUrl}, outline=${!!urls.outlineUrl}, summary=${!!urls.summaryUrl}, notes=${urls.notesUrls.length}`);

  // ── Step 2: Download & parse all in parallel ──
  const tasks = {};

  if (urls.transcriptUrl) {
    tasks.transcript = safeDownloadAndParse(urls.transcriptUrl, addLog, 'transcript');
  }
  if (urls.outlineUrl) {
    tasks.outline = safeDownloadAndParse(urls.outlineUrl, addLog, 'outline');
  }
  if (urls.summaryUrl) {
    tasks.summary = safeDownloadAndParse(urls.summaryUrl, addLog, 'summary');
  }

  const notePromises = urls.notesUrls.map((n, i) =>
    safeDownloadAndParse(n.url, addLog, `note-${i}`).then(result => ({
      ...result,
      title: n.title,
      type: n.type,
    }))
  );

  // Await all
  const [transcriptRaw, outlineRaw, summaryRaw, ...notesRaw] = await Promise.all([
    tasks.transcript || Promise.resolve(null),
    tasks.outline || Promise.resolve(null),
    tasks.summary || Promise.resolve(null),
    ...notePromises,
  ]);

  // ── Step 3: Parse each content type ──
  addLog('Parsing transcript');
  let transcript = null;
  if (transcriptRaw) {
    try {
      const data = transcriptRaw.type === 'json' ? transcriptRaw.data : transcriptRaw.data;
      transcript = parseTranscript(data, options);
      addLog(`Transcript parsed: ${transcript.stats.segmentsCount} segments, ${transcript.stats.wordsCount} words`, 'ok');
    } catch (err) {
      addLog(`Transcript parse error: ${err.message}`, 'error');
    }
  }

  addLog('Parsing summary');
  let summary = null;
  if (summaryRaw) {
    try {
      const text = summaryRaw.type === 'text' ? summaryRaw.data : JSON.stringify(summaryRaw.data);
      summary = parseSummary(text);
      addLog('Summary parsed', 'ok');
    } catch (err) {
      addLog(`Summary parse error: ${err.message}`, 'error');
    }
  }

  addLog('Parsing outline');
  let outline = null;
  if (outlineRaw) {
    try {
      outline = parseOutline(outlineRaw.type === 'json' ? outlineRaw.data : outlineRaw.data);
      addLog(`Outline parsed: ${outline.sections.length} sections`, 'ok');
    } catch (err) {
      addLog(`Outline parse error: ${err.message}`, 'error');
    }
  }

  // Parse notes
  const notes = [];
  for (const noteRaw of notesRaw) {
    if (!noteRaw) continue;
    try {
      const content = noteRaw.type === 'text'
        ? noteRaw.data
        : (typeof noteRaw.data === 'string' ? noteRaw.data : JSON.stringify(noteRaw.data, null, 2));
      notes.push({
        title: noteRaw.title || 'Note',
        type: noteRaw.type || 'unknown',
        content,
      });
    } catch (err) {
      addLog(`Note parse error: ${err.message}`, 'error');
    }
  }

  // ── Step 4: Build metadata ──
  const metadata = {
    fileId: fileDetail.file_id || fileDetail.id,
    filename: fileDetail.filename || fileDetail.name || fileDetail.title,
    duration: fileDetail.duration,
    createdAt: fileDetail.start_time
      ? new Date(fileDetail.start_time * 1000).toISOString()
      : fileDetail.created_at,
    filesize: fileDetail.filesize,
    hasTranscript: !!transcript,
    hasSummary: !!summary,
    hasOutline: !!outline,
    notesCount: notes.length,
    resolvedUrls: {
      transcript: !!urls.transcriptUrl,
      outline: !!urls.outlineUrl,
      summary: !!urls.summaryUrl,
      notes: urls.notesUrls.length,
    },
  };

  addLog('Pipeline complete', 'ok');

  return {
    transcript,
    summary,
    outline,
    notes,
    metadata,
    log,
  };
}

/**
 * Safe wrapper: download + parse, returning null on failure.
 */
async function safeDownloadAndParse(url, addLog, label) {
  try {
    addLog(`Downloading ${label}...`);
    const result = await downloadAndParse(url);
    addLog(`Downloaded ${label} (${result.type})`, 'ok');
    return result;
  } catch (err) {
    addLog(`Download failed [${label}]: ${err.message}`, 'error');
    return null;
  }
}

module.exports = { buildFullTranscript };
