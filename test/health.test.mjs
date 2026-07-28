import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { build } from 'esbuild';

/**
 * Config-audit tests. shared/health.ts is pure by design — no chrome.*, no DOM,
 * no clock of its own — so it runs here with nothing stubbed. Every check is
 * asserted both ways: that it fires on the shape it is meant to catch, and that
 * a clean config produces a perfect score. A check that never goes quiet is a
 * check the user learns to ignore.
 */

let lib;

before(async () => {
  const result = await build({
    stdin: {
      contents: "export * from './src/shared/health';",
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

const NOW = Date.UTC(2026, 6, 28, 12, 0, 0);
const CTX = { authGranted: true, now: NOW };

function config(profiles, activeId = 'direct') {
  return { version: 4, rev: 1, activeId, profiles, settings: {} };
}

function proxy(over = {}) {
  return {
    kind: 'proxy',
    id: 'px',
    name: 'Tokyo',
    color: '#46c9e5',
    scheme: 'socks5',
    host: '127.0.0.1',
    port: 1080,
    bypass: ['<local>'],
    ...over,
  };
}

function rule(over = {}) {
  return { id: 'r1', enabled: true, type: 'hostWildcard', pattern: '*.example.com', targetId: 'px', ...over };
}

function sw(over = {}) {
  return {
    kind: 'switch',
    id: 'sw',
    name: 'Work',
    color: '#2dd4a7',
    rules: [rule()],
    defaultTargetId: 'direct',
    ...over,
  };
}

const ids = (report) => report.issues.map((i) => i.id);

/* ---------------- the clean case ---------------- */

test('a well-formed config scores 100 and reports nothing', () => {
  const report = lib.auditConfig(config([proxy(), sw()]), CTX);
  assert.deepEqual(report.issues, []);
  assert.equal(report.score, 100);
  assert.deepEqual(report.counts, { error: 0, warn: 0, info: 0 });
});

test('an empty config is not a problem', () => {
  const report = lib.auditConfig(config([]), CTX);
  assert.deepEqual(report.issues, []);
  assert.equal(report.score, 100);
});

/* ---------------- proxy checks ---------------- */

test('a proxy with no host is an error', () => {
  const report = lib.auditConfig(config([proxy({ host: '' })]), CTX);
  assert.ok(ids(report).includes('empty-host:px'));
  assert.equal(report.counts.error, 1);
});

test('credentials without the auth grant are flagged, and clear once granted', () => {
  const withCreds = config([proxy({ scheme: 'https', username: 'u', password: 'p' })]);
  assert.ok(ids(lib.auditConfig(withCreds, { authGranted: false, now: NOW })).includes('auth-missing:px'));
  assert.ok(!ids(lib.auditConfig(withCreds, CTX)).includes('auth-missing:px'));
});

test('credentials on a SOCKS profile raise nothing — hasCredentials only counts http(s)', () => {
  // Chromium cannot authenticate SOCKS at all, and sanitizeConfig strips the
  // fields on load; flagging them here would be a finding the user cannot act on.
  const report = lib.auditConfig(config([proxy({ username: 'u', password: 'p' })]), {
    authGranted: false,
    now: NOW,
  });
  assert.deepEqual(report.issues, []);
});

test('a missing <local> bypass is a note, and any of the three spellings satisfies it', () => {
  assert.ok(ids(lib.auditConfig(config([proxy({ bypass: [] })]), CTX)).includes('no-local:px'));
  for (const entry of ['<local>', 'localhost', '127.0.0.1', ' <LOCAL> ']) {
    const report = lib.auditConfig(config([proxy({ bypass: [entry] })]), CTX);
    assert.deepEqual(report.issues, [], `${entry} should count as a local bypass`);
  }
});

/* ---------------- switch rule checks ---------------- */

test('an invalid pattern is an error and names the rule', () => {
  const bad = sw({ rules: [rule({ type: 'hostRegex', pattern: '*.example.[com' })] });
  const report = lib.auditConfig(config([proxy(), bad]), CTX);
  const issue = report.issues.find((i) => i.id === 'pattern:sw:r1');
  assert.ok(issue);
  assert.equal(issue.level, 'error');
  assert.equal(issue.profileId, 'sw');
  assert.equal(issue.ruleId, 'r1');
});

test('rules buried under a catch-all are reported once, with the count', () => {
  const buried = sw({
    rules: [
      rule({ id: 'a', pattern: '*' }),
      rule({ id: 'b', pattern: '*.foo.com' }),
      rule({ id: 'c', pattern: '*.bar.com' }),
    ],
  });
  const report = lib.auditConfig(config([proxy(), buried]), CTX);
  const issue = report.issues.find((i) => i.id === 'catchall:sw:a');
  assert.ok(issue);
  assert.match(issue.title, /2 rules in Work can never run/);
});

test('a catch-all in last position shadows nothing', () => {
  const fine = sw({ rules: [rule({ id: 'a', pattern: '*.foo.com' }), rule({ id: 'b', pattern: '*' })] });
  assert.deepEqual(lib.auditConfig(config([proxy(), fine]), CTX).issues, []);
});

test('a disabled catch-all does not shadow — only enabled rules are tried', () => {
  const fine = sw({
    rules: [rule({ id: 'a', pattern: '*', enabled: false }), rule({ id: 'b', pattern: '*.foo.com' })],
  });
  assert.deepEqual(lib.auditConfig(config([proxy(), fine]), CTX).issues, []);
});

test('a duplicate pattern with a different target is reported once, not per repeat', () => {
  const dupes = sw({
    rules: [
      rule({ id: 'a', pattern: '*.foo.com', targetId: 'px' }),
      rule({ id: 'b', pattern: '*.foo.com', targetId: 'direct' }),
      rule({ id: 'c', pattern: '*.foo.com', targetId: 'direct' }),
    ],
  });
  const found = ids(lib.auditConfig(config([proxy(), dupes]), CTX)).filter((i) => i.startsWith('dupe:'));
  assert.deepEqual(found, ['dupe:sw:b']);
});

test('the same pattern twice with the SAME target is not a finding', () => {
  // Redundant, but harmless and not a routing surprise.
  const same = sw({
    rules: [rule({ id: 'a', pattern: '*.foo.com' }), rule({ id: 'b', pattern: '*.foo.com' })],
  });
  assert.deepEqual(lib.auditConfig(config([proxy(), same]), CTX).issues, []);
});

test('every rule switched off is a warning', () => {
  const off = sw({ rules: [rule({ enabled: false })] });
  assert.ok(ids(lib.auditConfig(config([proxy(), off]), CTX)).includes('all-off:sw'));
});

test('a switch profile that only ever goes Direct is a note', () => {
  const inert = sw({ rules: [rule({ targetId: 'direct' })], defaultTargetId: 'direct' });
  assert.ok(ids(lib.auditConfig(config([proxy(), inert]), CTX)).includes('all-direct:sw'));
});

/* ---------------- rule lists ---------------- */

function list(over = {}) {
  return {
    kind: 'rulelist',
    id: 'rl',
    name: 'GFW',
    color: '#f472b6',
    format: 'switchy',
    url: 'https://example.com/list.txt',
    updateIntervalH: 24,
    matchTargetId: 'px',
    defaultTargetId: 'direct',
    text: 'example.com\nfoo.example.net\n',
    lastUpdated: NOW - 3_600_000,
    ...over,
  };
}

test('an empty list body is an error, and offers a fetch when it has a URL', () => {
  const report = lib.auditConfig(config([proxy(), list({ text: '' })]), CTX);
  const issue = report.issues.find((i) => i.id === 'list-empty:rl');
  assert.ok(issue);
  assert.equal(issue.fix.kind, 'update-list');
});

test('an empty list with no URL offers the editor instead of a fetch', () => {
  const report = lib.auditConfig(config([proxy(), list({ text: '', url: '' })]), CTX);
  assert.equal(report.issues.find((i) => i.id === 'list-empty:rl').fix.kind, 'open');
});

test('a list overdue by more than twice its interval is stale', () => {
  const fresh = list({ lastUpdated: NOW - 25 * 3_600_000 }); // 25 h, interval 24 h
  assert.ok(!ids(lib.auditConfig(config([proxy(), fresh]), CTX)).includes('list-stale:rl'));
  const old = list({ lastUpdated: NOW - 9 * 24 * 3_600_000 });
  assert.ok(ids(lib.auditConfig(config([proxy(), old]), CTX)).includes('list-stale:rl'));
});

test('auto-update off means staleness is not a finding', () => {
  const manual = list({ updateIntervalH: 0, lastUpdated: NOW - 90 * 24 * 3_600_000 });
  assert.ok(!ids(lib.auditConfig(config([proxy(), manual]), CTX)).includes('list-stale:rl'));
});

test('a body that parses to nothing is an error', () => {
  const junk = list({ format: 'autoproxy', text: '!! only comments\n! and more\n' });
  assert.ok(ids(lib.auditConfig(config([proxy(), junk]), CTX)).includes('list-unparsed:rl'));
});

/* ---------------- cycles ---------------- */

function alias(id, targetId, name) {
  return { kind: 'virtual', id, name, color: '#ffb020', targetId };
}

test('a two-hop alias loop is an error on both profiles', () => {
  const looped = config([alias('a', 'b', 'A'), alias('b', 'a', 'B')]);
  const found = ids(lib.auditConfig(looped, CTX)).filter((i) => i.startsWith('cycle:'));
  assert.deepEqual(found.sort(), ['cycle:a', 'cycle:b']);
});

test('an alias pointing at itself is an error', () => {
  assert.ok(ids(lib.auditConfig(config([alias('a', 'a', 'A')]), CTX)).includes('cycle:a'));
});

test('a diamond is not a cycle', () => {
  // Two switch profiles both routing to the same proxy share a target; that is
  // a diamond, not a loop, and reporting it would be noise on a normal setup.
  const diamond = config([
    proxy(),
    sw({ id: 's1', name: 'One', rules: [rule({ targetId: 'px' })] }),
    sw({ id: 's2', name: 'Two', rules: [rule({ targetId: 'px' })] }),
  ]);
  assert.ok(!ids(lib.auditConfig(diamond, CTX)).some((i) => i.startsWith('cycle:')));
});

/* ---------------- shape, scoring, ordering ---------------- */

test('routers with no proxy to route to is a note that offers to create one', () => {
  const report = lib.auditConfig(config([sw({ rules: [rule({ targetId: 'direct' })] })]), CTX);
  const issue = report.issues.find((i) => i.id === 'no-proxies');
  assert.ok(issue);
  // Not 'open': that kind needs a profileId to open, and this finding has none,
  // so a button reading "Add one" used to land on the settings page.
  assert.equal(issue.fix.kind, 'add-proxy');
  assert.equal(issue.profileId, undefined);
});

test('every fix that navigates to a profile actually names one', () => {
  // 'open' resolves through issue.profileId; an issue that offers it without an
  // id has nowhere to go.
  const messy = config([
    proxy({ host: '' }),
    sw({ rules: [rule({ type: 'ipCidr', pattern: 'nope' })] }),
    list({ text: '' }),
    alias('a', 'a', 'Loop'),
  ]);
  for (const issue of lib.auditConfig(messy, CTX).issues) {
    if (issue.fix.kind === 'open') {
      assert.ok(issue.profileId, `"${issue.title}" offers Open with no profile to open`);
    }
    if (issue.fix.kind === 'add-local-bypass' || issue.fix.kind === 'update-list') {
      assert.ok(issue.profileId, `"${issue.title}" needs a profile to act on`);
    }
  }
});

test('errors sort above warnings, which sort above notes', () => {
  const messy = config([
    proxy({ bypass: [] }), // info
    sw({ rules: [rule({ type: 'ipCidr', pattern: 'nonsense' })] }), // error
    list({ text: '' }), // error
  ]);
  const levels = lib.auditConfig(messy, CTX).issues.map((i) => i.level);
  assert.deepEqual(levels, [...levels].sort((a, b) => {
    const order = { error: 0, warn: 1, info: 2 };
    return order[a] - order[b];
  }));
  assert.equal(levels[0], 'error');
});

test('the score falls with severity and never goes below zero', () => {
  const one = lib.auditConfig(config([proxy({ bypass: [] })]), CTX);
  assert.equal(one.score, 97); // one note

  const many = config(
    Array.from({ length: 12 }, (_, i) => proxy({ id: `p${i}`, name: `P${i}`, host: '' }))
  );
  const report = lib.auditConfig(many, CTX);
  assert.ok(report.counts.error >= 12);
  assert.equal(report.score, 0);
});

test('issue ids are stable across repeated audits of the same config', () => {
  const c = config([proxy({ bypass: [] }), sw({ rules: [rule({ type: 'time', pattern: 'noon' })] })]);
  assert.deepEqual(ids(lib.auditConfig(c, CTX)), ids(lib.auditConfig(c, CTX)));
});

/* ---------------- the derived counters ---------------- */

test('ruleStats counts across every switch profile', () => {
  const c = config([
    proxy(),
    sw({
      id: 's1',
      rules: [rule({ id: 'a' }), rule({ id: 'b', enabled: false }), rule({ id: 'c', type: 'ipCidr', pattern: 'x' })],
    }),
    sw({ id: 's2', name: 'Two', rules: [rule({ id: 'd' })] }),
  ]);
  assert.deepEqual(lib.ruleStats(c), { total: 4, enabled: 3, invalid: 1 });
});

test('listedEntryCount sums the parsed rule lists', () => {
  const c = config([list({ id: 'l1', text: 'a.com\nb.com\n' }), list({ id: 'l2', text: 'c.com\n' })]);
  assert.equal(lib.listedEntryCount(c), 3);
});

test('livePath follows the chain from the active profile', () => {
  const c = config([proxy(), sw()], 'sw');
  const path = lib.livePath(c, 'sw');
  assert.ok(path.has('sw'));
  assert.ok(path.has('px'));
  assert.ok(path.has('direct')); // the default target
});

test('rootProfiles are the ones nothing points at', () => {
  const c = config([proxy(), sw()]);
  assert.deepEqual(lib.rootProfiles(c).map((p) => p.id), ['sw']);
});
