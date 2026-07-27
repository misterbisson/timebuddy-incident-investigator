import { describe, expect, it } from 'vitest';
import { registerListFolderDashboards } from '../src/tools/listFolderDashboards.js';
import type { Config, GrafanaConnection } from '../src/config.js';
import type { GrafanaClient } from '../src/grafana/client.js';
import type { FolderInfo, SearchResultItem, ShortUrlInfo } from '../src/grafana/types.js';
import { fakeRegistry, fakeServer } from './toolTestHelpers.js';

const connections: GrafanaConnection[] = [
  { id: 'test', name: 'test', url: 'https://grafana.example.com', authType: 'bearer', token: 'x' },
];

function config(): Config {
  return {
    connections,
    tlsVerify: true,
    requestTimeoutMs: 1000,
    screenshotTimeoutMs: 45000,
    maxConcurrency: 4,
    maxLookbackHours: 720,
    maxDataPoints: 2000,
    redactionPatterns: [],
    dataDir: '/tmp/list-folder-dashboards-tool-test',
    webhookPort: 4318,
  };
}

function dashItem(uid: string, title: string, folderUid?: string): SearchResultItem {
  return { uid, title, type: 'dash-db', tags: [], folderUid, url: `/d/${uid}` };
}

function folderItem(uid: string, title: string, folderUid?: string): SearchResultItem {
  return { uid, title, type: 'dash-folder', tags: [], folderUid, url: `/dashboards/f/${uid}` };
}

/**
 * A folder tree:
 *   infra-status
 *     - dashboards: net-overview
 *     - subfolders: dns-team
 *         - dashboards: dns-detail
 *         - subfolders: (none)
 */
function fakeClient(opts: { resolveShortUrl?: ShortUrlInfo } = {}): GrafanaClient {
  const folders: Record<string, FolderInfo> = {
    'infra-status': { uid: 'infra-status', title: 'Infra status' },
    'dns-team': { uid: 'dns-team', title: 'DNS team', parentUid: 'infra-status' },
  };
  const dashboardsByFolder: Record<string, SearchResultItem[]> = {
    'infra-status': [dashItem('net-overview', 'Network overview', 'infra-status')],
    'dns-team': [dashItem('dns-detail', 'DNS detail', 'dns-team')],
  };
  const subfoldersByFolder: Record<string, SearchResultItem[]> = {
    'infra-status': [folderItem('dns-team', 'DNS team', 'infra-status')],
    'dns-team': [],
  };
  return {
    getFolder: async (uid: string) => {
      const f = folders[uid];
      if (!f) throw Object.assign(new Error('not found'), { status: 404 });
      return f;
    },
    searchDashboards: async ({ folderUid }: { folderUid?: string }) => dashboardsByFolder[folderUid ?? ''] ?? [],
    searchFolders: async ({ folderUid }: { folderUid?: string }) => subfoldersByFolder[folderUid ?? ''] ?? [],
    resolveShortUrl: async () => {
      if (!opts.resolveShortUrl) throw new Error('resolveShortUrl not stubbed');
      return opts.resolveShortUrl;
    },
  } as unknown as GrafanaClient;
}

describe('list_folder_dashboards tool', () => {
  it('lists direct dashboards and subfolders given a folderUid directly', async () => {
    const { server, call } = fakeServer();
    registerListFolderDashboards(server, { registry: fakeRegistry(connections, fakeClient()), config: config() });

    // schema's recursive default isn't applied here (fakeServer bypasses zod parsing) - pass it explicitly.
    const result = (await call('list_folder_dashboards', { folderUid: 'infra-status', connection: 'test', recursive: false })) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.folderUid).toBe('infra-status');
    expect(parsed.folderTitle).toBe('Infra status');
    expect(parsed.dashboards).toEqual([{ uid: 'net-overview', title: 'Network overview', tags: [], url: 'https://grafana.example.com/d/net-overview' }]);
    expect(parsed.dashboardsTotal).toBe(1);
    expect(parsed.subfolders).toEqual([{ uid: 'dns-team', title: 'DNS team', url: 'https://grafana.example.com/dashboards/f/dns-team' }]);
    expect(parsed.subfoldersTotal).toBe(1);
    expect(parsed.recursive).toBe(false);
    expect(parsed.foldersScanned).toBeUndefined();
  });

  it('resolves the folder uid and connection from a folder url', async () => {
    const { server, call } = fakeServer();
    registerListFolderDashboards(server, { registry: fakeRegistry(connections, fakeClient()), config: config() });

    const result = (await call('list_folder_dashboards', {
      url: 'https://grafana.example.com/dashboards/f/infra-status/infra-status?orgId=1',
    })) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.folderUid).toBe('infra-status');
  });

  it('resolves a /goto/<id> short-link to a folder link first', async () => {
    const { server, call } = fakeServer();
    registerListFolderDashboards(server, {
      registry: fakeRegistry(connections, fakeClient({ resolveShortUrl: { uid: 'AT76wBvGk', path: 'dashboards/f/infra-status/infra-status?orgId=1', lastSeenAt: 0 } })),
      config: config(),
    });

    const result = (await call('list_folder_dashboards', { url: 'https://grafana.example.com/goto/AT76wBvGk' })) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.folderUid).toBe('infra-status');
  });

  it('errors when given a dashboard url instead of a folder url', async () => {
    const { server, call } = fakeServer();
    registerListFolderDashboards(server, { registry: fakeRegistry(connections, fakeClient()), config: config() });

    const result = (await call('list_folder_dashboards', { url: 'https://grafana.example.com/d/net-overview/network-overview' })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/not a folder link/);
  });

  it('errors when neither url nor folderUid is provided', async () => {
    const { server, call } = fakeServer();
    registerListFolderDashboards(server, { registry: fakeRegistry(connections, fakeClient()), config: config() });

    const result = (await call('list_folder_dashboards', {})) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Must provide either "url"/);
  });

  it('recursive: true flattens every descendant dashboard, but subfolders stays direct-children-only', async () => {
    const { server, call } = fakeServer();
    registerListFolderDashboards(server, { registry: fakeRegistry(connections, fakeClient()), config: config() });

    const result = (await call('list_folder_dashboards', { folderUid: 'infra-status', connection: 'test', recursive: true })) as {
      content: Array<{ text: string }>;
    };
    const parsed = JSON.parse(result.content[0]!.text);

    expect(parsed.dashboards.map((d: { uid: string }) => d.uid).sort()).toEqual(['dns-detail', 'net-overview']);
    expect(parsed.dashboardsTotal).toBe(2);
    // Direct subfolders only, even recursively — dns-team has no subfolders of its own.
    expect(parsed.subfolders).toEqual([{ uid: 'dns-team', title: 'DNS team', url: 'https://grafana.example.com/dashboards/f/dns-team' }]);
    expect(parsed.recursive).toBe(true);
    expect(parsed.foldersScanned).toBe(2);
    expect(parsed.truncated).toBe(false);
  });
});
