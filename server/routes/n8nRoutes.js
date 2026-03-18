/**
 * n8nRoutes.js
 *
 * API endpoints for n8n AI pipeline integration.
 *
 * Endpoints:
 *   POST /api/n8n/trigger       — Trigger AI pipeline for a fileId
 *   POST /api/n8n/callback      — Receive async result from n8n workflow
 *   GET  /api/n8n/status/:jobId — Poll job status
 *   GET  /api/n8n/jobs          — List all jobs
 *   GET  /api/n8n/config        — Get n8n configuration status
 *   POST /api/n8n/config        — Set n8n webhook URL at runtime
 *
 * FLOW:
 *   1. Frontend calls POST /trigger with fileId
 *   2. Backend fetches pipeline data (or uses cache), chunks transcript
 *   3. Sends to n8n webhook with jobId + callbackUrl
 *   4. n8n processes: Claude (chunk extraction) → merge → GPT (BA generation)
 *   5. n8n calls POST /callback with jobId + result
 *   6. Frontend polls GET /status/:jobId until completed
 */
const express = require('express');
const router = express.Router();
const { getSession } = require('../services/sessionStore');
const { getCachedTranscript, cacheTranscript } = require('../services/sessionStore');
const { buildFullTranscript } = require('../services/plaudAggregator');
const { prepareForAI } = require('../services/chunkingService');
const {
  getJob,
  updateJob,
  listJobs,
  triggerAIPipeline,
  getWebhookUrl,
} = require('../services/n8nClient');

// ── No-cache middleware for all n8n routes ──
router.use((_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  next();
});

// ══════════════════════════════════════
//  TRIGGER AI PIPELINE
// ══════════════════════════════════════

/**
 * POST /api/n8n/trigger
 *
 * Body: { fileId, fileName? }
 *
 * Flow:
 *   1. Validate session exists
 *   2. Fetch transcript from PLAUD (or use cache)
 *   3. Chunk transcript
 *   4. Trigger n8n webhook
 *   5. Return job object for polling
 */
router.post('/trigger', async (req, res) => {
  try {
    const { fileId, fileName } = req.body;
    if (!fileId) {
      return res.status(400).json({ error: 'Missing fileId in request body' });
    }

    // ── Session check: use request headers as fallback ──
    let baseUrl, token;
    const session = getSession();
    if (session) {
      baseUrl = session.baseUrl;
      token = session.token;
    } else {
      // Fallback: use headers from frontend
      baseUrl = req.query.base_url || req.body.base_url;
      token = req.headers.authorization;
    }
    if (!baseUrl || !token) {
      return res.status(401).json({ error: 'No active session. Connect to PLAUD first.' });
    }

    // ── Check webhook config ──
    if (!getWebhookUrl() && !process.env.N8N_WEBHOOK_URL) {
      return res.status(503).json({
        error: 'n8n webhook URL not configured. Set N8N_WEBHOOK_URL environment variable.',
      });
    }

    console.log(`[n8n/trigger] Starting AI pipeline for ${fileId}`);

    // ── Get transcript (cache or fetch) ──
    let pipelineResult = getCachedTranscript(fileId);
    if (!pipelineResult) {
      console.log(`[n8n/trigger] Fetching transcript from PLAUD for ${fileId}`);
      const plaudResp = await fetch(`${baseUrl}/file/detail/${fileId}`, {
        headers: { 'Authorization': token, 'Accept': 'application/json' },
      });
      if (!plaudResp.ok) {
        const text = await plaudResp.text().catch(() => '');
        throw new Error(`PLAUD API ${plaudResp.status}: ${text.substring(0, 200)}`);
      }
      const detailData = await plaudResp.json();
      const fileDetail = detailData.data || detailData;

      pipelineResult = await buildFullTranscript(fileDetail, {
        removeFillers: false,
        mergeGap: 3,
      });

      // Cache for future use
      cacheTranscript(fileId, pipelineResult);
    } else {
      console.log(`[n8n/trigger] Using cached transcript for ${fileId}`);
    }

    // ── Validate transcript exists ──
    if (!pipelineResult?.transcript?.fullText) {
      return res.status(422).json({
        error: 'No transcript available for this recording. Cannot run AI pipeline.',
      });
    }

    // ── Chunk transcript ──
    const chunkedData = prepareForAI(pipelineResult);
    console.log(`[n8n/trigger] Chunked into ${chunkedData.chunks.length} pieces (${chunkedData.metadata.totalChars} chars)`);

    // ── Trigger n8n ──
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
    console.error('[n8n/trigger]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ══════════════════════════════════════
//  CALLBACK (from n8n workflow)
// ══════════════════════════════════════

/**
 * POST /api/n8n/callback
 *
 * Called by n8n workflow when AI processing is complete.
 *
 * Body: {
 *   jobId: string,
 *   status: 'completed' | 'failed',
 *   baDocument?: { executive_summary, requirements, risks, next_actions, ... },
 *   error?: string
 * }
 */
router.post('/callback', async (req, res) => {
  try {
    const { jobId, status, baDocument, error } = req.body;

    if (!jobId) {
      return res.status(400).json({ error: 'Missing jobId' });
    }

    const job = getJob(jobId);
    if (!job) {
      console.warn(`[n8n/callback] Unknown jobId: ${jobId}`);
      return res.status(404).json({ error: `Job not found: ${jobId}` });
    }

    if (status === 'completed' && baDocument) {
      // ── Normalize n8n output to match our BA document format ──
      const normalizedBA = normalizeN8nBA(baDocument, job);

      updateJob(jobId, {
        status: 'completed',
        completedAt: Date.now(),
        result: normalizedBA,
        chunksProcessed: job.chunksTotal,
      });
      console.log(`[n8n/callback] Job ${jobId} completed successfully`);
    } else if (status === 'failed') {
      updateJob(jobId, {
        status: 'failed',
        error: error || 'Unknown error from n8n workflow',
      });
      console.error(`[n8n/callback] Job ${jobId} failed: ${error}`);
    } else {
      // Partial update (e.g., progress)
      const updates = {};
      if (req.body.chunksProcessed != null) updates.chunksProcessed = req.body.chunksProcessed;
      if (req.body.status === 'processing') updates.status = 'processing';
      updateJob(jobId, updates);
    }

    res.json({ received: true, jobId });
  } catch (err) {
    console.error('[n8n/callback]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════
//  STATUS POLLING
// ══════════════════════════════════════

/**
 * GET /api/n8n/status/:jobId
 *
 * Returns current job status for frontend polling.
 */
router.get('/status/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired' });
  }
  res.json(job);
});

/**
 * GET /api/n8n/jobs
 *
 * List all active jobs (for dashboard).
 */
router.get('/jobs', (_req, res) => {
  res.json({ jobs: listJobs() });
});

// ══════════════════════════════════════
//  CONFIGURATION
// ══════════════════════════════════════

/**
 * GET /api/n8n/config
 *
 * Returns n8n integration status.
 */
router.get('/config', (_req, res) => {
  const webhookUrl = getWebhookUrl();
  res.json({
    configured: !!webhookUrl,
    webhookUrl: webhookUrl ? `${webhookUrl.substring(0, 30)}...` : null,
    hasApiKey: !!process.env.N8N_API_KEY,
    callbackUrl: process.env.CALLBACK_BASE_URL || null,
  });
});

/**
 * POST /api/n8n/config
 *
 * Set n8n webhook URL at runtime (alternative to env var).
 * Body: { webhookUrl }
 */
router.post('/config', (req, res) => {
  const { webhookUrl } = req.body;
  if (!webhookUrl) {
    return res.status(400).json({ error: 'Missing webhookUrl' });
  }

  // Validate URL format
  try {
    new URL(webhookUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  process.env.N8N_WEBHOOK_URL = webhookUrl;
  console.log(`[n8n/config] Webhook URL set: ${webhookUrl.substring(0, 50)}...`);
  res.json({ success: true, configured: true });
});

// ══════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════

/**
 * Normalize n8n AI output to match our BA document format.
 * Handles both snake_case (GPT output) and camelCase (our format).
 */
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
    if (typeof r === 'string') {
      return { id: `RF-${String(i + 1).padStart(3, '0')}`, text: r };
    }
    return {
      id: r.id || `RF-${String(i + 1).padStart(3, '0')}`,
      text: r.text || r.description || String(r),
    };
  });
}

function normalizeJobStories(stories) {
  if (!Array.isArray(stories)) return [];
  return stories.map(s => {
    if (typeof s === 'string') {
      return { user: 'utente', want: s, value: 'valore di business' };
    }
    return {
      user: s.user || s.persona || 'utente',
      want: s.want || s.feature || s.action || '',
      value: s.value || s.benefit || s.so_that || '',
    };
  });
}

function normalizeAnalysis(items) {
  if (!Array.isArray(items)) return [];
  return items.map(f => {
    if (typeof f === 'string') {
      return { title: f, level: 1, detail: '' };
    }
    return {
      title: f.title || f.name || String(f),
      level: f.level || 1,
      detail: f.detail || f.description || '',
    };
  });
}

module.exports = router;
