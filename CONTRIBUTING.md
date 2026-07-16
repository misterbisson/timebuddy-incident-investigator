# Developing

This covers developing the engine in `src/`. For the desktop app's own dev/build/release
workflow, see [`electron/CONTRIBUTING.md`](electron/CONTRIBUTING.md). If you just want to
install and use the app, see the root [`README.md`](README.md) instead — nothing below is
needed for that.

## Commands

```bash
npm install
npm run build       # tsc -> dist/
npm run dev          # run src/index.ts directly via tsx (no build step)
npm run typecheck    # tsc --noEmit
npm test             # vitest run (all unit tests, fixture-based, no live Grafana needed)
npx vitest run test/baseline.test.ts   # run a single test file
npm run webhook       # start the standalone webhook listener (src/webhook/listener.ts)
```

## How it's organized

```
src/
  server.ts       library entrypoint: createServer()/startMcpServer() build the MCP server for any caller
  index.ts        standalone CLI wrapper around server.ts (env-only connections; dev/CI use, not the distributed app)
  grafana/        read-only Grafana HTTP client + per-connection client registry
  connections/    resolves which Grafana connection a tool call should use
  alerts/         normalizes a webhook payload / pasted alert JSON / Grafana URL into an AlertContext
  webhook/        a small companion HTTP listener that receives Grafana's webhook contact-point POSTs
  dashboards/     panel/target extraction + Grafana template-variable substitution
  query/          incident/pre-window/baseline window math + execution via /api/ds/query
  index-builder/  crawls dashboards into a metric/measurement -> dashboard reverse index (cached locally, per connection)
  analysis/       baseline z-score comparison, correlated-anomaly ranking, deterministic verdict assembly
  security/       the read-only enforcement layer: time-range/point limits, redaction, audit log
  knowledge/      looks up an adopter-published "Timebuddy knowledge" dashboard/panel for a product, with caching
  activity/       in-memory log of panels actually queried/screenshotted, surfaced by the Electron app's Activity window
  tools/          the 14 MCP tools (13 always registered, screenshot_panel only in the Electron app), each a thin wrapper over the modules above
electron/         the distributed app: a GUI for managing Grafana connections that is *also* the MCP
                  server (launched with --mcp-server instead of opening a window) — see the root
                  README.md for using it, electron/CONTRIBUTING.md for developing it.
```

See the root [`README.md`](README.md#tools) for what each of the 14 MCP tools does, and
[`docs/BEHAVIOR.md`](docs/BEHAVIOR.md) for a few Grafana edge cases (product knowledge
dashboards, live `$__all` variable resolution, the `-- Dashboard --` pseudo-datasource)
that are easy to miss from a partial read of the code.

## Running the standalone CLI

Everyone installing this app uses the Electron build (see root README); the standalone
CLI is only for iterating on the engine itself without going through Electron, or for
CI. It uses `GRAFANA_URL`/`GRAFANA_TOKEN` (see `.env.example`) for a single connection —
not needed for `npm test`/`npm run typecheck`, since the Grafana client is mocked there.

```bash
npm run build
node dist/index.js
```

```json
{
  "mcpServers": {
    "timebuddy-incident-investigator-dev": {
      "command": "node",
      "args": ["/path/to/timebuddy-incident-investigator/dist/index.js"],
      "env": { "GRAFANA_URL": "https://grafana.example.com", "GRAFANA_TOKEN": "glsa_..." }
    }
  }
}
```

## Webhook listener

A separate, optional process (`src/webhook/listener.ts`) — not part of the MCP server
itself. It only accepts `POST /` and appends to `<DATA_DIR>/alerts.jsonl`;
`get_alert_context` reads from that store when called with no arguments. Point a
Grafana contact point's webhook integration at it:

```bash
npm run webhook
```

Keep it minimal — it exists solely so Grafana's contact-point webhook has somewhere to
land.

## Testing

```bash
npm test        # vitest, all unit tests run against fixtures — no live Grafana required
npm run typecheck
```

There's no live Grafana instance in CI for this repo, so `npm test` covers URL parsing,
variable substitution, baseline statistics, metric extraction/indexing, and redaction
against fixture data — not an end-to-end call against a real Grafana API. To verify
against a real instance, run the standalone CLI under the
[MCP inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

`electron/test/mcpServerMode.mjs` covers the distributed app specifically — see
[`electron/CONTRIBUTING.md`](electron/CONTRIBUTING.md#testing).

## Claude Code skills

`skills/explore/SKILL.md`, `skills/investigate/SKILL.md`, and `skills/export/SKILL.md`
(packaged as a Claude Code plugin via `.claude-plugin/plugin.json`, invoked as
`/timebuddy:explore` / `/timebuddy:investigate` / `/timebuddy:export`) are prose runbooks
that drive these tools in the right order for an agent. Treat them as part of the
interface, not just docs: if a tool's params, return shape, or behavior changes in a way
that would make a skill's instructions wrong or stale, update the skill in the same
change. See the root [`README.md`](README.md#claude-code-skills) for how end users
install and use them.

See the root [`README.md`](README.md#known-limitations-mvp) for known limitations,
including the PromQL/InfluxQL metric extraction tradeoffs (`index-builder/extract.ts`)
worth knowing before trying to make it more precise.
