# Log integration (Graylog and Loki)

This is the contributor-facing design doc for the log-search subsystem added in v0.3.0
(`src/graylog/`, `src/logs/`, and the three log tools), and for Loki as a second kind of log
source (issue #265, [below](#loki-a-log-source-derived-from-grafana-not-configured)). It's the log counterpart to
`docs/BEHAVIOR.md`: read it before changing anything under those directories. The
end-user's view — how to configure a Graylog connection and use the tools — is in the root
`README.md`; this file is the *why*.

## The one-sentence version

Log search reuses Grafana's three architectural rules verbatim — closed-allowlist client,
redact-everything tools, resolve-a-connection-per-call — and adds exactly one genuinely
new idea: an adapter that makes a **live-tail-oriented** join engine run against a
**fixed, days-old historical window**.

## Two connection kinds, one machinery

Before v0.3.0 every tool resolved a `GrafanaConnection`. Now there are two connection
kinds, and the resolution/registry/redaction plumbing is shared rather than forked:

- `GrafanaConnection.authType` is `'bearer' | 'basic'`; `LogConnection.authType` is
  `'token' | 'basic'`. They deliberately **do not** share an interface — see
  [`src/config.ts`](../src/config.ts)'s comment on `LogConnection`. The two have almost no
  fields in common beyond auth, and a shared interface would just push Graylog-only fields
  (`streamId`, `streamName`) onto every Grafana connection.
- [`src/connections/resolve.ts`](../src/connections/resolve.ts)'s `resolveConnection()` is
  now generic over a minimal `ResolvableConnection` (`{id, url, matchHosts?}`), so both
  kinds share the one "explicit id wins → host match → sole connection → else error"
  policy. A `kind` param (default `'Grafana'`) only changes error-message wording, which
  is why every pre-existing Grafana call site's error text is unchanged — verified by the
  existing test suite.
- [`src/graylog/registry.ts`](../src/graylog/registry.ts)'s `LogConnectionRegistry`
  mirrors `ConnectionRegistry`: one lazily-built, cached `GraylogClient` per connection id,
  sourced from a thunk so the Electron app picks up a newly-added connection on the very
  next tool call with no restart.

One asymmetry worth knowing: log connections have no inbound alert/dashboard link, so
callers resolving a log connection pass no `hintUrl` — a log source is chosen by explicit
`connection` id, by shared-`tags` pairing (below), or by being the only one configured.

## The Graylog client is a closed allowlist

[`src/graylog/client.ts`](../src/graylog/client.ts)'s `GraylogClient` exposes exactly two
read-only endpoints and nothing else — same guarantee as `GrafanaClient`. Do **not** add a
generic "make an arbitrary Graylog request" method; that boundary is what makes the
read-only property real.

- `searchAbsolute()` → `GET /api/search/universal/absolute` — the **legacy (2.x–5.x)**
  Universal Search API. It takes explicit ISO8601 `from`/`to`, which is the whole reason
  it works for historical review. It requests `fields=_id,message,timestamp,source,*` — the
  trailing `*` pulls *every* indexed field so `correlate_logs` can join on arbitrary ones
  (`request_id`, `trace_id`, …).
- `listStreams()` → `GET /api/streams`.

Graylog 6.x's Views API returns CSV and needs materially different parsing — deliberately
out of scope (see README "Known limitations").

### The auth quirk

`buildGraylogAuthHeader()` ([client.ts:34](../src/graylog/client.ts)): an API **token** is
*not* a `Bearer` header. Graylog's documented convention is HTTP Basic with the token as
the **username** and the literal string `"token"` as the **password**
(`Basic base64(token:token)`). `'basic'` auth is an ordinary username/password login. This
was confirmed against `github.com/lcaliani/graylog-mcp` and is a deliberate deviation from
the abandoned `graylog` branch's approach. The connection form labels the "API token"
field so this isn't surprising to a user.

## The one genuinely new piece: HistoricalGraylogAdapter

[`src/logs/adapter.ts`](../src/logs/adapter.ts) is the crux. Correlation is built on the
vendored AGPL `@liquescent/log-correlator-core` engine (see `NOTICE.md`), which is a pure,
transport-agnostic join engine — it asks a `DataSourceAdapter` for streams and joins them.

The library ships its own `LokiAdapter`/`GraylogAdapter`, but **we don't use them**: every
"historical" fetch they support is hardcoded to `from = now - window, to = now`. They're
built exclusively for tailing. Reviewing an incident from last Tuesday needs a *fixed*
window, not a window anchored to `now`.

So `HistoricalGraylogAdapter`:

- Takes a fixed `{fromMs, toMs}` at construction and **ignores the `timeRange` the engine
  derives from the query's `[5m]` grammar entirely** — every `createStream()` call re-runs
  `searchAbsolute()` against that same fixed window. (Confirmed by reading the engine's
  source that the join logic itself has no live-tail assumptions baked in — only the
  bundled adapters do.)
- Turns every non-fixed field on a message into a joinable string label via `toLabels()`
  (skipping `_id`/`message`/`timestamp`/`source`, stringifying non-strings) — because the
  join grammar (`and on(request_id)`, `unless`, `group_left()`) matches on
  `LogEvent.labels`.
- Records a `StreamFetchStat` per stream (`fetched` vs. `total`, and a `truncated` flag
  when `total > fetched`). This is not bookkeeping — it drives the correctness guard below.
- Has a no-op `destroy()`: each search is a one-shot HTTP request, not a held
  subscription.

## Correlation is stateless and always torn down

[`src/logs/correlate.ts`](../src/logs/correlate.ts)'s `correlateLogs()` builds a **fresh**
`CorrelationEngine` + adapter per call and always `destroy()`s both in `finally`. Two
reasons: this server is stateless across tool calls (nothing about one correlation should
leak into the next), and the engine holds internal timers that would otherwise keep the
Node process alive. By the time `engine.correlate()` finishes, every stream has been
drained, so `adapter.fetchStats` is fully populated for the caller to inspect.

## Loki: a log source derived from Grafana, not configured

Loki has no web UI and, in practice, no credential of its own that users hold: people reach
it through Grafana, whose datasource config keeps Loki's URL and secret server-side. So a
Loki source is **not a new kind of `LogConnection`**. [`src/logs/sources.ts`](../src/logs/sources.ts)
derives one from every `loki` datasource on every Grafana connection, on every call, with
id `<grafanaConnectionId>/<datasourceUid>` and its Grafana connection's `tags`. Nothing to configure, no second
secret, and a datasource added in Grafana is searchable on the next call. A direct-to-Loki
connection kind is deliberately not built: it would need a gateway URL, a token, and a
tenant id that nobody outside the owning team usually has. Revisit that only if the Grafana
path turns out to be the problem.

**Resolution** mirrors `resolveConnection()` — explicit id, else the sole source, else a
hard error listing ids — with one rule added because sources are now *discovered*: a
Grafana connection whose datasource list can't be read blocks the sole-source default. It
might hold a Loki datasource, so "only one source" can't be established, and falling back
to the lone Graylog connection anyway is the exact failure this exists to stop (a Loki-only
service searched in Graylog, empty, read as "no errors"). `list_log_sources` reports the same
failures as `lokiDiscoveryProblems` rather than failing.

An explicit Loki id is never split on a `/`. Grafana only enforces a `/`-free datasource uid
from v12 (11.1 warns, 11.2 adds an opt-in check), and a uid created earlier survives the
upgrade, so `team/logs` is a real uid, and splitting on the last `/` listed a source that
could then never be resolved. The resolver matches the id against the known Grafana
connection ids instead, since those are the half this server controls, and takes the rest as
the uid. An id that means two things is refused, naming both, rather than resolved to either:
two connection ids that both prefix it, or a Graylog connection id that is also a Loki
source's id (the Graylog one used to win silently). So an explicit Graylog id reads a Grafana
connection's datasource list only when it begins with that connection's id and a `/`.

**The query path** ([`src/logs/loki.ts`](../src/logs/loki.ts)) is the already-allowlisted
`POST /api/ds/query` — no new endpoint. The query is model-authored, exactly as a Graylog
`search_logs` query always was, and like that path it needs no per-workspace ad-hoc flag.
Its guard is [`query/logqlGuard.ts`](../src/query/logqlGuard.ts) (shared with
`execute_adhoc_query`'s LogQL dialect): one expression, never rewritten, **log** queries
only. Its header says why that is enough for LogQL. Four details are load-bearing:

- **`maxLines` is always sent.** Unset, Grafana leaves the limit to the datasource's own
  setting, which is invisible from here — and a cap nobody can see makes "truncated"
  unknowable.
- **`truncated` is `returned >= limit`.** Loki reports no match total, so Graylog's
  `total > fetched` isn't available. The heuristic is conservative, which is the direction
  the `unless` refusal below needs, and `StreamFetchStat.total` is left unset for Loki rather
  than faked.
- **Two frame layouts, read by field name.** Grafana emits `labels`/`Time`/`Line`/`tsNs`/`id`
  by default and `labels`/`timestamp`/`body`/`id` behind its `lokiLogsDataplane` toggle. A
  numeric frame (a metric result) or an unrecognized layout throws rather than reading as
  "no lines".
- **`direction: backward`** (newest first, Loki's default), so a capped search keeps the end
  of the window. That decides *which* lines come back, since Loki applies the limit to the
  newest lines overall, but not their order: Grafana groups a frame's rows by stream.
  `parseLokiLogFrames` therefore sorts newest first itself, by nanosecond timestamp. That is
  `tsNs` in the legacy layout, and in the dataplane layout the time column's epoch ms plus the
  frame's `data.nanos` offset (the plugin SDK leaves `nanos` out when every offset is zero).
  The test fixture groups rows by stream the same way, so a test that assumed arrival order
  fails.

**Correlation** uses [`HistoricalLokiAdapter`](../src/logs/lokiAdapter.ts), registered under
`loki` so `loki(...)` streams reach it. `correlate_logs` checks each stream's source name
against the resolved source before running, so a `graylog(...)` query against a Loki source
fails with a message saying so. log-correlator's grammar takes only a **bare stream selector**
inside `loki(...)` — no pipeline — so a query can't ask Loki for `| json`. The adapter
therefore builds each event's labels itself: stream labels plus the fields `| json` would
extract, under the same names (nested keys joined with `_`, invalid characters to `_`, arrays
skipped, `_extracted` on a collision). Without that, events would be joinable only on stream
labels, and join keys like request ids are almost never stream labels. A JSON payload
double-encoded inside a string field isn't reached; that takes `line_format`, which only
`search_logs` can express.

Note the selector the adapter runs is the join parser's normalized form (e.g. whitespace
after a matcher's comma removed), not the caller's exact text. It is still the string the
guard scanned, and `joinShape`'s right-side selectors come from the same parser, so the
anti-join check compares like with like.

**Label discovery.** `list_log_sources({connection: <loki id>})` returns the datasource's
stream label *names* (`GrafanaClient.getLokiLabelNames`), which is the Loki counterpart of a
Graylog connection's streams. Grafana's Loki backend prefixes every resource path with
`/loki/api/v1/` itself (unchanged 9.5 through 12.x), so resource paths here are only what
follows it. `getLokiLabelValues` used to repeat the prefix and 404, and its test asserted the
doubled path.

Both label calls always send a `start`/`end` window, for two reasons. Loki defaults both
endpoints to the last 6 hours, so without one a service that stopped logging before that (it
crashed, or was renamed) disappears from an investigation of anything older. And Grafana 9.5
through 10.4 only forward a Loki resource URL beginning `labels?`, so a bare `labels` is refused
before it reaches Loki; v11 dropped that check. The window is required on the client methods
rather than defaulted there. `list_log_sources` and `discover_label_values` take an optional
`startsAtMs`/`endsAtMs`, default to the 24 hours before now (or `MAX_LOOKBACK_HOURS` if
shorter), and report the range used, since which labels exist depends on it. Passing a window
where it would scope nothing (no Loki source, or a non-Loki datasource) is refused rather than
ignored.

## Truncation: surfaced for joins, refused for anti-joins

A search capped at `limit` (default `MAX_LOG_LINES`, 500) gives the join a partial view.
The consequence depends on the join operator, and
[`src/tools/correlateLogs.ts`](../src/tools/correlateLogs.ts) treats them differently:

- **`and` (inner) / `or` (union)** under-count when truncated — lossy but not misleading.
  These surface a top-level `truncated: true` flag and continue.
- **`unless` (anti-join)** *inverts* when the **right (subtracted) side** is truncated: a
  left event whose match sits just past the cap gets reported as "unmatched" — e.g. "this
  frontend request never reached the backend" when it did. That's a wrong answer dressed as
  a confident one, so the tool **throws** instead, telling the caller to narrow the window,
  raise the cap, or lower `limit` and retry.

Knowing which selectors are on the right-hand side requires parsing the query.
[`src/logs/joinShape.ts`](../src/logs/joinShape.ts) uses the *same* `PeggyQueryParser` the
engine uses internally, so a query the engine accepts parses identically here. It's
best-effort: an unparseable query (the engine would already have thrown) yields an
undefined `joinType`, and the guard conservatively treats *any* truncation as unsafe when
it can't identify the sides.

## Data flow

```
search_logs        ─┐
correlate_logs     ─┼─→ resolveLogSource (logs/sources.ts)
list_log_sources   ─┘        │
              ┌──────────────┴───────────────┐
              ↓ graylog                      ↓ loki
   LogConnectionRegistry → GraylogClient    ConnectionRegistry → GrafanaClient
              │   searchAbsolute() /             │   queryDs() via logs/loki.ts
              │   listStreams()                  │   (logqlGuard), getLokiLabelNames()
              ↓                                  ↓
   Graylog /api/search/universal/absolute   Grafana /api/ds/query → Loki query_range
   correlate_logs: HistoricalGraylogAdapter correlate_logs: HistoricalLokiAdapter
```

All three tools follow the same `withAudit(...) { … redact(result, patterns) }` pattern as
every Grafana tool — audit-logged, and every text payload redacted before it reaches the
model. There is no image-bytes exception here (that's `screenshot_panel`-only); all log
output is text and all of it goes through `redact()`.

## Tag-based pairing

`GrafanaConnection` and `LogConnection` both carry free-form `tags` (e.g. `prod`,
`us-east`); a Loki source inherits its Grafana connection's. `list_datasources` surfaces each Grafana connection's tags (as
`connectionTags`) and `list_log_sources` surfaces each log connection's — so a skill can
pair "the log source covering the same environment as this dashboard" by shared tag
instead of guessing. The `/timebuddy:investigate` skill's log-evidence step does exactly
this: one match → use it; zero or many of the same kind → ask; a Graylog and a Loki
source both covering the environment → search both, since a service may log to either. Keep `list_datasources` and
`list_log_sources` symmetric on this field if you touch either.

## Standalone-CLI env vars

For engine iteration without Electron, a single Graylog connection comes from
`GRAYLOG_URL` + (`GRAYLOG_TOKEN` | `GRAYLOG_USERNAME`/`GRAYLOG_PASSWORD`), plus optional
`GRAYLOG_STREAM_ID`/`GRAYLOG_TAGS` — the same dev/CI convenience path as
`GRAFANA_URL`/`GRAFANA_TOKEN` ([`src/config.ts`](../src/config.ts)). The distributed app
sources log connections from its own `safeStorage`-backed store instead. See
`CONTRIBUTING.md`'s "Running the standalone CLI".

## Limitations (as shipped)

- Legacy (2.x–5.x) Universal Search API only; 6.x Views API not implemented.
- `correlate_logs` covers single-key `and`/`or`/`unless` across 3+ streams. Cross-field
  label-mapping joins (`on(a=b)`) and `group_left()`/`group_right()` many-to-one grouping
  exist in the underlying library but aren't exercised by this project's tests yet.
- Stream **name → id** resolution isn't implemented; pass `streamId` directly.
- Loki only through a Grafana datasource, never directly; a `loki(...)` join stream takes a
  bare selector, so a field inside a double-encoded JSON payload isn't joinable.

## Tests

`test/graylogClient`, `test/graylogRegistry`, `test/graylogUrlBuilder`,
`test/logsAdapter`, `test/logsCorrelate` (inner/left/anti-join plus a 3-stream join), and
tool-level tests for all three tools. Loki: `test/lokiSearch` (both frame layouts, the
request shape, truncation, refusals), `test/lokiAdapter` (the `| json` mirroring, and joins
through the real engine), `test/logSources` (resolution, including the discovery-failure
rule), and `test/lokiLogTools.tool` (all three tools against a Loki source). `electron/test/connectionStore.test.js` exercises
both connection kinds against the real Electron binary;
`electron/test/mcpServerMode.mjs` proves `search_logs` reaches a real network attempt via
a seeded Graylog connection. None require a live Graylog instance.
