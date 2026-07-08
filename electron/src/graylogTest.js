/**
 * A "test connection" call for a Graylog log connection, same rationale as
 * grafanaTest.js: as narrow an allowlist as src/graylog/client.ts on the
 * server side. Uses GET /api/system, which only needs an authenticated
 * session/token and no stream-read permission — the least-privileged real
 * endpoint that still proves the credential actually works.
 */
async function testGraylogConnection({ url, authType, username, password, token, tlsVerify }) {
  if (!url) return { ok: false, status: 0, message: 'URL is required' };

  const headers = { Accept: 'application/json' };
  if (authType === 'basic') {
    if (!username || !password) return { ok: false, status: 0, message: 'Username and password are required' };
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  } else {
    if (!token) return { ok: false, status: 0, message: 'Token is required' };
    headers.Authorization = `Bearer ${token}`;
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
    return { ok: true, status: response.status, message: `Connected to Graylog ${system.version ?? ''}`.trim() };
  } catch (err) {
    return { ok: false, status: 0, message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { testGraylogConnection };
