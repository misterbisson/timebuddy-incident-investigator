# timebuddy-incident-investigator

AI-powered investigation of dashboards, metrics, and logs during incidents.

A Grafana Incident Review MCP server: it gives an AI agent safe, read-only, structured
access to a Grafana instance so it can do the first 30-60 minutes of an SRE's incident
investigation — identify what fired, replay the underlying queries, compare against
baseline periods, search for correlated signals elsewhere, and hand back an
evidence-linked verdict for a human to act on.

## How it's organized

```
src/
  grafana/        read-only Grafana HTTP client + per-connection client registry
  connections/    resolves which Grafana connection a tool call should use, loads the connection store
  alerts/         normalizes a webhook payload / pasted alert JSON / Grafana URL into an AlertContext
  webhook/        a small companion HTTP listener that receives Grafana's webhook contact-point POSTs
  dashboards/     panel/target extraction + Grafana template-variable substitution
  query/          incident/pre-window/baseline window math + execution via /api/ds/query
  index-builder/  crawls dashboards into a metric/measurement -> dashboard reverse index (cached locally, per connection)
  analysis/       baseline z-score comparison, correlated-anomaly ranking, deterministic verdict assembly
  security/       the read-only enforcement layer: time-range/point limits, redaction, audit log
  tools/          the 8 MCP tools, each a thin wrapper over the modules above
electron/         a desktop app for managing Grafana connections (see "Multiple Grafana connections" below)
```

## Tools

| Tool | Purpose |
| --- | --- |
| `get_alert_context` | Ingest an alert (webhook payload, pasted JSON, or a dashboard/panel/alert-rule URL) and resolve it to dashboard UID, panel ID, labels, threshold, and time range. |
| `fetch_dashboard` | Fetch a dashboard's metadata, panel list, and template variables. |
| `resolve_panel_queries` | Extract a panel's query targets with variables substituted (using `var-*` overrides from the alert link where available). |
| `execute_query_window` | Replay a panel's queries for the incident window, a pre-window buffer, and baseline control windows. |
| `find_related_dashboards` | Reverse-index lookup: which other dashboards use a given metric or share label values with the alert. |
| `detect_correlated_anomalies` | Rank candidate panels by deviation strength, label overlap, and anomaly-onset timing vs. the primary alert. |
| `validate_baseline` | Z-score classification of the incident window vs. prior-hour/day/week baselines, flagging recurring patterns. |
| `summarize_findings` | Deterministic verdict assembly (`real-anomaly` / `likely-false-positive` / `inconclusive`) plus an evidence bundle — it does not generate prose; the calling agent writes the human-readable note from this bundle. |

## Setup

The recommended path is to run the connection-manager app once per person and let each
teammate authenticate as themselves against every Grafana endpoint they need:

1. `cd electron && npm install && npm run dev`, then add a connection for each Grafana
   endpoint you use (one per region/tier, etc.) — either a personal Bearer token (if your
   Grafana allows self-service API token creation) or your own username/password (Basic
   auth). "Test connection" before saving. See [`electron/README.md`](electron/README.md)
   for how this is stored.
2. Set `GRAFANA_CONNECTIONS_DIR` in the MCP server's environment to the storage location
   shown in that app (copy-path button provided); the server reads `connections.json` and
   `credentials.json` from there on startup.
3. `npm install` (root) and see `.env.example` for the optional limits (max lookback, max
   data points, concurrency, redaction patterns).

For a single Grafana instance with no interest in the desktop app (e.g. CI, or a quick
local test), `GRAFANA_URL`/`GRAFANA_TOKEN` in `.env` still works on its own — a Viewer-role
service-account token remains a fine, simpler choice there. Both paths can be used
together: the env-default connection and anything from `GRAFANA_CONNECTIONS_DIR` are
merged at startup.

## Running

**MCP server (stdio)** — for Claude Code/Desktop or any MCP client that spawns a
subprocess:

```bash
npm run build
node dist/index.js
```

Point your MCP client config at that command, e.g. in Claude Code:

```json
{
  "mcpServers": {
    "timebuddy-incident-investigator": {
      "command": "node",
      "args": ["/path/to/timebuddy-incident-investigator/dist/index.js"],
      "env": { "GRAFANA_URL": "https://grafana.example.com", "GRAFANA_TOKEN": "glsa_..." }
    }
  }
}
```

**Webhook listener (optional, separate process)** — only needed if you want
`get_alert_context` to pick up alerts automatically instead of via pasted JSON or a URL.
Point a Grafana contact point's webhook integration at it:

```bash
npm run webhook
```

It writes received alerts to `<DATA_DIR>/alerts.jsonl`; `get_alert_context` reads the
latest one (or a specific fingerprint) from there when called with no arguments.

## Multiple Grafana connections

Every tool takes an optional `connection` parameter (a connection id). When it's
omitted:

- `get_alert_context` auto-detects the right connection by matching the alert's own
  URL (panel/dashboard/generator link) against each configured connection's `url` (or its
  `matchHosts`, for cases like a load balancer alias) — and returns `resolvedConnectionId`
  for you to pass into every subsequent call for that incident.
- Single-target tools (`fetch_dashboard`, `resolve_panel_queries`, `execute_query_window`,
  `validate_baseline`, and the primary panel in `detect_correlated_anomalies`) fall back to
  the one configured connection if there's only one, otherwise error out listing the
  available connection ids — they never guess.
- The two search tools (`find_related_dashboards`, and `detect_correlated_anomalies` when
  auto-discovering candidates) fan out across every configured connection and merge
  results, each tagged with its `connectionId`.

## Security model

- The Grafana client (`src/grafana/client.ts`) is a fixed allowlist of read-only endpoints.
  There is no "make an arbitrary Grafana request" tool — nothing built on top of it can
  reach a mutating endpoint, even if asked to.
- `security/limits.ts` caps query time-range span and max data points, and caps
  concurrent outgoing Grafana requests.
- `security/redact.ts` masks secret-shaped fields and any configured
  customer-identifier patterns before data is returned to the model.
- `security/audit.ts` appends every tool invocation to a local JSONL audit log.
- A per-user Bearer token or Basic-auth login (via the connection manager) no longer
  carries the "Viewer-role service account" defense-in-depth layer that a shared token
  gave you — whatever role that person actually has in Grafana applies. The read-only
  guarantee then rests entirely on the client allowlist above, which is why that allowlist
  has no generic escape hatch. A Viewer-scoped service-account token remains the more
  defense-in-depth choice for a shared/CI connection.

## Testing

```bash
npm test        # vitest, all unit tests run against fixtures — no live Grafana required
npm run typecheck
```

There's no live Grafana instance in CI for this repo, so `npm test` covers URL parsing,
variable substitution, baseline statistics, metric extraction/indexing, and redaction
against fixture data — not an end-to-end call against a real Grafana API. To verify
against a real instance, run the server under the
[MCP inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

## Known limitations (MVP)

- InfluxQL support covers raw-query-mode targets and does a best-effort reconstruction
  for structured query-builder targets; it doesn't replicate Grafana's full InfluxQL
  query builder.
- The metric index doesn't detect *unused* metrics (ones that exist in a datasource but
  appear in no dashboard) — only the reverse lookup (metric -> dashboards) and dashboards
  pointing at a datasource UID that no longer exists.
- `detect_correlated_anomalies` ranks candidates with a heuristic (z-score magnitude ×
  label overlap × onset-timing proximity), not a statistical correlation/causation test.

## Acknowledgments

The `electron/` connection-manager app's UI and auth model are adapted from
[Time Buddy](https://github.com/Liquescent-Development/time-buddy) by Richard Kiene /
Liquescent Development (AGPL-3.0-only, the same license this repository uses). See
[`NOTICE.md`](NOTICE.md) for exactly what was adapted and what was deliberately changed
(credential storage, most notably).
