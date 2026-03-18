/**
 * plaudNormalizer.js
 *
 * Pure-function module: no I/O, no side effects.
 * Responsible for:
 * 1. Format detection (JSON / markdown / text)
 * 2. Canonical type mapping (data_type → semantic category)
 * 3. Grouping by category
 * 4. Deterministic stable ordering
 *
 * DESIGN: operates on already-downloaded raw strings.
 * Input:  RawContent[]  (from downloader)
 * Output: GroupedContents (ready for reconstruction)
 */

// ══════════════════════════════════════
//  CANONICAL TYPE MAP
// ══════════════════════════════════════

/**
 * Maps PLAUD data_type values to semantic categories.
 * Order matters: first match wins.
 */
const TYPE_RULES = [
  { category: 'transcript', patterns: ['transaction', 'trans_result', 'transcript', 'transcription'] },
  { category: 'outline',    patterns: ['outline', 'ai_outline'] },
  { category: 'summary',    patterns: ['auto_sum_note', 'ai_summary', 'summary', 'auto_summary'] },
  { category: 'notes',      patterns: ['consumer_note', 'user_note', 'note', 'ai_note', 'mind_map'] },
];

/**
 * Map a PLAUD data_type string to a canonical category.
 *
 * @param {string} dataType - Raw data_type from content_list
 * @returns {'transcript'|'outline'|'summary'|'notes'|'other'}
 */
function resolveCategory(dataType) {
  if (!dataType) return 'other';
  const lower = dataType.toLowerCase().trim();

  for (const rule of TYPE_RULES) {
    if (rule.patterns.some(p => lower.includes(p))) {
      return rule.category;
    }
  }

  return 'other';
}

// ══════════════════════════════════════
//  FORMAT DETECTION
// ══════════════════════════════════════

/**
 * Detect the format of a raw content string.
 * Rules:
 *  1. Valid JSON → 'json'
 *  2. Contains markdown indicators (headings, lists) → 'markdown'
 *  3. Default → 'text'
 *
 * @param {string} raw - The raw decompressed content
 * @returns {'json'|'markdown'|'text'}
 */
function detectFormat(raw) {
  if (!raw || typeof raw !== 'string') return 'text';

  const trimmed = raw.trim();

  // JSON: starts with { or [
  if ((trimmed[0] === '{' || trimmed[0] === '[')) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Malformed JSON — continue to markdown check
    }
  }

  // Markdown indicators: headings, bullet lists, bold, links
  if (/^#{1,6}\s/m.test(trimmed) ||
      /^[-*]\s/m.test(trimmed) ||
      /^\d+\.\s/m.test(trimmed) ||
      /\*\*.+\*\*/m.test(trimmed) ||
      /\[.+\]\(.+\)/m.test(trimmed)) {
    return 'markdown';
  }

  return 'text';
}

// ══════════════════════════════════════
//  NORMALIZE
// ══════════════════════════════════════

/**
 * @typedef {Object} ContentListItem
 * @property {string} data_type
 * @property {string} [data_title]
 * @property {string} [data_tab_name]
 * @property {string} data_link
 */

/**
 * @typedef {Object} NormalizedContent
 * @property {number}  originalIndex
 * @property {string}  dataType       - Original data_type
 * @property {'transcript'|'outline'|'summary'|'notes'|'other'} category
 * @property {string}  title
 * @property {string}  tab
 * @property {'json'|'markdown'|'text'} format
 * @property {string}  raw            - Decompressed content string
 * @property {string}  hash           - Content hash for dedup
 * @property {number}  sizeBytes
 * @property {number}  downloadMs
 */

/**
 * Normalize a single downloaded content item.
 * Combines the original content_list metadata with download results.
 *
 * @param {ContentListItem} item - Original content_list entry
 * @param {number} originalIndex - Position in the original array
 * @param {{raw: string, hash: string, sizeBytes: number, downloadMs: number}} downloaded
 * @returns {NormalizedContent}
 */
function normalizeItem(item, originalIndex, downloaded) {
  const dataType = (item.data_type || item.type || '').trim();
  const raw = downloaded.raw || '';

  return {
    originalIndex,
    dataType,
    category: resolveCategory(dataType),
    title: item.data_title || item.title || item.name || dataType || `Content ${originalIndex}`,
    tab: item.data_tab_name || item.tab_name || '',
    format: detectFormat(raw),
    raw,
    hash: downloaded.hash || '',
    sizeBytes: downloaded.sizeBytes || 0,
    decompressedBytes: downloaded.decompressedBytes || 0,
    downloadMs: downloaded.downloadMs || 0,
  };
}

// ══════════════════════════════════════
//  GROUPING
// ══════════════════════════════════════

/**
 * @typedef {Object} GroupedContents
 * @property {NormalizedContent[]} transcript
 * @property {NormalizedContent[]} summary
 * @property {NormalizedContent[]} outline
 * @property {NormalizedContent[]} notes
 * @property {NormalizedContent[]} other
 */

/**
 * Group normalized contents by category.
 * Does NOT mutate the input array.
 *
 * @param {NormalizedContent[]} items
 * @returns {GroupedContents}
 */
function groupByCategory(items) {
  const groups = {
    transcript: [],
    summary: [],
    outline: [],
    notes: [],
    other: [],
  };

  for (const item of items) {
    const cat = item.category;
    if (groups[cat]) {
      groups[cat].push(item);
    } else {
      groups.other.push(item);
    }
  }

  return groups;
}

// ══════════════════════════════════════
//  DETERMINISTIC ORDERING
// ══════════════════════════════════════

/**
 * Stable sort comparator for NormalizedContent.
 *
 * Priority:
 *  1. data_tab_name (if both present) → localeCompare
 *  2. title (if both present) → localeCompare
 *  3. originalIndex (always present) → numeric
 *
 * This ensures:
 *  - Items with tab names sort by tab first
 *  - Items without tab names retain relative order
 *  - originalIndex is the absolute fallback → deterministic & stable
 *
 * @param {NormalizedContent} a
 * @param {NormalizedContent} b
 * @returns {number}
 */
function contentComparator(a, b) {
  // Priority 1: tab name (only when BOTH have a non-empty tab)
  if (a.tab && b.tab) {
    const tabCmp = a.tab.localeCompare(b.tab, undefined, { numeric: true });
    if (tabCmp !== 0) return tabCmp;
  }

  // Priority 2: title (only when BOTH have a non-empty title)
  if (a.title && b.title) {
    const titleCmp = a.title.localeCompare(b.title, undefined, { numeric: true });
    if (titleCmp !== 0) return titleCmp;
  }

  // Priority 3: original array index (always deterministic)
  return a.originalIndex - b.originalIndex;
}

/**
 * Sort an array of NormalizedContent using stable, deterministic ordering.
 * Returns a NEW array (does not mutate input).
 *
 * @param {NormalizedContent[]} items
 * @returns {NormalizedContent[]}
 */
function sortDeterministic(items) {
  // Array.prototype.sort is stable in Node >= 12 (TimSort)
  return [...items].sort(contentComparator);
}

/**
 * Sort all groups in a GroupedContents object.
 * Returns a NEW object with sorted arrays.
 *
 * @param {GroupedContents} groups
 * @returns {GroupedContents}
 */
function sortAllGroups(groups) {
  return {
    transcript: sortDeterministic(groups.transcript),
    summary: sortDeterministic(groups.summary),
    outline: sortDeterministic(groups.outline),
    notes: sortDeterministic(groups.notes),
    other: sortDeterministic(groups.other),
  };
}

// ══════════════════════════════════════
//  DEDUPLICATION
// ══════════════════════════════════════

/**
 * Remove duplicate contents within each group based on content hash.
 * Keeps the first occurrence (lowest originalIndex).
 *
 * @param {GroupedContents} groups
 * @returns {GroupedContents}
 */
function deduplicateGroups(groups) {
  const dedup = (items) => {
    const seen = new Set();
    return items.filter(item => {
      if (!item.hash || item.hash === '') return true; // Keep items without hash
      if (seen.has(item.hash)) return false;
      seen.add(item.hash);
      return true;
    });
  };

  return {
    transcript: dedup(groups.transcript),
    summary: dedup(groups.summary),
    outline: dedup(groups.outline),
    notes: dedup(groups.notes),
    other: dedup(groups.other),
  };
}

// ══════════════════════════════════════
//  EXPORTS
// ══════════════════════════════════════

module.exports = {
  resolveCategory,
  detectFormat,
  normalizeItem,
  groupByCategory,
  contentComparator,
  sortDeterministic,
  sortAllGroups,
  deduplicateGroups,
};
