import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './registerAll.js';
import type { GrafanaClient } from '../grafana/client.js';
import type { SearchResultItem } from '../grafana/types.js';
import { parseGrafanaUrl } from '../alerts/urlParser.js';
import { dashboardUrlFor, folderUrlFor, resolveGotoUrl, resolveToolClient, toolErrorResult } from './shared.js';
import { redact } from '../security/redact.js';
import { withAudit } from '../security/audit.js';

const DEFAULT_LIMIT = 200;

/**
 * Safety backstop for the recursive walk below — a folder tree can't
 * genuinely cycle in Grafana, but an unbounded crawl over a huge/misconfigured
 * estate would still be unbounded work for one tool call. Same posture as
 * knowledge/folderWalk.ts's MAX_WALK_DEPTH: a cap that should never bind in
 * practice, reported via `truncated` when it does rather than silently
 * dropping folders.
 */
const MAX_FOLDERS_SCANNED = 500;

interface FolderContents {
  dashboards: SearchResultItem[];
  /** Direct children only, regardless of `recursive` — see listFolderContents' doc comment. */
  subfolders: SearchResultItem[];
  foldersScanned: number;
  truncated: boolean;
}

/**
 * Lists a folder's direct dashboards and subfolders — the same one level a
 * person sees opening this folder's browse page in Grafana. When `recursive`
 * is set, additionally walks every descendant folder (breadth-first) so
 * `dashboards` ends up flattened with every dashboard nested anywhere beneath
 * this folder, not just the direct ones; `subfolders` still reports only the
 * direct children either way, since that's the structural "what's in this one
 * folder" list, not the flattened content.
 */
async function listFolderContents(client: GrafanaClient, folderUid: string, recursive: boolean): Promise<FolderContents> {
  const [dashboards, subfolders] = await Promise.all([
    client.searchDashboards({ folderUid }),
    client.searchFolders({ folderUid }),
  ]);
  if (!recursive) {
    return { dashboards, subfolders, foldersScanned: 1, truncated: false };
  }

  const allDashboards = [...dashboards];
  const visited = new Set([folderUid]);
  const queue = subfolders.map((f) => f.uid);
  let foldersScanned = 1;
  let truncated = false;

  while (queue.length > 0) {
    const uid = queue.shift()!;
    if (visited.has(uid)) continue;
    visited.add(uid);
    if (foldersScanned >= MAX_FOLDERS_SCANNED) {
      truncated = true;
      break;
    }
    foldersScanned++;
    const [dash, subs] = await Promise.all([
      client.searchDashboards({ folderUid: uid }),
      client.searchFolders({ folderUid: uid }),
    ]);
    allDashboards.push(...dash);
    queue.push(...subs.map((f) => f.uid));
  }

  return { dashboards: allDashboards, subfolders, foldersScanned, truncated };
}

export function registerListFolderDashboards(server: McpServer, { registry, config }: ToolContext): void {
  server.registerTool(
    'list_folder_dashboards',
    {
      title: 'List folder dashboards',
      description:
        'Lists the dashboards (and subfolders) inside a Grafana folder - the MCP counterpart to opening a folder\'s ' +
        'browse page ("/dashboards/f/:uid/...") in Grafana. Pass a folder URL (connection auto-detected from its ' +
        'host, same as fetch_dashboard) or a folderUid + connection directly. A "/goto/<id>" share short-link is ' +
        'resolved to its canonical link first, transparently; a dead/pruned one errors distinctly from an ' +
        'unrecognized URL. By default only this folder\'s direct contents are returned - "subfolders" always lists ' +
        'direct children only, regardless of "recursive". Pass recursive: true to also walk every descendant folder ' +
        'and flatten every dashboard found anywhere beneath this one into "dashboards" (the crawl itself is capped ' +
        'for safety on a very large subtree - check "foldersScanned"/"truncated" before assuming full coverage). ' +
        'Each dashboard/subfolder carries a clickable url. Use this when you only have a folder link (e.g. from a ' +
        'runbook or wiki) and need to find the specific dashboard inside it, or to survey what a folder contains ' +
        'without already knowing a dashboard/panel/metric name to search find_related_dashboards for.',
      inputSchema: {
        url: z.string().optional().describe('A Grafana folder URL ("/dashboards/f/:uid/...")'),
        folderUid: z.string().optional().describe('Folder UID, when not passing url'),
        recursive: z.boolean().optional().default(false).describe('Also walk every descendant folder, flattening every dashboard found anywhere beneath this one into "dashboards"'),
        limit: z.number().optional().default(DEFAULT_LIMIT).describe('Max dashboards and max subfolders to return; see dashboardsTotal/subfoldersTotal for the untruncated counts'),
        connection: z.string().optional().describe('Connection id to use, when multiple Grafana connections are configured'),
      },
      annotations: { readOnlyHint: true, title: 'List folder dashboards' },
    },
    async ({ url, folderUid: inputFolderUid, recursive, limit, connection }) => {
      let resolvedConnectionId: string | undefined;
      let resolvedFolderUid: string | undefined;
      try {
        return await withAudit('list_folder_dashboards', { url, folderUid: inputFolderUid, recursive }, config, async () => {
          const { client, connectionId } = resolveToolClient(registry, { connection, hintUrl: url });
          resolvedConnectionId = connectionId;

          let folderUid = inputFolderUid;
          if (url) {
            const resolvedUrl = await resolveGotoUrl(registry, client, connectionId, url);
            const parsed = parseGrafanaUrl(resolvedUrl);
            if (parsed.type !== 'folder') {
              throw new Error(
                `"${url}" is a ${parsed.type} link, not a folder link - list_folder_dashboards needs a ` +
                  '"/dashboards/f/:uid/..." folder URL.',
              );
            }
            folderUid = parsed.uid;
          }
          if (!folderUid) {
            throw new Error('Must provide either "url" (a folder link) or "folderUid".');
          }
          resolvedFolderUid = folderUid;

          const [folder, contents] = await Promise.all([
            client.getFolder(folderUid),
            listFolderContents(client, folderUid, recursive),
          ]);

          const result = {
            folderUid: folder.uid,
            folderTitle: folder.title,
            parentUid: folder.parentUid,
            url: folderUrlFor(registry, connectionId, folder.uid),
            dashboards: contents.dashboards.slice(0, limit).map((d) => ({
              uid: d.uid,
              title: d.title,
              tags: d.tags,
              url: dashboardUrlFor(registry, connectionId, d.uid),
            })),
            dashboardsTotal: contents.dashboards.length,
            subfolders: contents.subfolders.slice(0, limit).map((f) => ({
              uid: f.uid,
              title: f.title,
              url: folderUrlFor(registry, connectionId, f.uid),
            })),
            subfoldersTotal: contents.subfolders.length,
            recursive,
            ...(recursive ? { foldersScanned: contents.foldersScanned, truncated: contents.truncated } : {}),
          };
          return { content: [{ type: 'text' as const, text: JSON.stringify(redact(result, config.redactionPatterns)) }] };
        });
      } catch (err) {
        const errorUrl = resolvedConnectionId && resolvedFolderUid ? folderUrlFor(registry, resolvedConnectionId, resolvedFolderUid) : undefined;
        return toolErrorResult(err, config, errorUrl);
      }
    },
  );
}
