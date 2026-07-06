# Grafana connection manager

A small Electron app for managing the Grafana connections used by the
`timebuddy-incident-investigator` MCP server, so each person authenticates as themselves
(a personal Bearer token or their own Basic-auth username/password) instead of everyone
sharing one admin-provisioned service-account token — and so an environment with more
than one Grafana endpoint (per region/tier, etc.) can have all of them registered in one
place.

Its connection-list UI and auth model are adapted from
[Time Buddy](https://github.com/Liquescent-Development/time-buddy) — see
[`../NOTICE.md`](../NOTICE.md) for what was and wasn't carried over. Unlike Time Buddy,
this app is scoped to connection management only: no query IDE, no AI analytics, no
charting.

## Running

```bash
cd electron
npm install
npm run dev
```

## How it stores data

Connections and credentials live under Electron's per-OS `userData` directory (shown in
the app's UI, with a "copy path" button). Three files:

- `connections.json` — non-secret metadata (name, URL, auth type, etc.). Read by both
  this app and the MCP server.
- `secrets.enc.json` — this app's own working copy of tokens/passwords, encrypted with
  Electron's `safeStorage` (backed by the OS keychain: macOS Keychain, Windows DPAPI, or
  libsecret on Linux). Only this app ever reads it.
- `credentials.json` — the MCP server's read path. `safeStorage` is an Electron-only
  API, so a plain Node process can't decrypt `secrets.enc.json`; this file is a
  `0600`-permissioned plaintext hand-off instead, the same posture as `~/.aws/credentials`
  or a kubeconfig. This is the one deliberate gap in "everything is encrypted" — flagged
  here rather than glossed over.

## Pointing the MCP server at this app's connections

Set `GRAFANA_CONNECTIONS_DIR` in the MCP server's environment to the directory shown in
this app's UI (defaults to `<DATA_DIR>/connections` if unset). See the root
[`README.md`](../README.md) for the full setup flow.
