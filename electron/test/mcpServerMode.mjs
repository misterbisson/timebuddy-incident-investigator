// Integration check for the merged app: seed a connection through
// connectionStore.js, then spawn the real Electron binary in --mcp-server
// mode using the actual @modelcontextprotocol/sdk Client + StdioClientTransport
// (the same spawn-and-speak-stdio-JSON-RPC mechanism Claude Code/Desktop use)
// and confirm it lists the expected tools and that a tool call actually reaches
// out using the seeded connection's real URL/token (proving safeStorage ->
// GrafanaClient wiring works end to end, not just that the process boots).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const electronRoot = join(__dirname, '..');
// require('electron') (not "from within Electron") resolves to the binary's
// real path — robust regardless of whether npm hoisted it to the workspace
// root's node_modules or kept it local to electron/node_modules.
const electronBin = createRequire(import.meta.url)('electron');
const userDataDir = mkdtempSync(join(tmpdir(), 'timebuddy-mcp-test-'));

function fail(message) {
  console.error('FAIL:', message);
  rmSync(userDataDir, { recursive: true, force: true });
  process.exit(1);
}

// --password-store=basic is a Chromium switch (documented as a safeStorage
// override for Linux): it skips the OS keyring/Secret Service entirely,
// which on a headless CI runner can otherwise hang indefinitely waiting on
// an unlock prompt nothing will ever answer. A no-op on macOS/Windows, where
// safeStorage always uses Keychain/DPAPI regardless of this flag.
//
// --disable-gpu: a bare Xvfb has no real GPU/GL driver behind it, and
// Electron's GPU process can hang negotiating hardware acceleration against
// it rather than falling back cleanly. Neither script here ever creates a
// BrowserWindow, so no rendering is lost by disabling it.
//
// stdio: 'inherit' (not the previous encoding:'utf8' capture) so this
// script's own console.log checkpoints are visible in CI in real time,
// rather than being silently buffered until — or unless — the process exits.
const seed = spawnSync(
  electronBin,
  [
    'test/seedConnection.js',
    `--user-data-dir=${userDataDir}`,
    '--password-store=basic',
    '--disable-gpu',
  ],
  {
    cwd: electronRoot,
    stdio: 'inherit',
  },
);
if (seed.status !== 0) {
  fail(`seed script exited ${seed.status} (spawn error: ${seed.error})`);
}

/**
 * The failure mode this exists for: Claude Code/Desktop exits (or is killed)
 * while this process still owes it a response, so the reply lands on a broken
 * pipe. Nothing in the SDK's stdio transport guards that write, and the
 * resulting unhandled 'error' event used to reach Electron's default handler —
 * which, in a process that deliberately never opens a window, puts a modal
 * "A JavaScript error occurred in the main process" dialog on screen with no
 * app behind it and blocks the main thread so even idle shutdown can't reap it.
 *
 * Only the real binary can prove this: the engine's own unit tests
 * (test/stdioPipe.test.ts) cover the guard against fake streams, but the thing
 * that made this bug bad — Electron's crash dialog, and main.js's headless
 * handlers for it — exists only here. Driven with a raw child process rather
 * than StdioClientTransport because the whole point is to slam our read end of
 * its stdout shut, which a well-behaved MCP client never does.
 */
async function checkClientDisconnectShutdown() {
  const child = spawn(
    electronBin,
    ['.', '--mcp-server', `--user-data-dir=${userDataDir}`, '--password-store=basic', '--disable-gpu'],
    { cwd: electronRoot, stdio: ['pipe', 'pipe', 'pipe'], env: process.env },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    process.stderr.write(`[electron disconnect stderr] ${chunk}`);
  });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

  // Break the pipe only once the server is actually serving — before that
  // there's no pending write to fail, so the test would prove nothing.
  const deadline = Date.now() + 60_000;
  while (!/MCP server running on stdio/.test(stderr)) {
    if (Date.now() > deadline) {
      child.kill();
      fail(`--mcp-server never reported readiness within 60s (stderr: ${stderr})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'disconnect-test', version: '0' } },
    }) + '\n',
  );
  // Our read end, gone before the reply can land — exactly what a departed
  // client looks like from the server's side. stdin is left open so this
  // exercises the failed-write path specifically, not the stdin-EOF one.
  child.stdout.destroy();

  const outcome = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 30_000)),
  ]);

  if (/A JavaScript error occurred|Unhandled 'error' event|Uncaught Exception/.test(stderr)) {
    child.kill();
    fail(`writing to a departed client crashed the main process instead of shutting it down: ${stderr}`);
  }
  if (outcome === 'timeout') {
    child.kill();
    fail(`--mcp-server did not quit within 30s of its client disappearing (stderr: ${stderr})`);
  }
  if (outcome.code !== 0) {
    fail(`--mcp-server exited ${outcome.code} (signal ${outcome.signal}) after its client disappeared, expected a clean 0`);
  }
  if (!/MCP client is gone/.test(stderr)) {
    fail(`--mcp-server quit without reporting why (stderr: ${stderr})`);
  }
  console.log('OK: a write to a departed client shut the server down cleanly instead of crashing');
}

const transport = new StdioClientTransport({
  command: electronBin,
  args: ['.', '--mcp-server', `--user-data-dir=${userDataDir}`, '--password-store=basic', '--disable-gpu'],
  cwd: electronRoot,
  stderr: 'pipe',
  // Unlike the seed step's spawnSync above (which inherits the full parent
  // environment by default), StdioClientTransport only inherits a small,
  // fixed allowlist (HOME/LOGNAME/PATH/SHELL/TERM/USER) unless env is given
  // explicitly here — so CI's ELECTRON_DISABLE_SANDBOX never reached this
  // process, and it hit the exact same SUID sandbox fatal error the seed
  // step needed that variable to avoid.
  env: process.env,
});

const client = new Client({ name: 'mcp-server-mode-test', version: '0.0.1' });

// Attached before connect(), not after: StdioClientTransport's stderr
// PassThrough exists immediately on construction specifically so early
// output isn't lost — a startup crash (before the MCP handshake even
// completes) would otherwise fail client.connect() itself with no listener
// ever attached, silently losing the one place the real error appears.
transport.stderr?.on('data', (chunk) => process.stderr.write(`[electron stderr] ${chunk}`));

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  const expectedNames = [
    'get_alert_context',
    'list_firing_alerts',
    'get_product_context',
    'fetch_dashboard',
    'resolve_panel_queries',
    'execute_query_window',
    'render_dashboard',
    'export_panel_csv',
    'screenshot_panel',
    'find_related_dashboards',
    'list_folder_dashboards',
    'detect_correlated_anomalies',
    'validate_baseline',
    'summarize_findings',
    'list_datasources',
    'discover_influxdb_schema',
    'discover_label_values',
    'search_logs',
    'list_log_sources',
    'correlate_logs',
  ];
  const actualNames = tools.map((t) => t.name).sort();
  // Compared as a set in *both* directions. The old one-way check
  // (expected.filter(n => !actual.includes(n))) could only catch a tool
  // disappearing from the list it already knew about — which is how
  // discover_influxdb_schema stayed missing from it: a tool that exists but
  // was never listed here was invisible to the assertion, and so was any tool
  // added later. That's not the "full expected tool set" CONTRIBUTING.md
  // claims this confirms, so the extra check is the point, not the one name.
  const missing = expectedNames.filter((n) => !actualNames.includes(n));
  const unexpected = actualNames.filter((n) => !expectedNames.includes(n));
  if (missing.length > 0 || unexpected.length > 0) {
    const parts = [];
    if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
    // Not a failure of the build so much as of this list: a newly registered
    // tool belongs here (and in README.md's table) before this passes again.
    if (unexpected.length > 0) parts.push(`unexpected (add them to expectedNames and README.md): ${unexpected.join(', ')}`);
    fail(`tools/list did not match the expected tool set — ${parts.join('; ')} (got: ${actualNames.join(', ')})`);
  }
  console.log(`OK: tools/list returned exactly the ${expectedNames.length} expected tools`);

  const result = await client.callTool({ name: 'fetch_dashboard', arguments: { dashboardUid: 'test-uid' } });
  const text = result.content?.[0]?.text ?? '';
  // We expect this to fail — grafana.example.com isn't a real Grafana — but
  // it must fail with a *network* error (proving connection resolution
  // succeeded, safeStorage decrypted the seeded token, and GrafanaClient
  // actually attempted the HTTP call), not a "no connections
  // configured"/"could not determine which connection" resolution error.
  if (/no grafana connections configured/i.test(text) || /could not determine which/i.test(text)) {
    fail(`fetch_dashboard failed at connection resolution, not at the network call: ${text}`);
  }
  console.log(`OK: fetch_dashboard got past connection resolution to a real network attempt: ${text}`);

  const logResult = await client.callTool({
    name: 'search_logs',
    arguments: { query: '*', startsAtMs: Date.now() - 60_000, endsAtMs: Date.now() },
  });
  const logText = logResult.content?.[0]?.text ?? '';
  // Same proof-of-wiring as fetch_dashboard above: graylog.example.com isn't
  // real either, so this must fail with a network error (safeStorage
  // decrypted the seeded Graylog token, GraylogClient actually attempted the
  // HTTP call), not a "no log connections configured"/"could not determine
  // which" resolution error.
  if (/no graylog connections configured/i.test(logText) || /could not determine which/i.test(logText)) {
    fail(`search_logs failed at connection resolution, not at the network call: ${logText}`);
  }
  console.log(`OK: search_logs got past connection resolution to a real network attempt: ${logText}`);

  if (actualNames.includes('execute_adhoc_query')) {
    fail('execute_adhoc_query must not be registered without an --allow-adhoc-queries flag');
  }
  console.log('OK: execute_adhoc_query is absent with no --allow-adhoc-queries flag');

  await client.close();

  // Second pass, same seeded store, this time with the flag. main.js is plain
  // JS and never sees tsc, so its argv parsing -> configOverrides ->
  // registerAll gating path has no type checking behind it: spawning the real
  // binary is the only thing that proves the flag actually arrives.
  const adhocTransport = new StdioClientTransport({
    command: electronBin,
    args: [
      '.',
      '--mcp-server',
      `--user-data-dir=${userDataDir}`,
      '--password-store=basic',
      '--disable-gpu',
      // Matches the hostname of the connection the seed step stored.
      '--allow-adhoc-queries=grafana.example.com:influxdb',
    ],
    cwd: electronRoot,
    stderr: 'pipe',
    env: process.env,
  });
  adhocTransport.stderr?.on('data', (chunk) => process.stderr.write(`[electron adhoc stderr] ${chunk}`));
  const adhocClient = new Client({ name: 'mcp-server-mode-adhoc-test', version: '0.0.0' });
  await adhocClient.connect(adhocTransport);

  const adhocTools = (await adhocClient.listTools()).tools.map((t) => t.name);
  if (!adhocTools.includes('execute_adhoc_query')) {
    fail(`execute_adhoc_query missing with the flag set (got: ${adhocTools.sort().join(', ')})`);
  }
  console.log('OK: execute_adhoc_query is registered when --allow-adhoc-queries names a configured host');

  // A destructive statement must come back as an error, never as a result.
  //
  // Scope of this check, stated precisely because it's easy to over-read: what
  // fails first here is the *authorization* step's listDatasources call, since
  // grafana.example.com isn't reachable — so this proves the call is gated, not
  // that the statement guard ran. The DROP text provably never reaches a
  // datasource because classifyInfluxQL runs before executeQueryWindow, and
  // that ordering is asserted directly against a mocked client in
  // test/executeAdhocQuery.tool.test.ts ("never reaches the datasource when the
  // statement guard refuses", which checks queryDs was not called at all). This
  // test's job is the part that one can't cover: that the argv flag reaches
  // registerAll in the real binary.
  const dropResult = await adhocClient.callTool({
    name: 'execute_adhoc_query',
    arguments: {
      query: 'DROP MEASUREMENT "cpu"',
      datasourceUid: 'whatever',
      fromMs: Date.now() - 60_000,
      toMs: Date.now(),
    },
  });
  const dropText = dropResult.content?.[0]?.text ?? '';
  if (dropResult.isError !== true) {
    fail(`DROP MEASUREMENT returned a non-error result: ${dropText}`);
  }
  if (/"series"|"provenance"/.test(dropText)) {
    fail(`DROP MEASUREMENT came back with query results: ${dropText}`);
  }
  console.log(`OK: DROP MEASUREMENT rejected: ${dropText.split('\n')[0]}`);

  await adhocClient.close();

  await checkClientDisconnectShutdown();

  rmSync(userDataDir, { recursive: true, force: true });
  console.log('ALL CHECKS PASSED');
  process.exit(0);
} catch (err) {
  fail(err instanceof Error ? err.stack : String(err));
}
