import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { build } from 'esbuild';

/**
 * The route a rule list's own URL is fetched through, as the editor states it
 * under the URL field. Chrome routes that fetch by whatever proxy setting is in
 * force (measured in real Chromium), so this must agree with the resolver the
 * PAC twin uses — including overrides, aliases, bypass lists, a list deciding
 * its own address, and Chrome's own rule that local addresses never use a proxy.
 */

let lib;

before(async () => {
  const result = await build({
    stdin: {
      contents: "export * from './src/shared/listroute';",
      resolveDir: new URL('..', import.meta.url).pathname,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    write: false,
  });
  lib = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
});

const work = { id: 'p-work', kind: 'proxy', name: 'Work SOCKS5', color: '#3b82f6', scheme: 'socks5', host: 'proxy.corp.io', port: 1080, bypass: ['<local>', '*.intranet'] };
const home = { id: 'p-home', kind: 'proxy', name: 'Home VPS', color: '#2dd4a7', scheme: 'socks5', host: '198.51.100.24', port: 1080, bypass: [] };
const office = {
  id: 'p-office', kind: 'switch', name: 'Office routing', color: '#6d5dfc', defaultTargetId: 'direct',
  rules: [
    { id: 'r0', enabled: false, type: 'hostWildcard', pattern: 'raw.githubusercontent.com', targetId: 'p-work' },
    { id: 'r1', enabled: true, type: 'hostWildcard', pattern: '*.github.com', targetId: 'p-work' },
    { id: 'r2', enabled: true, type: 'hostWildcard', pattern: 'raw.githubusercontent.com', targetId: 'p-home' },
  ],
};
const list = (text, match = 'p-home') => ({
  id: 'p-list', kind: 'rulelist', name: 'Blocked sites', color: '#ffb020', format: 'switchy',
  url: 'https://raw.githubusercontent.com/example/lists/main/blocked.txt', updateIntervalH: 24,
  matchTargetId: match, defaultTargetId: 'direct', text,
});
const URL_ = 'https://raw.githubusercontent.com/example/lists/main/blocked.txt';
const cfg = (activeId, profiles) => ({ version: 4, rev: 1, activeId, profiles, settings: {} });

test('Direct and System are named as the active profile; a missing one falls back to System', () => {
  assert.deepEqual(lib.listFetchRoute(cfg('direct', [work]), URL_), { targetId: 'direct', why: 'Direct is the active profile' });
  assert.deepEqual(lib.listFetchRoute(cfg('system', [work]), URL_), { targetId: 'system', why: 'System is the active profile' });
  const gone = lib.listFetchRoute(cfg('p-deleted', [work]), URL_);
  assert.equal(gone.targetId, 'system');
  assert.match(gone.why, /no longer exists/);
});

test('local addresses always go direct, whatever is active', () => {
  for (const u of ['http://localhost:8080/l.txt', 'http://lists.localhost/l.txt', 'http://127.0.0.1/l.txt', 'http://127.9.9.9/l', 'http://[::1]/l', 'http://169.254.10.1/l', 'http://[fe80::1]/l']) {
    const r = lib.listFetchRoute(cfg('p-work', [work]), u);
    assert.equal(r.targetId, 'direct', u);
    assert.match(r.why, /local address/, u);
  }
  assert.equal(lib.isImplicitlyDirect('10.0.0.1'), false);
  assert.equal(lib.isImplicitlyDirect('localhost.example.com'), false);
});

test('a URL that cannot be fetched says why instead of naming a route', () => {
  assert.equal(lib.listFetchRoute(cfg('direct', []), '   ').invalid, '');
  assert.match(lib.listFetchRoute(cfg('direct', []), 'example.com/list.txt').invalid, /https:\/\//);
  assert.match(lib.listFetchRoute(cfg('direct', []), 'ftp://example.com/list.txt').invalid, /ftp:/);
  // Unreadable, but already starting with a scheme: no advice to add one.
  assert.match(lib.listFetchRoute(cfg('direct', []), 'https://exa mple.com/list.txt').invalid ?? '', /can’t be read|no usable host/);
  assert.equal(lib.listFetchRoute(cfg('direct', []), 'ftp://example.com/list.txt').targetId, '');
  // fetch() throws on a URL with credentials in it, before any request goes out.
  for (const u of ['https://user:pass@example.com/list.txt', 'https://user@example.com/list.txt']) {
    const r = lib.listFetchRoute(cfg('p-work', [work]), u);
    assert.equal(r.targetId, '', u);
    assert.match(r.invalid ?? '', /user name or password/, u);
  }
});

test('a proxy carries the fetch unless its bypass list covers the host', () => {
  assert.deepEqual(lib.listFetchRoute(cfg('p-work', [work]), URL_), { targetId: 'p-work', why: 'it’s the active profile', selfRouted: false });
  const byp = lib.listFetchRoute(cfg('p-work', [work]), 'https://wiki.intranet/list.txt');
  assert.equal(byp.targetId, 'direct');
  assert.equal(byp.why, 'the host is on Work SOCKS5’s bypass list');
});

test('an auto switch names the rule by its place in first-match order, or its default', () => {
  const c = cfg('p-office', [work, home, office]);
  // r0 is off, so the first rule that can match is the third row: rule 3.
  assert.deepEqual(lib.listFetchRoute(c, URL_), { targetId: 'p-home', why: 'rule 3 in Office routing, the active profile', selfRouted: false });
  const def = lib.listFetchRoute(c, 'https://lists.example.org/l.txt');
  assert.equal(def.targetId, 'direct');
  assert.equal(def.why, 'the default of Office routing, the active profile');
});

test('a popup override comes first, as it does in the PAC', () => {
  const c = cfg('p-office', [work, home, office]);
  const ovr = [{ id: 't1', enabled: true, type: 'hostWildcard', pattern: 'raw.githubusercontent.com', targetId: 'p-work' }];
  assert.deepEqual(lib.listFetchRoute(c, URL_, ovr), { targetId: 'p-work', why: 'an override set from the popup', selfRouted: false });
});

test('a list that decides its own address is flagged, empty or not', () => {
  const empty = lib.listFetchRoute(cfg('p-list', [home, list('')]), URL_, [], 'p-list');
  assert.equal(empty.targetId, 'direct');
  assert.match(empty.why, /doesn’t cover its own address/);
  assert.equal(empty.selfRouted, true);
  const covers = lib.listFetchRoute(cfg('p-list', [home, list('raw.githubusercontent.com\n')]), URL_, [], 'p-list');
  assert.equal(covers.targetId, 'p-home');
  assert.equal(covers.why, 'this list covers its own address');
  assert.equal(covers.selfRouted, true);
  // Seen from another list's editor, the same hop is just "the list in …".
  const other = lib.listFetchRoute(cfg('p-list', [home, list('raw.githubusercontent.com\n')]), URL_, [], 'p-other');
  assert.equal(other.why, 'the list in Blocked sites, the active profile');
  assert.equal(other.selfRouted, false);
});

test('an alias is followed, and chains name every hop that decided', () => {
  const alias = { id: 'p-alias', kind: 'virtual', name: 'Egress', color: '#14b8a6', targetId: 'p-office' };
  const viaAlias = lib.listFetchRoute(cfg('p-alias', [work, home, office, alias]), URL_);
  assert.equal(viaAlias.targetId, 'p-home');
  assert.equal(viaAlias.why, 'rule 3 in Office routing, through the active alias Egress');
  const plain = { id: 'p-alias2', kind: 'virtual', name: 'Exit', color: '#14b8a6', targetId: 'p-home' };
  assert.deepEqual(lib.listFetchRoute(cfg('p-alias2', [home, plain]), URL_), { targetId: 'p-home', why: 'the active alias Exit points there', selfRouted: false });
  const outer = {
    id: 'p-outer', kind: 'switch', name: 'Travel', color: '#f472b6', defaultTargetId: 'p-office',
    rules: [{ id: 'o1', enabled: true, type: 'keyword', pattern: 'nothing-matches', targetId: 'p-work' }],
  };
  const chain = lib.listFetchRoute(cfg('p-outer', [work, home, office, outer]), URL_);
  assert.equal(chain.targetId, 'p-home');
  // The active profile is named on the hop that belongs to it, not on the last one.
  assert.equal(chain.why, 'the default of Travel, the active profile, then rule 3 in Office routing');
});
