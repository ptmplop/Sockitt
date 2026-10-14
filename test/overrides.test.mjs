import assert from 'node:assert/strict';
import { test, before, beforeEach } from 'node:test';
import { build } from 'esbuild';

let lib;

/** In-memory stand-in for chrome.storage.session, with a settable read hook. */
const store = new Map();
let onGet = null;
let writes = 0;

globalThis.chrome = {
  storage: {
    session: {
      get: async (keys) => {
        if (onGet) await onGet();
        const list = typeof keys === 'string' ? [keys] : keys;
        const out = {};
        for (const k of list) if (store.has(k)) out[k] = structuredClone(store.get(k));
        return out;
      },
      set: async (items) => {
        writes++;
        for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
      },
    },
  },
};

before(async () => {
  const result = await build({
    stdin: {
      contents:
        "export { addTempRule, removeTempRule, loadTempRules } from './src/shared/state'; export { overrideFor, resolveRoute } from './src/shared/match';",
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
  onGet = null;
  writes = 0;
});

const override = (id, host, targetId) => ({ id, enabled: true, type: 'hostWildcard', pattern: `*.${host}`, targetId });
const ids = (rules) => rules.map((r) => r.id);

const P1 = { kind: 'proxy', id: 'p1', name: 'Tokyo', color: '#46c9e5', scheme: 'socks5', host: '203.0.113.7', port: 1080, bypass: [] };
const P2 = { kind: 'proxy', id: 'p2', name: 'Berlin', color: '#6d5dfc', scheme: 'socks5', host: '198.51.100.3', port: 9050, bypass: [] };
const AUTO = {
  kind: 'switch', id: 'sw', name: 'Auto', color: '#ffb020', defaultTargetId: 'direct',
  rules: [{ id: 'perm', enabled: true, type: 'hostWildcard', pattern: '*.slack.com', targetId: 'p1' }],
};
const CONFIG = { version: 4, rev: 0, activeId: 'sw', profiles: [P1, P2, AUTO], settings: {} };

/** What the popup reads for a tab, and what the traffic for it actually takes. */
function onPage(rules, host) {
  const url = `https://${host}/`;
  return { shown: lib.overrideFor(rules, url, host)?.id, routedBy: lib.resolveRoute(CONFIG, AUTO, url, host, rules).ruleId };
}

test('an override is shown only on a site it covers', () => {
  const rules = [override('gh', 'github.com', 'p2')];
  assert.equal(onPage(rules, 'github.com').shown, 'gh');
  // Regression: 1.26.0 showed this override on every tab, as though it covered them.
  assert.equal(onPage(rules, 'news.example.com').shown, undefined);
  assert.equal(onPage(rules, 'news.example.com').routedBy, undefined);
  // `*.github.com` does cover its subdomains, so there it is this site's override.
  assert.deepEqual(onPage(rules, 'gist.github.com'), { shown: 'gh', routedBy: 'gh' });
});

test('the override shown is the one the traffic takes', () => {
  const rules = [override('sub', 'sub.example.com', 'p1'), override('parent', 'example.com', 'p2')];
  assert.deepEqual(onPage(rules, 'sub.example.com'), { shown: 'sub', routedBy: 'sub' });
  assert.deepEqual(onPage(rules, 'www.example.com'), { shown: 'parent', routedBy: 'parent' });
  // A disabled rule routes nothing, so it must not be shown as standing in.
  const off = [{ ...override('off', 'example.com', 'p2'), enabled: false }];
  assert.deepEqual(onPage(off, 'www.example.com'), { shown: undefined, routedBy: undefined });
});

test('setting an override on a second site keeps the first', async () => {
  await lib.addTempRule('sw', 'regular', override('gh', 'github.com', 'p2'));
  const saved = await lib.addTempRule('sw', 'regular', override('sl', 'slack.com', 'direct'));
  // Regression: one slot per profile meant the second site's override replaced the first.
  assert.deepEqual(ids(saved), ['gh', 'sl']);
  assert.deepEqual(ids(await lib.loadTempRules('sw', 'regular')), ['gh', 'sl']);
  const rules = await lib.loadTempRules('sw', 'regular');
  assert.deepEqual(onPage(rules, 'github.com'), { shown: 'gh', routedBy: 'gh' });
  assert.deepEqual(onPage(rules, 'app.slack.com'), { shown: 'sl', routedBy: 'sl' });
});

test('a broader override set later does not take a site from a narrower one', async () => {
  await lib.addTempRule('sw', 'regular', override('sub', 'sub.example.com', 'p1'));
  await lib.addTempRule('sw', 'regular', override('parent', 'example.com', 'p2'));
  const rules = await lib.loadTempRules('sw', 'regular');
  assert.deepEqual(onPage(rules, 'sub.example.com'), { shown: 'sub', routedBy: 'sub' });
  assert.deepEqual(onPage(rules, 'example.com'), { shown: 'parent', routedBy: 'parent' });
});

test('setting the same pattern again replaces it where it stands', async () => {
  await lib.addTempRule('sw', 'regular', override('sub', 'sub.example.com', 'p1'));
  await lib.addTempRule('sw', 'regular', override('parent', 'example.com', 'p2'));
  // Moved to the end, the new one would sit behind `*.example.com` and never match.
  const saved = await lib.addTempRule('sw', 'regular', override('sub2', 'sub.example.com', 'p2'));
  assert.deepEqual(ids(saved), ['sub2', 'parent']);
  assert.deepEqual(onPage(saved, 'sub.example.com'), { shown: 'sub2', routedBy: 'sub2' });
});

test('removing an override leaves every other site its own', async () => {
  await lib.addTempRule('sw', 'regular', override('gh', 'github.com', 'p2'));
  await lib.addTempRule('sw', 'regular', override('sl', 'slack.com', 'direct'));
  assert.deepEqual(ids(await lib.removeTempRule('sw', 'regular', 'gh')), ['sl']);
  assert.deepEqual(ids(await lib.loadTempRules('sw', 'regular')), ['sl']);
  // The last one out takes the slot with it rather than leaving an empty list.
  assert.deepEqual(await lib.removeTempRule('sw', 'regular', 'sl'), []);
  assert.deepEqual(store.get('sockitt-temp'), {});
});

/** Another window's write, straight to storage: this module never saw it. */
function writeBehind(key, rule) {
  const map = store.get('sockitt-temp') ?? {};
  store.set('sockitt-temp', { ...map, [key]: [...(map[key] ?? []), rule] });
}

test('each change starts from what is stored, not from the caller’s copy', async () => {
  await lib.addTempRule('sw', 'regular', override('gh', 'github.com', 'p2'));
  writeBehind('regular:sw', override('x', 'x.test', 'p1'));
  // A change made here has to keep that write rather than save a stale list over it.
  await lib.addTempRule('sw', 'regular', override('sl', 'slack.com', 'direct'));
  assert.deepEqual(ids(await lib.loadTempRules('sw', 'regular')), ['gh', 'x', 'sl']);
  writeBehind('regular:sw', override('y', 'y.test', 'p2'));
  await lib.removeTempRule('sw', 'regular', 'gh');
  assert.deepEqual(ids(await lib.loadTempRules('sw', 'regular')), ['x', 'sl', 'y']);
});

test('the two scopes and other profiles keep their overrides apart', async () => {
  await lib.addTempRule('sw', 'regular', override('gh', 'github.com', 'p2'));
  await lib.addTempRule('sw', 'incognito', override('inc', 'github.com', 'p1'));
  await lib.addTempRule('other', 'regular', override('x', 'github.com', 'direct'));
  assert.deepEqual(ids(await lib.loadTempRules('sw', 'regular')), ['gh']);
  assert.deepEqual(ids(await lib.loadTempRules('sw', 'incognito')), ['inc']);
  await lib.removeTempRule('sw', 'incognito', 'inc');
  assert.deepEqual(ids(await lib.loadTempRules('sw', 'regular')), ['gh']);
  assert.deepEqual(ids(await lib.loadTempRules('other', 'regular')), ['x']);
});

test('a failed read changes nothing, rather than saving over every override', async () => {
  await lib.addTempRule('sw', 'regular', override('gh', 'github.com', 'p2'));
  const before = writes;
  onGet = async () => {
    throw new Error('storage unavailable');
  };
  await assert.rejects(lib.addTempRule('sw', 'regular', override('sl', 'slack.com', 'direct')));
  await assert.rejects(lib.removeTempRule('sw', 'regular', 'gh'));
  assert.equal(writes, before);
  onGet = null;
  assert.deepEqual(ids(await lib.loadTempRules('sw', 'regular')), ['gh']);
});
