/**
 * sessionStore.js
 *
 * In-memory session storage for PLAUD API credentials.
 * Stores base_url + token per session to avoid repeated /connect calls.
 *
 * DESIGN:
 *   - Single-user in-memory store (suitable for Railway single-instance)
 *   - Auto-expiry after 4 hours of inactivity
 *   - Thread-safe (single Node.js event loop)
 *   - Transcript cache: fileId → pipeline result (avoids re-fetching)
 *
 * For multi-user: swap with Redis or a Map keyed by session ID.
 */

const config = require('../config');
const SESSION_TTL_MS = config.session.ttlMs;

// ── Primary session ──
let session = {
  baseUrl: null,
  token: null,
  connectedAt: null,
  lastUsedAt: null,
};

// ── Transcript cache: fileId → { data, cachedAt } ──
const transcriptCache = new Map();
const CACHE_TTL_MS = config.session.cacheTtlMs;

// ══════════════════════════════════════
//  SESSION MANAGEMENT
// ══════════════════════════════════════

/**
 * Save PLAUD session credentials.
 * Called after successful /connect.
 */
function saveSession(baseUrl, token) {
  session = {
    baseUrl,
    token,
    connectedAt: Date.now(),
    lastUsedAt: Date.now(),
  };
}

/**
 * Get current session. Returns null if expired or not set.
 */
function getSession() {
  if (!session.baseUrl || !session.token) return null;

  // Check TTL
  if (Date.now() - session.lastUsedAt > SESSION_TTL_MS) {
    clearSession();
    return null;
  }

  session.lastUsedAt = Date.now();
  return { baseUrl: session.baseUrl, token: session.token };
}

/**
 * Check if a valid session exists.
 */
function hasSession() {
  return getSession() !== null;
}

/**
 * Clear session and cache.
 */
function clearSession() {
  session = { baseUrl: null, token: null, connectedAt: null, lastUsedAt: null };
  transcriptCache.clear();
}

/**
 * Get session info for status endpoint.
 */
function getSessionInfo() {
  const s = getSession();
  if (!s) return { active: false };
  return {
    active: true,
    baseUrl: s.baseUrl,
    connectedAt: new Date(session.connectedAt).toISOString(),
    cacheSize: transcriptCache.size,
  };
}

// ══════════════════════════════════════
//  TRANSCRIPT CACHE
// ══════════════════════════════════════

/**
 * Cache a transcript pipeline result by fileId.
 */
function cacheTranscript(fileId, data) {
  transcriptCache.set(fileId, { data, cachedAt: Date.now() });
}

/**
 * Get cached transcript. Returns null if expired or missing.
 */
function getCachedTranscript(fileId) {
  const entry = transcriptCache.get(fileId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    transcriptCache.delete(fileId);
    return null;
  }
  return entry.data;
}

/**
 * Invalidate a specific cache entry.
 */
function invalidateCache(fileId) {
  transcriptCache.delete(fileId);
}

module.exports = {
  saveSession,
  getSession,
  hasSession,
  clearSession,
  getSessionInfo,
  cacheTranscript,
  getCachedTranscript,
  invalidateCache,
};
