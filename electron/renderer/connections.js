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

function openModalForAdd() {
  editingConnectionId = null;
  $('connectionFormTitle').textContent = 'Add connection';
  $('connectionName').value = '';
  $('connectionUrl').value = '';
  $('connectionToken').value = '';
  $('connectionUsername').value = '';
  $('connectionPassword').value = '';
  $('connectionMatchHosts').value = '';
  $('connectionTlsVerify').checked = true;
  $('testResult').textContent = '';
  $('testResult').className = 'test-result';
  setAuthType('bearer');
  $('connectionModal').classList.remove('hidden');
}

function openModalForEdit(connection) {
  editingConnectionId = connection.id;
  $('connectionFormTitle').textContent = `Edit connection: ${connection.name}`;
  $('connectionName').value = connection.name;
  $('connectionUrl').value = connection.url;
  // Secrets are never sent back to the renderer — leaving these blank and
  // saving keeps whatever is already stored (see connectionStore.js).
  $('connectionToken').value = '';
  $('connectionUsername').value = connection.username ?? '';
  $('connectionPassword').value = '';
  $('connectionMatchHosts').value = (connection.matchHosts ?? []).join(', ');
  $('connectionTlsVerify').checked = connection.tlsVerify ?? true;
  $('testResult').textContent = '';
  $('testResult').className = 'test-result';
  setAuthType(connection.authType);
  $('connectionModal').classList.remove('hidden');
}

function openModalForDuplicate(connection) {
  editingConnectionId = null;
  $('connectionFormTitle').textContent = `Duplicate connection: ${connection.name}`;
  $('connectionName').value = `${connection.name} (copy)`;
  $('connectionUrl').value = connection.url;
  // Secrets never reach the renderer, so a duplicate can't carry the
  // original's token/password along — re-enter it for the new connection.
  $('connectionToken').value = '';
  $('connectionUsername').value = connection.username ?? '';
  $('connectionPassword').value = '';
  $('connectionMatchHosts').value = (connection.matchHosts ?? []).join(', ');
  $('connectionTlsVerify').checked = connection.tlsVerify ?? true;
  $('testResult').textContent = '';
  $('testResult').className = 'test-result';
  setAuthType(connection.authType);
  $('connectionModal').classList.remove('hidden');
}

function closeModal() {
  $('connectionModal').classList.add('hidden');
  editingConnectionId = null;
}

function readDraft() {
  const authType = currentAuthType();
  const matchHosts = $('connectionMatchHosts').value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    id: editingConnectionId ?? undefined,
    name: $('connectionName').value.trim(),
    url: $('connectionUrl').value.trim(),
    authType,
    token: authType === 'bearer' ? $('connectionToken').value.trim() : undefined,
    username: authType === 'basic' ? $('connectionUsername').value.trim() : undefined,
    password: authType === 'basic' ? $('connectionPassword').value.trim() : undefined,
    matchHosts: matchHosts.length ? matchHosts : undefined,
    tlsVerify: $('connectionTlsVerify').checked,
  };
}

async function renderConnections() {
  const connections = await window.connectionManager.list();
  const body = $('connectionsTableBody');
  body.innerHTML = '';

  if (connections.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="5">No connections yet. Click "Add connection" to create one.</td></tr>';
    return;
  }

  for (const connection of connections) {
    const row = document.createElement('tr');

    const nameCell = document.createElement('td');
    nameCell.textContent = connection.name;
    row.appendChild(nameCell);

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
  const { execPath, isPackaged, appPath, pluginPath } = await window.connectionManager.registrationInfo();
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

  // Registers the plugin/skills bundled alongside this app (see main.js's
  // registrationInfo handler and package.json's build.extraResources) as a
  // local-directory marketplace — the plugin id and marketplace id here must
  // match .claude-plugin/marketplace.json's "name" fields exactly, or
  // enabledPlugins' "plugin@marketplace" key won't resolve.
  const pluginSnippet = JSON.stringify(
    {
      extraKnownMarketplaces: {
        'timebuddy-incident-investigator': {
          source: { source: 'directory', path: pluginPath },
        },
      },
      enabledPlugins: {
        'timebuddy@timebuddy-incident-investigator': true,
      },
    },
    null,
    2,
  );
  $('claudePluginSnippet').textContent = pluginSnippet;

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
  $('copyClaudePluginBtn').addEventListener('click', () => navigator.clipboard.writeText(pluginSnippet));
}

loadRegistrationInfo();
renderConnections();
