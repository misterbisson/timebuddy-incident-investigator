/**
 * A "test connection" call, deliberately as narrow an allowlist as
 * src/grafana/client.ts on the server side: it only ever calls GET /api/org
 * (works for any authenticated role, including Viewer) — never a generic
 * passthrough.
 */
async function testConnection({ url, authType, username, password, token, tlsVerify }) {
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
    const response = await fetch(`${url.replace(/\/+$/, '')}/api/org`, {
      headers,
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, status: response.status, message: text.slice(0, 300) || response.statusText };
    }
    const org = await response.json();
    return { ok: true, status: response.status, message: `Connected as org "${org.name}"` };
  } catch (err) {
    return { ok: false, status: 0, message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { testConnection };
