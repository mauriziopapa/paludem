/**
 * plaudOutlineParser.js
 * Parse outline data from PLAUD (outline.json.gz).
 * Produces hierarchical section list with titles, levels, timestamps.
 */

/**
 * @param {Object|string} rawData - Outline JSON or markdown
 * @returns {Object} Parsed outline
 */
function parseOutline(rawData) {
  if (!rawData) {
    return { sections: [] };
  }

  // If string, try JSON parse first
  if (typeof rawData === 'string') {
    try {
      rawData = JSON.parse(rawData);
    } catch {
      // It's markdown — parse headings
      return { sections: parseMarkdownOutline(rawData) };
    }
  }

  // JSON structures
  let sections = [];

  // Structure A: { outline: [...] }
  if (Array.isArray(rawData.outline)) {
    sections = extractSections(rawData.outline);
  }
  // Structure B: { sections: [...] }
  else if (Array.isArray(rawData.sections)) {
    sections = extractSections(rawData.sections);
  }
  // Structure C: { data: { outline: [...] } }
  else if (rawData.data) {
    if (Array.isArray(rawData.data.outline)) {
      sections = extractSections(rawData.data.outline);
    } else if (Array.isArray(rawData.data.sections)) {
      sections = extractSections(rawData.data.sections);
    } else if (Array.isArray(rawData.data)) {
      sections = extractSections(rawData.data);
    }
  }
  // Structure D: direct array
  else if (Array.isArray(rawData)) {
    sections = extractSections(rawData);
  }
  // Structure E: { chapters: [...] }
  else if (Array.isArray(rawData.chapters)) {
    sections = extractSections(rawData.chapters);
  }

  return { sections };
}

/**
 * Extract sections from an array of outline items.
 * Handles nested children recursively.
 */
function extractSections(items, level = 1) {
  const sections = [];

  for (const item of items) {
    const section = {
      title: item.title || item.heading || item.text || item.name || item.content || 'Untitled',
      level: item.level || item.depth || level,
      timestamp: normalizeTimestamp(item.start ?? item.start_time ?? item.timestamp ?? item.time ?? null),
      summary: item.summary || item.description || item.detail || null,
    };

    sections.push(section);

    // Recurse into children
    const children = item.children || item.sub_sections || item.items || item.subsections;
    if (Array.isArray(children) && children.length > 0) {
      sections.push(...extractSections(children, (section.level || level) + 1));
    }
  }

  return sections;
}

/**
 * Parse outline from markdown headings.
 */
function parseMarkdownOutline(text) {
  const sections = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      const level = match[1].length;
      let title = match[2].trim();

      // Extract inline timestamp like [00:05:30]
      let timestamp = null;
      const timeMatch = title.match(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/);
      if (timeMatch) {
        timestamp = parseTimeString(timeMatch[1]);
        title = title.replace(timeMatch[0], '').trim();
      }

      sections.push({ title, level, timestamp, summary: null });
    }
  }

  return sections;
}

function normalizeTimestamp(v) {
  if (v == null) return null;
  const n = Number(v);
  if (isNaN(n)) return null;
  return n > 10000 ? n / 1000 : n;
}

function parseTimeString(str) {
  const parts = str.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

module.exports = { parseOutline };
