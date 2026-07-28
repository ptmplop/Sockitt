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
  /** Opens a profile's editor — the profile column links to what it names. */
  open: (id: string) => void;
  /** Whether recording is wanted. Outlives the panel, which is rebuilt on nav. */
  recording: () => boolean;
  setRecording: (on: boolean) => void;
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
  let filter = '';
  let failedOnly = false;
  /** Temp rules are a session override the popup writes; read once, not per request. */
  let tempRules: SwitchRule[] = [];

  const body = el('div', { class: 'net-body' });
  const countLabel = el('span', { class: 'net-count' });
  const panel = el('div', { class: 'pane net' });
  /**
   * The scrolling element, built once and never replaced.
   *
   * This is the whole reason painting is incremental. Rebuilding the list on
   * each paint threw away the node the user had scrolled, and a removed node
   * takes its scrollTop with it — so with traffic arriving the list snapped
   * back to the top on every frame and could not be scrolled at all.
   */
  const listNode = el('div', { class: 'net-list' });
  /** Rendered rows by request id, with a signature of what they were drawn from. */
  const drawn = new Map<string, { node: HTMLElement; sig: string }>();
  /** Changing the filter reorders everything; that alone justifies a full rebuild. */
  let drawnFilterKey = '';

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
    countLabel.textContent = rows.length
      ? `${shown.length} of ${rows.length} request${rows.length === 1 ? '' : 's'}`
      : '';
    recordBtn.textContent = recording ? 'Stop' : 'Record';
    recordBtn.classList.toggle('on', recording);
    panel.classList.toggle('stopped', granted && !recording);

    if (!granted) {
      body.replaceChildren(permissionGate());
      return;
    }
    if (!rows.length) {
      body.replaceChildren(
        el(
          'p',
          { class: 'net-empty' },
          recording
            ? 'Recording. Reload a page, or browse — requests appear here as they are made.'
            : 'Stopped. Nothing is being observed: the listeners are detached, not just ignored. Press Record to start.'
        )
      );
      return;
    }
    if (!shown.length) {
      body.replaceChildren(el('p', { class: 'net-empty' }, 'No request matches that filter.'));
      drawn.clear();
      listNode.replaceChildren();
      drawnFilterKey = '';
      return;
    }

    // Mount the list once. Re-mounting is what destroyed the scroll position,
    // so anything below here mutates the node in place rather than swapping it.
    if (listNode.parentNode !== body) {
      body.replaceChildren(header(), listNode);
      // Coming back from an empty state, nothing on screen is reusable.
      drawn.clear();
      listNode.replaceChildren();
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
      listNode.replaceChildren(
        ...order.map((r) => {
          const node = rowNode(r);
          drawn.set(r.id, { node, sig: signature(r) });
          return node;
        })
      );
      drawnFilterKey = filterKey;
      listNode.scrollTop = 0;
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
    const scrollBefore = listNode.scrollTop;
    const heightBefore = listNode.scrollHeight;
    let inserted = false;

    let cursor: ChildNode | null = listNode.firstChild;
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
        listNode.insertBefore(entry.node, cursor);
      }
    }

    // New rows go in above whatever is being read, pushing it down by exactly
    // their height. Give that height back to scrollTop so the rows under the
    // pointer stay put — the other half of making the list scrollable while
    // traffic is flowing. Only when already scrolled: at rest at the top, the
    // newest arriving in view is the point.
    if (inserted && scrollBefore > 0) {
      listNode.scrollTop = scrollBefore + (listNode.scrollHeight - heightBefore);
    }
  };

  /** What a row was drawn from — cheaper than diffing the node it produced. */
  const signature = (r: Row): string =>
    `${r.status}|${r.statusCode ?? ''}|${r.error ?? ''}|${r.bytes ?? ''}|${r.ms ?? ''}|${r.targetId}`;

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
            host.setRecording(true);
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
  const recordBtn = el(
    'button',
    {
      class: 'btn net-rec',
      onclick: () => {
        const next = !recording;
        host.setRecording(next);
        if (next) void start();
        else {
          stop();
          paint();
        }
      },
    },
    'Stop'
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
      recordBtn,
      el(
        'button',
        {
          class: 'btn ghost',
          onclick: () => {
            rows.length = 0;
            byRequestId.clear();
            drawn.clear();
            listNode.replaceChildren();
            drawnFilterKey = '';
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
    // Only start if recording is still wanted — the remembered answer, not a
    // fresh default, or leaving the page would restart what was just stopped.
    if (granted && host.recording()) await start();
    else paint();
    observer.observe(document.body, { childList: true, subtree: true });
  })();

  paint();
  return panel;
}
