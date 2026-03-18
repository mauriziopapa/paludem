/**
 * plaudContentEngine.js
 *
 * Content Reconstruction Engine — the core pipeline orchestrator.
 *
 * Pipeline:
 *   content_list
 *     → Parallel Download (concurrency-limited)
 *     → Decompression
 *     → Format Detection
 *     → Normalization (type mapping)
 *     → Grouping (transcript/summary/outline/notes/other)
 *     → Deduplication (content hash)
 *     → Deterministic Ordering (tab → title → originalIndex)
 *     → Reconstruction (parse ONLY after ordering)
 *     → Unified Output DTO
 *
 * DESIGN PRINCIPLES:
 *   - Downloader ≠ Parser ≠ Reconstructor
 *   - No parsing during fetch
 *   - No loss of original order
 *   - No overwrite of multiple contents
 *   - Fault-tolerant: skip corrupted, log errors, continue
 *   - Deterministic: same input → same output
 */
const { downloadAll } = require('./plaudDownloader');
const {
  normalizeItem,
  groupByCategory,
  sortAllGroups,
  deduplicateGroups,
} = require('./plaudNormalizer');
const { parseTranscript } = require('../parser/plaudTranscriptParser');
const { parseSummary } = require('../parser/plaudSummaryParser');
const { parseOutline } = require('../parser/plaudOutlineParser');

// ══════════════════════════════════════
//  MAIN ENTRY POINT
// ══════════════════════════════════════

/**
 * Reconstruct all PLAUD content from a content_list.
 *
 * @param {Array<{data_type: string, data_title?: string, data_tab_name?: string, data_link: string}>} contentList
 * @param {Object} [options]
 * @param {boolean} [options.removeFillers=false]
 * @param {number}  [options.mergeGap=3]
 * @param {boolean} [options.includeDebug=true]
 * @returns {Promise<PlaudReconstructedOutput>}
 */
async function reconstructPlaudContent(contentList, options = {}) {
  const { removeFillers = false, mergeGap = 3, includeDebug = true } = options;
  const pipelineStart = Date.now();
  const log = [];
  const addLog = (msg, level = 'info') => log.push({ ts: Date.now(), level, msg });

  // ── Validate input ──
  if (!Array.isArray(contentList) || contentList.length === 0) {
    addLog('Empty content_list — nothing to reconstruct', 'warn');
    return buildEmptyOutput(log, pipelineStart);
  }

  addLog(`Pipeline start: ${contentList.length} items in content_list`);

  // ══════════════════════════════════════
  //  STEP 1 — PARALLEL DOWNLOAD + DECOMPRESS
  // ══════════════════════════════════════

  addLog('Step 1: Downloading all contents (concurrency-limited)...');

  // Extract URLs while preserving original index
  const downloadItems = contentList.map((item, i) => ({
    url: item.data_link || item.temp_url || item.url || item.signed_url || item.content_url || '',
    index: i,
  }));

  // Filter out items without URLs
  const validItems = downloadItems.filter(item => item.url);
  const skippedCount = downloadItems.length - validItems.length;
  if (skippedCount > 0) {
    addLog(`Skipped ${skippedCount} items without data_link`, 'warn');
  }

  // Download all in parallel with concurrency limit
  const downloadResults = await downloadAll(
    validItems,
    (index, total, status, error) => {
      if (status === 'error') {
        addLog(`Download failed [${index}]: ${error}`, 'error');
      }
    }
  );

  const successCount = downloadResults.filter(r => r.success).length;
  const failCount = downloadResults.filter(r => !r.success).length;
  addLog(`Step 1 complete: ${successCount} downloaded, ${failCount} failed`, successCount > 0 ? 'ok' : 'error');

  // ══════════════════════════════════════
  //  STEP 2 — FORMAT DETECTION + NORMALIZATION
  // ══════════════════════════════════════

  addLog('Step 2: Normalizing contents...');

  const normalized = [];
  for (let i = 0; i < validItems.length; i++) {
    const dlResult = downloadResults[i];
    if (!dlResult.success) continue;

    const originalIndex = validItems[i].index;
    const originalItem = contentList[originalIndex];

    const item = normalizeItem(originalItem, originalIndex, dlResult);
    normalized.push(item);
  }

  addLog(`Step 2 complete: ${normalized.length} items normalized (formats: ${formatDistribution(normalized)})`, 'ok');

  // ══════════════════════════════════════
  //  STEP 3 — GROUPING
  // ══════════════════════════════════════

  addLog('Step 3: Grouping by category...');
  const grouped = groupByCategory(normalized);
  addLog(`Step 3 complete: transcript=${grouped.transcript.length}, summary=${grouped.summary.length}, outline=${grouped.outline.length}, notes=${grouped.notes.length}, other=${grouped.other.length}`, 'ok');

  // ══════════════════════════════════════
  //  STEP 4 — DEDUPLICATION
  // ══════════════════════════════════════

  addLog('Step 4: Deduplicating by content hash...');
  const deduped = deduplicateGroups(grouped);
  const dedupedTotal = countAll(deduped);
  const removedDupes = countAll(grouped) - dedupedTotal;
  if (removedDupes > 0) {
    addLog(`Removed ${removedDupes} duplicate(s)`, 'ok');
  }

  // ══════════════════════════════════════
  //  STEP 5 — DETERMINISTIC ORDERING
  // ══════════════════════════════════════

  addLog('Step 5: Sorting (tab_name → title → originalIndex)...');
  const sorted = sortAllGroups(deduped);
  addLog('Step 5 complete: deterministic order applied', 'ok');

  // ══════════════════════════════════════
  //  STEP 6 — RECONSTRUCTION (parse AFTER ordering)
  // ══════════════════════════════════════

  addLog('Step 6: Reconstructing contents...');

  // 6.1 TRANSCRIPT
  const transcript = reconstructTranscript(sorted.transcript, { removeFillers, mergeGap }, addLog);

  // 6.2 SUMMARY
  const summary = reconstructSummary(sorted.summary, addLog);

  // 6.3 OUTLINE
  const outline = reconstructOutline(sorted.outline, addLog);

  // 6.4 NOTES
  const notes = reconstructNotes(sorted.notes, addLog);

  addLog('Step 6 complete', 'ok');

  // ══════════════════════════════════════
  //  STEP 7 — BUILD OUTPUT DTO
  // ══════════════════════════════════════

  const pipelineMs = Date.now() - pipelineStart;
  addLog(`Pipeline complete in ${pipelineMs}ms`, 'ok');

  const meta = {
    totalContents: contentList.length,
    downloadedContents: successCount,
    failedContents: failCount,
    skippedNoUrl: skippedCount,
    processedContents: normalized.length,
    duplicatesRemoved: removedDupes,
    groups: {
      transcript: sorted.transcript.length,
      summary: sorted.summary.length,
      outline: sorted.outline.length,
      notes: sorted.notes.length,
      other: sorted.other.length,
    },
    pipelineMs,
  };

  const result = {
    transcript,
    summary,
    outline,
    notes,
    meta,
    log,
  };

  // Debug: include all normalized contents
  if (includeDebug) {
    result.debug = normalized.map(item => ({
      originalIndex: item.originalIndex,
      dataType: item.dataType,
      category: item.category,
      title: item.title,
      tab: item.tab,
      format: item.format,
      hash: item.hash,
      sizeBytes: item.sizeBytes,
      downloadMs: item.downloadMs,
      rawPreview: (item.raw || '').substring(0, 200),
    }));
  }

  return result;
}

// ══════════════════════════════════════
//  RECONSTRUCTION: TRANSCRIPT
// ══════════════════════════════════════

/**
 * Reconstruct transcript from one or more transcript content items.
 * Handles multiple transcript files by concatenating segments in order.
 */
function reconstructTranscript(items, options, addLog) {
  if (items.length === 0) {
    addLog('No transcript content found');
    return null;
  }

  addLog(`Reconstructing transcript from ${items.length} source(s)...`);

  // Collect all segments from all transcript sources
  const allResults = [];

  for (const item of items) {
    try {
      let data = item.raw;

      // Parse JSON if format detected
      if (item.format === 'json') {
        try {
          data = JSON.parse(item.raw);
        } catch {
          // Keep as string — parseTranscript handles strings too
        }
      }

      const parsed = parseTranscript(data, options);
      allResults.push(parsed);
      addLog(`Transcript source "${item.title}": ${parsed.stats.segmentsCount} segments, ${parsed.stats.wordsCount} words`, 'ok');
    } catch (err) {
      addLog(`Transcript parse failed for "${item.title}": ${err.message}`, 'error');
    }
  }

  if (allResults.length === 0) {
    addLog('All transcript sources failed to parse', 'error');
    return null;
  }

  // Single source — return directly
  if (allResults.length === 1) {
    return allResults[0];
  }

  // Multiple sources — merge segments in order, sort by timestamp
  const allSegments = [];
  const allSpeakers = new Set();

  for (const result of allResults) {
    allSegments.push(...result.segments);
    result.speakers.forEach(s => allSpeakers.add(s));
  }

  // Sort by start timestamp if available
  allSegments.sort((a, b) => (a.start || 0) - (b.start || 0));

  const speakers = [...allSpeakers];
  const fullText = allSegments.map(seg => {
    const time = formatTimestamp(seg.start);
    return `[${seg.speaker}] (${time})\n${seg.text}`;
  }).join('\n\n');

  // Recompute stats
  const wordsCount = allSegments.reduce((sum, seg) =>
    sum + (seg.text || '').split(/\s+/).filter(Boolean).length, 0);
  const duration = allSegments.length > 0
    ? (allSegments[allSegments.length - 1].end || 0) - (allSegments[0].start || 0)
    : 0;

  const speakerStats = {};
  for (const seg of allSegments) {
    if (!speakerStats[seg.speaker]) {
      speakerStats[seg.speaker] = { words: 0, segments: 0, duration: 0 };
    }
    const st = speakerStats[seg.speaker];
    st.words += (seg.text || '').split(/\s+/).filter(Boolean).length;
    st.segments += 1;
    st.duration += ((seg.end || 0) - (seg.start || 0));
  }

  return {
    segments: allSegments,
    speakers,
    fullText,
    stats: {
      duration: Math.round(duration),
      speakersCount: speakers.length,
      wordsCount,
      segmentsCount: allSegments.length,
      speakerStats,
    },
  };
}

// ══════════════════════════════════════
//  RECONSTRUCTION: SUMMARY
// ══════════════════════════════════════

/**
 * Reconstruct summary from one or more summary content items.
 * Multiple summaries are concatenated with separators, then parsed.
 */
function reconstructSummary(items, addLog) {
  if (items.length === 0) {
    addLog('No summary content found');
    return null;
  }

  addLog(`Reconstructing summary from ${items.length} source(s)...`);

  // Collect raw markdown from all sources
  const markdownParts = [];

  for (const item of items) {
    let text = item.raw || '';

    // If JSON, try to extract text fields
    if (item.format === 'json') {
      try {
        const data = JSON.parse(item.raw);
        text = extractTextFromJson(data);
      } catch {
        // Keep raw
      }
    }

    if (text.trim()) {
      markdownParts.push(text.trim());
    }
  }

  if (markdownParts.length === 0) {
    addLog('All summary sources empty', 'warn');
    return null;
  }

  // Concatenate multiple summaries with separator (preserving hierarchy)
  const combinedMarkdown = markdownParts.join('\n\n---\n\n');

  try {
    const result = parseSummary(combinedMarkdown);
    addLog(`Summary parsed: ${Object.values(result.sections).flat().length} items across sections`, 'ok');
    return result;
  } catch (err) {
    addLog(`Summary parse failed: ${err.message}`, 'error');
    return { raw: combinedMarkdown, sections: { keyPoints: [], actions: [], decisions: [], risks: [] } };
  }
}

// ══════════════════════════════════════
//  RECONSTRUCTION: OUTLINE
// ══════════════════════════════════════

/**
 * Reconstruct outline from one or more outline content items.
 * Multiple outlines are merged section arrays.
 */
function reconstructOutline(items, addLog) {
  if (items.length === 0) {
    addLog('No outline content found');
    return null;
  }

  addLog(`Reconstructing outline from ${items.length} source(s)...`);

  const allSections = [];

  for (const item of items) {
    try {
      let data = item.raw;
      if (item.format === 'json') {
        try { data = JSON.parse(item.raw); } catch { /* keep string */ }
      }

      const parsed = parseOutline(data);
      allSections.push(...(parsed.sections || []));
      addLog(`Outline source "${item.title}": ${parsed.sections.length} sections`, 'ok');
    } catch (err) {
      addLog(`Outline parse failed for "${item.title}": ${err.message}`, 'error');
    }
  }

  if (allSections.length === 0) {
    addLog('All outline sources failed', 'error');
    return null;
  }

  return { sections: allSections };
}

// ══════════════════════════════════════
//  RECONSTRUCTION: NOTES
// ══════════════════════════════════════

/**
 * Reconstruct notes from content items.
 * Each item becomes one note. Original order preserved. No merge.
 */
function reconstructNotes(items, addLog) {
  if (items.length === 0) {
    addLog('No notes content found');
    return [];
  }

  addLog(`Reconstructing ${items.length} note(s)...`);

  const notes = [];

  for (const item of items) {
    let content = item.raw || '';

    // If JSON, pretty-print or extract text
    if (item.format === 'json') {
      try {
        const data = JSON.parse(item.raw);
        const extracted = extractTextFromJson(data);
        content = extracted || JSON.stringify(data, null, 2);
      } catch {
        // Keep raw
      }
    }

    notes.push({
      title: item.title,
      type: item.dataType,
      tab: item.tab,
      content: content.trim(),
      originalIndex: item.originalIndex,
    });
  }

  addLog(`Notes reconstructed: ${notes.length}`, 'ok');
  return notes;
}

// ══════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════

/**
 * Try to extract readable text from a JSON object.
 * Handles common PLAUD structures.
 */
function extractTextFromJson(data) {
  if (typeof data === 'string') return data;

  // Common fields
  if (data.text) return data.text;
  if (data.content) return typeof data.content === 'string' ? data.content : JSON.stringify(data.content, null, 2);
  if (data.markdown) return data.markdown;
  if (data.summary) return typeof data.summary === 'string' ? data.summary : JSON.stringify(data.summary, null, 2);

  // Nested data wrapper
  if (data.data) return extractTextFromJson(data.data);

  return '';
}

function formatTimestamp(seconds) {
  if (seconds == null) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDistribution(items) {
  const counts = {};
  for (const item of items) {
    counts[item.format] = (counts[item.format] || 0) + 1;
  }
  return Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ');
}

function countAll(groups) {
  return Object.values(groups).reduce((sum, arr) => sum + arr.length, 0);
}

function buildEmptyOutput(log, pipelineStart) {
  return {
    transcript: null,
    summary: null,
    outline: null,
    notes: [],
    meta: {
      totalContents: 0,
      downloadedContents: 0,
      failedContents: 0,
      skippedNoUrl: 0,
      processedContents: 0,
      duplicatesRemoved: 0,
      groups: { transcript: 0, summary: 0, outline: 0, notes: 0, other: 0 },
      pipelineMs: Date.now() - pipelineStart,
    },
    log,
    debug: [],
  };
}

// ══════════════════════════════════════
//  EXPORTS
// ══════════════════════════════════════

module.exports = { reconstructPlaudContent };
