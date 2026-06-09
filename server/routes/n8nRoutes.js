const express = require('express');
const router = express.Router();
const plaudProvider = require('../services/plaud/provider');
const { getCachedTranscript, cacheTranscript } = require('../services/sessionStore');
const { buildFullTranscript } = require('../services/plaudAggregator');
const { parseTranscript } = require('../parser/plaudTranscriptParser');
const { prepareForAI } = require('../services/chunkingService');
const { AppError, Errors } = require('../utils/errors');
const { validateFileId } = require('../utils/execCommand');
const { createLogger } = require('../utils/logger');
const {
  getJob,
  updateJob,
  listJobs,
  triggerAIPipeline,
  getWebhookUrl,
} = require('../services/n8nClient');

const log = createLogger('n8n-routes');

router.use((_req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Expires': '0' });
  next();
});

function sendError(res, err) {
  if (err instanceof AppError) return res.status(err.status).json(err.toJSON());
  log.error(err.message);
  res.status(err.status || 500).json({ error: { code: 'INTERNAL_ERROR', message: err.message } });
}

/**
 * POST /api/n8n/trigger
 */
router.post('/trigger', async (req, res) => {
  try {
    const { fileId, fileName } = req.body;
    if (!fileId) throw Errors.MISSING_PARAM('Missing fileId in request body');
    if (!validateFileId(fileId)) throw Errors.INVALID_FILE_ID();

    if (!getWebhookUrl() && !process.env.N8N_WEBHOOK_URL) {
      throw Errors.N8N_NOT_CONFIGURED();
    }

    log.info(`Starting AI pipeline for ${fileId}`);

    let pipelineResult = getCachedTranscript(fileId);
    if (!pipelineResult) {
      log.info(`Fetching recording from PLAUD for ${fileId}`);
      const fullData = await plaudProvider.getFullRecording(fileId);
      const rawDetail = fullData.rawDetail;
      const contentList = rawDetail?.content_list || rawDetail?.contents || rawDetail?.data_content_list || [];

      if (contentList.length > 0) {
        pipelineResult = await buildFullTranscript(rawDetail, { removeFillers: false, mergeGap: 3 });
      } else {
        pipelineResult = buildResultFromProvider(fullData);
      }
      cacheTranscript(fileId, pipelineResult);
    } else {
      log.info(`Using cached transcript for ${fileId}`);
    }

    if (!pipelineResult?.transcript?.fullText) {
      throw Errors.NO_TRANSCRIPT('No transcript available. Cannot run AI pipeline.');
    }

    const chunkedData = prepareForAI(pipelineResult);
    log.info(`Chunked into ${chunkedData.chunks.length} pieces (${chunkedData.metadata.totalChars} chars)`);

    const job = await triggerAIPipeline(
      fileId,
      fileName || pipelineResult?.metadata?.filename || fileId,
      pipelineResult,
      chunkedData
    );

    res.json({
      success: true,
      job,
      message: job.status === 'completed'
        ? 'AI pipeline completed synchronously'
        : 'AI pipeline triggered. Poll /api/n8n/status/:jobId for results.',
    });
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * POST /api/n8n/callback
 */
router.post('/callback', async (req, res) => {
  try {
    const { jobId, status, baDocument, error } = req.body;
    if (!jobId) throw Errors.MISSING_PARAM('Missing jobId');

    const job = getJob(jobId);
    if (!job) {
      log.warn(`Unknown jobId: ${jobId}`);
      return res.status(404).json({ error: { code: 'JOB_NOT_FOUND', message: `Job not found: ${jobId}` } });
    }

    if (status === 'completed' && baDocument) {
      const normalizedBA = normalizeN8nBA(baDocument, job);
      updateJob(jobId, {
        status: 'completed',
        completedAt: Date.now(),
        result: normalizedBA,
        chunksProcessed: job.chunksTotal,
      });
      log.info(`Job ${jobId} completed`);
    } else if (status === 'failed') {
      updateJob(jobId, { status: 'failed', error: error || 'Unknown error from n8n workflow' });
      log.error(`Job ${jobId} failed: ${error}`);
    } else {
      const updates = {};
      if (req.body.chunksProcessed != null) updates.chunksProcessed = req.body.chunksProcessed;
      if (req.body.status === 'processing') updates.status = 'processing';
      updateJob(jobId, updates);
    }

    res.json({ received: true, jobId });
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/status/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: { code: 'JOB_NOT_FOUND', message: 'Job not found or expired' } });
  res.json(job);
});

router.get('/jobs', (_req, res) => {
  res.json({ jobs: listJobs() });
});

router.get('/config', (_req, res) => {
  const webhookUrl = getWebhookUrl();
  res.json({
    configured: !!webhookUrl,
    webhookUrl: webhookUrl ? `${webhookUrl.substring(0, 30)}...` : null,
    hasApiKey: !!process.env.N8N_API_KEY,
    callbackUrl: process.env.CALLBACK_BASE_URL || null,
  });
});

router.post('/config', (req, res) => {
  const { webhookUrl } = req.body;
  if (!webhookUrl) throw Errors.MISSING_PARAM('Missing webhookUrl');

  try {
    new URL(webhookUrl);
  } catch {
    return res.status(400).json({ error: { code: 'INVALID_URL', message: 'Invalid URL format' } });
  }

  process.env.N8N_WEBHOOK_URL = webhookUrl;
  log.info(`Webhook URL updated`);
  res.json({ success: true, configured: true });
});

function buildResultFromProvider(fullData) {
  const { recording, transcriptRaw, noteRaw } = fullData;
  let transcript = null;

  if (transcriptRaw) {
    try { transcript = parseTranscript(transcriptRaw, { removeFillers: false, mergeGap: 3 }); } catch { /* skip */ }
  }

  return {
    transcript,
    summary: null,
    outline: null,
    notes: [],
    metadata: {
      fileId: recording?.id,
      filename: recording?.name,
      duration: recording?.duration,
      hasTranscript: !!transcript,
    },
    meta: { pipelineMs: 0 },
    log: [],
  };
}

function normalizeN8nBA(raw, job) {
  return {
    title: raw.title || job.fileName || 'AI-Generated BA Document',
    generatedAt: new Date().toISOString(),
    source: 'n8n-ai-pipeline',
    executiveSummary: raw.executive_summary || raw.executiveSummary || '',
    businessContext: raw.business_context || raw.businessContext || '',
    objectives: ensureArray(raw.objectives),
    requirements: normalizeRequirements(raw.requirements),
    jobStories: normalizeJobStories(raw.job_stories || raw.jobStories),
    functionalAnalysis: normalizeAnalysis(raw.functional_analysis || raw.functionalAnalysis),
    dataIntegration: ensureArray(raw.data_integration || raw.dataIntegration),
    risks: ensureArray(raw.risks),
    openPoints: ensureArray(raw.open_points || raw.openPoints),
    nextActions: ensureArray(raw.next_actions || raw.nextActions),
    kpiMonitoring: ensureArray(raw.kpi_monitoring || raw.kpiMonitoring),
  };
}

function ensureArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === 'string') return val.split('\n').filter(Boolean);
  return [];
}

function normalizeRequirements(reqs) {
  if (!Array.isArray(reqs)) return [];
  return reqs.map((r, i) => {
    if (typeof r === 'string') return { id: `RF-${String(i + 1).padStart(3, '0')}`, text: r };
    return { id: r.id || `RF-${String(i + 1).padStart(3, '0')}`, text: r.text || r.description || String(r) };
  });
}

function normalizeJobStories(stories) {
  if (!Array.isArray(stories)) return [];
  return stories.map(s => {
    if (typeof s === 'string') return { user: 'utente', want: s, value: 'valore di business' };
    return { user: s.user || s.persona || 'utente', want: s.want || s.feature || s.action || '', value: s.value || s.benefit || s.so_that || '' };
  });
}

function normalizeAnalysis(items) {
  if (!Array.isArray(items)) return [];
  return items.map(f => {
    if (typeof f === 'string') return { title: f, level: 1, detail: '' };
    return { title: f.title || f.name || String(f), level: f.level || 1, detail: f.detail || f.description || '' };
  });
}

module.exports = router;
