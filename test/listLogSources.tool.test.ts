import { describe, expect, it } from 'vitest';
import { registerListLogSources } from '../src/tools/listLogSources.js';
import type { Config, LogConnection } from '../src/config.js';
import { fakeGraylogClient, fakeLogRegistry, fakeServer } from './toolTestHelpers.js';

const connections: LogConnection[] = [
  {
    id: 'log1',
    name: 'log1-prod',
    sourceType: 'graylog',
    url: 'https://graylog.example.com',
    authType: 'token',
    token: 'x',
    tags: ['prod', 'us-east'],
    streamId: 'default-stream',
    streamName: 'APIGW 5xx',
  },
  { id: 'log2', name: 'log2-staging', sourceType: 'graylog', url: 'https://graylog-staging.example.com', authType: 'basic', username: 'a', password: 'b' },
];

function config(overrides: Partial<Config> = {}): Config {
  return {
    connections: [],
    logConnections: connections,
    tlsVerify: true,
    requestTimeoutMs: 1000,
    screenshotTimeoutMs: 45000,
    maxConcurrency: 4,
    maxLookbackHours: 720,
    maxDataPoints: 2000,
    maxLogLines: 500,
    redactionPatterns: [],
    dataDir: '.data',
    webhookPort: 4318,
    ...overrides,
  };
}

describe('list_log_sources tool', () => {
  it('lists every configured connection with id/name/tags/stream info, and no streams when "connection" is omitted', async () => {
    const { client } = fakeGraylogClient({ streams: [] });
    const { server, call } = fakeServer();
    registerListLogSources(server, { logRegistry: fakeLogRegistry(connections, client), config: config() } as never);

    const result = (await call('list_log_sources', {})) as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0]!.text);

    expect(body.sources).toEqual([
      { id: 'log1', name: 'log1-prod', sourceType: 'graylog', tags: ['prod', 'us-east'], streamId: 'default-stream', streamName: 'APIGW 5xx' },
      { id: 'log2', name: 'log2-staging', sourceType: 'graylog', tags: undefined, streamId: undefined, streamName: undefined },
    ]);
    expect(body.streams).toBeUndefined();
  });

  it('also lists that connection\'s streams when "connection" is given', async () => {
    const { client } = fakeGraylogClient({ streams: [{ id: 's1', title: 'APIGW 5xx' }, { id: 's2', title: 'Auth errors' }] });
    const { server, call } = fakeServer();
    registerListLogSources(server, { logRegistry: fakeLogRegistry(connections, client), config: config() } as never);

    const result = (await call('list_log_sources', { connection: 'log1' })) as { content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0]!.text);

    expect(body.streams).toEqual([{ id: 's1', title: 'APIGW 5xx' }, { id: 's2', title: 'Auth errors' }]);
  });

  it('returns an error result for an unknown connection id rather than silently listing nothing', async () => {
    const { client } = fakeGraylogClient({ streams: [] });
    const { server, call } = fakeServer();
    registerListLogSources(server, { logRegistry: fakeLogRegistry(connections, client), config: config() } as never);

    const result = (await call('list_log_sources', { connection: 'bogus' })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Unknown connection id "bogus"/);
  });
});
