import { describe, expect, it } from 'vitest';
// Plain CommonJS with no `electron` import of its own (the session is a
// parameter), so it's unit-testable here without spawning the real binary.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { originOf, attachAuthHeaders } = require('../electron/src/authGuard.js');

/** Minimal stand-in for an Electron session: captures the one listener and replays requests through it. */
function fakeSession() {
  let listener: ((details: { url: string }, cb: (r: Record<string, unknown>) => void) => void) | undefined;
  return {
    webRequest: {
      onBeforeSendHeaders(fn: typeof listener) {
        listener = fn;
      },
    },
    /** Returns the headers that would actually go out for `url`, or undefined when none were injected. */
    send(url: string): Record<string, string> | undefined {
      let result: Record<string, string> | undefined;
      listener!({ url }, (r) => {
        result = r.requestHeaders as Record<string, string> | undefined;
      });
      return result;
    },
  };
}

const TOKEN = { Authorization: 'Bearer supersecret' };

describe('originOf', () => {
  it('returns the origin, and null for unparseable input', () => {
    expect(originOf('https://grafana.internal/d/abc?x=1')).toBe('https://grafana.internal');
    expect(originOf('https://grafana.internal:3000/d/abc')).toBe('https://grafana.internal:3000');
    expect(originOf('not a url')).toBeNull();
  });
});

describe('attachAuthHeaders', () => {
  const target = 'https://grafana.internal';
  const guarded = () => {
    const ses = fakeSession();
    attachAuthHeaders(ses, (origin: string) => (origin === target ? TOKEN : null));
    return ses;
  };

  it('injects the header for the vouched-for origin', () => {
    expect(guarded().send('https://grafana.internal/api/ds/query')).toMatchObject(TOKEN);
  });

  it('does not leak the token to a third-party subresource', () => {
    // The exfiltration path: a text panel with an external <img>.
    expect(guarded().send('https://attacker.example/pixel.png')).toBeUndefined();
  });

  it('does not send an https token over plaintext http to the same hostname', () => {
    // The `URL.host === host` comparison this replaced matched here, because
    // host carries hostname and port but not protocol.
    expect(guarded().send('http://grafana.internal/api/ds/query')).toBeUndefined();
  });

  it('treats a different port as a different origin', () => {
    expect(guarded().send('https://grafana.internal:3000/api/ds/query')).toBeUndefined();
  });

  it('sends nothing when the request URL does not parse', () => {
    expect(guarded().send('not a url')).toBeUndefined();
  });

  it('falls back to unauthenticated when resolveHeaders throws', () => {
    // buildAuthHeader throws for a connection with no token saved yet; that
    // must not tear down the whole live-view session.
    const ses = fakeSession();
    attachAuthHeaders(ses, () => {
      throw new Error('no token saved');
    });
    expect(ses.send('https://grafana.internal/api/ds/query')).toBeUndefined();
  });
});
