import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { build } from 'esbuild';

/**
 * Which lines a rule list ignored, and why.
 *
 * The count on its own said a line had been dropped without saying which, so on
 * any list longer than a screen it was a puzzle with no way in. These assert
 * that every rejection path names a line number, the text, and a reason that
 * points at the actual cause.
 */

let lib;

before(async () => {
  const result = await build({
    stdin: {
      contents: "export * from './src/shared/rulelist';",
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

const domain = (text) => lib.parseRuleList('switchy', text);
const autoproxy = (text) => lib.parseRuleList('autoproxy', text);

/* ---------------- the case that prompted this ---------------- */

const REAL_LIST = [
  '*.google.com',
  '*.dns.com',
  'metrics*.example.net',
  'ads.example.com # test',
  '*.tracker.example        # the host and every subdomain',
  'metrics*.example.net     # * and ? are wildcards',
  'https://cdn.example/px   # a URL prefix; trailing * is implied',
  '@@safe.example.com       # never match this one',
  '@@google.co.uk # This is a test',
].join('\n');

test('the https-with-a-path line is the only one rejected, and is named', () => {
  const parsed = domain(REAL_LIST);
  assert.equal(parsed.count, 8);
  assert.equal(parsed.ignored, 1);
  assert.equal(parsed.rejected.length, 1);

  const [bad] = parsed.rejected;
  assert.equal(bad.line, 7, 'the 1-based line number a text editor would show');
  assert.equal(bad.text, 'https://cdn.example/px   # a URL prefix; trailing * is implied');
  // The reason must name the cause AND the way out, not just restate the fact.
  assert.match(bad.reason, /https:\/\/ with a path/);
  assert.match(bad.reason, /cdn\.example/, 'suggests the bare host');
  assert.match(bad.reason, /http:\/\//, 'suggests the scheme that keeps paths');
});

test('the same entry over http:// is accepted', () => {
  const parsed = domain(REAL_LIST.replace('https://cdn.example/px', 'http://cdn.example/px'));
  assert.equal(parsed.ignored, 0);
  assert.deepEqual(parsed.rejected, []);
  assert.equal(parsed.count, 9);
});

/* ---------------- line numbering ---------------- */

test('line numbers count blanks and comments, so they match the editor', () => {
  const parsed = domain(['# header', '', 'ok.example', '', 'https://x.example/p', ''].join('\n'));
  assert.equal(parsed.rejected[0].line, 5);
});

test('a rejected line reports the raw text, comment and all', () => {
  const parsed = domain('bad:8080   # why is this here');
  assert.equal(parsed.rejected[0].text, 'bad:8080   # why is this here');
});

test('a pathological line is truncated in the record', () => {
  const parsed = domain('x'.repeat(500) + ':80');
  assert.ok(parsed.rejected[0].text.length <= 160);
  assert.ok(parsed.rejected[0].text.endsWith('…'));
});

/* ---------------- every domain-list rejection has its own reason ---------------- */

const REASONS = [
  ['UrlRegex: ^https?://ads\\.', /contains a space/, 'a typed condition from another tool'],
  ['https://cdn.example/px', /https:\/\/ with a path/, 'https with a path'],
  ['bücher.example', /non-ASCII/, 'needs punycode'],
  ['10.0.0.0/8', /path or a CIDR/, 'CIDR'],
  ['example.com/path', /path or a CIDR/, 'a path on a bare entry'],
  ['example.com:8080', /has a port/, 'a port'],
  ['exam+ple.com', /is not a hostname/, 'an illegal character'],
];

for (const [entry, pattern, what] of REASONS) {
  test(`domain list explains ${what}`, () => {
    const parsed = domain(entry);
    assert.equal(parsed.ignored, 1, `"${entry}" should be rejected`);
    assert.equal(parsed.rejected.length, 1);
    assert.match(parsed.rejected[0].reason, pattern);
    // Every reason is a sentence, not a code.
    assert.ok(parsed.rejected[0].reason.endsWith('.'), 'reads as a sentence');
  });
}

test('every rejected line gets a non-empty reason, whatever the cause', () => {
  const junk = ['a b', 'https://x.example/p', 'ü.example', 'x/y', 'x:1', 'x+y', '...'];
  const parsed = domain(junk.join('\n'));
  assert.equal(parsed.ignored, junk.length);
  for (const r of parsed.rejected) {
    assert.ok(r.reason.length > 10, `line ${r.line} ("${r.text}") has no usable reason`);
  }
});

/* ---------------- autoproxy ---------------- */

test('autoproxy explains a bare || and a bare |', () => {
  const parsed = autoproxy('||\n|');
  assert.equal(parsed.ignored, 2);
  assert.match(parsed.rejected[0].reason, /nothing after \|\|/);
  assert.match(parsed.rejected[1].reason, /nothing after \|/);
});

test('autoproxy distinguishes an invalid regex from an unsafe one', () => {
  const parsed = autoproxy(['/([/', '/(a+)+$/'].join('\n'));
  assert.equal(parsed.ignored, 2);
  assert.match(parsed.rejected[0].reason, /not a valid regular expression/);
  assert.match(parsed.rejected[1].reason, /backtrack catastrophically/);
});

/* ---------------- bounds ---------------- */

test('a list of nothing but bad lines records a sample, and the count stays true', () => {
  const parsed = domain(Array.from({ length: 300 }, (_, i) => `bad${i}:80`).join('\n'));
  assert.equal(parsed.ignored, 300, 'the total is not capped');
  assert.equal(parsed.rejected.length, 20, 'the sample is');
  assert.equal(parsed.rejected[0].line, 1);
  assert.equal(parsed.rejected[19].line, 20);
});

test('a clean list carries an empty sample, not a missing field', () => {
  const parsed = domain('example.com\n*.foo.example');
  assert.deepEqual(parsed.rejected, []);
  assert.equal(parsed.ignored, 0);
});

test('an empty body parses to the shared empty result, sample included', () => {
  assert.deepEqual(domain('   ').rejected, []);
  assert.deepEqual(autoproxy('').rejected, []);
});
