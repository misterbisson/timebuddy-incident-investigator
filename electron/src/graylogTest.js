/**
 * A "test connection" call, deliberately as narrow an allowlist as
 * src/graylog/client.ts on the server side: it only ever calls GET
 * /api/system, GET /api/streams, and GET /api/search/universal/absolute —
 * never a generic passthrough. Mirrors grafanaTest.js's shape.
 *
 * Three requests, not one:
 *  - /api/system works for any authenticated user (no stream-read permission
 *    needed), so it only proves the credentials authenticate.
 *  - /api/streams requires additional Graylog-side stream-read permission — a
 *    token can pass /api/system and still 403 here.
 *  - Even a token that passes both of the above can still 403 on
 *    /api/search/universal/absolute: some Graylog roles grant search
 *    permission scoped to individual streams but not the unscoped/"universal"
 *    search across all of them. GraylogClient.searchAbsolute() always hits
 *    that same endpoint, adding a `filter=streams:<id>` only when a streamId
 *    is available (the call's own, or this connection's configured default) —
 *    so a connection with no default streamId configured sends every
 *    search_logs/correlate_logs call that omits `streamId` out unscoped. This
 *    third probe exercises exactly the search shape this connection will
 *    actually use in production — scoped to its configured default stream if
 *    it has one, unscoped if it doesn't — rather than stopping at /api/streams
 *    and assuming search will work the same way.
 *
 * authType is 'token' | 'basic', not Grafana's 'bearer' | 'basic' — Graylog's
 * REST API doesn't accept a real `Authorization: Bearer` header for
 * API-token auth; its documented convention is HTTP Basic with the token as
 * the username and the literal string "token" as the password. 'basic' is a
 * real username/password login.
 */
async function testGraylogConnection({ url, authType, username, password, token, tlsVerify, streamId }) {
  if (!url) return { ok: false, status: 0, message: 'URL is required' };

  const headers = { Accept: 'application/json' };
  if (authType === 'basic') {
    if (!username || !password) return { ok: false, status: 0, message: 'Username and password are required' };
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  } else {
    if (!token) return { ok: false, status: 0, message: 'API token is required' };
    headers.Authorization = `Basic ${Buffer.from(`${token}:token`).toString('base64')}`;
  }

  let dispatcher;
  if (tlsVerify === false) {
    const { Agent } = require('undici');
    dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const base = url.replace(/\/+$/, '');
  const fetchOpts = { headers, signal: controller.signal, ...(dispatcher ? { dispatcher } : {}) };
  try {
    const systemResponse = await fetch(`${base}/api/system`, fetchOpts);
    if (!systemResponse.ok) {
      const text = await systemResponse.text().catch(() => '');
      return { ok: false, status: systemResponse.status, message: text.slice(0, 300) || systemResponse.statusText };
    }
    const system = await systemResponse.json();
    const detail = [system.hostname, system.version].filter(Boolean).join(' ');

    const streamsResponse = await fetch(`${base}/api/streams`, fetchOpts);
    if (!streamsResponse.ok) {
      const text = await streamsResponse.text().catch(() => '');
      return {
        ok: false,
        status: streamsResponse.status,
        message: `Authenticated to Graylog${detail ? ` (${detail})` : ''}, but lack permission to list streams (GET /api/streams: ${streamsResponse.status} ${text.slice(0, 200) || streamsResponse.statusText}). search_logs/list_log_sources/correlate_logs will fail the same way — check this token's Graylog role/permissions.`,
      };
    }
    const streams = await streamsResponse.json();
    const streamCount = Array.isArray(streams.streams) ? streams.streams.length : undefined;

    const now = Date.now();
    const searchQs = new URLSearchParams({
      query: '*',
      from: new Date(now - 5 * 60 * 1000).toISOString(),
      to: new Date(now).toISOString(),
      limit: '1',
      sort: 'timestamp:asc',
      fields: '_id,message,timestamp,source,*',
    });
    if (streamId) searchQs.set('filter', `streams:${streamId}`);
    const searchResponse = await fetch(`${base}/api/search/universal/absolute?${searchQs.toString()}`, fetchOpts);
    if (!searchResponse.ok) {
      const text = await searchResponse.text().catch(() => '');
      const scopeDetail = streamId
        ? `scoped to its configured default stream (${streamId})`
        : 'unscoped, since this connection has no default stream configured';
      const fix = streamId
        ? 'check that this token has search permission on that specific stream'
        : `configure a default stream on this connection (there ${streamCount === 1 ? 'is 1 stream' : `are ${streamCount ?? 'some'} streams`} visible to pick from above), or make sure every search_logs/correlate_logs call against it passes an explicit streamId`;
      return {
        ok: false,
        status: searchResponse.status,
        message: `Authenticated to Graylog${detail ? ` (${detail})` : ''} and can list streams, but a real search ${scopeDetail} failed (GET /api/search/universal/absolute: ${searchResponse.status} ${text.slice(0, 200) || searchResponse.statusText}). search_logs/correlate_logs will fail the same way — ${fix}.`,
      };
    }

    return {
      ok: true,
      status: searchResponse.status,
      message: `Connected to Graylog${detail ? ` (${detail})` : ''}${streamCount !== undefined ? ` — ${streamCount} stream(s) visible` : ''}`,
    };
  } catch (err) {
    return { ok: false, status: 0, message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { testGraylogConnection };
