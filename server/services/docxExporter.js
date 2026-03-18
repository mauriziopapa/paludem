/**
 * docxExporter.js
 *
 * Generates a .docx file from a BA Document object using the `docx` npm package.
 * Returns a Buffer ready for HTTP response.
 */
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
} = require('docx');

/**
 * Generate a DOCX buffer from a BA document object.
 *
 * @param {Object} baDoc - The BA document (from generateBADocument)
 * @returns {Promise<Buffer>} DOCX file buffer
 */
async function exportBADocx(baDoc) {
  const children = [];

  // ── Title ──
  children.push(
    new Paragraph({
      text: baDoc.title || 'Business Analysis Document',
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `Generato: ${baDoc.generatedAt || new Date().toISOString()}`, italics: true, size: 20, color: '666666' }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
    })
  );

  // ── 1. Executive Summary ──
  addSection(children, 'Executive Summary', baDoc.executiveSummary);

  // ── 2. Business Context ──
  addSection(children, 'Business Context', baDoc.businessContext);

  // ── 3. Objectives ──
  addListSection(children, 'Objectives', baDoc.objectives);

  // ── 4. Requirements ──
  if (baDoc.requirements && baDoc.requirements.length > 0) {
    children.push(heading('Requirements (RF)'));
    children.push(buildRequirementsTable(baDoc.requirements));
    children.push(spacer());
  }

  // ── 5. Job Stories ──
  if (baDoc.jobStories && baDoc.jobStories.length > 0) {
    children.push(heading('Job Stories'));
    baDoc.jobStories.forEach((story, i) => {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `#${i + 1}  `, bold: true }),
            new TextRun({ text: 'As a ', bold: true }),
            new TextRun(story.user),
            new TextRun({ text: '  I want ', bold: true }),
            new TextRun(story.want),
            new TextRun({ text: '  So that ', bold: true }),
            new TextRun(story.value),
          ],
          spacing: { after: 120 },
        })
      );
    });
    children.push(spacer());
  }

  // ── 6. Functional Analysis ──
  if (baDoc.functionalAnalysis && baDoc.functionalAnalysis.length > 0) {
    children.push(heading('Functional Analysis'));
    baDoc.functionalAnalysis.forEach(f => {
      const indent = ((f.level || 1) - 1) * 360;
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: f.title, bold: true }),
            f.detail ? new TextRun({ text: ` — ${f.detail}` }) : new TextRun(''),
          ],
          indent: { left: indent },
          spacing: { after: 80 },
          bullet: { level: Math.min((f.level || 1) - 1, 3) },
        })
      );
    });
    children.push(spacer());
  }

  // ── 7. Data & Integration ──
  addListSection(children, 'Data & Integration Points', baDoc.dataIntegration);

  // ── 8. Risks & Issues ──
  addListSection(children, 'Risks & Issues', baDoc.risks);

  // ── 9. Open Points ──
  addListSection(children, 'Open Points', baDoc.openPoints);

  // ── 10. Next Actions ──
  addListSection(children, 'Next Actions', baDoc.nextActions);

  // ── 11. KPI & Monitoring ──
  addListSection(children, 'KPI & Monitoring', baDoc.kpiMonitoring);

  // Build document
  const doc = new Document({
    creator: 'PALUDEM — Meeting Intelligence Engine',
    title: baDoc.title || 'BA Document',
    description: 'Business Analysis Document generated from meeting transcript',
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

// ── Helpers ──

function heading(text) {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 300, after: 120 },
  });
}

function spacer() {
  return new Paragraph({ text: '', spacing: { after: 200 } });
}

function addSection(children, title, content) {
  if (!content) return;
  children.push(heading(title));
  // Split content by newlines for proper paragraphs
  const lines = content.split('\n').filter(l => l.trim());
  lines.forEach(line => {
    const isBullet = /^[-*•]\s/.test(line.trim());
    children.push(
      new Paragraph({
        children: [new TextRun(line.replace(/^[-*•]\s+/, ''))],
        bullet: isBullet ? { level: 0 } : undefined,
        spacing: { after: 60 },
      })
    );
  });
  children.push(spacer());
}

function addListSection(children, title, items) {
  if (!items || items.length === 0) return;
  children.push(heading(title));
  items.forEach(item => {
    children.push(
      new Paragraph({
        children: [new TextRun(item)],
        bullet: { level: 0 },
        spacing: { after: 60 },
      })
    );
  });
  children.push(spacer());
}

function buildRequirementsTable(requirements) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: 'ID', bold: true })] })],
        width: { size: 15, type: WidthType.PERCENTAGE },
        shading: { type: ShadingType.SOLID, color: 'E8E8E8' },
      }),
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: 'Requisito', bold: true })] })],
        width: { size: 85, type: WidthType.PERCENTAGE },
        shading: { type: ShadingType.SOLID, color: 'E8E8E8' },
      }),
    ],
  });

  const rows = requirements.map(r =>
    new TableRow({
      children: [
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: r.id, bold: true })] })],
        }),
        new TableCell({
          children: [new Paragraph(r.text)],
        }),
      ],
    })
  );

  return new Table({
    rows: [headerRow, ...rows],
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

module.exports = { exportBADocx };
