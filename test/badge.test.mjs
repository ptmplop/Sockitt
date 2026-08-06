import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { build } from 'esbuild';

let lib;

before(async () => {
  const result = await build({
    stdin: {
      contents: "export * from './src/shared/badge';",
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

const WORK = {
  id: 'work',
  kind: 'proxy',
  name: 'Work',
  color: '#3355ff',
  scheme: 'socks5',
  host: '127.0.0.1',
  port: 1080,
  bypass: [],
};

/** A switch profile routing *.example.com through Work, everything else direct. */
const auto = (over = {}) => ({
  id: 'auto',
  kind: 'switch',
  name: 'Auto',
  color: '#00aa66',
  defaultTargetId: 'direct',
  rules: [
    { id: 'r1', enabled: true, type: 'hostWildcard', pattern: '*.example.com', targetId: 'work' },
  ],
  ...over,
});

const cfg = (profiles, activeId) => ({
  rev: 1,
  activeId,
  profiles,
  settings: {},
});

const page = (url) => ({ url, host: new URL(url).hostname, pending: false });

test('a rule match paints the target profile’s initials in its own colour', () => {
  const config = cfg([WORK, auto()], 'auto');
  assert.deepEqual(lib.badgePaintFor(config, config.profiles[1], page('https://a.example.com/')), {
    text: 'WO',
    color: '#3355ff',
  });
});

test('a site no rule covers paints DIR in the neutral colour', () => {
  const config = cfg([WORK, auto()], 'auto');
  assert.deepEqual(lib.badgePaintFor(config, config.profiles[1], page('https://other.test/')), {
    text: 'DIR',
    color: lib.NEUTRAL,
  });
});

test('an unconditional profile paints nothing — the icon already says it', () => {
  // The badge exists to answer a question a per-request profile raises. A plain
  // proxy routes everything the same way, so there is nothing per-tab to say.
  const config = cfg([WORK], 'work');
  assert.equal(lib.badgePaintFor(config, config.profiles[0], page('https://a.example.com/')), null);
});

test('a page Sockitt cannot route paints nothing', () => {
  const config = cfg([WORK, auto()], 'auto');
  assert.equal(lib.badgePaintFor(config, config.profiles[1], null), null);
});

test('a bypassed host reads DIR in the NEUTRAL colour, never the proxy’s', () => {
  // Regression: the text came from `route.bypassed` but the colour did not, so a
  // bypassed site painted "DIR" on the proxy's own colour — the one combination
  // that reads as "this tab is routed through it".
  const work = { ...WORK, bypass: ['*.example.com'] };
  const config = cfg([work, auto()], 'auto');
  const paint = lib.badgePaintFor(config, config.profiles[1], page('https://a.example.com/'));
  assert.equal(paint.text, 'DIR');
  assert.equal(paint.color, lib.NEUTRAL);
  assert.notEqual(paint.color, work.color);
});

test('a temporary override wins, and is painted like any other route', () => {
  const config = cfg([WORK, auto()], 'auto');
  const temp = [
    { id: 't1', enabled: true, type: 'hostWildcard', pattern: '*.other.test', targetId: 'work' },
  ];
  assert.deepEqual(
    lib.badgePaintFor(config, config.profiles[1], page('https://x.other.test/'), temp),
    { text: 'WO', color: '#3355ff' }
  );
});

test('a time rule is resolved against the clock it is given, not the wall clock', () => {
  // Regression: the badge is only ever correct for the instant it was painted,
  // which is why `now` is a parameter here and why the worker re-paints on a
  // minute alarm while such a rule is reachable.
  const config = cfg(
    [
      WORK,
      auto({
        rules: [{ id: 'r1', enabled: true, type: 'time', pattern: '09:00-17:00', targetId: 'work' }],
      }),
    ],
    'auto'
  );
  const at = (h, m) => new Date(2026, 0, 5, h, m);
  const inside = lib.badgePaintFor(config, config.profiles[1], page('https://a.test/'), [], at(16, 59));
  const outside = lib.badgePaintFor(config, config.profiles[1], page('https://a.test/'), [], at(17, 1));
  assert.equal(inside.text, 'WO');
  assert.equal(outside.text, 'DIR');
  assert.equal(outside.color, lib.NEUTRAL);
});

test('a disabled rule routes nothing', () => {
  const config = cfg(
    [WORK, auto({ rules: [{ ...auto().rules[0], enabled: false }] })],
    'auto'
  );
  assert.equal(
    lib.badgePaintFor(config, config.profiles[1], page('https://a.example.com/')).text,
    'DIR'
  );
});

test('https is matched on the URL Chrome actually hands the PAC', () => {
  // pacRequestUrl strips path/query from https, so a urlWildcard rule written
  // against a path cannot match — the badge must agree with real routing rather
  // than with the raw tab URL.
  const config = cfg(
    [
      WORK,
      auto({
        rules: [
          { id: 'r1', enabled: true, type: 'urlWildcard', pattern: 'https://a.test/secret', targetId: 'work' },
        ],
      }),
    ],
    'auto'
  );
  assert.equal(
    lib.badgePaintFor(config, config.profiles[1], page('https://a.test/secret/x')).text,
    'DIR'
  );
});

test('a rule pointing at a deleted profile falls back to DIR, not a blank badge', () => {
  const config = cfg([auto()], 'auto'); // 'work' is gone
  assert.deepEqual(lib.badgePaintFor(config, config.profiles[0], page('https://a.example.com/')), {
    text: 'DIR',
    color: lib.NEUTRAL,
  });
});

/* ---------- when the badge has to repaint itself ---------- */

const timed = (rules) => cfg([WORK, auto({ rules })], 'auto');
const live = new Set(['auto', 'work']);
const at = (h, m) => new Date(2026, 0, 5, h, m);
const nextChange = (config, when) => lib.minutesToNextClockChange(config, live, when);

test('no clock-dependent rule means no wake-up is scheduled at all', () => {
  // The alarm must not exist for the overwhelming majority of users; a periodic
  // poll would wake the worker 1440 times a day to change nothing.
  assert.equal(nextChange(timed(auto().rules), at(12, 0)), null);
  assert.equal(nextChange(cfg([WORK], 'work'), at(12, 0)), null);
});

test('a time rule wakes at its start and one minute past its end', () => {
  // timeInRange is inclusive of `to`, so 17:00 still matches and 17:01 is the
  // first minute that does not — that, not 17:00, is when the badge changes.
  const config = timed([
    { id: 'r1', enabled: true, type: 'time', pattern: '09:00-17:00', targetId: 'work' },
  ]);
  assert.equal(nextChange(config, at(8, 30)), 30); // -> 09:00, starts matching
  assert.equal(nextChange(config, at(9, 0)), 481); // already open; next is 17:01
  assert.equal(nextChange(config, at(16, 59)), 2); // -> 17:01, stops matching
  assert.equal(nextChange(config, at(17, 1)), 959); // wraps to tomorrow's 09:00
});

test('a weekday rule wakes at midnight, when getDay() moves', () => {
  const config = timed([
    { id: 'r1', enabled: true, type: 'weekday', pattern: 'mon-fri', targetId: 'work' },
  ]);
  assert.equal(nextChange(config, at(23, 30)), 30);
  assert.equal(nextChange(config, at(0, 0)), 1440);
});

test('the soonest boundary across several rules wins', () => {
  const config = timed([
    { id: 'r1', enabled: true, type: 'time', pattern: '09:00-17:00', targetId: 'work' },
    { id: 'r2', enabled: true, type: 'time', pattern: '12:00-13:00', targetId: 'work' },
  ]);
  assert.equal(nextChange(config, at(11, 30)), 30); // 12:00 beats 17:01
});

test('a disabled or unparseable clock rule schedules nothing', () => {
  assert.equal(
    nextChange(
      timed([{ id: 'r1', enabled: false, type: 'time', pattern: '09:00-17:00', targetId: 'work' }]),
      at(8, 0)
    ),
    null
  );
  assert.equal(
    nextChange(
      timed([{ id: 'r1', enabled: true, type: 'time', pattern: 'nonsense', targetId: 'work' }]),
      at(8, 0)
    ),
    null
  );
});

test('a clock rule in an unreachable profile is not woken for', () => {
  // livePath decides reachability; a profile nothing routes through must not
  // keep the worker waking up.
  const config = timed([
    { id: 'r1', enabled: true, type: 'time', pattern: '09:00-17:00', targetId: 'work' },
  ]);
  assert.equal(lib.minutesToNextClockChange(config, new Set(['work']), at(8, 0)), null);
});

test('the next boundary is always strictly ahead, so re-arming cannot loop', () => {
  const config = timed([
    { id: 'r1', enabled: true, type: 'time', pattern: '09:00-17:00', targetId: 'work' },
  ]);
  // Firing exactly on a boundary must schedule the NEXT one, never 0.
  for (const when of [at(9, 0), at(17, 1), at(0, 0)]) {
    assert.ok(nextChange(config, when) > 0, `looped at ${when.toTimeString()}`);
  }
});
