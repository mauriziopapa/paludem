/**
 * plaudResolver.js
 * Resolves content URLs from PLAUD file detail response.
 * Maps content_list entries to their semantic type.
 */

// Known data_type mappings from PLAUD API
const TYPE_MAP = {
  transcript: ['transaction', 'trans_result', 'transcript', 'transcription'],
  outline:    ['outline', 'ai_outline'],
  summary:    ['auto_sum_note', 'ai_summary', 'summary', 'auto_summary'],
  notes:      ['consumer_note', 'user_note', 'note', 'ai_note', 'mind_map'],
};

/**
 * Given the full file detail object from PLAUD API,
 * resolve all content URLs by type.
 *
 * @param {Object} fileDetail - The file detail response (data field)
 * @returns {Object} Resolved URLs
 */
function resolveContent(fileDetail) {
  const result = {
    transcriptUrl: null,
    outlineUrl: null,
    summaryUrl: null,
    notesUrls: [],
    raw: {},
  };

  // content_list is the primary source
  const contentList = fileDetail.content_list
    || fileDetail.contents
    || fileDetail.data_content_list
    || [];

  for (const item of contentList) {
    const dataType = (item.data_type || item.type || '').toLowerCase();
    const url = item.temp_url || item.url || item.signed_url || item.content_url;

    if (!url) continue;

    // Store raw mapping for debugging
    result.raw[dataType] = url;

    if (matchesType(dataType, TYPE_MAP.transcript)) {
      // Prefer trans_result.json.gz — check filename if available
      if (!result.transcriptUrl || isTransResult(item)) {
        result.transcriptUrl = url;
      }
    } else if (matchesType(dataType, TYPE_MAP.outline)) {
      result.outlineUrl = url;
    } else if (matchesType(dataType, TYPE_MAP.summary)) {
      result.summaryUrl = url;
    } else if (matchesType(dataType, TYPE_MAP.notes)) {
      result.notesUrls.push({ url, type: dataType, title: item.title || item.name || dataType });
    } else {
      // Unknown type — add to notes as fallback
      result.notesUrls.push({ url, type: dataType, title: item.title || item.name || dataType });
    }
  }

  // Fallback: check top-level fields
  if (!result.transcriptUrl && fileDetail.transcription_url) {
    result.transcriptUrl = fileDetail.transcription_url;
  }
  if (!result.summaryUrl && fileDetail.summary_url) {
    result.summaryUrl = fileDetail.summary_url;
  }

  return result;
}

function matchesType(dataType, patterns) {
  return patterns.some(p => dataType.includes(p));
}

function isTransResult(item) {
  const filename = (item.filename || item.name || '').toLowerCase();
  return filename.includes('trans_result');
}

module.exports = { resolveContent };
