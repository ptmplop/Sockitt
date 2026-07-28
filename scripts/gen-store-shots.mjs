/**
 * Regenerate the Chrome Web Store listing screenshots in img/store/.
 *
 * Same principle as gen-screenshots.mjs, and for the same reason: these were
 * hand-composited once and immediately started drifting from the product. Each
 * scene is a 1280×800 canvas — the size the store requires — holding a headline
 * and the REAL built UI in an iframe, behind the same `chrome.*` shim the README
 * shots use. Re-running after a UI change reflects it; nothing here can show a
 * layout the code no longer produces.
 *
 *   npm run store-shots
 *
 * Override the browser with CHROME=/path/to/chrome.
 *
 * The output is 1280×800 at 1x on purpose: the store rejects other sizes, so
 * this cannot be a retina capture like the README pair.
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const STAGE = resolve('.store-shots-tmp');
const OUT = resolve('img/store');

/* ---------------- the scripted config every scene renders ----------------
   Deliberately the names the published listing already uses, so a refresh
   never silently rewrites the story the store text tells. */

const P = {
  work: 'p-work',
  home: 'p-home',
  office: 'p-office',
  ads: 'p-ads',
};

const CONFIG = {
  version: 4,
  rev: 1_753_500_000_000,
  activeId: P.office,
  profiles: [
    {
      id: P.work,
      kind: 'proxy',
      name: 'Work SOCKS5',
      color: '#3b82f6',
      scheme: 'socks5',
      host: 'proxy.corp.io',
      port: 1080,
      bypass: ['<local>', '*.intranet'],
    },
    {
      id: P.home,
      kind: 'proxy',
      name: 'Home VPS',
      color: '#2dd4a7',
      scheme: 'socks5',
      host: '198.51.100.24',
      port: 1080,
      bypass: ['<local>'],
    },
    {
      id: P.office,
      kind: 'switch',
      name: 'Office routing',
      color: '#6d5dfc',
      defaultTargetId: 'direct',
      rules: [
        { id: 'r1', enabled: true, type: 'hostWildcard', pattern: '*.github.com', targetId: P.work },
        { id: 'r2', enabled: true, type: 'hostWildcard', pattern: '*.slack.com', targetId: P.work },
        { id: 'r3', enabled: true, type: 'keyword', pattern: 'internal', targetId: P.home },
        { id: 'r4', enabled: true, type: 'ipCidr', pattern: '10.0.0.0/8', targetId: P.home },
        { id: 'r5', enabled: false, type: 'time', pattern: '22:00-06:00', targetId: 'direct' },
      ],
    },
    {
      id: P.ads,
      kind: 'rulelist',
      name: 'Ad block',
      color: '#ffb020',
      format: 'autoproxy',
      url: 'https://easylist.to/easylist/easylist.txt',
      updateIntervalH: 24,
      matchTargetId: 'direct',
      defaultTargetId: 'direct',
      text: '! EasyList (subset)\n||doubleclick.net\n||googlesyndication.com\n||ads.example.com\n',
      lastUpdated: 1_753_490_000_000,
    },
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
    // Per-scene, see SCENES. The options pages want it on so "Test connection"
    // is live rather than greyed out under a "turn this on first" note; the
    // popup wants it off, because there it would fire a lookup on open.
    exitIpCheck: false,
    incognitoProfileId: '',
  },
};

/** The tab the popup believes is in front. */
const TAB = { id: 7, url: 'https://github.com/ptmplop/Sockitt', active: true };

/* ---------------- the five listing scenes ---------------- */

const POPUP_FRAME = { page: 'popup', frameW: 720, frameH: 520, left: 280, top: 205, radius: 16 };
const OPTIONS_FRAME = {
  page: 'options',
  frameW: 1200,
  frameH: 670,
  left: 40,
  top: 130,
  radius: 14,
  bleed: true,
  settings: { exitIpCheck: true },
};

const SCENES = [
  {
    ...POPUP_FRAME,
    file: 'screenshot-1-popup.png',
    title: 'Switch proxies in one click',
    subtitle:
      'Route your whole browser through SOCKS5, SOCKS4, HTTP or HTTPS — and manage exactly where the current tab goes.',
  },
  {
    ...OPTIONS_FRAME,
    file: 'screenshot-2-rules.png',
    clickNav: 'Office routing',
    title: 'Route every site automatically',
    subtitle:
      'An ordered, first-match-wins rule table — host, regex, keyword, CIDR, weekday, time of day — compiled to a fast PAC script.',
  },
  {
    ...OPTIONS_FRAME,
    file: 'screenshot-3-proxy.png',
    clickNav: 'Work SOCKS5',
    title: 'Any proxy, your way',
    subtitle: 'SOCKS5 · SOCKS4 · HTTP · HTTPS, with optional HTTP(S) authentication and a per-profile bypass list.',
  },
  {
    ...OPTIONS_FRAME,
    file: 'screenshot-4-lists.png',
    clickNav: 'Ad block',
    title: 'Subscribe to rule lists',
    subtitle: 'AutoProxy / GFWList or plain domain lists, auto-updated on a schedule — even very large lists stay fast.',
  },
  {
    ...OPTIONS_FRAME,
    file: 'screenshot-5-inspect.png',
    clickNav: 'Route inspector',
    inspect: 'https://api.github.com/repos',
    title: 'See exactly where a URL routes',
    subtitle:
      'Trace any URL through your configuration with the real resolver — which rule fired, the chain it walked, where it landed.',
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
    permissions: { contains: async () => true, request: async () => true, onAdded: evt(), onRemoved: evt() },
    runtime: {
      lastError: undefined,
      connect: () => ({ name: 'mock', postMessage: noop, disconnect: noop, onDisconnect: evt(), onMessage: evt() }),
      openOptionsPage: noop,
      getURL: (p) => p,
      getManifest: () => ({ version: S.version }),
    },
    extension: { isAllowedIncognitoAccess: async () => true },
    action: { setBadgeText: noop, setTitle: noop, setIcon: noop },
    alarms: { create: noop, clear: noop, onAlarm: evt() },
  };

  // No scene enables the exit-IP readout, so nothing here should reach the
  // network. Fail loudly rather than let a listing shot depend on the internet.
  globalThis.fetch = async (input) => {
    throw new Error('unexpected network call in a listing shot: ' + input);
  };

  addEventListener('load', () => {
    // Options boots on the first profile, so a scene naming another page clicks
    // its sidebar entry the way a user would rather than reaching into private
    // state. Matched on the .name span — the tile carries the initials as text.
    setTimeout(() => {
      if (S.clickNav) {
        const hit = [...document.querySelectorAll('.nav-item')].find(
          (n) => (n.querySelector('.name')?.textContent || n.textContent).trim() === S.clickNav
        );
        if (!hit) throw new Error('no sidebar entry named ' + S.clickNav);
        hit.click();
      }
      if (S.inspect) {
        const field = document.querySelector('.inspect-form .input.mono');
        if (!field) throw new Error('route inspector field not found');
        field.value = S.inspect;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.activeElement?.blur?.();
    }, 200);
  });
})();`;
}

/* ---------------- the 1280×800 canvas each scene is composed on ---------------- */

function framePage(scene) {
  // Only the top corners are rounded on a frame that bleeds off the bottom —
  // rounding all four would imply the window ends there.
  const radius = scene.bleed
    ? `${scene.radius}px ${scene.radius}px 0 0`
    : `${scene.radius}px`;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="theme.css">
<style>
  html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; }
  body {
    /* The options page's own brand wash, so the listing frame and the product
       inside it are lit the same way. */
    background:
      radial-gradient(60% 45% at 82% -8%, color-mix(in srgb, var(--accent-2) 16%, transparent), transparent 70%),
      radial-gradient(55% 45% at 8% -6%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 70%),
      var(--bg);
  }
  .head { position: absolute; left: 48px; top: 26px; right: 48px; }
  .wordmark { display: flex; align-items: center; gap: 9px; }
  .wordmark img { width: 18px; height: 18px; border-radius: 26%; }
  .wordmark span {
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--accent-ink);
  }
  h1 {
    margin: 12px 0 0;
    font-size: 30px;
    font-weight: 800;
    letter-spacing: -0.022em;
    line-height: 1.1;
    color: var(--text);
  }
  p { margin: 9px 0 0; font-size: 15px; line-height: 1.4; color: var(--text-dim); max-width: 1000px; }
  .frame {
    position: absolute;
    left: ${scene.left}px;
    top: ${scene.top}px;
    width: ${scene.frameW}px;
    height: ${scene.frameH}px;
    border-radius: ${radius};
    overflow: hidden;
    box-shadow:
      0 2px 4px rgba(28, 39, 84, 0.06),
      0 12px 28px -8px rgba(28, 39, 84, 0.12),
      0 40px 80px -24px rgba(28, 39, 84, 0.28);
  }
  .frame iframe { width: ${scene.frameW}px; height: ${scene.frameH}px; border: 0; display: block; }
</style>
</head>
<body>
  <div class="head">
    <div class="wordmark"><img src="logo-mark.png" alt=""><span>Sockitt</span></div>
    <h1>${scene.title}</h1>
    <p>${scene.subtitle}</p>
  </div>
  <div class="frame"><iframe src="shot-${scene.page}.html" scrolling="no"></iframe></div>
</body>
</html>`;
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

async function capture(url, out) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--window-size=1280,800',
    '--virtual-time-budget=1200',
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
  const { version } = JSON.parse(await readFile(resolve('package.json'), 'utf8'));

  await rm(STAGE, { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });
  await mkdir(OUT, { recursive: true });
  await cp(resolve('dist'), STAGE, { recursive: true });
  await cp(resolve('img/logo-mark.png'), resolve(STAGE, 'logo-mark.png'));
  await writeFile(resolve(STAGE, 'mock.js'), mockSource());

  // The UI pages get the shim injected ahead of their bundle, once each.
  for (const page of ['popup', 'options']) {
    const html = await readFile(resolve(STAGE, `${page}.html`), 'utf8');
    const shot = html.replace(
      /<script type="module"/,
      '<script src="scene.js"></script>\n  <script src="mock.js"></script>\n  <script type="module"'
    );
    if (shot === html) throw new Error(`could not inject the shim into ${page}.html`);
    await writeFile(resolve(STAGE, `shot-${page}.html`), shot);
  }

  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const scene of SCENES) {
      await writeFile(
        resolve(STAGE, 'scene.js'),
        `globalThis.__SOCKITT_SCENE__ = ${JSON.stringify(
          {
            config: { ...CONFIG, settings: { ...CONFIG.settings, ...(scene.settings ?? {}) } },
            tab: TAB,
            version,
            clickNav: scene.clickNav ?? null,
            inspect: scene.inspect ?? null,
          },
          null,
          2
        )};`
      );
      await writeFile(resolve(STAGE, 'frame.html'), framePage(scene));
      const out = resolve(OUT, scene.file);
      if (!(await capture(`${base}/frame.html`, out))) {
        throw new Error('could not run Chrome to capture screenshots (set CHROME to its path)');
      }
      console.log(`store shot → img/store/${scene.file}  (1280×800)`);
    }
  } finally {
    server.close();
  }

  await rm(STAGE, { recursive: true, force: true });
}

await main();
