# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run build       # tsc -> dist/
npm run dev          # run src/index.ts directly via tsx (no build step)
npm run typecheck    # tsc --noEmit
npm test             # vitest run (all unit tests, fixture-based, no live Grafana needed)
npx vitest run test/baseline.test.ts   # run a single test file
npm run webhook       # start the standalone webhook listener (src/webhook/listener.ts)
```

`GRAFANA_URL`/`GRAFANA_TOKEN` (see `.env.example`) are only used by the standalone CLI
path above (`npm run dev`, or `dist/index.js`) — not needed for `npm test`/`npm run
typecheck` (the Grafana client is mocked), and not used at all by the distributed
Electron app, which sources connections from its own `safeStorage`-backed store instead
(see `README.md`'s "How connections are stored" section).

`electron/` is a separate npm workspace (the distributed app) with its own commands:

```bash
cd electron && npm install   # also links the root engine package via the npm workspace
npm run dev                    # builds the root package, then opens the connection-manager GUI
node test/mcpServerMode.mjs    # spawns the real electron binary in --mcp-server mode; no live Grafana needed
```

## Pull requests

Title every PR as a [Conventional Commit](https://www.conventionalcommits.org/) —
`feat: ...`, `fix: ...`, `chore: ...`, `docs: ...`, `refactor: ...`, `test: ...`,
`build: ...`, `ci: ...` — matching this repo's existing commit history convention. This
isn't just style: this repo only allows squash merges (no merge commits, no rebase
merges), and GitHub's squash commit message defaults to the PR title. That single commit
is what `.github/workflows/release.yml`'s `version` job feeds to
[`release-please`](https://github.com/googleapis/release-please)
(`release-please-config.json` / `.release-please-manifest.json`, repo root) on every push
to `main`. It reads that title to decide whether a release is warranted and what version
bump it gets (`feat:` → minor, `fix:` → patch, a `BREAKING CHANGE:` footer or `!` after
the type → major; other types don't trigger a release), and uses it verbatim for the
CHANGELOG.md entry.

Note the two-step shape, which differs from a push-to-release flow: release-please doesn't
tag on merge. It opens (or updates) a single accumulating "chore(release): x.y.z" PR, and
the release is only cut when *that* PR is merged — so any number of unreleased commits can
sit on `main` in the meantime.

A PR merged with a non-conventional title (e.g. a bare description with no type prefix) is
real, shipped code that this pipeline can't see: no version bump, no changelog entry, even
though `main` moved. See `electron/CONTRIBUTING.md`'s "Building, signing, and releasing"
section for the full release flow.

## Architecture

This is an MCP server (`@modelcontextprotocol/sdk`, stdio transport) that gives an AI
agent read-only tools for Grafana-based incident investigation: ingest an alert, replay
its dashboard queries over the incident window, compare against baselines, and search
for correlated signals on other dashboards. Full tool list and design rationale are in
README.md.

Three things shape almost every module here and are easy to miss from a partial read:

1. **The Grafana client is a closed allowlist, not a passthrough.** `src/grafana/client.ts`
   exposes exactly the read-only endpoints the tools need (search, dashboard-by-uid,
   datasources, `/api/ds/query`, alertmanager alerts, ruler rules, annotations) and
   nothing else. There is deliberately no "make an arbitrary Grafana request" escape
   hatch anywhere in the tool layer — that boundary is what makes the read-only guarantee
   real rather than just a description. Don't add a generic proxy method to this client.

2. **Every tool's structured output is redacted before it reaches the model.** `security/redact.ts`
   masks secret-shaped keys and configured customer-identifier patterns; tools call it on
   their result just before returning `content`. `security/limits.ts` enforces the
   max-lookback/max-data-points/concurrency caps on every query window, and
   `security/audit.ts` logs every tool invocation to a local JSONL file. New tools should
   follow the same `withAudit(...) { ...; return { content: [...] } }` /
   `redact(result, config.redactionPatterns)` pattern used in `src/tools/*.ts` rather than
   returning raw data. The one exception is image bytes: `screenshot_panel` redacts its JSON
   payload like everything else, but the PNG content block goes to the model as rendered,
   since redaction only understands text. Don't generalize that into a second exception —
   any new *text* output belongs behind `redact()`.

3. **A tool call doesn't target one fixed Grafana — it resolves a connection first.**
   `src/grafana/registry.ts`'s `ConnectionRegistry` lazily builds and caches one
   `GrafanaClient` per connection id from a `ConnectionsSource`: a static array for the
   standalone CLI (env-based, one connection), or a thunk that re-reads
   `connections.json` on every call for the Electron app's `--mcp-server` mode — so
   adding/editing a connection in the GUI takes effect on the very next tool call, no
   server restart. `src/connections/resolve.ts`'s `resolveConnection()` picks which
   connection a given call uses: an explicit `connection` param always wins, then a match
   against the alert/dashboard URL's hostname, then the sole configured connection if
   there's only one — anything ambiguous or unresolvable is a hard error listing the
   available ids, never a guess. This is why every tool takes an optional `connection`
   parameter.

Data flow for the core incident-review path: `alerts/ingest.ts` normalizes a webhook
payload / pasted JSON / Grafana URL (via `alerts/urlParser.ts`) into an `AlertContext`
(resolving dashboard/panel links via `__dashboardUid__`/`__panelId__` annotations or by
parsing the URL); `dashboards/panelQueries.ts` + `dashboards/variables.ts` turn a
dashboard UID/panel ID into concrete, variable-substituted query targets; `query/windows.ts`
computes the incident/pre-window/control windows; `query/executor.ts` runs them through
`/api/ds/query` and parses Grafana's data-frame response into `{refId, labels, points}`
series; `analysis/baseline.ts`, `analysis/correlation.ts`, and `analysis/runs.ts`
(maximal-run detection for a threshold crossing — e.g. an uptime series dipping below
1.0 — shared by `execute_query_window`'s optional `threshold`/`thresholdDirection` and by
`validate_baseline`'s `briefExcursions`) turn those series into a z-score classification
and a ranked correlated-signal list; `analysis/summarize.ts` does **deterministic**
rule-based verdict assembly only (no LLM call, no prose generation) — the calling agent
is expected to write the human-readable note from that structured output, which is why
`summarize_findings` returns `reasons`/`evidence` arrays rather than a paragraph.
`grafana/urlBuilder.ts` builds the clickable dashboard/panel URL nearly every tool
returns alongside its data, deliberately using the same `viewPanel` URL shape
`urlParser.ts` parses on the way in, so a URL built here round-trips if it's ever pasted
back into `get_alert_context`.

`index-builder/` is a separate concern: it crawls all dashboards (per connection) to
build a metric/measurement -> dashboard reverse index, cached to
`<DATA_DIR>/metric-index.json` with a TTL (rebuilt on demand via
`find_related_dashboards({forceRefresh: true})` or `detect_correlated_anomalies` when it
needs to auto-discover candidates), not tied to the per-alert investigation flow.

The webhook listener (`src/webhook/listener.ts`) is a separate, optional process — it's
not part of the MCP server itself. It only accepts `POST /` and appends to
`<DATA_DIR>/alerts.jsonl`; `get_alert_context` reads from that store when called with no
arguments. Keep it that minimal — it exists solely so Grafana's contact-point webhook has
somewhere to land.

`electron/` is a separate npm workspace: the distributed app end users actually install.
Launched normally it's a connection-manager GUI (adds Grafana connections into a
`safeStorage`-encrypted local store, one per Grafana endpoint/region/tier); launched with
`--mcp-server` it skips the window and runs this same MCP server, sourcing connections
from that store via the `ConnectionsSource` thunk above instead of env vars. Both modes
are the same binary/process — that's what lets connection secrets stay OS-keychain-encrypted
end to end, with no separate server process that would need a plaintext credential on
disk. See `README.md`'s "How connections are stored" section for the storage format and
`electron/test/mcpServerMode.mjs` for how it's tested (spawns the real binary in
`--mcp-server` mode via the actual MCP SDK client/transport; no live Grafana needed).

`skills/explore/SKILL.md`, `skills/investigate/SKILL.md`, and `skills/export/SKILL.md`
(packaged as a Claude Code plugin via `.claude-plugin/plugin.json`, invoked as
`/timebuddy:explore` / `/timebuddy:investigate` / `/timebuddy:export`) are prose runbooks
that drive these tools in the right order for
an agent. Treat them as part of the interface, not just docs: if a tool's params, return
shape, or behavior changes in a way that would make a skill's instructions wrong or
stale, update the skill in the same change.

PromQL/InfluxQL metric and label extraction (`index-builder/extract.ts`) is a best-effort
regex scan, not a real parser — see the "Known limitations" section in README.md before
trying to make it more precise; the tradeoffs there were deliberate given the scope.

Docs are split by audience — keep it that way rather than drifting back into the mixed
files this was split out of. `README.md` is user-facing only (install, configure, use);
`CONTRIBUTING.md` and `electron/CONTRIBUTING.md` hold developer/build/release workflow
for the engine and the Electron app respectively; `docs/BEHAVIOR.md` holds the deep
Grafana-edge-case specs (product-knowledge dashboards, live `$__all` variable resolution,
the `-- Dashboard --` pseudo-datasource) that would otherwise clutter README.md. A change
to what an end user does belongs in README.md; a change to how a contributor
builds/tests/releases belongs in the relevant CONTRIBUTING.md — don't duplicate the same
instructions across both just because a change touches code in both places.
