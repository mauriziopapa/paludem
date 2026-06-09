/**
 * plaudDownloader.js
 *
 * Download layer for signed URLs with:
 * - Retry with exponential backoff (max 3)
 * - Configurable timeout (30s default)
 * - Concurrency limiter (max 5 parallel)
 * - Gzip decompression with plain-text fallback
 * - Content hash for deduplication
 * - Per-download metrics
 *
 * DESIGN: This module is ONLY responsible for fetching and decompressing.
 * It does NOT parse or interpret content. Separation of concerns.
 */
const { promisify } = require('util');
const { createHash } = require('crypto');
const zlib = require('zlib');
const gunzip = promisify(zlib.gunzip);

const MAX_RETRIES = 3;
const TIMEOUT_MS = 30_000;
const RETRY_DELAYS = [1000, 2000, 4000];
const MAX_CONCURRENCY = 5;

// ══════════════════════════════════════
//  CONCURRENCY LIMITER
// ══════════════════════════════════════

/**
 * Simple semaphore-based concurrency limiter.
 * Ensures at most `limit` async operations run in parallel.
 */
function createLimiter(limit) {
  let running = 0;
  const queue = [];

  function next() {
    if (queue.length === 0 || running >= limit) return;
    running++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      running--;
      next();
    });
  }

  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

// Shared limiter instance
const limiter = createLimiter(MAX_CONCURRENCY);

// ══════════════════════════════════════
//  DOWNLOAD
// ══════════════════════════════════════

/**
 * Download a URL and return the raw Buffer.
 * Retries on transient failures with exponential backoff.
 *
 * @param {string} url - The signed URL to fetch
 * @param {number} retries - Max retry attempts
 * @returns {Promise<Buffer>}
 */
async function downloadFile(url, retries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }

      const arrayBuffer = await resp.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      lastError = err;
      if (attempt < retries - 1) {
        await sleep(RETRY_DELAYS[attempt] || 4000);
      }
    }
  }
  throw new Error(`Download failed after ${retries} attempts: ${lastError?.message}`);
}

// ══════════════════════════════════════
//  DECOMPRESSION
// ══════════════════════════════════════

/**
 * Decompress a gzip buffer to UTF-8 string.
 * Falls back to plain-text interpretation if not gzipped.
 *
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function decompressGzip(buffer) {
  // Check gzip magic bytes (1f 8b)
  const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;

  if (isGzip) {
    try {
      const decompressed = await gunzip(buffer);
      return decompressed.toString('utf-8');
    } catch {
      // Corrupted gzip — fall through to plain text
    }
  }

  // Plain text fallback
  const text = buffer.toString('utf-8');
  if (text.length > 0) {
    return text;
  }

  throw new Error('Failed to decompress: not valid gzip or text');
}

// ══════════════════════════════════════
//  DOWNLOAD + DECOMPRESS (combined)
// ══════════════════════════════════════

/**
 * Download a signed URL, decompress gzip, and return raw string.
 * Does NOT parse content — returns the raw text and metadata only.
 *
 * @param {string} url
 * @returns {Promise<{raw: string, hash: string, sizeBytes: number, downloadMs: number}>}
 */
async function downloadAndDecompress(url) {
  const start = Date.now();
  const buffer = await downloadFile(url);
  const text = await decompressGzip(buffer);
  const downloadMs = Date.now() - start;

  return {
    raw: text,
    hash: createHash('sha256').update(text).digest('hex').substring(0, 16),
    sizeBytes: buffer.length,
    decompressedBytes: Buffer.byteLength(text, 'utf-8'),
    downloadMs,
  };
}

/**
 * Concurrent download of multiple items through the limiter.
 * Each item must have a `url` property.
 * Returns results in the SAME order as input (preserves originalIndex).
 *
 * @param {Array<{url: string, ...}>} items - Items with URL to download
 * @param {Function} onProgress - Callback (index, total, status, error?)
 * @returns {Promise<Array<{success: boolean, raw?: string, hash?: string, error?: string, ...metrics}>>}
 */
async function downloadAll(items, onProgress) {
  const results = new Array(items.length);

  const promises = items.map((item, index) =>
    limiter(async () => {
      try {
        const result = await downloadAndDecompress(item.url);
        results[index] = { success: true, ...result };
        if (onProgress) onProgress(index, items.length, 'ok');
      } catch (err) {
        results[index] = {
          success: false,
          raw: null,
          hash: null,
          sizeBytes: 0,
          decompressedBytes: 0,
          downloadMs: 0,
          error: err.message,
        };
        if (onProgress) onProgress(index, items.length, 'error', err.message);
      }
    })
  );

  await Promise.all(promises);
  return results;
}

// ══════════════════════════════════════
//  LEGACY COMPAT (used by old code paths)
// ══════════════════════════════════════

/**
 * @deprecated Use downloadAndDecompress + format detection instead.
 */
async function downloadAndParse(url) {
  const { raw } = await downloadAndDecompress(url);
  try {
    return { type: 'json', data: JSON.parse(raw) };
  } catch {
    return { type: 'text', data: raw };
  }
}

// ══════════════════════════════════════
//  UTILS
// ══════════════════════════════════════

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  downloadFile,
  decompressGzip,
  downloadAndDecompress,
  downloadAll,
  downloadAndParse,
  createLimiter,
};
