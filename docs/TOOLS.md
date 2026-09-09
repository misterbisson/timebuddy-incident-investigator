# MCP tools reference

The full behavior of every tool Timebuddy exposes. You rarely call these by name — the
three [skills](../README.md#skills) chain them for you. This page is for
driving them directly (Claude Desktop or another MCP client without skill support), or for
understanding exactly what a call returns.

21 tools total, of which 19 are always registered. Two are conditional: `screenshot_panel` is
only present in the Electron app (it needs a browser to drive), and `execute_adhoc_query` is
only present when a workspace explicitly authorized it with a `--allow-adhoc-queries` launch
flag (see [Ad-hoc queries](../README.md#ad-hoc-queries-off-by-default)) — with no flag anywhere,
the tool list is identical to what it was before that feature existed. Every tool takes an
optional `connection` parameter — see
[Multiple connections](../README.md#multiple-connections).

Every text payload is [redacted](../README.md#security) before it reaches the model, and
every call is audit-logged.

## Ingest & resolve

| Tool | What it does |
| --- | --- |
| `get_alert_context` | Ingest an alert (webhook payload, pasted JSON, or a dashboard/panel/alert-rule URL) and resolve it to dashboard UID, panel ID, labels, threshold, and time range. Also attaches a matching "Timebuddy knowledge" panel when one has been published (see [`BEHAVIOR.md`](BEHAVIOR.md)). When resolved from an alert-rule URL, also returns best-effort `ruleLastModified`/`ruleLastModifiedBy`/`ruleVersion` (Grafana 11.5+ for the latter two) and `ruleProvenance` (`"none"` = hand-edited in the UI) — "was this rule recently touched by a person" during an incident review (#177). |
| `list_firing_alerts` | Enumerate the alerts currently active in Grafana's Alertmanager — the "what's on fire right now" view for when someone points at a live incident without a link to paste. Filter by exact label matches (`labelFilters`) and/or `connection`; each entry comes back in the shape `get_alert_context` accepts as `alertJson`, so a chosen entry pipes straight into an investigation. Read-only — never silences or acknowledges. |
| `get_product_context` | Look up a "Timebuddy knowledge" panel directly by product key, without an alert in hand. |
| `fetch_dashboard` | Fetch a dashboard's metadata, panel list, and template variables — from a dashboard/panel/alert-rule URL (connection auto-detected) or a `dashboardUid`. Useful for finding a panel's id/type from its title before calling another tool. |
| `resolve_panel_queries` | Extract a panel's query targets with variables substituted (using `var-*` overrides from the alert link where available). |

`fetch_dashboard`, `render_dashboard`, `export_panel_csv`, and `screenshot_panel` all accept
a Grafana `/goto/<shortId>` share short-link ("Share → Link → Shorten URL") wherever they
accept a URL — it's resolved to its canonical dashboard/panel link first, transparently, via
the connection's short-URL API; an expired/pruned short-link errors distinctly ("expired or
was not found") from an unrecognized URL shape. None of them accept a folder link
(`/dashboards/f/:uid/...`) — see `list_folder_dashboards` below.

## Query & analyze

| Tool | What it does |
| --- | --- |
| `execute_query_window` | Replay a panel's queries for the incident window, a pre-window buffer, and baseline control windows. Optional `threshold`/`thresholdDirection` returns each series' precise dip/spike run(s) — start, end, duration, min/max — instead of leaving that to be eyeballed. Optional `tagBreakout` re-runs the panel broken out by a tag: `{ key }` adds a `GROUP BY`/`by (...)` for that key (one series per value — surfaces which host is hot when a cross-host aggregate hides it), `{ key, value }` filters to that one value (to isolate a host before feeding it into `search_logs`). Supports builder-mode InfluxQL and PromQL targets (raw-query InfluxQL and Loki/LogQL still hard-error rather than silently returning the un-broken-out query — see [`src/dashboards/tagBreakout.ts`](../src/dashboards/tagBreakout.ts)/[`promqlBreakout.ts`](../src/dashboards/promqlBreakout.ts)); pair with `discover_influxdb_schema`/`discover_label_values` to get the real tag/label keys and values. `includePoints: false` drops raw points (stats/runs still returned) for a wide window that would otherwise overflow. |
| `render_dashboard` | One-shot "what does this dashboard show right now": executes every queryable panel on a dashboard/panel/alert-rule URL (or `dashboardUid`) for a single window — no pre-window buffer, no baseline controls — instead of chaining `fetch_dashboard` → `resolve_panel_queries` → `execute_query_window` per panel. `includePoints: false` gives a compact, stats-only survey. A panel mirroring another via Grafana's "-- Dashboard --" datasource (see [`BEHAVIOR.md`](BEHAVIOR.md)) is reported with `mirrorsPanelIds`, never executed or errored. |
| `validate_baseline` | Z-score classification of the incident window vs. prior-hour/day/week baselines, flagging recurring patterns. |
| `execute_adhoc_query` | *Only registered when authorized — see [Ad-hoc queries](../README.md#ad-hoc-queries-off-by-default).* Run query text **you** wrote against a datasource over an explicit window, rather than replaying a query from a dashboard. Dispatches on datasource type: InfluxQL against `influxdb`, PromQL/MetricsQL against `prometheus`. Returns series plus `provenance: "adhoc"` plus a Grafana Explore URL that re-runs exactly that query (absolute window, so it stays truthful when opened later; recorded in `audit.jsonl` even when the query is refused or fails). Read-only by construction, by a different route per language: InfluxQL is restricted to single-statement `SELECT`/`SHOW` with statement heads allowlisted rather than destructive verbs blocklisted (`SELECT … INTO` refused separately, anything unclassifiable refused), while PromQL has no write form at all and Grafana only reaches its query endpoints — so its guard enforces one expression per call instead. Only datasource types both authorized *and* guardable are reachable; raw SQL is refused regardless. PromQL range queries require an explicit `stepSeconds` and report the step the datasource actually used — see [PromQL step reporting](#promql-step-reporting) below. Subject to the same `MAX_LOOKBACK_HOURS`/`MAX_DATA_POINTS` caps as every other query. Prefer the dashboard path (`find_related_dashboards` → `resolve_panel_queries` → `execute_query_window`) first: a dashboard query encodes aggregation and retention choices a service owner validated, and a hand-written one can look right while being subtly wrong — with one exception, questions about the data's own shape (`count_over_time(metric[1m])` for real scrape density, a MetricsQL-only construct to tell VictoriaMetrics from Prometheus), which no dashboard could have encoded. |
| `summarize_findings` | Deterministic verdict assembly (`real-anomaly` / `likely-false-positive` / `inconclusive`) plus an evidence bundle. It does **not** generate prose — the calling agent writes the human-readable note from this bundle, which is why it returns `reasons`/`evidence` arrays rather than a paragraph. |

## Correlate & discover

| Tool | What it does |
| --- | --- |
| `find_related_dashboards` | Reverse-index lookup: which other dashboards use a given metric or share label values with the alert. Also surfaces `alertBackedDashboards` and `knowledgeDashboards` (with their published product keys) as standing overviews, independent of any search term. |
| `list_folder_dashboards` | List the dashboards and subfolders directly inside a Grafana folder — the MCP counterpart to opening a folder's browse page (`/dashboards/f/:uid/...`). Pass `recursive: true` to flatten every dashboard nested anywhere beneath it into `dashboards` (`subfolders` always stays direct-children-only). Use this when you only have a folder link and need to find the dashboard inside it. |
| `detect_correlated_anomalies` | Rank candidate panels by deviation strength, label overlap, and anomaly-onset timing vs. the primary alert. When auto-discovering, checks one `scope` tier per call — `product` (default: the primary dashboard plus any ops/SLI dashboards and dependencies its Timebuddy knowledge panel declares, or the primary dashboard alone when none is published), then `connection`, then `all-connections` — so a caller can report each tier's result and only pay for a wider search when the narrower one didn't answer. |
| `discover_influxdb_schema` | Query an InfluxDB datasource directly for its own measurement/field/tag schema — not dashboarded data. A last-resort fallback when `find_related_dashboards` finds nothing for a metric you have independent evidence should exist (the index only knows about metrics some panel already visualizes). Requires a `searchTerm`; there's no "list everything" mode by design. When it resolves to one measurement, also pass `tagKey` to enumerate that tag's actual values (`SHOW TAG VALUES`) — the concrete hosts/IPs panels aggregate across, so you can feed a real identifier into `search_logs` instead of inventing one. InfluxDB only, by design (it's an InfluxDB schema catalog); for the same host/IP enumeration on a Prometheus- or Loki-backed panel, use `discover_label_values`. |
| `discover_label_values` | The datasource-agnostic counterpart to `discover_influxdb_schema`'s `tagKey` enumeration: given a `metric` and a `label` key, list that label's actual values, dispatching by datasource type — InfluxDB `SHOW TAG VALUES`, Prometheus `label_values(metric, label)`, Loki's label-values API. Same purpose as the InfluxDB path: surface the concrete hosts/IPs/instances a panel aggregates across so you can feed a real identifier into `search_logs` instead of inventing one — only values returned here are safe to search on. A datasource-level query failure is a hard error, not an empty list. |

## Export & capture

| Tool | What it does |
| --- | --- |
| `export_panel_csv` | Write one panel's data to a CSV file, for archiving/reporting/presentations. See [CSV export behavior](#csv-export-behavior) below. |
| `screenshot_panel` | *Electron app only.* Capture a real screenshot of one panel exactly as Grafana renders it, via a hidden browser window — for seeing a chart's actual shape, or reading a table/matrix panel whose transformed content isn't in any raw query result. Returns the image inline plus a clickable Grafana link, and always saves the PNG to disk (`savedTo`). See [the redaction exceptions](#redaction-exceptions) below. |

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

## PromQL step reporting

`execute_adhoc_query` requires `stepSeconds` on a PromQL range query and refuses to infer one.
The step is not a display preference: every range-vector function (`rate`, `increase`, `delta`,
`*_over_time`) is *defined* in terms of it, so a step chosen for you decides the answer. [Issue
#200](https://github.com/misterbisson/timebuddy-incident-investigator/issues/200) is the full
account of what that costs — a replay at an unrequested 15s step reported ~0.75 errors/minute
from a counter that had been flat for eight days, and several layers of analysis were built on
that number before the step was suspected.

Because a requested step is still only a request — Grafana's Prometheus backend can enlarge one
(its own safe-resolution limit), and an older instance may read a field this client didn't
send — the result reports what the returned timestamps say about it:

```json
"step": { "requestedMs": 60000, "observedGapGcdMs": 15000, "observedMinGapMs": 15000,
          "seriesMeasured": 1, "consistentWithRequested": false,
          "note": "Gaps between returned points share a divisor of 15000ms, which is not a
                   multiple of the requested 60000ms — so the datasource did not evaluate at
                   the requested step. ..." }
```

Note what is *not* reported: an "effective step". The obvious version of this field — the median
gap between timestamps — is confidently wrong on sparse data, in the direction that matters.
Prometheus evaluates a range query on a fixed grid but returns a point only where the range
vector had samples, so a metric emitting a few events an hour comes back as isolated points 15
minutes apart *even when the step was honoured exactly*. A median-gap report would call that a
900000ms step and flag a mismatch, and since [`skills/investigate/SKILL.md`](../skills/investigate/SKILL.md)
tells the agent to reread every number against the reported step, a correct scrape-density
measurement would be read as a 15x error — on the very query this tool is the right first move
for.

What the timestamps license is one inference, in one direction: every gap is an integer multiple
of the step that produced it, so **the step divides the GCD of the gaps**.

- `consistentWithRequested: false` is *proof* of an override — the requested step does not divide
  `observedGapGcdMs`, so the datasource cannot have used it (the #200 case: 15000ms gaps against
  a requested 60000ms).
- `consistentWithRequested: true` is weaker on purpose: the data is consistent with the request,
  and wider spacing is sparsity. A datasource that coarsened 60000ms to 120000ms is
  indistinguishable from a metric that is simply sparse at 60000ms, so the field is named for the
  consistency it can establish rather than a match it can't. When no gap is as tight as the step,
  the `note` says so explicitly — "not evidence of a different step, so read the numbers as they
  are" — because silence there reads like a mismatch.

Both figures are measured across **every** returned series, not the first one with two points (a
response's first series can be a single-point outlier while the rest are dense), and measured
before the response-shaping clamp (`clampSeriesPoints`) strides the emitted points, so they
describe the datasource rather than the clamp. When no series has two distinct timestamps, `step`
says that plainly instead of omitting the field.

`queryType: "instant"` has no step at all: Prometheus evaluates an instant query at a single
timestamp, so the result carries `evaluatedAtMs` (the window end) instead, and passing
`stepSeconds` alongside it is refused rather than ignored. `stepSeconds`/`queryType` against an
InfluxDB datasource are likewise refused — InfluxQL takes its resolution from the query's own
`GROUP BY time(...)`, and accepting a parameter that does nothing is the same trap one level up.

## Redaction exceptions

Two tools' output is only **partly** covered by the redaction layer. Both exceptions exist
because redaction *cannot help* with the value in question, not because it was inconvenient —
and both are enumerated in code (`security/redact.ts`'s `RedactOptions.exempt`) rather than
matched by a naming convention, so adding a third has to be deliberate.

### `screenshot_panel`'s image

Its JSON payload is redacted like every other tool's, but the **image itself is
not** — redaction only understands text, so anything legible on the panel (legend values,
axis labels, annotation text) reaches the model as rendered.

### `execute_adhoc_query`'s `exploreUrl`

The replayable Grafana Explore URL skips the configured customer-identifier patterns (in the
tool result *and* in `audit.jsonl`). Two reasons, and the second is the one that matters:

1. `redactString` rewrites *inside* strings, so a pattern matching something in the query text
   would return a **broken link** rather than a masked one — silently converting the audit
   record for the riskiest tool into a dead URL.
2. It would mask nothing. The model **wrote** that query, so any identifier in the query text
   was already in its context before the URL existed. Redaction's job is stopping identifiers
   from crossing into the model's context; it can't un-cross one.

That reasoning is specific to model-authored query *text*. A dashboard query's *results* come
from Grafana and the model hasn't seen them, which is why series data on the very same response
stays fully redacted — as does `execute_adhoc_query`'s own echoed `query` field. Secret-shaped
keys are still masked even inside an exempt key, since nothing needs an unmasked password to
function.

Note the Explore URL requires **Grafana 10.2+** to open with the query pre-filled: it uses the
`schemaVersion=1&panes={...}` form, and there is deliberately no Grafana version detection in
this client. On an older instance the link opens Explore without the query rather than erroring.
