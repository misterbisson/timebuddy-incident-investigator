/**
 * A "test connection" call, deliberately as narrow an allowlist as
 * src/graylog/client.ts on the server side: it only ever calls GET
 * /api/system and GET /api/streams — never a generic passthrough. Mirrors
 * grafanaTest.js's shape.
 *
 * Two requests, not one: /api/system works for any authenticated user (no
 * stream-read permission needed), so it only proves the credentials
 * authenticate — it does NOT prove search_logs/list_log_sources/
 * correlate_logs will work, since those call /api/search/universal/absolute
 * and /api/streams, which require additional Graylog-side stream-read
 * permission. A token can pass /api/system and still 403 on every real
 * query. So this also probes /api/streams (the same endpoint
 * GraylogClient.listStreams() uses) to catch that gap here instead of
 * leaving it to surface confusingly during an actual investigation.
 *
 * authType is 'token' | 'basic', not Grafana's 'bearer' | 'basic' — Graylog's
 * REST API doesn't accept a real `Authorization: Bearer` header for
 * API-token auth; its documented convention is HTTP Basic with the token as
 * the username and the literal string "token" as the password. 'basic' is a
 * real username/password login.
 */
async function testGraylogConnection({ url, authType, username, password, token, tlsVerify }) {
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
    return {
      ok: true,
      status: streamsResponse.status,
      message: `Connected to Graylog${detail ? ` (${detail})` : ''}${streamCount !== undefined ? ` — ${streamCount} stream(s) visible` : ''}`,
    };
  } catch (err) {
    return { ok: false, status: 0, message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { testGraylogConnection };
