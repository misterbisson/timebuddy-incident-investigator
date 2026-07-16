# Behavioral reference

Deep-dive notes on a few edge cases in how this project talks to Grafana. Nothing here
is needed to install or run the app — see the root [`README.md`](../README.md) for that.
This is for understanding *why* a tool returned what it did, or for anyone extending the
engine itself (see [`CONTRIBUTING.md`](../CONTRIBUTING.md)).

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
- Both lookups above require already knowing (or guessing) a product key. To discover
  *that* knowledge dashboards exist at all — without a key in hand — `find_related_dashboards`
  also returns `knowledgeDashboards`: every `timebuddy-knowledge`-tagged dashboard found per
  connection, with the product keys each one publishes, as a standing overview independent
  of any search term (the same idea as that tool's `alertBackedDashboards`).

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

## Grafana's "-- Dashboard --" pseudo-datasource

A stat/gauge panel can be configured to re-display another panel's already-computed value
client-side instead of querying anything itself — Grafana calls this the "-- Dashboard --"
datasource. There's no backend behind it, so replaying it through `/api/ds/query` (as every
query-execution tool here does) always 404s with "data source not found" — a recurring,
mechanically-detectable pattern seen across real dashboards, not a misconfiguration. Rather
than surface that 404 (or require fetching the dashboard's raw JSON to explain it, as an
investigation previously had to), `render_dashboard` and `resolve_panel_queries` detect this
case up front and report it as `mirrorsPanelIds` (the panel id(s) it mirrors) instead of an
error — read the referenced panel(s) directly for the real data. `export_panel_csv` does the
same when the Electron browser-capture path is available; otherwise (and always for
`execute_query_window`, `validate_baseline`, and `detect_correlated_anomalies`, which resolve
panels through a different, non-graceful path) a mirror panel surfaces as a thrown error
instead — its message still names the mirrored panel id(s) to call directly.
