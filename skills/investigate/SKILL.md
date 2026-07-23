---
description: Investigates a live or recent Grafana incident using the timebuddy-incident-investigator MCP tools - ingests alert details (a pasted Grafana URL, alert JSON, webhook payload, or just a description), replays the underlying queries over the incident window, checks against baselines, looks for correlated signals, pulls corroborating Graylog log evidence when a log connection is configured, and produces an evidence-linked verdict. Use whenever someone pastes alert/incident details, mentions being paged or on-call, or asks what's going on with a service.
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
   - **When the person points at what's firing *right now* rather than pasting one alert** ("look
     at what's firing", "the eu-central-1 alerts", "we're getting paged and I don't have a link"),
     call `list_firing_alerts` first — it reads Grafana's live Alertmanager state and enumerates
     the active alerts. Pass `labelFilters` (e.g. `{"region":"eu-central-1"}` or
     `{"severity":"critical"}`) to narrow a busy estate, and `connection` if they named the
     environment. Each entry comes back in the exact shape `get_alert_context` accepts as
     `alertJson`, so once you've picked the relevant one, hand it straight to
     `get_alert_context({ alertJson: <entry> })` (or pass its `source` link as `url`) — no need to
     make the person go find and paste a link that Grafana already knows about. This is the
     resolution for the common "I directed you at the firing alerts but you couldn't see them"
     gap: there *is* a tool for it; don't ask the person to paste what `list_firing_alerts` can
     list. An empty result (and no `failedConnections`) genuinely means nothing is firing on that
     connection right now — say so rather than assuming you looked in the wrong place.
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
     fold it into your verdict in step 7. Absent means nothing's been published for this alert's
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
   - **On a wide window and/or a dashboard with many panels, pass `includePoints: false`.** Every
     series' `stats` (min/max/mean/count/nonZeroCount) is computed and returned either way — only
     the raw `points` array is dropped. A multi-day, all-panel render with points included routinely
     overflows the tool response to a saved file, forcing a jq/bash detour to recover numbers `stats`
     already had. Re-run the one or two specific panels you actually need points for (screenshot,
     `execute_query_window`'s `threshold`, etc.) once you've picked them out from the compact survey.
   - **Note each panel's own `title` from this response.** You'll want it as `panelTitle` in step 3
     below on any dashboard where panel ids collide (see that step's note).
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
     just your description of what you saw in it. If you need the transformed data *as data* rather
     than a picture (e.g. to cite specific values in your verdict), `export_panel_csv` can capture it
     directly — check its `transformationsApplied` field; `true` means the file is Grafana's own
     transformed output, not just the raw per-query series.
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
   - **Pass `panelTitle` alongside `panelId` on every call below whenever you already know it**
     (from `alertContext.panelURL`'s resolved panel, or a prior `render_dashboard`/`fetch_dashboard`
     call) — don't wait for an ambiguity error to add it. Some dashboards have more than one panel
     sharing an id (a provisioning bug, not Grafana's repeat-panel feature); `execute_query_window`/
     `validate_baseline`/`detect_correlated_anomalies` all reject an ambiguous `panelId` outright
     rather than guessing, listing the candidate titles in the error — but that costs a whole extra
     round trip of retries you can just avoid up front by always passing the title when you have it.
   - Pass `includePoints: false` **on `execute_query_window`** when you're re-confirming something
     `stats`/`runs` already told you and don't need the raw series — same tradeoff as
     `render_dashboard`'s option above, for the same reason. `validate_baseline` has no such
     parameter, and passing it there is silently ignored rather than rejected (zod strips unknown
     keys), so you'd believe you'd asked for a compact response and get the full one — which is the
     response-overflow problem in step 3, not a fix for it. To keep a `validate_baseline` response
     small, narrow the window instead.
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
   - **A query against an InfluxDB-backed panel that times out or aborts is often hitting
     InfluxDB's own hard ~15s query timeout, not a transient fluke** — this server's own default
     request timeout is coincidentally the same ~15s, so a heavy query (a fine-grained `GROUP BY
     time(5s)`-style aggregate over a wide window is the usual culprit) can fail on either side of
     that race. Don't just retry the identical call, and especially don't retry several of them in
     parallel expecting one to get through — that adds load and makes the timeout *more* likely, not
     less. Instead narrow the window, drop to a coarser aggregation, or fall back to a cheaper/
     non-aggregated target for that same series, and prefer calling sequentially over an
     InfluxDB-backed datasource rather than in parallel once you've seen one timeout.
   - `validate_baseline` with the same panel/window to get a real classification
     (`statistically-unusual` vs `common-during-normal-operations`) instead of eyeballing numbers.
     **Always check each series' `briefExcursions` too, even when `classification` says common** —
     that classification is based on the whole window's mean, which can dilute a real, sharp,
     short-lived event (e.g. a health signal fully down for a few minutes inside a much longer
     window) into looking routine. `briefExcursions` is a separate, point-level check against the
     same baseline and will still catch it. Don't just trust a "common" label at face value.
   - **`classification: baseline-all-zero` means there is no baseline to compare against.** Every
     control window was flat zero and the incident window isn't — something that never happened
     is happening. That's real information, but it is *not* a statistical result: `zScore` comes
     back as `null` (there's no meaningful value to report, and JSON has no `NaN`), and no
     number could make the finding statistically strong anyway, because there's no spread to be
     strong relative to. A `null` `zScore` here means "not applicable", not "zero" and not
     "missing data" — that's `insufficient-data`, a different classification.
     Report it as a presence change, cite the actual numbers
     from `incidentStats` (peak, nonzero sample count) rather than any sigma figure, and lean on
     corroboration — did the alert's own threshold cross, did anything correlate — to decide
     whether it matters. Don't describe it as "highly unusual" or similar; you don't know that.
   - **A `runsTotal` or `briefExcursionsTotal` field means the list next to it was truncated.**
     Both appear only when a series produced more than 1000 threshold crossings, and both report
     the real count. Don't read the truncated list as the complete set, and don't reason about
     "the first crossing" from it — a series that noisy is telling you the threshold or the
     window is wrong for it, so re-query a narrower window (or a coarser aggregation) and look
     again rather than summarizing what came back.
   - **A run's `durationMs` is the span between its first and last crossing *sample*, not a
     bucket-aware outage length — don't report it as the exact length.** A dip caught in a single
     sample has `durationMs: 0` (start and end are the same timestamp); that is "one bucket wide,"
     *not* instantaneous or a blip — a one-minute outage on a 60s-resolution series looks exactly
     like this. Every run also understates the real duration by up to one sample interval, because
     the final sample's own bucket isn't counted. Read `durationMs` together with `pointCount` and
     the series' sample spacing (the gap between adjacent points): a `pointCount: 1` run lasted at
     least one interval, and "N samples at ~S apart" is the honest way to describe how long a dip
     persisted.

4. **If there's no dashboard/panel link** (warnings said so, or there was nothing to paste in
   step 1), fall back to `find_related_dashboards` using `alertContext.labels` (or whatever labels
   the person gave you) to locate relevant dashboards. If the only thing you have is a product/
   service name in plain language (e.g. "block storage is degraded") rather than an exact metric
   or label value, use `find_related_dashboards`'s `query` param instead — a free-text substring
   match against metric names and dashboard/panel titles. Then proceed as in step 3 once you have
   a candidate panel.
   - **If `find_related_dashboards` comes back empty for a specific metric/measurement name you
     have independent evidence should exist** (it's named in the alert itself, an error message, or
     a log line — not just a hunch), and the environment is InfluxDB-backed, `discover_influxdb_schema`
     is a last-resort fallback: it queries the datasource's own schema directly rather than only
     what's been dashboarded. Use it only in that specific situation, not as a routine step or a
     first move — pass the exact name as `searchTerm`. `find_related_dashboards` coming back empty
     just means no dashboard visualizes it yet; that's itself worth reporting (a real observability
     gap on the dashboard-owning team's side), separate from whether the metric exists at all.

5. **Check blast radius**, once you have a primary panel: `detect_correlated_anomalies` with
   `primaryDashboardUid`/`primaryPanelId`/`startsAtMs`/`primaryLabels`/`connection` — omit
   `candidates` to let it auto-discover across the metric index. This tells you what else moved
   around the same time, which is often the actual answer to "is this real."

   **Call it once per `scope` tier, narrowest first, and report each tier's result before widening —
   don't just call `all-connections` straight away.** Default (`scope: "product"`) checks the primary
   dashboard plus whatever its own Timebuddy knowledge panel declares as its ops/SLI dashboards and
   dependencies (falls back to just the primary dashboard alone if no knowledge is published for this
   alert — check `productScope.source` to know which happened). Say what that tier found — even
   "nothing correlated within the product" is a real, useful thing to report mid-investigation, not
   just a step to silently pass through. Then look at `nextScope`/`nextScopeCandidateCount` in the
   response: if `nextScopeCandidateCount` is `0`, there's nothing to gain by widening, say so and
   move on. If `nextScopeCandidateCount` is missing instead of a number, it's genuinely unknown (not
   zero) — widening to `scope: "connection"`/`"all-connections"` involves crawling every dashboard on
   a connection the first time (or once its cache goes stale), which this tool only ever does for
   connections the requested scope actually needs, so it won't pay that cost just to answer a count
   you didn't ask for. Otherwise call again with `scope: "connection"`, report that, and only escalate
   to `scope: "all-connections"` — the broadest and most expensive tier — when you still don't have a
   confident answer. Skipping straight to the widest scope costs several times the query volume for
   no benefit when the narrower tier would have already answered it.

   **Finding correlated panels within `product` scope does *not* establish that the blast radius is
   contained — it only tells you the product moved, which you already knew.** "Contained to the
   product", "nothing else in the region was affected", "no other product moved" are all claims about
   the *`connection`* tier (every other dashboard on the same Grafana — i.e. the other products in
   that region/estate), and you cannot make any of them from `product`-scope results alone. This is
   the resolution for the "never checked other products in the region" gap, and it is **not** a
   knowledge-dashboard gap: `connection` scope sweeps the whole region regardless of whether a
   Timebuddy knowledge dashboard is published. It bites hardest when `productScope.source` comes back
   `same-dashboard-only` (no knowledge published for this alert) — there, `product` scope *only ever
   looked at the primary dashboard itself*, so a "clean" or "self-contained" product-scope result has
   quite literally not looked at any other product yet. So **before you assert containment or that the
   blast radius is confined to the product, run `scope: "connection"`** (unless its
   `nextScopeCandidateCount` was `0`, meaning there's nothing else on the connection to check). Report
   what it found — "checked the N other dashboards on the region connection, nothing else moved" is a
   real, earned containment statement; "the same-dashboard panels agreed with each other" is not.
   Don't wait to be asked "what about other products?" — that check is part of establishing blast
   radius, not an optional follow-up. The tool now flags this for you: a `containmentCheckIncomplete: true`
   in the response (with a `containmentHint` naming how many same-connection panels are still unchecked)
   means you are *not* done — re-run with `scope: "connection"` before writing any "contained"/"self-
   contained"/"no other product affected" language into the verdict.

   **This only checks *other dashboards* — it won't catch a primary panel that's a narrow/synthetic
   signal (e.g. a health-check-style series) overstating impact that sibling panels on the *same*
   dashboard would reveal.** Especially for an undirected "find errors"/"what's going on" investigation
   with no specific alert pointing at one exact panel: before asserting severity from a single
   high-deviation panel, check whether the same dashboard has sibling panels measuring the same
   underlying thing at a different, more concrete grain — real traffic/volume, per-account or
   per-method breakdowns, success-rate panels — over the same incident window (`execute_query_window`
   or a quick `render_dashboard` re-check with `includePoints: false` is usually enough). A panel
   reading "0% for 5 hours" next to real traffic that only dipped 4% and was concentrated on one
   account is a materially different, more useful finding than the first panel alone.

   A stat panel using Grafana's built-in "-- Dashboard --" datasource re-displays another panel's
   already-computed value client-side and has no backend to query, so it can never be executed. How
   that reaches you depends on which tool you called, and it matters here because
   `detect_correlated_anomalies` is one of the tools that *throws*:

   - **Reported gracefully** by `render_dashboard` and `resolve_panel_queries`, as `mirrorsPanelIds`
     on the panel — the rest of the dashboard still comes back normally.
   - **Thrown as an error** by `execute_query_window`, `validate_baseline`, `export_panel_csv`, and
     `detect_correlated_anomalies` *when the mirror panel is the one you named*. The message names
     the mirrored panel id(s), so call that panel directly and move on.
   - **Silently omitted** when `detect_correlated_anomalies` hits one among the candidates it
     auto-discovered, rather than as the primary panel. Those run under `Promise.allSettled` and
     rejected candidates are skipped, so the mirror panel is neither returned nor reported — it just
     isn't in the results. Don't read a candidate's absence as evidence it was checked and cleared.

   All three are expected, not failures to investigate. Don't go looking for a misconfiguration and
   don't treat the throw as the dashboard being broken — it's this Grafana feature working as
   designed.

   If a panel's queries fail with something like "404 Data source not found" for any *other*
   reason, check whether its datasource reference is a literal name rather than a UID (not a
   `$variable` — those are already handled). `list_datasources` tells you whether a datasource
   matching that name still exists under a different UID — if it does, that's a real, reportable
   finding ("this dashboard's datasource reference is stale, here's the correct UID"), not a dead
   end. If nothing close shows up, say so plainly rather than retrying — that dashboard needs a
   Grafana-side fix, not something any tool call here can resolve.

6. **Pull corroborating log evidence**, once you have a primary panel and/or some identifiers.
   **This step is not optional and is not conditional on how the metrics looked.** Always run it —
   calling `list_log_sources` is a required part of every investigation, and the *only* clean way to
   skip the rest of the step is an empty `sources` (no Graylog configured). A confident,
   clean-looking metrics verdict is **not** a reason to skip logs — it is exactly when logs pay off
   most. Metrics tell you *that* a signal moved and *where* (which host/orchestrator/cell); logs
   routinely tell you *why*, turning "chronic CM errors on `a2`" into "one specific certificate stuck
   in a non-exportable state." Don't jump from step 5 to step 7 because the numbers already tell a
   tidy story; pull the logs and let them sharpen (or contradict) it first.
   - Call `list_log_sources` with no arguments. If `sources` is empty, no Graylog connections are
     configured — skip the rest of this step silently; that's a normal, common state, not
     something to flag as missing unless asked. Any other outcome means you keep going.
   - **Pick which log connection to use.** If `sources` has exactly one entry, use its `id` as
     `connection` on the calls below — no further resolution needed. If there's more than one,
     pair by tags instead of asking outright: call `list_datasources` with
     `connection: <resolvedConnectionId>` (the Grafana connection from step 2) to get
     `connectionTags[<resolvedConnectionId>]`, then find the log source(s) in `sources` whose own
     `tags` array shares at least one value with it. Exactly one match: use it. Zero or more than
     one match (or no `resolvedConnectionId` to pair from): ask the person which log connection
     covers this environment, listing the candidate names — same "ambiguous is a hard stop, don't
     guess" approach every connection resolution in this server already follows.
   - **Gather identifiers to search on** from what you already have: `alertContext.labels`, the
     `labels` field on any series you pulled in step 3 (`execute_query_window`/`render_dashboard`/
     `detect_correlated_anomalies` all return per-series `labels` — hostnames, instance ids,
     whatever the underlying datasource query tagged each series with), and the labels on any
     correlated result from step 5. Only use identifier values that are actually present in this
     data — don't invent a hostname or guess at one from a naming convention.
     - If your primary panel *aggregates across* hosts (its series carry no host/instance label,
       so nothing above yields one), you can enumerate the real candidate values rather than
       inventing one — how depends on the datasource:
       - **InfluxDB:** call `discover_influxdb_schema` with the measurement as `searchTerm` and the
         host/instance tag as `tagKey`. Its `schema.tagValues` is the actual host/IP list for that
         measurement.
       - **Prometheus or Loki (or InfluxDB too):** call `discover_label_values` with the `metric`
         (the Prometheus metric name / series selector, Loki stream selector, or InfluxDB
         measurement) and the `label` key (e.g. `instance`/`pod`/`host`). Its `values` is the
         actual identifier list — the `label_values(metric, label)` equivalent.
       Either way it's a real, data-derived set you can legitimately scope a log search to (it just
       doesn't by itself say *which* host was hot). Same last-resort framing as step 4: only when
       you'd otherwise have no identifier. If either call returns an *empty* list, don't read that
       as "no hosts" straight away — a mistyped `label`/`tagKey`/`metric` isn't an error to the
       datasource, it just matches nothing, so re-check the name against the panel's own series
       labels (or `discover_influxdb_schema`'s `tagKeys`) before concluding the set is truly empty.
     - To find *which* of those hosts was actually hot (not just the candidate set), re-run the
       aggregating panel broken out per host: call `execute_query_window` with
       `tagBreakout: { key: "<host tag>" }` (the same tag key you enumerated above). It adds a
       `GROUP BY` that tag, so the panel returns one series per host instead of one aggregate —
       read each series' `stats`/`runs` to see which host drove the anomaly, then use that host's
       name as the `search_logs` identifier. To confirm a single suspected host in isolation, pass
       `tagBreakout: { key, value: "web-07" }` to filter to just it. This works on builder-mode
       InfluxQL panels only; a raw-query or Prometheus panel hard-errors (it won't silently return
       the un-broken-out aggregate), so fall back to the candidate-set search above in that case.
   - Call `search_logs` with those identifiers built into Graylog query syntax (e.g.
     `host:web-03 AND level:ERROR`), the same `startsAtMs`/`endsAtMs` as the incident window, and
     the resolved log `connection`. Graylog's own field names for a given identifier aren't
     knowable in advance from this side — if a specific query comes back empty, try a broader one
     (fewer fields, or a bare `*` scoped to the time window) before concluding there's nothing
     there, and say so plainly if it's still empty rather than treating silence as a finding.
   - If that call (or `correlate_logs`, below) fails with a permission error mentioning "no stream
     filter applied" or similar, the connection's Graylog role can search within a stream but not
     across all of them unscoped, and it has no default stream configured — this is a real, common
     lockdown, not a broken connection. Call `list_log_sources` again with
     `connection: <resolvedConnectionId>` to list that connection's streams, pick the one most
     relevant to what you're investigating (or `Default Stream`/`All events`/`All messages` if
     nothing more specific fits), and retry the same call with `streamId` set explicitly rather than
     reporting the connection as broken.
   - If you have a specific join key connecting two log streams (e.g. a `request_id` tying a
     frontend log line to the backend call it triggered), use `correlate_logs` instead of two
     separate `search_logs` calls — one query, one already-joined result set. Its `and`/`or`/
     `unless` operators are documented in the tool description; `unless` is the one worth
     remembering for "which requests on one side never showed up on the other."
     - A `truncated: true` in the result (or any `streams[]` entry with `truncated: true`) means a
       stream hit the per-stream line cap, so the join ran on a partial view — treat the result as
       a floor, not a complete count, and narrow the window/query if the count matters. A truncated
       `unless` right side errors out rather than returning a possibly-inverted answer; narrow and
       retry rather than working around it.
   - **If the log evidence stands on its own — a service, host, or error type that showed up in the
     logs but that you never reached from a Grafana panel** (no primary panel in step 3, or the log
     finding names something the panel you did have doesn't cover) — pivot back to
     `find_related_dashboards` before summarizing, with the identifier pulled from the log line as
     its `query` param (a service/host/error keyword — the same free-text substring match against
     metric names and dashboard/panel titles it does in step 4, just seeded from a log finding
     instead of an alert). A hit gives you a metrics panel that corroborates (or contradicts) the
     log finding, which is stronger evidence than the logs alone and belongs in the verdict the same
     way any other panel would; baseline or blast-radius-check it as in steps 3–5 if the window
     warrants. **Report the empty result explicitly** when nothing matches — "no Grafana dashboard
     visualizes <identifier>" is a real finding (the log signal isn't dashboarded, an observability
     gap worth naming, same as the empty-`find_related_dashboards` case in step 4), and stating it
     keeps a log-only verdict from reading as if you simply forgot to check the metrics side.
   - Whatever `search_logs`/`correlate_logs` returns is one more piece of evidence for step 7's
     verdict, not a separate report — its `url` belongs in `evidence[]` the same way every other
     tool's URL does, and a specific log line or correlated pair worth citing belongs in the
     verdict's prose the same way a baseline number would.
   - **Every log claim you make must be traceable to the exact search that produced it — surface
     that search's own returned `url`, one link per distinct search.** Each `search_logs`/
     `correlate_logs` call returns a `url` that encodes *that call's* query, time window, and
     `streamId` exactly, so it re-runs to the same result set someone else can read. When you cite a
     count, a cert ARN, a host, or an error string, link the `url` of the search that actually
     returned it — **not** the broad `*`/single-bare-term fallback search you used along the way to
     find the right query, and **not** one "representative" link standing in for several searches.
     If several searches back the finding (e.g. one for the incident-window count and one over a
     wider window), include each one's `url` as its own evidence entry so the query and window on
     each link match the specific claim it supports. A verdict that asserts a precise root cause but
     links a vaguer search (or no search) reads as unverifiable even when it's correct — the whole
     point of the link is that the reader can click it and see the same lines you did.
   - **This link discipline applies whenever you report log findings — including when logs are
     pulled reactively, after you've already given a metrics verdict** (someone asks "what did you
     find in Graylog?" and you go search). You're not going back through `summarize_findings` in that
     case, but the same rule holds: name each search's own `url` next to the claim it supports, and
     never hand-build or merge a Graylog URL (see step 7). Don't let a follow-up log dig skip the
     evidence links just because it's outside the one-shot pipeline.

7. **Assemble the verdict**: `summarize_findings` with the baseline result, correlated results,
   and an `evidence` array of dashboard/panel links you gathered along the way. Pass
   `validate_baseline`'s `briefExcursions` through in `baseline` unchanged, not just the top-level
   `classification` — `summarize_findings` now folds that in itself, so it never returns
   `likely-false-positive` while brief excursions are sitting right there unexamined (it returns
   `inconclusive` instead when the window-mean says "common" but excursions say otherwise). This
   used to be entirely on the calling agent to catch by eye, per the `briefExcursions` guidance in
   step 3 above — passing the array through now makes that check real instead of easy to forget.
   Every tool above
   (`get_alert_context`'s `dashboardUrl`, `execute_query_window`/`validate_baseline`'s `url`,
   `detect_correlated_anomalies`'s `primaryUrl` and each correlated result's `url`,
   `find_related_dashboards`'s per-match `url`, `search_logs`/`correlate_logs`'s `url`) already
   returns a ready-to-click link at the exact panel/query and time window — use those directly as
   `evidence[].url`. **Never construct or paraphrase a URL yourself**, for a Grafana dashboard or a
   Graylog search alike (e.g. by guessing at `/d/{uid}`, copying a base URL from somewhere else, or
   combining the query text from two different `search_logs` calls into what looks like a single
   representative link) — the tools already know the right connection's base URL and the right
   query params; hand-building or merging one risks pointing at the wrong instance, a broken query
   string, or a link missing required params (e.g. Graylog's absolute time range) that only the
   tool's own URL builder fills in correctly. If you want to cite more than one `search_logs` call
   in the verdict, include each call's own `url` as a separate `evidence[]` entry rather than
   folding them into one.
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

**If asked to archive, export, or hand off a panel's data** (not just describe it) — for a
postmortem, a report, or further analysis in another tool — use `export_panel_csv` on that panel
rather than pasting numbers by hand. It writes a real CSV file to disk and returns its path; state
that path in your response the same way you would a `screenshot_panel` `savedTo` path. Table panels
export as-is; timeseries/graph panels come out as one UTC-timestamp column plus one column per
series. This is a follow-up action once someone has a specific panel in mind, not a replacement for
`execute_query_window`'s stats/threshold analysis during the investigation itself.

**Never read this server's own persistent, unredacted data store directly** (`metric-index.json`,
`connections.json`, or anything else under its data directory), **even if you can find where it's
stored on disk — always go through the MCP tools above.** That data was never redacted for you to
see; a tool's own return value always is. If a tool doesn't seem to cover what you need, that's a
sign to use a different tool/param (`query` for free-text search, `connection` to scope a search),
not to go around the tool layer, especially mid-incident when speed matters and a wrong shortcut is
expensive.

This is a different thing from a tool response the harness itself saved to a file because it was too
large to return inline (you'll see this for a wide-window `render_dashboard`/`execute_query_window`
call) — that file **is** the same already-redacted output you'd have gotten inline, just spilled to
disk for size reasons. Reading it back, or running `jq`/`grep` over it to pull out specific fields
without loading the whole thing into context, is fine and often the right move for a large survey —
just prefer `includePoints: false` up front (step 3 above) so you don't need the detour in the first
place.
