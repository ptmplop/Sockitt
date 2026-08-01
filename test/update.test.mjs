import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { build } from 'esbuild';

let lib;

before(async () => {
  const result = await build({
    stdin: {
      contents: "export { isNewer, readPendingUpdate } from './src/shared/update';",
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

test('isNewer compares component-wise', () => {
  const { isNewer } = lib;
  assert.equal(isNewer('1.21.5', '1.20.2'), true);
  assert.equal(isNewer('1.20.2', '1.21.5'), false);
  assert.equal(isNewer('1.21.5', '1.21.5'), false);
  assert.equal(isNewer('2.0.0', '1.99.99'), true);
  // Not lexicographic: '9' must not beat '10'.
  assert.equal(isNewer('1.9.0', '1.10.0'), false);
  assert.equal(isNewer('1.10.0', '1.9.0'), true);
});

test('isNewer treats missing components as zero', () => {
  const { isNewer } = lib;
  assert.equal(isNewer('1.2', '1.2.0'), false);
  assert.equal(isNewer('1.2.0', '1.2'), false);
  assert.equal(isNewer('1.2.1', '1.2'), true);
  assert.equal(isNewer('1.2', '1.2.1'), false);
  assert.equal(isNewer('1.2.0.1', '1.2'), true);
});

test('isNewer refuses anything that is not an extension version', () => {
  const { isNewer } = lib;
  // Every one of these must answer "not newer" rather than throw or guess.
  for (const bad of ['', 'x', '1.x', '1..2', '1.2.3.4.5', '-1', '1.2.3-beta', '65536', ' 1.2', null, undefined, 5, {}]) {
    assert.equal(isNewer(bad, '1.0.0'), false, `candidate ${JSON.stringify(bad)}`);
    assert.equal(isNewer('9.9.9', bad), false, `current ${JSON.stringify(bad)}`);
  }
  assert.equal(isNewer('65535', '1.0.0'), true); // the top of the legal range still works
});

test('readPendingUpdate answers only while the update is still pending', () => {
  const { readPendingUpdate } = lib;
  const record = { version: '1.21.5', at: 1000 };
  assert.deepEqual(readPendingUpdate(record, '1.20.2'), { version: '1.21.5', at: 1000 });
  // Self-healing: the update landed, so the note about it stops answering even
  // though nothing cleared it.
  assert.equal(readPendingUpdate(record, '1.21.5'), null);
  assert.equal(readPendingUpdate(record, '1.22.0'), null);
});

test('readPendingUpdate survives junk in storage', () => {
  const { readPendingUpdate } = lib;
  for (const bad of [null, undefined, 'nope', 5, [], {}, { version: 7 }, { version: '1.x' }]) {
    assert.equal(readPendingUpdate(bad, '1.0.0'), null, JSON.stringify(bad));
  }
  // A missing timestamp reads as 0 so the banner can tell it apart from a real
  // one and leave the "arrived N ago" clause off.
  assert.deepEqual(readPendingUpdate({ version: '2.0.0' }, '1.0.0'), { version: '2.0.0', at: 0 });
  assert.deepEqual(readPendingUpdate({ version: '2.0.0', at: 'soon' }, '1.0.0'), {
    version: '2.0.0',
    at: 0,
  });
});
