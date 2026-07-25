import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

let lib;

before(async () => {
  const result = await build({
    stdin: {
      contents:
        "export * from './src/shared/pac'; export * from './src/shared/match'; export * from './src/shared/rulelist'; export { sanitizeConfig, sanitizeHost, proxyHostError } from './src/shared/state'; export { slimConfig, decidePush, decidePull, remoteCompatibility, reassembleChunks, chunkByBytes } from './src/shared/sync';",
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

// Wednesday 2026-07-22 14:30 local time.
const FIXED_NOW = new Date(2026, 6, 22, 14, 30);

class FakeDate {
  getDay() { return FIXED_NOW.getDay(); }
  getHours() { return FIXED_NOW.getHours(); }
  getMinutes() { return FIXED_NOW.getMinutes(); }
}

function runPac(pac, url, host) {
  const ctx = vm.createContext({ Date: FakeDate });
  vm.runInContext(pac, ctx);
  return ctx.FindProxyForURL(url, host);
}

const P1 = {
  kind: 'proxy', id: 'p1', name: 'Tokyo', color: '#46c9e5', scheme: 'socks5',
  host: '203.0.113.7', port: 1080,
  bypass: ['<local>', '*.intra.net', '192.168.0.0/16'],
};
const P2 = {
  kind: 'proxy', id: 'p2', name: 'Berlin', color: '#6d5dfc', scheme: 'socks5',
  host: '198.51.100.3', port: 9050, bypass: [],
};
const SOCKS_P1 = 'SOCKS5 203.0.113.7:1080';
const SOCKS_P2 = 'SOCKS5 198.51.100.3:9050';

function makeConfig(profiles, activeId) {
  return {
    version: 4, rev: 0, activeId, profiles,
    settings: {
      quickSwitch: false, quickSwitchIds: [], syncEnabled: false, startupProfileId: '',
      revertExternal: false, confirmDeletion: true, addToBottom: true,
      refreshOnSwitch: false, badgeResult: false,
    },
  };
}

function sw(id, rules, defaultTargetId, name = id) {
  return { kind: 'switch', id, name, color: '#2dd4a7', rules, defaultTargetId };
}
const rule = (id, type, pattern, targetId, enabled = true) =>
  ({ id, enabled, type, pattern, targetId });

/* ---------------- original routing behaviour ---------------- */

const BASE_RULES = [
  rule('r1', 'hostWildcard', '*.example.com', 'p1'),
  rule('r2', 'hostRegex', '^api\\.', 'direct'),
  rule('r3', 'urlWildcard', 'https://cdn.*', 'p1'),
  rule('r4', 'ipCidr', '10.0.0.0/8', 'p1'),
  rule('r5', 'hostWildcard', '*.intra.net', 'p1'),
  rule('r6', 'hostWildcard', '*.disabled.io', 'p1', false),
  rule('r7', 'ipCidr', '192.168.0.0/16', 'p1'),
];

const BASE_CASES = [
  ['example.com', null, SOCKS_P1],
  ['www.example.com', null, SOCKS_P1],
  ['deep.sub.example.com', null, SOCKS_P1],
  ['notexample.com', null, 'DIRECT'],
  ['api.anything.org', null, 'DIRECT'],
  ['cdn.assets.io', 'https://cdn.assets.io/app.js', SOCKS_P1],
  ['10.1.2.3', null, SOCKS_P1],
  ['11.1.2.3', null, 'DIRECT'],
  ['db.intra.net', null, 'DIRECT'],      // routed to p1 but bypassed
  ['192.168.1.5', null, 'DIRECT'],       // CIDR bypass wins
  ['sub.disabled.io', null, 'DIRECT'],   // disabled rule is inert
];

test('generated PAC routes correctly (base conditions)', () => {
  const profile = sw('sw1', BASE_RULES, 'direct');
  const config = makeConfig([P1, profile], 'sw1');
  const pac = lib.compilePac(config, profile);
  for (const [host, url, expected] of BASE_CASES) {
    assert.equal(runPac(pac, url ?? `https://${host}/`, host), expected, `host=${host}`);
  }
});

/* ---------------- new condition types ---------------- */

test('keyword, hostLevels, weekday and time conditions', () => {
  const profile = sw('sw1', [
    rule('k', 'keyword', 'tracker', 'p1'),
    rule('l', 'hostLevels', '4', 'p2'),
    rule('w', 'weekday', 'mon-fri', 'p1', true),
    rule('t', 'time', '22:00-06:00', 'p2'),
  ], 'direct');
  const config = makeConfig([P1, P2, profile], 'sw1');
  const pac = lib.compilePac(config, profile);

  assert.equal(runPac(pac, 'https://x.io/tracker.js', 'x.io'), SOCKS_P1);
  assert.equal(runPac(pac, 'https://a.b.c.d/', 'a.b.c.d'), SOCKS_P2);
  // Wednesday 14:30: weekday rule matches everything remaining…
  assert.equal(runPac(pac, 'https://plain.org/', 'plain.org'), SOCKS_P1);

  // …and with the weekday rule limited to weekends, the night window misses too.
  const profile2 = sw('sw1', [
    rule('w', 'weekday', 'sat,sun', 'p1'),
    rule('t', 'time', '22:00-06:00', 'p2'),
  ], 'direct');
  const config2 = makeConfig([P1, P2, profile2], 'sw1');
  const pac2 = lib.compilePac(config2, profile2);
  assert.equal(runPac(pac2, 'https://plain.org/', 'plain.org'), 'DIRECT');
});

test('PAC and resolveRoute agree, including new condition types', () => {
  const profile = sw('sw1', [
    ...BASE_RULES,
    rule('k', 'keyword', 'tracker', 'p2'),
    rule('l', 'hostLevels', '5-6', 'p2'),
    rule('t', 'time', '09:00-17:30', 'direct'),
  ], 'p2');
  const config = makeConfig([P1, P2, profile], 'sw1');
  const pac = lib.compilePac(config, profile);
  const hosts = [
    ...BASE_CASES.map(([host, url]) => [host, url]),
    ['x.io', 'https://x.io/tracker.js'],
    ['a.b.c.d.e', null],
    ['anything.net', null],
  ];
  for (const [host, url] of hosts) {
    const u = url ?? `https://${host}/`;
    const pacResult = runPac(pac, u, host);
    const route = lib.resolveRoute(config, profile, u, host, [], FIXED_NOW);
    const expected =
      route.targetId === 'direct' || route.bypassed
        ? 'DIRECT'
        : route.targetId === 'p1' ? SOCKS_P1 : SOCKS_P2;
    assert.equal(pacResult, expected, `parity for ${host}`);
  }
});

/* ---------------- nesting, aliases, cycles ---------------- */

test('switch rules can target other switch profiles', () => {
  const inner = sw('sw2', [rule('i1', 'hostWildcard', '*.eu.example', 'p2')], 'p1');
  const outer = sw('sw1', [rule('o1', 'hostWildcard', '*.example', 'sw2')], 'direct');
  const config = makeConfig([P1, P2, inner, outer], 'sw1');
  const pac = lib.compilePac(config, outer);
  assert.equal(runPac(pac, 'https://api.eu.example/', 'api.eu.example'), SOCKS_P2);
  assert.equal(runPac(pac, 'https://api.example/', 'api.example'), SOCKS_P1);
  assert.equal(runPac(pac, 'https://other.org/', 'other.org'), 'DIRECT');
});

test('virtual aliases resolve through chains; cycles fall back to DIRECT', () => {
  const v2 = { kind: 'virtual', id: 'v2', name: 'inner alias', color: '#ffb020', targetId: 'p1' };
  const v1 = { kind: 'virtual', id: 'v1', name: 'outer alias', color: '#ffb020', targetId: 'v2' };
  const profile = sw('sw1', [rule('r', 'hostWildcard', '*.a.io', 'v1')], 'direct');
  const config = makeConfig([P1, v1, v2, profile], 'sw1');
  const pac = lib.compilePac(config, profile);
  assert.equal(runPac(pac, 'https://x.a.io/', 'x.a.io'), SOCKS_P1);

  // Cycle: alias -> switch -> alias
  const cv = { kind: 'virtual', id: 'cv', name: 'cycle', color: '#ffb020', targetId: 'cs' };
  const cs = sw('cs', [rule('r', 'hostWildcard', '*.b.io', 'cv')], 'p1');
  const config2 = makeConfig([P1, cv, cs], 'cs');
  const pac2 = lib.compilePac(config2, cs);
  assert.equal(runPac(pac2, 'https://x.b.io/', 'x.b.io'), 'DIRECT'); // cycle guard
  assert.equal(runPac(pac2, 'https://y.org/', 'y.org'), SOCKS_P1);
  const route = lib.resolveRoute(config2, cs, 'https://x.b.io/', 'x.b.io');
  assert.equal(route.targetId, 'direct');
});

test('staticTerminal resolves alias chains for the fixed-servers fast path', () => {
  const v2 = { kind: 'virtual', id: 'v2', name: 'v2', color: '#ffb020', targetId: 'p1' };
  const v1 = { kind: 'virtual', id: 'v1', name: 'v1', color: '#ffb020', targetId: 'v2' };
  const s = sw('sw1', [], 'direct');
  const config = makeConfig([P1, v1, v2, s], 'v1');
  assert.equal(lib.staticTerminal(config, v1).id, 'p1');
  assert.equal(lib.staticTerminal(config, P1).id, 'p1');
  assert.equal(lib.staticTerminal(config, s), null);
  const toDirect = { kind: 'virtual', id: 'vd', name: 'vd', color: '#ffb020', targetId: 'direct' };
  assert.equal(lib.staticTerminal(makeConfig([toDirect], 'vd'), toDirect), 'direct');
});

/* ---------------- temp rules ---------------- */

test('temp rules take priority over permanent rules and reach parity', () => {
  const profile = sw('sw1', [rule('perm', 'hostWildcard', '*.site.com', 'p1')], 'direct');
  const config = makeConfig([P1, P2, profile], 'sw1');
  const temp = [rule('tmp', 'hostWildcard', '*.site.com', 'p2')];
  const pac = lib.compilePac(config, profile, temp);
  assert.equal(runPac(pac, 'https://www.site.com/', 'www.site.com'), SOCKS_P2);
  const route = lib.resolveRoute(config, profile, 'https://www.site.com/', 'www.site.com', temp);
  assert.equal(route.targetId, 'p2');
  assert.equal(route.ruleId, 'tmp');
});

test('probe override reroutes only the given host, leaving all other traffic normal', () => {
  const profile = sw('sw1', [rule('r', 'hostWildcard', '*.example.com', 'p1')], 'direct');
  const config = makeConfig([P1, P2, profile], 'sw1');
  // Tab exits via p2; send only ipconfig.is through p2, everything else untouched.
  const pac = lib.compilePac(config, profile, [], { host: 'ipconfig.is', directive: SOCKS_P2 });
  assert.equal(runPac(pac, 'https://ipconfig.is/json', 'ipconfig.is'), SOCKS_P2); // overridden host
  assert.equal(runPac(pac, 'https://ipconfig.is/json', 'IpConfig.Is'), SOCKS_P2); // case-insensitive
  assert.equal(runPac(pac, 'https://www.example.com/', 'www.example.com'), SOCKS_P1); // normal rule intact
  assert.equal(runPac(pac, 'https://other.test/', 'other.test'), 'DIRECT'); // normal default intact
  // A direct-exit tab overrides ipconfig.is to DIRECT without touching the rest.
  const pacDirect = lib.compilePac(config, profile, [], { host: 'ipconfig.is', directive: 'DIRECT' });
  assert.equal(runPac(pacDirect, 'https://ipconfig.is/json', 'ipconfig.is'), 'DIRECT');
  assert.equal(runPac(pacDirect, 'https://www.example.com/', 'www.example.com'), SOCKS_P1);
});

/* ---------------- rule lists ---------------- */

const AUTOPROXY_TEXT = [
  '[AutoProxy 0.2.9]',
  '! comment line',
  '||blocked.example',
  '@@||allowed.blocked.example',
  '|https://exactprefix.example/path',
  '/^https?:\\/\\/regexmatch\\./',
  'plainkeyword',
  '@@safe-keyword',
  '@@',                    // bare whitelist marker must be inert, not match-all
  '|',                     // bare prefix marker must be inert
].join('\n');

test('AutoProxy parsing covers every entry form', () => {
  const parsed = lib.parseAutoProxy(AUTOPROXY_TEXT);
  assert.equal(parsed.count, 6);
  assert.equal(parsed.whitelist.length, 2);
  assert.equal(parsed.blacklist.length, 4);
  assert.deepEqual(parsed.blacklist[0], {
    op: 'suffix', suffix: '.blocked.example', alsoBare: 'blocked.example',
  });
});

test('base64 GFWList payloads decode transparently', () => {
  const encoded = Buffer.from(AUTOPROXY_TEXT).toString('base64');
  const parsed = lib.parseAutoProxy(encoded);
  assert.equal(parsed.count, 6);
});

test('rule list profile compiles to a fast PAC and matches resolveRoute', () => {
  const rl = {
    kind: 'rulelist', id: 'rl1', name: 'List', color: '#f5576c',
    format: 'autoproxy', url: '', updateIntervalH: 0,
    matchTargetId: 'p1', defaultTargetId: 'direct', text: AUTOPROXY_TEXT,
  };
  const config = makeConfig([P1, rl], 'rl1');
  const pac = lib.compilePac(config, rl);

  const cases = [
    ['blocked.example', 'https://blocked.example/', SOCKS_P1],
    ['x.blocked.example', 'https://x.blocked.example/', SOCKS_P1],
    ['allowed.blocked.example', 'https://allowed.blocked.example/', 'DIRECT'], // whitelist wins
    ['exactprefix.example', 'https://exactprefix.example/path/deep', SOCKS_P1],
    ['regexmatch.io', 'https://regexmatch.io/', SOCKS_P1],
    ['keyword.org', 'https://keyword.org/plainkeyword/x', SOCKS_P1],
    ['keyword.org', 'https://keyword.org/safe-keyword-plainkeyword', 'DIRECT'], // whitelist keyword
    ['unrelated.org', 'https://unrelated.org/', 'DIRECT'],
  ];
  for (const [host, url, expected] of cases) {
    assert.equal(runPac(pac, url, host), expected, url);
    const route = lib.resolveRoute(config, rl, url, host);
    const ts = route.targetId === 'direct' || route.bypassed ? 'DIRECT' : SOCKS_P1;
    assert.equal(ts, expected, `resolveRoute parity for ${url}`);
  }

  // Domain buckets become dictionaries (keys prefixed to dodge __proto__).
  assert.ok(pac.includes('"$blocked.example":1'), 'suffix dictionary emitted');
});

test('Switchy format parsing', () => {
  const parsed = lib.parseSwitchy(
    ['# comment', '*.wild.example', 'exact.example', '@@*.safe.example', 'https://url.example/*'].join('\n')
  );
  assert.equal(parsed.count, 4);
  assert.equal(parsed.whitelist.length, 1);
  assert.deepEqual(parsed.blacklist[1], { op: 'hostEq', host: 'exact.example' });
});

/* ---------------- structural guarantees ---------------- */

test('no regex construction in the per-request hot path', () => {
  const profile = sw('sw1', BASE_RULES, 'direct');
  const config = makeConfig([P1, profile], 'sw1');
  const pac = lib.compilePac(config, profile);
  const hotPath = pac.slice(pac.indexOf('function P'));
  assert.ok(!hotPath.includes('new RegExp'), 'regexes must be precompiled into tables');
});

test('per-request values are only computed when needed', () => {
  const plain = sw('s', [rule('r', 'hostWildcard', '*.x.io', 'p1')], 'direct');
  const noDates = lib.compilePac(makeConfig([P1, plain], 's'), plain);
  assert.ok(!noDates.includes('new Date'), 'no Date without time/weekday rules');

  const plain2 = sw('s', [rule('r', 'hostWildcard', '*.x.io', 'p2')], 'direct');
  const noIp = lib.compilePac(makeConfig([P2, plain2], 's'), plain2);
  assert.ok(!noIp.includes('function A('), 'no IPv4 parser without CIDR conditions');
});

test('rules referencing missing targets fall back to DIRECT', () => {
  const profile = sw('sw1', [rule('r', 'hostWildcard', '*.ghost.io', 'nope')], 'direct');
  const config = makeConfig([P1, profile], 'sw1');
  const pac = lib.compilePac(config, profile);
  assert.equal(runPac(pac, 'https://a.ghost.io/', 'a.ghost.io'), 'DIRECT');
});

test('invalid patterns compile to inert rules, not broken PAC', () => {
  const profile = sw('sw1', [
    rule('r1', 'hostRegex', '([bad', 'p1'),
    rule('r2', 'ipCidr', 'not-an-ip', 'p1'),
    rule('r3', 'weekday', 'someday', 'p1'),
    rule('r4', 'time', '25:00-99:99', 'p1'),
    rule('r5', 'hostWildcard', '*.ok.net', 'p1'),
  ], 'direct');
  const config = makeConfig([P1, profile], 'sw1');
  const pac = lib.compilePac(config, profile);
  assert.equal(runPac(pac, 'https://x.ok.net/', 'x.ok.net'), SOCKS_P1);
  assert.equal(runPac(pac, 'https://other.net/', 'other.net'), 'DIRECT');
});

/* ---------------- matcher primitives ---------------- */

test('matcher primitives', () => {
  assert.deepEqual(lib.parseCidr('10.0.0.0/8'), { base: 0x0a000000, mask: 0xff000000 });
  assert.equal(lib.parseCidr('300.0.0.0/8'), null);
  assert.deepEqual(lib.compileHostWildcard('*.foo.com'), {
    op: 'suffix', suffix: '.foo.com', alsoBare: 'foo.com',
  });
  assert.equal(lib.compileHostWildcard('a*.b.com').op, 'hostRegex');

  assert.deepEqual(lib.parseLevels('2-4'), { min: 2, max: 4 });
  assert.deepEqual(lib.parseLevels('3'), { min: 3, max: 3 });
  assert.equal(lib.parseLevels('4-2'), null);

  assert.equal(lib.parseWeekdays('mon-fri'), 0b0111110);
  assert.equal(lib.parseWeekdays('sat,sun'), 0b1000001);
  assert.equal(lib.parseWeekdays('fri-mon'), 0b1100011); // wraps the week
  assert.equal(lib.parseWeekdays('noday'), null);

  assert.deepEqual(lib.parseTimeRange('09:00-17:30'), { from: 540, to: 1050 });
  assert.equal(lib.parseTimeRange('9am-5pm'), null);
  assert.equal(lib.timeInRange(120, 1320, 360), true);  // 02:00 in 22:00-06:00
  assert.equal(lib.timeInRange(720, 1320, 360), false); // 12:00 not in 22:00-06:00
});

/* ---------------- regression: code-review fixes (1.2.1) ---------------- */

test('profile name cannot escape the PAC header comment or inject code', () => {
  for (const name of ['**// FindProxyForURL=function(){return "SOCKS5 evil:1"} //', '*/', '**//', 'a*/b']) {
    const p = sw('sw', [rule('r', 'hostWildcard', '*.x.io', 'p1')], 'direct', name);
    const pac = lib.compilePac(makeConfig([P1, p], 'sw'), p);
    const ctx = vm.createContext({ Date: FakeDate });
    vm.runInContext(pac, ctx); // must parse without throwing
    assert.equal(typeof ctx.FindProxyForURL, 'function');
    assert.equal(runPac(pac, 'https://a.x.io/', 'a.x.io'), SOCKS_P1);
    assert.equal(runPac(pac, 'https://evil.test/', 'evil.test'), 'DIRECT'); // no injected route
  }
});

test('__proto__ as a rule-list host matches in both PAC and resolveRoute', () => {
  // P2 has no bypass list, so dotless hosts like __proto__ aren't <local>-bypassed.
  const rl = {
    kind: 'rulelist', id: 'rl', name: 'l', color: '#111111', format: 'autoproxy',
    url: '', updateIntervalH: 0, matchTargetId: 'p2', defaultTargetId: 'direct',
    text: '||__proto__\n||normal.example\nconstructor',
  };
  const config = makeConfig([P2, rl], 'rl');
  const pac = lib.compilePac(config, rl);
  // The dangerous key must be a real own entry in the emitted dictionary.
  assert.ok(pac.includes('"$__proto__":1'), '__proto__ stored as an own dict key');
  for (const host of ['__proto__', 'x.__proto__', 'normal.example', 'constructor']) {
    const url = `http://${host}/`;
    const pacRes = runPac(pac, url, host);
    const route = lib.resolveRoute(config, rl, url, host);
    const tsRes = route.targetId === 'direct' || route.bypassed ? 'DIRECT' : SOCKS_P2;
    assert.equal(pacRes, SOCKS_P2, `PAC should match ${host}`);
    assert.equal(pacRes, tsRes, `parity for ${host}`);
  }
  // A host that is NOT in the list must still fall through to DIRECT.
  assert.equal(runPac(pac, 'http://toString/', 'toString'), 'DIRECT');
});

test('rule types from the prototype chain are dropped, not compiled to undefined', () => {
  // Pre-fix isRuleType used `in`, so these keys passed sanitization; compileRule
  // then returned undefined and compilePac/resolveRoute threw — silently
  // leaving the proxy unapplied while the UI showed the profile as active.
  for (const type of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const swp = sw('sw', [rule('r1', type, '*.evil.com', 'p1')], 'direct');
    const config = lib.sanitizeConfig(makeConfig([P1, swp], 'sw'));
    assert.equal(config.profiles[1].rules.length, 0, `${type} rule must be dropped`);
    const clean = config.profiles[1];
    const pac = lib.compilePac(config, clean); // must not throw
    assert.equal(runPac(pac, 'https://evil.com/', 'evil.com'), 'DIRECT', type);
    assert.equal(lib.resolveRoute(config, clean, 'https://evil.com/', 'evil.com').targetId, 'direct', type);
  }
});

test('sanitize strips a proxy host that would inject an extra PAC proxy', () => {
  assert.equal(sanitizedProxy(rawProxy({ scheme: 'socks5', host: '203.0.113.7; SOCKS5 evil.test' })).host, '203.0.113.7');
  assert.equal(sanitizedProxy(rawProxy({ host: '203.0.113.7 evil' })).host, '203.0.113.7');
  assert.equal(sanitizedProxy(rawProxy({ host: 'evil/..' })).host, 'evil');
  // Clean hosts and bracketed IPv6 are untouched.
  assert.equal(sanitizedProxy(rawProxy({ host: 'proxy.example.com' })).host, 'proxy.example.com');
  assert.equal(sanitizedProxy(rawProxy({ host: '[::1]' })).host, '[::1]');
  // ...and the injected proxy never reaches the compiled PAC.
  const q = { ...rawProxy({ scheme: 'socks5', host: 'a; SOCKS5 evil.test' }), id: 'q', bypass: [] };
  const clean = lib.sanitizeConfig(makeConfig([q], 'q')).profiles[0];
  assert.ok(!lib.compilePac(makeConfig([clean], 'q'), clean).includes('evil.test'));
});

test('proxyHostError flags empty and directive-breaking hosts', () => {
  for (const ok of ['proxy.example.com', '127.0.0.1', '[::1]']) {
    assert.equal(lib.proxyHostError(ok), null, ok);
  }
  for (const bad of ['', '   ', 'a; SOCKS5 evil', 'has space', 'has/slash']) {
    assert.ok(lib.proxyHostError(bad), JSON.stringify(bad));
  }
});

test('catastrophic-backtracking regex sources are rejected (ReDoS guard)', () => {
  // Nested quantifiers (star height > 1) are the classic exponential shape.
  for (const bad of ['(a+)+', '(a+)+$', '(.*)*', '(a*)*b', '([a-z]+)*', '(\\d+)+x', 'a'.repeat(1001)]) {
    assert.equal(lib.regexSourceIsSafe(bad), false, bad);
  }
  // Ordinary regexes (star height <= 1) stay allowed, including common list forms.
  for (const ok of ['^https?://', '(foo|bar)', '(ab)+', 'a.*b.*c', '[a-z]{2,10}', '(?:x)+', '^https?:\\/\\/[^\\/]+\\.google\\.']) {
    assert.equal(lib.regexSourceIsSafe(ok), true, ok);
  }
});

test('a dangerous regex rule or list entry compiles inert, never onto the hot path', () => {
  assert.deepEqual(lib.compileRule({ type: 'urlRegex', pattern: '(a+)+$' }), { op: 'never' });
  assert.deepEqual(lib.compileRule({ type: 'hostRegex', pattern: '(a+)+' }), { op: 'never' });
  assert.ok(lib.patternError({ type: 'urlRegex', pattern: '(a+)+$' }), 'options UI flags it');
  // AutoProxy /regex/ list line: dangerous entry dropped, safe suffix kept.
  const parsed = lib.parseAutoProxy('/(a+)+$/\n||safe.example');
  assert.ok(!parsed.blacklist.some((c) => c.op === 'urlRegex'), 'no urlRegex from the dangerous line');
  assert.ok(parsed.blacklist.some((c) => c.op === 'suffix' && c.alsoBare === 'safe.example'));
  const rl = {
    kind: 'rulelist', id: 'rl', name: 'l', color: '#111111', format: 'autoproxy',
    url: '', updateIntervalH: 0, matchTargetId: 'p1', defaultTargetId: 'direct', text: '/(a+)+$/',
  };
  assert.ok(!lib.compilePac(makeConfig([P1, rl], 'rl'), rl).includes('(a+)+'), 'source absent from PAC');
});

test('PAC and resolveRoute agree on a cyclic switch graph (no frozen-edge divergence)', () => {
  // swR -> swB; swB <-> swA via conditional keyword rules. Before the fix the
  // PAC froze swB->swA to DIRECT at compile time, so a request reaching swB
  // where its rule fires but swA's does not routed DIRECT while resolveRoute
  // (the popup/inspector twin) reported a proxy — a silent leak + a lying UI.
  const swR = sw('swR', [rule('rR', 'keyword', 'bbb', 'swB')], 'direct');
  const swA = sw('swA', [rule('rA', 'keyword', 'xxx', 'swB')], 'p1');
  const swB = sw('swB', [rule('rB', 'keyword', 'yyy', 'swA')], 'p2');
  const config = makeConfig([P1, P2, swR, swA, swB], 'swR');
  const pac = lib.compilePac(config, swR);
  const toDirective = (r) =>
    r.targetId === 'direct' || r.bypassed ? 'DIRECT' : r.targetId === 'p1' ? SOCKS_P1 : SOCKS_P2;
  for (const [url, host] of [
    ['http://bbb-yyy.test/', 'bbb-yyy.test'],         // swB, yyy->swA, xxx? no -> p1
    ['http://bbb-yyy-xxx.test/', 'bbb-yyy-xxx.test'], // full cycle -> DIRECT
    ['http://bbb.test/', 'bbb.test'],                 // swB default -> p2
    ['http://other.test/', 'other.test'],             // swR default -> direct
  ]) {
    const route = lib.resolveRoute(config, swR, url, host);
    assert.equal(runPac(pac, url, host), toDirective(route), `parity for ${host} (route ${route.targetId})`);
  }
});

test('AutoProxy ||domain:port strips the port so the host matches', () => {
  const parsed = lib.parseAutoProxy('||example.com:8080');
  assert.deepEqual(parsed.blacklist[0], {
    op: 'suffix', suffix: '.example.com', alsoBare: 'example.com',
  });
});

test('pacRequestUrl mirrors Chrome path-stripping (https origin-only, http full)', () => {
  assert.equal(lib.pacRequestUrl('https://x.io/tracker.js?a=1'), 'https://x.io/');
  assert.equal(lib.pacRequestUrl('https://x.io:8443/deep/path'), 'https://x.io:8443/');
  assert.equal(lib.pacRequestUrl('http://x.io/tracker.js'), 'http://x.io/tracker.js');
  assert.equal(lib.pacRequestUrl('not a url'), 'not a url');

  // A path-only keyword rule: preview must use pacRequestUrl to agree with the PAC.
  const p = sw('sw', [rule('k', 'keyword', 'tracker', 'p1')], 'direct');
  const config = makeConfig([P1, p], 'sw');
  const pac = lib.compilePac(config, p);
  const raw = 'https://x.io/tracker.js';
  const stripped = lib.pacRequestUrl(raw);
  assert.equal(runPac(pac, stripped, 'x.io'), 'DIRECT'); // Chrome sees no path on https
  assert.equal(lib.resolveRoute(config, p, stripped, 'x.io').targetId, 'direct'); // preview agrees
  assert.equal(lib.resolveRoute(config, p, raw, 'x.io').targetId, 'p1'); // raw url would mislead
});

/* ---------------- multiple proxy protocols (1.5) ---------------- */

test('each proxy scheme emits the correct PAC directive', () => {
  const cases = [
    ['socks5', 'SOCKS5 h.example:1080'],
    ['socks4', 'SOCKS h.example:1080'],
    ['http', 'PROXY h.example:1080'],
    ['https', 'HTTPS h.example:1080'],
  ];
  for (const [scheme, expected] of cases) {
    assert.equal(lib.pacDirective(scheme, 'h.example', 1080), expected, scheme);
    const proxy = { kind: 'proxy', id: 'x', name: 'X', color: '#111111', scheme, host: 'h.example', port: 1080, bypass: [] };
    const sw = { kind: 'switch', id: 's', name: 'S', color: '#111111', defaultTargetId: 'x',
      rules: [rule('r', 'hostWildcard', '*.site.io', 'x')] };
    const config = makeConfig([proxy, sw], 's');
    const pac = lib.compilePac(config, sw);
    assert.equal(runPac(pac, 'https://a.site.io/', 'a.site.io'), expected, `PAC route ${scheme}`);
  }
});

test('fixedServersValue maps scheme through for the fast path', () => {
  const v = lib.fixedServersValue('https', '1.2.3.4', 8080, ['<local>']);
  assert.equal(v.rules.singleProxy.scheme, 'https');
  assert.equal(v.rules.singleProxy.host, '1.2.3.4');
  assert.equal(v.rules.singleProxy.port, 8080);
  assert.deepEqual(v.rules.bypassList, ['<local>']);
  assert.equal(lib.fixedServersValue('socks4', 'h', 1, []).rules.singleProxy.scheme, 'socks4');
});

/* ---------------- sanitizer: schemes and credentials (1.6.3) ---------------- */

const rawProxy = (over = {}) => ({
  kind: 'proxy', id: 'p', name: 'P', color: '#123456',
  scheme: 'http', host: 'Proxy.Example.COM', port: 8080, bypass: [],
  username: 'user', password: 'pass', ...over,
});
const sanitizedProxy = (raw) =>
  lib.sanitizeConfig(makeConfig([raw], 'p')).profiles[0];

test('sanitize keeps every known scheme and coerces unknown ones to socks5', () => {
  for (const scheme of ['socks5', 'socks4', 'http', 'https']) {
    assert.equal(sanitizedProxy(rawProxy({ scheme })).scheme, scheme);
  }
  for (const scheme of ['quic', '', 42, null, 'toString']) {
    assert.equal(sanitizedProxy(rawProxy({ scheme })).scheme, 'socks5', String(scheme));
  }
});

test('sanitize drops credentials for SOCKS schemes and keeps them for http/https', () => {
  const socks = sanitizedProxy(rawProxy({ scheme: 'socks5' }));
  assert.equal(socks.username, undefined);
  assert.equal(socks.password, undefined);
  const http = sanitizedProxy(rawProxy());
  assert.equal(http.username, 'user');
  assert.equal(http.password, 'pass');
  // Password-only credentials are valid (empty username HTTP auth) and survive.
  const pwOnly = sanitizedProxy(rawProxy({ username: undefined }));
  assert.equal(pwOnly.username, undefined);
  assert.equal(pwOnly.password, 'pass');
});

/* ---------------- route tracing (1.7) ---------------- */

test('resolveRoute trace records the full chain: rule → alias → proxy', () => {
  const alias = { kind: 'virtual', id: 'al', name: 'Alias', color: '#123456', targetId: 'p1' };
  const swp = sw('sw', [rule('r1', 'hostWildcard', '*.example.com', 'al')], 'direct');
  const config = makeConfig([P1, alias, swp], 'sw');
  const trace = [];
  const route = lib.resolveRoute(config, swp, 'https://a.example.com/', 'a.example.com', [], new Date(), trace);
  assert.equal(route.targetId, 'p1');
  assert.deepEqual(
    trace.map((e) => [e.from, e.to, e.kind]),
    [['sw', 'al', 'rule'], ['al', 'p1', 'alias']]
  );
  assert.equal(trace[0].pattern, '*.example.com');

  // No match → the default edge is traced.
  const trace2 = [];
  lib.resolveRoute(config, swp, 'https://other.io/', 'other.io', [], new Date(), trace2);
  assert.deepEqual(trace2.map((e) => [e.from, e.to, e.kind]), [['sw', 'direct', 'default']]);
});

test('resolveRoute with a trace matches resolveRoute without one', () => {
  const swp = sw('sw', BASE_RULES, 'p2');
  const config = makeConfig([P1, P2, swp], 'sw');
  for (const [url, host] of [
    ['https://x.example.com/', 'x.example.com'],
    ['https://api.example.io/', 'api.example.io'],
    ['https://nothing.io/', 'nothing.io'],
  ]) {
    const plain = lib.resolveRoute(config, swp, url, host);
    const traced = lib.resolveRoute(config, swp, url, host, [], new Date(), []);
    assert.deepEqual(traced, plain, url);
  }
});

test('sanitize validates the new v4 settings fields', () => {
  const cfg = makeConfig([P1], 'p1');
  cfg.settings.exitIpCheck = false;
  cfg.settings.incognitoProfileId = 'p1';
  const clean = lib.sanitizeConfig(cfg);
  assert.equal(clean.settings.exitIpCheck, false);
  assert.equal(clean.settings.incognitoProfileId, 'p1');

  cfg.settings.incognitoProfileId = 'no-such-profile';
  assert.equal(lib.sanitizeConfig(cfg).settings.incognitoProfileId, '');

  // Absent fields (pre-v4 config) fall back to defaults — IP lookups default OFF.
  delete cfg.settings.exitIpCheck;
  delete cfg.settings.incognitoProfileId;
  const upgraded = lib.sanitizeConfig(cfg);
  assert.equal(upgraded.settings.exitIpCheck, false);
  assert.equal(upgraded.settings.incognitoProfileId, '');
});

test('slimConfig strips credentials (and refetchable list bodies) for sync', () => {
  const listed = {
    kind: 'rulelist', id: 'rl', name: 'L', color: '#123456', format: 'autoproxy',
    url: 'https://x.io/list.txt', updateIntervalH: 24,
    matchTargetId: 'p', defaultTargetId: 'direct', text: '||example.com',
  };
  const slim = lib.slimConfig(
    makeConfig([rawProxy({ username: 'agent-99', password: 'sekrit-hunter2' }), listed], 'p')
  );
  const proxy = slim.profiles[0];
  assert.equal(proxy.username, undefined);
  assert.equal(proxy.password, undefined);
  assert.equal(slim.profiles[1].text, '');
  // ...and the stripped values vanish from the synced JSON entirely.
  const json = JSON.stringify(slim);
  assert.ok(!json.includes('sekrit-hunter2') && !json.includes('agent-99'));
});

test('slimConfig keeps a small pasted list but drops url-backed and oversize bodies', () => {
  const base = {
    kind: 'rulelist', name: 'A', color: '#123456', format: 'autoproxy',
    updateIntervalH: 0, matchTargetId: 'p', defaultTargetId: 'direct',
  };
  const inlineSmall = { ...base, id: 'a', url: '', text: '||example.com' };
  const inlineBig = { ...base, id: 'b', url: '', text: 'x'.repeat(9000) };
  const urlBacked = { ...base, id: 'c', url: 'https://x.io/l.txt', text: '||example.com' };
  const slim = lib.slimConfig(makeConfig([inlineSmall, inlineBig, urlBacked], 'a'));
  assert.equal(slim.profiles[0].text, '||example.com'); // small inline preserved (unrecoverable)
  assert.equal(slim.profiles[1].text, '');              // oversize inline dropped
  assert.equal(slim.profiles[2].text, '');              // url-backed dropped (refetchable)
});

/* ---------------- sync version/rev gates (pure seams) ---------------- */

// CV stands in for CONFIG_VERSION; the gate functions take it as a parameter,
// so these cover the decision logic independent of the current schema number.
const CV = 4;
const meta = (over = {}) => ({ rev: 100, chunks: 1, ...over });

test('decidePush gates on remote schema version and revision', () => {
  assert.equal(lib.decidePush(undefined, 100, CV).action, 'push');            // empty account
  assert.equal(lib.decidePush(meta({ version: CV + 1 }), 100, CV).action, 'pause'); // newer schema
  assert.equal(lib.decidePush(meta({ version: undefined }), 100, CV).action, 'pause'); // version-less
  assert.equal(lib.decidePush(meta({ version: 2 }), 100, CV).action, 'pause');        // <=1.6.2
  assert.equal(lib.decidePush(meta({ version: 3, rev: 50 }), 100, CV).action, 'push'); // gated older, migrate up
  assert.equal(lib.decidePush(meta({ version: CV, rev: 200 }), 100, CV).action, 'skip'); // remote newer rev
  assert.equal(lib.decidePush(meta({ version: CV, rev: 50 }), 100, CV).action, 'push');  // our rev newer
});

test('decidePull adopts an older/equal-schema newer-rev payload, refuses a newer schema', () => {
  assert.equal(lib.decidePull(undefined, 0, CV).action, 'skip');
  assert.equal(lib.decidePull(meta({ rev: 100 }), 100, CV).action, 'skip'); // not newer than local
  assert.equal(lib.decidePull(meta({ rev: 100, version: CV }), 50, CV).action, 'adopt');
  assert.equal(lib.decidePull(meta({ rev: 100, version: 3 }), 50, CV).action, 'adopt');
  assert.equal(lib.decidePull(meta({ rev: 100, version: undefined }), 50, CV).action, 'adopt'); // older is safe
  assert.equal(lib.decidePull(meta({ rev: 100, version: CV + 1 }), 50, CV).action, 'pause');   // newer schema
});

test('remoteCompatibility agrees with decidePush on which remotes are joinable', () => {
  assert.equal(lib.remoteCompatibility(undefined, CV), 'none');
  assert.equal(lib.remoteCompatibility(meta({ version: CV }), CV), 'compatible');
  assert.equal(lib.remoteCompatibility(meta({ version: 3 }), CV), 'compatible');
  assert.equal(lib.remoteCompatibility(meta({ version: undefined }), CV), 'legacy'); // was wrongly 'compatible'
  assert.equal(lib.remoteCompatibility(meta({ version: 2 }), CV), 'legacy');
  assert.equal(lib.remoteCompatibility(meta({ version: CV + 1 }), CV), 'newer');
  // Cross-check: any non-joinable remote is exactly one decidePush pauses on.
  for (const v of [2, undefined, CV + 1]) {
    assert.notEqual(lib.remoteCompatibility(meta({ version: v }), CV), 'compatible');
    assert.equal(lib.decidePush(meta({ version: v, rev: 1 }), 999, CV).action, 'pause');
  }
});

test('reassembleChunks joins in order and flags a partial write', () => {
  assert.equal(
    lib.reassembleChunks(['sockitt#0', 'sockitt#1'], { 'sockitt#0': '{"a":1', 'sockitt#1': ',"b":2}' }),
    '{"a":1,"b":2}'
  );
  assert.equal(lib.reassembleChunks(['sockitt#0', 'sockitt#1'], { 'sockitt#0': 'x' }), null); // missing chunk
  assert.equal(lib.reassembleChunks(['sockitt#0'], { 'sockitt#0': 42 }), null); // non-string chunk
});

/* ---------------- regression: code-review fixes (1.8.23) ---------------- */

test('IPv6-literal hosts are not <local>-bypassed (real-IP leak guard)', () => {
  // P1 ships bypass ['<local>', ...], so it compiles down the PAC path where our
  // own <local> clause governs (not Chrome's native fixed_servers bypass).
  const config = makeConfig([P1], 'p1');
  const pac = lib.compilePac(config, P1);
  const via = (host) => runPac(pac, `http://${host}/`, host);

  // Public IPv6 literals (dotless, colon-bearing) must traverse the proxy,
  // bracketed or not — before the fix `h.indexOf('.')<0` sent them DIRECT,
  // leaking the real IP for an anonymity tool in its default configuration.
  for (const host of ['2606:4700:4700::1111', '[2606:4700:4700::1111]', '2001:db8::1']) {
    assert.equal(via(host), SOCKS_P1, `IPv6 literal ${host} must route through the proxy`);
  }
  // Loopback stays local (direct), in both explicit forms.
  for (const host of ['::1', '[::1]', '127.0.0.1', 'localhost']) {
    assert.equal(via(host), 'DIRECT', `${host} must stay local`);
  }
  // A single-label (dotless AND colonless) intranet host is still local.
  assert.equal(via('intranet'), 'DIRECT');
  // A normal public host routes through the proxy.
  assert.equal(via('example.org'), SOCKS_P1);

  // resolveRoute twin (popup preview / badge) agrees, so the UI can't hide it.
  const rr = (host) => {
    const r = lib.resolveRoute(config, P1, `http://${host}/`, host);
    return r.bypassed || r.targetId === 'direct' ? 'DIRECT' : r.targetId === 'p1' ? SOCKS_P1 : '?';
  };
  assert.equal(rr('2606:4700:4700::1111'), SOCKS_P1);
  assert.equal(rr('[2606:4700:4700::1111]'), SOCKS_P1);
  assert.equal(rr('::1'), 'DIRECT');
  assert.equal(rr('intranet'), 'DIRECT');
});

test('sync chunks stay under the 8192-byte per-item quota (serialized size, not raw)', () => {
  // chrome.storage.sync measures an item as key.length + JSON.stringify(value)
  // bytes. The chunk value is re-escaped when stored, so a quote-dense slice can
  // nearly double; chunkByBytes must budget by that serialized cost. 'sockitt#0'
  // ..'sockitt#NN' keys are <= 12 bytes for any realistic config.
  const itemBytes = (chunk) => Buffer.byteLength(JSON.stringify(chunk), 'utf8') + 'sockitt#000'.length;
  const inputs = [
    '"'.repeat(20000), // all quotes — each doubles to \" when stored
    '\\'.repeat(20000), // all backslashes
    '{"kind":"proxy","id":"x"},'.repeat(2000), // realistic quote-dense config JSON
    '日本語のプロキシ設定'.repeat(2000), // multibyte non-ASCII
    '😀'.repeat(5000), // astral (surrogate pairs) — never split mid-codepoint
    JSON.stringify({
      profiles: Array.from({ length: 300 }, (_, i) => ({
        kind: 'proxy', id: 'p' + i, name: 'Proxy ' + i, host: '10.0.0.' + (i % 255), port: 1080 + i,
      })),
    }),
  ];
  for (const input of inputs) {
    const chunks = lib.chunkByBytes(input);
    for (const c of chunks) {
      assert.ok(itemBytes(c) <= 8192, `stored chunk is ${itemBytes(c)} bytes, over the 8192 quota`);
    }
    assert.equal(chunks.join(''), input, 'chunks must reassemble losslessly');
    const keys = chunks.map((_, i) => `sockitt#${i}`);
    const store = Object.fromEntries(chunks.map((c, i) => [`sockitt#${i}`, c]));
    assert.equal(lib.reassembleChunks(keys, store), input, 'read path round-trips');
  }
});
