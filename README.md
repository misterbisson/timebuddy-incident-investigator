# Timebuddy Incident Investigator

**Let an AI agent run the first 30 minutes of your incident investigation — read-only,
across your Grafana dashboards, metrics, and Graylog logs.**

Timebuddy is an MCP server. You paste a paged alert into your Claude client; it identifies
what fired, replays the dashboard's real queries over the incident window, compares against
baselines, hunts for correlated signals elsewhere, corroborates with logs, and hands back
an **evidence-linked verdict with clickable links** for a human to act on — not a paragraph
of confident guesses.

**Is it for you?** If you're on call with Grafana dashboards and use Claude Code, Claude
Desktop, or any MCP client — yes. Everything it touches is read-only and redacted (see
[Security](#security)), so it's safe to point at production during an incident.

## What it does

Give it an alert (a link, alert JSON, or webhook payload) and it will:

- **Identify** — resolve the alert to its dashboard, panel, labels, threshold, and window.
- **Replay** — re-run the panel's real queries over the incident window, a pre-incident
  buffer, and historical baselines. No eyeballing raw graphs.
- **Compare** — z-score the incident against prior-hour/day/week baselines, flagging
  recurring patterns and likely false positives.
- **Correlate** — rank other dashboards and panels by deviation, label overlap, and
  anomaly timing to surface what else moved.
- **Corroborate** — pull matching Graylog log evidence using identifiers already in hand
  (host, IP, request/trace id).
- **Report** — a verdict (`real-anomaly` / `likely-false-positive` / `inconclusive`) with
  a clickable link to every piece of evidence.

## Skills

Three bundled Claude Code skills chain the [tools](#mcp-tools) in the right order, so nobody
memorizes tool names or call order — paste an alert link, ask what's connected, or ask to
export a panel, and the right one takes it from there:

| Skill | Use it when | What it does |
| --- | --- | --- |
| `/timebuddy:explore` | Before an incident — a health check, or "what's even connected?" | Confirms the server is connected, surveys connections/dashboards, and flags which are alert-backed (and therefore trustworthy) |
| `/timebuddy:investigate` | Something paged, someone pasted an alert link, or "what's going on with X" | Ingests the alert, replays its queries, checks baselines, finds correlated signals, pulls log evidence, and writes an evidence-linked verdict |
| `/timebuddy:export` | Handing off a panel's data or chart for a report, postmortem, or deck | Resolves the exact panel from a URL and name, writes its data to CSV, and optionally grabs a screenshot |

Not using Claude Code? Any MCP client (Claude Desktop, etc.) calls the tools directly —
same capability, you just drive it yourself. Install the skills from the app in a couple of
clicks; see [Claude Code skills](#claude-code-skills).

## Quick start

One app to install. Each person adds their own Grafana connection (a personal token or
login — no shared admin service account), then registers it with their Claude client. No
separate server process, no env vars to hand-edit, no plaintext credential file anywhere.

1. **Download & install** the latest build for your platform from
   [GitHub Releases](https://github.com/misterbisson/timebuddy-incident-investigator/releases).
   On macOS the first launch hits a Gatekeeper block (the build isn't notarized yet) — see
   the [one-time click-through](#installing-a-downloaded-build-macos) below.
2. **Add a connection** for each Grafana or Graylog endpoint (one per region/tier) — Bearer
   token or Basic auth for Grafana, API token or login for Graylog. Hit **Test connection**,
   then **Save**. See [Configuring connections](#configuring-connections).
3. **Register with Claude.** The app's "Register with Claude" section gives you a
   ready-to-run command (Claude Code) or JSON snippet (Claude Desktop) with this app's path
   already filled in — paste it into your client. An optional block installs the three
   skills above.

Connection changes take effect on the very next tool call — no restart. On macOS, the first
time Claude starts the app as a server, expect a one-time keychain prompt; it's decrypting
your saved credentials, so **Allow** it.

> For local development or CI, the standalone CLI runs on its own with a single connection
> from env vars — see [`CONTRIBUTING.md`](CONTRIBUTING.md#running-the-standalone-cli).

## MCP tools

17 read-only tools, grouped by what they're for. You rarely call them by name — the skills
above chain them. **See [`docs/TOOLS.md`](docs/TOOLS.md) for the full reference.**

| Group | Tools |
| --- | --- |
| **Ingest & resolve** | `get_alert_context`, `get_product_context`, `fetch_dashboard`, `resolve_panel_queries` |
| **Query & analyze** | `execute_query_window`, `render_dashboard`, `validate_baseline`, `summarize_findings` |
| **Correlate & discover** | `find_related_dashboards`, `detect_correlated_anomalies`, `discover_influxdb_schema`, `discover_label_values` |
| **Export & capture** | `export_panel_csv`, `screenshot_panel` *(Electron app only)* |
| **Logs** | `search_logs`, `list_log_sources`, `correlate_logs` |
| **Utility** | `list_datasources` |

## Installing a downloaded build (macOS)

The macOS build is signed with a self-signed certificate, not a real Apple Developer ID
(see [`electron/CONTRIBUTING.md`](electron/CONTRIBUTING.md#building-signing-and-releasing)),
so Gatekeeper blocks it as unverified on first launch. On Sequoia and later the old
"right-click → Open" bypass no longer works — it has to be allowed from System Settings.
This is a one-time click-through per downloaded build.

Fastest path — clear the quarantine flag from the terminal, then open the app normally:

```bash
xattr -d com.apple.quarantine "/Applications/Timebuddy Incident Investigator.app"
```

<details>
<summary>Prefer clicking through the dialogs? Step-by-step with screenshots.</summary>

1. Open the `.dmg` and drag `Timebuddy Incident Investigator.app` into **Applications**.

   <img src="docs/images/macos-install-1-drag-to-applications.png" width="500" alt="Drag the app into the Applications folder">

2. Double-click the app. macOS refuses to open it — click **Done** (not "Move to Trash").

   <img src="docs/images/macos-install-2-not-opened.png" width="380" alt="“Timebuddy Incident Investigator.app” Not Opened">

3. Open **System Settings → Privacy & Security**, scroll to **Security**, and click **Open
   Anyway** next to the app's entry.

   <img src="docs/images/macos-install-3-privacy-security-open-anyway.png" width="360" alt="Privacy & Security showing the blocked app with an Open Anyway button">

4. Confirm **Open Anyway** in the dialog, then authenticate with Touch ID or your password.

   <img src="docs/images/macos-install-4-confirm-open-anyway.png" width="360" alt="Open “Timebuddy Incident Investigator.app”? confirmation dialog">

</details>

The app opens normally afterward and won't be re-blocked — until a rebuilt or re-downloaded
`.app` is quarantined again and needs it repeated.

## Configuring connections

Add a connection for each Grafana or Graylog endpoint you use. Each person authenticates as
themselves — their own token or login — rather than everyone sharing one admin-provisioned
service-account credential.

1. Click **Add connection**, pick a **kind** (Grafana or Graylog), and fill in a name, URL,
   and credentials. Grafana takes a Bearer token or Basic auth; Graylog takes an **API
   token** or Basic auth — note the API token is sent as HTTP Basic with the token as the
   *username*, per Graylog's own convention, not a Bearer header. Either kind can carry
   optional **tags** (e.g. `prod`, `us-east`) that a skill uses to pair a Graylog connection
   with the right Grafana one. `kind` is fixed once saved.

   <img src="docs/images/connections-1-add-modal.png" width="400" alt="Add connection form">

2. Click **Test connection** before saving — it catches a wrong URL, bad credential, or
   unreachable instance now instead of partway through an investigation later.

3. Click **Save**. Repeat for every endpoint; they all show up in one list, each
   editable/duplicable/deletable at any time.

   <img src="docs/images/connections-2-list-redacted.png" width="700" alt="Configured connections list">

Adding, editing, or removing a connection takes effect on the very next tool call — no
restart. (Restarting the GUI window does nothing here; it's a separate process from the one
your Claude client is talking to.)

### How connections are stored

Connections live under Electron's per-OS `userData` directory, in two files written
atomically (temp file + rename, so an interrupted write can't truncate either):

- `connections.json` — non-secret metadata (name, URL, auth type, kind, tags), plaintext.
- `secrets.enc.json` — every token/password, `safeStorage`-encrypted via the OS keychain
  (macOS Keychain, Windows DPAPI, libsecret on Linux). Decrypted only in-memory, only inside
  the `--mcp-server` process, only when building a client — never written back to disk.

If a row shows **"Can't decrypt secret"**, the credential is still there but this machine's
keychain can no longer open it — usually after an OS reinstall, keychain reset, or machine
migration. Edit that connection and re-enter its token/password to fix it; only that one
connection is affected.

## Registering with Claude

The app's "Register with Claude" section shows a ready-to-run
`claude mcp add --scope user` command (Claude Code) and a ready-to-paste `mcpServers` JSON
snippet (Claude Desktop), both pointing at this app's executable with `--mcp-server`.
`--scope user` registers it once for the whole machine rather than a single project
directory, since this is one desktop app usable from anywhere.

<img src="docs/images/connections-3-register-with-claude-redacted.png" width="700" alt="Register with Claude section">

A third optional block installs the bundled Claude Code skills — two `claude plugin`
commands (the app fills in the first command's path for you):

```bash
claude plugin marketplace add "/Applications/Timebuddy Incident Investigator.app/Contents/Resources/plugin" --scope user
claude plugin install timebuddy@timebuddy-incident-investigator --scope user
```

Skills show up immediately, no restart; only the MCP server itself needs a client restart to
reconnect.

**macOS keychain prompt:** the *first* time Claude actually starts the app as an MCP server
(which can be well after you register it — not until your client's next session), macOS
prompts for keychain access to decrypt your saved credentials. This is expected — **Allow**
(or **Always Allow**). It's this app's own `safeStorage` secrets being decrypted (see [How
connections are stored](#how-connections-are-stored)), nothing else.

<img src="docs/images/macos-keychain-access.png" width="480" alt="macOS keychain access prompt">

## Claude Code skills

The three skills ship as a Claude Code plugin (`.claude-plugin/plugin.json`) bundled with
the app, so the easiest install is the "Claude Code skills (optional)" block in [Registering
with Claude](#registering-with-claude) above — no GitHub access, pinned to your installed app
version.

Prefer installing from GitHub instead (no desktop app, or you want plugin updates independent
of the app's release cadence)? The same plugin is a normal Claude Code marketplace:

```
/plugin marketplace add misterbisson/timebuddy-incident-investigator
/plugin install timebuddy@timebuddy-incident-investigator
```

Either way, skills appear under the `/timebuddy:` namespace — `explore`, `investigate`, and
`export`, described in [Skills](#skills) above. See the runbooks each one follows:
[`explore`](skills/explore/SKILL.md), [`investigate`](skills/investigate/SKILL.md),
[`export`](skills/export/SKILL.md).

## Activity window

Once Claude has started the app as your MCP server, a companion **Timebuddy Activity**
window appears the moment Claude pulls data from its first panel or runs its first log
search — a live, clickable log of what's being inspected. Each entry is one Grafana panel
Claude actually queried or screenshotted, or one Graylog search (`search_logs`/
`correlate_logs`) it ran, tagged **panel** or **logs** so the two read distinctly. Clicking a
**panel** entry shows either the saved screenshot or a live, authenticated view of the real
Grafana panel embedded in the window. A panel served from a connection's `matchHosts` alias
authenticates here too, but only over that connection's own scheme — an `https` connection's
credentials are never sent to the alias over plaintext `http`.

Each **panel** entry also has **Export CSV** and **Capture screenshot** buttons — the same
export/capture the `export_panel_csv` and `screenshot_panel` tools do (same window,
variables, formula-injection neutralization, and redaction), saved straight to your
**Downloads** folder. A **logs** entry instead shows a short text summary of the search —
query, stream, result count, and tool — plus an **Open in Graylog** button that opens the
recorded search in your browser; it doesn't embed the Graylog UI (a log search isn't a single
visual), and the panel-only export/screenshot buttons stay hidden. The log is in-memory only
and clears when the server restarts; nothing is written to disk.

## Multiple connections

Every tool takes an optional `connection` parameter (a connection id). When it's omitted:

- **`get_alert_context`** auto-detects the connection by matching the alert's URL against
  each configured connection's `url` (or its `matchHosts` aliases), and returns
  `resolvedConnectionId` to pass into every subsequent call for that incident.
- **Single-target tools** (`resolve_panel_queries`, `execute_query_window`,
  `validate_baseline`, `get_product_context`, and the primary panel of
  `detect_correlated_anomalies`) fall back to the sole configured connection, otherwise error
  out listing the available ids — they never guess. `fetch_dashboard`, `render_dashboard`,
  `export_panel_csv`, and `screenshot_panel` additionally auto-detect from a URL's host first.
- **Fan-out tools** (`find_related_dashboards`, `list_datasources`, and
  `detect_correlated_anomalies` when auto-discovering) query every connection and merge
  results, each tagged with its `connectionId`. Passing `connection` narrows them to one.

The single-connection fallback only applies when nothing contradicts it: a URL whose host
matches no configured connection is an error listing the available ids — even with exactly
one connection configured — rather than silently investigating a different Grafana than the
link points at. Add the host to that connection's `matchHosts` if it's an alias.

See [`docs/BEHAVIOR.md`](docs/BEHAVIOR.md) for a few Grafana edge cases: the
product-knowledge-dashboard convention for publishing institutional knowledge (what a panel
means, known false positives, runbook links), live resolution of "all" dashboard variables,
and Grafana's "-- Dashboard --" pseudo-datasource panels.

## Searching logs

Add a Graylog connection (see [Configuring connections](#configuring-connections)) and
`/timebuddy:investigate` pulls corroborating log evidence automatically — it pairs the right
log source to the dashboard by shared `tags`, builds a query from identifiers already in hand
(hostname, IP, product string, request/trace id), and folds what it finds into the verdict.

To drive the log tools directly (Claude Desktop, or an ad-hoc question):

- **`search_logs`** takes a Graylog query and a time window. Use identifiers a metric
  investigation surfaced, not a bare wildcard:

  ```
  search_logs(query: "source:api-gw-* AND level:ERROR", startsAtMs: <incident start>)
  ```

  It returns each matching message plus a clickable Graylog URL, and defaults the window end
  to now. A search that hits the per-stream line cap (`MAX_LOG_LINES`, default 500) is flagged
  so you know you're seeing a partial view.

- **`correlate_logs`** joins two or more streams on a shared field. The classic use is
  tracing one request across services by a shared id:

  ```
  correlate_logs(
    query: "graylog(service:frontend) and on(request_id) graylog(service:backend)",
    startsAtMs: <incident start>
  )
  ```

  `and` is an inner join, `or` a union, `unless` a left-anti-join ("which frontend requests
  never reached the backend"). Every stream uses the one window you pass — the `[5m]` the
  grammar allows has no effect. Safety behavior: an `unless` whose subtracted side got
  truncated at the line cap **errors out** rather than return a possibly-inverted answer.

- **`list_log_sources`** lists your Graylog connections (and, given a `connection`, its
  streams) — cross-reference its `tags` against `list_datasources` to see which log source
  covers the same environment as a Grafana connection.

Only Graylog's legacy (2.x–5.x) search API is supported — see [Known
limitations](#known-limitations-mvp). Design rationale: [`docs/LOGS.md`](docs/LOGS.md).

## Security

- The Grafana and Graylog clients are **fixed allowlists of read-only endpoints**. There is
  no "make an arbitrary request" tool — nothing built on top can reach a mutating endpoint,
  even if asked to.
- `security/limits.ts` caps query time-range span, max data points, and concurrent outgoing
  requests.
- `security/redact.ts` masks secret-shaped fields and configured customer-identifier
  patterns before any data returns to the model. (The one gap: `screenshot_panel`'s rendered
  image — see [`docs/TOOLS.md`](docs/TOOLS.md#screenshot-redaction-exception).)
- `security/audit.ts` appends every tool invocation to a local JSONL audit log.
- A per-user token or login carries whatever Grafana role that person actually has — it drops
  the "Viewer-role service account" defense-in-depth a shared token gave you, so the read-only
  guarantee then rests entirely on the client allowlist. A Viewer-scoped service-account token
  is still the safer choice for a shared/CI connection.

## Local data and disk usage

Everything this server writes lands under `DATA_DIR` (default `.data` for the CLI; the packaged
app uses Electron's per-OS `userData` directory). Two paths grow with use and are bounded
automatically by a best-effort sweep that runs once at server startup (never blocking startup):

- **`screenshots/`** — one PNG per `screenshot_panel` call. The highest-volume path. Any PNG
  older than `SCREENSHOT_RETENTION_HOURS` (default `168` / 7 days) is deleted on startup; set
  `0` to keep everything.
- **`audit.jsonl`** — the record backing the read-only guarantee, so it's **rotated, not
  truncated**. Past `AUDIT_MAX_BYTES` (default ~5 MB) it rolls to `audit.jsonl.1`, keeping up
  to `AUDIT_KEEP_FILES` (default `5`) generations. Set `AUDIT_MAX_BYTES=0` to disable rotation.

The metric-index cache (`metric-index.json`) is overwritten in place, not appended. The webhook
alert store `alerts.jsonl` is deliberately **not** swept (see below).

## Receiving alerts by webhook

Optional. Point a Grafana webhook contact point at this listener, and `get_alert_context` with
no arguments picks up the most recent alert it received:

```bash
npm run webhook     # listens on 127.0.0.1:4318, appends to $DATA_DIR/alerts.jsonl
```

It accepts only `POST /` with a Grafana Alertmanager body, never contacts Grafana, and has no
other routes. **It binds loopback by default, which assumes Grafana runs on the same host.** If
it doesn't, widen the bind *and set a shared secret at the same time*:

```bash
WEBHOOK_BIND_ADDRESS=0.0.0.0
WEBHOOK_TOKEN=<a long random string>
```

With `WEBHOOK_TOKEN` set, every request must carry `Authorization: Bearer <token>` — configure
the same value on the Grafana contact point. Binding wide *without* a token logs a startup
warning: anything posted to this port becomes the incident `get_alert_context` hands to the
agent, so an unauthenticated open port is a way to feed the agent attacker-chosen content, not
just a way to fill a disk. That's also why `alerts.jsonl` is left out of the startup sweep —
better bounded by keeping the port loopback-and-authenticated than by a blanket sweep that
would race the listener's own appends.

## Known limitations (MVP)

- **InfluxQL:** covers raw-query-mode targets and a best-effort reconstruction of structured
  query-builder targets; it doesn't replicate Grafana's full InfluxQL query builder.
- **Metric index:** doesn't detect *unused* metrics (ones in a datasource but on no dashboard)
  — only the reverse lookup (metric → dashboards) and dashboards pointing at a now-missing
  datasource UID. Extraction is a best-effort regex scan, not a full parser.
- **`detect_correlated_anomalies`** ranks candidates with a heuristic (z-score magnitude ×
  label overlap × onset-timing proximity), not a statistical correlation/causation test.
- **Not notarized yet:** downloaded builds hit a Gatekeeper block on macOS (see
  [above](#installing-a-downloaded-build-macos)) or SmartScreen warnings on Windows until
  signed with a real developer identity — a prerequisite for wider rollout, not a code fix.
- **`export_panel_csv`'s Grafana-side transformation capture** is Electron-only and depends on
  Grafana's Inspect-drawer DOM rather than a published API, so it's more version-sensitive than
  the rest of the integration. See [`docs/TOOLS.md`](docs/TOOLS.md#csv-export-behavior).
- **Logs:** only Graylog's legacy (2.x–5.x) Universal Search API — 6.x's Views API returns CSV
  and isn't implemented. `correlate_logs` covers `and`/`or`/`unless` with a single join key
  across 3+ streams; cross-field label-mapping joins and `group_left()`/`group_right()` grouping
  exist in the underlying library but aren't exercised by this project's tests yet.
- **Graylog search permissions:** a token that can *list* streams can't necessarily *search*
  across all of them. `search_logs`/`correlate_logs` scope to one stream (via
  `filter=streams:<id>`) whenever a `streamId` is available — from the call or a connection's
  default — but a connection with no default stream can 403 on any call that omits an explicit
  `streamId`, even though `/api/streams` succeeds for the same token. The app's "Test
  connection" button probes this directly; if it flags it, set a default stream or always pass
  `streamId`.

## Acknowledgments

The `electron/` connection-manager app's UI and auth model are adapted from
[Time Buddy](https://github.com/Liquescent-Development/time-buddy) by Richard Kiene /
Liquescent Development (AGPL-3.0-only, the same license this repo uses). `correlate_logs` is
built on `@liquescent/log-correlator-core`/`-query-parser`, also by Richard Kiene / Liquescent
Development (AGPL-3.0-only). See [`NOTICE.md`](NOTICE.md) for exactly what was adapted or used
and what was deliberately changed (credential storage, most notably).
