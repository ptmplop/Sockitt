import assert from 'node:assert/strict';
import { test, before, beforeEach } from 'node:test';
import { build } from 'esbuild';

/**
 * The dashboard's session timeline, and specifically that its appends are
 * serialized.
 *
 * Each append is a read-modify-write on session storage, and nothing stops two
 * applies from overlapping — a config change and a temp-rule change both call
 * applyActive, and neither waits for the other. Interleaved, they would read
 * the same log, and the second write would land on top of the first.
 */

let lib;

/** In-memory chrome.storage.session with a hook that can stall a write. */
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
      contents:
        "export { recordActivation, loadHistory, HISTORY_KEY, MAX_HISTORY } from './src/shared/state';",
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

const ids = async () => (await lib.loadHistory()).map((e) => e.id);

test('a switch is appended', async () => {
  await lib.recordActivation('work', 1000);
  assert.deepEqual(await ids(), ['work']);
});

test('re-applying the same profile does not append again', async () => {
  // The worker re-applies on rule edits, permission grants and its own
  // restarts. None of those is a switch, and a timeline of zero-width segments
  // is not a record of anything.
  await lib.recordActivation('work', 1000);
  await lib.recordActivation('work', 1200);
  await lib.recordActivation('work', 1400);
  assert.deepEqual(await ids(), ['work']);
});

test('switching away and back records both legs', async () => {
  await lib.recordActivation('work', 1000);
  await lib.recordActivation('direct', 2000);
  await lib.recordActivation('work', 3000);
  assert.deepEqual(await ids(), ['work', 'direct', 'work']);
});

test('overlapping appends do not lose an entry', async () => {
  // The regression this serialization exists for: stall the first write long
  // enough that a second append would, unserialized, read the pre-write log.
  let firstWrite = true;
  onSet = async () => {
    if (!firstWrite) return;
    firstWrite = false;
    await new Promise((r) => setTimeout(r, 30));
  };
  await Promise.all([lib.recordActivation('work', 1000), lib.recordActivation('direct', 1010)]);
  assert.deepEqual(await ids(), ['work', 'direct']);
});

test('a burst of overlapping appends keeps every distinct switch, in order', async () => {
  onSet = () => new Promise((r) => setTimeout(r, 3));
  const order = ['a', 'b', 'c', 'd', 'e', 'f'];
  await Promise.all(order.map((id, i) => lib.recordActivation(id, 1000 + i)));
  assert.deepEqual(await ids(), order);
});

test('the same-profile skip still holds under concurrency', async () => {
  onSet = () => new Promise((r) => setTimeout(r, 3));
  await Promise.all([
    lib.recordActivation('work', 1000),
    lib.recordActivation('work', 1001),
    lib.recordActivation('work', 1002),
  ]);
  assert.deepEqual(await ids(), ['work']);
});

test('the log is capped, dropping oldest first', async () => {
  for (let i = 0; i < lib.MAX_HISTORY + 12; i++) {
    await lib.recordActivation(`p${i}`, 1000 + i);
  }
  const log = await lib.loadHistory();
  assert.equal(log.length, lib.MAX_HISTORY);
  // Newest survives, oldest fell off the front.
  assert.equal(log[log.length - 1].id, `p${lib.MAX_HISTORY + 11}`);
  assert.equal(log[0].id, 'p12');
});

test('a storage failure is swallowed rather than thrown at the worker', async () => {
  onSet = () => Promise.reject(new Error('session storage unavailable'));
  await lib.recordActivation('work', 1000);
  assert.deepEqual(await ids(), []);
  // …and the chain is not poisoned: the next append still works.
  onSet = null;
  await lib.recordActivation('direct', 2000);
  assert.deepEqual(await ids(), ['direct']);
});

test('malformed stored entries are dropped on read', async () => {
  store.set(lib.HISTORY_KEY, [{ id: 'ok', at: 1 }, { id: 5 }, null, 'nope', { at: 2 }]);
  assert.deepEqual(await ids(), ['ok']);
});
