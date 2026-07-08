// Connection list/modal logic. Field IDs and the "leave secret blank on
// edit to keep the existing one" behavior are adapted from Time Buddy's
// public/js/connections.js (showAddConnectionForm/editConnection/
// saveConnection) — see NOTICE.md. Persistence goes through
// window.connectionManager (exposed by preload.js) instead of localStorage.

let editingConnectionId = null;

function $(id) {
  return document.getElementById(id);
}

function currentAuthType() {
  return document.querySelector('input[name="authType"]:checked').value;
}

function setAuthType(type) {
  for (const radio of document.querySelectorAll('input[name="authType"]')) {
    radio.checked = radio.value === type;
  }
  $('bearerFields').classList.toggle('hidden', type !== 'bearer');
  $('basicFields').classList.toggle('hidden', type !== 'basic');
}

for (const radio of document.querySelectorAll('input[name="authType"]')) {
  radio.addEventListener('change', (e) => setAuthType(e.target.value));
}

function currentKind() {
  return document.querySelector('input[name="connectionKind"]:checked').value;
}

function setKind(kind) {
  for (const radio of document.querySelectorAll('input[name="connectionKind"]')) {
    radio.checked = radio.value === kind;
  }
  $('grafanaFields').classList.toggle('hidden', kind !== 'grafana');
  $('graylogFields').classList.toggle('hidden', kind !== 'graylog');
  $('connectionUrl').placeholder = kind === 'graylog' ? 'https://graylog.example.com' : 'https://grafana.example.com';
}

for (const radio of document.querySelectorAll('input[name="connectionKind"]')) {
  radio.addEventListener('change', (e) => setKind(e.target.value));
}

function resetCommonFields(connection) {
  $('connectionName').value = connection?.name ?? '';
  $('connectionUrl').value = connection?.url ?? '';
  // Secrets are never sent back to the renderer — leaving these blank and
  // saving keeps whatever is already stored (see connectionStore.js).
  $('connectionToken').value = '';
  $('connectionUsername').value = connection?.username ?? '';
  $('connectionPassword').value = '';
  $('connectionMatchHosts').value = (connection?.matchHosts ?? []).join(', ');
  $('connectionApiVersion').value = connection?.apiVersion ?? 'legacy';
  $('connectionStreamId').value = connection?.streamId ?? '';
  $('connectionStreamName').value = connection?.streamName ?? '';
  $('connectionTags').value = (connection?.tags ?? []).join(', ');
  $('connectionTlsVerify').checked = connection?.tlsVerify ?? true;
  $('testResult').textContent = '';
  $('testResult').className = 'test-result';
  setKind(connection?.kind ?? 'grafana');
  setAuthType(connection?.authType ?? 'bearer');
}

function openModalForAdd() {
  editingConnectionId = null;
  $('connectionFormTitle').textContent = 'Add connection';
  resetCommonFields(undefined);
  $('connectionModal').classList.remove('hidden');
}

function openModalForEdit(connection) {
  editingConnectionId = connection.id;
  $('connectionFormTitle').textContent = `Edit connection: ${connection.name}`;
  resetCommonFields(connection);
  $('connectionModal').classList.remove('hidden');
}

function openModalForDuplicate(connection) {
  editingConnectionId = null;
  $('connectionFormTitle').textContent = `Duplicate connection: ${connection.name}`;
  // Secrets never reach the renderer, so a duplicate can't carry the
  // original's token/password along — re-enter it for the new connection.
  resetCommonFields({ ...connection, name: `${connection.name} (copy)` });
  $('connectionModal').classList.remove('hidden');
}

function closeModal() {
  $('connectionModal').classList.add('hidden');
  editingConnectionId = null;
}

function splitTags(value) {
  const tags = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return tags.length ? tags : undefined;
}

function readDraft() {
  const kind = currentKind();
  const authType = currentAuthType();
  return {
    id: editingConnectionId ?? undefined,
    kind,
    name: $('connectionName').value.trim(),
    url: $('connectionUrl').value.trim(),
    authType,
    token: authType === 'bearer' ? $('connectionToken').value.trim() : undefined,
    username: authType === 'basic' ? $('connectionUsername').value.trim() : undefined,
    password: authType === 'basic' ? $('connectionPassword').value.trim() : undefined,
    tags: splitTags($('connectionTags').value),
    tlsVerify: $('connectionTlsVerify').checked,
    // Grafana-only.
    matchHosts: kind === 'grafana' ? splitTags($('connectionMatchHosts').value) : undefined,
    // Graylog-only.
    apiVersion: kind === 'graylog' ? $('connectionApiVersion').value : undefined,
    streamId: kind === 'graylog' ? $('connectionStreamId').value.trim() || undefined : undefined,
    streamName: kind === 'graylog' ? $('connectionStreamName').value.trim() || undefined : undefined,
  };
}

async function renderConnections() {
  const connections = await window.connectionManager.list();
  const body = $('connectionsTableBody');
  body.innerHTML = '';

  if (connections.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="6">No connections yet. Click "Add connection" to create one.</td></tr>';
    return;
  }

  for (const connection of connections) {
    const row = document.createElement('tr');

    const nameCell = document.createElement('td');
    nameCell.textContent = connection.name;
    row.appendChild(nameCell);

    const kindCell = document.createElement('td');
    kindCell.textContent = (connection.kind ?? 'grafana') === 'graylog' ? 'Log source (Graylog)' : 'Grafana';
    row.appendChild(kindCell);

    const urlCell = document.createElement('td');
    urlCell.textContent = connection.url;
    row.appendChild(urlCell);

    const authCell = document.createElement('td');
    authCell.textContent = connection.authType === 'basic' ? 'Basic auth' : 'Bearer token';
    row.appendChild(authCell);

    const statusCell = document.createElement('td');
    statusCell.textContent = connection.hasSecret ? 'Configured' : 'Missing secret';
    statusCell.className = connection.hasSecret ? 'status-ok' : 'status-warn';
    row.appendChild(statusCell);

    const actionsCell = document.createElement('td');
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openModalForEdit(connection));
    const duplicateBtn = document.createElement('button');
    duplicateBtn.type = 'button';
    duplicateBtn.textContent = 'Duplicate';
    duplicateBtn.addEventListener('click', () => openModalForDuplicate(connection));
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      if (confirm(`Delete connection "${connection.name}"? This also removes its stored credential.`)) {
        await window.connectionManager.delete(connection.id);
        await renderConnections();
      }
    });
    actionsCell.appendChild(editBtn);
    actionsCell.appendChild(duplicateBtn);
    actionsCell.appendChild(deleteBtn);
    row.appendChild(actionsCell);

    body.appendChild(row);
  }
}

$('addConnectionBtn').addEventListener('click', openModalForAdd);
$('cancelConnectionBtn').addEventListener('click', closeModal);

$('saveConnectionBtn').addEventListener('click', async () => {
  const draft = readDraft();
  if (!draft.name || !draft.url) {
    alert('Please provide at least a name and URL for the connection.');
    return;
  }
  await window.connectionManager.upsert(draft);
  closeModal();
  await renderConnections();
});

$('testConnectionBtn').addEventListener('click', async () => {
  const draft = readDraft();
  const resultEl = $('testResult');
  resultEl.textContent = 'Testing...';
  resultEl.className = 'test-result';
  const result = await window.connectionManager.test(draft);
  resultEl.textContent = result.message;
  resultEl.className = `test-result ${result.ok ? 'status-ok' : 'status-warn'}`;
});

// Claude Code's exact `mcp add` flags can vary by version — this is the
// documented `name -- command [args...]` shape as of when this was written;
// if it doesn't match your installed version, `claude mcp add --help` has
// the current syntax. The Claude Desktop JSON, by contrast, is the same
// mcpServers shape every local MCP server uses, and won't drift.
async function loadRegistrationInfo() {
  const { execPath, isPackaged, appPath } = await window.connectionManager.registrationInfo();
  const quote = (s) => (s.includes(' ') ? `"${s}"` : s);

  // The raw dev Electron binary needs the app directory as an explicit
  // argument, or it just prints its own --help and never loads main.js —
  // only a packaged executable can be told to just run with --mcp-server on
  // its own. See main.js's registrationInfo handler for why.
  const args = isPackaged ? ['--mcp-server'] : [appPath, '--mcp-server'];

  const codeCommand = `claude mcp add timebuddy-incident-investigator -- ${quote(execPath)} ${args.map(quote).join(' ')}`;
  $('claudeCodeCommand').textContent = codeCommand;

  const desktopSnippet = JSON.stringify(
    {
      mcpServers: {
        'timebuddy-incident-investigator': {
          command: execPath,
          args,
        },
      },
    },
    null,
    2,
  );
  $('claudeDesktopSnippet').textContent = desktopSnippet;

  if (!isPackaged) {
    const note = document.createElement('p');
    note.className = 'subtitle';
    note.textContent =
      'Running from a dev checkout, not a packaged build — these commands include the app directory as an ' +
      'explicit argument, which a packaged install won\'t need.';
    $('claudeCodeCommand').insertAdjacentElement('beforebegin', note);
  }

  $('copyClaudeCodeBtn').addEventListener('click', () => navigator.clipboard.writeText(codeCommand));
  $('copyClaudeDesktopBtn').addEventListener('click', () => navigator.clipboard.writeText(desktopSnippet));
}

loadRegistrationInfo();
renderConnections();
