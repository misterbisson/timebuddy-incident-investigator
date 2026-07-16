# Developing the Electron app

This covers building and testing the desktop app itself. For using it (configuring
connections, installing a downloaded build, registering with Claude), see
[`README.md`](README.md). For the underlying engine (`src/` at the repo root), see the
root [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Running

```bash
cd electron
npm install        # also links the root engine package via the npm workspace
npm run dev         # builds the root package, then opens the GUI
```

To run in MCP-server mode directly (what Claude Code/Desktop will do):

```bash
electron . --mcp-server
```

## Testing

`test/mcpServerMode.mjs` seeds a connection directly through `connectionStore.js` (bypassing
the GUI), then spawns this app's real binary in `--mcp-server` mode using the actual
`@modelcontextprotocol/sdk` `Client`/`StdioClientTransport` — the same mechanism a real MCP
client uses — and confirms `tools/list` returns the full expected tool set and a tool call reaches a real
network attempt using the seeded, `safeStorage`-decrypted credential (not a
connection-resolution error). Run it with:

```bash
node test/mcpServerMode.mjs
```

No live Grafana instance is required; the seeded connection points at a placeholder URL
specifically so the test can assert the call got *past* connection resolution, not that it
succeeded against a real Grafana.

`test/connectionStore.test.js` covers `connectionStore.js` directly (same
bypass-the-renderer approach as `seedConnection.js`): both the `grafana` and `graylog`
connection `kind`s round-trip through `listConnectionsForDisplay()`, each kind's
engine-facing getter (`getConnectionsForEngine()`/`getLogConnectionsForEngine()`) only
returns its own kind with the right shape (decrypted secret, `matchHosts` vs
`streamId`/`streamName`, shared `tags`), and editing a connection with a blank
secret field keeps the previously stored one. **Always pass `--user-data-dir`** (same as
`seedConnection.js`) — without it, this writes into your real `connections.json`/
`secrets.enc.json` instead of a scratch directory:

```bash
electron test/connectionStore.test.js --user-data-dir=/tmp/timebuddy-connection-store-test
```

## Building, signing, and releasing

Packaging is `electron-builder`, configured in this package's `build` field in
`package.json` — adapted from Time Buddy's own setup (`build.js`/`release.yml` in
[Liquescent-Development/time-buddy](https://github.com/Liquescent-Development/time-buddy),
see [`../NOTICE.md`](../NOTICE.md)):

```bash
cd electron
npm run build-mac    # or build-win / build-linux
```

Each of those first runs the root package's `tsc` build (`npm run build --prefix ..`) so
the engine's `dist/` is current, then invokes `electron-builder` for that platform. Output
lands in `electron/dist/`.

`.github/workflows/release.yml` builds all three platforms on every push/PR to `main`.

Pushes to `main` first run a `version` job: [`release-please`](https://github.com/googleapis/release-please)
(`release-please-config.json`/`.release-please-manifest.json`, repo root) analyzes commits
since the last release using Conventional Commits (`feat:` → minor, `fix:` → patch, a
`BREAKING CHANGE:`/`!` → major) and, if any are releasable, opens or updates a single
`chore(release): X.Y.Z` pull request accumulating all of them — nothing is published at
this point. Because `main`'s branch protection requires every change to go through a PR
with passing status checks (with no bypass for direct pushes), this PR is also what makes
that possible at all: a prior direct-push design (`semantic-release`) could never actually
land a release once branch protection was added. Dependabot's bumps use `fix(deps)`/
`fix(deps-dev)` commit types specifically so release-please's default versioning (which,
unlike the old setup, has no config option for custom commit-type-to-bump-level rules)
picks them up — without that, a merged Dependabot PR, including a security fix, would
silently produce no release at all.

Merging the accumulated release PR (through the same required status checks as any other
PR) is what actually cuts the release: release-please bumps `package.json` and
`electron/package.json` in lockstep (an `extra-files` entry in
`release-please-config.json` keeps the latter in sync), updates `CHANGELOG.md`, and tags
the merge commit `vX.Y.Z`. The `release` job then only runs if a version was actually
published, checked out at that new tag, and does the actual platform builds +
`electron-builder --publish always` (so `electron-updater` — not yet wired into `main.js`
— can eventually point at those release artifacts; release-please itself is configured
with `skip-github-release: true` so it only tags, leaving the actual GitHub Release object
and asset uploads to electron-builder, avoiding a double-release conflict). A `main` push
with no releasable commits merged (docs-only, non-dependency chores, etc.) skips the
build/publish matrix entirely, same as before. Until you merge the accumulated PR, any
number of unreleased commits can land on `main` without forcing a release — merge it
whenever you're ready to cut one.

`.github/dependabot.yml` configures scheduled dependency-update PRs (weekly, grouped by
minor/patch) for the root workspace, the `electron/` workspace, and GitHub Actions
versions — on top of GitHub's always-on, config-independent Dependabot security-update
PRs for vulnerability fixes.

**macOS signing is currently a self-signed certificate**, not a real Apple Developer ID —
see [`SELF_SIGNED_SETUP.md`](SELF_SIGNED_SETUP.md) for what that does and doesn't buy you
(short version: `afterSign` runs `scripts/afterSign.js`, which signs but can't notarize
without real Apple credentials, so downloaded builds still hit a Gatekeeper block — see
the root [`README.md`](../README.md#installing-a-downloaded-build-macos) for the
click-through).
Windows and Linux builds are unsigned entirely, same as upstream Time Buddy.
