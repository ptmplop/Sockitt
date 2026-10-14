/**
 * Why a rule list could not be fetched, in words a person can act on.
 *
 * fetch() reports every network failure the same way — TypeError "Failed to
 * fetch" — whether the name did not resolve, the proxy was down, a tunnel was
 * refused, or the server answered without letting extensions read it. So the
 * options page gathers what else it can see while the fetch runs (the HTTP
 * status, chrome.proxy.onProxyError, a no-cors probe and a prefetch on routes
 * where those cannot raise a sign-in prompt, and the exact net:: code when the
 * optional webRequest grant happens to be in place), and this turns that
 * evidence into a sentence that names the route it failed on. What each signal
 * can and cannot tell apart was measured in real Chromium (2026-10-14).
 *
 * Pure, so the wording is tested without a browser.
 */

export type ListFetchFailure =
  /** The URL is not one Sockitt will fetch; `reason` already says why. */
  | { kind: 'invalid'; reason: string }
  /** The server (or a proxy in front of it) answered with a non-2xx status. */
  | { kind: 'status'; status: number; statusText?: string }
  | { kind: 'empty' }
  | { kind: 'too-large'; maxBytes: number }
  /** The server started sending, and the transfer broke off. */
  | { kind: 'body'; netError?: string }
  /**
   * Nothing came back in time. `connect` is Chrome giving up on its own: it
   * stops trying to connect after 30 seconds, but waits on an open connection
   * forever, so that case is the page's own limit.
   */
  | { kind: 'timeout'; seconds: number; connect?: boolean }
  /**
   * The route's proxy has a sign-in that Sockitt is not allowed to answer.
   * `tunnel`: the proxy refused to open the connection, which is how that
   * sign-in shows on an https address — and how a real refusal shows too.
   */
  | { kind: 'signin'; tunnel?: boolean }
  /**
   * The request failed below HTTP, or its reply could not be read.
   * - `proxyError`: a code chrome.proxy reported at the moment this fetch
   *   failed. It only ever reports a proxy that could not be reached or refused
   *   a tunnel, and for all traffic at once, so the page only passes it for a
   *   proxied route and only when nothing contradicts it.
   * - `netError`: the exact code, when the optional webRequest grant is there.
   * - `answered`: a no-cors probe got an HTTP response — something answered,
   *   but the browser would not hand the reply to Sockitt.
   * - `listOk`: what a prefetch of the same URL made of that response: true
   *   for a 2xx (the list is there, just not readable by an extension), false
   *   for an error status, undefined when it could not tell or was not run.
   */
  | { kind: 'network'; proxyError?: string; netError?: string; answered?: boolean; listOk?: boolean };

/** The route the fetch took, already named for display. */
export interface RouteName {
  /**
   * 'direct', 'system' (the OS proxy settings), 'proxy' (a Sockitt proxy
   * profile), 'other' (another extension holds the browser's proxy) or
   * 'policy' (this machine's policy fixes it).
   */
  via: 'direct' | 'system' | 'proxy' | 'other' | 'policy';
  /** The proxy profile's name, for via 'proxy'. */
  name?: string;
  /** "SOCKS5 127.0.0.1:1080", for via 'proxy'. */
  endpoint?: string;
  /** The proxy's scheme, for via 'proxy': answers differ by protocol. */
  scheme?: string;
}

export interface Explanation {
  /** One line for a toast. */
  short: string;
  /** The whole story, for the editor. */
  detail: string;
}

const STATUS_WORDS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  410: 'Gone',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

function statusLabel(status: number, statusText?: string): string {
  const words = statusText?.trim() || STATUS_WORDS[status];
  return words ? `${status} ${words}` : String(status);
}

/** "directly" / "through Work SOCKS5" — how the fetch went, inside a sentence. */
function viaWords(route: RouteName): string {
  switch (route.via) {
    case 'direct':
      return 'directly';
    case 'system':
      return 'through your system’s proxy settings';
    case 'other':
      return 'through another extension’s proxy settings';
    case 'policy':
      return 'through the proxy your system’s policy sets';
    case 'proxy':
      return `through ${route.name ?? 'the proxy'}`;
  }
}

/** The proxy, named for the start of a sentence. */
function proxyNamed(route: RouteName, withEndpoint = true): string {
  switch (route.via) {
    case 'proxy':
      return `${route.name ?? 'The proxy'}${withEndpoint && route.endpoint ? ` (${route.endpoint})` : ''}`;
    case 'system':
      return 'Your system’s proxy';
    case 'other':
      return 'The other extension’s proxy';
    case 'policy':
      return 'The policy’s proxy';
    case 'direct':
      return 'The proxy';
  }
}

/**
 * The same name in the middle of a sentence: "Your system’s proxy" becomes
 * "your system’s proxy"; a profile's own name is kept exactly as typed.
 */
function midSentence(named: string, route: RouteName): string {
  return route.via === 'proxy' && route.name ? named : named.charAt(0).toLowerCase() + named.slice(1);
}

/** An HTTP(S) proxy can answer for the server over plain http, and can ask for a sign-in. */
function speaksHttp(route: RouteName): boolean {
  if (route.via === 'proxy') return /^https?$/i.test(route.scheme ?? '');
  // The OS's, another extension's or a policy's proxy: most likely an HTTP one.
  return route.via !== 'direct';
}

/** What each code means for this one request, with a toast-sized version. */
function netWords(code: string, host: string, route: RouteName): Explanation | null {
  const c = code.replace(/^net::/, '');
  const proxy = proxyNamed(route);
  const via = viaWords(route);
  if (c === 'ERR_NAME_NOT_RESOLVED')
    return route.via === 'direct'
      ? { short: `The name ${host} doesn’t resolve`, detail: `The name ${host} doesn’t resolve — check the address for a typo.` }
      : { short: `${host} doesn’t resolve`, detail: `The name ${host} doesn’t resolve ${via} — check the address for a typo.` };
  if (c === 'ERR_INTERNET_DISCONNECTED') return { short: 'This computer is offline', detail: 'This computer is offline.' };
  if (c === 'ERR_CONNECTION_REFUSED')
    return { short: `${host} refused the connection`, detail: `${host} refused the connection ${via} — nothing is listening at that address and port.` };
  if (c === 'ERR_CONNECTION_TIMED_OUT' || c === 'ERR_TIMED_OUT')
    return { short: `${host} didn’t answer in time`, detail: `${host} didn’t answer in time ${via}.` };
  if (c === 'ERR_CONNECTION_RESET' || c === 'ERR_CONNECTION_CLOSED' || c === 'ERR_EMPTY_RESPONSE')
    return { short: `${host} dropped the connection`, detail: `${host} dropped the connection ${via} without sending the list.` };
  if (c.startsWith('ERR_CERT_'))
    return { short: `${host}’s certificate isn’t trusted`, detail: `${host}’s security certificate isn’t trusted (${c}), so the browser wouldn’t read from it.` };
  if (c.startsWith('ERR_SSL_')) return { short: `The secure connection to ${host} failed`, detail: `The secure connection to ${host} failed (${c}).` };
  if (c === 'ERR_PROXY_CONNECTION_FAILED')
    return {
      short: `Couldn’t connect to ${midSentence(proxyNamed(route, false), route)}`,
      detail: `Couldn’t connect to ${midSentence(proxy, route)}. The proxy isn’t running, or something between here and it is blocking the connection.`,
    };
  if (c === 'ERR_TUNNEL_CONNECTION_FAILED')
    return {
      short: `${proxyNamed(route, false)} wouldn’t open a connection to ${host}`,
      detail: `${proxy} wouldn’t open a connection to ${host}. It may not be able to reach that site, it may block it or its port, or it may want a sign-in.`,
    };
  if (c === 'ERR_SOCKS_CONNECTION_HOST_UNREACHABLE' || c === 'ERR_SOCKS_CONNECTION_FAILED')
    return {
      short: `${proxyNamed(route, false)} couldn’t reach ${host}`,
      detail: `${proxy} couldn’t open a connection to ${host}. From where the proxy sits, the name may not resolve, or the server refused.`,
    };
  if (c.startsWith('ERR_PROXY_AUTH'))
    return route.via === 'proxy'
      ? {
          short: `${proxyNamed(route, false)} wants a sign-in`,
          detail: `${proxy} wants a username and password — set them under Sign-in in its editor, and allow Sockitt to answer.`,
        }
      : { short: `${proxyNamed(route, false)} wants a sign-in`, detail: `${proxy} wants a username and password, which Sockitt can’t supply for it.` };
  if (c === 'ERR_PROXY_CERTIFICATE_INVALID') return { short: 'The proxy’s certificate isn’t trusted', detail: `${proxy}’s own certificate isn’t trusted.` };
  if (c === 'ERR_MANDATORY_PROXY_CONFIGURATION_FAILED' || c === 'ERR_PAC_SCRIPT_FAILED')
    return { short: 'The routing script failed', detail: 'The routing script failed, so nothing could be sent — check the active profile’s rules.' };
  if (c === 'ERR_BLOCKED_BY_CLIENT') return { short: 'Another extension blocked the request', detail: 'Another extension blocked the request.' };
  if (c === 'ERR_BLOCKED_BY_ADMINISTRATOR') return { short: 'Blocked by policy', detail: 'This machine’s policy blocks that address.' };
  if (c === 'ERR_UNSAFE_PORT') return { short: 'The browser won’t use that port', detail: `The browser refuses to connect to that port on ${host} — Chrome blocks a set of ports for safety.` };
  if (c === 'ERR_ADDRESS_UNREACHABLE') return { short: `${host} is unreachable`, detail: `${host} is unreachable ${via} — there is no network route to it.` };
  return null;
}

export function explainListFailure(f: ListFetchFailure, route: RouteName, host: string, urlIsHttps: boolean): Explanation {
  const via = viaWords(route);
  switch (f.kind) {
    case 'invalid':
      return { short: f.reason, detail: f.reason };
    case 'empty':
      return {
        short: 'The server sent an empty file',
        detail: `${host} answered, but the file it sent was empty — nothing to load. Check the address points at the list itself.`,
      };
    case 'too-large':
      return {
        short: 'The list is too large',
        detail: `The list is over ${Math.round(f.maxBytes / 1048576)} MB — more than Sockitt will parse, because every request’s route is decided against it.`,
      };
    case 'body':
      return {
        short: 'The download broke off',
        detail: `${host} started sending the list ${via}, but the transfer broke off${f.netError ? ` (${f.netError.replace(/^net::/, '')})` : ''}. Try again.`,
      };
    case 'signin': {
      const allow = `Allow it under Sign-in in ${route.name ?? 'the proxy’s editor'}, then try again.`;
      return {
        short: `${proxyNamed(route, false)} wants a sign-in`,
        detail: f.tunnel
          ? `${proxyNamed(route, false)} wouldn’t open a connection to ${host} — most likely because it wants its sign-in, and Sockitt isn’t allowed to answer it yet. ${allow}`
          : `${proxyNamed(route, false)} asked for its sign-in, and Sockitt isn’t allowed to answer it yet. ${allow}`,
      };
    }
    case 'timeout': {
      if (f.connect) {
        return {
          short: `No connection in ${f.seconds} seconds`,
          detail: `Chrome gave up connecting ${via} after ${f.seconds} seconds. ${route.via === 'direct' ? host : `${proxyNamed(route, false)} or ${host} behind it`} isn’t answering — it may be down, or a firewall may be dropping the connection.`,
        };
      }
      const signIn = speaksHttp(route) ? `, or ${midSentence(proxyNamed(route, false), route)} may be waiting for a sign-in` : '';
      return {
        short: `No answer in ${f.seconds} seconds`,
        detail:
          route.via === 'direct'
            ? `${host} accepted the connection but sent nothing back in ${f.seconds} seconds, so Sockitt stopped waiting — the server may be stuck or very slow.`
            : `Nothing came back ${via} in ${f.seconds} seconds, so Sockitt stopped waiting — the proxy or the server behind it may be stuck${signIn}.`,
      };
    }
    case 'status': {
      const label = statusLabel(f.status, f.statusText);
      // Over plain http an HTTP(S) proxy can be the one answering — with its
      // own 502 or 504 when it cannot reach the server.
      const proxyMayAnswer = speaksHttp(route) && !urlIsHttps;
      const proxy = proxyNamed(route, false);
      let why: string;
      if (f.status === 404 || f.status === 410) why = 'There’s no list at that address — check the URL.';
      else if (f.status === 401 || f.status === 403) why = 'The server refused to hand the list over.';
      else if (f.status === 407)
        why = route.via === 'proxy' ? `${proxy} wants a username and password — set them under Sign-in in its editor.` : `${proxy} wants a username and password.`;
      else if (f.status === 429) why = 'The server says too many requests — try again later.';
      else if (f.status >= 500)
        why = proxyMayAnswer
          ? `The server had a problem — or ${midSentence(proxy, route)} couldn’t reach it and answered for it.`
          : 'The server had a problem — try again later.';
      else why = 'That isn’t the list.';
      return { short: `The server answered ${label}`, detail: `${host} answered ${label} ${via}. ${why}` };
    }
    case 'network': {
      const exact = f.netError ? netWords(f.netError, host, route) : null;
      if (exact) return exact;
      if (f.netError) {
        const c = f.netError.replace(/^net::/, '');
        return { short: `The request failed (${c})`, detail: `The request ${via} failed with ${c}.` };
      }
      if (route.via !== 'direct' && f.proxyError) {
        const words = netWords(f.proxyError, host, route);
        if (words) return words;
      }
      // Over plain http an HTTP(S) proxy answers for the server when it can't
      // reach it, or wants a sign-in, so an unreadable reply may be the proxy's.
      const httpProxy = speaksHttp(route) && !urlIsHttps;
      if (f.answered && f.listOk === true && !httpProxy) {
        return {
          short: 'The server won’t let extensions read the list',
          detail: `${host} sent the list, but without an Access-Control-Allow-Origin header, so the browser won’t let Sockitt read it. Host it where that header is sent — raw.githubusercontent.com and most raw-file hosts do — or paste it in below.`,
        };
      }
      if (f.answered && f.listOk === false && !httpProxy) {
        return {
          short: 'The server answered with an error page',
          detail: `${host} answered ${via} with an error rather than the list — check the address. (It sends no Access-Control-Allow-Origin header, so the browser won’t say which error.)`,
        };
      }
      if (f.answered || httpProxy) {
        const proxy = midSentence(proxyNamed(route, false), route);
        return {
          short: 'The reply couldn’t be read',
          detail: httpProxy
            ? `${host}, or ${proxy} in front of it, answered something the browser won’t let Sockitt read. Either the server sends no Access-Control-Allow-Origin header, or ${proxy} sent its own error — it may not reach ${host}, or it may want a sign-in. Check the address, or route it another way.`
            : `${host} answered, but the browser won’t let Sockitt read the reply, because the server sends no Access-Control-Allow-Origin header. If the address is right, host the list where that header is sent — raw.githubusercontent.com does — or paste it in below.`,
        };
      }
      // Nothing answered. A dead proxy or a refused tunnel reports itself, so
      // through a proxy it was the onward leg that failed.
      const tls = urlIsHttps ? ', or the secure connection failed' : '';
      let detail: string;
      if (route.via === 'direct') {
        detail = `Couldn’t reach ${host} directly. The name may not resolve, or nothing may be answering${tls}. Check the address, or route it another way.`;
      } else if (route.via === 'proxy' && /^socks/i.test(route.scheme ?? '')) {
        detail = `Couldn’t reach ${host} through ${route.name ?? 'the proxy'}. The proxy is running, but it couldn’t connect to the server: from where it sits, the name may not resolve, or the server refused${tls}.`;
      } else if (route.via === 'proxy') {
        detail = `Couldn’t reach ${host} through ${route.name ?? 'the proxy'}. The proxy is running, but the connection to the server behind it failed${urlIsHttps ? ' — often the secure connection' : ''}.`;
      } else {
        detail = `Couldn’t reach ${host} ${via}. Check the address, or route it another way.`;
      }
      return { short: `Couldn’t reach ${host} ${via}`, detail };
    }
  }
}
