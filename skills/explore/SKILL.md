---
description: Confirms the timebuddy-incident-investigator MCP server is connected and surveys what Grafana connections and dashboards are available, so someone can get comfortable with it before an incident happens. Use when checking that the Grafana MCP setup works, doing a health check, saying hello, or asking what's available/connected.
---

# Explore

This is the low-stakes, before-an-incident path: confirm the setup actually works, and help the
person get familiar with what's there. Don't wait for something to be broken to be useful — the
point of this skill is building confidence and familiarity ahead of time, since a NOC/on-call
person who has never successfully used this tool won't reach for it under real pressure.

## What to do

1. Call `find_related_dashboards` with no arguments (no `metricName`, no `labels`, no
   `connection`). With no filters it won't return `matches`, but it still builds/reads each
   configured connection's metric index — use `dashboardsScanned` per connection as your real
   connectivity signal. On a large Grafana estate this can take a little while the first time
   (it's crawling every dashboard); say so up front rather than let it look stuck.
2. If that call fails outright (e.g. "No Grafana connections configured"), stop and explain
   plainly: connections are added through the Grafana Connection Manager app (the Electron app
   this MCP server ships as, in its normal GUI mode, not `--mcp-server` mode) — direct them there
   rather than trying to debug it from inside this skill.
3. If it succeeds, summarize in plain language, not raw JSON: how many connections responded and
   roughly how many dashboards each one has. Mention `brokenDatasourcesTotal` per connection if
   it's non-trivial, but don't treat a large count as an incident signal on its own — a sizable
   chunk of it is typically panels whose datasource is a Grafana template variable
   (`${datasource}`, `$some_var`) that this index can't resolve statically, not real breakage.
   `datasourceUid` values that look like plain names rather than variables (no leading `$`) are
   the ones worth a second look.
4. Pick one or two real dashboards from the results and offer to look at one with them —
   `fetch_dashboard` for its panel list, or `resolve_panel_queries`/`execute_query_window` if
   they want to see actual data. The goal is for them to see a real, live result, not just a
   status message.
5. Invite them to try asking about something specific ("ask me to look at any dashboard or
   metric you're curious about") so this feels like a tool they've actually used, not just
   installed.

If any tool result comes back large, read its summary/count fields (every tool here reports
counts like `dashboardsScanned`, `matchesTotal`, `brokenDatasourcesTotal` precisely so you don't
have to) rather than reaching for `jq`/`python3 -c`/shell scripting to page through saved output —
that's a sign to ask for a narrower query (a `metricName`/`labels` filter, a specific
`connection`), not to script around the result.

If multiple connections are configured, mention which ones responded by name/id — this is also a
good moment for someone to notice if a connection they expected isn't there or isn't working, well
before they'd need it during a real incident.
