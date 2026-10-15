/**
 * Regenerate the Chrome Web Store listing screenshots in img/store/.
 *
 * Same principle as the README shots, and for the same reason: these were
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
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

/**
 * Anything the UI renders as an AGE has to be relative, or the shot rots: the
 * Overview prints "fetched 3 h ago" and draws a freshness bar from it, so a
 * fixed timestamp would read "fetched 400 d ago" in amber a year from now and
 * raise a stale-list finding nobody intended to demonstrate. Fixed values are
 * still right for `rev`, which is never shown.
 */
const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 3_600_000;

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
      // Pink, not the palette's violet: the logo is violet, and a violet
      // profile beside it would blur the one rule the listing is about —
      // every hue on screen is a route.
      color: '#f472b6',
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
      // A list that does something on the map: the company's hosts, published
      // by IT, through the office proxy — everything else straight out.
      id: P.ads,
      kind: 'rulelist',
      name: 'Company hosts',
      color: '#ffb020',
      format: 'switchy',
      url: 'https://it.example.com/proxy/company-hosts.txt',
      updateIntervalH: 24,
      matchTargetId: P.work,
      defaultTargetId: 'direct',
      text: '# Company hosts, published by IT\nexample-corp.com\n*.example-corp.net\njira.example-corp.com\ngit.example-corp.com\n',
      lastUpdated: NOW - 3 * HOUR,
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

/** The tab the popup believes is in front — a rule sends it through Work SOCKS5. */
const TAB = { id: 7, url: 'https://github.com/ptmplop/Sockitt', title: 'ptmplop/Sockitt', active: true, windowId: 1, status: 'complete' };
/** The second popup's tab: no rule matches, so it falls through to the default. */
const TAB2 = { id: 8, url: 'https://news.example.com/story/12', title: 'Story', active: true, windowId: 1, status: 'complete' };

/* ---------------- the seven listing scenes ---------------- */

/**
 * The popup is a 400×600 window, shown twice: in the light theme on a tab a
 * rule sends through a proxy, and in the dark theme on a tab that falls through
 * to the default. Each frame names its variant in the URL's hash (see the shim).
 */
const POPUP_FRAME = { page: 'popup', frameW: 400, frameH: 600, top: 176, radius: 10, frames: ['', '#dark&tab2'] };
const OPTIONS_FRAME = {
  page: 'options',
  frameW: 1200,
  frameH: 650,
  left: 40,
  top: 156,
  radius: 10,
  bleed: true,
  settings: { exitIpCheck: true },
};

/**
 * Rows for the Activity scene: rules firing, a keyword rule, the default, and
 * one failure. The failure goes last so it lands on top — newest first — where
 * its opened row fits inside the frame.
 */
const TRAFFIC = [
  { url: 'https://news.example.com/story/12', type: 'main_frame', status: 200, bytes: 48230, ms: 174 },
  { url: 'https://cdn.example.com/img/hero.webp', type: 'image', status: 200, ms: 88 },
  { url: 'https://fonts.gstatic.com/s/inter/v13.woff2', type: 'font', status: 200, bytes: 21504, ms: 33 },
  { url: 'https://app.slack.com/api/rtm.connect', type: 'xmlhttprequest', status: 200, bytes: 1820, ms: 61 },
  { url: 'https://github.githubassets.com/assets/app.js', type: 'script', status: 200, bytes: 128944, ms: 96 },
  { url: 'https://api.github.com/repos/ptmplop/Sockitt', type: 'xmlhttprequest', status: 200, bytes: 34211, ms: 142 },
  { url: 'https://wiki.internal.corp/handbook', type: 'main_frame', error: 'net::ERR_PROXY_CONNECTION_FAILED', ms: 210 },
];

/** An Overview with something true to say: a session, tabs on every line, an exit, one finding. */
const OVERVIEW = {
  config: {
    ...CONFIG,
    // One deliberate smell, so Needs attention has something to show: localhost
    // through a remote proxy is the mistake people actually make, and it
    // carries a one-click fix.
    profiles: CONFIG.profiles.map((p) => (p.id === P.home ? { ...p, bypass: [] } : p)),
  },
  settings: { exitIpCheck: true, syncEnabled: true },
  session: {
    'sockitt-history': [
      { id: 'direct', at: NOW - 130 * MINUTE },
      { id: P.office, at: NOW - 100 * MINUTE },
      { id: P.work, at: NOW - 45 * MINUTE },
      { id: P.office, at: NOW - 25 * MINUTE },
    ],
    'sockitt-applied': { activeId: P.office, at: NOW - 4 * MINUTE },
    'sockitt-control': { level: 'controlled_by_this_extension', at: NOW - 4 * MINUTE },
  },
  // Home VPS's own address, so the exit reading agrees with the profile the
  // rest of the listing shows.
  exitIp: { ip: '198.51.100.24', country_name: 'Netherlands', country_code: 'NL' },
  // A believable spread across the three routes the rule table produces:
  // github/slack → Work SOCKS5, the "internal" keyword → Home VPS, the rest direct.
  tabs: [
    ...Array.from({ length: 4 }, (_, i) => ({ id: 100 + i, url: `https://github.com/ptmplop/Sockitt/pull/${i + 1}` })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: 110 + i, url: `https://app.slack.com/client/T0/C${i}` })),
    ...Array.from({ length: 2 }, (_, i) => ({ id: 120 + i, url: `https://wiki.internal.corp/page/${i}` })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: 130 + i, url: `https://news.example.com/story/${i}` })),
  ],
};

const SCENES = [
  {
    ...POPUP_FRAME,
    file: 'screenshot-1-popup.png',
    title: 'Switch proxies in one click',
    subtitle:
      'The popup draws the route this tab takes and the rule that sends it there - change either, or switch your whole browser, in one click.',
  },
  {
    ...OPTIONS_FRAME,
    ...OVERVIEW,
    file: 'screenshot-6-overview.png',
    clickNav: 'Overview',
    title: 'Know where your traffic goes',
    subtitle:
      'Your rules drawn as a track map, in the order they are tried. Every line is a profile, in its own colour, and ends where that traffic exits.',
  },
  {
    ...OPTIONS_FRAME,
    file: 'screenshot-2-rules.png',
    clickNav: 'Office routing',
    title: 'Route every site automatically',
    subtitle:
      'First match wins: host, regex, keyword, CIDR, weekday or time of day, compiled to a fast PAC script. Each rule is a numbered junction on the map.',
  },
  {
    ...OPTIONS_FRAME,
    file: 'screenshot-3-proxy.png',
    clickNav: 'Work SOCKS5',
    title: 'Any proxy, your way',
    subtitle: 'SOCKS5, SOCKS4, HTTP or HTTPS, with HTTP(S) sign-in, a per-profile bypass list, and a one-click connection test.',
  },
  {
    ...OPTIONS_FRAME,
    file: 'screenshot-4-lists.png',
    clickNav: 'Company hosts',
    title: 'Subscribe to rule lists',
    subtitle: 'AutoProxy / GFWList or plain domain lists, updated on a schedule. Even very large lists stay fast: domains compile to one lookup.',
  },
  {
    ...OPTIONS_FRAME,
    file: 'screenshot-5-inspect.png',
    clickNav: 'Inspector',
    inspect: 'https://api.github.com/repos',
    title: 'See exactly where an address goes',
    subtitle: 'Type any URL and the map lights its path, with every step written out - which rule took it, and where it lands. Nothing is sent.',
  },
  {
    ...OPTIONS_FRAME,
    file: 'screenshot-7-monitor.png',
    clickNav: 'Activity',
    traffic: TRAFFIC,
    // The failure is the row you open this page for: opened, it shows its track and why.
    openRow: 'wiki.internal.corp',
    title: 'Watch the rules do their work',
    subtitle: 'Every request while the page is open, the line it took and why. Open one to see its track, test its proxy, or trace it.',
  },
];

/* ---------------- the chrome.* shim injected ahead of the bundle ---------------- */

function mockSource() {
  return `(() => {
  const S = globalThis.__SOCKITT_SCENE__;
  // A frame names its variant in the hash: #dark sets this page's theme (as
  // the Appearance setting would), #tab2 puts a second tab in front of it.
  const variant = new Set(location.hash.slice(1).split('&').filter(Boolean));
  const ui = variant.has('dark') ? { theme: 'dark' } : {};
  // Session storage is seeded per scene: the Overview reads its activation
  // timeline and its proxy-failure state from there, and an empty session
  // renders those sections as their own empty states.
  const areas = { local: { sockitt: S.config, 'sockitt-ui': ui }, session: S.session || {}, sync: {}, managed: {} };
  const tab = variant.has('tab2') && S.tab2 ? S.tab2 : S.tab;
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
    // The Overview's sync tile reads this. A fixed figure, so the meter is the
    // same width in every regeneration.
    getBytesInUse: async () => 12_704,
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
  const mkEvent = () => {
    const fns = [];
    return {
      addListener: (fn) => fns.push(fn),
      removeListener: (fn) => { const i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
      hasListener: (fn) => fns.includes(fn),
      _fire: (d) => fns.slice().forEach((fn) => fn(d)),
    };
  };

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
    tabs: {
      // The popup asks for the active tab; the Overview counts them all.
      query: async (q) => (q && q.active ? (tab ? [tab] : []) : S.tabs || (tab ? [tab] : [])),
      get: async () => tab,
      reload: noop,
      onUpdated: evt(),
      onActivated: evt(),
    },
    windows: { getCurrent: async () => ({ id: 1, incognito: false }), onFocusChanged: evt() },
    permissions: { contains: async () => true, request: async () => true, onAdded: evt(), onRemoved: evt() },
    runtime: {
      lastError: undefined,
      connect: () => ({ name: 'mock', postMessage: noop, disconnect: noop, onDisconnect: evt(), onMessage: evt() }),
      openOptionsPage: noop,
      getURL: (p) => p,
      getManifest: () => ({ version: S.version }),
    },
    extension: { isAllowedIncognitoAccess: async () => true },
    // getUserSettings answers "pinned", so the options page has no unpinned
    // banner to raise in a listing shot. Without it the permission refresh threw
    // before it reached the auth check the Overview's health card depends on.
    action: { setBadgeText: noop, setTitle: noop, setIcon: noop, getUserSettings: async () => ({ isOnToolbar: true }) },
    alarms: { create: noop, clear: noop, onAlarm: evt() },
    // Dispatchable, so the network-monitor scene can play traffic through the
    // real panel rather than being handed a table of rows to draw.
    webRequest: {
      onBeforeRequest: mkEvent(),
      onCompleted: mkEvent(),
      onErrorOccurred: mkEvent(),
      onAuthRequired: evt(),
    },
  };

  // A listing shot must never depend on the internet. A scene that shows the
  // exit readout declares the answer it expects; everything else still fails
  // loudly, so a new network call cannot creep in unnoticed.
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (S.exitIp && url.includes('ipconfig.is')) {
      return { ok: true, json: async () => S.exitIp };
    }
    throw new Error('unexpected network call in a listing shot: ' + url);
  };

  addEventListener('load', () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const label = (n) => (n.childNodes[0]?.textContent || '').trim();
    // Options boots on the Overview, so a scene naming another page clicks its
    // way there as a user would: a tab across the top, or a profile's row on
    // the Profiles page.
    const go = async (name) => {
      const tabNode = [...document.querySelectorAll('.tab')].find((n) => label(n) === name);
      if (tabNode) {
        tabNode.click();
        return;
      }
      [...document.querySelectorAll('.tab')].find((n) => label(n) === 'Profiles')?.click();
      await wait(60);
      const row = [...document.querySelectorAll('.plist-row')].find((n) => n.querySelector('.nm')?.textContent.trim() === name);
      if (!row) throw new Error('no tab or profile named ' + name);
      row.click();
    };
    // The monitor batches paints on requestAnimationFrame, which headless
    // virtual time does not run; a filter keystroke repaints synchronously.
    const nudge = () => document.querySelector('.nt-find .input')?.dispatchEvent(new Event('input', { bubbles: true }));
    void (async () => {
      await wait(200);
      if (S.clickNav) await go(S.clickNav);
      if (S.inspect) {
        await wait(60);
        const field = document.querySelector('.insp-url .input');
        if (!field) throw new Error('inspector field not found');
        field.value = S.inspect;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (S.testResult) {
        await wait(60);
        [...document.querySelectorAll('.test-btn')][0]?.click();
        await wait(60);
        await globalThis.chrome.storage.session.set({ 'sockitt-test-result': S.testResult });
      }
      if (S.traffic) {
        // A second turn: the monitor attaches its listeners behind a permission
        // check and a storage read, so traffic fired with the click would
        // arrive before anything is listening.
        await wait(350);
        const wr = globalThis.chrome.webRequest;
        S.traffic.forEach((t, i) => {
          const id = String(i + 1);
          wr.onBeforeRequest._fire({ requestId: id, url: t.url, method: 'GET', type: t.type, tabId: 1, frameId: 0, parentFrameId: -1, timeStamp: Date.now() });
          // Finish in a later turn, at a time of the scene's choosing: completing
          // in the tick the request started in makes every row read 0 ms.
          setTimeout(() => {
            if (t.error) {
              wr.onErrorOccurred._fire({ requestId: id, url: t.url, method: 'GET', type: t.type, tabId: 1, error: t.error, fromCache: false, timeStamp: Date.now() });
            } else if (t.status) {
              wr.onCompleted._fire({
                requestId: id, url: t.url, method: 'GET', type: t.type, tabId: 1,
                statusCode: t.status, fromCache: false, timeStamp: Date.now(),
                responseHeaders: t.bytes ? [{ name: 'Content-Length', value: String(t.bytes) }] : [],
              });
            }
            nudge();
          }, t.ms || 40);
        });
        nudge();
        if (S.openRow) {
          await wait(Math.max(...S.traffic.map((t) => t.ms || 40)) + 120);
          nudge();
          [...document.querySelectorAll('.nt-url')].find((b) => b.textContent.includes(S.openRow))?.click();
        }
      }
      await wait(60);
      document.activeElement?.blur?.();
    })();
  });
})();`;
}

/* ---------------- the 1280×800 canvas each scene is composed on ---------------- */

function framePage(scene) {
  // Only the top corners are rounded on a frame that bleeds off the bottom —
  // rounding all four would imply the window ends there.
  const radius = scene.bleed ? `${scene.radius}px ${scene.radius}px 0 0` : `${scene.radius}px`;
  const frames = scene.frames ?? [''];
  // Side by side, centred; a single options frame keeps its own left edge.
  const gap = 28;
  const total = frames.length * scene.frameW + (frames.length - 1) * gap;
  const left0 = scene.left ?? Math.round((1280 - total) / 2);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="theme.css">
<style>
  html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; }
  /* The listing sits on the map's own band tint: the product's one tinted
     surface, so the window inside reads as the white sheet it is. */
  body { background: var(--yard); }
  body::after { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 1px; background: var(--rule); }
  .head { position: absolute; left: 48px; top: 30px; right: 48px; }
  .wordmark { display: flex; align-items: center; gap: 9px; }
  .wordmark img { width: 24px; height: 24px; }
  .wordmark span { font-size: 16px; font-weight: 650; font-stretch: 108%; letter-spacing: -0.01em; color: var(--ink); }
  h1 { margin: 14px 0 0; font-size: 34px; font-weight: 600; font-stretch: 110%; letter-spacing: -0.02em; line-height: 1.08; color: var(--ink); }
  p { margin: 9px 0 0; font-size: 16px; line-height: 1.45; color: var(--ink-2); max-width: 1040px; }
  .frame {
    position: absolute;
    top: ${scene.top}px;
    width: ${scene.frameW}px;
    height: ${scene.frameH}px;
    border-radius: ${radius};
    overflow: hidden;
    background: var(--paper);
    box-shadow: 0 0 0 1px var(--rule-2), 0 1px 2px rgb(18 19 24 / 0.05), 0 24px 56px -22px rgb(18 19 24 / 0.3);
  }
  .frame iframe { width: ${scene.frameW}px; height: ${scene.frameH}px; border: 0; display: block; }
</style>
</head>
<body>
  <div class="head">
    <div class="wordmark"><img src="logo-mark.svg" alt=""><span>Sockitt</span></div>
    <h1>${scene.title}</h1>
    <p>${scene.subtitle}</p>
  </div>
  ${frames
    .map(
      (hash, i) =>
        `<div class="frame" style="left: ${left0 + i * (scene.frameW + gap)}px"><iframe src="shot-${scene.page}.html${hash}" scrolling="no"></iframe></div>`
    )
    .join('\n  ')}
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
  '.woff2': 'font/woff2',
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
    '--virtual-time-budget=2200',
    `--screenshot=${out}`,
    url,
  ];
  for (const bin of chromeBin()) {
    // The exit code alone proves nothing: Google Chrome 155 accepts
    // --screenshot under --headless=new, exits 0, and writes no file — so this
    // used to print "store shot →" seven times and leave every old image in
    // place. The old file goes first, and a capture counts only when a new one
    // is actually on disk.
    await rm(out, { force: true });
    // execFile, not execFileSync: the static server above shares this event
    // loop, so a blocking child would deadlock against its own page loads.
    try {
      await run(bin, args);
      if ((await stat(out).catch(() => null))?.size) return true;
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
  await cp(resolve('img/logo/logo-mark.svg'), resolve(STAGE, 'logo-mark.svg'));
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
            // A scene may swap the whole configuration; `settings` still layers
            // on top either way, so the frame defaults keep applying.
            config: (() => {
              const base = scene.config ?? CONFIG;
              return { ...base, settings: { ...base.settings, ...(scene.settings ?? {}) } };
            })(),
            tab: TAB,
            tab2: TAB2,
            tabs: scene.tabs ?? null,
            session: scene.session ?? {},
            exitIp: scene.exitIp ?? null,
            version,
            clickNav: scene.clickNav ?? null,
            inspect: scene.inspect ?? null,
            traffic: scene.traffic ?? null,
            openRow: scene.openRow ?? null,
            testResult: scene.testResult ?? null,
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
