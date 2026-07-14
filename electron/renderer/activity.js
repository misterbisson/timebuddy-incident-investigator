const listEl = document.getElementById('activityList');
const emptyStateEl = document.getElementById('activityEmptyState');
const detailEl = document.getElementById('activityDetail');
const detailTitleEl = document.getElementById('detailTitle');
const detailSubtitleEl = document.getElementById('detailSubtitle');
const showScreenshotBtn = document.getElementById('showScreenshotBtn');
const showLiveBtn = document.getElementById('showLiveBtn');
const openBrowserBtn = document.getElementById('openBrowserBtn');
const screenshotEl = document.getElementById('detailScreenshot');
const webviewEl = document.getElementById('detailWebview');

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

function entryLabel(entry) {
  return entry.panelTitle || entry.dashboardTitle || entry.dashboardUid;
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
    li.innerHTML = `
      <div class="activity-item-time">${formatTime(entry.timestamp)}</div>
      <div class="activity-item-title">${escapeHtml(entryLabel(entry))}</div>
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

  emptyStateEl.classList.add('hidden');
  detailEl.classList.remove('hidden');
  detailTitleEl.textContent = entryLabel(entry);
  detailSubtitleEl.textContent = [entry.connectionName, entry.dashboardTitle, entry.toolName, formatTime(entry.timestamp)]
    .filter(Boolean)
    .join(' · ');

  showScreenshotBtn.classList.toggle('hidden', !entry.screenshotPath);
  openBrowserBtn.classList.toggle('hidden', !entry.url);
  webviewEl.classList.add('hidden');
  webviewEl.src = 'about:blank';
  screenshotEl.classList.add('hidden');
  screenshotEl.src = '';

  if (entry.screenshotPath) {
    showScreenshot(entry);
  } else if (entry.url) {
    showLive(entry);
  }

  showLiveBtn.onclick = () => showLive(entry);
  showScreenshotBtn.onclick = () => showScreenshot(entry);
  openBrowserBtn.onclick = () => window.activityLog.openExternal(entry.url);
}

function showScreenshot(entry) {
  if (!entry.screenshotPath) return;
  webviewEl.classList.add('hidden');
  screenshotEl.classList.remove('hidden');
  screenshotEl.src = `file://${entry.screenshotPath}`;
}

function showLive(entry) {
  if (!entry.url) return;
  screenshotEl.classList.add('hidden');
  webviewEl.classList.remove('hidden');
  webviewEl.src = entry.url;
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
