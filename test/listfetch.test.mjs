import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { build } from 'esbuild';

/**
 * A failed rule-list fetch, explained. fetch() says "Failed to fetch" for every
 * network failure, so the options page gathers evidence (status, a no-cors
 * probe, proxy errors, an exact net:: code when it can) and this turns it into
 * a sentence that names the route and says what to do.
 */

let lib;

before(async () => {
  const result = await build({
    stdin: { contents: "export * from './src/shared/listfetch';", resolveDir: new URL('..', import.meta.url).pathname, loader: 'ts' },
    bundle: true,
    format: 'esm',
    write: false,
  });
  lib = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
});

const direct = { via: 'direct' };
const system = { via: 'system' };
const work = { via: 'proxy', name: 'Work SOCKS5', endpoint: 'SOCKS5 proxy.corp.io:1080', scheme: 'socks5' };
const office = { via: 'proxy', name: 'Office HTTP', endpoint: 'HTTP 10.0.0.2:3128', scheme: 'http' };
const host = 'lists.example.org';

test('an HTTP status is named, with what it means', () => {
  const nf = lib.explainListFailure({ kind: 'status', status: 404, statusText: '' }, direct, host, true);
  assert.equal(nf.short, 'The server answered 404 Not Found');
  assert.match(nf.detail, /^lists\.example\.org answered 404 Not Found directly\. There’s no list at that address/);
  const forbidden = lib.explainListFailure({ kind: 'status', status: 403, statusText: 'Forbidden' }, work, host, true);
  assert.match(forbidden.detail, /answered 403 Forbidden through Work SOCKS5\. The server refused/);
  const auth = lib.explainListFailure({ kind: 'status', status: 407 }, office, host, false);
  assert.match(auth.detail, /Office HTTP wants a username and password/);
});

test('a 5xx over plain http through an HTTP proxy may be the proxy’s own answer', () => {
  const viaHttpProxy = lib.explainListFailure({ kind: 'status', status: 502 }, office, host, false);
  assert.match(viaHttpProxy.detail, /or Office HTTP couldn’t reach it and answered for it/);
  const overHttps = lib.explainListFailure({ kind: 'status', status: 502 }, office, host, true);
  assert.doesNotMatch(overHttps.detail, /answered for it/, 'over https the proxy can only tunnel, so a status is the server’s');
  const viaSocks = lib.explainListFailure({ kind: 'status', status: 502 }, work, host, false);
  assert.doesNotMatch(viaSocks.detail, /answered for it/, 'a SOCKS proxy never answers HTTP itself');
});

test('a reply the browser would not hand over is told apart from no reply at all', () => {
  // A 2xx the prefetch could load: the list is there, the server just won't share it.
  const cors = lib.explainListFailure({ kind: 'network', answered: true, listOk: true }, direct, host, true);
  assert.equal(cors.short, 'The server won’t let extensions read the list');
  assert.match(cors.detail, /sent the list, but without an Access-Control-Allow-Origin header/);
  // An error status the browser won't name: the address is the likelier problem.
  const errorPage = lib.explainListFailure({ kind: 'network', answered: true, listOk: false }, work, host, true);
  assert.equal(errorPage.short, 'The server answered with an error page');
  assert.match(errorPage.detail, /through Work SOCKS5 with an error rather than the list - check the address/);
  // The prefetch couldn't tell: say both.
  const unknown = lib.explainListFailure({ kind: 'network', answered: true }, direct, host, true);
  assert.equal(unknown.short, 'The reply couldn’t be read');
  // Plain http through an HTTP proxy: the reply may be the proxy's own, whatever the prefetch saw.
  const viaHttpProxy = lib.explainListFailure({ kind: 'network', answered: true, listOk: true }, office, host, false);
  assert.match(viaHttpProxy.detail, /lists\.example\.org, or Office HTTP in front of it, answered something.*or Office HTTP sent its own error - it may not reach lists\.example\.org, or it may want a sign-in/);
  const nothing = lib.explainListFailure({ kind: 'network', answered: false }, direct, host, true);
  assert.equal(nothing.short, 'Couldn’t reach lists.example.org directly');
  const viaSystem = lib.explainListFailure({ kind: 'network' }, system, host, true);
  assert.match(viaSystem.detail, /through your system’s proxy settings/);
});

test('through a proxy with no proxy error, it was the onward leg that failed', () => {
  // A dead proxy or a refused tunnel always reports; SOCKS failures never do.
  const socks = lib.explainListFailure({ kind: 'network' }, work, host, true);
  assert.match(socks.detail, /through Work SOCKS5\. The proxy is running, but it couldn’t connect to the server/);
  const http = lib.explainListFailure({ kind: 'network' }, office, host, true);
  assert.match(http.detail, /through Office HTTP\. The proxy is running, but the connection to the server behind it failed - often the secure connection/);
  // Plain http has no secure connection to blame.
  const plain = lib.explainListFailure({ kind: 'network', answered: false }, direct, host, false);
  assert.doesNotMatch(plain.detail, /secure connection/);
  // A proxy error is never trusted on a direct route: it came from other traffic.
  const stray = lib.explainListFailure({ kind: 'network', proxyError: 'net::ERR_PROXY_CONNECTION_FAILED' }, direct, host, true);
  assert.equal(stray.short, 'Couldn’t reach lists.example.org directly');
});

test('Chrome giving up on a connection is told apart from a server that never answers', () => {
  const connect = lib.explainListFailure({ kind: 'timeout', seconds: 30, connect: true }, work, host, true);
  assert.equal(connect.short, 'No connection in 30 seconds');
  assert.match(connect.detail, /Chrome gave up connecting through Work SOCKS5 after 30 seconds/);
  const signIn = lib.explainListFailure({ kind: 'timeout', seconds: 60 }, office, host, true);
  assert.match(signIn.detail, /or Office HTTP may be waiting for a sign-in/);
});

test('a proxy error during the attempt names the proxy and its address', () => {
  const down = lib.explainListFailure({ kind: 'network', proxyError: 'net::ERR_PROXY_CONNECTION_FAILED' }, work, host, true);
  assert.equal(down.short, 'Couldn’t connect to Work SOCKS5');
  assert.match(down.detail, /^Couldn’t connect to Work SOCKS5 \(SOCKS5 proxy\.corp\.io:1080\)\. The proxy isn’t running/);
  // A name with a colon or a dash in it survives into the toast whole.
  const named = lib.explainListFailure({ kind: 'network', proxyError: 'net::ERR_PROXY_CONNECTION_FAILED' }, { ...work, name: 'VPN: Frankfurt - 2' }, host, true);
  assert.equal(named.short, 'Couldn’t connect to VPN: Frankfurt - 2');
  const tunnel = lib.explainListFailure({ kind: 'network', proxyError: 'net::ERR_TUNNEL_CONNECTION_FAILED' }, office, host, true);
  assert.match(tunnel.detail, /Office HTTP \(HTTP 10\.0\.0\.2:3128\) wouldn’t open a connection to lists\.example\.org\. It may not be able to reach that site/);
  // The OS's proxy is named as such, capitalised where it opens the sentence.
  const sys = lib.explainListFailure({ kind: 'network', proxyError: 'net::ERR_TUNNEL_CONNECTION_FAILED' }, system, host, true);
  assert.match(sys.short, /^Your system’s proxy wouldn’t open a connection/);
});

test('an exact code, when the optional grant gives one, beats every guess', () => {
  const dns = lib.explainListFailure({ kind: 'network', netError: 'net::ERR_NAME_NOT_RESOLVED', answered: false }, direct, host, true);
  assert.equal(dns.short, 'The name lists.example.org doesn’t resolve');
  const cert = lib.explainListFailure({ kind: 'network', netError: 'net::ERR_CERT_AUTHORITY_INVALID' }, direct, host, true);
  assert.match(cert.detail, /certificate isn’t trusted \(ERR_CERT_AUTHORITY_INVALID\)/);
  const socks = lib.explainListFailure({ kind: 'network', netError: 'net::ERR_SOCKS_CONNECTION_HOST_UNREACHABLE' }, work, host, true);
  assert.match(socks.detail, /Work SOCKS5 \(SOCKS5 proxy\.corp\.io:1080\) couldn’t open a connection to lists\.example\.org/);
  // A code with no wording of its own is named, never turned into "nothing answered".
  const unknown = lib.explainListFailure({ kind: 'network', netError: 'net::ERR_CONTENT_DECODING_FAILED' }, direct, host, true);
  assert.equal(unknown.short, 'The request failed (ERR_CONTENT_DECODING_FAILED)');
});

test('the rest: invalid, empty, too large, no answer in time', () => {
  assert.equal(lib.explainListFailure({ kind: 'invalid', reason: 'Not a URL.' }, direct, '', true).detail, 'Not a URL.');
  assert.match(lib.explainListFailure({ kind: 'empty' }, direct, host, true).detail, /was empty/);
  assert.match(lib.explainListFailure({ kind: 'too-large', maxBytes: 4 * 1048576 }, direct, host, true).detail, /over 4 MB/);
  const slow = lib.explainListFailure({ kind: 'timeout', seconds: 60 }, work, host, true);
  assert.equal(slow.short, 'No answer in 60 seconds');
  assert.match(slow.detail, /through Work SOCKS5 in 60 seconds, so Sockitt stopped waiting - the proxy or the server behind it may be stuck\./);
  const hang = lib.explainListFailure({ kind: 'timeout', seconds: 60 }, direct, host, true);
  assert.match(hang.detail, /^lists\.example\.org accepted the connection but sent nothing back in 60 seconds/);
});

test('a sign-in Sockitt may not answer, a broken transfer, and another extension’s proxy', () => {
  const signin = lib.explainListFailure({ kind: 'signin' }, office, host, true);
  assert.equal(signin.short, 'Office HTTP wants a sign-in');
  assert.match(signin.detail, /^Office HTTP asked for its sign-in, and Sockitt isn’t allowed to answer it yet\. Allow it under Sign-in in Office HTTP/);
  // On https the sign-in shows as a refused tunnel, which a real refusal looks
  // like too — so it is the likely cause, not a certainty.
  const tunnel = lib.explainListFailure({ kind: 'signin', tunnel: true }, office, host, true);
  assert.equal(tunnel.short, 'Office HTTP wants a sign-in');
  assert.equal(
    tunnel.detail,
    'Office HTTP wouldn’t open a connection to lists.example.org - most likely because it wants its sign-in, and Sockitt isn’t allowed to answer it yet. Allow it under Sign-in in Office HTTP, then try again.'
  );
  const bare = lib.explainListFailure({ kind: 'body' }, work, host, true);
  assert.equal(bare.detail, 'lists.example.org started sending the list through Work SOCKS5, but the transfer broke off. Try again.');
  const body =lib.explainListFailure({ kind: 'body', netError: 'net::ERR_INCOMPLETE_CHUNKED_ENCODING' }, direct, host, true);
  assert.match(body.detail, /started sending the list directly, but the transfer broke off \(ERR_INCOMPLETE_CHUNKED_ENCODING\)/);
  const other = { via: 'other' };
  const viaOther = lib.explainListFailure({ kind: 'network' }, other, host, true);
  assert.equal(viaOther.short, 'Couldn’t reach lists.example.org through another extension’s proxy settings');
  const otherDown = lib.explainListFailure({ kind: 'network', proxyError: 'net::ERR_PROXY_CONNECTION_FAILED' }, other, host, true);
  assert.equal(otherDown.short, 'Couldn’t connect to the other extension’s proxy');
});
