/* ══════════════════════════════════════════════
   PALUDEM — Frontend Application
   Meeting Intelligence Engine
   ══════════════════════════════════════════════ */

const state = {
  connected: false,
  recordings: [],
  total: 0,
  skip: 0,
  limit: 20,
  currentData: null,
  activeTab: 'transcript',
  searchQuery: '',
  speakerFilter: '',
  baDocument: null,
  n8nConfigured: false,
  n8nJob: null,
  n8nPolling: null,
  sort: { field: 'date', direction: 'desc' },
};

const SPEAKER_COLORS = ['speaker-1', 'speaker-2', 'speaker-3', 'speaker-4', 'speaker-5', 'speaker-6'];
function speakerColorClass(speaker, speakers) {
  const idx = (speakers || []).indexOf(speaker);
  return SPEAKER_COLORS[idx % SPEAKER_COLORS.length];
}

// ══════════════════════════════════════
//  INIT
// ══════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('contentModal').addEventListener('click', e => {
    if (e.target.id === 'contentModal') closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });

  checkPlaudStatus();
  checkN8nConfig();
});

// ══════════════════════════════════════
//  LOGGING
// ══════════════════════════════════════

function log(msg, type = '') {
  const el = document.getElementById('log');
  const time = new Date().toLocaleTimeString();
  const cls = type === 'ok' ? 'log-ok' : type === 'err' ? 'log-err' : '';
  el.innerHTML = `<div class="log-entry ${cls}">[${time}] ${msg}</div>` + el.innerHTML;
}

// ══════════════════════════════════════
//  API CALL
// ══════════════════════════════════════

async function apiCall(endpoint, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  log(`${options.method || 'GET'} ${endpoint}`);

  const url = endpoint.startsWith('/api/') ? endpoint : `/api/plaud${endpoint}`;

  try {
    const resp = await fetch(url, { ...options, headers });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const msg = data?.error?.message || data?.error || `HTTP ${resp.status}`;
      throw new Error(msg);
    }
    const data = await resp.json();
    log('OK', 'ok');
    return data;
  } catch (err) {
    log(`Errore: ${err.message}`, 'err');
    throw err;
  }
}

// ══════════════════════════════════════
//  PLAUD STATUS
// ══════════════════════════════════════

async function checkPlaudStatus() {
  const el = document.getElementById('plaudStatus');
  el.innerHTML = '<span class="loader"></span> Checking...';

  try {
    const data = await apiCall('/status');
    state.connected = data.connected;

    if (data.connected) {
      let info = `<span class="status status-ok">Connesso</span>`;
      if (data.cliMode) info += ` <span class="status status-info">${esc(data.cliMode)}</span>`;
      if (data.cliVersion) info += ` <span class="status status-info">v${esc(data.cliVersion)}</span>`;
      if (data.user) info += ` <span style="color:var(--text-muted);font-size:0.82rem">${esc(data.user)}</span>`;
      el.innerHTML = info;
      log(`PLAUD connesso (${data.cliMode || data.mode})`, 'ok');
    } else if (data.status === 'cli_not_found') {
      el.innerHTML = `<span class="status status-err">CLI non trovata</span>
        <div class="plaud-status-hint">
          Installa la CLI PLAUD: <code>npm i -g @plaud-ai/cli@latest</code><br>
          Oppure imposta <code>PLAUD_CLI_MODE=npx</code> nelle variabili d'ambiente.
        </div>`;
      log('PLAUD CLI non trovata', 'err');
    } else if (data.status === 'not_authenticated') {
      el.innerHTML = `<span class="status status-warn">CLI trovata, non autenticata</span>
        ${data.cliVersion ? `<span class="status status-info">v${esc(data.cliVersion)}</span>` : ''}
        <div class="plaud-status-hint">
          Esegui <code>plaud login</code> nel terminale per autenticarti.
        </div>`;
      log('PLAUD CLI trovata ma non autenticata', 'err');
    } else {
      el.innerHTML = `<span class="status status-err">Non connesso</span>
        <span style="color:var(--text-muted);font-size:0.82rem;margin-left:8px">${esc(data.reason || '')}</span>`;
      log(`PLAUD non connesso: ${data.reason || ''}`, 'err');
    }
  } catch (err) {
    el.innerHTML = `<span class="status status-err">Errore</span>
      <span style="color:var(--text-muted);font-size:0.82rem;margin-left:8px">${esc(err.message)}</span>`;
  }
}

// ══════════════════════════════════════
//  LOAD RECORDINGS
// ══════════════════════════════════════

async function loadRecordings(refresh = false) {
  if (refresh) state.skip = 0;

  const statusEl = document.getElementById('listStatus');
  statusEl.innerHTML = '<span class="loader"></span>';

  try {
    const data = await apiCall(`/files?skip=${state.skip}&limit=${state.limit}`);
    state.recordings = data.recordings || [];
    state.total = data.total || 0;
    renderRecordings();
    statusEl.innerHTML = `<span class="status status-ok">${state.total} totali</span>`;
  } catch {
    statusEl.innerHTML = '<span class="status status-err">Errore caricamento</span>';
  }
}

// ══════════════════════════════════════
//  RENDER RECORDINGS TABLE
// ══════════════════════════════════════

function renderRecordings() {
  const container = document.getElementById('recordingsTable');
  if (!state.recordings || state.recordings.length === 0) {
    container.innerHTML = '<div class="empty">Nessuna registrazione trovata</div>';
    document.getElementById('pagination').classList.add('hidden');
    return;
  }

  const sorted = sortRecordings([...state.recordings]);
  const sortIcon = state.sort.direction === 'asc' ? '&#9650;' : '&#9660;';

  let html = `<table><thead><tr>
    <th>Nome</th><th>Durata</th><th class="sortable-header" onclick="toggleSort()">Data ${sortIcon}</th><th>Dimensione</th><th>Azioni</th>
  </tr></thead><tbody>`;

  for (const rec of sorted) {
    const id = rec.id;
    const name = rec.name || 'Senza nome';
    const duration = formatDuration(rec.duration);
    const date = formatDate(rec.createdAt);
    const size = rec.filesize ? formatSize(rec.filesize) : '-';

    html += `<tr>
      <td class="filename" onclick="openContent('${esc(id)}', '${esc(name)}')">${esc(name)}</td>
      <td>${duration}</td>
      <td>${date}</td>
      <td>${size}</td>
      <td><div class="btn-row">
        <button class="btn btn-sm btn-primary" onclick="openContent('${esc(id)}', '${esc(name)}')">Apri</button>
      </div></td>
    </tr>`;
  }

  html += '</tbody></table>';
  container.innerHTML = html;

  const pag = document.getElementById('pagination');
  pag.classList.remove('hidden');
  document.getElementById('pageInfo').textContent =
    `${state.skip + 1}–${Math.min(state.skip + state.limit, state.total)} di ${state.total}`;
  document.getElementById('btnPrev').disabled = state.skip === 0;
  document.getElementById('btnNext').disabled = state.skip + state.limit >= state.total;
}

function prevPage() { state.skip = Math.max(0, state.skip - state.limit); loadRecordings(); }
function nextPage() { state.skip += state.limit; loadRecordings(); }

// ══════════════════════════════════════
//  OPEN CONTENT — Full pipeline
// ══════════════════════════════════════

async function openContent(fileId, fileName) {
  const modal = document.getElementById('contentModal');
  modal.classList.add('open');

  document.getElementById('modalTitle').textContent = fileName;
  state.currentData = null;
  state.baDocument = null;
  state.n8nJob = null;
  stopN8nPolling();
  state.activeTab = 'transcript';
  state.searchQuery = '';
  state.speakerFilter = '';

  document.getElementById('modalBodyContent').innerHTML =
    '<div class="loading-state"><div class="loader loader-lg"></div><div>Pipeline in corso...</div></div>';

  updateModalTabs(null);

  try {
    const data = await apiCall(`/files/${fileId}/full`);
    state.currentData = data;
    log(`Pipeline completa per: ${fileName}`, 'ok');
    updateModalTabs(data);
    renderActiveTab();
  } catch (err) {
    document.getElementById('modalBodyContent').innerHTML =
      `<div class="loading-state" style="color:var(--error)">Errore pipeline: ${esc(err.message)}</div>`;
  }
}

// ══════════════════════════════════════
//  MODAL TABS
// ══════════════════════════════════════

function updateModalTabs(data) {
  const tabs = document.getElementById('modalTabs');
  const meta = data?.meta || data?.metadata?.pipeline;
  const items = [
    { id: 'transcript', label: 'Trascrizione', badge: data?.transcript ? data.transcript.stats.segmentsCount : null },
    { id: 'summary', label: 'Sommario', badge: data?.summary ? 'AI' : null },
    { id: 'outline', label: 'Outline', badge: data?.outline?.sections?.length || null },
    { id: 'notes', label: 'Note', badge: data?.notes?.length || null },
    { id: 'ba', label: 'BA Document', badge: state.baDocument ? 'OK' : null },
    { id: 'pipeline', label: 'Pipeline', badge: meta ? `${meta.pipelineMs}ms` : null },
    { id: 'raw', label: 'Raw', badge: null },
  ];

  tabs.innerHTML = items.map(t => {
    const active = t.id === state.activeTab ? 'active' : '';
    const badge = t.badge != null ? `<span class="badge">${t.badge}</span>` : '';
    return `<button class="modal-tab ${active}" onclick="switchModalTab('${t.id}')">${t.label}${badge}</button>`;
  }).join('');
}

function switchModalTab(tabId) {
  state.activeTab = tabId;
  updateModalTabs(state.currentData);
  renderActiveTab();
}

// ══════════════════════════════════════
//  MODAL TOOLBAR
// ══════════════════════════════════════

function renderToolbar() {
  const toolbar = document.getElementById('modalToolbar');

  if (state.activeTab === 'transcript' && state.currentData?.transcript) {
    const speakers = state.currentData.transcript.speakers || [];
    const speakerOptions = speakers.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');

    toolbar.classList.remove('hidden');
    toolbar.innerHTML = `
      <input type="text" placeholder="Cerca nel testo..." value="${esc(state.searchQuery)}"
             oninput="onSearchInput(this.value)" id="searchInput">
      <select onchange="onSpeakerFilter(this.value)">
        <option value="">Tutti gli speaker</option>
        ${speakerOptions}
      </select>
    `;
  } else {
    toolbar.classList.add('hidden');
    toolbar.innerHTML = '';
  }
}

function onSearchInput(value) {
  state.searchQuery = value;
  renderActiveTab();
}

function onSpeakerFilter(value) {
  state.speakerFilter = value;
  renderActiveTab();
}

// ══════════════════════════════════════
//  RENDER ACTIVE TAB
// ══════════════════════════════════════

function renderActiveTab() {
  renderToolbar();
  updateFooter();

  const container = document.getElementById('modalBodyContent');
  const data = state.currentData;

  if (!data) {
    container.innerHTML = '<div class="empty">Nessun dato disponibile</div>';
    return;
  }

  switch (state.activeTab) {
    case 'transcript': renderTranscript(container, data); break;
    case 'summary':    renderSummary(container, data); break;
    case 'outline':    renderOutline(container, data); break;
    case 'notes':      renderNotes(container, data); break;
    case 'ba':         renderBATab(container, data); break;
    case 'pipeline':   renderPipeline(container, data); break;
    case 'raw':        renderRaw(container, data); break;
  }
}

// ══════════════════════════════════════
//  RENDER: Transcript
// ══════════════════════════════════════

function renderTranscript(container, data) {
  if (!data.transcript || !data.transcript.segments.length) {
    const raw = data.rawDetail;
    let fallbackText = '';
    if (raw) {
      fallbackText = raw.transcription_text || raw.transcription || '';
      if (typeof fallbackText === 'object') fallbackText = JSON.stringify(fallbackText, null, 2);
    }
    container.innerHTML = fallbackText
      ? `<div class="modal-body-inner"><div class="summary-raw">${esc(fallbackText)}</div></div>`
      : '<div class="empty">Nessuna trascrizione disponibile</div>';
    return;
  }

  const { segments, speakers, stats } = data.transcript;
  let filtered = segments;

  if (state.speakerFilter) {
    filtered = filtered.filter(s => s.speaker === state.speakerFilter);
  }

  let html = '<div class="modal-body-inner">';
  html += `<div style="margin-bottom:14px;display:flex;gap:12px;flex-wrap:wrap">
    <span class="status status-info">${stats.speakersCount} speaker</span>
    <span class="status status-info">${stats.wordsCount} parole</span>
    <span class="status status-info">${stats.segmentsCount} segmenti</span>
    <span class="status status-info">${formatDuration(stats.duration)}</span>
  </div>`;

  for (const seg of filtered) {
    const colorClass = speakerColorClass(seg.speaker, speakers);
    const borderClass = colorClass + '-border';
    let text = esc(seg.text);

    if (state.searchQuery) {
      const regex = new RegExp(`(${escRegex(state.searchQuery)})`, 'gi');
      text = text.replace(regex, '<mark>$1</mark>');
    }

    html += `<div class="transcript-segment ${borderClass}">
      <div class="segment-header">
        <span class="segment-speaker ${colorClass}">${esc(seg.speaker)}</span>
        <span class="segment-time">${formatTimestamp(seg.start)} – ${formatTimestamp(seg.end)}</span>
      </div>
      <div class="segment-text">${text}</div>
    </div>`;
  }

  if (stats.speakerStats && Object.keys(stats.speakerStats).length > 1) {
    html += '<div style="margin-top:20px"><h4 style="font-size:0.85rem;margin-bottom:8px">Distribuzione speaker</h4>';
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
    for (const [spk, st] of Object.entries(stats.speakerStats)) {
      const pct = stats.wordsCount > 0 ? Math.round((st.words / stats.wordsCount) * 100) : 0;
      const colorClass = speakerColorClass(spk, speakers);
      html += `<div style="flex:1;min-width:120px;padding:8px 12px;background:var(--surface-alt);border-radius:var(--radius);border-left:3px solid">
        <div class="segment-speaker ${colorClass}" style="margin-bottom:4px">${esc(spk)}</div>
        <div style="font-size:0.78rem;color:var(--text-muted)">${st.words} parole (${pct}%) · ${st.segments} seg</div>
      </div>`;
    }
    html += '</div></div>';
  }

  html += '</div>';
  container.innerHTML = html;
}

// ══════════════════════════════════════
//  RENDER: Summary
// ══════════════════════════════════════

function renderSummary(container, data) {
  if (!data.summary) {
    container.innerHTML = '<div class="empty">Nessun sommario disponibile</div>';
    return;
  }

  const { sections, raw } = data.summary;
  let html = '<div class="modal-body-inner">';

  const sectionConfigs = [
    { key: 'keyPoints', title: 'Punti Chiave', icon: '&#9679;', cls: 'key-points' },
    { key: 'actions', title: 'Azioni / TODO', icon: '&#9745;', cls: 'actions' },
    { key: 'decisions', title: 'Decisioni', icon: '&#9733;', cls: 'decisions' },
    { key: 'risks', title: 'Rischi / Problemi', icon: '&#9888;', cls: 'risks' },
  ];

  let hasSections = false;
  for (const cfg of sectionConfigs) {
    const items = sections[cfg.key] || [];
    if (items.length === 0) continue;
    hasSections = true;

    html += `<div class="summary-section">
      <h4><span class="icon">${cfg.icon}</span> ${cfg.title} <span class="badge" style="font-size:0.7rem">${items.length}</span></h4>
      <ul class="summary-list ${cfg.cls}">
        ${items.map(i => `<li>${esc(i)}</li>`).join('')}
      </ul>
    </div>`;
  }

  if (raw) {
    if (hasSections) html += '<details style="margin-top:16px"><summary style="cursor:pointer;font-size:0.82rem;color:var(--text-muted)">Mostra testo originale</summary>';
    html += `<div class="summary-raw" style="margin-top:8px">${esc(raw)}</div>`;
    if (hasSections) html += '</details>';
  }

  html += '</div>';
  container.innerHTML = html;
}

// ══════════════════════════════════════
//  RENDER: Outline
// ══════════════════════════════════════

function renderOutline(container, data) {
  if (!data.outline || !data.outline.sections.length) {
    container.innerHTML = '<div class="empty">Nessun outline disponibile</div>';
    return;
  }

  let html = '<div class="modal-body-inner"><ul class="outline-tree">';
  for (const section of data.outline.sections) {
    const level = Math.min(section.level || 1, 4);
    const time = section.timestamp != null ? formatTimestamp(section.timestamp) : '';

    html += `<li class="outline-item outline-level-${level}">
      <div class="outline-item-header" onclick="toggleOutlineItem(this)">
        ${section.summary ? '<span class="outline-toggle">&#9654;</span>' : '<span style="width:20px"></span>'}
        <span class="outline-title">${esc(section.title)}</span>
        ${time ? `<span class="outline-time">${time}</span>` : ''}
      </div>
      ${section.summary ? `<div class="outline-summary hidden">${esc(section.summary)}</div>` : ''}
    </li>`;
  }
  html += '</ul></div>';
  container.innerHTML = html;
}

function toggleOutlineItem(header) {
  const toggle = header.querySelector('.outline-toggle');
  const summary = header.nextElementSibling;
  if (toggle && summary) {
    toggle.classList.toggle('open');
    summary.classList.toggle('hidden');
  }
}

// ══════════════════════════════════════
//  RENDER: Notes
// ══════════════════════════════════════

function renderNotes(container, data) {
  if (!data.notes || data.notes.length === 0) {
    container.innerHTML = '<div class="empty">Nessuna nota disponibile</div>';
    return;
  }

  let html = '<div class="modal-body-inner">';
  for (const note of data.notes) {
    html += `<div class="note-card">
      <h4>${esc(note.title)} <span class="note-type">${esc(note.type)}</span></h4>
      <div class="note-content">${esc(note.content)}</div>
    </div>`;
  }
  html += '</div>';
  container.innerHTML = html;
}

// ══════════════════════════════════════
//  RENDER: Pipeline
// ══════════════════════════════════════

function renderPipeline(container, data) {
  let html = '<div class="modal-body-inner">';

  const meta = data.meta || data.metadata?.pipeline;
  if (meta) {
    html += '<h4 style="font-size:0.85rem;margin-bottom:10px">Pipeline Metrics</h4>';
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">';
    if (meta.totalContents != null) html += `<span class="status status-info">${meta.totalContents} totali</span>`;
    if (meta.downloadedContents) html += `<span class="status status-ok">${meta.downloadedContents} scaricati</span>`;
    if (meta.failedContents > 0) html += `<span class="status status-err">${meta.failedContents} falliti</span>`;
    if (meta.duplicatesRemoved > 0) html += `<span class="status status-warn">${meta.duplicatesRemoved} duplicati rimossi</span>`;
    if (meta.pipelineMs) html += `<span class="status status-info">${meta.pipelineMs}ms</span>`;
    html += '</div>';

    if (meta.groups) {
      html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">';
      for (const [cat, count] of Object.entries(meta.groups)) {
        if (count > 0) {
          html += `<div style="padding:6px 12px;background:var(--surface-alt);border-radius:var(--radius);font-size:0.82rem">
            <strong>${cat}</strong>: ${count}
          </div>`;
        }
      }
      html += '</div>';
    }
  }

  if (data.debug && data.debug.length > 0) {
    html += '<h4 style="font-size:0.85rem;margin-bottom:8px">Content Items</h4>';
    html += '<div style="overflow-x:auto"><table><thead><tr>';
    html += '<th>#</th><th>Category</th><th>data_type</th><th>Title</th><th>Tab</th><th>Format</th><th>Size</th><th>Time</th><th>Hash</th>';
    html += '</tr></thead><tbody>';

    for (const item of data.debug) {
      const catClass = item.category === 'transcript' ? 'status-info' :
                       item.category === 'summary' ? 'status-ok' :
                       item.category === 'outline' ? 'status-warn' :
                       item.category === 'notes' ? 'status-info' : '';
      html += `<tr>
        <td>${item.originalIndex}</td>
        <td><span class="status ${catClass}">${esc(item.category)}</span></td>
        <td style="font-family:var(--font-mono);font-size:0.75rem">${esc(item.dataType)}</td>
        <td>${esc(item.title)}</td>
        <td>${esc(item.tab || '-')}</td>
        <td>${esc(item.format)}</td>
        <td>${formatSize(item.sizeBytes)}</td>
        <td>${item.downloadMs}ms</td>
        <td style="font-family:var(--font-mono);font-size:0.7rem">${esc(item.hash)}</td>
      </tr>`;
    }
    html += '</tbody></table></div>';

    html += '<h4 style="font-size:0.85rem;margin:16px 0 8px">Content Previews</h4>';
    for (const item of data.debug) {
      if (item.rawPreview) {
        html += `<details style="margin-bottom:6px">
          <summary style="cursor:pointer;font-size:0.78rem;color:var(--text-muted)">[${item.originalIndex}] ${esc(item.category)} — ${esc(item.title)}</summary>
          <div class="summary-raw" style="margin-top:4px;font-size:0.78rem;max-height:150px;overflow-y:auto">${esc(item.rawPreview)}...</div>
        </details>`;
      }
    }
  }

  if (data.log && data.log.length > 0) {
    html += '<h4 style="font-size:0.85rem;margin:16px 0 8px">Pipeline Log</h4>';
    html += '<div class="pipeline-log">';
    for (const entry of data.log) {
      const cls = entry.level === 'ok' ? 'ok' : entry.level === 'error' ? 'error' : '';
      html += `<div class="pipeline-log-entry ${cls}">[${entry.level}] ${esc(entry.msg)}</div>`;
    }
    html += '</div>';
  }

  html += '</div>';
  container.innerHTML = html;
}

// ══════════════════════════════════════
//  RENDER: Raw
// ══════════════════════════════════════

function renderRaw(container, data) {
  let html = '<div class="modal-body-inner">';

  if (data.metadata) {
    html += '<h4 style="font-size:0.85rem;margin-bottom:8px">Metadata</h4>';
    html += `<div class="summary-raw">${esc(JSON.stringify(data.metadata, null, 2))}</div>`;
  }

  if (data.rawDetail) {
    html += '<details style="margin-top:16px"><summary style="cursor:pointer;font-size:0.82rem;color:var(--text-muted)">Raw file detail JSON</summary>';
    html += `<div class="summary-raw" style="margin-top:8px;max-height:400px;overflow-y:auto">${esc(JSON.stringify(data.rawDetail, null, 2))}</div>`;
    html += '</details>';
  }

  html += '<details style="margin-top:16px"><summary style="cursor:pointer;font-size:0.82rem;color:var(--text-muted)">Full pipeline response JSON</summary>';
  const exportable = { ...data };
  delete exportable.rawDetail;
  html += `<div class="summary-raw" style="margin-top:8px;max-height:400px;overflow-y:auto">${esc(JSON.stringify(exportable, null, 2))}</div>`;
  html += '</details>';

  html += '</div>';
  container.innerHTML = html;
}

// ══════════════════════════════════════
//  MODAL FOOTER
// ══════════════════════════════════════

function updateFooter() {
  const left = document.getElementById('modalFooterLeft');
  const data = state.currentData;

  if (!data) { left.innerHTML = ''; return; }

  const m = data.metadata || {};
  const meta = data.meta || m.pipeline || {};
  const parts = [];
  if (m.hasTranscript) parts.push('Transcript');
  if (m.hasSummary) parts.push('Summary');
  if (m.hasOutline) parts.push('Outline');
  if (m.notesCount > 0) parts.push(`${m.notesCount} Note`);
  if (meta.pipelineMs) parts.push(`${meta.pipelineMs}ms`);

  left.innerHTML = `<span class="modal-stats">${parts.join(' · ') || 'Nessun contenuto'}</span>`;
}

// ══════════════════════════════════════
//  EXPORT & COPY
// ══════════════════════════════════════

function copyCurrentTab() {
  const text = getCurrentTabText();
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => log('Copiato negli appunti', 'ok'));
}

function exportTXT() {
  const text = getCurrentTabText();
  if (!text) return;
  const title = document.getElementById('modalTitle').textContent;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  downloadBlob(blob, `${sanitizeFilename(title)}_${state.activeTab}.txt`);
  log(`Esportato TXT: ${state.activeTab}`, 'ok');
}

function exportJSON() {
  const data = state.currentData;
  if (!data) return;
  const title = document.getElementById('modalTitle').textContent;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  downloadBlob(blob, `${sanitizeFilename(title)}_full.json`);
  log('Esportato JSON completo', 'ok');
}

function getCurrentTabText() {
  const data = state.currentData;
  if (!data) return '';

  switch (state.activeTab) {
    case 'transcript': return data.transcript?.fullText || '';
    case 'summary':    return data.summary?.raw || '';
    case 'outline':
      return (data.outline?.sections || []).map(s => {
        const indent = '  '.repeat((s.level || 1) - 1);
        const time = s.timestamp != null ? ` [${formatTimestamp(s.timestamp)}]` : '';
        return `${indent}${s.title}${time}`;
      }).join('\n');
    case 'notes':
      return (data.notes || []).map(n => `=== ${n.title} ===\n${n.content}`).join('\n\n');
    case 'ba':
      return state.baDocument ? baDocumentToText(state.baDocument) : '';
    case 'raw':
      return JSON.stringify(data, null, 2);
    default: return '';
  }
}

// ══════════════════════════════════════
//  MODAL OPEN/CLOSE
// ══════════════════════════════════════

function closeModal() {
  document.getElementById('contentModal').classList.remove('open');
}

// ══════════════════════════════════════
//  HELPERS — Date / Timestamp
// ══════════════════════════════════════

function normalizeDate(ts) {
  if (!ts) return null;
  if (ts instanceof Date) return ts;
  if (typeof ts === 'string') {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  }
  const n = Number(ts);
  if (isNaN(n)) return null;
  if (n > 1e12) return new Date(n);
  if (n > 1e9)  return new Date(n * 1000);
  return null;
}

function formatDate(ts) {
  const d = normalizeDate(ts);
  if (!d) return '-';
  return d.toLocaleString('it-IT', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatDuration(seconds) {
  if (!seconds) return '-';
  seconds = Number(seconds);
  if (isNaN(seconds)) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function formatTimestamp(seconds) {
  if (seconds == null) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (!bytes) return '-';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// ══════════════════════════════════════
//  SORTING
// ══════════════════════════════════════

function sortRecordings(data) {
  return data.sort((a, b) => {
    const da = normalizeDate(a.createdAt)?.getTime() || 0;
    const db = normalizeDate(b.createdAt)?.getTime() || 0;
    return state.sort.direction === 'asc' ? da - db : db - da;
  });
}

function toggleSort() {
  state.sort.direction = state.sort.direction === 'desc' ? 'asc' : 'desc';
  renderRecordings();
}

// ══════════════════════════════════════
//  BA GENERATOR (EGO Template)
// ══════════════════════════════════════

function generateBADocument(data) {
  if (!data) return null;

  const transcript = data.transcript || {};
  const summary = data.summary || {};
  const outline = data.outline || {};
  const metadata = data.metadata || {};
  const sections = summary.sections || {};
  const fullText = transcript.fullText || '';
  const segments = transcript.segments || [];

  const executiveSummary = buildExecutiveSummary(sections, metadata, segments);
  const businessContext = buildBusinessContext(metadata, sections, fullText);
  const objectives = extractObjectives(sections, fullText);
  const requirements = extractRequirements(fullText, sections);
  const jobStories = extractJobStories(fullText, sections);
  const functionalAnalysis = buildFunctionalAnalysis(outline, sections);
  const dataIntegration = extractDataIntegration(fullText);
  const risks = extractRisks(sections, fullText);
  const openPoints = extractOpenPoints(fullText, sections);
  const nextActions = extractNextActions(sections, fullText);
  const kpiMonitoring = extractKPI(fullText);

  return {
    title: metadata.filename || 'BA Document',
    generatedAt: new Date().toISOString(),
    executiveSummary, businessContext, objectives, requirements, jobStories,
    functionalAnalysis, dataIntegration, risks, openPoints, nextActions, kpiMonitoring,
  };
}

function buildExecutiveSummary(sections, metadata, segments) {
  const parts = [];
  if (metadata.filename) parts.push(`Meeting: ${metadata.filename}`);
  if (metadata.duration) parts.push(`Durata: ${formatDuration(metadata.duration)}`);
  if (segments.length > 0) {
    const speakers = [...new Set(segments.map(s => s.speaker))];
    parts.push(`Partecipanti: ${speakers.join(', ')}`);
  }
  const keyPoints = sections.keyPoints || [];
  if (keyPoints.length > 0) {
    parts.push('', 'Punti principali:');
    keyPoints.slice(0, 5).forEach(p => parts.push(`- ${p}`));
  }
  return parts.join('\n');
}

function buildBusinessContext(metadata, sections, fullText) {
  const parts = [];
  if (metadata.createdAt) parts.push(`Data meeting: ${formatDate(metadata.createdAt)}`);
  const contextSnippet = fullText.substring(0, 500);
  if (contextSnippet) {
    parts.push('', 'Contesto discusso:');
    parts.push(contextSnippet.replace(/\[.*?\]\s*\(.*?\)\n/g, '').substring(0, 300) + '...');
  }
  return parts.join('\n');
}

function extractObjectives(sections, fullText) {
  const objectives = [];
  (sections.keyPoints || []).forEach(p => {
    if (/obiettiv|goal|target|scopo|finalit/i.test(p)) objectives.push(p);
  });
  const objPatterns = /(?:l'obiettivo|lo scopo|il goal|dobbiamo raggiungere|vogliamo ottenere|the goal is|we aim to)\s+[^.]+/gi;
  let m;
  while ((m = objPatterns.exec(fullText)) !== null) objectives.push(m[0].trim());
  return objectives.length > 0 ? objectives : ['Nessun obiettivo esplicito individuato nel meeting.'];
}

function extractRequirements(fullText, sections) {
  const reqs = [];
  const reqPatterns = /(?:deve|dovrà|richiede|necessita|bisogna|implementare|occorre|è necessario|should|must|need to|requires)\s+[^.!?]+[.!?]?/gi;
  let m;
  while ((m = reqPatterns.exec(fullText)) !== null) {
    const text = m[0].trim();
    if (text.length > 15 && text.length < 300)
      reqs.push({ id: `RF-${String(reqs.length + 1).padStart(3, '0')}`, text });
  }
  (sections.decisions || []).forEach(d => {
    if (/deve|implementare|richiede|should|must/i.test(d))
      reqs.push({ id: `RF-${String(reqs.length + 1).padStart(3, '0')}`, text: d });
  });
  return deduplicateByText(reqs, 'text').slice(0, 20);
}

function extractJobStories(fullText, sections) {
  const stories = [];
  const storyPatterns = /(?:as a|come|in qualità di)\s+([^,]+),?\s*(?:I want|vorrei|voglio)\s+([^,]+),?\s*(?:so that|in modo che|così che|affinché)\s+([^.]+)/gi;
  let m;
  while ((m = storyPatterns.exec(fullText)) !== null)
    stories.push({ user: m[1].trim(), want: m[2].trim(), value: m[3].trim() });

  if (stories.length === 0) {
    const actions = sections.actions || [];
    const decisions = sections.decisions || [];
    [...actions, ...decisions].slice(0, 5).forEach(item => {
      stories.push({
        user: 'utente',
        want: item.replace(/^(deve|dovrà|bisogna)\s+/i, ''),
        value: 'migliorare il processo e raggiungere gli obiettivi di business',
      });
    });
  }
  return stories;
}

function buildFunctionalAnalysis(outline, sections) {
  const items = [];
  if (outline.sections) {
    outline.sections.forEach(s => items.push({ title: s.title, level: s.level || 1, detail: s.summary || '' }));
  }
  if (items.length === 0 && sections.keyPoints) {
    sections.keyPoints.forEach(p => items.push({ title: p, level: 1, detail: '' }));
  }
  return items;
}

function extractDataIntegration(fullText) {
  const points = [];
  const patterns = /(?:API|database|integrazione|endpoint|servizio|microservic|webhook|ETL|data\s*flow|flusso dati|import|export|sync|migrazione)\s+[^.!?]+[.!?]?/gi;
  let m;
  while ((m = patterns.exec(fullText)) !== null) {
    const text = m[0].trim();
    if (text.length > 10 && text.length < 300) points.push(text);
  }
  return deduplicateSimple(points).slice(0, 10);
}

function extractRisks(sections, fullText) {
  const risks = [...(sections.risks || [])];
  const riskPatterns = /(?:rischio|problema|attenzione|criticità|warning|blocker|impedimento|issue|concern)\s*[:\s]+[^.!?]+[.!?]?/gi;
  let m;
  while ((m = riskPatterns.exec(fullText)) !== null) {
    const text = m[0].trim();
    if (text.length > 10 && text.length < 300) risks.push(text);
  }
  return deduplicateSimple(risks).slice(0, 15);
}

function extractOpenPoints(fullText) {
  const points = [];
  const patterns = /(?:da definire|da chiarire|da decidere|open point|punto aperto|TBD|to be defined|to be decided|da verificare|da confermare)\s*[:\s]*[^.!?]+[.!?]?/gi;
  let m;
  while ((m = patterns.exec(fullText)) !== null) points.push(m[0].trim());
  return deduplicateSimple(points).slice(0, 10);
}

function extractNextActions(sections, fullText) {
  const actions = [...(sections.actions || [])];
  const actionPatterns = /(?:fare|definire|implementare|creare|completare|organizzare|pianificare|verificare|contattare|preparare|scrivere|sviluppare)\s+[^.!?]+[.!?]?/gi;
  let m;
  while ((m = actionPatterns.exec(fullText)) !== null) {
    const text = m[0].trim();
    if (text.length > 10 && text.length < 200) actions.push(text);
  }
  return deduplicateSimple(actions).slice(0, 15);
}

function extractKPI(fullText) {
  const kpis = [];
  const patterns = /(?:KPI|metrica|metric|indicatore|measure|target|SLA|performance|benchmark|conversion|tasso)\s*[:\s]*[^.!?]+[.!?]?/gi;
  let m;
  while ((m = patterns.exec(fullText)) !== null) kpis.push(m[0].trim());
  return deduplicateSimple(kpis).slice(0, 10);
}

function deduplicateSimple(arr) {
  const seen = new Set();
  return arr.filter(item => {
    const key = item.toLowerCase().substring(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deduplicateByText(arr, field) {
  const seen = new Set();
  return arr.filter(item => {
    const key = item[field].toLowerCase().substring(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ══════════════════════════════════════
//  BA DOCUMENT — RENDER
// ══════════════════════════════════════

function renderBATab(container, data) {
  if (!state.baDocument) {
    const n8nStatus = state.n8nJob ? renderN8nJobStatus(state.n8nJob) : '';

    container.innerHTML = `<div class="modal-body-inner">
      <div class="ba-generate-prompt">
        <p>Genera il documento di Business Analysis dal contenuto del meeting.</p>
        <p style="font-size:0.82rem;color:var(--text-muted);margin:8px 0">
          Il BA Generator analizza trascrizione, sommario, outline e note per estrarre:
          requisiti, job stories, rischi, azioni e KPI.
        </p>
        <div class="ba-mode-selector">
          <div class="ba-mode-card" onclick="generateBA()">
            <div class="ba-mode-icon">&#9881;</div>
            <h5>BA Locale (Regex)</h5>
            <p>Estrazione istantanea con pattern matching.<br>Veloce, offline, deterministico.</p>
            <button class="btn btn-primary btn-sm">Genera Locale</button>
          </div>
          <div class="ba-mode-card ${state.n8nConfigured ? '' : 'ba-mode-disabled'}" onclick="${state.n8nConfigured ? 'triggerN8nBA()' : 'configureN8n()'}">
            <div class="ba-mode-icon">&#129302;</div>
            <h5>BA con AI (n8n)</h5>
            <p>${state.n8nConfigured
              ? 'Claude + GPT pipeline via n8n.<br>Qualità superiore, richiede connessione.'
              : 'Non configurato. Clicca per impostare<br>l\'URL webhook di n8n.'}</p>
            <button class="btn ${state.n8nConfigured ? 'btn-primary' : 'btn-outline'} btn-sm">
              ${state.n8nConfigured ? 'Genera con AI' : 'Configura n8n'}
            </button>
          </div>
        </div>
        ${n8nStatus}
      </div>
    </div>`;
    return;
  }

  const ba = state.baDocument;
  let html = '<div class="modal-body-inner ba-document">';

  const sourceLabel = ba.source === 'n8n-ai-pipeline'
    ? '<span class="ba-source ba-source-ai">AI Pipeline</span>'
    : '<span class="ba-source ba-source-local">Locale</span>';
  html += `<div class="ba-header">
    <h3>${esc(ba.title)} ${sourceLabel}</h3>
    <span class="ba-date">Generato: ${formatDate(ba.generatedAt)}</span>
    <div class="btn-row" style="margin-top:10px">
      <button class="btn btn-sm btn-outline" onclick="generateBA()">Rigenera Locale</button>
      ${state.n8nConfigured ? '<button class="btn btn-sm btn-primary" onclick="triggerN8nBA()">Rigenera con AI</button>' : ''}
      <button class="btn btn-sm btn-success" onclick="exportBADocx()">Export DOCX</button>
    </div>
  </div>`;

  html += renderBASection('Executive Summary', ba.executiveSummary, 'ba-exec');
  html += renderBASection('Business Context', ba.businessContext, 'ba-context');
  html += renderBAListSection('Objectives', ba.objectives, 'ba-objectives');

  if (ba.requirements.length > 0) {
    html += '<div class="ba-section ba-requirements"><h4>Requirements (RF)</h4>';
    html += '<table class="ba-req-table"><thead><tr><th>ID</th><th>Requisito</th></tr></thead><tbody>';
    ba.requirements.forEach(r => {
      html += `<tr><td class="ba-req-id">${esc(r.id)}</td><td>${esc(r.text)}</td></tr>`;
    });
    html += '</tbody></table></div>';
  }

  if (ba.jobStories.length > 0) {
    html += '<div class="ba-section ba-stories"><h4>Job Stories</h4>';
    ba.jobStories.forEach((s, i) => {
      html += `<div class="ba-story">
        <span class="ba-story-num">#${i + 1}</span>
        <div><strong>As a</strong> ${esc(s.user)}<br>
        <strong>I want</strong> ${esc(s.want)}<br>
        <strong>So that</strong> ${esc(s.value)}</div>
      </div>`;
    });
    html += '</div>';
  }

  if (ba.functionalAnalysis.length > 0) {
    html += '<div class="ba-section ba-functional"><h4>Functional Analysis</h4><ul>';
    ba.functionalAnalysis.forEach(f => {
      const indent = f.level > 1 ? ` style="margin-left:${(f.level - 1) * 16}px"` : '';
      html += `<li${indent}><strong>${esc(f.title)}</strong>${f.detail ? ` — ${esc(f.detail)}` : ''}</li>`;
    });
    html += '</ul></div>';
  }

  html += renderBAListSection('Data & Integration Points', ba.dataIntegration, 'ba-data');
  html += renderBAListSection('Risks & Issues', ba.risks, 'ba-risks');
  html += renderBAListSection('Open Points', ba.openPoints, 'ba-open');
  html += renderBAListSection('Next Actions', ba.nextActions, 'ba-actions');
  html += renderBAListSection('KPI & Monitoring', ba.kpiMonitoring, 'ba-kpi');

  html += '</div>';
  container.innerHTML = html;
}

function renderBASection(title, content, cls) {
  if (!content) return '';
  return `<div class="ba-section ${cls}"><h4>${title}</h4><div class="ba-text">${esc(content)}</div></div>`;
}

function renderBAListSection(title, items, cls) {
  if (!items || items.length === 0) return '';
  let html = `<div class="ba-section ${cls}"><h4>${title}</h4><ul>`;
  items.forEach(i => { html += `<li>${esc(i)}</li>`; });
  html += '</ul></div>';
  return html;
}

function generateBA() {
  if (!state.currentData) return;
  log('Generazione BA Document...');
  state.baDocument = generateBADocument(state.currentData);
  log('BA Document generato', 'ok');
  updateModalTabs(state.currentData);
  state.activeTab = 'ba';
  renderActiveTab();
}

async function exportBADocx() {
  if (!state.baDocument) { alert('Genera prima il BA Document'); return; }
  log('Esportazione DOCX in corso...');

  try {
    const resp = await fetch('/api/plaud/export-docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baDocument: state.baDocument }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);

    const blob = await resp.blob();
    const filename = sanitizeFilename(state.baDocument.title || 'BA_Document') + '_BA.docx';
    downloadBlob(blob, filename);
    log(`DOCX esportato: ${filename}`, 'ok');
  } catch (err) {
    log(`Errore export DOCX: ${err.message}`, 'err');
    alert(`Errore export DOCX: ${err.message}`);
  }
}

function baDocumentToText(ba) {
  const lines = [];
  lines.push(`# ${ba.title}`, `Generato: ${ba.generatedAt}`, '');
  lines.push('# Executive Summary', ba.executiveSummary || '-', '');
  lines.push('# Business Context', ba.businessContext || '-', '');
  lines.push('# Objectives');
  (ba.objectives || []).forEach(o => lines.push(`- ${o}`));
  lines.push('');
  lines.push('# Requirements (RF)');
  (ba.requirements || []).forEach(r => lines.push(`${r.id}: ${r.text}`));
  lines.push('');
  lines.push('# Job Stories');
  (ba.jobStories || []).forEach((s, i) => lines.push(`#${i + 1} As a ${s.user} I want ${s.want} So that ${s.value}`));
  lines.push('');
  lines.push('# Functional Analysis');
  (ba.functionalAnalysis || []).forEach(f => lines.push(`${'  '.repeat((f.level || 1) - 1)}- ${f.title}${f.detail ? ': ' + f.detail : ''}`));
  lines.push('');
  lines.push('# Data & Integration Points');
  (ba.dataIntegration || []).forEach(d => lines.push(`- ${d}`));
  lines.push('');
  lines.push('# Risks & Issues');
  (ba.risks || []).forEach(r => lines.push(`- ${r}`));
  lines.push('');
  lines.push('# Open Points');
  (ba.openPoints || []).forEach(p => lines.push(`- ${p}`));
  lines.push('');
  lines.push('# Next Actions');
  (ba.nextActions || []).forEach(a => lines.push(`- ${a}`));
  lines.push('');
  lines.push('# KPI & Monitoring');
  (ba.kpiMonitoring || []).forEach(k => lines.push(`- ${k}`));
  return lines.join('\n');
}

// ══════════════════════════════════════
//  N8N AI PIPELINE
// ══════════════════════════════════════

async function checkN8nConfig() {
  try {
    const resp = await fetch('/api/n8n/config');
    if (resp.ok) {
      const data = await resp.json();
      state.n8nConfigured = data.configured;
    }
  } catch { /* silently ignore */ }
}

async function configureN8n() {
  const url = prompt(
    'Inserisci l\'URL del webhook n8n:\n\n' +
    'Esempio: https://your-n8n.app/webhook/xxxxx\n\n' +
    'Puoi anche impostarlo via env var N8N_WEBHOOK_URL'
  );
  if (!url) return;

  try {
    const resp = await fetch('/api/n8n/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: url }),
    });
    if (!resp.ok) {
      const data = await resp.json();
      throw new Error(data.error?.message || data.error || `HTTP ${resp.status}`);
    }
    state.n8nConfigured = true;
    log('n8n webhook configurato', 'ok');
    if (state.activeTab === 'ba') renderActiveTab();
  } catch (err) {
    log(`Errore config n8n: ${err.message}`, 'err');
    alert(`Errore: ${err.message}`);
  }
}

async function triggerN8nBA() {
  if (!state.currentData) return;
  if (!state.n8nConfigured) { configureN8n(); return; }

  const fileId = state.currentData?.metadata?.fileId;
  const fileName = state.currentData?.metadata?.filename;
  if (!fileId) { alert('fileId non disponibile'); return; }

  log('Avvio pipeline AI (n8n)...');

  try {
    const resp = await fetch('/api/n8n/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId, fileName }),
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error?.message || data.error || `HTTP ${resp.status}`);
    }

    const data = await resp.json();
    state.n8nJob = data.job;

    if (data.job.status === 'completed' && data.job.result) {
      state.baDocument = data.job.result;
      log('BA Document AI generato (sync)', 'ok');
      updateModalTabs(state.currentData);
      state.activeTab = 'ba';
      renderActiveTab();
    } else {
      log(`Job ${data.job.jobId} avviato. Polling...`);
      startN8nPolling(data.job.jobId);
      state.activeTab = 'ba';
      renderActiveTab();
    }
  } catch (err) {
    log(`Errore pipeline AI: ${err.message}`, 'err');
    alert(`Errore: ${err.message}`);
  }
}

function startN8nPolling(jobId) {
  stopN8nPolling();

  state.n8nPolling = setInterval(async () => {
    try {
      const resp = await fetch(`/api/n8n/status/${jobId}`);
      if (!resp.ok) { stopN8nPolling(); return; }

      const job = await resp.json();
      state.n8nJob = job;

      if (job.status === 'completed' && job.result) {
        stopN8nPolling();
        state.baDocument = job.result;
        log('BA Document AI generato', 'ok');
        updateModalTabs(state.currentData);
        renderActiveTab();
      } else if (job.status === 'failed') {
        stopN8nPolling();
        log(`Pipeline AI fallita: ${job.error}`, 'err');
        renderActiveTab();
      } else {
        if (state.activeTab === 'ba') renderActiveTab();
      }
    } catch {
      stopN8nPolling();
    }
  }, 3000);
}

function stopN8nPolling() {
  if (state.n8nPolling) {
    clearInterval(state.n8nPolling);
    state.n8nPolling = null;
  }
}

function renderN8nJobStatus(job) {
  if (!job) return '';

  const statusClass = job.status === 'completed' ? 'status-ok'
    : job.status === 'failed' ? 'status-err' : 'status-info';

  const statusLabel = job.status === 'pending' ? 'In attesa...'
    : job.status === 'processing' ? `Elaborazione... (${job.chunksProcessed || 0}/${job.chunksTotal || '?'} chunks)`
    : job.status === 'completed' ? 'Completato'
    : `Fallito: ${job.error || 'errore sconosciuto'}`;

  let html = `<div class="n8n-status" style="margin-top:16px">
    <span class="status ${statusClass}">${esc(statusLabel)}</span>`;
  if (job.status === 'processing' || job.status === 'pending') html += ' <span class="loader"></span>';
  html += '</div>';
  return html;
}

// ══════════════════════════════════════
//  HELPERS — General
// ══════════════════════════════════════

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeFilename(str) {
  return str.replace(/[^a-zA-Z0-9_\-\s]/g, '').replace(/\s+/g, '_').substring(0, 80);
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
