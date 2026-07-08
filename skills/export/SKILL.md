---
description: Exports a dashboard panel's data as a CSV file, and optionally a screenshot, given a dashboard/panel URL (its own embedded time range is used automatically) and a panel name or a direct panel link. Use when someone asks to export, download, save, or archive a panel's data or chart - for a report, a presentation, or further analysis elsewhere.
---

# Export

This is invoked directly with a URL and/or a panel name - usually something like "export the CPU
panel from this dashboard as CSV" or "download the data behind this link." Drive the tools below
yourself; don't just describe what could be done.

## What to do

1. **Figure out which panel is being asked for.**
   - If the URL already points at one specific panel (it has `viewPanel=<id>` in it - the link you
     get from "View" on a panel, or from another tool's own `url` field), skip straight to step 2
     with that url as-is; there's nothing to resolve.
   - If it's a whole-dashboard URL (no `viewPanel`) and a panel name/description was given (e.g.
     "the CPU cores panel", "the host connectivity table"), call `fetch_dashboard` with that same
     `url` - it auto-detects the connection from the url's host and returns every panel's id/title/
     type. Match the requested panel by title (a case-insensitive substring match is fine). If more
     than one panel plausibly matches, list the candidates and ask which one rather than guessing -
     exporting the wrong panel's data is a worse outcome than one extra question.
   - If no url was given at all, or the named panel can't be found on the dashboard, fall back to
     `find_related_dashboards`'s `query` param (a free-text search over metric/dashboard/panel
     titles) the same way `/timebuddy:explore` does, to help locate it first.

2. **Export the data.** Call `export_panel_csv` with the same `url` - its own embedded time range
   (`from`/`to`) is used automatically, so only pass `fromMs`/`toMs` if the person wants a different
   window than what's in the link - plus `panelId` (and `panelTitle`, if step 1 needed it to
   disambiguate a shared id). Table panels are exported as-is; timeseries/graph panels come out as
   one UTC-timestamp column plus one column per series. If the result's `files` array has more than
   one entry, say so and mention why - the `note` field explains it (usually more than one query
   feeding the panel, with Grafana's own join/transform between them not replicated here).

3. **Also capture a screenshot** when: the person asked for one explicitly, or the panel is a
   table/matrix type. Table/matrix panels are frequently built from Grafana transformations (joins,
   computed columns) applied on top of the raw query - the CSV `export_panel_csv` writes is that raw
   query result, not necessarily the merged table shown on screen (same caveat `/timebuddy:investigate`
   gives for reading table panels), so a screenshot is often the only faithful view of what's actually
   displayed. For a plain timeseries/graph panel, skip the screenshot unless asked - the CSV there is
   already a complete, faithful export. Call `screenshot_panel` with the same `url` and `panelId`.

4. **Report every file path plainly** - e.g. "<panel title> data: <csv path(s)>" and, if captured,
   "<panel title> screenshot: <saved path>" - plus the panel's own `url` so they can also open it
   live in Grafana. Don't just say "done"; state exactly where to find what was asked for, since
   that path is the actual deliverable here, not your description of the data.

**Never construct a dashboard/panel URL yourself.** Every tool above (`fetch_dashboard`,
`export_panel_csv`, `screenshot_panel`, `find_related_dashboards`) already returns a URL pointed at
the right connection, panel, and time window - use those directly rather than guessing at one from a
base address, which risks pointing at the wrong Grafana instance or a broken link.
