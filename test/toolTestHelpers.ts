import { vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { ConnectionRegistry } from '../src/grafana/registry.js';
import type { GraylogClient } from '../src/graylog/client.js';
import type { LogConnectionRegistry } from '../src/graylog/registry.js';
import type { GrafanaConnection, LogConnection } from '../src/config.js';
import type { DashboardGetResponse, DsQueryRequest, DsQueryResponse } from '../src/grafana/types.js';
import type { GraylogMessageWrapper, GraylogStream } from '../src/graylog/types.js';

/** Captures a tool's registered handler so it can be invoked directly, without spinning up a real MCP server/transport. */
export function fakeServer(): { server: McpServer; call: (name: string, args: unknown) => Promise<unknown> } {
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: (args: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  return {
    server,
    call: async (name, args) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`No tool registered as "${name}"`);
      return handler(args);
    },
  };
}

export function fakeRegistry(connections: GrafanaConnection[], client: GrafanaClient): ConnectionRegistry {
  return { list: () => connections, get: () => client } as unknown as ConnectionRegistry;
}

export function fakeLogRegistry(connections: LogConnection[], client: GraylogClient): LogConnectionRegistry {
  return { list: () => connections, get: () => client } as unknown as LogConnectionRegistry;
}

export function tagValuesResponse(values: string[]): DsQueryResponse {
  return {
    results: {
      variable: {
        frames: [
          {
            schema: { fields: [{ name: 'key', type: 'string' }, { name: 'value', type: 'string' }] },
            data: { values: [values.map(() => 'target_host'), values] },
          },
        ],
      },
    },
  };
}

function numberSeriesResponse(refId: string, points: Array<[number, number]>): DsQueryResponse {
  return {
    results: {
      [refId]: {
        frames: [
          {
            schema: { refId, fields: [{ name: 'time', type: 'time' }, { name: 'value', type: 'number' }] },
            data: { values: [points.map((p) => p[0]), points.map((p) => p[1])] },
          },
        ],
      },
    },
  };
}

/**
 * A GrafanaClient stub that answers "SHOW TAG VALUES"-shaped queryDs calls
 * (the live variable-resolution path) with liveValues, and everything else
 * with a trivial one-point numeric series — enough to exercise a tool's full
 * resolve-and-execute path without a real Grafana instance.
 */
export function fakeGrafanaClient(opts: {
  dashboard: DashboardGetResponse;
  liveValues?: string[];
}): { client: GrafanaClient; queryDs: ReturnType<typeof vi.fn>; listDatasources: ReturnType<typeof vi.fn> } {
  const queryDs = vi.fn(async (req: DsQueryRequest) => {
    const target = req.queries[0]!;
    if (target.refId === 'variable') {
      return tagValuesResponse(opts.liveValues ?? []);
    }
    return numberSeriesResponse(target.refId, [[req.from ? Number(req.from) : 0, 1]]);
  });
  const listDatasources = vi.fn(async () => [{ uid: 'influx1', id: 1, name: 'InfluxDB', type: 'influxdb' }]);
  const client = {
    getDashboard: vi.fn(async () => opts.dashboard),
    queryDs,
    listDatasources,
  } as unknown as GrafanaClient;
  return { client, queryDs, listDatasources };
}

/**
 * A GraylogClient stub — searchAbsolute answers with a fixed message list
 * (or a per-selector map, keyed by the `query` param, for correlate_logs
 * tests that need different streams to return different events) and
 * listStreams answers with a fixed stream list. Enough to exercise a log
 * tool's full resolve-and-execute path without a real Graylog instance.
 */
export function fakeGraylogClient(opts: {
  messages?: GraylogMessageWrapper[];
  messagesBySelector?: Record<string, GraylogMessageWrapper[]>;
  streams?: GraylogStream[];
}): { client: GraylogClient; searchAbsolute: ReturnType<typeof vi.fn>; listStreams: ReturnType<typeof vi.fn> } {
  const searchAbsolute = vi.fn(async (params: { query: string }) => {
    const messages = opts.messagesBySelector ? (opts.messagesBySelector[params.query] ?? []) : (opts.messages ?? []);
    return { messages, total_results: messages.length };
  });
  const listStreams = vi.fn(async () => opts.streams ?? []);
  const client = { searchAbsolute, listStreams } as unknown as GraylogClient;
  return { client, searchAbsolute, listStreams };
}
