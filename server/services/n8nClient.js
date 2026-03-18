/**
 * n8nClient.js
 *
 * Client for triggering n8n workflows via webhook.
 * Manages:
 *   - Webhook URL configuration (env var or runtime)
 *   - Job tracking (pending, processing, completed, failed)
 *   - Retry logic with exponential backoff
 *   - Timeout handling
 *
 * ARCHITECTURE:
 *   Frontend → Backend /api/n8n/trigger → n8nClient → n8n Webhook
 *   n8n Workflow → Backend /api/n8n/callback → job result stored
 *   Frontend polls /api/n8n/status/:jobId
 *
 * ENV VARS:
 *   N8N_WEBHOOK_URL — The n8n webhook trigger URL
 *   N8N_API_KEY     — Optional API key for webhook auth
 */

const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 4000, 8000];
const WEBHOOK_TIMEOUT_MS = 30_000;
const JOB_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// ══════════════════════════════════════
//  JOB STORE
// ══════════════════════════════════════

/**
 * In-memory job store.
 * Each job tracks the lifecycle of an n8n workflow execution.
 *
 * States: pending → processing → completed | failed
 */
const jobs = new Map();

function generateJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

function createJob(fileId, fileName) {
  const jobId = generateJobId();
  const job = {
    jobId,
    fileId,
    fileName: fileName || fileId,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    triggeredAt: null,
    completedAt: null,
    result: null,
    error: null,
    chunksTotal: 0,
    chunksProcessed: 0,
  };
  jobs.set(jobId, job);
  cleanupOldJobs();
  return job;
}

function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (Date.now() - job.createdAt > JOB_TTL_MS) {
    jobs.delete(jobId);
    return null;
  }
  return job;
}

function updateJob(jobId, updates) {
  const job = jobs.get(jobId);
  if (!job) return null;
  Object.assign(job, updates, { updatedAt: Date.now() });
  return job;
}

function listJobs() {
  cleanupOldJobs();
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}

// ══════════════════════════════════════
//  WEBHOOK TRIGGER
// ══════════════════════════════════════

/**
 * Get the n8n webhook URL from environment or config.
 */
function getWebhookUrl() {
  return process.env.N8N_WEBHOOK_URL || null;
}

/**
 * Trigger an n8n webhook with transcript data.
 * Retries on transient failures.
 *
 * @param {string} jobId - Job ID for tracking
 * @param {Object} payload - Data to send to n8n
 * @param {string} payload.fileId - PLAUD file ID
 * @param {string} payload.fileName - Recording filename
 * @param {string} payload.fullText - Full transcript text
 * @param {Array}  payload.chunks - Chunked transcript
 * @param {Object} payload.metadata - Pipeline metadata
 * @param {Object} payload.summary - Parsed summary sections
 * @returns {Promise<Object>} n8n response
 */
async function triggerWebhook(jobId, payload) {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) {
    throw new Error('N8N_WEBHOOK_URL not configured. Set it in environment variables.');
  }

  const apiKey = process.env.N8N_API_KEY || '';
  const callbackUrl = process.env.CALLBACK_BASE_URL
    ? `${process.env.CALLBACK_BASE_URL}/api/n8n/callback`
    : null;

  const body = {
    jobId,
    callbackUrl,
    ...payload,
  };

  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

      const headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      };
      if (apiKey) {
        headers['X-N8N-API-Key'] = apiKey;
      }

      console.log(`[n8n] Trigger attempt ${attempt + 1}/${MAX_RETRIES} → ${webhookUrl}`);

      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`n8n webhook HTTP ${resp.status}: ${text.substring(0, 300)}`);
      }

      const result = await resp.json().catch(() => ({ ok: true }));
      console.log(`[n8n] Trigger success for job ${jobId}`);
      return result;
    } catch (err) {
      lastError = err;
      console.error(`[n8n] Trigger attempt ${attempt + 1} failed:`, err.message);
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_DELAYS[attempt] || 4000);
      }
    }
  }

  throw new Error(`n8n webhook failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

/**
 * Full trigger flow: create job → trigger webhook → update job status.
 *
 * @param {string} fileId
 * @param {string} fileName
 * @param {Object} pipelineResult - Full Content Reconstruction Engine result
 * @param {Object} chunkedData - From chunkingService.prepareForAI()
 * @returns {Promise<Object>} Job object
 */
async function triggerAIPipeline(fileId, fileName, pipelineResult, chunkedData) {
  const job = createJob(fileId, fileName);

  updateJob(job.jobId, {
    status: 'processing',
    triggeredAt: Date.now(),
    chunksTotal: chunkedData.chunks.length,
  });

  try {
    const webhookPayload = {
      fileId,
      fileName: fileName || fileId,
      fullText: chunkedData.fullText,
      chunks: chunkedData.chunks,
      metadata: chunkedData.metadata,
      summary: pipelineResult?.summary?.sections || null,
      outline: pipelineResult?.outline?.sections || null,
    };

    const n8nResponse = await triggerWebhook(job.jobId, webhookPayload);

    // If n8n returns the result synchronously (webhook response node)
    if (n8nResponse && n8nResponse.baDocument) {
      updateJob(job.jobId, {
        status: 'completed',
        completedAt: Date.now(),
        result: n8nResponse.baDocument,
        chunksProcessed: chunkedData.chunks.length,
      });
    }
    // Otherwise, wait for callback

    return getJob(job.jobId);
  } catch (err) {
    updateJob(job.jobId, {
      status: 'failed',
      error: err.message,
    });
    return getJob(job.jobId);
  }
}

// ══════════════════════════════════════
//  UTILS
// ══════════════════════════════════════

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  createJob,
  getJob,
  updateJob,
  listJobs,
  triggerWebhook,
  triggerAIPipeline,
  getWebhookUrl,
};
