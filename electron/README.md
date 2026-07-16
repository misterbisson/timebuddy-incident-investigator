# Grafana connection manager (and the MCP server itself)

One Electron app, two modes:

- Launched normally (double-click, `npm run dev`/`npm start`), it's a small GUI for
  managing Grafana connections, so each person authenticates as themselves (a personal
  Bearer token or their own Basic-auth username/password) instead of everyone sharing one
  admin-provisioned service-account token — and so an environment with more than one
  Grafana endpoint (per region/tier, etc.) can have all of them registered in one place.
- Launched with a `--mcp-server` flag — which is how Claude Code/Desktop should be
  configured to run it — it skips the window entirely and *is* the
  `timebuddy-incident-investigator` MCP server, talking to its client over stdio.

Both modes are the same binary and the same process type, which is what lets connection
secrets stay `safeStorage`-encrypted end to end: there's no separate server process that
can't call `safeStorage`, so there's never a reason to write a credential to disk in
plaintext.

The connection-list UI and auth model are adapted from
[Time Buddy](https://github.com/Liquescent-Development/time-buddy) — see
[`../NOTICE.md`](../NOTICE.md) for what was and wasn't carried over. Unlike Time Buddy,
this app is scoped to connection management (plus being the MCP server): no query IDE, no
AI analytics, no charting.

For downloading, installing, configuring, and using this app (connections, the Activity
window, registering with Claude), see the root [`README.md`](../README.md) — this is one
distributed product, and that page covers it end to end regardless of which part of the
repo a given feature's code happens to live in.

For building, testing, or releasing this app, see [`CONTRIBUTING.md`](CONTRIBUTING.md).
