import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { build } from 'esbuild';

/**
 * Track-map layout tests. shared/yard.ts is pure geometry, so it runs here with
 * nothing stubbed. The invariants are the ones the drawing relies on and a
 * screenshot cannot prove for every configuration: every branch is a true 45°,
 * lands exactly on its own track, the first-reached destination sits lowest,
 * parallel diagonals never meet, and anything that does cross a track is
 * reported so the view can case it.
 */

let lib;

before(async () => {
  const result = await build({
    stdin: {
      contents: "export * from './src/shared/yard'; export { BUILTIN_FILL, routeColours } from './src/shared/colour'; export { hostLooksReal } from './src/shared/match';",
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
    { id: 'r1', enabled: true, type: 'hostWildcard', pattern: '*.github.com', targetId: 'p-work' },
    { id: 'r2', enabled: true, type: 'hostWildcard', pattern: '*.slack.com', targetId: 'p-work' },
    { id: 'r3', enabled: true, type: 'keyword', pattern: 'internal', targetId: 'p-home' },
    { id: 'r4', enabled: true, type: 'ipCidr', pattern: '10.0.0.0/8', targetId: 'p-home' },
    { id: 'r5', enabled: false, type: 'time', pattern: '22:00-06:00', targetId: 'direct' },
  ],
};
const ads = { id: 'p-ads', kind: 'rulelist', name: 'Ad block', color: '#ffb020', format: 'autoproxy', url: '', updateIntervalH: 24, matchTargetId: 'p-home', defaultTargetId: 'direct', text: '||doubleclick.net\n||ads.example.com\n' };
const alias = { id: 'p-alias', kind: 'virtual', name: 'Current egress', color: '#14b8a6', targetId: 'p-office' };
const config = (profiles, activeId = 'p-office') => ({ version: 4, rev: 1, activeId, profiles, settings: {} });

const near = (a, b) => Math.abs(a - b) < 0.02;

function assertGeometry(layout) {
  const trackY = new Map(layout.tracks.map((t) => [t.id, t.y]));
  for (const b of layout.branches) {
    const [x1, y1, x2, y2] = b.diagonal;
    assert.ok(near(x2 - x1, y2 - y1), `branch ${b.junctionKey}→${b.targetId} is not 45° (${x2 - x1} vs ${y2 - y1})`);
    // the path ends on the track it belongs to, at its merge x
    const end = b.d.trim().split(/\s+/).slice(-2).map(Number);
    assert.ok(near(end[0], b.mergeX), `branch ends at x ${end[0]}, merge says ${b.mergeX}`);
    assert.equal(end[1], trackY.get(b.targetId), `branch ${b.junctionKey} lands off its track`);
    // its track begins no later than it lands
    const track = layout.tracks.find((t) => t.id === b.targetId);
    assert.ok(track.startX <= b.mergeX + 0.01, `track ${track.id} starts after a branch merges into it`);
    assert.ok(b.mergeX < layout.width, 'merge point outside the drawing');
  }
  // Every diagonal runs at 45° down-right, so two of them meet only if they are
  // the same line — which happens only for branches out of one junction.
  for (const a of layout.branches) {
    for (const b of layout.branches) {
      if (a === b || a.junctionKey === b.junctionKey) continue;
      const ca = a.diagonal[1] - a.diagonal[0];
      const cb = b.diagonal[1] - b.diagonal[0];
      assert.ok(!near(ca, cb), `diagonals of ${a.junctionKey} and ${b.junctionKey} coincide`);
    }
  }
}

test('Office routing: five junctions in rule order, two tracks, first-reached lowest', () => {
  const c = config([work, home, office, ads]);
  const y = lib.layoutYard(c, 'p-office');
  assert.equal(y.kind, 'switch');
  assert.deepEqual(y.junctions.map((j) => j.label), ['1', '2', '3', '4', '5']);
  assert.deepEqual(y.junctions.map((j) => j.x), [200, 320, 440, 560, 680]);
  assert.equal(y.defaultTarget, 'direct');
  assert.equal(y.tracks[0].id, 'direct');
  assert.equal(y.tracks[0].isDefault, true);
  const work_ = y.tracks.find((t) => t.id === 'p-work');
  const home_ = y.tracks.find((t) => t.id === 'p-home');
  assert.ok(work_.y > home_.y, 'Work (reached at rule 1) must sit below Home (rule 3)');
  assert.equal(y.branches.length, 4);
  assert.deepEqual(y.branches.map((b) => `${b.junctionKey}>${b.targetId}`), ['r1>p-work', 'r2>p-work', 'r3>p-home', 'r4>p-home']);
  // rule 5 is off and points at the default: a junction, no branch
  assert.equal(y.junctions[4].off, true);
  assert.deepEqual(y.junctions[4].targets, []);
  assert.equal(lib.crossings(y).length, 0, 'rules grouped by destination must not cross');
  assertGeometry(y);
});

test('a rule that sends traffic to the default destination does not branch', () => {
  const s = { ...office, rules: [{ id: 'a', enabled: true, type: 'hostWildcard', pattern: '*.a', targetId: 'direct' }] };
  const y = lib.layoutYard(config([work, s]), 'p-office');
  assert.equal(y.branches.length, 0);
  assert.equal(y.tracks.length, 1);
});

test('interleaved destinations cross, and the crossing is reported', () => {
  const s = {
    ...office,
    rules: [
      { id: 'a', enabled: true, type: 'hostWildcard', pattern: '*.a', targetId: 'p-work' },
      { id: 'b', enabled: true, type: 'hostWildcard', pattern: '*.b', targetId: 'p-home' },
      { id: 'c', enabled: true, type: 'hostWildcard', pattern: '*.c', targetId: 'p-work' },
    ],
  };
  const y = lib.layoutYard(config([work, home, s]), 'p-office');
  assertGeometry(y);
  const crossed = lib.crossings(y);
  assert.equal(crossed.length, 1);
  assert.equal(crossed[0].branch.junctionKey, 'c');
  assert.equal(crossed[0].track.id, 'p-home');
});

test('past six rules the rest fold into one wide junction', () => {
  const rules = Array.from({ length: 24 }, (_, i) => ({
    id: `r${i}`, enabled: i !== 9, type: 'hostWildcard', pattern: `*.site${i}.example.com`, targetId: i % 2 ? 'p-work' : 'p-home',
  }));
  const s = { ...office, rules };
  const y = lib.layoutYard(config([work, home, s]), 'p-office');
  assert.equal(y.junctions.length, 6);
  const fold = y.junctions[5];
  assert.equal(fold.key, 'fold');
  assert.equal(fold.label, '6-24');
  assert.equal(fold.caption, '19 more rules');
  assert.equal(fold.ruleIndexes.length, 19);
  assert.deepEqual([...fold.targets].sort(), ['p-home', 'p-work']);
  assertGeometry(y);
});

test('a long pattern is shortened from the middle to its slot', () => {
  const short = lib.fitPattern('*.github.com', 106);
  assert.equal(short, '*.github.com');
  const long = lib.fitPattern('*.googleapis.example-content.com', 106);
  assert.ok(long.length <= 14, long);
  assert.ok(long.includes('…'));
  assert.ok(long.startsWith('*.goo') && long.endsWith('.com'), long);
});

test('a proxy: ink to its bypass diamond, then its own line; with no bypass list, its line from the start', () => {
  const y = lib.layoutYard(config([work]), 'p-work');
  assert.equal(y.kind, 'proxy');
  assert.equal(y.defaultTarget, 'p-work');
  assert.equal(y.junctions.length, 1);
  assert.equal(y.junctions[0].shape, 'diamond');
  assert.deepEqual(y.junctions[0].targets, ['direct']);
  const d = y.junctions[0];
  assert.equal(y.trunkEnd, d.x + d.half + 1, 'undecided until the diamond, so ink until it');
  assertGeometry(y);
  const plain = lib.layoutYard(config([home]), 'p-home');
  assert.equal(plain.junctions.length, 0, 'an empty bypass list has no junction');
  assert.equal(plain.trunkEnd, plain.startX, 'nothing decides, so the proxy line runs from the start bar');
});

test('the default line leaves the last junction with its branches, not a seam further on', () => {
  const y = lib.layoutYard(config([work, home, office]), 'p-office');
  const last = y.junctions[y.junctions.length - 1];
  assert.equal(y.trunkEnd, last.x + last.half + 1);
  for (const b of y.branches.filter((x) => x.junctionKey === last.key)) {
    assert.ok(y.trunkEnd < b.mergeX, 'the default is under way before the branch beside it lands');
  }
});

test('a rule list is one junction, branching only when its targets differ', () => {
  const y = lib.layoutYard(config([home, ads]), 'p-ads');
  assert.equal(y.kind, 'rulelist');
  assert.equal(y.junctions[0].shape, 'list');
  assert.equal(y.junctions[0].fullText, '2 entries');
  assert.deepEqual(y.junctions[0].targets, ['p-home']);
  const same = lib.layoutYard(config([home, { ...ads, matchTargetId: 'direct' }]), 'p-ads');
  assert.equal(same.branches.length, 0);
});

test('an alias is drawn as what it points at, and says so', () => {
  const y = lib.layoutYard(config([work, home, office, alias], 'p-alias'), 'p-alias');
  assert.equal(y.kind, 'switch');
  assert.equal(y.profileId, 'p-office');
  assert.equal(y.viaAlias, 'Current egress');
  const loop = { id: 'x', kind: 'virtual', name: 'X', color: '#000000', targetId: 'y' };
  const loop2 = { id: 'y', kind: 'virtual', name: 'Y', color: '#000000', targetId: 'x' };
  const l = lib.layoutYard(config([loop, loop2], 'x'), 'x');
  assert.equal(l.kind, 'direct', 'an alias loop ends instead of recursing');
});

test('Direct and System are one line, System dashed', () => {
  const d = lib.layoutYard(config([]), 'direct');
  assert.equal(d.kind, 'direct');
  assert.equal(d.tracks.length, 1);
  const s = lib.layoutYard(config([]), 'system');
  assert.equal(s.kind, 'system');
  assert.equal(s.tracks[0].dashed, true);
});

test('overrides take the first junction, ahead of rule 1', () => {
  const overrides = [{ id: 't1', enabled: true, type: 'hostWildcard', pattern: '*.github.com', targetId: 'p-home' }];
  const y = lib.layoutYard(config([work, home, office]), 'p-office', lib.FULL, overrides);
  assert.equal(y.junctions[0].key, 'overrides');
  assert.equal(y.junctions[0].shape, 'pin');
  assert.equal(y.junctions[1].label, '1');
  assertGeometry(y);
});

test('trace: the junction that takes a request is the one the resolver would', () => {
  const c = config([work, home, office]);
  const y = lib.layoutYard(c, 'p-office');
  const at = (url, host) => lib.traceYard(c, y, url, host);
  assert.deepEqual(
    (({ junctionKey, targetId, ruleIndex }) => ({ junctionKey, targetId, ruleIndex }))(at('https://api.github.com/', 'api.github.com')),
    { junctionKey: 'r1', targetId: 'p-work', ruleIndex: 0 }
  );
  assert.equal(at('https://wiki.internal.corp/', 'wiki.internal.corp').junctionKey, 'r3');
  const none = at('https://news.example.com/', 'news.example.com');
  assert.equal(none.junctionKey, null);
  assert.equal(none.targetId, 'direct');
  // an override wins over rule 1
  const overrides = [{ id: 't1', enabled: true, type: 'hostWildcard', pattern: '*.github.com', targetId: 'p-home' }];
  const yo = lib.layoutYard(c, 'p-office', lib.FULL, overrides);
  const o = lib.traceYard(c, yo, 'https://api.github.com/', 'api.github.com', overrides);
  assert.equal(o.junctionKey, 'overrides');
  assert.equal(o.targetId, 'p-home');
  // a proxy's bypass list
  const yp = lib.layoutYard(config([work]), 'p-work');
  assert.equal(lib.traceYard(config([work]), yp, 'http://intranet/', 'intranet').junctionKey, 'bypass');
  assert.equal(lib.traceYard(config([work]), yp, 'https://example.com/', 'example.com').junctionKey, null);
});

test('route colours: every palette fill gets a line at 3:1 and text at 4.5:1 in both themes', () => {
  const palette = ['#46c9e5', '#3b82f6', '#6d5dfc', '#7c3aed', '#f472b6', '#f5576c', '#fb923c', '#ffb020', '#84cc16', '#2dd4a7', '#14b8a6', '#64748b'];
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lum = (rgb) => {
    const l = rgb.map((c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
  };
  const cr = (a, b) => { const [x, y] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const fill of palette) {
    const c = lib.routeColours(fill);
    for (const g of ['#ffffff', '#f4f5f7']) {
      assert.ok(cr(c.lineLight, g) >= 3, `${fill} line on ${g}: ${cr(c.lineLight, g).toFixed(2)}`);
      assert.ok(cr(c.textLight, g) >= 4.5, `${fill} text on ${g}: ${cr(c.textLight, g).toFixed(2)}`);
    }
    for (const g of ['#0f1013', '#16181c']) {
      assert.ok(cr(c.lineDark, g) >= 3, `${fill} dark line on ${g}: ${cr(c.lineDark, g).toFixed(2)}`);
      assert.ok(cr(c.textDark, g) >= 4.5, `${fill} dark text on ${g}: ${cr(c.textDark, g).toFixed(2)}`);
    }
  }
});

test('a traced address must have a host that could be one', () => {
  // Chrome parses "https://not a url" and percent-encodes the spaces into the
  // hostname; the trace field and the Inspector must not route that as a site.
  for (const host of ['api.github.com', 'localhost', '10.0.0.1', '[::1]', 'xn--bcher-kva.example', 'example.com.', 'under_score.example']) {
    assert.equal(lib.hostLooksReal(host), true, host);
  }
  for (const host of ['not%20a%20url', 'a..b', '', '.example.com', 'exa mple.com']) {
    assert.equal(lib.hostLooksReal(host), false, host);
  }
  // What Chrome makes of https://not a url at all (Node's stricter parser throws).
  assert.equal(lib.hostLooksReal('not%20a%20url%20at%20all'), false);
});

test('a rule hop is named by its place in first-match order', () => {
  const office = {
    id: 'p-office', kind: 'switch', name: 'Office', color: '#6d5dfc', defaultTargetId: 'direct',
    rules: [
      { id: 'a', enabled: false, type: 'hostWildcard', pattern: '*.github.com', targetId: 'p-work' },
      { id: 'b', enabled: true, type: 'hostWildcard', pattern: '*.github.com', targetId: 'p-work' },
      { id: 'c', enabled: true, type: 'keyword', pattern: 'internal', targetId: 'p-work' },
    ],
  };
  const config = { version: 4, rev: 1, activeId: 'p-office', profiles: [work, office], settings: {} };
  // The off duplicate above it is skipped, the way the resolver skips it.
  assert.equal(lib.edgeRuleIndex(config, { from: 'p-office', to: 'p-work', kind: 'rule', pattern: '*.github.com', ruleType: 'hostWildcard' }), 1);
  assert.equal(lib.edgeRuleIndex(config, { from: 'p-office', to: 'p-work', kind: 'rule', pattern: 'internal', ruleType: 'keyword' }), 2);
  assert.equal(lib.edgeRuleIndex(config, { from: 'p-office', to: 'direct', kind: 'default' }), -1);
});

test('a list junction names its first entry and how many more, never half of one', () => {
  assert.equal(lib.fitList(['<local>', '*.intranet'], 106), '<local> +1');
  assert.equal(lib.fitList(['<local>'], 106), '<local>');
  assert.equal(lib.fitList(['a.io', 'b.io'], 106), 'a.io, b.io');
  const proxy = { ...work, bypass: ['<local>', '*.intranet', '10.0.0.0/8'] };
  const config = { version: 4, rev: 1, activeId: proxy.id, profiles: [proxy], settings: {} };
  const j = lib.layoutYard(config, proxy.id, lib.FULL).junctions.find((x) => x.key === 'bypass');
  assert.equal(j.text, '<local> +2');
  assert.equal(j.fullText, '<local>, *.intranet, 10.0.0.0/8');
});
