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
   disambiguate a shared id). Check `transformationsApplied` in the result:
   - `true` means this is the Electron app's own real-browser capture - Grafana's actual on-screen
     data (joins, reduces, renames, whatever the panel has configured). Trust it fully. It's
     re-serialized (RFC 4180) so it can be neutralized for spreadsheets, so it's semantically
     identical to Grafana's Download CSV, not byte-for-byte (see `formulaNeutralizationNote`).
   - `false` means it's this server's own direct export instead: table panels as-is, timeseries/graph
     panels as one UTC-timestamp column plus one column per series. This happens when the panel
     genuinely has no transformations configured (nothing lost - the direct export is exactly as
     correct there), when there's no Electron/screenshotter available, or when the capture attempt
     itself failed - check `transformCaptureNote` for that last case specifically, since a real
     transformation this data doesn't reflect may exist.
   - If the result's `files` array has more than one entry, say so and mention why - the `note` field
     explains it (this only happens in the direct-export fallback: more than one query feeding the
     panel, with no merge applied).
   - **Check each file's `resolution`** (present when the file has a time axis):
     `{points, effectiveBucketMs, spanMs, approximate}`. This is the bucket width of the exported
     series - if it's coarser than the person needs (e.g. 30-min buckets when they want 5-min),
     you can get finer data without chunking the window. For a panel *with* transformations
     (`transformationsApplied: true`), pass `renderWidth` (px): the browser render's resolution is a
     function of viewport width, not the time range, so a wider render yields finer buckets - aim for
     roughly one pixel per point you want (28 days at 5-min ≈ 8064 points → `renderWidth: ~8100`). The
     result echoes the `renderWidth` used and lists any `warnings` (e.g. it was clamped, or it had no
     effect because the direct path was taken - `renderWidth` only steers the browser-render path).
     For the direct path, resolution is governed by the server's `maxDataPoints`, not `renderWidth`.
   - `formulaNeutralized` is always `true`: every file this tool writes has cells beginning with `=`,
     `+`, `-`, or `@` prefixed with an apostrophe, so a spreadsheet displays them instead of executing
     them on open. On the captured path (`transformationsApplied: true`) that's done by re-serializing
     Grafana's output, so the file is not byte-for-byte identical to it; `formulaNeutralizationNote`
     carries that caveat, worth passing along when you point someone at the file.

3. **Also capture a screenshot** when: the person asked for one explicitly, or
   `transformationsApplied` is `false` for a table/matrix panel (i.e. the CSV is this server's raw
   per-query export, not Grafana's own transformed output) - a screenshot is then the only faithful
   view of what's actually displayed, same caveat `/timebuddy:investigate` gives for reading table
   panels. Skip the screenshot when `transformationsApplied` is `true`, or for a plain timeseries/
   graph panel, unless asked - the CSV is already a complete, faithful export in both of those cases.
   Call `screenshot_panel` with the same `url` and `panelId`.

4. **Report every file path plainly** - e.g. "<panel title> data: <csv path(s)>" and, if captured,
   "<panel title> screenshot: <saved path>" - plus the panel's own `url` so they can also open it
   live in Grafana. Don't just say "done"; state exactly where to find what was asked for, since
   that path is the actual deliverable here, not your description of the data.

**Never construct a dashboard/panel URL yourself.** Every tool above (`fetch_dashboard`,
`export_panel_csv`, `screenshot_panel`, `find_related_dashboards`) already returns a URL pointed at
the right connection, panel, and time window - use those directly rather than guessing at one from a
base address, which risks pointing at the wrong Grafana instance or a broken link.
