import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadConfig } from '../config.js';
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
 * Minimal HTTP listener for a Grafana webhook contact point. Only accepts
 * POST / and appends the payload to the local alert store — it never talks
 * back to Grafana and has no other routes, so it can't be used to reach
 * anything beyond "record this alert for later retrieval".
 */
export function startWebhookListener(port: number) {
  const config = loadConfig();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/') {
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
  server.listen(port, () => {
    console.error(`[webhook] listening on :${port}, writing to ${config.dataDir}/alerts.jsonl`);
  });
  return server;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startWebhookListener(loadConfig().webhookPort);
}
