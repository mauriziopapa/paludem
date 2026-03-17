/**
 * plaudDownloader.js
 * Download signed URLs, decompress gzip, with retry and timeout.
 */
const { promisify } = require('util');
const zlib = require('zlib');
const gunzip = promisify(zlib.gunzip);

const MAX_RETRIES = 3;
const TIMEOUT_MS = 30_000;
const RETRY_DELAYS = [1000, 2000, 4000];

/**
 * Download a URL and return the raw Buffer.
 * Retries on transient failures.
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

/**
 * Decompress a gzip buffer to UTF-8 string.
 * If decompression fails, tries to interpret as plain text.
 */
async function decompressGzip(buffer) {
  try {
    const decompressed = await gunzip(buffer);
    return decompressed.toString('utf-8');
  } catch {
    // Possibly not gzipped — try as plain text
    const text = buffer.toString('utf-8');
    if (text.length > 0 && (text[0] === '{' || text[0] === '[' || text[0] === '#')) {
      return text;
    }
    throw new Error('Failed to decompress: not valid gzip or text');
  }
}

/**
 * Download + decompress in one call. Returns parsed JSON or raw string.
 */
async function downloadAndParse(url) {
  const buffer = await downloadFile(url);
  const text = await decompressGzip(buffer);

  // Try JSON parse
  try {
    return { type: 'json', data: JSON.parse(text) };
  } catch {
    return { type: 'text', data: text };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { downloadFile, decompressGzip, downloadAndParse };
