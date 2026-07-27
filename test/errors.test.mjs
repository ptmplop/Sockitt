import assert from 'node:assert/strict';
import { test, before, beforeEach } from 'node:test';
import { build } from 'esbuild';

let lib;

/** In-memory stand-in for chrome.storage.session, with a settable write hook. */
const store = new Map();
let onSet = null;

globalThis.chrome = {
  storage: {
    session: {
      get: async (keys) => {
        const list = typeof keys === 'string' ? [keys] : keys;
        const out = {};
        for (const k of list) if (store.has(k)) out[k] = structuredClone(store.get(k));
        return out;
      },
      set: async (items) => {
        if (onSet) await onSet();
        for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
      },
      remove: async (keys) => {
        for (const k of typeof keys === 'string' ? [keys] : keys) store.delete(k);
      },
    },
  },
};

before(async () => {
  const result = await build({
    stdin: {
      contents: "export * from './src/shared/errors';",
      resolveDir: new URL('..', import.meta.url).pathname,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    write: false,
  });
  lib = await import(
    'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
  );
});

beforeEach(() => {
  store.clear();
  onSet = null;
});

const FAIL = {
  source: 'proxy',
  error: 'net::ERR_PROXY_CONNECTION_FAILED',
  details: '',
  fatal: true,
  profileId: 'p1',
  profileName: 'Bangkok',
  via: { id: 'p1', name: 'Bangkok', endpoint: 'SOCKS5 203.0.113.7:1080' },
};

test('identical repeats collapse into one entry, and the streak keeps counting', async () => {
  const { recordProxyError, loadErrorLog } = lib;
  await recordProxyError({ ...FAIL, at: 1000 });
  await recordProxyError({ ...FAIL, at: 2000 });
  const alert = await recordProxyError({ ...FAIL, at: 3000 });

  const log = await loadErrorLog();
  assert.equal(log.length, 1, 'a dead proxy must not flood the log');
  assert.equal(log[0].count, 3);
  assert.equal(log[0].at, 1000, 'the entry keeps the time it started');
  assert.equal(log[0].lastAt, 3000);
  assert.equal(alert.streak, 3);
  assert.equal(alert.fatalStreak, true);
});

test('a collapsed repeat carries the newest route, not the one it started with', async () => {
  const { recordProxyError, loadErrorLog } = lib;
  await recordProxyError({ ...FAIL, at: 1000 });
  // The user corrects the port and it still fails: same failure recurring, so
  // it collapses — but the entry must now name the address in force today.
  await recordProxyError({
    ...FAIL,
    at: 2000,
    profileName: 'Bangkok (fixed)',
    via: { id: 'p1', name: 'Bangkok', endpoint: 'SOCKS5 203.0.113.7:1081' },
  });

  const [entry] = await loadErrorLog();
  assert.equal(entry.count, 2);
  assert.equal(entry.at, 1000, 'the entry still says when the run started');
  assert.equal(entry.via.endpoint, 'SOCKS5 203.0.113.7:1081', 'but points at the current address');
  assert.equal(entry.profileName, 'Bangkok (fixed)');
});

test('severity accumulates across a collapse — a fatal line is never relabelled a warning', async () => {
  const { recordProxyError, loadErrorLog } = lib;
  await recordProxyError({ ...FAIL, fatal: true, at: 1000 });
  await recordProxyError({ ...FAIL, fatal: false, at: 2000 });
  assert.equal((await loadErrorLog())[0].fatal, true);
});

test('a candidate set that changed is replaced, not kept stale', async () => {
  const { recordProxyError, loadErrorLog } = lib;
  const base = { ...FAIL, via: undefined, profileId: 'sw', profileName: 'Auto routing' };
  await recordProxyError({ ...base, at: 1000, candidates: [{ id: 'a', name: 'A', endpoint: 'SOCKS5 a:1' }] });
  await recordProxyError({ ...base, at: 2000, candidates: [{ id: 'c', name: 'C', endpoint: 'SOCKS5 c:3' }] });
  const [entry] = await loadErrorLog();
  assert.equal(entry.count, 2, 'still the same failure');
  assert.deepEqual(entry.candidates.map((c) => c.id), ['c'], 'named against the route as it is now');
});

test('an apply failure keeps its thrown reason reachable for the UI', async () => {
  const { errorHeadline, errorSummaryLine } = lib;
  // background.ts puts the message in BOTH fields: `error` is the collapse key,
  // `details` is what the surfaces render under the generic headline.
  const entry = { ...FAIL, source: 'apply', error: 'net::ERR_FAILED at set()', details: 'net::ERR_FAILED at set()' };
  assert.equal(errorHeadline(entry), 'Could not apply the proxy settings');
  assert.equal(errorSummaryLine(entry), 'Could not apply the proxy settings — net::ERR_FAILED at set()');
});

test('a one-line summary folds in the detail and stays short enough for a tooltip', () => {
  const { errorSummaryLine } = lib;
  assert.equal(errorSummaryLine(FAIL), 'net::ERR_PROXY_CONNECTION_FAILED', 'no detail, no separator');
  const long = { ...FAIL, details: 'x'.repeat(400) };
  const line = errorSummaryLine(long);
  assert.equal(line.length, 120);
  assert.ok(line.endsWith('…'));
  // A detail identical to the headline is not repeated back at the user.
  assert.equal(errorSummaryLine({ ...FAIL, details: FAIL.error }), FAIL.error);
});

test('a different failure opens a new entry but continues the same incident', async () => {
  const { recordProxyError, loadErrorLog } = lib;
  await recordProxyError({ ...FAIL, at: 1000 });
  const alert = await recordProxyError({ ...FAIL, error: 'net::ERR_PAC_SCRIPT_FAILED', at: 2000 });

  const log = await loadErrorLog();
  assert.equal(log.length, 2);
  assert.equal(log[0].error, 'net::ERR_PAC_SCRIPT_FAILED', 'newest first');
  assert.equal(log[0].count, 1);
  assert.equal(alert.streak, 2, 'the streak spans different codes — it counts the incident');
});

test('clearing the alert restarts the streak but keeps the history', async () => {
  const { recordProxyError, clearProxyAlert, loadErrorLog, loadProxyAlert } = lib;
  await recordProxyError({ ...FAIL, at: 1000 });
  await recordProxyError({ ...FAIL, at: 2000 });
  await clearProxyAlert();

  assert.equal(await loadProxyAlert(), null);
  assert.equal((await loadErrorLog()).length, 1, 'the log outlives the incident');

  const alert = await recordProxyError({ ...FAIL, at: 90_000 });
  assert.equal(alert.streak, 1, 'a failure after a quiet spell is a new incident');
  assert.equal((await loadErrorLog())[0].count, 3, 'but it still collapses onto the same entry');
});

test('a non-fatal error alone never raises the fatal (badge-painting) flag', async () => {
  const { recordProxyError } = lib;
  const warn = await recordProxyError({ ...FAIL, fatal: false, at: 1000 });
  assert.equal(warn.fatalStreak, false);
  const then = await recordProxyError({ ...FAIL, fatal: true, error: 'net::ERR_X', at: 2000 });
  assert.equal(then.fatalStreak, true, 'one fatal in the run is enough');
  const after = await recordProxyError({ ...FAIL, fatal: false, error: 'net::ERR_Y', at: 3000 });
  assert.equal(after.fatalStreak, true, 'and it stays raised for the rest of the run');
});

test('the log is capped, newest kept', async () => {
  const { recordProxyError, loadErrorLog, MAX_ERROR_ENTRIES } = lib;
  for (let i = 0; i < MAX_ERROR_ENTRIES + 10; i++) {
    await recordProxyError({ ...FAIL, error: `net::ERR_${i}`, at: 1000 + i });
  }
  const log = await loadErrorLog();
  assert.equal(log.length, MAX_ERROR_ENTRIES);
  assert.equal(log[0].error, `net::ERR_${MAX_ERROR_ENTRIES + 9}`);
});

test('concurrent reports are serialized — none is lost to a read-modify-write race', async () => {
  const { recordProxyError, loadErrorLog } = lib;
  // Make every write take a turn of the event loop, the window in which
  // interleaved read-modify-writes would clobber each other.
  onSet = () => new Promise((r) => setTimeout(r, 0));
  const alerts = await Promise.all(
    Array.from({ length: 12 }, (_, i) => recordProxyError({ ...FAIL, error: `net::ERR_${i}`, at: 1000 + i }))
  );
  const log = await loadErrorLog();
  assert.equal(log.length, 12, 'every distinct failure survives');
  assert.deepEqual(
    alerts.map((a) => a.streak),
    Array.from({ length: 12 }, (_, i) => i + 1),
    'and the streak counts each exactly once'
  );
});

test('badge text shows a count only once it adds information, and saturates', () => {
  const { badgeTextFor } = lib;
  assert.equal(badgeTextFor(1), '!');
  assert.equal(badgeTextFor(2), '!2');
  assert.equal(badgeTextFor(9), '!9');
  assert.equal(badgeTextFor(10), '!9+');
  assert.equal(badgeTextFor(4000), '!9+');
});

test('a record written by an older version is discarded, not rendered', async () => {
  const { asProxyAlert, loadProxyAlert, ERROR_KEY } = lib;
  // Pre-1.9 shape: {message, at, fatal} — no `error`, so nothing to headline.
  assert.equal(asProxyAlert({ message: 'net::ERR_PROXY_CONNECTION_FAILED', at: 1, fatal: true }), null);
  store.set(ERROR_KEY, { message: 'boom', at: 1, fatal: true });
  assert.equal(await loadProxyAlert(), null);
});

test('a malformed log survives loading, dropping only the bad rows', async () => {
  const { loadErrorLog, ERROR_LOG_KEY } = lib;
  store.set(ERROR_LOG_KEY, [
    { ...FAIL, at: 1000 },
    null,
    { nonsense: true },
    { ...FAIL, at: 2000, count: -4, candidates: ['not a ref'] },
  ]);
  const log = await loadErrorLog();
  assert.equal(log.length, 2);
  assert.equal(log[1].count, 1, 'a nonsense count falls back to one');
  assert.equal(log[1].candidates, undefined, 'and non-refs are dropped rather than rendered');
});

test('advice is matched on the code, and unknown codes get none rather than a guess', () => {
  const { errorAdvice } = lib;
  assert.match(errorAdvice({ ...FAIL, error: 'net::ERR_PROXY_CONNECTION_FAILED' }), /could not reach/i);
  assert.match(errorAdvice({ ...FAIL, error: 'ERR_SOCKS_CONNECTION_HOST_UNREACHABLE' }), /destination host/i);
  assert.match(errorAdvice({ ...FAIL, source: 'apply', error: 'anything' }), /previous route is still in force/i);
  assert.equal(errorAdvice({ ...FAIL, error: 'net::ERR_SOMETHING_NEW' }), null);
});

test('a plain proxy is not rendered as a hop through itself', () => {
  const { describeCarrier, viaIsSelf } = lib;
  assert.equal(viaIsSelf(FAIL), true);
  assert.equal(describeCarrier(FAIL), 'Bangkok — SOCKS5 203.0.113.7:1080');
  const viaSwitch = { ...FAIL, profileId: 'sw', profileName: 'Auto routing' };
  assert.equal(describeCarrier(viaSwitch), 'Auto routing → Bangkok — SOCKS5 203.0.113.7:1080');
});

test('the copied report names the servers and never carries a credential', () => {
  const { formatErrorReport } = lib;
  const entry = { ...FAIL, id: 'e1', at: 1000, lastAt: 5000, count: 4 };
  const report = formatErrorReport([entry], { ...entry, streak: 4, fatalStreak: true }, '1.9.0');
  assert.match(report, /v1\.9\.0/);
  assert.match(report, /SOCKS5 203\.0\.113\.7:1080/);
  assert.match(report, /×4/);
  assert.match(report, /status: failing/);
  // Entries carry no credential field at all, so this can only ever hold.
  assert.doesNotMatch(report, /password|username/i);
});
