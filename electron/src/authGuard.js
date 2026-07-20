// Injecting a connection's Authorization header into an Electron session applies
// it to *every* request that session makes — including the off-host subresources
// a Grafana panel can pull in: an external <img> in a text panel, a CDN-served
// plugin, a gravatar avatar, a web font. With no check on the destination, the
// connection's raw bearer token (or base64 basic credentials) is transmitted
// verbatim to those third parties, and a dashboard an attacker can edit turns a
// single screenshot_panel / export_panel_csv call into token exfiltration.
//
// So header injection goes through this one helper rather than being wired up
// per call site: `resolveHeaders` is consulted only for requests whose origin the
// caller vouches for, and anything that fails to match — or whose URL doesn't
// parse — goes out with no injected headers at all.
//
// Origin, not host: URL.host carries hostname and port but *not* protocol, so
// matching on it attaches an https connection's token to a plaintext http://
// request to the same hostname, where anyone on-path reads it straight off the
// wire.

/** Origin of `url` ("https://host:port"), or null if it isn't a parseable absolute URL. */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Install the session's one onBeforeSendHeaders listener, injecting only the
 * headers `resolveHeaders(origin)` returns for that request's origin. Return
 * null/undefined from it to send the request unauthenticated.
 *
 * Electron allows a single onBeforeSendHeaders listener per session, so this
 * takes over the session's header handling entirely — don't add another.
 */
function attachAuthHeaders(ses, resolveHeaders) {
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const origin = originOf(details.url);
    if (!origin) {
      callback({});
      return;
    }
    let headers;
    try {
      headers = resolveHeaders(origin);
    } catch {
      // Misconfigured connection (e.g. bearer auth with no token saved yet) —
      // load without auth rather than tear down the whole session.
      callback({});
      return;
    }
    if (!headers) {
      callback({});
      return;
    }
    callback({ requestHeaders: { ...details.requestHeaders, ...headers } });
  });
}

module.exports = { originOf, attachAuthHeaders };
