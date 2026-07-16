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

Pushes to `main` first run a `version` job: `semantic-release` (`release.config.js`,
repo root) analyzes commits since the last release using Conventional Commits
(`feat:` → minor, `fix:` → patch, etc. — plus a `dependencyReleaseRules` override so
`build(deps)`/`build(deps-dev)`/`chore(deps)`/`chore(deps-dev)` commits, e.g. Dependabot's,
also release as a patch; without it a merged Dependabot PR — including a security fix —
would silently produce no release at all), and if one of those is warranted, bumps
`package.json` and `electron/package.json` in lockstep (`scripts/sync-electron-version.js`
keeps the latter in sync, since `@semantic-release/npm` only touches the root one),
updates `CHANGELOG.md`, and commits + tags that as `vX.Y.Z` on `main` (pushed with
`[skip ci]`, so it doesn't re-trigger the workflow). The `release` job then only runs
if a version was actually published, checked out at that new tag, and does the actual
platform builds + `electron-builder --publish always` (so `electron-updater` — not yet
wired into `main.js` — can eventually point at those release artifacts). A `main` push
with no releasable commits (docs-only, non-dependency chores, etc.) skips the
build/publish matrix entirely.

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
