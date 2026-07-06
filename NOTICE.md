# Notice

## Time Buddy attribution

The `electron/` connection-manager app in this repository is design-adapted from
[**Time Buddy**](https://github.com/Liquescent-Development/time-buddy) (also published as
`grafana-query-ide`), by **Richard Kiene** / Liquescent Development
(richard@liquescent.dev), licensed under the GNU Affero General Public License v3.0
(AGPL-3.0-only) — the same license this repository uses.

Specifically adapted from Time Buddy:

- The named-connection data model (`{id, name, url, username}`, one connection per
  Grafana instance, selected/edited rather than a single global credential) —
  originally `public/js/storage.js`'s `grafanaConnections` store.
- The add/edit connection form's field layout and behavior — originally
  `public/js/connections.js`'s `showAddConnectionForm`/`editConnection`/`saveConnection`
  (name/URL/username fields, and leaving the password field blank on edit to keep the
  existing stored secret rather than re-displaying it).
- HTTP Basic auth (username/password) as a supported per-connection auth mode —
  originally `public/js/connections.js`'s `btoa(username:password)` header construction.

Deliberately **not** carried over: Time Buddy stores its connection list and cached
auth header in plaintext `localStorage`. This project's Electron app instead encrypts
every credential with `safeStorage` (OS keychain-backed) and never writes one to disk in
plaintext — see `electron/README.md`. This was easier to get right here than it might
sound: the app itself *is* the MCP server (launched with a `--mcp-server` flag instead of
opening a window), so the same in-process `safeStorage` call that encrypts a credential is
also the one that decrypts it for use, with no separate process and no hand-off file
needed in between. None of Time Buddy's query IDE, editor, AI-analytics, or charting code
was used; this repository only needed connection management.

Time Buddy is Copyright © Richard Kiene / Liquescent Development. See its repository for
full license text and authorship details.
