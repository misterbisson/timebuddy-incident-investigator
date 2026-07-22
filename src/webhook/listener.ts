import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { loadConfig, type Config } from '../config.js';
import { storeWebhook } from './store.js';
import type { WebhookPayload } from '../alerts/ingest.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Constant-time compare of two secrets of unknown, possibly differing
 * length. timingSafeEqual throws outright on a length mismatch, and
 * returning early on that would itself leak the expected token's length —
 * so both sides are hashed to a fixed 32 bytes and the digests compared.
 */
function secretMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Checks the bearer token when one is configured. Deliberately runs before
 * any routing, so an unauthenticated caller learns nothing about the shape
 * of this service: with a token set, every request that doesn't carry it
 * gets the same 401 whatever its method or path.
 */
export function isAuthorized(req: IncomingMessage, config: Config): boolean {
  if (!config.webhookToken) return true;
  const header = req.headers.authorization;
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return secretMatches(match[1]!.trim(), config.webhookToken);
}

function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === 'localhost' || address === '::1';
}

/**
 * Minimal HTTP listener for a Grafana webhook contact point. Only accepts
 * POST / and appends the payload to the local alert store — it never talks
 * back to Grafana and has no other routes, so it can't be used to reach
 * anything beyond "record this alert for later retrieval".
 *
 * That bound is smaller than it sounds, which is why this binds loopback by
 * default (see Config.webhookBindAddress): whatever lands here is what a
 * no-argument `get_alert_context` later hands the investigating agent as the
 * incident to look into.
 *
 * There is deliberately no rate limit. On loopback it buys nothing, and for
 * a wider bind the shared secret is the control that matters — a limiter
 * would only bound how fast an *authorized* Grafana could write. The
 * unbounded growth of alerts.jsonl is tracked separately in #71.
 */
export function startWebhookListener(port: number, configOverride?: Config) {
  const config = configOverride ?? loadConfig();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Drain before replying on every early return: an unread request body
    // leaves the socket half-consumed, which surfaces to the client as a
    // connection reset rather than the status we just wrote.
    if (!isAuthorized(req, config)) {
      req.resume();
      res
        .writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' })
        .end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/') {
      req.resume();
      res.writeHead(404).end();
      return;
    }
    readBody(req)
      .then(async (raw) => {
        const payload = JSON.parse(raw) as WebhookPayload;
        if (!Array.isArray(payload.alerts)) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({ error: 'expected a Grafana Alertmanager webhook body with an "alerts" array' }),
          );
          return;
        }
        await storeWebhook(payload, config);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
      })
      .catch((err: unknown) => {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        );
      });
  });
  server.listen(port, config.webhookBindAddress, () => {
    const auth = config.webhookToken ? 'bearer token required' : 'no auth';
    console.error(
      `[webhook] listening on ${config.webhookBindAddress}:${port} (${auth}), ` +
        `writing to ${config.dataDir}/alerts.jsonl`,
    );
    if (!isLoopback(config.webhookBindAddress) && !config.webhookToken) {
      console.error(
        `[webhook] WARNING: bound to ${config.webhookBindAddress} with no WEBHOOK_TOKEN set. Anyone who can ` +
          'reach this port can inject alerts that get_alert_context will hand to the investigating agent.',
      );
    }
  });
  return server;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startWebhookListener(loadConfig().webhookPort);
}
