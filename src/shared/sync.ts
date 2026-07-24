import { sanitizeConfig, saveConfigRaw } from './state';
import { Config } from './types';

/**
 * Mirror the config over chrome.storage.sync. sync items are capped (~8 KB
 * each, ~100 KB total), so the JSON is split into chunks under a meta record
 * carrying the revision. Conflicts resolve last-write-wins by `config.rev`
 * (a local ms timestamp bumped on every UI save).
 */
const META = 'sockitt#meta';
const CHUNK = 'sockitt#';
const CHUNK_SIZE = 7000;
const SYNC_ERROR_KEY = 'sockitt-sync-error';

interface SyncMeta {
  rev: number;
  chunks: number;
}

let lastPushedRev = 0;
let lastAppliedRev = 0;

export async function pushToSync(config: Config): Promise<void> {
  if (config.rev <= lastPushedRev || config.rev === lastAppliedRev) return;
  const json = JSON.stringify(config);
  const items: Record<string, unknown> = {};
  let chunks = 0;
  for (let i = 0; i < json.length; i += CHUNK_SIZE) {
    items[`${CHUNK}${chunks++}`] = json.slice(i, i + CHUNK_SIZE);
  }
  items[META] = { rev: config.rev, chunks } satisfies SyncMeta;
  try {
    await chrome.storage.sync.set(items);
    lastPushedRev = config.rev;
    await chrome.storage.session.remove(SYNC_ERROR_KEY).catch(() => undefined);
  } catch (e) {
    await chrome.storage.session
      .set({ [SYNC_ERROR_KEY]: { message: e instanceof Error ? e.message : String(e) } })
      .catch(() => undefined);
  }
}

export async function pullFromSync(localRev: number): Promise<Config | null> {
  try {
    const metaStore = await chrome.storage.sync.get(META);
    const meta = metaStore[META] as SyncMeta | undefined;
    if (!meta || typeof meta.rev !== 'number' || meta.rev <= localRev) return null;
    const keys = Array.from({ length: meta.chunks }, (_, i) => `${CHUNK}${i}`);
    const chunkStore = await chrome.storage.sync.get(keys);
    let json = '';
    for (const key of keys) {
      const part = chunkStore[key];
      if (typeof part !== 'string') return null; // partial write — skip
      json += part;
    }
    const config = sanitizeConfig(JSON.parse(json));
    if (!config) return null;
    config.rev = meta.rev;
    return config;
  } catch {
    return null;
  }
}

/**
 * Apply a newer remote config to local storage. Records the applied revision
 * so the resulting local change doesn't get pushed straight back out.
 */
export async function applyFromSync(config: Config): Promise<void> {
  lastAppliedRev = config.rev;
  await saveConfigRaw(config);
}

/** Fires when another device pushed a newer revision. */
export function onSyncChanged(fn: (remoteRev: number) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes[META]) return;
    const meta = changes[META].newValue as SyncMeta | undefined;
    if (meta && typeof meta.rev === 'number' && meta.rev !== lastPushedRev) fn(meta.rev);
  });
}

export async function clearSync(): Promise<void> {
  try {
    const all = await chrome.storage.sync.get(null);
    const keys = Object.keys(all).filter((k) => k === META || k.startsWith(CHUNK));
    if (keys.length) await chrome.storage.sync.remove(keys);
  } catch {
    // sync unavailable — nothing to clear
  }
}
