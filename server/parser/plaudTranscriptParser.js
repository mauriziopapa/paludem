/**
 * plaudTranscriptParser.js
 * 7-step pipeline: detect → normalize speakers → build timeline →
 * merge adjacent → clean text → build fullText → compute metadata
 */

// Filler words to optionally remove (Italian + English)
const FILLERS = /\b(eh|ehm|uhm|uh|mmm|mm|hmm|mhm|ah|oh|beh|cioè|tipo|insomma|praticamente|basically|like|you know|um|erm)\b/gi;

/**
 * Main entry point. Takes raw JSON from trans_result.json.gz
 * @param {Object|string} rawJson
 * @param {Object} options
 * @param {boolean} options.removeFillers - Remove filler words (default false)
 * @param {number}  options.mergeGap - Max gap in seconds to merge segments (default 3)
 * @returns {Object} Parsed transcript
 */
function parseTranscript(rawJson, options = {}) {
  const { removeFillers = false, mergeGap = 3 } = options;

  // If string, try parse
  if (typeof rawJson === 'string') {
    try { rawJson = JSON.parse(rawJson); } catch { /* keep as string */ }
  }

  // STEP 1 — Detect structure & extract raw segments
  let rawSegments = detectAndExtract(rawJson);

  // STEP 2 — Normalize speakers
  rawSegments = normalizeSpeakers(rawSegments);

  // STEP 3 — Build timeline
  rawSegments = buildTimeline(rawSegments);

  // STEP 4 — Merge adjacent same-speaker segments
  let segments = mergeAdjacent(rawSegments, mergeGap);

  // STEP 5 — Clean text
  segments = segments.map(seg => ({
    ...seg,
    text: cleanText(seg.text, removeFillers),
  })).filter(seg => seg.text.length > 0);

  // STEP 6 — Build fullText
  const speakers = [...new Set(segments.map(s => s.speaker))];
  const fullText = buildFullText(segments);

  // STEP 7 — Compute metadata
  const stats = computeStats(segments, speakers);

  return { segments, speakers, fullText, stats };
}

// ─── STEP 1: Detect structure ───

function detectAndExtract(data) {
  if (typeof data === 'string') {
    return [{ speaker: 'Unknown', text: data, start: 0, end: 0 }];
  }

  // Try known PLAUD structures
  // Structure A: { segments: [...] }
  if (Array.isArray(data.segments)) {
    return extractFromArray(data.segments);
  }

  // Structure B: { utterances: [...] }
  if (Array.isArray(data.utterances)) {
    return extractFromArray(data.utterances);
  }

  // Structure C: { paragraphs: [...] } or { paragraphs: { paragraphs: [...] } }
  if (data.paragraphs) {
    const paras = Array.isArray(data.paragraphs)
      ? data.paragraphs
      : (data.paragraphs.paragraphs || []);
    return extractFromArray(paras);
  }

  // Structure D: { sentences: [...] }
  if (Array.isArray(data.sentences)) {
    return extractFromArray(data.sentences);
  }

  // Structure E: { results: [...] } (some ASR formats)
  if (Array.isArray(data.results)) {
    return extractFromArray(data.results);
  }

  // Structure F: { text: "..." } flat
  if (data.text && typeof data.text === 'string') {
    return [{ speaker: 'Unknown', text: data.text, start: 0, end: 0 }];
  }

  // Structure G: { trans_result: { ... } } wrapper
  if (data.trans_result) {
    return detectAndExtract(data.trans_result);
  }

  // Structure H: { data: { ... } } wrapper
  if (data.data && typeof data.data === 'object') {
    return detectAndExtract(data.data);
  }

  // Structure I: direct array
  if (Array.isArray(data)) {
    return extractFromArray(data);
  }

  // Last resort: stringify
  return [{ speaker: 'Unknown', text: JSON.stringify(data), start: 0, end: 0 }];
}

function extractFromArray(arr) {
  return arr.map(item => {
    // Handle nested sentences within paragraphs
    if (item.sentences && Array.isArray(item.sentences)) {
      const text = item.sentences.map(s => s.text || s.content || '').join(' ');
      return {
        speaker: extractSpeaker(item),
        text,
        start: extractTime(item, 'start'),
        end: extractTime(item, 'end'),
      };
    }

    // Handle words array
    if (item.words && Array.isArray(item.words) && !item.text) {
      const text = item.words.map(w => w.word || w.text || '').join(' ');
      return {
        speaker: extractSpeaker(item),
        text,
        start: extractTime(item, 'start'),
        end: extractTime(item, 'end'),
      };
    }

    return {
      speaker: extractSpeaker(item),
      text: item.text || item.content || item.transcript || item.value || '',
      start: extractTime(item, 'start'),
      end: extractTime(item, 'end'),
    };
  });
}

function extractSpeaker(item) {
  return item.speaker
    || item.speaker_id
    || item.speaker_label
    || item.spk
    || item.channel
    || null;
}

function extractTime(item, which) {
  if (which === 'start') {
    const v = item.start ?? item.start_time ?? item.startTime ?? item.from ?? item.begin ?? null;
    return normalizeTimestamp(v);
  }
  const v = item.end ?? item.end_time ?? item.endTime ?? item.to ?? null;
  return normalizeTimestamp(v);
}

function normalizeTimestamp(v) {
  if (v == null) return null;
  const n = Number(v);
  if (isNaN(n)) return null;
  // If > 10000, assume milliseconds
  return n > 10000 ? n / 1000 : n;
}

// ─── STEP 2: Normalize speakers ───

function normalizeSpeakers(segments) {
  const speakerMap = new Map();
  let counter = 0;

  return segments.map(seg => {
    let speaker = seg.speaker;
    if (!speaker || speaker === '' || speaker === 'null' || speaker === 'undefined') {
      speaker = 'Unknown';
    }

    // Normalize to Sn format
    const key = String(speaker).trim().toLowerCase();
    if (!speakerMap.has(key)) {
      counter++;
      // Keep original if it's already a readable name
      const isReadable = /^(speaker|s|spk)/i.test(key) || /^\d+$/.test(key) || key === 'unknown';
      speakerMap.set(key, isReadable ? `S${counter}` : String(speaker).trim());
    }

    return { ...seg, speaker: speakerMap.get(key) };
  });
}

// ─── STEP 3: Build timeline ───

function buildTimeline(segments) {
  let lastEnd = 0;
  return segments.map((seg, i) => {
    let start = seg.start;
    let end = seg.end;

    if (start == null) {
      start = lastEnd;
    }
    if (end == null) {
      // Estimate from text length (~150 words/min)
      const words = (seg.text || '').split(/\s+/).length;
      const estimatedDuration = (words / 150) * 60;
      end = start + Math.max(estimatedDuration, 1);
    }

    lastEnd = end;
    return { ...seg, start, end };
  });
}

// ─── STEP 4: Merge adjacent ───

function mergeAdjacent(segments, maxGap) {
  if (segments.length === 0) return [];

  const merged = [{ ...segments[0] }];

  for (let i = 1; i < segments.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = segments[i];

    if (curr.speaker === prev.speaker && (curr.start - prev.end) < maxGap) {
      prev.text = prev.text + ' ' + curr.text;
      prev.end = curr.end;
    } else {
      merged.push({ ...curr });
    }
  }

  return merged;
}

// ─── STEP 5: Clean text ───

function cleanText(text, removeFillers) {
  if (!text) return '';

  // Trim
  text = text.trim();

  // Remove filler words if requested
  if (removeFillers) {
    text = text.replace(FILLERS, '');
  }

  // Remove duplicate consecutive words
  text = text.replace(/\b(\w+)\s+\1\b/gi, '$1');

  // Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();

  // Normalize punctuation: remove double periods, spaces before punctuation
  text = text.replace(/\s+([.,;:!?])/g, '$1');
  text = text.replace(/\.{2,}/g, '.');
  text = text.replace(/,{2,}/g, ',');

  return text;
}

// ─── STEP 6: Build fullText ───

function buildFullText(segments) {
  return segments.map(seg => {
    const time = formatTimestamp(seg.start);
    return `[${seg.speaker}] (${time})\n${seg.text}`;
  }).join('\n\n');
}

function formatTimestamp(seconds) {
  if (!seconds && seconds !== 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const h = Math.floor(m / 60);
  if (h > 0) {
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─── STEP 7: Compute stats ───

function computeStats(segments, speakers) {
  const wordsCount = segments.reduce((sum, seg) => {
    return sum + (seg.text || '').split(/\s+/).filter(Boolean).length;
  }, 0);

  const duration = segments.length > 0
    ? segments[segments.length - 1].end - segments[0].start
    : 0;

  // Per-speaker stats
  const speakerStats = {};
  for (const seg of segments) {
    if (!speakerStats[seg.speaker]) {
      speakerStats[seg.speaker] = { words: 0, segments: 0, duration: 0 };
    }
    const st = speakerStats[seg.speaker];
    st.words += (seg.text || '').split(/\s+/).filter(Boolean).length;
    st.segments += 1;
    st.duration += (seg.end - seg.start);
  }

  return {
    duration: Math.round(duration),
    speakersCount: speakers.length,
    wordsCount,
    segmentsCount: segments.length,
    speakerStats,
  };
}

module.exports = { parseTranscript };
