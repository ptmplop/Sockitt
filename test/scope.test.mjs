import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { build } from 'esbuild';

let lib;

before(async () => {
  const result = await build({
    stdin: {
      contents: "export * from './src/shared/scope';",
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

const config = (incognitoProfileId) => ({ settings: { incognitoProfileId } });

test('a separate profile is the incognito scope only once access is granted', () => {
  assert.equal(lib.incognitoActiveId(config('p1'), true), 'p1');
  // The setting exists but Chrome is not letting Sockitt near incognito: the
  // regular settings span it, so there is no separate scope to report.
  assert.equal(lib.incognitoActiveId(config('p1'), false), null);
});

test('"same as regular windows" is not a scope of its own', () => {
  assert.equal(lib.incognitoActiveId(config(''), true), null);
  assert.equal(lib.incognitoActiveId(config(''), false), null);
});

test('the same profile keeps one override slot per scope', () => {
  assert.notEqual(lib.tempRuleKey('p1', 'incognito'), lib.tempRuleKey('p1', 'regular'));
});

test('no profile id can make the two scopes share a slot', () => {
  // An imported configuration may carry any string as a profile id, including
  // one shaped like the other namespace. Naming both scopes in the key is what
  // stops that reaching across: the keys differ in their first character.
  const ids = ['p1', 'incognito:p1', 'regular:p1', '', ':', 'incognito:regular:p1'];
  const keys = new Set();
  for (const id of ids) {
    for (const scope of ['regular', 'incognito']) keys.add(lib.tempRuleKey(id, scope));
  }
  assert.equal(keys.size, ids.length * 2, 'every (profile, scope) pair needs its own key');
});
