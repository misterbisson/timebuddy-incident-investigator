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
connection-resolution error).

It then spawns the binary a **second** time with
`--allow-adhoc-queries=grafana.example.com:influxdb` and checks that
`execute_adhoc_query` is absent in the first pass and present in the second. That pass exists
because `main.js` is plain JS that never sees `tsc`, so its argv-parsing →
`startMcpServer` `configOverrides` → `registerAll` gating path has no type checking behind it —
a typo there would silently either never enable the tool or always enable it. The statement
guard's own ordering (refuse before any query executes) is asserted separately against a mocked
client in the engine's `test/executeAdhocQuery.tool.test.ts`, since an unreachable
`grafana.example.com` can't distinguish a guard refusal from a network failure.

A **third** pass spawns the binary with a raw child process instead of an SDK client, so it
can do the one thing a well-behaved MCP client never does: destroy its read end of the
server's stdout while a response is pending. That's what Claude Code/Desktop exiting mid-call
looks like from this side, and it used to be a crash — the failed write raised an unhandled
`EPIPE`, which in a process that's GUI-capable but deliberately windowless meant Electron's
default handler putting a modal "A JavaScript error occurred in the main process" dialog on
screen, blocking the main thread so not even idle shutdown could reap it. The pass asserts the
process instead reports why and quits `0`. The guard itself is unit-tested in the engine
(`test/stdioPipe.test.ts`); what only the real binary can show is that the crash dialog is
gone and that `main.js`'s headless `uncaughtException`/`unhandledRejection` handlers are in
place. Run all three with:

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
`package-lock.json`'s own entry for the `electron` workspace member (a fourth
`extra-files` entry, `$.packages.electron.version`; the `node` release type refreshes the
lockfile's *root* entry on its own but not a member's, so without it `electron` sat at the
previous version in the lockfile while `electron/package.json` moved on — harmless to
`npm ci`, and it self-corrected whenever Dependabot next regenerated the lockfile, which
is why it went unnoticed. A jsonpath matching nothing is a no-op in release-please's JSON
updater, so if the lockfile's shape ever changes this reverts to the old drift rather than
breaking the release), bumps
the version string `src/server.ts` reports to MCP clients in the `initialize` handshake
(via release-please's generic updater and the `x-release-please-version` marker comment,
since a `.ts` file can't take a `jsonpath` entry), updates `CHANGELOG.md`, and tags the
merge commit `vX.Y.Z`. The `release` job then only runs if a version was actually
published, checked out at that new tag, and does the actual platform builds +
`electron-builder --publish always`, uploading the installers **and** the
`latest-*.yml` update manifests that `electron-updater` reads. Those manifests are what
`src/updater.js` checks on launch to auto-download and install newer releases; it no-ops in
dev (unpackaged). It runs in **both** launch modes, but they behave differently on purpose:

- **GUI:** always checks, and on a completed download offers a restart dialog.
- **`--mcp-server`:** checks only if it wins the election in `src/updateCheckClaim.js`,
  and never prompts or calls `quitAndInstall()` — that would tear down the stdio session
  Claude Code owns, mid-conversation. `autoInstallOnAppQuit` applies the update when that
  server process next exits, which for an MCP server is the end of every session, so the
  user picks it up at their next session having been interrupted by nothing.

The election exists because there's no `requestSingleInstanceLock`: every Claude Code
session/worktree spawns its own process (11 were observed at once), so an unconditional
check would mean 11 simultaneous ~120MB downloads onto one shared cache path. A timestamp
file gates on an interval, and an atomically-created (`wx`) lock file covers the
read-then-write window for processes starting simultaneously. GUI launches deliberately
bypass the election — opening the app is the user's one manual recourse, and silently
no-opping it because a background process stamped the file an hour ago would be worse than
the redundant download it saves. Note that `requestSingleInstanceLock()` is *not* the tool
for this: it makes the second instance quit, which would break the multi-session MCP model
outright. Also note that in `--mcp-server` mode stdout is the JSON-RPC channel, which is
why `updater.js` pins `electron-updater`'s logger to stderr — its default logger is
`electron-log` when resolvable and bare `console` otherwise, and `console.info` writes to
stdout, corrupting the session silently rather than failing loudly. This is why
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
minor/patch) for npm and for GitHub Actions versions — on top of GitHub's always-on,
config-independent Dependabot security-update PRs for vulnerability fixes.

There is deliberately **one** npm entry, `directory: "/"`, covering the `electron/`
workspace member too — resist adding a second for `/electron`, which reads like the
obvious thing to do given it has its own `package.json`. It can't produce a mergeable PR:
the member has no `electron/package-lock.json` (npm resolves the whole workspace into the
root lockfile), so a `/electron`-scoped entry bumps `electron/package.json`, can't reach
the lockfile that pins it, and every job dies at `npm ci` with `Invalid: lock file's
electron@X does not satisfy electron@Y`. Meanwhile the root entry *does* reach the member's
manifest — it has bumped both `zod` in `electron/package.json`
([#227](https://github.com/misterbisson/timebuddy-incident-investigator/pull/227)) and
`electron` itself
([#229](https://github.com/misterbisson/timebuddy-incident-investigator/pull/229)) — so the
second entry only ever produced a broken twin of a PR the root entry already opened
correctly ([#228](https://github.com/misterbisson/timebuddy-incident-investigator/pull/228)
was that twin). If `electron/` ever gets its own lockfile, this inverts and a second entry
becomes right.

**macOS builds are Apple Developer ID signed and notarized** (electron-builder native
signing via `CSC_LINK` + `mac.notarize`), so downloaded builds open without a Gatekeeper
block — see [`SIGNING.md`](SIGNING.md) for the full setup, the required secrets, and the
validate-before-store credential-rotation runbook. The `verify-signing.yml` workflow proves
the whole sign → notarize → staple path on a clean runner for every PR that touches the
app, **and** on every push to `main`. Windows and Linux builds are unsigned entirely, same
as upstream Time Buddy.

The push-to-`main` trigger is not redundant with the PR one: a Dependabot `pull_request`
event runs with the `dependabot` secrets scope rather than the repo's, so
`MACOS_CERTIFICATE` is empty and this job fails on *every* Dependabot PR no matter how
healthy the bump. It isn't a required check, so that doesn't block merges — but it does
make a bump that breaks signing indistinguishable from one that doesn't, which is how
electron 43 → 44 reached `main` with signing verified only by a manually dispatched run.
To get that signal *before* merging a Dependabot PR, dispatch it against the branch —
`workflow_dispatch` runs do get repo secrets:

```bash
gh workflow run verify-signing.yml --ref <dependabot-branch>
```

`mac.target[0].arch` builds both `x64` and `arm64` dmgs, and `mac.artifactName` is set
explicitly (`${productName}-${version}-${arch}.${ext}`) so both always carry their arch in
the filename. Without it, electron-builder's own default silently drops the arch suffix for
whichever one it treats as "default" — `x64`, unless `mac.defaultArch` says otherwise, for
backward-compat reasons that predate Apple Silicon — so the release page showed an
`arm64`-labeled dmg next to a bare, unlabeled one that was actually the (little-used) Intel
build. See [#190](https://github.com/misterbisson/timebuddy-incident-investigator/issues/190).
