/**
 * A "test connection" call, deliberately as narrow an allowlist as
 * src/graylog/client.ts on the server side: it only ever calls GET
 * /api/system (works for any authenticated user, no stream-read permission
 * needed) — never a generic passthrough. Mirrors grafanaTest.js's shape.
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
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/api/system`, {
      headers,
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, status: response.status, message: text.slice(0, 300) || response.statusText };
    }
    const system = await response.json();
    const detail = [system.hostname, system.version].filter(Boolean).join(' ');
    return { ok: true, status: response.status, message: `Connected to Graylog${detail ? ` (${detail})` : ''}` };
  } catch (err) {
    return { ok: false, status: 0, message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { testGraylogConnection };
