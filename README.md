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
  grafana/        read-only Grafana HTTP client (search, dashboards, ds/query, alerts, rules, annotations)
  alerts/         normalizes a webhook payload / pasted alert JSON / Grafana URL into an AlertContext
  webhook/        a small companion HTTP listener that receives Grafana's webhook contact-point POSTs
  dashboards/     panel/target extraction + Grafana template-variable substitution
  query/          incident/pre-window/baseline window math + execution via /api/ds/query
  index-builder/  crawls dashboards into a metric/measurement -> dashboard reverse index (cached locally)
  analysis/       baseline z-score comparison, correlated-anomaly ranking, deterministic verdict assembly
  security/       the read-only enforcement layer: time-range/point limits, redaction, audit log
  tools/          the 8 MCP tools, each a thin wrapper over the modules above
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

1. Create a Grafana **service account** scoped to the **Viewer** role (defense in depth —
   the code only ever calls read-only endpoints, but the account itself should also be
   unable to mutate anything) and generate a token.
2. Copy `.env.example` to `.env` and fill in `GRAFANA_URL` and `GRAFANA_TOKEN`. See
   `.env.example` for the optional limits (max lookback, max data points, concurrency,
   redaction patterns).
3. `npm install`

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

## Security model

- The Grafana client (`src/grafana/client.ts`) is a fixed allowlist of read-only endpoints.
  There is no "make an arbitrary Grafana request" tool — nothing built on top of it can
  reach a mutating endpoint, even if asked to.
- `security/limits.ts` caps query time-range span and max data points, and caps
  concurrent outgoing Grafana requests.
- `security/redact.ts` masks secret-shaped fields and any configured
  customer-identifier patterns before data is returned to the model.
- `security/audit.ts` appends every tool invocation to a local JSONL audit log.

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
