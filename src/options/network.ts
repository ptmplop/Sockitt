import { DIRECT, SYSTEM, Config, SwitchRule, profileById } from '../shared/types';
import { pacRequestUrl, resolveRoute } from '../shared/match';
import { el, toast } from '../shared/ui';
import { loadTempRules } from '../shared/state';

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

/** webRequest sees nothing without host access, and it is optional here. */
const MONITOR_PERMS: chrome.permissions.Permissions = {
  permissions: ['webRequest'],
  origins: ['<all_urls>'],
};

export interface NetworkHost {
  config: () => Config;
  /** Opens a profile's editor — the profile column links to what it names. */
  open: (id: string) => void;
}

interface Row {
  id: string;
  at: number;
  method: string;
  url: string;
  host: string;
  type: string;
  /** Profile id the request resolved to, or DIRECT. '' when not resolvable. */
  targetId: string;
  /** How it was decided, for the title attribute. */
  why: string;
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

export function networkPanel(host: NetworkHost): HTMLElement {
  const rows: Row[] = [];
  const byRequestId = new Map<string, Row>();
  let recording = false;
  let granted = false;
  let paused = false;
  let filter = '';
  let failedOnly = false;
  /** Temp rules are a session override the popup writes; read once, not per request. */
  let tempRules: SwitchRule[] = [];

  const body = el('div', { class: 'net-body' });
  const countLabel = el('span', { class: 'net-count' });
  const panel = el('div', { class: 'pane net' });

  /* ---------------- routing attribution ---------------- */

  /**
   * Which profile would carry this URL, by the same resolver the Route
   * inspector uses — so the two can never disagree about the same request.
   *
   * Computed, not observed: Chrome tells an extension the request happened but
   * never which proxy carried it, so this is what the rules SAY should happen.
   * Almost always the same thing; the column header says "computed" so nobody
   * reads it as a measurement.
   */
  const resolveFor = (url: string): { targetId: string; why: string } => {
    const config = host.config();
    const activeId = config.activeId;
    if (activeId === SYSTEM) return { targetId: '', why: 'System proxy — the OS decides' };
    if (activeId === DIRECT) return { targetId: DIRECT, why: 'Direct is active' };
    const start = profileById(config, activeId);
    if (!start) return { targetId: '', why: 'no active profile' };
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { targetId: '', why: 'unparsable URL' };
    }
    const route = resolveRoute(
      config,
      start,
      pacRequestUrl(u.href),
      u.hostname,
      tempRules,
      new Date()
    );
    const why = route.bypassed
      ? `${nameFor(config, route.targetId)} — sent direct by its bypass list`
      : nameFor(config, route.targetId);
    return { targetId: route.bypassed ? DIRECT : route.targetId, why };
  };

  const nameFor = (config: Config, id: string): string =>
    id === DIRECT ? 'Direct' : (profileById(config, id)?.name ?? 'Unknown');

  /* ---------------- listeners ---------------- */

  // Declared to return undefined, not void: the listener type still carries the
  // blocking-response shape even though we never pass 'blocking'.
  const onBeforeRequest = (d: chrome.webRequest.OnBeforeRequestDetails): undefined => {
    if (paused) return;
    // Our own pages' requests are noise: opening this panel would log itself.
    if (d.url.startsWith('chrome-extension://')) return;
    let hostname = '';
    try {
      hostname = new URL(d.url).hostname;
    } catch {
      /* keep the row; a URL we cannot parse is still a request that happened */
    }
    const { targetId, why } = resolveFor(d.url);
    const row: Row = {
      id: d.requestId,
      at: Date.now(),
      method: d.method,
      url: d.url,
      host: hostname,
      type: d.type,
      targetId,
      why,
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
    tempRules = await loadTempRules(host.config().activeId).catch(() => []);
    chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, FILTER);
    chrome.webRequest.onCompleted.addListener(onCompleted, FILTER, ['responseHeaders']);
    chrome.webRequest.onErrorOccurred.addListener(onErrorOccurred, FILTER);
    recording = true;
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
    const needle = filter.trim().toLowerCase();
    return rows.filter((r) => {
      if (failedOnly && r.status !== 'error') return false;
      if (!needle) return true;
      return (
        r.url.toLowerCase().includes(needle) ||
        r.why.toLowerCase().includes(needle) ||
        r.type.includes(needle)
      );
    });
  };

  const rowNode = (r: Row): HTMLElement => {
    const config = host.config();
    const target =
      r.targetId && r.targetId !== DIRECT ? profileById(config, r.targetId) : null;
    const chip = el(
      'button',
      {
        class: `net-chip${r.targetId === DIRECT ? ' direct' : ''}${target ? '' : ' unknown'}`,
        type: 'button',
        title: r.why,
        onclick: () => {
          if (target) host.open(target.id);
        },
      },
      target ? el('i', { style: { background: target.color } }) : null,
      r.targetId === DIRECT ? 'Direct' : target ? target.name : '—'
    );
    if (!target) (chip as HTMLButtonElement).disabled = true;

    const statusText =
      r.status === 'pending'
        ? '···'
        : r.status === 'error'
          ? (r.error ?? 'failed').replace(/^net::/, '')
          : String(r.statusCode ?? '');

    return el(
      'div',
      { class: `net-row ${r.status}` },
      el('span', { class: 'net-time' }, new Date(r.at).toLocaleTimeString()),
      el('span', { class: 'net-method' }, r.method),
      el('span', { class: 'net-url', title: r.url }, r.url),
      chip,
      el('span', { class: 'net-type' }, r.type),
      el('span', { class: 'net-status', title: r.error ?? '' }, statusText),
      el(
        'span',
        { class: 'net-size', title: r.bytes === undefined ? 'No Content-Length on this response' : '' },
        r.bytes === undefined ? '—' : humanBytes(r.bytes)
      ),
      el('span', { class: 'net-ms' }, r.ms === undefined ? '' : `${r.ms} ms`)
    );
  };

  const paint = (): void => {
    const shown = visible();
    countLabel.textContent = recording
      ? `${shown.length} of ${rows.length} request${rows.length === 1 ? '' : 's'}`
      : '';

    if (!granted) {
      body.replaceChildren(permissionGate());
      return;
    }
    if (!rows.length) {
      body.replaceChildren(
        el(
          'p',
          { class: 'net-empty' },
          paused
            ? 'Paused. Nothing is being recorded.'
            : 'Recording. Reload a page, or browse — requests appear here as they are made.'
        )
      );
      return;
    }
    if (!shown.length) {
      body.replaceChildren(el('p', { class: 'net-empty' }, 'No request matches that filter.'));
      return;
    }
    // Newest first: on a busy page the interesting request is the one that just
    // happened, and a list that grows downward puts it off the bottom.
    const list = el('div', { class: 'net-list' });
    for (let i = shown.length - 1; i >= 0; i--) list.append(rowNode(shown[i]!));
    body.replaceChildren(header(), list);
  };

  const header = (): HTMLElement =>
    el(
      'div',
      { class: 'net-row net-head' },
      el('span', {}, 'Time'),
      el('span', {}, 'Method'),
      el('span', {}, 'URL'),
      el('span', { title: 'Where Sockitt’s rules send this request' }, 'Routed via'),
      el('span', {}, 'Kind'),
      el('span', {}, 'Result'),
      el('span', { title: 'Declared Content-Length. Streamed responses do not carry one.' }, 'Size'),
      el('span', {}, 'Took')
    );

  const permissionGate = (): HTMLElement =>
    el(
      'div',
      { class: 'net-gate' },
      el('p', {}, 'The monitor needs permission to observe requests before it can show any.'),
      el(
        'p',
        { class: 'note' },
        'It grants Sockitt access to read the requests your browser makes. Nothing is stored: ' +
          'the log lives in this page only, and closing it discards everything. Recording stops ' +
          'the moment you leave this page.'
      ),
      el(
        'button',
        {
          class: 'btn primary',
          onclick: async () => {
            const ok = await chrome.permissions.request(MONITOR_PERMS).catch(() => false);
            if (!ok) {
              toast('Permission declined');
              return;
            }
            granted = true;
            await start();
          },
        },
        'Turn on the monitor'
      )
    );

  /* ---------------- chrome ---------------- */

  const filterInput = el('input', {
    class: 'input mono',
    placeholder: 'Filter by URL, profile, or kind',
    spellcheck: false,
    oninput: () => {
      filter = (filterInput as HTMLInputElement).value;
      paint();
    },
  }) as HTMLInputElement;

  const pauseBtn = el(
    'button',
    {
      class: 'btn',
      onclick: () => {
        paused = !paused;
        pauseBtn.textContent = paused ? 'Resume' : 'Pause';
        paint();
      },
    },
    'Pause'
  );

  const failedBtn = el(
    'button',
    {
      class: 'btn',
      onclick: () => {
        failedOnly = !failedOnly;
        failedBtn.classList.toggle('on', failedOnly);
        paint();
      },
    },
    'Failed only'
  );

  panel.append(
    el(
      'div',
      { class: 'doc-head' },
      el('h2', { class: 'doc-title' }, 'Network monitor'),
      countLabel
    ),
    el(
      'p',
      { class: 'net-lede' },
      'Every request this browser makes while the page is open, and which profile Sockitt’s ' +
        'rules route it through. Nothing is recorded once you leave.'
    ),
    el(
      'div',
      { class: 'net-bar' },
      filterInput,
      failedBtn,
      pauseBtn,
      el(
        'button',
        {
          class: 'btn ghost',
          onclick: () => {
            rows.length = 0;
            byRequestId.clear();
            paint();
          },
        },
        'Clear'
      )
    ),
    body
  );

  // Permission state decides whether we start; both are async, so the panel
  // paints its gate first and swaps itself out when the answer lands.
  void (async () => {
    granted = await chrome.permissions.contains(MONITOR_PERMS).catch(() => false);
    if (granted) await start();
    else paint();
    observer.observe(document.body, { childList: true, subtree: true });
  })();

  paint();
  return panel;
}
