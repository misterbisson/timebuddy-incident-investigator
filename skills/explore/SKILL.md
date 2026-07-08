---
description: Confirms the timebuddy-incident-investigator MCP server is connected and surveys what Grafana and log (Graylog) connections and dashboards are available, so someone can get comfortable with it before an incident happens. Use when checking that the MCP setup works, doing a health check, saying hello, or asking what's available/connected.
---

# Explore

This is the low-stakes, before-an-incident path: confirm the setup actually works, and help the
person get familiar with what's there. Don't wait for something to be broken to be useful — the
point of this skill is building confidence and familiarity ahead of time, since a NOC/on-call
person who has never successfully used this tool won't reach for it under real pressure.

## What to do

1. Call `find_related_dashboards` with no arguments (no `metricName`, no `labels`, no `query`, no
   `connection`). With no filters it won't return `matches`, but it still builds/reads each
   configured connection's metric index — use `dashboardsScanned` per connection as your real
   connectivity signal, and `alertBackedDashboards`/`alertBackedTotal` (also returned regardless
   of filters) as your "what's known to matter" signal, covered in the next step. On a large
   Grafana estate this can take a little while the first time (it's crawling every dashboard and
   every alert rule); say so up front rather than let it look stuck.
2. If that call fails outright (e.g. "No Grafana connections configured"), stop and explain
   plainly: connections are added through the Grafana Connection Manager app (the Electron app
   this MCP server ships as, in its normal GUI mode, not `--mcp-server` mode) — direct them there
   rather than trying to debug it from inside this skill.
3. Also call `list_log_sources` with no arguments — the same kind of survey as step 1, for log
   connections (Graylog) instead of Grafana. An empty `sources` list is a normal, unremarkable
   state (log investigation is optional), not a problem to report as broken. If any are
   configured, mention them by name/id the same way you'll mention Grafana connections in the
   next step, and note any connection whose `tags` overlap a Grafana connection's `connectionTags`
   (from `list_datasources`) — that overlap is what lets a real incident investigation pair the
   two automatically later, so it's worth surfacing now if it's missing (e.g. "your Grafana prod
   connection and Graylog connection don't share a tag yet, so an investigation would have to ask
   which log source to use").
4. If it succeeds, summarize in plain language, not raw JSON: how many connections responded and
   roughly how many dashboards each one has.
5. **Lead with `alertBackedDashboards`, not a raw dashboard count.** A dashboard/panel search can
   turn up plenty of results that merely match a name or metric — some real, some test/scratch/
   deprecated decoys, and there's no reliable way to tell those apart from titles alone.
   `alertBackedDashboards` is different: every entry there has a real Grafana alert rule wired to
   it (via its `__dashboardUid__`/`__panelId__` annotations), which is the strongest signal this
   tool has for "this is actually relied on." Walk through a handful of these by name — this is
   the single most useful thing to come out of an explore session, since it's the shortlist worth
   trusting during a real incident. A dashboard *not* appearing here isn't necessarily bad, it's
   just unverified by this particular signal (its alert rule might not be dashboard-linked, or it
   might genuinely have no alert wired to it yet).
   - **If `alertBackedTotal` is 0 or surprisingly low, check `alertRuleAccessErrors` before
     concluding this Grafana estate just has no alerts wired up that way.** It's only present for
     a connection when the alert-rule crawl itself failed (e.g. a permission-scoped token) — that
     looks identical to "genuinely zero alerts" unless you check it, and 0 across a large estate
     (hundreds/thousands of dashboards) is unusual enough to be worth verifying rather than assuming.
6. Mention `brokenDatasourcesTotal` per connection if it's non-trivial, but don't treat a large
   count as an incident signal on its own — a sizable chunk of it is typically panels whose
   datasource is a Grafana template variable (`${datasource}`, `$some_var`) that this index can't
   resolve statically, not real breakage. `datasourceUid` values that look like plain names rather
   than variables (no leading `$`) are the ones worth a second look. Also check
   `brokenDatasourcesUniqueCount` before reacting to a big total — `brokenDatasourcesTotal` counts
   panel *references*, and a handful of retired datasources can each be referenced by hundreds or
   thousands of old panels, so a total in the tens of thousands is often really "a few datasources
   need cleanup," not thousands of distinct problems.
7. Pick one or two dashboards from `alertBackedDashboards` and offer to look at one with them —
   `fetch_dashboard` for its panel list, or `resolve_panel_queries`/`execute_query_window` if
   they want to see actual data. The goal is for them to see a real, live, *trustworthy* result,
   not just a status message. If a log connection was configured in step 3, offer the same for it:
   `search_logs` for a recent, narrow window is a fine way to show a real result without needing
   an actual incident.
8. Invite them to try asking about something specific ("ask me to look at any dashboard or
   metric you're curious about") so this feels like a tool they've actually used, not just
   installed. If they name a product/service in plain language (e.g. "block storage") rather
   than an exact metric or label, use `find_related_dashboards`'s `query` param — it does a
   free-text substring match against metric names and dashboard/panel titles, which is exactly
   for this case. Matches that are themselves alert-backed sort first in the results.

Every dashboard/panel or log search you mention — in `alertBackedDashboards`, `matches`,
`search_logs`/`correlate_logs` results, or anywhere else — comes with a ready-to-click `url`
field already pointing at the right connection. Include it whenever you name one, so "here's
what's trustworthy" is something they can actually click through to, not just a list of names and
UIDs. Don't construct a URL yourself from a connection's base address — use the one the tool
already gives you.

**Never read this server's cached index/data files directly, even if you can find where they're
stored on disk (e.g. by searching for "metric-index" under Application Support or similar) —
always go through the MCP tools instead.** This isn't just about avoiding shell-command
permission prompts: this server's whole design is that tool output is redacted before it reaches
you, and a raw file read skips that entirely. If a tool doesn't seem to support what you're
trying to do (e.g. no free-text search), that's a sign to use a different tool/param — like
`query` above — not to go around the tool layer.

If any tool result comes back large, read its summary/count fields (every tool here reports
counts like `dashboardsScanned`, `matchesTotal`, `brokenDatasourcesTotal` precisely so you don't
have to) rather than reaching for `jq`/`python3 -c`/shell scripting to page through saved output —
that's a sign to ask for a narrower query (a `metricName`/`labels`/`query` filter, a specific
`connection`), not to script around the result.

If multiple connections are configured, mention which ones responded by name/id — this is also a
good moment for someone to notice if a connection they expected isn't there or isn't working, well
before they'd need it during a real incident.
