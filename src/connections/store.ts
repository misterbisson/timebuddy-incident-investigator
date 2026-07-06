import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config, GrafanaConnection } from '../config.js';

interface StoredConnectionMeta {
  id: string;
  name: string;
  url: string;
  authType: 'bearer' | 'basic';
  username?: string;
  matchHosts?: string[];
  tlsVerify?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface ConnectionsFile {
  version: 1;
  connections: StoredConnectionMeta[];
}

type StoredCredential =
  | { authType: 'bearer'; token: string }
  | { authType: 'basic'; username: string; password: string };

interface CredentialsFile {
  version: 1;
  credentials: Record<string, StoredCredential>;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Reads the connection-manager app's connections.json + credentials.json
 * (see electron/src/connectionStore.ts for the writer side) and merges them
 * into GrafanaConnection objects. Missing files mean "no connection store
 * configured yet" — not an error — so this returns [] rather than throwing.
 */
export async function loadConnectionsFromDisk(config: Config): Promise<GrafanaConnection[]> {
  const [connectionsFile, credentialsFile] = await Promise.all([
    readJson<ConnectionsFile>(join(config.connectionsDir, 'connections.json')),
    readJson<CredentialsFile>(join(config.connectionsDir, 'credentials.json')),
  ]);
  if (!connectionsFile) return [];

  const credentials = credentialsFile?.credentials ?? {};
  return connectionsFile.connections.map((meta) => {
    const cred = credentials[meta.id];
    return {
      id: meta.id,
      name: meta.name,
      url: meta.url.replace(/\/+$/, ''),
      authType: meta.authType,
      username: cred?.authType === 'basic' ? cred.username : meta.username,
      password: cred?.authType === 'basic' ? cred.password : undefined,
      token: cred?.authType === 'bearer' ? cred.token : undefined,
      matchHosts: meta.matchHosts,
      tlsVerify: meta.tlsVerify,
    };
  });
}
