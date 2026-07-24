// Connection list/modal logic. Field IDs and the "leave secret blank on
// edit to keep the existing one" behavior are adapted from Time Buddy's
// public/js/connections.js (showAddConnectionForm/editConnection/
// saveConnection) — see NOTICE.md. Persistence goes through
// window.connectionManager (exposed by preload.js) instead of localStorage.
//
// Two connection kinds share this one form: Grafana (bearer/basic auth,
// optional matchHosts) and Graylog (API-token/basic auth, optional
// streamId/streamName). `kind` is fixed at creation — the toggle is disabled
// while editing or duplicating an existing connection, since none of a
// connection's kind-specific fields carry over to the other kind.

let editingConnectionId = null;

function $(id) {
  return document.getElementById(id);
}

function currentKind() {
  return document.querySelector('input[name="kind"]:checked').value;
}

function setKind(kind, { lock = false } = {}) {
  for (const radio of document.querySelectorAll('input[name="kind"]')) {
    radio.checked = radio.value === kind;
    radio.disabled = lock;
  }
  $('grafanaFields').classList.toggle('hidden', kind !== 'grafana');
  $('graylogFields').classList.toggle('hidden', kind !== 'graylog');
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

function currentGraylogAuthType() {
  return document.querySelector('input[name="graylogAuthType"]:checked').value;
}

function setGraylogAuthType(type) {
  for (const radio of document.querySelectorAll('input[name="graylogAuthType"]')) {
    radio.checked = radio.value === type;
  }
  $('graylogTokenFields').classList.toggle('hidden', type !== 'token');
  $('graylogBasicFields').classList.toggle('hidden', type !== 'basic');
}

for (const radio of document.querySelectorAll('input[name="kind"]')) {
  radio.addEventListener('change', (e) => setKind(e.target.value));
}
for (const radio of document.querySelectorAll('input[name="authType"]')) {
  radio.addEventListener('change', (e) => setAuthType(e.target.value));
}
for (const radio of document.querySelectorAll('input[name="graylogAuthType"]')) {
  radio.addEventListener('change', (e) => setGraylogAuthType(e.target.value));
}

function resetCommonFields() {
  $('connectionName').value = '';
  $('connectionUrl').value = '';
  $('connectionTags').value = '';
  $('connectionTlsVerify').checked = true;
  $('testResult').textContent = '';
  $('testResult').className = 'test-result';
}

function resetGrafanaFields() {
  $('connectionToken').value = '';
  $('connectionUsername').value = '';
  $('connectionPassword').value = '';
  $('connectionMatchHosts').value = '';
  setAuthType('bearer');
}

function resetGraylogFields() {
  $('connectionGraylogToken').value = '';
  $('connectionGraylogUsername').value = '';
  $('connectionGraylogPassword').value = '';
  $('connectionStreamId').value = '';
  $('connectionStreamName').value = '';
  setGraylogAuthType('token');
}

function openModalForAdd() {
  editingConnectionId = null;
  $('connectionFormTitle').textContent = 'Add connection';
  resetCommonFields();
  resetGrafanaFields();
  resetGraylogFields();
  setKind('grafana', { lock: false });
  $('connectionModal').classList.remove('hidden');
}

function populateFromConnection(connection) {
  $('connectionName').value = connection.name;
  $('connectionUrl').value = connection.url;
  $('connectionTags').value = (connection.tags ?? []).join(', ');
  $('connectionTlsVerify').checked = connection.tlsVerify ?? true;
  $('testResult').textContent = '';
  $('testResult').className = 'test-result';

  const kind = connection.kind ?? 'grafana';
  if (kind === 'graylog') {
    // Secrets are never sent back to the renderer — leaving these blank and
    // saving keeps whatever is already stored (see connectionStore.js).
    $('connectionGraylogToken').value = '';
    $('connectionGraylogUsername').value = connection.username ?? '';
    $('connectionGraylogPassword').value = '';
    $('connectionStreamId').value = connection.streamId ?? '';
    $('connectionStreamName').value = connection.streamName ?? '';
    setGraylogAuthType(connection.authType ?? 'token');
  } else {
    $('connectionToken').value = '';
    $('connectionUsername').value = connection.username ?? '';
    $('connectionPassword').value = '';
    $('connectionMatchHosts').value = (connection.matchHosts ?? []).join(', ');
    setAuthType(connection.authType ?? 'bearer');
  }
  setKind(kind, { lock: true });
}

function openModalForEdit(connection) {
  editingConnectionId = connection.id;
  $('connectionFormTitle').textContent = `Edit connection: ${connection.name}`;
  populateFromConnection(connection);
  $('connectionModal').classList.remove('hidden');
}

function openModalForDuplicate(connection) {
  editingConnectionId = null;
  $('connectionFormTitle').textContent = `Duplicate connection: ${connection.name}`;
  // Secrets never reach the renderer, so a duplicate can't carry the
  // original's token/password along — re-enter it for the new connection.
  populateFromConnection(connection);
  $('connectionName').value = `${connection.name} (copy)`;
  $('connectionModal').classList.remove('hidden');
}

function closeModal() {
  $('connectionModal').classList.add('hidden');
  editingConnectionId = null;
}

function readTags() {
  const tags = $('connectionTags').value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return tags.length ? tags : undefined;
}

function readDraft() {
  const kind = currentKind();
  const common = {
    id: editingConnectionId ?? undefined,
    kind,
    name: $('connectionName').value.trim(),
    url: $('connectionUrl').value.trim(),
    tags: readTags(),
    tlsVerify: $('connectionTlsVerify').checked,
  };

  if (kind === 'graylog') {
    const authType = currentGraylogAuthType();
    return {
      ...common,
      authType,
      token: authType === 'token' ? $('connectionGraylogToken').value.trim() : undefined,
      username: authType === 'basic' ? $('connectionGraylogUsername').value.trim() : undefined,
      password: authType === 'basic' ? $('connectionGraylogPassword').value.trim() : undefined,
      streamId: $('connectionStreamId').value.trim() || undefined,
      streamName: $('connectionStreamName').value.trim() || undefined,
    };
  }

  const authType = currentAuthType();
  const matchHosts = $('connectionMatchHosts').value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    ...common,
    authType,
    token: authType === 'bearer' ? $('connectionToken').value.trim() : undefined,
    username: authType === 'basic' ? $('connectionUsername').value.trim() : undefined,
    password: authType === 'basic' ? $('connectionPassword').value.trim() : undefined,
    matchHosts: matchHosts.length ? matchHosts : undefined,
  };
}

function authLabel(connection) {
  if (connection.kind === 'graylog') {
    return connection.authType === 'basic' ? 'Basic auth' : 'API token';
  }
  return connection.authType === 'basic' ? 'Basic auth' : 'Bearer token';
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
    kindCell.textContent = connection.kind === 'graylog' ? 'Graylog' : 'Grafana';
    row.appendChild(kindCell);

    const urlCell = document.createElement('td');
    urlCell.textContent = connection.url;
    row.appendChild(urlCell);

    const authCell = document.createElement('td');
    authCell.textContent = authLabel(connection);
    row.appendChild(authCell);

    const statusCell = document.createElement('td');
    // Three states, not two. "Can't decrypt" means a secret *is* stored but
    // this machine's keychain can no longer open it (OS reinstall, keychain
    // reset, migration) — unlike "Missing secret", re-entering the credential
    // is the fix, so telling the user which one they have is the whole point.
    if (connection.secretError) {
      statusCell.textContent = "Can't decrypt secret";
      statusCell.className = 'status-err';
      statusCell.title = `${connection.secretError}\n\nEdit this connection and re-enter its credential to fix it. Other connections are unaffected.`;
    } else {
      statusCell.textContent = connection.hasSecret ? 'Configured' : 'Missing secret';
      statusCell.className = connection.hasSecret ? 'status-ok' : 'status-warn';
    }
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

function openImportModal() {
  $('importSharedUsername').value = '';
  $('importSharedPassword').value = '';
  $('importResult').textContent = '';
  $('importResult').className = 'test-result';
  $('importModal').classList.remove('hidden');
}

function closeImportModal() {
  $('importModal').classList.add('hidden');
}

function describeImportSummary(summary) {
  const parts = [
    `Imported ${summary.total} connection${summary.total === 1 ? '' : 's'} ` +
      `(${summary.created} added, ${summary.updated} updated).`,
  ];
  if (summary.configured > 0) {
    parts.push(`${summary.configured} have a stored credential.`);
  }
  if (summary.needSecret.length > 0) {
    const names = summary.needSecret.map((c) => c.name).join(', ');
    parts.push(`Still need a credential (edit each to add one): ${names}.`);
  }
  return parts.join(' ');
}

$('importConnectionsBtn').addEventListener('click', openImportModal);
$('cancelImportBtn').addEventListener('click', closeImportModal);

$('chooseImportFileBtn').addEventListener('click', async () => {
  const resultEl = $('importResult');
  resultEl.textContent = 'Choose a file…';
  resultEl.className = 'test-result';

  const response = await window.connectionManager.import({
    sharedUsername: $('importSharedUsername').value.trim(),
    sharedPassword: $('importSharedPassword').value,
  });

  if (response.canceled) {
    resultEl.textContent = '';
    return;
  }
  if (response.error) {
    // A validation failure carries the full problem list; show each on its own
    // line so a multi-mistake manifest is fixable in one pass.
    resultEl.textContent = response.problems?.length
      ? `Import failed:\n- ${response.problems.join('\n- ')}`
      : `Import failed: ${response.error}`;
    resultEl.className = 'test-result status-warn';
    return;
  }

  resultEl.textContent = describeImportSummary(response.summary);
  resultEl.className = 'test-result status-ok';
  await renderConnections();
});

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
  const { execPath, isPackaged, appPath, pluginPath } = await window.connectionManager.registrationInfo();
  const quote = (s) => (s.includes(' ') ? `"${s}"` : s);

  // The raw dev Electron binary needs the app directory as an explicit
  // argument, or it just prints its own --help and never loads main.js —
  // only a packaged executable can be told to just run with --mcp-server on
  // its own. See main.js's registrationInfo handler for why.
  const args = isPackaged ? ['--mcp-server'] : [appPath, '--mcp-server'];

  // An unpackaged run (npm run dev / electron .) is a contributor pointing this
  // at their own source checkout, not the installed app — suffix the server
  // name so it registers as a distinct entry instead of colliding with (or
  // overwriting) whatever real 'timebuddy-incident-investigator' registration
  // already points at the packaged build. See electron/CONTRIBUTING.md's
  // "Registering a dev instance with Claude Code" section.
  const serverName = isPackaged
    ? 'timebuddy-incident-investigator'
    : 'timebuddy-incident-investigator-dev';

  // --scope user (not the "local" default) registers this once for the whole machine/user
  // instead of only the one project directory this command happens to be run from —
  // consistent with the skills' --scope user below, and what you want for a single desktop
  // app meant to be usable from any project.
  const codeCommand = `claude mcp add --scope user ${serverName} -- ${quote(execPath)} ${args.map(quote).join(' ')}`;
  $('claudeCodeCommand').textContent = codeCommand;

  const desktopSnippet = JSON.stringify(
    {
      mcpServers: {
        [serverName]: {
          command: execPath,
          args,
        },
      },
    },
    null,
    2,
  );
  $('claudeDesktopSnippet').textContent = desktopSnippet;

  // Registers the plugin/skills bundled alongside this app (see main.js's
  // registrationInfo handler and package.json's build.extraResources) as a
  // local-directory marketplace, then installs it. The plugin/marketplace ids
  // in the second command aren't arbitrary — they're read from that bundle's
  // own .claude-plugin/marketplace.json / plugin.json "name" fields, so this
  // is fixed as long as those files don't change. --scope user writes both to
  // ~/.claude/settings.json (extraKnownMarketplaces + enabledPlugins) for this
  // machine/user, same as pasting the JSON snippet by hand used to, just via
  // the CLI instead — confirmed skills show up immediately with no restart
  // (only the MCP server itself needs a client restart to reconnect).
  const pluginCommand = [
    `claude plugin marketplace add ${quote(pluginPath)} --scope user`,
    'claude plugin install timebuddy@timebuddy-incident-investigator --scope user',
  ].join('\n');
  $('claudePluginSnippet').textContent = pluginCommand;

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
  $('copyClaudePluginBtn').addEventListener('click', () => navigator.clipboard.writeText(pluginCommand));
}

loadRegistrationInfo();
renderConnections();
