/**
 * chunkingService.js
 *
 * Splits large transcripts into chunks for AI processing.
 * Preserves sentence boundaries to avoid cutting mid-sentence.
 *
 * DESIGN:
 *   - Default chunk size: 5000 chars
 *   - Splits at sentence boundaries (. ! ? newline)
 *   - Overlap: 200 chars to preserve context across chunks
 *   - Never produces empty chunks
 *   - Returns chunk metadata (index, total, charRange)
 */

const DEFAULT_CHUNK_SIZE = 5000;
const OVERLAP_CHARS = 200;

/**
 * Split text into chunks at sentence boundaries.
 *
 * @param {string} text - Full transcript text
 * @param {number} [maxChunkSize=5000] - Max chars per chunk
 * @returns {Array<{index: number, total: number, text: string, startChar: number, endChar: number}>}
 */
function chunkTranscript(text, maxChunkSize = DEFAULT_CHUNK_SIZE) {
  if (!text || typeof text !== 'string') return [];
  text = text.trim();
  if (text.length === 0) return [];

  // Small text → single chunk
  if (text.length <= maxChunkSize) {
    return [{
      index: 0,
      total: 1,
      text,
      startChar: 0,
      endChar: text.length,
    }];
  }

  const chunks = [];
  let position = 0;

  while (position < text.length) {
    let end = Math.min(position + maxChunkSize, text.length);

    // If not at the very end, find a sentence boundary to split at
    if (end < text.length) {
      const searchStart = Math.max(end - 500, position); // Look back up to 500 chars
      const segment = text.substring(searchStart, end);

      // Find last sentence-ending punctuation followed by space or newline
      const sentenceEnd = findLastSentenceBoundary(segment);
      if (sentenceEnd !== -1) {
        end = searchStart + sentenceEnd + 1; // +1 to include the punctuation
      }
    }

    const chunkText = text.substring(position, end).trim();
    if (chunkText.length > 0) {
      chunks.push({
        index: chunks.length,
        total: 0, // Will be set after loop
        text: chunkText,
        startChar: position,
        endChar: end,
      });
    }

    // Advance position with overlap
    position = Math.max(end - OVERLAP_CHARS, position + 1);
    if (position >= text.length) break;
  }

  // Set total count
  chunks.forEach(c => { c.total = chunks.length; });

  return chunks;
}

/**
 * Find the last sentence boundary in a string.
 * Returns the index of the boundary character, or -1 if not found.
 */
function findLastSentenceBoundary(text) {
  // Match: period/exclamation/question followed by space, newline, or end
  let lastIdx = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if ((ch === '.' || ch === '!' || ch === '?' || ch === '\n') &&
        (i === text.length - 1 || /\s/.test(text[i + 1]))) {
      lastIdx = i;
      break;
    }
  }
  return lastIdx;
}

/**
 * Prepare transcript data for n8n webhook.
 * Extracts fullText and chunks it.
 *
 * @param {Object} pipelineResult - Result from Content Reconstruction Engine
 * @param {number} [maxChunkSize=5000]
 * @returns {{fullText: string, chunks: Array, metadata: Object}}
 */
function prepareForAI(pipelineResult, maxChunkSize = DEFAULT_CHUNK_SIZE) {
  const transcript = pipelineResult?.transcript;
  const fullText = transcript?.fullText || '';
  const chunks = chunkTranscript(fullText, maxChunkSize);

  return {
    fullText,
    chunks,
    metadata: {
      totalChars: fullText.length,
      totalChunks: chunks.length,
      chunkSize: maxChunkSize,
      hasTranscript: !!transcript,
      segmentsCount: transcript?.stats?.segmentsCount || 0,
      wordsCount: transcript?.stats?.wordsCount || 0,
      speakersCount: transcript?.stats?.speakersCount || 0,
    },
  };
}

module.exports = { chunkTranscript, prepareForAI };
