---
description: Investigates a live or recent Grafana incident using the timebuddy-incident-investigator MCP tools - ingests alert details (a pasted Grafana URL, alert JSON, webhook payload, or just a description), replays the underlying queries over the incident window, checks against baselines, looks for correlated signals, and produces an evidence-linked verdict. Use whenever someone pastes alert/incident details, mentions being paged or on-call, or asks what's going on with a service.
---

# Investigate

Alert details, if any were included when this skill was invoked: $ARGUMENTS

This is the reactive path — something is (or was) firing and someone needs an answer quickly.
Drive the tools below yourself; don't just describe what could be done. The person invoking this
generally won't know the tool names or the right order to call them in — that's exactly what this
skill exists to handle for them.

## Pipeline

1. **Normalize whatever was given.** Call `get_alert_context` with whichever of `url`,
   `alertJson`, or `webhookPayload` matches what was pasted above (a Grafana dashboard/panel/
   alert-rule URL, a raw alert JSON object, or a full Alertmanager webhook body). If nothing
   usable was given, ask for one of those three — a pasted Slack/email alert often has a URL in
   it even if the surrounding text doesn't look like structured data.
   - **Recognize stripped-link pasted alerts and ask, don't guess.** Slack (and some email
     clients) turn a message's hyperlinks into plain anchor text when copied — you'll see link
     *titles* like "Dashboard", "Runbook", "Silence", "Graylog: APIGW 5xx" with no URL anywhere
     near them, alongside real-looking alert labels. This is NOT "truly nothing to paste" — a
     real link exists, it just didn't survive the copy. Say so plainly and ask for it directly
     (e.g. "Slack strips links when copied as plain text — could you grab the Dashboard or alert
     link itself, or the alert's timestamp?") before falling back to step 4's label/description
     search. Guessing the dashboard and time window from labels alone when a precise link was one
     click away wastes several tool calls and turns; asking up front is faster for everyone.
   - Only skip straight to step 4 when the person genuinely has no link and no JSON to give you
     (e.g. they're describing the incident from memory, or pasted a screenshot's text by hand).
   - If the response includes a `knowledge` field, a "Timebuddy knowledge" dashboard published
     product-specific context for this alert (owner, known false positives, runbook links) —
     fold it into your verdict in step 6. Absent means nothing's been published for this alert's
     product, not an error; don't go looking for it yourself (`get_product_context` exists for
     that, but `get_alert_context` already tried).

2. **Note the resolved connection.** The response includes `resolvedConnectionId` when it could
   determine which Grafana connection the alert belongs to. Pass that same id as the `connection`
   parameter on every tool call for the rest of this investigation — don't re-resolve it per call.
   - If `resolvedConnectionId` is missing and `alertContext.warnings` mentions being unable to
     determine the connection, the warning text lists the available connection ids — ask the
     person which environment this is (they usually know, even if the alert link didn't say) and
     use that as `connection` going forward.

3. **Get the primary signal(s).**
   - If you only have `alertContext.dashboardUid` with **no** `panelId` — a bare dashboard link
     (e.g. someone pasted a `/d/:uid?var-...` URL with no `viewPanel`/`panelId` in it) — call
     `render_dashboard` with that same `url` first. It executes every queryable panel on the
     dashboard in one call, using the url's own time window and variable overrides automatically.
     **Don't manually chain `fetch_dashboard` -> guess which panel -> `resolve_panel_queries` as a
     substitute for this** — that's more tool calls to arrive at the same per-panel series
     `render_dashboard` already returns directly. Skim `panels[].series`/`stats` (and `title`) for
     the panel(s) that actually answer the question, then drop into the steps below on just those
     panels for threshold/baseline analysis.
   - **Table and matrix panels can look empty when they aren't.** These are frequently built from
     Grafana transformations (joins, filters, field overrides, computed columns) applied on top of
     the raw query — `execute_query_window`/`render_dashboard` only ever return each query target's
     *raw* series, never the transformed/rendered result the panel actually displays. A raw series
     coming back empty or unremarkable does **not** mean the panel shows nothing; it may just mean
     the transformation that produces the interesting column isn't visible in the raw query alone.
     If you're asked to identify specific rows/cells in a table or matrix (e.g. "which hosts
     failed"), or a table/matrix panel's raw data looks empty or surprising, call `screenshot_panel`
     on it and look at the actual rendered image before concluding there's no data — don't stop at
     raw series alone. **The inline image `screenshot_panel` returns is for you to look at — it is
     not guaranteed to reach the person you're talking to.** Every call also saves the PNG to disk
     and returns its path as `savedTo`; always state that path in your response (e.g. "screenshot
     saved to <path> — open it to see the table") so they have something to actually look at, not
     just your description of what you saw in it.
   - **Check `unresolvedAllVariables` before trusting a panel's scope.** `render_dashboard`,
     `resolve_panel_queries`, `execute_query_window`, and `detect_correlated_anomalies` best-effort
     resolve a `$__all`-selected variable to its real value list, but some datasources/query shapes
     can't be resolved this way and fall back to matching *everything* that datasource has ever
     recorded for that field — silently far broader than what the dashboard/panel actually shows. If
     a variable a panel depends on shows up in `unresolvedAllVariables`, treat that panel's results as
     unscoped: don't apply a naming-convention guess (e.g. matching a hostname prefix) to narrow down
     which rows are actually in scope — screenshot the panel or ask the person directly instead.
   - Once you have a specific `dashboardUid`/`panelId` (from `alertContext`, or picked out of a
     `render_dashboard` survey above):
   - `execute_query_window` with `dashboardUid`, `panelId`, `startsAtMs` (use `alertContext.startsAt`),
     `connection` — this gets you the incident window, a pre-window buffer, and baseline control
     windows in one call. Every series in the response already includes `stats`
     (min/max/mean/count/nonZeroCount) — check that first for quick questions like "was there any
     traffic at all" or "what's the min/max here" instead of writing jq/python over a saved
     tool-output file to compute the same thing yourself, even for a substitute panel you fall back
     to (e.g. because the primary panel errors or times out) — this isn't just for the one panel the
     alert points at. If you know or can guess a meaningful threshold for the metric (e.g. an
     uptime-style series where 1.0 = fully healthy, a known SLO threshold, or 0 for "any activity at
     all" on a volume/count metric), pass `threshold`/`thresholdDirection` in the *same* call — it
     returns each series' precise dip/spike windows (start, end, duration, min/max) directly,
     including whether sibling series in the same panel (other hosts/cells/nodes) show the same dip.
     **Do this instead of fetching raw points and writing jq/python to find dip boundaries
     yourself** — that's exactly what `threshold` is for, and scripting it ad hoc from a saved
     tool-output file is slower and more error-prone mid-incident.
   - `validate_baseline` with the same panel/window to get a real classification
     (`statistically-unusual` vs `common-during-normal-operations`) instead of eyeballing numbers.
     **Always check each series' `briefExcursions` too, even when `classification` says common** —
     that classification is based on the whole window's mean, which can dilute a real, sharp,
     short-lived event (e.g. a health signal fully down for a few minutes inside a much longer
     window) into looking routine. `briefExcursions` is a separate, point-level check against the
     same baseline and will still catch it. Don't just trust a "common" label at face value.

4. **If there's no dashboard/panel link** (warnings said so, or there was nothing to paste in
   step 1), fall back to `find_related_dashboards` using `alertContext.labels` (or whatever labels
   the person gave you) to locate relevant dashboards. If the only thing you have is a product/
   service name in plain language (e.g. "block storage is degraded") rather than an exact metric
   or label value, use `find_related_dashboards`'s `query` param instead — a free-text substring
   match against metric names and dashboard/panel titles. Then proceed as in step 3 once you have
   a candidate panel.

5. **Check blast radius**, once you have a primary panel: `detect_correlated_anomalies` with
   `primaryDashboardUid`/`primaryPanelId`/`startsAtMs`/`primaryLabels`/`connection` — omit
   `candidates` to let it auto-discover across the metric index. This tells you what else moved
   around the same time, which is often the actual answer to "is this real."

   If a panel's queries fail with something like "404 Data source not found," check whether its
   datasource reference is a literal name rather than a UID (not a `$variable` — those are already
   handled). `list_datasources` tells you whether a datasource matching that name still exists
   under a different UID — if it does, that's a real, reportable finding ("this dashboard's
   datasource reference is stale, here's the correct UID"), not a dead end. If nothing close shows
   up, say so plainly rather than retrying — that dashboard needs a Grafana-side fix, not something
   any tool call here can resolve.

6. **Assemble the verdict**: `summarize_findings` with the baseline result, correlated results,
   and an `evidence` array of dashboard/panel links you gathered along the way. Every tool above
   (`get_alert_context`'s `dashboardUrl`, `execute_query_window`/`validate_baseline`'s `url`,
   `detect_correlated_anomalies`'s `primaryUrl` and each correlated result's `url`,
   `find_related_dashboards`'s per-match `url`) already returns a ready-to-click Grafana link at
   the exact panel and time window — use those directly as `evidence[].url`. **Never construct a
   dashboard URL yourself** (e.g. by guessing at `/d/{uid}` or copying a base URL from somewhere
   else) — the tools already know the right connection's base URL and the right query params;
   hand-building one risks pointing at the wrong Grafana instance or a broken link.
   `summarize_findings` returns **structured data only — no prose**. Reading its `reasons` and
   `evidence` fields, write the actual human-readable incident note yourself: what fired, whether
   it's real, why (cite the specific baseline/correlation numbers), and the links you collected so
   the person can click straight through and verify anything you said. This last step is not
   optional — a bare JSON dump back to a NOC person on a live incident is not useful in the flow.
   If you called `screenshot_panel` anywhere above, list each screenshot's `savedTo` path next to
   the panel it came from — it's evidence for "why do you say that," and the file is the only
   reliable way the person actually gets to see it (see step 3 above). If `get_alert_context`
   returned a `knowledge` field (step 1), weave its content into the note (e.g. a known false
   positive, an owning team, a runbook link) rather than leaving it as a separate, unexplained blob.

**Never read this server's cached index/data files directly, even if you can find where they're
stored on disk — always go through the MCP tools above.** Tool output is redacted before it
reaches you; a raw file read isn't. If a tool doesn't seem to cover what you need, that's a sign
to use a different tool/param (`query` for free-text search, `connection` to scope a search), not
to go around the tool layer, especially mid-incident when speed matters and a wrong shortcut is
expensive.
