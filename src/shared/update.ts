/**
 * A version Chrome has downloaded but not yet swapped in.
 *
 * Chrome stages an update and then waits for the extension to fall idle before
 * applying it. A worker that keeps waking — on a rule-list alarm, a proxy
 * error, a popup connecting — may never present the quiet moment Chrome is
 * waiting for, and a staged version can sit unapplied for days while the store
 * and the browser both believe the release went out.
 *
 * chrome.runtime.onUpdateAvailable is the only announcement of that state, it
 * fires once, and it fires at a worker that will not outlive the wait. So it is
 * written down here, and the options page reads it back.
 *
 * Nothing in Sockitt applies the update. Restarting the browser does, and that
 * is the user's to do: a reload timed by the extension could land in the middle
 * of a connection test, which holds the live proxy configuration and restores
 * it in a finally that a reload would never reach.
 */

/**
 * chrome.storage.local, not session: the whole point is to outlive the worker,
 * and the wait routinely outlives the browser session too.
 */
export const UPDATE_KEY = 'sockitt-update';

export interface PendingUpdate {
  /** The staged version, exactly as onUpdateAvailable named it. */
  version: string;
  /** When Chrome announced it. */
  at: number;
}

/**
 * '1.21.5' → [1, 21, 5].
 *
 * Extension versions are one to four dot-separated integers under 65536 and
 * nothing else, so anything else reads as null rather than as a version that
 * happens to sort low: Number('') is 0 and Number('x') is NaN, and either would
 * quietly answer a comparison instead of refusing it.
 */
function parseVersion(version: unknown): number[] | null {
  if (typeof version !== 'string') return null;
  const parts = version.split('.');
  if (parts.length > 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,5}$/.test(part)) return null;
    const n = Number(part);
    if (n > 65535) return null;
    out.push(n);
  }
  return out;
}

/**
 * Component-wise, with missing components reading as 0 — so 1.2.1 is newer than
 * 1.2, and 1.2 is not newer than 1.2.0. An unparseable version on either side
 * is never newer: the banner this gates is worth skipping, never worth guessing.
 */
export function isNewer(candidate: unknown, current: unknown): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * The stored record, if it still describes an update that hasn't landed.
 *
 * The version check is what makes the record self-healing. onInstalled clears
 * it when the update applies, but that event can be missed — Chrome can apply a
 * staged version during a shutdown, and the profile may next open on a build
 * that never saw the event. A record naming a version that is already running
 * simply doesn't answer, so a stale one cannot strand the banner on screen.
 */
export function readPendingUpdate(raw: unknown, running: unknown): PendingUpdate | null {
  if (!raw || typeof raw !== 'object') return null;
  const { version, at } = raw as { version?: unknown; at?: unknown };
  if (typeof version !== 'string' || !isNewer(version, running)) return null;
  return { version, at: typeof at === 'number' ? at : 0 };
}

/** The staged update, or null when the running version is already the latest. */
export async function loadPendingUpdate(): Promise<PendingUpdate | null> {
  try {
    const stored = await chrome.storage.local.get(UPDATE_KEY);
    return readPendingUpdate(stored[UPDATE_KEY], chrome.runtime.getManifest().version);
  } catch {
    return null; // a banner is never worth throwing a page over
  }
}

export async function savePendingUpdate(version: string): Promise<void> {
  const record: PendingUpdate = { version, at: Date.now() };
  await chrome.storage.local.set({ [UPDATE_KEY]: record }).catch(() => undefined);
}

export async function clearPendingUpdate(): Promise<void> {
  await chrome.storage.local.remove(UPDATE_KEY).catch(() => undefined);
}
