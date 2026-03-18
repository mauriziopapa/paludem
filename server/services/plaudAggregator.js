/**
 * plaudAggregator.js
 *
 * Top-level orchestrator for the PLAUD pipeline.
 * Delegates content reconstruction to plaudContentEngine.
 *
 * Flow:
 *   fileDetail (from PLAUD API)
 *     → extract content_list
 *     → ContentEngine.reconstructPlaudContent(content_list)
 *     → enrich with file metadata
 *     → return unified DTO
 */
const { reconstructPlaudContent } = require('./plaudContentEngine');

/**
 * Build the complete enriched transcript from a PLAUD file detail.
 *
 * @param {Object} fileDetail - The raw file detail data from PLAUD API
 * @param {Object} options
 * @param {boolean} [options.removeFillers=false]
 * @param {number}  [options.mergeGap=3]
 * @returns {Promise<Object>}
 */
async function buildFullTranscript(fileDetail, options = {}) {
  // ── Extract content_list with fallbacks ──
  const contentList = fileDetail.content_list
    || fileDetail.contents
    || fileDetail.data_content_list
    || [];

  // ── Run Content Reconstruction Engine ──
  const result = await reconstructPlaudContent(contentList, {
    removeFillers: options.removeFillers || false,
    mergeGap: options.mergeGap || 3,
    includeDebug: true,
  });

  // ── Enrich with file-level metadata ──
  result.metadata = {
    fileId: fileDetail.file_id || fileDetail.id,
    filename: fileDetail.filename || fileDetail.name || fileDetail.title,
    duration: fileDetail.duration,
    createdAt: fileDetail.start_time
      ? new Date(fileDetail.start_time * 1000).toISOString()
      : fileDetail.created_at,
    filesize: fileDetail.filesize,
    hasTranscript: !!result.transcript,
    hasSummary: !!result.summary,
    hasOutline: !!result.outline,
    notesCount: (result.notes || []).length,
    contentListSize: contentList.length,
    pipeline: result.meta,
  };

  return result;
}

module.exports = { buildFullTranscript };
