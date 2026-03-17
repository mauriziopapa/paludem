/**
 * plaudSummaryParser.js
 * Parse markdown summary from PLAUD (ai_content.md.gz).
 * Extracts structured sections: keyPoints, actions, decisions, risks.
 */

/**
 * @param {string} markdown - Raw markdown text
 * @returns {Object} Parsed summary
 */
function parseSummary(markdown) {
  if (!markdown || typeof markdown !== 'string') {
    return { raw: '', sections: { keyPoints: [], actions: [], decisions: [], risks: [] } };
  }

  const raw = markdown.trim();
  const sections = {
    keyPoints: [],
    actions: [],
    decisions: [],
    risks: [],
  };

  // Strategy 1: Parse by markdown headings
  const headingBlocks = splitByHeadings(raw);

  for (const block of headingBlocks) {
    const heading = block.heading.toLowerCase();
    const items = extractListItems(block.content);

    if (matchesSection(heading, ['key point', 'punto chiave', 'punti chiave', 'highlights', 'main point', 'punti principali', 'overview', 'riepilogo', 'summary', 'sommario'])) {
      sections.keyPoints.push(...items);
    } else if (matchesSection(heading, ['action', 'azione', 'azioni', 'todo', 'to-do', 'task', 'next step', 'prossimi passi', 'follow-up', 'follow up'])) {
      sections.actions.push(...items);
    } else if (matchesSection(heading, ['decision', 'decisione', 'decisioni', 'agreed', 'accordo', 'conclusion', 'conclusione', 'conclusioni'])) {
      sections.decisions.push(...items);
    } else if (matchesSection(heading, ['risk', 'rischio', 'rischi', 'issue', 'problema', 'problemi', 'concern', 'warning', 'blocker', 'impediment', 'criticità'])) {
      sections.risks.push(...items);
    } else {
      // Unknown section — add to keyPoints as fallback
      if (items.length > 0) {
        sections.keyPoints.push(...items);
      }
    }
  }

  // Strategy 2: If no sections found, try regex patterns
  if (allEmpty(sections)) {
    extractByPatterns(raw, sections);
  }

  // Strategy 3: If still empty, treat entire content as key points
  if (allEmpty(sections)) {
    const items = extractListItems(raw);
    if (items.length > 0) {
      sections.keyPoints = items;
    } else {
      // Split by paragraphs
      sections.keyPoints = raw
        .split(/\n\n+/)
        .map(p => p.trim())
        .filter(p => p.length > 0);
    }
  }

  return { raw, sections };
}

/**
 * Split markdown into heading-delimited blocks.
 */
function splitByHeadings(text) {
  const blocks = [];
  const lines = text.split('\n');
  let currentHeading = '';
  let currentContent = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,4}\s+(.+)/);
    if (headingMatch) {
      if (currentHeading || currentContent.length > 0) {
        blocks.push({ heading: currentHeading, content: currentContent.join('\n') });
      }
      currentHeading = headingMatch[1].trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  // Last block
  if (currentHeading || currentContent.length > 0) {
    blocks.push({ heading: currentHeading, content: currentContent.join('\n') });
  }

  return blocks;
}

/**
 * Extract bullet/numbered list items from text.
 */
function extractListItems(text) {
  const items = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Match: - item, * item, 1. item, 1) item
    const listMatch = trimmed.match(/^(?:[-*•]|\d+[.)]\s*)\s*(.+)/);
    if (listMatch) {
      const item = listMatch[1].trim();
      if (item.length > 0) {
        items.push(item);
      }
    }
  }

  return items;
}

function matchesSection(heading, keywords) {
  const h = heading.toLowerCase().replace(/[^a-zà-ú0-9\s-]/gi, '');
  return keywords.some(kw => h.includes(kw));
}

function allEmpty(sections) {
  return Object.values(sections).every(arr => arr.length === 0);
}

/**
 * Fallback: extract by known regex patterns in the text.
 */
function extractByPatterns(text, sections) {
  // Look for action-like patterns
  const actionPatterns = /(?:TODO|ACTION|AZIONE|DA FARE)[:\s]+(.+)/gi;
  let match;
  while ((match = actionPatterns.exec(text)) !== null) {
    sections.actions.push(match[1].trim());
  }

  // Look for decision-like patterns
  const decisionPatterns = /(?:DECISION|DECISIONE|AGREED|ACCORDO)[:\s]+(.+)/gi;
  while ((match = decisionPatterns.exec(text)) !== null) {
    sections.decisions.push(match[1].trim());
  }

  // Look for risk-like patterns
  const riskPatterns = /(?:RISK|RISCHIO|WARNING|ATTENZIONE|BLOCKER)[:\s]+(.+)/gi;
  while ((match = riskPatterns.exec(text)) !== null) {
    sections.risks.push(match[1].trim());
  }
}

module.exports = { parseSummary };
