// Integration check for the merged app: seed a connection through
// connectionStore.js, then spawn the real Electron binary in --mcp-server
// mode using the actual @modelcontextprotocol/sdk Client + StdioClientTransport
// (the same spawn-and-speak-stdio-JSON-RPC mechanism Claude Code/Desktop use)
// and confirm it lists the expected tools and that a tool call actually reaches
// out using the seeded connection's real URL/token (proving safeStorage ->
// GrafanaClient wiring works end to end, not just that the process boots).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
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

const seed = spawnSync(electronBin, ['test/seedConnection.js', `--user-data-dir=${userDataDir}`], {
  cwd: electronRoot,
  encoding: 'utf8',
});
if (seed.status !== 0) {
  fail(`seed script exited ${seed.status} (spawn error: ${seed.error})\nstderr: ${seed.stderr}\nstdout: ${seed.stdout}`);
}

const transport = new StdioClientTransport({
  command: electronBin,
  args: ['.', '--mcp-server', `--user-data-dir=${userDataDir}`],
  cwd: electronRoot,
  stderr: 'pipe',
});

const client = new Client({ name: 'mcp-server-mode-test', version: '0.0.1' });

try {
  await client.connect(transport);
  transport.stderr?.on('data', (chunk) => process.stderr.write(`[electron stderr] ${chunk}`));

  const { tools } = await client.listTools();
  const expectedNames = [
    'get_alert_context',
    'get_product_context',
    'fetch_dashboard',
    'resolve_panel_queries',
    'execute_query_window',
    'render_dashboard',
    'export_panel_csv',
    'screenshot_panel',
    'find_related_dashboards',
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

  await client.close();
  rmSync(userDataDir, { recursive: true, force: true });
  console.log('ALL CHECKS PASSED');
  process.exit(0);
} catch (err) {
  fail(err instanceof Error ? err.stack : String(err));
}
