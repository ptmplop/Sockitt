import { sanitizeConfig, saveConfigRaw } from './state';
import { CONFIG_VERSION, Config, Profile, schemeSupportsAuth } from './types';

/**
 * Mirror the config over chrome.storage.sync. sync items are capped (~8 KB
 * each, ~100 KB total), so:
 *   - Rule-list bodies are excluded when they can be refetched from a URL, and
 *     large pasted bodies are dropped too, keeping the payload small.
 *   - Proxy credentials are excluded on principle, not size: they never leave
 *     the device (see PRIVACY.md); each machine keeps its own copy.
 *   - The remaining JSON is split into byte-bounded chunks (never mid-codepoint)
 *     under a meta record carrying the revision.
 *   - Every push first checks the remote revision and refuses to overwrite a
 *     newer one, so an offline/stale device can't clobber fresher data.
 * Conflicts otherwise resolve last-write-wins by `config.rev` (a local ms
 * timestamp bumped on every UI save).
 */
const META = 'sockitt#meta';
const CHUNK = 'sockitt#';
const MAX_ITEM_BYTES = 7000; // headroom under the 8192-byte per-item quota
const INLINE_TEXT_MAX = 8000; // pasted lists this small still sync
export const SYNC_ERROR_KEY = 'sockitt-sync-error';

interface SyncMeta {
  rev: number;
  chunks: number;
  /** Config schema version of the payload; absent = pre-v3 install. */
  version?: number;
}

const encoder = new TextEncoder();

let lastPushedRev = 0;
let lastAppliedRev = 0;

/**
 * Strip what must not travel: rule-list bodies that other devices can refetch
 * (or that are too big), and proxy credentials — PRIVACY.md promises those
 * never leave the device, so each machine keeps its own copy (restored from
 * the local config in applyFromSync, like rule-list text).
 */
export function slimConfig(config: Config): Config {
  const profiles: Profile[] = config.profiles.map((p) => {
    if (p.kind === 'proxy') {
      return p.username !== undefined || p.password !== undefined
        ? { ...p, username: undefined, password: undefined }
        : p;
    }
    if (p.kind !== 'rulelist') return p;
    const keepText = !p.url && p.text.length <= INLINE_TEXT_MAX;
    return { ...p, text: keepText ? p.text : '' };
  });
  return { ...config, profiles };
}

/** Split into chunks whose UTF-8 size stays under MAX_ITEM_BYTES, never mid-codepoint. */
function chunkByBytes(str: string): string[] {
  const chunks: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of str) {
    const b = encoder.encode(ch).length;
    if (curBytes + b > MAX_ITEM_BYTES && cur) {
      chunks.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function recordError(e: unknown): Promise<void> {
  await chrome.storage.session
    .set({ [SYNC_ERROR_KEY]: { message: e instanceof Error ? e.message : String(e), at: Date.now() } })
    .catch(() => undefined);
}

async function clearError(): Promise<void> {
  await chrome.storage.session.remove(SYNC_ERROR_KEY).catch(() => undefined);
}

export async function pushToSync(config: Config): Promise<void> {
  if (config.rev <= lastPushedRev || config.rev === lastAppliedRev) return;
  try {
    const metaStore = await chrome.storage.sync.get(META);
    const remote = metaStore[META] as SyncMeta | undefined;
    if (remote && typeof remote.rev === 'number') {
      const remoteVersion = remote.version ?? 2;
      // A NEWER-schema remote must never be overwritten: our payload would
      // lack fields its devices rely on. Pause until this machine updates.
      if (remoteVersion > CONFIG_VERSION) {
        lastPushedRev = config.rev; // don't keep retrying until the next edit
        await recordError(
          new Error(
            'Sync paused: another device runs a newer Sockitt version — update this one to resume.'
          )
        );
        return;
      }
      // A version-less remote (Sockitt ≤ 1.6.2) may mean pre-gate devices are
      // still alive; they adopt anything we push and their sanitizer would
      // strip newer fields, destroying their local config. Hard stop.
      if (remoteVersion < 3) {
        lastPushedRev = config.rev;
        await recordError(
          new Error(
            'Sync paused: a device running Sockitt 1.6.2 or older wrote the synced data. Update every device, then toggle Sync off and on here to resume.'
          )
        );
        return;
      }
      // remoteVersion 3..CONFIG_VERSION: those are gated builds — overwriting
      // is safe (an older gated build pauses until updated rather than
      // adopting), and it is exactly how the remote migrates to this schema.
      // The normal newest-wins rule still applies.
      if (remote.rev > config.rev) {
        lastPushedRev = config.rev; // don't keep retrying this stale push
        return;
      }
    }

    const chunks = chunkByBytes(JSON.stringify(slimConfig(config)));
    const items: Record<string, unknown> = {
      [META]: { rev: config.rev, chunks: chunks.length, version: CONFIG_VERSION },
    };
    chunks.forEach((c, i) => (items[`${CHUNK}${i}`] = c));
    await chrome.storage.sync.set(items);

    // Remove orphan chunks left by an earlier, larger push.
    const oldCount = remote?.chunks ?? 0;
    const stale: string[] = [];
    for (let i = chunks.length; i < oldCount; i++) stale.push(`${CHUNK}${i}`);
    if (stale.length) await chrome.storage.sync.remove(stale);

    lastPushedRev = config.rev;
    await clearError();
  } catch (e) {
    await recordError(e);
  }
}

/**
 * What the remote holds: nothing, a payload this build can adopt (same or
 * older schema — older upgrades safely through sanitize), or one written by a
 * NEWER schema, which the enable-sync join flow must treat as a hard stop:
 * adopting it would strip fields, and pushing over it would gut the fleet.
 */
export async function remoteSyncState(): Promise<'none' | 'compatible' | 'incompatible'> {
  try {
    const metaStore = await chrome.storage.sync.get(META);
    const meta = metaStore[META] as SyncMeta | undefined;
    if (!meta || typeof meta.rev !== 'number') return 'none';
    return (meta.version ?? 2) <= CONFIG_VERSION ? 'compatible' : 'incompatible';
  } catch {
    return 'none';
  }
}

export async function pullFromSync(localRev: number): Promise<Config | null> {
  try {
    const metaStore = await chrome.storage.sync.get(META);
    const meta = metaStore[META] as SyncMeta | undefined;
    if (!meta || typeof meta.rev !== 'number' || meta.rev <= localRev) return null;
    // Never adopt a payload from a NEWER schema: this build's sanitizer would
    // strip fields it doesn't know and could push the gutted config back.
    // OLDER payloads are safe in this direction — sanitizeConfig fills in
    // whatever the old schema lacked — and adopting them is how a freshly
    // updated device stays current until the whole fleet migrates.
    if ((meta.version ?? 2) > CONFIG_VERSION) {
      await recordError(
        new Error(
          'Sync paused: another device runs a newer Sockitt version — update this one to resume.'
        )
      );
      return null;
    }
    const keys = Array.from({ length: meta.chunks }, (_, i) => `${CHUNK}${i}`);
    const chunkStore = await chrome.storage.sync.get(keys);
    let json = '';
    for (const key of keys) {
      const part = chunkStore[key];
      if (typeof part !== 'string') return null; // partial write — skip this round
      json += part;
    }
    const config = sanitizeConfig(JSON.parse(json));
    if (!config) return null;
    config.rev = meta.rev;
    // A good pull supersedes any lingering "sync paused" notice.
    await clearError();
    return config;
  } catch {
    return null;
  }
}

/**
 * Apply a newer remote config to local storage. Fields that were stripped for
 * sync are restored from the local copy (matched by id): rule-list bodies so
 * a pull never wipes a locally-fetched list (anything still empty refetches
 * on its own alarm), and proxy credentials, which deliberately never travel.
 * Records the applied revision so the resulting local change isn't pushed
 * straight back out.
 */
export async function applyFromSync(remote: Config, local: Config): Promise<void> {
  const localText = new Map<string, string>();
  const localCreds = new Map<string, { username?: string; password?: string }>();
  for (const p of local.profiles) {
    if (p.kind === 'rulelist' && p.text) localText.set(p.id, p.text);
    if (p.kind === 'proxy' && (p.username || p.password)) {
      localCreds.set(p.id, { username: p.username, password: p.password });
    }
  }
  for (const p of remote.profiles) {
    if (p.kind === 'rulelist' && !p.text) {
      const text = localText.get(p.id);
      if (text) p.text = text;
    }
    if (p.kind === 'proxy' && p.username === undefined && p.password === undefined) {
      const cred = localCreds.get(p.id);
      if (cred && schemeSupportsAuth(p.scheme)) {
        p.username = cred.username;
        p.password = cred.password;
      }
    }
  }
  lastAppliedRev = remote.rev;
  await saveConfigRaw(remote);
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
    lastPushedRev = 0;
  } catch {
    // sync unavailable — nothing to clear
  }
}
