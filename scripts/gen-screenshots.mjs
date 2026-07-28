/**
 * Regenerate the README screenshots in img/screenshots/.
 *
 * The screenshots are of the REAL built UI, not a mock-up: each scene loads
 * dist/popup.html or dist/options.html in headless Chrome behind a small
 * `chrome.*` shim that serves a scripted config out of memory. So a screenshot
 * can never show a layout the code no longer produces — if the UI changes,
 * re-running this reflects it, which is the whole point of generating them
 * rather than taking them by hand.
 *
 *   npm run shots
 *
 * Override the browser with CHROME=/path/to/chrome.
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const STAGE = resolve('.shots-tmp');
const OUT = resolve('img/screenshots');
/** Retina capture: the README renders these at half width, so they stay sharp. */
const SCALE = 2;

/* ---------------- the scripted config every scene renders ---------------- */

const P = {
  switch: 'p-switch',
  bangkok: 'p-bangkok',
  frankfurt: 'p-frankfurt',
  office: 'p-office',
  gfw: 'p-gfw',
  alias: 'p-alias',
};

const CONFIG = {
  version: 4,
  rev: 1_753_500_000_000,
  activeId: P.switch,
  profiles: [
    {
      id: P.switch,
      kind: 'switch',
      name: 'Auto routing',
      color: '#6d5dfc',
      defaultTargetId: 'direct',
      rules: [
        { id: 'r1', enabled: true, type: 'hostWildcard', pattern: '*.corp.example', targetId: P.office },
        { id: 'r2', enabled: true, type: 'hostWildcard', pattern: '*.wikipedia.org', targetId: P.bangkok },
        { id: 'r3', enabled: true, type: 'ipCidr', pattern: '10.0.0.0/8', targetId: P.office },
        { id: 'r4', enabled: true, type: 'urlRegex', pattern: '^https?://(www\\.)?example\\.com/', targetId: P.frankfurt },
        { id: 'r5', enabled: true, type: 'keyword', pattern: 'tracker', targetId: 'direct' },
        { id: 'r6', enabled: false, type: 'time', pattern: '22:00-06:00', targetId: P.alias },
      ],
    },
    {
      id: P.bangkok,
      kind: 'proxy',
      name: 'Bangkok',
      color: '#2dd4a7',
      scheme: 'socks5',
      host: '27.145.178.97',
      port: 1080,
      bypass: ['<local>'],
    },
    {
      id: P.frankfurt,
      kind: 'proxy',
      name: 'Frankfurt',
      color: '#3b82f6',
      scheme: 'socks5',
      host: '10.24.9.14',
      port: 1080,
      bypass: [],
    },
    {
      id: P.office,
      kind: 'proxy',
      name: 'Office HTTP',
      color: '#fb923c',
      scheme: 'http',
      host: 'proxy.corp.example',
      port: 3128,
      username: 'alex',
      password: '••••••••',
      bypass: ['<local>', '*.corp.example'],
    },
    {
      id: P.gfw,
      kind: 'rulelist',
      name: 'GFWList',
      color: '#f472b6',
      format: 'autoproxy',
      url: 'https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt',
      updateIntervalH: 24,
      matchTargetId: P.frankfurt,
      defaultTargetId: 'direct',
      text: '! sample\n||example.org\n||wikipedia.org\n@@||news.example.org\n',
      lastUpdated: 1_753_490_000_000,
    },
    { id: P.alias, kind: 'virtual', name: 'Fastest', color: '#46c9e5', targetId: P.bangkok },
  ],
  settings: {
    quickSwitch: false,
    quickSwitchIds: [],
    syncEnabled: false,
    startupProfileId: '',
    revertExternal: true,
    confirmDeletion: true,
    addToBottom: true,
    refreshOnSwitch: true,
    badgeResult: false,
    exitIpCheck: true,
    incognitoProfileId: '',
  },
};

/** What the stubbed ipconfig.is lookup reports, and how long it "takes". */
const EXIT = { ip: '27.145.178.97', country_name: 'Thailand', country_code: 'TH', delayMs: 237 };

/** The tab the popup believes is in front. */
const TAB = { id: 7, url: 'https://en.wikipedia.org/wiki/Proxy_server', active: true };

const SCENES = [
  {
    file: 'app-popup.png',
    page: 'popup',
    // Not a guess: popup.css pins the window to exactly this size (Chrome caps
    // popups at 800×600). Matching it leaves no dead margin in the capture.
    width: 720,
    height: 520,
    // popup.css rounds the body's corners over a transparent html, so capture
    // on transparency — the corners come out round instead of boxed in white.
    transparent: true,
    // The exit lookup resolves after EXIT.delayMs; capture once it has landed.
    settleMs: 900,
  },
  {
    file: 'app-options.png',
    page: 'options',
    width: 1180,
    // Tall enough to clear the Danger zone card under the rule table. The table
    // is the point of the shot, and a card sliced through its own heading reads
    // as a bug — so the frame either contains a card whole or not at all.
    height: 960,
    settleMs: 500,
  },
];

/* ---------------- the chrome.* shim injected ahead of the bundle ---------------- */

function mockSource() {
  return `(() => {
  const S = globalThis.__SOCKITT_SCENE__;
  const areas = { local: { sockitt: S.config }, session: {}, sync: {}, managed: {} };
  const listeners = [];
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const pick = (store, keys) => {
    if (keys === null || keys === undefined) return clone(store);
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const k of list) if (k in store) out[k] = clone(store[k]);
    return out;
  };
  const area = (name) => ({
    get: async (keys) => pick(areas[name], keys),
    set: async (items) => {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: clone(areas[name][k]), newValue: clone(v) };
        areas[name][k] = clone(v);
      }
      listeners.forEach((fn) => fn(changes, name));
    },
    remove: async (keys) => {
      for (const k of typeof keys === 'string' ? [keys] : keys) delete areas[name][k];
    },
    clear: async () => { areas[name] = {}; },
  });

  const noop = () => {};
  const evt = () => ({ addListener: noop, removeListener: noop, hasListener: () => false });

  globalThis.chrome = {
    storage: {
      local: area('local'),
      session: area('session'),
      sync: area('sync'),
      onChanged: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
    },
    tabs: { query: async () => (S.tab ? [S.tab] : []), reload: noop },
    permissions: {
      contains: async () => true,
      request: async () => true,
      onAdded: evt(),
      onRemoved: evt(),
    },
    runtime: {
      lastError: undefined,
      connect: () => ({ name: 'mock', postMessage: noop, disconnect: noop, onDisconnect: evt(), onMessage: evt() }),
      openOptionsPage: noop,
      getURL: (p) => p,
    },
    extension: { isAllowedIncognitoAccess: async () => true },
    action: { setBadgeText: noop, setTitle: noop, setIcon: noop },
    alarms: { create: noop, clear: noop, onAlarm: evt() },
  };

  // ipconfig.is is the only network call these pages make. Answer it locally,
  // after a plausible delay so the readout shows a real-looking latency rather
  // than "0 ms".
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('ipconfig.is')) {
      await new Promise((r) => setTimeout(r, S.exit.delayMs));
      return new Response(JSON.stringify(S.exit), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input, init);
  };

  // Stand in for the service worker's tab-exit probe. When the tab routes
  // differently from the exit-IP host — the normal case for a switch profile —
  // the popup asks the worker to probe the TAB's own route instead of doing a
  // plain lookup. With no worker here that request would hang and the readout
  // would sit on "Checking…" forever, so answer it the way the worker does.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes['sockitt-tab-exit']) return;
    const req = changes['sockitt-tab-exit'].newValue;
    if (!req) return;
    setTimeout(() => {
      void chrome.storage.session.set({
        'sockitt-tab-exit-result': {
          nonce: req.nonce,
          ok: true,
          ip: S.exit.ip,
          iso: S.exit.country_code,
          country: S.exit.country_name,
          ms: S.exit.delayMs,
        },
      });
    }, S.exit.delayMs);
  });

  // Screenshots must not show a focus ring on whatever happened to be first in
  // the tab order, and the cursor never appears in a headless capture anyway.
  addEventListener('load', () => {
    // Options boots on the first profile. A scene wanting another page (Route
    // inspector, Docs, Settings…) names its sidebar entry; click it the way a
    // user would rather than reaching into the page's private state.
    if (S.clickNav) {
      const hit = [...document.querySelectorAll('.nav-item')].find(
        (n) => n.textContent.trim() === S.clickNav
      );
      if (!hit) throw new Error('no sidebar entry named ' + S.clickNav);
      hit.click();
    }
    document.activeElement?.blur?.();
  });
})();`;
}

/* ---------------- capture ---------------- */

function chromeBin() {
  return [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'google-chrome',
    'chromium',
  ].filter(Boolean);
}

async function stageScene(scene) {
  const html = await readFile(resolve(STAGE, `${scene.page}.html`), 'utf8');
  const shot = html.replace(
    /<script type="module"/,
    '<script src="scene.js"></script>\n  <script src="mock.js"></script>\n  <script type="module"'
  );
  if (shot === html) throw new Error(`could not inject the shim into ${scene.page}.html`);
  await writeFile(resolve(STAGE, `shot-${scene.page}.html`), shot);
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

/**
 * Serve the stage over HTTP. Not a detail: the pages load their bundle with
 * `<script type="module">`, and module scripts are fetched with CORS semantics
 * that a `file://` origin can never satisfy — served from a file the page comes
 * up permanently blank.
 */
function serve() {
  const server = createServer(async (req, res) => {
    const path = join(STAGE, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

async function capture(scene, url, out) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--force-device-scale-factor=${SCALE}`,
    `--window-size=${scene.width},${scene.height}`,
    `--virtual-time-budget=${scene.settleMs}`,
    ...(scene.transparent ? ['--default-background-color=00000000'] : []),
    `--screenshot=${out}`,
    url,
  ];
  for (const bin of chromeBin()) {
    // execFile, not execFileSync: the static server above shares this event
    // loop, so a blocking child would deadlock against its own page loads.
    try {
      await run(bin, args);
      return true;
    } catch {
      /* try the next candidate */
    }
  }
  return false;
}

async function main() {
  await rm(STAGE, { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });
  await mkdir(OUT, { recursive: true });
  await cp(resolve('dist'), STAGE, { recursive: true });
  await writeFile(resolve(STAGE, 'mock.js'), mockSource());
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const scene of SCENES) {
      await writeFile(
        resolve(STAGE, 'scene.js'),
        `globalThis.__SOCKITT_SCENE__ = ${JSON.stringify(
          { config: CONFIG, tab: TAB, exit: EXIT, clickNav: scene.clickNav ?? null },
          null,
          2
        )};`
      );
      await stageScene(scene);
      const out = resolve(OUT, scene.file);
      if (!(await capture(scene, `${base}/shot-${scene.page}.html`, out))) {
        throw new Error('could not run Chrome to capture screenshots (set CHROME to its path)');
      }
      console.log(`shot → img/screenshots/${scene.file}  (${scene.width}×${scene.height} @${SCALE}x)`);
    }
  } finally {
    server.close();
  }

  await rm(STAGE, { recursive: true, force: true });
}

await main();
