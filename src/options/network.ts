import { DIRECT, SYSTEM, Config, SwitchRule, profileById } from '../shared/types';
import { TraceEdge, pacRequestUrl, resolveRoute } from '../shared/match';
import { el, icon, toast } from '../shared/ui';
import { loadTempRules } from '../shared/state';
import { BUILTIN_FILL, paintRoute } from '../shared/colour';
import { StripModel, routeStrip } from '../shared/strip';
import { colourOf, edgeRuleIndex } from '../shared/yard';
import { codeAdvice } from '../shared/errors';

/**
 * The network monitor — every request the browser makes, and where Sockitt sent
 * it.
 *
 * Recording lives HERE, in the page, not in the service worker. Three reasons,
 * in order of how much they matter:
 *
 *   - Nothing is ever stored. The log is an array in this tab; close the page
 *     and it is gone. A monitor that logged in the background would be building
 *     a browsing history on disk, which is not a thing this extension should
 *     own — it is the one feature here that could quietly become surveillance.
 *   - An MV3 service worker is killed when idle. Background listeners and their
 *     in-memory tables would evaporate mid-session and the log would silently
 *     reset. (This is a real bug in the extension this feature is modelled on.)
 *   - "Records while you are watching" is the DevTools Network model, which is
 *     the mental model people already have for a panel that looks like this.
 *
 * The cost is that you cannot see what happened before you opened it. Open it,
 * then reload the page you care about — same as DevTools.
 */

/** Rows kept. Old ones fall off the top; the newest request always survives. */
const MAX_ROWS = 500;

/**
 * webRequest sees nothing without host access, and it is optional here.
 *
 * webRequestAuthProvider rides along even though the monitor never answers an
 * auth challenge. The worker registers its onAuthRequired listener with
 * asyncBlocking in its first synchronous turn — it has to, or Chrome will not
 * wake it for a proxy 407 — and it can only test for the API being there, not
 * for the permission behind it. Granting webRequest alone therefore made that
 * registration fail on every worker start with "You do not have permission to
 * use blocking webRequest listeners".
 *
 * The two have always been requested as a pair (AUTH_PERMS); this keeps that
 * true. It costs nothing: the provider grants no access to anything, it only
 * allows a challenge to be answered, and it adds no warning to the prompt that
 * the host access has not already made.
 */
const MONITOR_PERMS: chrome.permissions.Permissions = {
  permissions: ['webRequest', 'webRequestAuthProvider'],
  origins: ['<all_urls>'],
};

export interface NetworkHost {
  config: () => Config;
  /** Opens a profile's editor — the route column links to what it names. */
  open: (id: string) => void;
  /** Opens the Inspector on a URL, traced. */
  inspect: (url: string) => void;
  /** Runs a proxy's connection test, reporting into `out`; `button` is given back when it ends. */
  test: (profileId: string, button: HTMLButtonElement, out: HTMLElement) => void;
  /** Whether recording is wanted. Outlives the panel, which is rebuilt on nav. */
  recording: () => boolean;
  setRecording: (on: boolean) => void;
  /** The Requests sub-tab carries the count. */
  setCount: (n: number) => void;
}

type How = StripModel['how'];

interface Row {
  id: string;
  at: number;
  method: string;
  url: string;
  host: string;
  type: string;
  /** Where the request ended up: a proxy profile id, DIRECT or SYSTEM. '' when not resolvable. */
  targetId: string;
  /** How the active profile decided it — the strip's first hop. */
  how: How;
  /** The route column's quiet second word: "rule 2", "default", "override", "bypass". */
  howText: string;
  /** The hops the resolver took, for the opened row's sentence. */
  edges: TraceEdge[];
  status: 'pending' | 'ok' | 'error';
  statusCode?: number;
  error?: string;
  fromCache?: boolean;
  /** Declared Content-Length, when the response carried one. */
  bytes?: number;
  ms?: number;
  ip?: string;
}

/** 1.2 kB / 340 kB / 12.4 MB — short enough for a narrow column. */
function humanBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} kB`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)} MB`;
}

function headerValue(headers: chrome.webRequest.HttpHeader[] | undefined, name: string): string {
  if (!headers) return '';
  const hit = headers.find((h) => h.name.toLowerCase() === name);
  return hit?.value ?? '';
}

/**
 * A failed request's result in two words. The code itself is in the opened
 * row and its tooltip; a column of ERR_TUNNEL_CONNECTION_FAILED is unreadable.
 */
const SHORT_ERRORS: Array<[string, string]> = [
  ['ERR_PROXY_CONNECTION_FAILED', 'Proxy refused'],
  ['ERR_TUNNEL_CONNECTION_FAILED', 'Tunnel refused'],
  ['ERR_SOCKS_CONNECTION_FAILED', 'SOCKS failed'],
  ['ERR_PROXY_AUTH', 'Proxy sign-in'],
  ['ERR_PROXY_CERTIFICATE_INVALID', 'Proxy certificate'],
  ['ERR_ABORTED', 'Cancelled'],
  ['ERR_BLOCKED_BY_CLIENT', 'Blocked'],
  ['ERR_BLOCKED_BY', 'Blocked'],
  ['ERR_NAME_NOT_RESOLVED', 'No such host'],
  ['ERR_CONNECTION_REFUSED', 'Refused'],
  ['ERR_CONNECTION_RESET', 'Reset'],
  ['ERR_CONNECTION_CLOSED', 'Closed'],
  ['ERR_CONNECTION_TIMED_OUT', 'Timed out'],
  ['ERR_TIMED_OUT', 'Timed out'],
  ['ERR_CERT_', 'Certificate'],
  ['ERR_SSL_', 'TLS failed'],
  ['ERR_INTERNET_DISCONNECTED', 'Offline'],
  ['ERR_CACHE_MISS', 'Cache miss'],
];

function shortError(error: string | undefined): string {
  const code = (error ?? 'failed').replace(/^net::/, '');
  const hit = SHORT_ERRORS.find(([needle]) => code.includes(needle));
  if (hit) return hit[1];
  const words = code.replace(/^ERR_/, '').toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Errors that say something about the proxy, as opposed to the site behind it. */
function proxyFault(error: string | undefined): boolean {
  return !!error && /PROXY|TUNNEL|SOCKS/.test(error);
}

export function networkPanel(host: NetworkHost): HTMLElement {
  const rows: Row[] = [];
  const byRequestId = new Map<string, Row>();
  let recording = false;
  let recordingSince = 0;
  let granted = false;
  let filter = '';
  let failedOnly = false;
  /** The request whose row is open, showing its track. One at a time. */
  let openId: string | null = null;
  /** Temp rules are the session overrides the popup writes; read once, not per request. */
  let tempRules: SwitchRule[] = [];

  const body = el('div', { class: 'nt-body' });
  const panel = el('div', { class: 'net' });
  const mix = el('div', { class: 'mix' });
  const since = el('span', { class: 'meta nt-since' });
  /**
   * The list's holder, built once and never replaced. The page itself scrolls
   * (the table's head sticks to the top of the window), and painting is
   * incremental so that a reader's place survives traffic: rebuilding the list
   * on each paint snapped it back to the top on every frame.
   */
  const scroller = el('div', { class: 'nt-wrap' });
  /**
   * One tbody per request: the row, and under it the opened detail. Keeping the
   * pair in one node is what lets the keyed walk below move a request without
   * leaving its detail behind.
   */
  const table = el('table', { class: 'nt' });
  scroller.append(table);
  /** Rendered requests by id, with a signature of what they were drawn from. */
  const drawn = new Map<string, { node: HTMLElement; sig: string }>();
  /** Changing the filter reorders everything; that alone justifies a full rebuild. */
  let drawnFilterKey = '';

  const nameFor = (config: Config, id: string): string =>
    id === DIRECT ? 'Direct' : id === SYSTEM ? 'System' : (profileById(config, id)?.name ?? 'Unknown');

  /* ---------------- routing attribution ---------------- */

  /**
   * Which profile would carry this URL, by the same resolver the Route
   * inspector uses — so the two can never disagree about the same request.
   *
   * Computed, not observed: Chrome tells an extension the request happened but
   * never which proxy carried it, so this is what the rules SAY should happen.
   * Almost always the same thing; the column header says so on hover.
   */
  const resolveFor = (url: string): Pick<Row, 'targetId' | 'how' | 'howText' | 'edges'> => {
    const config = host.config();
    const activeId = config.activeId;
    const all = (targetId: string, howText = ''): Pick<Row, 'targetId' | 'how' | 'howText' | 'edges'> => ({
      targetId,
      how: { kind: 'all' },
      howText,
      edges: [],
    });
    if (activeId === SYSTEM) return all(SYSTEM, 'OS decides');
    if (activeId === DIRECT) return all(DIRECT);
    const start = profileById(config, activeId);
    if (!start) return all('');
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return all('');
    }
    const edges: TraceEdge[] = [];
    const route = resolveRoute(config, start, pacRequestUrl(u.href), u.hostname, tempRules, new Date(), edges);
    if (route.bypassed) {
      return { targetId: DIRECT, how: { kind: 'bypass', viaColour: colourOf(config, route.targetId) }, howText: 'bypass', edges };
    }
    // The first decision taken, past any alias standing in front of it.
    const first = edges.find((e) => e.kind !== 'alias');
    let how: How = { kind: 'all' };
    let howText = '';
    if (first?.kind === 'temp-rule') {
      how = { kind: 'override' };
      howText = 'override';
    } else if (first?.kind === 'rule') {
      const index = edgeRuleIndex(config, first);
      how = { kind: 'rule', label: index >= 0 ? String(index + 1) : '?' };
      howText = index >= 0 ? `rule ${index + 1}` : 'rule';
    } else if (first?.kind === 'default' || first?.kind === 'list-default') {
      how = { kind: 'default' };
      howText = 'default';
    } else if (first?.kind === 'list-match') {
      how = { kind: 'list' };
      howText = 'on the list';
    }
    return { targetId: route.targetId, how, howText, edges };
  };

  /* ---------------- listeners ---------------- */

  // Declared to return undefined, not void: the listener type still carries the
  // blocking-response shape even though we never pass 'blocking'.
  const onBeforeRequest = (d: chrome.webRequest.OnBeforeRequestDetails): undefined => {
    // Our own pages' requests are noise: opening this panel would log itself.
    if (d.url.startsWith('chrome-extension://')) return;
    let hostname = '';
    try {
      hostname = new URL(d.url).hostname;
    } catch {
      /* keep the row; a URL we cannot parse is still a request that happened */
    }
    const row: Row = {
      id: d.requestId,
      at: Date.now(),
      method: d.method,
      url: d.url,
      host: hostname,
      type: d.type,
      ...resolveFor(d.url),
      status: 'pending',
    };
    byRequestId.set(d.requestId, row);
    rows.push(row);
    if (rows.length > MAX_ROWS) {
      const dropped = rows.splice(0, rows.length - MAX_ROWS);
      for (const r of dropped) byRequestId.delete(r.id);
    }
    schedulePaint();
    return undefined;
  };

  const onCompleted = (d: chrome.webRequest.OnCompletedDetails): void => {
    const row = byRequestId.get(d.requestId);
    if (!row) return;
    row.status = 'ok';
    row.statusCode = d.statusCode;
    row.fromCache = d.fromCache;
    row.ip = d.ip ?? undefined;
    row.ms = Date.now() - row.at;
    const len = headerValue(d.responseHeaders, 'content-length');
    const n = Number.parseInt(len, 10);
    if (Number.isFinite(n) && n >= 0) row.bytes = n;
    schedulePaint();
  };

  const onErrorOccurred = (d: chrome.webRequest.OnErrorOccurredDetails): void => {
    const row = byRequestId.get(d.requestId);
    if (!row) return;
    row.status = 'error';
    row.error = d.error;
    row.ms = Date.now() - row.at;
    schedulePaint();
  };

  const FILTER = { urls: ['<all_urls>'] };

  const start = async (): Promise<void> => {
    if (recording) return;
    // The options page is a regular window, so the monitor answers for the
    // regular scope — incognito's own overrides are not what these requests take.
    tempRules = await loadTempRules(host.config().activeId, 'regular').catch(() => []);
    chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, FILTER);
    chrome.webRequest.onCompleted.addListener(onCompleted, FILTER, ['responseHeaders']);
    chrome.webRequest.onErrorOccurred.addListener(onErrorOccurred, FILTER);
    recording = true;
    recordingSince = Date.now();
    paint();
  };

  const stop = (): void => {
    if (!recording) return;
    chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
    chrome.webRequest.onCompleted.removeListener(onCompleted);
    chrome.webRequest.onErrorOccurred.removeListener(onErrorOccurred);
    recording = false;
  };

  /**
   * Detach when the panel leaves the document.
   *
   * Not optional housekeeping: a listener outlives the nodes that installed it,
   * so navigating away without this would leave every visited panel recording
   * into an array nobody can see, for as long as the tab is open.
   */
  const observer = new MutationObserver(() => {
    if (!panel.isConnected) {
      stop();
      observer.disconnect();
    }
  });

  /* ---------------- painting ---------------- */

  // A busy page fires hundreds of events a second; repainting per event would
  // spend the whole frame budget rebuilding rows nobody has read yet.
  let painting = false;
  const schedulePaint = (): void => {
    if (painting) return;
    painting = true;
    requestAnimationFrame(() => {
      painting = false;
      paint();
    });
  };

  const visible = (): Row[] => {
    const config = host.config();
    const needle = filter.trim().toLowerCase();
    return rows.filter((r) => {
      if (failedOnly && r.status !== 'error') return false;
      if (!needle) return true;
      return (
        r.url.toLowerCase().includes(needle) ||
        nameFor(config, r.targetId).toLowerCase().includes(needle) ||
        r.howText.includes(needle) ||
        r.type.includes(needle) ||
        (r.status === 'error' && shortError(r.error).toLowerCase().includes(needle)) ||
        String(r.statusCode ?? '').startsWith(needle)
      );
    });
  };

  /** The route a request took: its destination's line key, its name, and how. */
  const routeCell = (r: Row): HTMLElement => {
    const config = host.config();
    if (!r.targetId) return el('span', { class: 'meta' }, '-');
    const target = r.targetId !== DIRECT && r.targetId !== SYSTEM ? profileById(config, r.targetId) : null;
    const key = paintRoute(el('span', { class: `key${r.targetId === SYSTEM ? ' system' : ''}` }), colourOf(config, r.targetId));
    const inner: Array<Node | string> = [key, el('span', { class: 'rv-n' }, nameFor(config, r.targetId))];
    if (r.howText) inner.push(el('span', { class: 'meta' }, r.howText));
    return target
      ? el('button', { class: 'rv', type: 'button', title: `Open ${target.name}`, onclick: () => host.open(target.id) }, ...inner)
      : el('span', { class: 'rv' }, ...inner);
  };

  const resultCell = (r: Row): HTMLElement => {
    if (r.status === 'pending') return el('span', { class: 'meta' }, '···');
    if (r.status === 'error') return el('span', { class: 'st bad', title: r.error ?? '' }, shortError(r.error));
    return el('span', { class: 'mono dim' }, `${r.statusCode ?? ''}${r.fromCache ? ' · cache' : ''}`);
  };

  /** The opened request: its track, what decided it, what came back, and what to do next. */
  const detail = (r: Row): HTMLElement => {
    const config = host.config();
    const destId = r.targetId || DIRECT;
    const dest = profileById(config, destId);
    const destName = nameFor(config, destId);
    const failing = r.status === 'error' && proxyFault(r.error);
    const strip = routeStrip({
      how: r.how,
      dest: { name: destName, colour: colourOf(config, destId), system: destId === SYSTEM },
      broken: failing,
      label: `${r.host || r.url} went to ${destName}${r.howText ? `, by ${r.howText}` : ''}${failing ? ', where the connection failed' : ''}.`,
    });

    const hostNode = el('b', { class: 'mono host' }, r.host || r.url);
    const endpoint = dest?.kind === 'proxy' ? el('span', { class: 'mono' }, `${dest.host}:${dest.port}`) : null;
    const first = r.edges.find((e) => e.kind !== 'alias');
    const decider = first ? profileById(config, first.from) : null;
    const story: Array<Node | string> = [hostNode];
    switch (r.how.kind) {
      case 'rule':
        story.push(
          ` matched ${r.howText}, `,
          el('span', { class: 'mono' }, first?.pattern ?? ''),
          `, in ${decider?.name ?? 'the active profile'}, and went to ${destName}`
        );
        break;
      case 'override':
        story.push(` has an override, set from the popup, that sends it to ${destName}`);
        break;
      case 'default':
        story.push(
          decider?.kind === 'rulelist'
            ? ` is not on ${decider.name}’s list, so it went to ${destName}`
            : ` matched no rule in ${decider?.name ?? 'the active profile'}, so it took the default, ${destName}`
        );
        break;
      case 'list':
        story.push(` is on ${decider?.name ?? 'the rule list'}’s list, so it went to ${destName}`);
        break;
      case 'bypass': {
        const via = [...r.edges].reverse().find((e) => e.to !== DIRECT)?.to;
        story.push(` is on ${via ? nameFor(config, via) : 'the proxy'}’s bypass list, so it went straight out, Direct`);
        break;
      }
      case 'all':
        story.push(
          destId === SYSTEM
            ? ' was handed to your operating system’s proxy settings'
            : destId === DIRECT
              ? ' went straight out: Direct is active'
              : ` went through ${destName}, which carries everything`
        );
        break;
    }
    if (endpoint && r.how.kind !== 'bypass') story.push(' at ', endpoint);
    story.push('.');

    const facts: Array<Node | string> = [];
    if (r.status === 'error') {
      facts.push('Chrome answered ', el('span', { class: 'mono' }, r.error ?? 'an error'), r.ms !== undefined ? ` after ${r.ms} ms.` : '.');
      // The advice is about proxies; on a direct request it would blame one that was never involved.
      const advice = dest?.kind === 'proxy' ? codeAdvice(r.error ?? '') : null;
      if (advice) facts.push(` ${advice}`);
    } else if (r.status === 'ok') {
      facts.push(
        `Answered ${r.statusCode ?? ''}${r.fromCache ? ' from the cache' : ''}${r.ms !== undefined ? ` in ${r.ms} ms` : ''}`,
        r.ip ? el('span', {}, ' from ', el('span', { class: 'mono' }, r.ip)) : '',
        '.'
      );
    } else {
      facts.push('Still waiting for an answer.');
    }
    facts.push(` ${r.method} · ${r.type.replace(/_/g, ' ')}${r.bytes !== undefined ? ` · ${humanBytes(r.bytes)}` : ''}`);

    const acts: HTMLElement[] = [];
    let testOut: HTMLElement | null = null;
    if (dest?.kind === 'proxy') {
      testOut = el('span', { class: 'note test-result', dataset: { profile: dest.id } });
      const testBtn = el(
        'button',
        { class: `btn${failing ? ' primary' : ''} test-btn`, type: 'button', dataset: { profile: dest.id } },
        `Test ${dest.name}`
      );
      testBtn.onclick = () => host.test(dest.id, testBtn, testOut!);
      acts.push(testBtn);
    }
    acts.push(
      el('button', { class: `btn${failing ? '' : ' primary'}`, type: 'button', onclick: () => host.inspect(r.url) }, 'Open in Inspector'),
      el(
        'button',
        {
          class: 'btn quiet',
          type: 'button',
          onclick: async () => {
            const text = [
              `${r.method} ${r.url}`,
              `Route: ${destName}${r.howText ? ` (${r.howText})` : ''}`,
              `Result: ${r.status === 'error' ? (r.error ?? 'failed') : r.status === 'ok' ? String(r.statusCode ?? '') : 'pending'}${r.ms !== undefined ? ` in ${r.ms} ms` : ''}`,
              `At: ${new Date(r.at).toISOString()}`,
            ].join('\n');
            try {
              await navigator.clipboard.writeText(text);
              toast('Copied');
            } catch {
              toast('Could not copy');
            }
          },
        },
        'Copy as text'
      )
    );

    return el(
      'div',
      { class: 'det' },
      strip,
      el('div', { class: 'det-text' }, el('p', {}, ...story), el('p', {}, ...facts), el('div', { class: 'acts' }, ...acts, testOut))
    );
  };

  const rowNode = (r: Row): HTMLElement => {
    const open = openId === r.id;
    const time = new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return el(
      'tbody',
      { class: `nt-r ${r.status}${open ? ' is-open' : ''}` },
      el(
        'tr',
        {},
        el('td', { class: 'c-time mono' }, time),
        el('td', { class: 'c-m mono' }, r.method),
        el(
          'td',
          { class: 'c-url' },
          el(
            'button',
            {
              class: 'nt-url mono',
              type: 'button',
              title: r.url,
              ariaExpanded: String(open),
              onclick: () => {
                const prev = openId;
                openId = open ? null : r.id;
                redraw(r.id, true);
                if (prev && prev !== r.id) redraw(prev, false);
              },
            },
            r.url
          )
        ),
        el('td', { class: 'c-route' }, routeCell(r)),
        el('td', { class: 'c-res' }, resultCell(r)),
        el('td', { class: 'c-took mono' }, r.ms === undefined ? '' : `${r.ms} ms`)
      ),
      open ? el('tr', { class: 'nt-detail' }, el('td', { colSpan: 6 }, detail(r))) : null
    );
  };

  /**
   * Repaint one request in place — opening or closing it, mostly. The button
   * that was pressed is replaced with its row, so focus is put back on the new
   * one, or a keyboard user would be dropped at the top of the page.
   */
  const redraw = (id: string, refocus: boolean): void => {
    const entry = drawn.get(id);
    const r = byRequestId.get(id);
    if (!entry || !r) return;
    const node = rowNode(r);
    entry.node.replaceWith(node);
    drawn.set(id, { node, sig: signature(r) });
    if (refocus) node.querySelector<HTMLElement>('.nt-url')?.focus({ preventScroll: true });
  };

  /** Of everything recorded: how much went where, as one bar and its key. */
  const paintMix = (): void => {
    if (!rows.length) {
      mix.replaceChildren();
      return;
    }
    const config = host.config();
    const counts = new Map<string, number>();
    let failed = 0;
    for (const r of rows) {
      const id = r.targetId || DIRECT;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      if (r.status === 'error') failed++;
    }
    const order = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const bar = el('div', { class: 'mix-bar', role: 'img' });
    bar.setAttribute(
      'aria-label',
      `Of ${rows.length} request${rows.length === 1 ? '' : 's'}: ${order.map(([id, n]) => `${n} ${nameFor(config, id)}`).join(', ')}`
    );
    for (const [id, n] of order) {
      const seg = paintRoute(el('i', { class: id === SYSTEM ? 'system' : '' }), id === DIRECT || id === SYSTEM ? BUILTIN_FILL : colourOf(config, id));
      seg.style.flex = String(n);
      bar.append(seg);
    }
    const key = el(
      'p',
      { class: 'mix-key' },
      ...order.map(([id, n]) =>
        el(
          'span',
          {},
          paintRoute(el('span', { class: `key${id === SYSTEM ? ' system' : ''}` }), colourOf(config, id)),
          `${nameFor(config, id)} `,
          el('span', { class: 'tnum' }, n.toLocaleString())
        )
      ),
      failed ? el('span', { class: 'st bad' }, `${failed.toLocaleString()} failed`) : null
    );
    mix.replaceChildren(bar, key);
  };

  const head = (): HTMLElement =>
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { class: 'c-time' }, 'Time'),
        el('th', { class: 'c-m' }, 'Method'),
        el('th', { class: 'c-url' }, 'URL'),
        el('th', { class: 'c-route', title: 'Where Sockitt’s rules send this request - worked out from the rules, since Chrome never says' }, 'Route'),
        el('th', { class: 'c-res' }, 'Result'),
        el('th', { class: 'c-took' }, 'Took')
      )
    );

  const paint = (): void => {
    const shown = visible();
    host.setCount(rows.length);
    recordBtn.replaceChildren(icon(recording ? 'pause' : 'record', 'sm'), recording ? 'Stop' : 'Record');
    since.textContent = recording && recordingSince
      ? `Recording since ${new Date(recordingSince).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`
      : granted
        ? 'Stopped'
        : '';
    panel.classList.toggle('stopped', granted && !recording);
    toolbar.hidden = !granted;
    paintMix();

    if (!granted) {
      body.replaceChildren(permissionGate());
      return;
    }
    if (!rows.length) {
      body.replaceChildren(
        el(
          'p',
          { class: 'nt-empty' },
          recording
            ? 'Recording. Reload a page, or browse - requests appear here as they are made.'
            : 'Stopped. Nothing is being observed: the listeners are detached, not just ignored. Press Record to start.'
        )
      );
      return;
    }
    if (!shown.length) {
      body.replaceChildren(el('p', { class: 'nt-empty' }, 'No request matches that filter.'));
      drawn.clear();
      table.replaceChildren();
      drawnFilterKey = '';
      return;
    }

    // Mount the list once. Re-mounting is what destroyed the scroll position,
    // so anything below here mutates the node in place rather than swapping it.
    if (scroller.parentNode !== body) {
      body.replaceChildren(scroller);
      // Coming back from an empty state, nothing on screen is reusable.
      drawn.clear();
      table.replaceChildren(head());
      drawnFilterKey = '';
    }

    // Newest first: on a busy page the interesting request is the one that just
    // happened, and a list that grows downward puts it off the bottom.
    const order: Row[] = [];
    for (let i = shown.length - 1; i >= 0; i--) order.push(shown[i]!);

    const filterKey = `${filter.trim().toLowerCase()}|${failedOnly}`;
    if (filterKey !== drawnFilterKey) {
      // A different set in a different order — rebuild, and let it start at the
      // top, which is where someone who has just typed a filter expects to be.
      drawn.clear();
      table.replaceChildren(
        head(),
        ...order.map((r) => {
          const node = rowNode(r);
          drawn.set(r.id, { node, sig: signature(r) });
          return node;
        })
      );
      drawnFilterKey = filterKey;
      // Let it start at the top, which is where someone who has just typed a
      // filter expects to be — but only pull the page back if it had moved on.
      if (table.getBoundingClientRect().top < 0) table.scrollIntoView({ block: 'start' });
      return;
    }

    // Rows the filter no longer admits, or that the cap dropped off the end.
    const live = new Set(order.map((r) => r.id));
    for (const [id, entry] of drawn) {
      if (live.has(id)) continue;
      entry.node.remove();
      drawn.delete(id);
    }

    // Anything already on screen whose state moved on — a pending request that
    // completed, mostly. Replaced in place so the row keeps its position.
    for (const r of order) {
      const entry = drawn.get(r.id);
      if (!entry) continue;
      const sig = signature(r);
      if (sig === entry.sig) continue;
      const node = rowNode(r);
      entry.node.replaceWith(node);
      drawn.set(r.id, { node, sig });
    }

    // Walk the wanted order against the DOM, inserting what is missing where it
    // belongs. Keyed rather than "prepend the new ones": with Failed only on, a
    // request that was pending and then failed becomes newly visible but sorts
    // into the middle, and prepending would file it above rows newer than it.
    // Whether the reader is down in the list, and how tall it was, before rows go in.
    const readingBelow = table.getBoundingClientRect().top < 0;
    const heightBefore = table.offsetHeight;
    let inserted = false;

    // The head stays first; requests follow it.
    let cursor: ChildNode | null = table.firstChild?.nextSibling ?? null;
    for (const r of order) {
      let entry = drawn.get(r.id);
      if (!entry) {
        entry = { node: rowNode(r), sig: signature(r) };
        drawn.set(r.id, entry);
        inserted = true;
      }
      if (entry.node === cursor) {
        cursor = cursor.nextSibling;
      } else {
        table.insertBefore(entry.node, cursor);
      }
    }

    // New rows go in above whatever is being read, pushing it down by exactly
    // their height. Give that height back to the page's scroll so the rows
    // under the pointer stay put — the other half of making the list readable
    // while traffic is flowing. Only when already scrolled into the list: at
    // rest above it, the newest arriving in view is the point.
    if (inserted && readingBelow) window.scrollBy(0, table.offsetHeight - heightBefore);
  };

  /** What a row was drawn from — cheaper than diffing the node it produced. */
  const signature = (r: Row): string =>
    `${r.status}|${r.statusCode ?? ''}|${r.error ?? ''}|${r.bytes ?? ''}|${r.ms ?? ''}|${r.targetId}|${openId === r.id}`;

  const permissionGate = (): HTMLElement =>
    el(
      'div',
      { class: 'callout info nt-gate' },
      el(
        'div',
        {},
        el('h3', {}, 'The monitor needs permission to observe requests'),
        el(
          'p',
          {},
          'It lets Sockitt read the requests your browser makes. Nothing is stored: the log lives in this page only, ' +
            'closing it discards everything, and recording stops the moment you leave.'
        )
      ),
      el(
        'div',
        { class: 'acts' },
        el(
          'button',
          {
            class: 'btn primary',
            type: 'button',
            onclick: async () => {
              const ok = await chrome.permissions.request(MONITOR_PERMS).catch(() => false);
              if (!ok) {
                toast('Permission declined');
                return;
              }
              granted = true;
              host.setRecording(true);
              await start();
            },
          },
          'Turn on the monitor'
        )
      )
    );

  /* ---------------- chrome ---------------- */

  const filterInput = el('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Filter by URL, profile or result',
    ariaLabel: 'Filter requests',
    spellcheck: false,
    oninput: () => {
      filter = filterInput.value;
      paint();
    },
  }) as HTMLInputElement;

  /**
   * Record / Stop — one control, and stopping really stops.
   *
   * There is no separate pause: a pause that left the listeners attached and
   * dropped what they reported would be observing your browsing to no purpose,
   * which is not a state this feature should have. Stop detaches them.
   *
   * The choice is remembered outside the panel, because the panel is thrown
   * away on every navigation — stopping the monitor and stepping over to the
   * Overview used to bring it back recording.
   */
  const recordBtn = el('button', {
    class: 'btn net-rec',
    type: 'button',
    onclick: () => {
      const next = !recording;
      host.setRecording(next);
      if (next) void start();
      else {
        stop();
        paint();
      }
    },
  });

  const failedBox = el('input', {
    class: 'check',
    type: 'checkbox',
    onchange: () => {
      failedOnly = failedBox.checked;
      paint();
    },
  }) as HTMLInputElement;

  const toolbar = el(
    'div',
    { class: 'toolbar' },
    el('div', { class: 'search nt-find' }, filterInput),
    el('label', { class: 'chk' }, failedBox, 'Failed only'),
    el('span', { class: 'grow' }),
    since,
    recordBtn,
    el(
      'button',
      {
        class: 'btn quiet',
        type: 'button',
        onclick: () => {
          rows.length = 0;
          byRequestId.clear();
          drawn.clear();
          openId = null;
          table.replaceChildren();
          drawnFilterKey = '';
          paint();
        },
      },
      'Clear'
    )
  );

  panel.append(mix, toolbar, body);

  // Permission state decides whether we start; both are async, so the panel
  // paints its gate first and swaps itself out when the answer lands.
  void (async () => {
    granted = await chrome.permissions.contains(MONITOR_PERMS).catch(() => false);
    // Only start if recording is still wanted — the remembered answer, not a
    // fresh default, or leaving the page would restart what was just stopped.
    if (granted && host.recording()) await start();
    else paint();
    observer.observe(document.body, { childList: true, subtree: true });
  })();

  paint();
  return panel;
}
