const express = require('express');
const router = express.Router();
const plaudProvider = require('../services/plaud/provider');
const { buildFullTranscript } = require('../services/plaudAggregator');
const { exportBADocx } = require('../services/docxExporter');
const { cacheTranscript, getCachedTranscript } = require('../services/sessionStore');
const { parseTranscript } = require('../parser/plaudTranscriptParser');
const { parseSummary } = require('../parser/plaudSummaryParser');
const { parseOutline } = require('../parser/plaudOutlineParser');
const { validateFileId } = require('../utils/execCommand');
const { AppError, Errors } = require('../utils/errors');
const { createLogger } = require('../utils/logger');

const log = createLogger('plaud-routes');

router.use((_req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Expires': '0' });
  next();
});

function sendError(res, err) {
  if (err instanceof AppError) {
    return res.status(err.status).json(err.toJSON());
  }
  log.error(err.message);
  res.status(err.status || 500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
}

/**
 * GET /api/plaud/status
 * PLAUD connection status.
 */
router.get('/status', async (_req, res) => {
  try {
    const status = await plaudProvider.getStatus();
    res.json(status);
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * GET /api/plaud/files
 * List recordings with pagination.
 */
router.get('/files', async (req, res) => {
  try {
    const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const query = req.query.q || undefined;

    const data = await plaudProvider.listFiles({ skip, limit, query });
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * GET /api/plaud/files/:fileId
 * Get file metadata.
 */
router.get('/files/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!validateFileId(fileId)) throw Errors.INVALID_FILE_ID();

    const data = await plaudProvider.getFile(fileId);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * GET /api/plaud/files/:fileId/transcript
 * Get parsed transcript for a recording.
 */
router.get('/files/:fileId/transcript', async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!validateFileId(fileId)) throw Errors.INVALID_FILE_ID();

    const removeFillers = req.query.removeFillers === '1';
    const mergeGap = Number(req.query.mergeGap) || 3;

    const raw = await plaudProvider.getTranscript(fileId);
    if (!raw) throw Errors.NO_TRANSCRIPT();

    const parsed = parseTranscript(raw, { removeFillers, mergeGap });
    res.json(parsed);
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * GET /api/plaud/files/:fileId/note
 * Get summary/note for a recording.
 */
router.get('/files/:fileId/note', async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!validateFileId(fileId)) throw Errors.INVALID_FILE_ID();

    const raw = await plaudProvider.getNote(fileId);
    if (!raw) return res.json({ summary: null, outline: null });

    let summary = null;
    let outline = null;

    if (typeof raw === 'string') {
      summary = parseSummary(raw);
    } else if (raw.summary || raw.auto_sum_note) {
      summary = parseSummary(raw.summary || raw.auto_sum_note);
    }
    if (raw.outline || raw.ai_outline) {
      outline = parseOutline(raw.outline || raw.ai_outline);
    }

    res.json({ summary, outline });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * GET /api/plaud/files/:fileId/full
 * Full Content Reconstruction Engine pipeline.
 * Returns: { transcript, summary, outline, notes, metadata, meta, log, debug, rawDetail }
 */
router.get('/files/:fileId/full', async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!validateFileId(fileId)) throw Errors.INVALID_FILE_ID();

    const removeFillers = req.query.removeFillers === '1';
    const mergeGap = Number(req.query.mergeGap) || 3;

    const fullData = await plaudProvider.getFullRecording(fileId);
    const rawDetail = fullData.rawDetail;

    const contentList = rawDetail?.content_list
      || rawDetail?.contents
      || rawDetail?.data_content_list
      || [];

    let result;

    if (contentList.length > 0) {
      result = await buildFullTranscript(rawDetail, { removeFillers, mergeGap });
    } else {
      result = buildResultFromCliOutput(fullData, { removeFillers, mergeGap });
    }

    cacheTranscript(fileId, result);
    result.rawDetail = rawDetail;

    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /api/plaud/files/:fileId/process-ba
 * Trigger local BA generation for a recording.
 */
router.post('/files/:fileId/process-ba', async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!validateFileId(fileId)) throw Errors.INVALID_FILE_ID();

    let pipelineResult = getCachedTranscript(fileId);
    if (!pipelineResult) {
      const fullData = await plaudProvider.getFullRecording(fileId);
      const rawDetail = fullData.rawDetail;
      const contentList = rawDetail?.content_list || rawDetail?.contents || rawDetail?.data_content_list || [];

      if (contentList.length > 0) {
        pipelineResult = await buildFullTranscript(rawDetail, { removeFillers: false, mergeGap: 3 });
      } else {
        pipelineResult = buildResultFromCliOutput(fullData, { removeFillers: false, mergeGap: 3 });
      }
      cacheTranscript(fileId, pipelineResult);
    }

    if (!pipelineResult?.transcript?.fullText) {
      throw Errors.NO_TRANSCRIPT();
    }

    res.json({ success: true, pipelineResult });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /api/plaud/export-docx
 * Generate .docx from BA document object.
 */
router.post('/export-docx', async (req, res) => {
  try {
    const { baDocument } = req.body;
    if (!baDocument) throw Errors.MISSING_PARAM('Missing baDocument in request body');

    const buffer = await exportBADocx(baDocument);
    const filename = (baDocument.title || 'BA_Document').replace(/[^a-zA-Z0-9_\-\s]/g, '').substring(0, 80);

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${filename}_BA.docx"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  } catch (err) {
    sendError(res, err);
  }
});

function buildResultFromCliOutput(fullData, options) {
  const { transcriptRaw, noteRaw, recording } = fullData;
  let transcript = null;
  let summary = null;
  let outline = null;

  if (transcriptRaw) {
    try { transcript = parseTranscript(transcriptRaw, options); } catch { /* skip */ }
  }
  if (noteRaw) {
    if (typeof noteRaw === 'string') {
      try { summary = parseSummary(noteRaw); } catch { /* skip */ }
    } else {
      if (noteRaw.summary || noteRaw.auto_sum_note) {
        try { summary = parseSummary(noteRaw.summary || noteRaw.auto_sum_note); } catch { /* skip */ }
      }
      if (noteRaw.outline || noteRaw.ai_outline) {
        try { outline = parseOutline(noteRaw.outline || noteRaw.ai_outline); } catch { /* skip */ }
      }
    }
  }

  return {
    transcript,
    summary,
    outline,
    notes: [],
    metadata: {
      fileId: recording?.id,
      filename: recording?.name,
      duration: recording?.duration,
      createdAt: recording?.createdAt,
      filesize: recording?.filesize,
      hasTranscript: !!transcript,
      hasSummary: !!summary,
      hasOutline: !!outline,
      notesCount: 0,
      contentListSize: 0,
    },
    meta: { pipelineMs: 0 },
    log: [],
    debug: [],
  };
}

module.exports = router;
