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
   - If there's truly nothing to paste (no URL, no JSON) — no `get_alert_context` call will
     help; skip to step 4 and search by labels/description instead.

2. **Note the resolved connection.** The response includes `resolvedConnectionId` when it could
   determine which Grafana connection the alert belongs to. Pass that same id as the `connection`
   parameter on every tool call for the rest of this investigation — don't re-resolve it per call.
   - If `resolvedConnectionId` is missing and `alertContext.warnings` mentions being unable to
     determine the connection, the warning text lists the available connection ids — ask the
     person which environment this is (they usually know, even if the alert link didn't say) and
     use that as `connection` going forward.

3. **Replay the primary signal**, if `alertContext.dashboardUid`/`panelId` were resolved:
   - `execute_query_window` with `dashboardUid`, `panelId`, `startsAtMs` (use `alertContext.startsAt`),
     `connection` — this gets you the incident window, a pre-window buffer, and baseline control
     windows in one call. If you know or can guess a meaningful threshold for the metric (e.g. an
     uptime-style series where 1.0 = fully healthy, or a known SLO threshold), pass `threshold`/
     `thresholdDirection` in the *same* call — it returns each series' precise dip/spike windows
     (start, end, duration, min/max) directly, including whether sibling series in the same panel
     (other hosts/cells/nodes) show the same dip. **Do this instead of fetching raw points and
     writing jq/python to find dip boundaries yourself** — that's exactly what `threshold` is for,
     and scripting it ad hoc from a saved tool-output file is slower and more error-prone mid-incident.
   - `validate_baseline` with the same panel/window to get a real classification
     (`statistically-unusual` vs `common-during-normal-operations`) instead of eyeballing numbers.

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

6. **Assemble the verdict**: `summarize_findings` with the baseline result, correlated results,
   and an `evidence` array of dashboard/panel links you gathered along the way.
   `summarize_findings` returns **structured data only — no prose**. Reading its `reasons` and
   `evidence` fields, write the actual human-readable incident note yourself: what fired, whether
   it's real, why (cite the specific baseline/correlation numbers), and links to the
   dashboards/panels involved so the person can verify anything you said. This last step is not
   optional — a bare JSON dump back to a NOC person on a live incident is not useful in the flow.

**Never read this server's cached index/data files directly, even if you can find where they're
stored on disk — always go through the MCP tools above.** Tool output is redacted before it
reaches you; a raw file read isn't. If a tool doesn't seem to cover what you need, that's a sign
to use a different tool/param (`query` for free-text search, `connection` to scope a search), not
to go around the tool layer, especially mid-incident when speed matters and a wrong shortcut is
expensive.
