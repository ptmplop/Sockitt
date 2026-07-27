import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { build } from 'esbuild';

let lib;

before(async () => {
  const result = await build({
    stdin: {
      contents: "export * from './src/shared/tabs';",
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

test('a loaded page is the target, and is not pending', () => {
  assert.deepEqual(lib.tabTarget({ url: 'https://example.com/a?b=1', status: 'complete' }), {
    url: 'https://example.com/a?b=1',
    host: 'example.com',
    pending: false,
  });
});

test('a navigation in flight wins over the document still on screen', () => {
  // Chrome's real shape while a firewalled host hangs: url is the OLD page.
  assert.deepEqual(
    lib.tabTarget({ url: 'https://old.example/page', pendingUrl: 'https://blocked.example/x' }),
    { url: 'https://blocked.example/x', host: 'blocked.example', pending: true }
  );
});

test('a brand-new tab typed straight at a hanging host still has a target', () => {
  // A fresh tab reports url:"" (or chrome://newtab/) until something commits —
  // this is the case that used to say "no web page here" and offer no rule.
  assert.deepEqual(lib.tabTarget({ url: '', pendingUrl: 'http://blocked.example/' }), {
    url: 'http://blocked.example/',
    host: 'blocked.example',
    pending: true,
  });
  assert.deepEqual(lib.tabTarget({ url: 'chrome://newtab/', pendingUrl: 'http://blocked.example/' }), {
    url: 'http://blocked.example/',
    host: 'blocked.example',
    pending: true,
  });
});

test('a same-URL navigation that is hanging counts as pending', () => {
  const t = lib.tabTarget({ url: 'https://slow.example/', pendingUrl: 'https://slow.example/' });
  assert.equal(t.pending, true);
  assert.equal(t.host, 'slow.example');
});

test('a non-web pending navigation leaves the committed page in charge', () => {
  assert.deepEqual(lib.tabTarget({ url: 'https://example.com/', pendingUrl: 'chrome://settings/' }), {
    url: 'https://example.com/',
    host: 'example.com',
    pending: false,
  });
});

test('pages Sockitt cannot route have no target', () => {
  assert.equal(lib.tabTarget(undefined), null);
  assert.equal(lib.tabTarget(null), null);
  assert.equal(lib.tabTarget({}), null);
  assert.equal(lib.tabTarget({ url: 'chrome://extensions/' }), null);
  assert.equal(lib.tabTarget({ url: 'about:blank' }), null);
  assert.equal(lib.tabTarget({ url: 'file:///tmp/x.html' }), null);
  assert.equal(lib.tabTarget({ url: 'chrome-error://chromewebdata/' }), null);
  // A scrubbed tab (no permission for it) must not become a phantom target.
  assert.equal(lib.tabTarget({ status: 'loading' }), null);
});

test('a URL that only looks like one is rejected, not thrown on', () => {
  assert.equal(lib.tabTarget({ url: 'https://' }), null);
  assert.equal(lib.tabTarget({ url: 'http://' }), null);
  // Scheme-prefixed but not an http(s) navigation — must not slip past the test.
  assert.equal(lib.tabTarget({ url: 'view-source:http://example.com/' }), null);
  assert.equal(lib.tabTarget({ url: 'javascript:fetch("http://x")' }), null);
});

test('the scheme test is case-insensitive, like the rest of Sockitt', () => {
  assert.deepEqual(lib.tabTarget({ url: 'HTTPS://Example.COM/x' }), {
    url: 'HTTPS://Example.COM/x',
    host: 'example.com',
    pending: false,
  });
});

test('IPv6 and port hosts keep the form the rule matchers expect', () => {
  assert.equal(lib.tabTarget({ url: 'http://10.0.0.5:8080/x' }).host, '10.0.0.5');
  assert.equal(lib.tabTarget({ url: 'http://[::1]:8080/' }).host, '[::1]');
});
