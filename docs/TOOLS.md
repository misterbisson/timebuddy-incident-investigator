# MCP tools reference

The full behavior of every tool Timebuddy exposes. You rarely call these by name — the
three [skills](../README.md#skills) chain them for you. This page is for
driving them directly (Claude Desktop or another MCP client without skill support), or for
understanding exactly what a call returns.

17 tools total. 16 are always registered; `screenshot_panel` is only present in the
Electron app (it needs a browser to drive). Every tool takes an optional `connection`
parameter — see [Multiple connections](../README.md#multiple-connections).

Every text payload is [redacted](../README.md#security) before it reaches the model, and
every call is audit-logged.

## Ingest & resolve

| Tool | What it does |
| --- | --- |
| `get_alert_context` | Ingest an alert (webhook payload, pasted JSON, or a dashboard/panel/alert-rule URL) and resolve it to dashboard UID, panel ID, labels, threshold, and time range. Also attaches a matching "Timebuddy knowledge" panel when one has been published (see [`BEHAVIOR.md`](BEHAVIOR.md)). |
| `get_product_context` | Look up a "Timebuddy knowledge" panel directly by product key, without an alert in hand. |
| `fetch_dashboard` | Fetch a dashboard's metadata, panel list, and template variables — from a dashboard/panel/alert-rule URL (connection auto-detected) or a `dashboardUid`. Useful for finding a panel's id/type from its title before calling another tool. |
| `resolve_panel_queries` | Extract a panel's query targets with variables substituted (using `var-*` overrides from the alert link where available). |

## Query & analyze

| Tool | What it does |
| --- | --- |
| `execute_query_window` | Replay a panel's queries for the incident window, a pre-window buffer, and baseline control windows. Optional `threshold`/`thresholdDirection` returns each series' precise dip/spike run(s) — start, end, duration, min/max — instead of leaving that to be eyeballed. `includePoints: false` drops raw points (stats/runs still returned) for a wide window that would otherwise overflow. |
| `render_dashboard` | One-shot "what does this dashboard show right now": executes every queryable panel on a dashboard/panel/alert-rule URL (or `dashboardUid`) for a single window — no pre-window buffer, no baseline controls — instead of chaining `fetch_dashboard` → `resolve_panel_queries` → `execute_query_window` per panel. `includePoints: false` gives a compact, stats-only survey. A panel mirroring another via Grafana's "-- Dashboard --" datasource (see [`BEHAVIOR.md`](BEHAVIOR.md)) is reported with `mirrorsPanelIds`, never executed or errored. |
| `validate_baseline` | Z-score classification of the incident window vs. prior-hour/day/week baselines, flagging recurring patterns. |
| `summarize_findings` | Deterministic verdict assembly (`real-anomaly` / `likely-false-positive` / `inconclusive`) plus an evidence bundle. It does **not** generate prose — the calling agent writes the human-readable note from this bundle, which is why it returns `reasons`/`evidence` arrays rather than a paragraph. |

## Correlate & discover

| Tool | What it does |
| --- | --- |
| `find_related_dashboards` | Reverse-index lookup: which other dashboards use a given metric or share label values with the alert. Also surfaces `alertBackedDashboards` and `knowledgeDashboards` (with their published product keys) as standing overviews, independent of any search term. |
| `detect_correlated_anomalies` | Rank candidate panels by deviation strength, label overlap, and anomaly-onset timing vs. the primary alert. When auto-discovering, checks one `scope` tier per call — `product` (default: the primary dashboard plus any ops/SLI dashboards and dependencies its Timebuddy knowledge panel declares, or the primary dashboard alone when none is published), then `connection`, then `all-connections` — so a caller can report each tier's result and only pay for a wider search when the narrower one didn't answer. |
| `discover_influxdb_schema` | Query an InfluxDB datasource directly for its own measurement/field/tag schema — not dashboarded data. A last-resort fallback when `find_related_dashboards` finds nothing for a metric you have independent evidence should exist (the index only knows about metrics some panel already visualizes). Requires a `searchTerm`; there's no "list everything" mode by design. InfluxDB only, for now. |

## Export & capture

| Tool | What it does |
| --- | --- |
| `export_panel_csv` | Write one panel's data to a CSV file, for archiving/reporting/presentations. See [CSV export behavior](#csv-export-behavior) below. |
| `screenshot_panel` | *Electron app only.* Capture a real screenshot of one panel exactly as Grafana renders it, via a hidden browser window — for seeing a chart's actual shape, or reading a table/matrix panel whose transformed content isn't in any raw query result. Returns the image inline plus a clickable Grafana link, and always saves the PNG to disk (`savedTo`). See [the redaction exception](#screenshot-redaction-exception) below. |

## Logs (Graylog)

| Tool | What it does |
| --- | --- |
| `search_logs` | Search a Graylog connection for log messages in a fixed time window, using Graylog's own query syntax. Use identifiers pulled from a metric investigation (hostname, IP, product string, request/trace id) to narrow the search. |
| `list_log_sources` | List configured Graylog connections (id/name/tags/default stream) — the log-side counterpart to `list_datasources`. Pass `connection` to also list that connection's available streams. |
| `correlate_logs` | Join two or more Graylog searches on a shared field (e.g. a request id) using a PromQL-inspired join query — `and` (inner), `or` (union), `unless` (anti-join). Every stream runs against the same fixed historical window, not a live tail. |

See [Searching logs during an investigation](../README.md#searching-logs) for usage
examples, and [`LOGS.md`](LOGS.md) for the subsystem's design.

## Utility

| Tool | What it does |
| --- | --- |
| `list_datasources` | List a connection's configured datasources (uid/name/type/default) and each connection's `tags` — cross-reference against `list_log_sources`' tags to pair a Grafana connection with the log connection covering the same environment. Also useful for checking whether a panel's literal-name datasource reference still exists under some other UID. |

## CSV export behavior

`export_panel_csv` writes one panel's data to disk. In the Electron app it first tries to
capture the panel's real on-screen data by driving a hidden browser to Grafana's own
Inspect → Data view with "Apply panel transformations" checked (`transformationsApplied:
true` in the result) — so a join/reduce/rename configured on the panel comes back exactly
as shown, not just the raw query result.

Otherwise (no transformations configured, or no Electron/`screenshotter`) it falls back to
a direct export: table panels as-is (every raw column); timeseries/graph panels pivoted
wide (one UTC-timestamp column plus one column per series). A table panel backed by more
than one query/frame is then written to one CSV file per frame, not a merged table.

**Every CSV is neutralized against spreadsheet formula injection.** A cell beginning with
`=`, `+`, `-`, or `@` is executed as a formula when opened in Excel, LibreOffice, or Google
Sheets, so every such cell is prefixed with an apostrophe (it then displays instead of
executing). The direct exports neutralize at the cell level; the Grafana-captured path
neutralizes by re-parsing and re-serializing Grafana's output (a full RFC 4180 round-trip,
since a quoted field can span lines). That makes the captured file *semantically* identical
to Grafana's Download CSV rather than byte-for-byte — quoting minimized, line endings
normalized to CRLF, a leading BOM preserved — reported as `formulaNeutralized: true` with a
`formulaNeutralizationNote`.

The Grafana-side transformation capture depends on the exact visible text/DOM of Grafana's
Inspect drawer rather than a published API, so it's more version-sensitive than the rest of
this project's Grafana integration.

## Screenshot redaction exception

`screenshot_panel` is the one tool whose output is only **partly** covered by the redaction
layer. Its JSON payload is redacted like every other tool's, but the **image itself is
not** — redaction only understands text, so anything legible on the panel (legend values,
axis labels, annotation text) reaches the model as rendered.
