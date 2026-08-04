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

### Registering a dev instance with Claude Code

To exercise local changes as a real tool call from Claude Code (rather than via
`test/mcpServerMode.mjs`'s scripted client), open the GUI (`npm run dev`) and use its
"Register with Claude" section same as an end user would — but run it from this
unpackaged checkout, not an installed build. The generated `claude mcp add`/Claude
Desktop snippet detects that it's unpackaged (`isPackaged` is false) and automatically
names the server `timebuddy-incident-investigator-dev` instead of
`timebuddy-incident-investigator`, so it registers as a distinct entry alongside any real
connection to a packaged build rather than colliding with (or overwriting) it. Both can
be connected at once; make sure whichever client you're testing in is pointed at the
`-dev` entry, since tool names are otherwise identical between the two.

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

`ci.yml`'s `electron-mcp-server` job runs this on every PR, under a directly-started `Xvfb`
(Electron needs a display even with no window shown) and `--disable-gpu` (a bare Xvfb has
no real GPU/GL driver, and neither script here ever creates a `BrowserWindow`). The spawned
Electron processes get `--password-store=basic` so Linux `safeStorage` never touches a real
Secret Service — a real D-Bus/`gnome-keyring` session works too, but can hang indefinitely
on a headless runner waiting on an unlock prompt nothing will ever answer;
`--password-store=basic` is documented Chromium behavior, not a workaround specific to this
repo. That alone isn't sufficient, though: selecting the `basic_text` backend doesn't make
`safeStorage.isEncryptionAvailable()` true by itself — both `seedConnection.js` and
`main.js` also call `safeStorage.setUsePlainTextEncryption(true)` (Linux-only, Electron
25.5.0+), the separate opt-in Electron's own native `IsEncryptionAvailable()` requires
alongside the `basic_text` backend. In `main.js` this is a real fix, not just a CI
accommodation: without it, a real Linux desktop with no working keyring couldn't store any
connection at all. It's a separate job from `ci.yml`'s fast fixture-based `test` job — this
one needs a full workspace install (the real Electron binary), an explicit `npm run build`
(main.js dynamically imports the *built* engine package, which `npm ci` alone never
produces), and those system packages, so it's split out rather than slowing down the fast
signal. `release.yml`'s build jobs still don't invoke it; they package with
`electron-builder` but never run the packaged binary. Formerly untested in CI at all —
see [#97](https://github.com/misterbisson/timebuddy-incident-investigator/issues/97).

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

`test/screenshotter.test.js` covers `screenshotter.js`'s `capturePanel` against a real
(offscreen) `BrowserWindow` — a mock can't exercise this, since the behavior in question is
Electron's own `capturePage()`/`toPNG()` baking the host display's actual device pixels into
the captured image. It asserts that a capture's backing-store area tracks the *requested*
width/height regardless of the display's `scaleFactor`, rather than blowing up by
`scaleFactor^2` on a hi-dpi display (see [#179](https://github.com/misterbisson/timebuddy-incident-investigator/issues/179),
verified against a real 2x Retina display: a request for 1600x900 captured at 3200x1800
before the fix, 1600x900 after). On a 1x display — most CI runners — the compensation is a
no-op, so this test passes trivially there; it's most meaningful run on real hi-dpi hardware:

```bash
electron test/screenshotter.test.js --user-data-dir=/tmp/timebuddy-screenshotter-test
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

`.github/workflows/release.yml` builds all three platforms on every PR to `main`, and on a
push to `main` only when that push actually cuts a release (see below).

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
PR) is what actually cuts the release: release-please bumps `package.json`,
`electron/package.json`, and `.claude-plugin/plugin.json` in lockstep (`extra-files`
entries in `release-please-config.json` keep the latter two in sync — the plugin one
matters because `electron/package.json` ships that directory as `extraResources`, so a
stale version there would be visible to anyone who installed the bundled plugin), bumps
the version string `src/server.ts` reports to MCP clients in the `initialize` handshake
(via release-please's generic updater and the `x-release-please-version` marker comment,
since a `.ts` file can't take a `jsonpath` entry), updates `CHANGELOG.md`, and tags the
merge commit `vX.Y.Z`. The `release` job then only runs if a version was actually
published, checked out at that new tag, and does the actual platform builds +
`electron-builder --publish always`, uploading the installers **and** the
`latest-*.yml` update manifests that `electron-updater` reads. Those manifests are what
`src/updater.js` (wired into `main.js`'s GUI startup) checks on launch to auto-download and
install newer releases; it no-ops in dev and in `--mcp-server` mode. This is why
`build.mac.target` lists a `zip` alongside the `dmg`: Squirrel.Mac (via electron-updater)
can only consume a zip, so a dmg-only mac release would publish a `latest-mac.yml` the
updater then chokes on (`ERR_UPDATER_ZIP_FILE_NOT_FOUND`) — the dmg is for first installs,
the zip is what auto-update actually downloads. release-please creates the `vX.Y.Z`
tag *and* the GitHub Release object together (it is **not** run with `skip-github-release`
— that would skip the tag too; see the note in `.github/workflows/release.yml`), so the
release already exists as a *published* release by the time `electron-builder` runs. That
is why the `github` publish entry in this package's `build` config sets
`"releaseType": "release"`: electron-builder's default is to publish into a *draft*, and
it refuses to upload to a release whose type doesn't match (`existing type not compatible
with publishing type ... existingType=release publishingType=draft`) — silently skipping
every asset while the job still reports success. `releaseType: "release"` makes it upload
into the existing published release instead. A `main` push
with no releasable commits merged (docs-only, non-dependency chores, etc.) skips the
build/publish matrix entirely, same as before. Until you merge the accumulated PR, any
number of unreleased commits can land on `main` without forcing a release — merge it
whenever you're ready to cut one.

`.github/dependabot.yml` configures scheduled dependency-update PRs (weekly, grouped by
minor/patch) for the root workspace, the `electron/` workspace, and GitHub Actions
versions — on top of GitHub's always-on, config-independent Dependabot security-update
PRs for vulnerability fixes.

**macOS builds are Apple Developer ID signed and notarized** (electron-builder native
signing via `CSC_LINK` + `mac.notarize`), so downloaded builds open without a Gatekeeper
block — see [`SIGNING.md`](SIGNING.md) for the full setup, the required secrets, and the
validate-before-store credential-rotation runbook. The `verify-signing.yml` workflow proves
the whole sign → notarize → staple path on a clean runner for every PR that touches the
app. Windows and Linux builds are unsigned entirely, same as upstream Time Buddy.

`mac.target[0].arch` builds both `x64` and `arm64` dmgs, and `mac.artifactName` is set
explicitly (`${productName}-${version}-${arch}.${ext}`) so both always carry their arch in
the filename. Without it, electron-builder's own default silently drops the arch suffix for
whichever one it treats as "default" — `x64`, unless `mac.defaultArch` says otherwise, for
backward-compat reasons that predate Apple Silicon — so the release page showed an
`arm64`-labeled dmg next to a bare, unlabeled one that was actually the (little-used) Intel
build. See [#190](https://github.com/misterbisson/timebuddy-incident-investigator/issues/190).
