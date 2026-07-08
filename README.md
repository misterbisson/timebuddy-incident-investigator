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
  tools/          the 11 MCP tools, each a thin wrapper over the modules above
electron/         the distributed app: a GUI for managing Grafana connections that is *also* the MCP
                  server (launched with --mcp-server instead of opening a window) — see electron/README.md
```

## Tools

| Tool | Purpose |
| --- | --- |
| `get_alert_context` | Ingest an alert (webhook payload, pasted JSON, or a dashboard/panel/alert-rule URL) and resolve it to dashboard UID, panel ID, labels, threshold, and time range. Also attaches a matching "Timebuddy knowledge" panel when one has been published (see below). |
| `get_product_context` | Look up a "Timebuddy knowledge" panel directly by product key, without an alert in hand. |
| `fetch_dashboard` | Fetch a dashboard's metadata, panel list, and template variables. |
| `resolve_panel_queries` | Extract a panel's query targets with variables substituted (using `var-*` overrides from the alert link where available). |
| `execute_query_window` | Replay a panel's queries for the incident window, a pre-window buffer, and baseline control windows. Optional `threshold`/`thresholdDirection` returns each series' precise dip/spike run(s) — start, end, duration, min/max — instead of leaving that to be eyeballed from raw points. |
| `render_dashboard` | One-shot "what does this dashboard show right now": executes every queryable panel on a dashboard/panel/alert-rule URL (or `dashboardUid`) for a single window — no pre-window buffer, no baseline controls — instead of chaining `fetch_dashboard` -> `resolve_panel_queries` -> `execute_query_window` per panel. |
| `find_related_dashboards` | Reverse-index lookup: which other dashboards use a given metric or share label values with the alert. |
| `detect_correlated_anomalies` | Rank candidate panels by deviation strength, label overlap, and anomaly-onset timing vs. the primary alert. |
| `validate_baseline` | Z-score classification of the incident window vs. prior-hour/day/week baselines, flagging recurring patterns. |
| `summarize_findings` | Deterministic verdict assembly (`real-anomaly` / `likely-false-positive` / `inconclusive`) plus an evidence bundle — it does not generate prose; the calling agent writes the human-readable note from this bundle. |
| `list_datasources` | List a connection's configured datasources (uid/name/type/default) — mainly for checking whether a panel's literal-name datasource reference still exists under some other UID. |

## Setup

There's one app to install: run it, add your Grafana connection(s) yourself (each person
authenticates as themselves — a personal Bearer token or your own username/password —
instead of everyone sharing one admin-provisioned service-account token), then register it
with whichever Claude client you use. No separate MCP server process, no env vars to
hand-edit, no plaintext credential file anywhere.

1. `cd electron && npm install && npm run dev` — opens the connection manager.
2. Add a connection for each Grafana endpoint you use (one per region/tier, etc.) —
   Bearer token or Basic auth, your choice. "Test connection" before saving.
3. In the app's "Register with Claude" section, copy the command (Claude Code) or JSON
   snippet (Claude Desktop) shown there — it already has this app's own path filled in —
   and add it to your Claude client.

Adding, editing, or removing a connection later takes effect immediately for any MCP
server that's already running — it's picked up on the very next tool call, no restart
needed. (Restarting the connection-manager GUI window itself does nothing for this — it's
a separate process from the one your Claude client is already talking to.)

See [`electron/README.md`](electron/README.md) for exactly how connections/credentials are
stored (short version: `safeStorage`/OS-keychain-encrypted, nothing plaintext, ever).

For local development or CI, where there's no interest in the desktop app, the standalone
CLI still works on its own with a single connection from env vars — see "Standalone CLI"
below.

## Claude Code skills

This repo also ships as a Claude Code plugin (`.claude-plugin/plugin.json`) with two skills
that drive the tools above so nobody needs to know the tool names or the right call order:

- `/timebuddy:explore` — a low-stakes health check: confirms the MCP server is connected,
  surveys what connections/dashboards exist, and highlights which dashboards are actually
  alert-backed (and therefore trustworthy) before an incident happens.
- `/timebuddy:investigate` — the reactive path: ingests an alert (a pasted URL, alert JSON,
  or webhook payload), replays it, checks baselines, looks for correlated signals, and
  writes an evidence-linked incident note.

See [`skills/explore/SKILL.md`](skills/explore/SKILL.md) and
[`skills/investigate/SKILL.md`](skills/investigate/SKILL.md) for the exact pipeline each one
follows.

## Running

**The distributed app (recommended)** — one Electron binary, launched with `--mcp-server`
by whichever Claude client you registered it with (see Setup above); it reads connections
from its own `safeStorage`-backed store, no env vars needed. See
[`electron/README.md`](electron/README.md).

**Standalone CLI (dev/CI only)** — `src/index.ts` compiled to `dist/index.js`, using
`GRAFANA_URL`/`GRAFANA_TOKEN` for a single connection. Not what end users install; this is
for iterating on the engine itself without going through Electron:

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
  `render_dashboard`, `validate_baseline`, and the primary panel in
  `detect_correlated_anomalies`) fall back to the one configured connection if there's only
  one, otherwise error out listing the available connection ids — they never guess.
  `render_dashboard` additionally auto-detects the connection from a `url`'s host, the same
  way `get_alert_context` does.
- The two search tools (`find_related_dashboards`, and `detect_correlated_anomalies` when
  auto-discovering candidates) fan out across every configured connection and merge
  results, each tagged with its `connectionId`.

## Product knowledge dashboards

A generic, adopter-defined convention for surfacing institutional knowledge (what a panel
means, known false positives, runbook links, ownership) that lives in your team's heads,
not in Grafana's own data. There are no Joyent- or org-specific assumptions here — any
adopter can publish their own.

**Publishing convention:**

- In a folder alongside your product's dashboards, add one dashboard titled
  `🧠 Timebuddy knowledge` and tagged `timebuddy-knowledge`.
- Add one panel per product, each a Grafana **text panel** (markdown mode) titled
  `timebuddy: <product-key>` (case-insensitive).
- Start that panel's markdown with a single fenced ` ```json ` block holding whatever
  structured data you want tools/agents to read (severity, owner, runbook links, known
  false positives — no fixed schema is enforced); free-form prose below it is for humans
  and is returned too. A missing or malformed JSON block degrades to the raw panel text
  rather than breaking the tool call it's attached to.

**Lookup behavior:**

- `get_alert_context` automatically looks for a knowledge dashboard once it resolves an
  alert to a dashboard, trying (in order) each of that dashboard's own Grafana tags, then
  each of the alert's label values, as the product key — the first one matching a
  `timebuddy: <key>` panel wins. If nothing matches, `get_alert_context`'s output is
  unchanged (no `knowledge` field, no warning, no error) — this is purely additive and
  never a prerequisite.
- `get_product_context` looks up the same convention directly by product key. Pass
  `dashboardUid` to scope the search to that dashboard's folder; omit it to search every
  knowledge dashboard on the connection (returning every match rather than guessing when
  more than one exists, e.g. the same product key defined in both a staging and a prod
  knowledge dashboard).
- Lookup **walks up the folder tree**: if a dashboard's own folder has no knowledge
  dashboard, its parent folder is checked, and so on up to 10 levels, stopping at the
  first match or the top of the tree. A partially-adopted estate (knowledge published in
  some folders but not others) works fine — a miss anywhere in the chain is silent.
- Results are cached per connection (which knowledge dashboard serves a given folder, and
  each knowledge dashboard's parsed panel content, keyed by its own save version) so a
  live investigation doesn't repeat the folder walk or re-parse panels on every call. An
  edit to a knowledge dashboard is picked up as soon as its cached folder-resolution entry
  expires (15 minutes) and its version no longer matches.

## Live resolution of "all" dashboard variables

A dashboard's saved JSON only ever caches the *options* Grafana knew about at save time.
For a **query-type variable** — one whose value list Grafana computes live (e.g. an
InfluxQL `SHOW TAG VALUES` variable) rather than a fixed list — that means a `$__all`
selection with no cached options and no configured `allValue` has nothing to expand to.
The safe default, kept from an earlier real incident, is to fail *open*: substitute the
regex `.*` rather than an empty string, since an empty match silently reports "no data"
over what might be a live outage. But failing open can just as easily produce a
*wrong* answer instead of no answer — `.*` matches every value that datasource has ever
recorded for that field, not the actual (often much smaller) set the dashboard's variable
is scoped to, and there is no way to tell the two apart from the result alone.

`render_dashboard`, `resolve_panel_queries`, `execute_query_window`, and
`detect_correlated_anomalies` (for its primary panel only — see below) now make a
best-effort attempt to resolve this properly instead: when a query-type variable is stuck
at an unresolved `$__all`, and its query text is a `SHOW TAG VALUES` InfluxQL statement,
it's actually executed through the same allowlisted `/api/ds/query` endpoint panel queries
already use, with any other variable references and `$timeFilter` in it substituted
first (so the result is scoped to the same window being investigated). The real value
list replaces the `.*` fallback. `execute_query_window`/`detect_correlated_anomalies`
resolve this once per call using the incident window — not once per baseline/control
window — so a historical comparison window can't end up scoped to a different value list
than the incident it's being compared against.

This only covers the one concrete shape seen in practice; other datasources (e.g. a
Prometheus `label_values(...)` variable, which resolves through a different Grafana API
entirely) or a live lookup that itself fails still fall back to `.*`, exactly as before.
Either way, the variable's name is added to the result's `unresolvedAllVariables` array
(omitted when empty) — treat any panel whose scope depends on a listed variable as
unverified rather than trusting its result or narrowing it down with a naming-convention
guess.

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
against a real instance, run the standalone CLI under the
[MCP inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

`electron/test/mcpServerMode.mjs` covers the distributed app specifically: it spawns the
real Electron binary in `--mcp-server` mode via the actual SDK client/transport and
confirms the `safeStorage` -> engine wiring works end to end (see
[`electron/README.md`](electron/README.md#testing)).

## Known limitations (MVP)

- InfluxQL support covers raw-query-mode targets and does a best-effort reconstruction
  for structured query-builder targets; it doesn't replicate Grafana's full InfluxQL
  query builder.
- The metric index doesn't detect *unused* metrics (ones that exist in a datasource but
  appear in no dashboard) — only the reverse lookup (metric -> dashboards) and dashboards
  pointing at a datasource UID that no longer exists.
- `detect_correlated_anomalies` ranks candidates with a heuristic (z-score magnitude ×
  label overlap × onset-timing proximity), not a statistical correlation/causation test.
- The Electron app isn't code-signed yet. Unsigned builds run fine for local
  testing, but distributing one to other people will hit Gatekeeper (macOS) or
  SmartScreen (Windows) warnings until it's signed with a real developer identity —
  a prerequisite for wider rollout, not something fixable in code.

## Acknowledgments

The `electron/` connection-manager app's UI and auth model are adapted from
[Time Buddy](https://github.com/Liquescent-Development/time-buddy) by Richard Kiene /
Liquescent Development (AGPL-3.0-only, the same license this repository uses). See
[`NOTICE.md`](NOTICE.md) for exactly what was adapted and what was deliberately changed
(credential storage, most notably).
