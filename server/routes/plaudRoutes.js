/**
 * plaudRoutes.js
 *
 * API endpoints for the PLAUD Meeting Intelligence Engine.
 * All PLAUD API calls are proxied through the backend to:
 * - Avoid CORS issues
 * - Handle gzip decompression server-side
 * - Run the full content reconstruction pipeline
 */
const express = require('express');
const router = express.Router();
const { buildFullTranscript } = require('../services/plaudAggregator');
const { exportBADocx } = require('../services/docxExporter');

// ── Proxy: forward auth header to PLAUD API ──
async function plaudFetch(url, authHeader) {
  const resp = await fetch(url, {
    headers: {
      'Authorization': authHeader,
      'Accept': 'application/json',
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

/**
 * GET /api/plaud/connect
 * Test connection & return basic info.
 */
router.get('/connect', async (req, res) => {
  try {
    const { base_url } = req.query;
    const auth = req.headers.authorization;
    if (!auth || !base_url) {
      return res.status(400).json({ error: 'Missing authorization header or base_url query param' });
    }

    const data = await plaudFetch(
      `${base_url}/file/simple/web?skip=0&limit=1&is_trash=0&sort_by=edit_time&is_desc=true`,
      auth
    );

    res.json({
      connected: true,
      total: data.data_file_total || data.total || 0,
      data,
    });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

/**
 * GET /api/plaud/recordings
 * List recordings with pagination.
 */
router.get('/recordings', async (req, res) => {
  try {
    const { base_url, skip = 0, limit = 20 } = req.query;
    const auth = req.headers.authorization;
    if (!auth || !base_url) {
      return res.status(400).json({ error: 'Missing authorization or base_url' });
    }

    const data = await plaudFetch(
      `${base_url}/file/simple/web?skip=${skip}&limit=${limit}&is_trash=0&sort_by=edit_time&is_desc=true`,
      auth
    );

    res.json({
      recordings: data.data_file_list || data.files || [],
      total: data.data_file_total || data.total || 0,
    });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

/**
 * GET /api/plaud/:fileId
 * Full Content Reconstruction Engine pipeline.
 *
 * Query params:
 *   base_url      — PLAUD API base URL
 *   removeFillers — 0|1 (default 0)
 *   mergeGap      — seconds (default 3)
 *
 * Response:
 *   { transcript, summary, outline, notes, metadata, meta, log, debug, rawDetail }
 */
router.get('/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const { base_url, removeFillers = '0', mergeGap = '3' } = req.query;
    const auth = req.headers.authorization;

    if (!auth || !base_url) {
      return res.status(400).json({ error: 'Missing authorization or base_url' });
    }

    // 1. Fetch file detail from PLAUD API
    const detailResp = await plaudFetch(`${base_url}/file/detail/${fileId}`, auth);
    const fileDetail = detailResp.data || detailResp;

    // 2. Run full Content Reconstruction Engine pipeline
    const result = await buildFullTranscript(fileDetail, {
      removeFillers: removeFillers === '1',
      mergeGap: Number(mergeGap) || 3,
    });

    // 3. Attach raw detail for frontend fallbacks
    result.rawDetail = fileDetail;

    res.json(result);
  } catch (err) {
    console.error(`[plaud/${req.params.fileId}]`, err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});

/**
 * GET /api/plaud/:fileId/download-urls
 * Get pre-signed download URLs for audio.
 */
router.get('/:fileId/download-urls', async (req, res) => {
  try {
    const { fileId } = req.params;
    const { base_url } = req.query;
    const auth = req.headers.authorization;

    if (!auth || !base_url) {
      return res.status(400).json({ error: 'Missing authorization or base_url' });
    }

    const data = await plaudFetch(`${base_url}/file/temp-url/${fileId}?is_opus=1`, auth);
    const urls = [];
    const d = data.data || data;

    if (d.temp_url) urls.push({ label: 'WAV', url: d.temp_url });
    if (d.temp_url_opus) urls.push({ label: 'OPUS', url: d.temp_url_opus });
    if (d.temp_url_mp3) urls.push({ label: 'MP3', url: d.temp_url_mp3 });

    res.json({ urls });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

/**
 * POST /api/plaud/export-docx
 * Generate a .docx file from a BA document object.
 * Body: { baDocument: { title, executiveSummary, ... } }
 * Returns: .docx binary
 */
router.post('/export-docx', async (req, res) => {
  try {
    const { baDocument } = req.body;
    if (!baDocument) {
      return res.status(400).json({ error: 'Missing baDocument in request body' });
    }

    const buffer = await exportBADocx(baDocument);

    const filename = (baDocument.title || 'BA_Document').replace(/[^a-zA-Z0-9_\-\s]/g, '').substring(0, 80);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${filename}_BA.docx"`,
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  } catch (err) {
    console.error('[export-docx]', err.message);
    res.status(500).json({ error: `DOCX generation failed: ${err.message}` });
  }
});

module.exports = router;
