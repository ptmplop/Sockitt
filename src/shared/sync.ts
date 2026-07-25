import { loadConfig, sanitizeConfig, saveConfigRaw } from './state';
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
// chrome.storage.sync caps each item at 8192 bytes, measured as
// key.length + JSON.stringify(value).length (UTF-8). Our chunk value is a slice
// of already-serialized config JSON; storing it re-escapes the slice — every "
// and \ DOUBLES and non-ASCII becomes \uXXXX — so a quote-dense structural
// chunk can nearly double. Budget by that SERIALIZED cost (jsonByteCost), not
// the raw byte size, or a large config overflows the quota and the whole push
// fails. Slack below the 8192 cap covers the "sockitt#NN" key and the value's
// two enclosing quotes.
const MAX_ITEM_BYTES = 8192;
const CHUNK_BUDGET = MAX_ITEM_BYTES - 200;
export const INLINE_TEXT_MAX = 8000; // pasted lists this small still sync
export const SYNC_ERROR_KEY = 'sockitt-sync-error';

interface SyncMeta {
  rev: number;
  chunks: number;
  /** Config schema version of the payload; absent = pre-v3 install. */
  version?: number;
}

let lastPushedRev = 0;
let lastAppliedRev = 0;

const PAUSE_NEWER =
  'Sync paused: another device runs a newer Sockitt version — update this one to resume.';
const PAUSE_LEGACY =
  'Sync paused: a device running Sockitt 1.6.2 or older wrote the synced data. Update every device, then toggle Sync off and on here to resume.';

export type PushDecision =
  | { action: 'push' }
  | { action: 'skip' } // stale/no-op — silent
  | { action: 'pause'; reason: string };

/**
 * Pure version/rev gate for a push (no I/O). `remote` is the current remote
 * meta (undefined = empty account). Get this direction right or you freeze sync
 * or wipe the fleet — see the CONFIG_VERSION notes in types.ts.
 */
export function decidePush(
  remote: SyncMeta | undefined,
  configRev: number,
  configVersion: number
): PushDecision {
  if (!remote || typeof remote.rev !== 'number') return { action: 'push' };
  const remoteVersion = remote.version ?? 2;
  // A NEWER-schema remote must never be overwritten — our payload would lack
  // fields its devices rely on.
  if (remoteVersion > configVersion) return { action: 'pause', reason: PAUSE_NEWER };
  // A version-less remote (Sockitt ≤ 1.6.2) has no gate and would adopt+strip
  // anything we push, destroying its local config. Hard stop.
  if (remoteVersion < 3) return { action: 'pause', reason: PAUSE_LEGACY };
  // 3..configVersion are gated builds: overwriting is safe and is how the remote
  // migrates up. Otherwise the normal newest-wins rule applies.
  if (remote.rev > configRev) return { action: 'skip' };
  return { action: 'push' };
}

export type PullDecision =
  | { action: 'adopt' }
  | { action: 'skip' }
  | { action: 'pause'; reason: string };

/** Pure version/rev gate for a pull (no I/O). */
export function decidePull(
  meta: SyncMeta | undefined,
  localRev: number,
  configVersion: number
): PullDecision {
  if (!meta || typeof meta.rev !== 'number' || meta.rev <= localRev) return { action: 'skip' };
  // Never adopt a NEWER schema: this build's sanitizer would strip fields it
  // doesn't know and could push the gutted config back. OLDER is safe.
  if ((meta.version ?? 2) > configVersion) return { action: 'pause', reason: PAUSE_NEWER };
  return { action: 'adopt' };
}

/**
 * Compatibility of the remote payload for the enable-sync join flow. Must agree
 * with decidePush on which remotes are usable: a NEWER schema (adopting strips
 * fields) and a version-LESS remote (≤ 1.6.2, which decidePush hard-stops on)
 * are both unjoinable — otherwise the join adopts a payload the push path then
 * refuses, stranding the machine. 'legacy' vs 'newer' lets the UI say which.
 */
export function remoteCompatibility(
  meta: SyncMeta | undefined,
  configVersion: number
): 'none' | 'compatible' | 'legacy' | 'newer' {
  if (!meta || typeof meta.rev !== 'number') return 'none';
  const version = meta.version ?? 2;
  if (version < 3) return 'legacy';
  if (version > configVersion) return 'newer';
  return 'compatible';
}

/** Join ordered chunk values; null if any chunk is missing (a partial write). */
export function reassembleChunks(keys: string[], store: Record<string, unknown>): string | null {
  let json = '';
  for (const key of keys) {
    const part = store[key];
    if (typeof part !== 'string') return null;
    json += part;
  }
  return json;
}

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

/**
 * Bytes `ch` costs inside a stored JSON string value. Conservative: matches
 * JSON.stringify's `"`/`\`/control escaping and counts every non-ASCII code
 * point at its worst-case `\uXXXX` size (12 for an astral pair), since the
 * writer that measures the quota escapes non-ASCII. Over-counting only shrinks
 * chunks, which stays safely under the cap; under-counting would overflow it.
 */
function jsonByteCost(ch: string): number {
  if (ch === '"' || ch === '\\') return 2;
  const cp = ch.codePointAt(0)!;
  if (cp < 0x20) return ch === '\n' || ch === '\r' || ch === '\t' || ch === '\b' || ch === '\f' ? 2 : 6;
  if (cp < 0x7f) return 1; // printable ASCII
  return cp < 0x10000 ? 6 : 12; // non-ASCII escaped as \uXXXX (surrogate pair for astral)
}

/**
 * Split into chunks whose stored JSON-serialized value stays under the per-item
 * quota, never breaking a code point. Sized by serialized cost, not raw UTF-8,
 * because the value is re-escaped when stored (see CHUNK_BUDGET).
 */
export function chunkByBytes(str: string): string[] {
  const chunks: string[] = [];
  let cur = '';
  let cost = 0;
  for (const ch of str) {
    const c = jsonByteCost(ch);
    if (cost + c > CHUNK_BUDGET && cur) {
      chunks.push(cur);
      cur = '';
      cost = 0;
    }
    cur += ch;
    cost += c;
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
    const decision = decidePush(remote, config.rev, CONFIG_VERSION);
    if (decision.action !== 'push') {
      lastPushedRev = config.rev; // don't keep retrying a paused/stale push
      if (decision.action === 'pause') await recordError(new Error(decision.reason));
      return;
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
export async function remoteSyncState(): Promise<'none' | 'compatible' | 'legacy' | 'newer'> {
  try {
    const metaStore = await chrome.storage.sync.get(META);
    return remoteCompatibility(metaStore[META] as SyncMeta | undefined, CONFIG_VERSION);
  } catch {
    return 'none';
  }
}

export async function pullFromSync(localRev: number): Promise<Config | null> {
  try {
    const metaStore = await chrome.storage.sync.get(META);
    const meta = metaStore[META] as SyncMeta | undefined;
    const decision = decidePull(meta, localRev, CONFIG_VERSION);
    if (decision.action === 'skip') return null;
    if (decision.action === 'pause') {
      await recordError(new Error(decision.reason));
      return null;
    }
    // decidePull returned 'adopt', so meta is a valid SyncMeta.
    const adopted = meta as SyncMeta;
    const keys = Array.from({ length: adopted.chunks }, (_, i) => `${CHUNK}${i}`);
    const chunkStore = await chrome.storage.sync.get(keys);
    const json = reassembleChunks(keys, chunkStore);
    if (json === null) return null; // partial write — skip this round
    const config = sanitizeConfig(JSON.parse(json));
    if (!config) return null;
    config.rev = adopted.rev;
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
export async function applyFromSync(
  remote: Config,
  local: Config,
  opts: { force?: boolean } = {}
): Promise<void> {
  // Newest-rev-wins guard for the automatic pull: a UI save can land between the
  // pull's rev check and this write, so re-read storage and bail if local is now
  // newer than the remote we pulled (its own applyActive will push it out). The
  // explicit enable-sync JOIN passes force to adopt the remote regardless of rev
  // (skipping would leave storage stale while the UI shows the remote adopted).
  if (!opts.force) {
    const current = await loadConfig().catch(() => null);
    if (current && current.rev > remote.rev) return;
  }
  // Restore device-local fields (credentials and list bodies stripped for sync)
  // from the caller's in-memory `local` — the freshest copy on the join path,
  // where the options page's config can lead its debounced save to storage, so a
  // just-pasted list body or just-typed password would otherwise be lost.
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
