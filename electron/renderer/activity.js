const listEl = document.getElementById('activityList');
const emptyStateEl = document.getElementById('activityEmptyState');
const detailEl = document.getElementById('activityDetail');
const detailTitleEl = document.getElementById('detailTitle');
const detailSubtitleEl = document.getElementById('detailSubtitle');
const showScreenshotBtn = document.getElementById('showScreenshotBtn');
const showLiveBtn = document.getElementById('showLiveBtn');
const openBrowserBtn = document.getElementById('openBrowserBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const captureScreenshotBtn = document.getElementById('captureScreenshotBtn');
const exportStatusEl = document.getElementById('exportStatus');
const exportStatusTextEl = document.getElementById('exportStatusText');
const revealBtn = document.getElementById('revealBtn');
const screenshotEl = document.getElementById('detailScreenshot');
const webviewEl = document.getElementById('detailWebview');
const logSummaryEl = document.getElementById('detailLogSummary');

// Newest first; keyed by id so a live-pushed entry can't be double-rendered
// if it somehow arrives both in the initial list() and as a push event.
let entries = [];
let selectedId = null;

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function isLog(entry) {
  return entry.kind === 'log';
}

function entryLabel(entry) {
  if (isLog(entry)) return entry.query;
  return entry.panelTitle || entry.dashboardTitle || entry.dashboardUid;
}

function streamLabel(entry) {
  return entry.streamName || entry.streamId || 'all streams';
}

function renderList() {
  if (entries.length === 0) {
    listEl.innerHTML = '<li class="empty-row">Nothing inspected yet.</li>';
    return;
  }
  listEl.innerHTML = '';
  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = 'activity-item' + (entry.id === selectedId ? ' selected' : '');
    li.dataset.id = entry.id;
    const kindTag = `<span class="activity-kind activity-kind-${isLog(entry) ? 'log' : 'panel'}">${isLog(entry) ? 'logs' : 'panel'}</span>`;
    li.innerHTML = `
      <div class="activity-item-time">${formatTime(entry.timestamp)}</div>
      <div class="activity-item-title">${kindTag}${escapeHtml(entryLabel(entry))}</div>
      <div class="activity-item-meta">${escapeHtml(entry.toolName)}${entry.connectionName ? ' &middot; ' + escapeHtml(entry.connectionName) : ''}</div>
    `;
    li.addEventListener('click', () => selectEntry(entry.id));
    listEl.appendChild(li);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function selectEntry(id) {
  selectedId = id;
  const entry = entries.find((e) => e.id === id);
  renderList();
  if (!entry) return;

  const log = isLog(entry);
  emptyStateEl.classList.add('hidden');
  detailEl.classList.remove('hidden');
  detailTitleEl.textContent = entryLabel(entry);
  // The middle field is the entry's most identifying secondary detail: a
  // dashboard title for a panel, the searched stream for a log.
  detailSubtitleEl.textContent = [entry.connectionName, log ? streamLabel(entry) : entry.dashboardTitle, entry.toolName, formatTime(entry.timestamp)]
    .filter(Boolean)
    .join(' · ');

  // A log entry has no screenshot and no single panel to view live / export —
  // its only affordance is opening the Graylog search in the browser. The
  // panel-only buttons stay hidden for it (they'd otherwise drive the Grafana
  // screenshotter/CSV exporter against a Graylog URL).
  showScreenshotBtn.classList.toggle('hidden', log || !entry.screenshotPath);
  showLiveBtn.classList.toggle('hidden', log);
  openBrowserBtn.classList.toggle('hidden', !entry.url);
  openBrowserBtn.textContent = log ? 'Open in Graylog' : 'Open in browser';
  // Export/capture need a specific panel over a specific window — both of which
  // the entry's url carries (viewPanel + from/to + var-*). Dashboard-level
  // entries (no panelId) and log entries have nothing single-panel to export.
  const canExport = !log && Boolean(entry.url) && entry.panelId != null;
  exportCsvBtn.classList.toggle('hidden', !canExport);
  captureScreenshotBtn.classList.toggle('hidden', !canExport);
  // The busy/disabled state is global to the two buttons, but a run only
  // re-enables them when its own entry is still selected. Reset it on every
  // switch so an export left in-flight on a prior entry can't leave the buttons
  // permanently disabled for the panel now on screen.
  setExportBusy(false);
  resetExportStatus();
  webviewEl.classList.add('hidden');
  webviewEl.src = 'about:blank';
  screenshotEl.classList.add('hidden');
  screenshotEl.src = '';
  logSummaryEl.classList.add('hidden');

  if (log) {
    showLogSummary(entry);
  } else if (entry.screenshotPath) {
    showScreenshot(entry);
  } else if (entry.url) {
    showLive(entry);
  }

  showLiveBtn.onclick = () => showLive(entry);
  showScreenshotBtn.onclick = () => showScreenshot(entry);
  openBrowserBtn.onclick = () => window.activityLog.openExternal(entry.url);
  exportCsvBtn.onclick = () => runExport('csv', entry);
  captureScreenshotBtn.onclick = () => runExport('screenshot', entry);
}

// Clears any prior export/capture status when switching entries or starting a
// fresh run, so a stale "Saved …" line never lingers under a different panel.
function resetExportStatus() {
  exportStatusEl.classList.add('hidden');
  exportStatusTextEl.textContent = '';
  revealBtn.classList.add('hidden');
  revealBtn.onclick = null;
}

function setExportBusy(busy) {
  exportCsvBtn.disabled = busy;
  captureScreenshotBtn.disabled = busy;
}

function showExportStatus(text, revealPath) {
  exportStatusEl.classList.remove('hidden');
  exportStatusTextEl.textContent = text;
  if (revealPath) {
    revealBtn.classList.remove('hidden');
    revealBtn.onclick = () => window.activityLog.revealInFolder(revealPath);
  } else {
    revealBtn.classList.add('hidden');
    revealBtn.onclick = null;
  }
}

// Drives the main-process export/screenshot handler for one entry and reports
// where the file landed. The selectedId guard drops a slow result whose entry
// the user has since navigated away from, so it can't overwrite the status of
// whatever panel is now on screen.
async function runExport(kind, entry) {
  setExportBusy(true);
  showExportStatus(kind === 'csv' ? 'Exporting CSV…' : 'Capturing screenshot…', null);
  try {
    if (kind === 'csv') {
      const { files } = await window.activityLog.exportCsv(entry);
      if (selectedId !== entry.id) return;
      const first = files[0];
      if (!first) {
        showExportStatus('No data to export for this panel.', null);
      } else if (files.length === 1) {
        showExportStatus(`Saved ${first.name} to Downloads.`, first.path);
      } else {
        showExportStatus(`Saved ${files.length} files to Downloads (${first.name}, …).`, first.path);
      }
    } else {
      const { path, name } = await window.activityLog.screenshot(entry);
      if (selectedId !== entry.id) return;
      showExportStatus(`Saved ${name} to Downloads.`, path);
    }
  } catch (err) {
    if (selectedId !== entry.id) return;
    showExportStatus(`Export failed: ${errorMessage(err)}`, null);
  } finally {
    if (selectedId === entry.id) setExportBusy(false);
  }
}

// IPC rejections arrive as "Error invoking remote method '…': Error: <msg>" —
// strip that wrapper down to the underlying message the engine actually threw.
function errorMessage(err) {
  const raw = (err && err.message) || String(err);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '');
}

function showScreenshot(entry) {
  if (!entry.screenshotPath) return;
  logSummaryEl.classList.add('hidden');
  webviewEl.classList.add('hidden');
  screenshotEl.classList.remove('hidden');
  screenshotEl.src = `file://${entry.screenshotPath}`;
}

function showLive(entry) {
  if (!entry.url) return;
  logSummaryEl.classList.add('hidden');
  screenshotEl.classList.add('hidden');
  webviewEl.classList.remove('hidden');
  webviewEl.src = entry.url;
}

// A log search isn't a single visual the way a panel screenshot is, and
// embedding the Graylog UI would drag in the live-view auth guard — so a log
// entry gets a plain text summary here plus the "Open in Graylog" button.
function showLogSummary(entry) {
  webviewEl.classList.add('hidden');
  screenshotEl.classList.add('hidden');
  const rows = [
    ['Query', entry.query],
    ['Stream', streamLabel(entry)],
    ['Results', entry.resultCount != null ? String(entry.resultCount) : '—'],
    ['Tool', entry.toolName],
  ];
  logSummaryEl.innerHTML = rows
    .map(([term, value]) => `<div class="log-summary-row"><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('');
  logSummaryEl.classList.remove('hidden');
}

function addEntry(entry) {
  entries.unshift(entry);
  renderList();
  if (selectedId === null) selectEntry(entry.id);
}

async function init() {
  entries = (await window.activityLog.list()).slice().reverse();
  renderList();
  window.activityLog.onEntry(addEntry);
}

init();
