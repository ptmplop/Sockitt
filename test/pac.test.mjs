import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

let lib;

before(async () => {
  const result = await build({
    stdin: {
      contents: "export * from './src/shared/pac'; export * from './src/shared/match';",
      resolveDir: new URL('..', import.meta.url).pathname,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    write: false,
  });
  const code = result.outputFiles[0].text;
  lib = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
});

function runPac(pac, url, host) {
  const ctx = vm.createContext({});
  vm.runInContext(pac, ctx);
  return ctx.FindProxyForURL(url, host);
}

const P1 = {
  kind: 'proxy',
  id: 'p1',
  name: 'Tokyo',
  color: '#46c9e5',
  host: '203.0.113.7',
  port: 1080,
  bypass: ['<local>', '*.intra.net', '192.168.0.0/16'],
};

function makeConfig(rules, defaultTargetId) {
  const sw = {
    kind: 'switch',
    id: 'sw',
    name: 'Auto',
    color: '#6d5dfc',
    rules,
    defaultTargetId,
  };
  return { config: { version: 1, activeId: 'sw', profiles: [P1, sw] }, sw };
}

const RULES = [
  { id: 'r1', enabled: true, type: 'hostWildcard', pattern: '*.example.com', targetId: 'p1' },
  { id: 'r2', enabled: true, type: 'hostRegex', pattern: '^api\\.', targetId: 'direct' },
  { id: 'r3', enabled: true, type: 'urlWildcard', pattern: 'https://cdn.*', targetId: 'p1' },
  { id: 'r4', enabled: true, type: 'ipCidr', pattern: '10.0.0.0/8', targetId: 'p1' },
  { id: 'r5', enabled: true, type: 'hostWildcard', pattern: '*.intra.net', targetId: 'p1' },
  { id: 'r6', enabled: false, type: 'hostWildcard', pattern: '*.disabled.io', targetId: 'p1' },
  { id: 'r7', enabled: true, type: 'ipCidr', pattern: '192.168.0.0/16', targetId: 'p1' },
];

const CASES = [
  // [host, url override, expected PAC result]
  ['example.com', null, 'SOCKS5 203.0.113.7:1080'],       // *. also matches bare domain
  ['www.example.com', null, 'SOCKS5 203.0.113.7:1080'],
  ['deep.sub.example.com', null, 'SOCKS5 203.0.113.7:1080'],
  ['notexample.com', null, 'DIRECT'],                      // no suffix false-positive
  ['api.anything.org', null, 'DIRECT'],                    // regex rule routing direct
  ['cdn.assets.io', 'https://cdn.assets.io/app.js', 'SOCKS5 203.0.113.7:1080'],
  ['10.1.2.3', null, 'SOCKS5 203.0.113.7:1080'],
  ['11.1.2.3', null, 'DIRECT'],
  ['db.intra.net', null, 'DIRECT'],                        // routed to p1 but bypassed
  ['192.168.1.5', null, 'DIRECT'],                         // CIDR bypass wins
  ['sub.disabled.io', null, 'DIRECT'],                     // disabled rule is inert
];

test('generated PAC routes correctly', () => {
  const { config, sw } = makeConfig(RULES, 'direct');
  const pac = lib.compilePac(config, sw);
  for (const [host, url, expected] of CASES) {
    assert.equal(runPac(pac, url ?? `https://${host}/`, host), expected, `host=${host}`);
  }
});

test('PAC and resolveRoute agree on every case', () => {
  const { config, sw } = makeConfig(RULES, 'direct');
  const pac = lib.compilePac(config, sw);
  for (const [host, url] of CASES) {
    const u = url ?? `https://${host}/`;
    const pacResult = runPac(pac, u, host);
    const route = lib.resolveRoute(config, sw, u, host);
    const tsResult =
      route.targetId === 'direct' || route.bypassed ? 'DIRECT' : 'SOCKS5 203.0.113.7:1080';
    assert.equal(pacResult, tsResult, `parity for ${host}`);
  }
});

test('default target with bypass list', () => {
  const { config, sw } = makeConfig([], 'p1');
  const pac = lib.compilePac(config, sw);
  assert.equal(runPac(pac, 'https://example.org/', 'example.org'), 'SOCKS5 203.0.113.7:1080');
  assert.equal(runPac(pac, 'http://localhost:3000/', 'localhost'), 'DIRECT'); // <local>
  assert.equal(runPac(pac, 'http://nas/', 'nas'), 'DIRECT');                  // dotless host
  assert.equal(runPac(pac, 'https://x.intra.net/', 'x.intra.net'), 'DIRECT');
});

test('rules referencing missing or non-proxy targets fall back to DIRECT', () => {
  const { config, sw } = makeConfig(
    [{ id: 'r', enabled: true, type: 'hostWildcard', pattern: '*.ghost.io', targetId: 'nope' }],
    'direct'
  );
  const pac = lib.compilePac(config, sw);
  assert.equal(runPac(pac, 'https://a.ghost.io/', 'a.ghost.io'), 'DIRECT');
});

test('invalid patterns compile to inert rules, not broken PAC', () => {
  const { config, sw } = makeConfig(
    [
      { id: 'r1', enabled: true, type: 'hostRegex', pattern: '([bad', targetId: 'p1' },
      { id: 'r2', enabled: true, type: 'ipCidr', pattern: 'not-an-ip', targetId: 'p1' },
      { id: 'r3', enabled: true, type: 'hostWildcard', pattern: '*.ok.net', targetId: 'p1' },
    ],
    'direct'
  );
  const pac = lib.compilePac(config, sw);
  assert.equal(runPac(pac, 'https://x.ok.net/', 'x.ok.net'), 'SOCKS5 203.0.113.7:1080');
  assert.equal(runPac(pac, 'https://other.net/', 'other.net'), 'DIRECT');
});

test('regexes are precompiled once at PAC top level', () => {
  const { config, sw } = makeConfig(RULES, 'direct');
  const pac = lib.compilePac(config, sw);
  const body = pac.slice(pac.indexOf('function FindProxyForURL'));
  assert.ok(!body.includes('new RegExp'), 'no regex construction inside the hot path');
});

test('matcher primitives', () => {
  assert.deepEqual(lib.parseCidr('10.0.0.0/8'), { base: 0x0a000000, mask: 0xff000000 });
  assert.equal(lib.parseCidr('300.0.0.0/8'), null);
  assert.equal(lib.parseCidr('10.0.0.0/33'), null);
  assert.deepEqual(lib.compileHostWildcard('*.foo.com'), {
    op: 'suffix', suffix: '.foo.com', alsoBare: 'foo.com',
  });
  assert.deepEqual(lib.compileHostWildcard('exact.host'), { op: 'hostEq', host: 'exact.host' });
  assert.equal(lib.compileHostWildcard('a*.b.com').op, 'hostRegex');
});
