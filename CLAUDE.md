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

`GRAFANA_URL` and `GRAFANA_TOKEN` are required at runtime (see `.env.example`); they are
not needed for `npm test` or `npm run typecheck`, since tests mock the Grafana client.

## Architecture

This is an MCP server (`@modelcontextprotocol/sdk`, stdio transport) that gives an AI
agent read-only tools for Grafana-based incident investigation: ingest an alert, replay
its dashboard queries over the incident window, compare against baselines, and search
for correlated signals on other dashboards. Full tool list and design rationale are in
README.md.

Two things shape almost every module here and are easy to miss from a partial read:

1. **The Grafana client is a closed allowlist, not a passthrough.** `src/grafana/client.ts`
   exposes exactly the read-only endpoints the tools need (search, dashboard-by-uid,
   datasources, `/api/ds/query`, alertmanager alerts, ruler rules, annotations) and
   nothing else. There is deliberately no "make an arbitrary Grafana request" escape
   hatch anywhere in the tool layer — that boundary is what makes the read-only guarantee
   real rather than just a description. Don't add a generic proxy method to this client.

2. **Every tool output is redacted before it reaches the model.** `security/redact.ts`
   masks secret-shaped keys and configured customer-identifier patterns; tools call it on
   their result just before returning `content`. `security/limits.ts` enforces the
   max-lookback/max-data-points/concurrency caps on every query window, and
   `security/audit.ts` logs every tool invocation to a local JSONL file. New tools should
   follow the same `withAudit(...) { ...; return { content: [...] } }` /
   `redact(result, config.redactionPatterns)` pattern used in `src/tools/*.ts` rather than
   returning raw data.

Data flow for the core incident-review path: `alerts/ingest.ts` normalizes a webhook
payload / pasted JSON / Grafana URL into an `AlertContext` (resolving dashboard/panel
links via `__dashboardUid__`/`__panelId__` annotations or by parsing the URL);
`dashboards/panelQueries.ts` + `dashboards/variables.ts` turn a dashboard UID/panel ID
into concrete, variable-substituted query targets; `query/windows.ts` computes the
incident/pre-window/control windows; `query/executor.ts` runs them through
`/api/ds/query` and parses Grafana's data-frame response into `{refId, labels, points}`
series; `analysis/baseline.ts` and `analysis/correlation.ts` turn those series into a
z-score classification and a ranked correlated-signal list; `analysis/summarize.ts` does
**deterministic** rule-based verdict assembly only (no LLM call, no prose generation) —
the calling agent is expected to write the human-readable note from that structured
output, which is why `summarize_findings` returns `reasons`/`evidence` arrays rather than
a paragraph.

`index-builder/` is a separate concern: it crawls all dashboards to build a
metric/measurement -> dashboard reverse index, cached to `<DATA_DIR>/metric-index.json`
with a TTL (rebuilt on demand via `find_related_dashboards({forceRefresh: true})` or
`detect_correlated_anomalies` when it needs to auto-discover candidates), not tied to the
per-alert investigation flow.

The webhook listener (`src/webhook/listener.ts`) is a separate, optional process — it's
not part of the MCP server itself. It only accepts `POST /` and appends to
`<DATA_DIR>/alerts.jsonl`; `get_alert_context` reads from that store when called with no
arguments. Keep it that minimal — it exists solely so Grafana's contact-point webhook has
somewhere to land.

PromQL/InfluxQL metric and label extraction (`index-builder/extract.ts`) is a best-effort
regex scan, not a real parser — see the "Known limitations" section in README.md before
trying to make it more precise; the tradeoffs there were deliberate given the scope.
