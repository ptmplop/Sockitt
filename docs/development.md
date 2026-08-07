# Development guide

## Prerequisites

- Node.js 20+ (developed on 26)
- ImageMagick (`brew install imagemagick`), only if you regenerate icons
- A Chromium browser for manual testing

## Setup and commands

```sh
npm install

npm run typecheck   # strict tsc, no emit (esbuild does the emitting)
npm test            # node --test: every suite in test/ (see Testing philosophy)
npm run build       # minified production build to dist/
npm run watch       # rebuild on change, inline sourcemaps
npm run zip         # builds, then packs dist/ into sockitt.zip
npm run crx         # builds, then signs dist/ into sockitt.crx (see Signing below)
npm run shots       # builds, then regenerates img/store/ from the real UI
npm run icons       # regenerate img/ assets from img/logo-source.png (ImageMagick)
```

Load `dist/` via `chrome://extensions` > Developer mode > Load unpacked. After
`npm run watch` rebuilds, click the reload arrow on the extension card; the
popup and options pages pick up changes when reopened.

> The build cleans the *contents* of `dist/` in place rather than removing the
> directory, so an extension loaded unpacked from `dist/` keeps working across
> rebuilds. (Removing and recreating the folder would orphan Chrome's handle
> and cause a "file couldn't be accessed" error.)

## Project layout

```
static/manifest.json     MV3 manifest (copied into dist/)
src/
  shared/types.ts        data model and small helpers
  shared/match.ts        condition compiler / evaluator (browser + node)
  shared/pac.ts          PAC script generator (pure, node-testable)
  shared/rulelist.ts     AutoProxy/GFWList and domain-list parsing
  shared/sync.ts         chrome.storage.sync mirroring
  shared/state.ts        chrome.storage load / save / sanitise, UI prefs, the
                         activation history, and the per-scope session overrides
  shared/scope.ts        regular vs incognito: which profile a window routes by
  shared/badge.ts        per-tab route badge: what it should read, and the next
                         minute a clock rule changes the answer
  shared/tabs.ts         the page a tab is on, or the one it is trying to reach
  shared/health.ts       configuration audit behind the Overview health card
  shared/errors.ts       proxy failures: the live alert, the session log, and
                         the wording both surfaces render
  shared/exitip.ts       ipconfig.is exit-IP lookup (opt-in, off by default)
  shared/update.ts       a version Chrome has downloaded but not swapped in
  shared/avatar.ts       initials-avatar helpers
  shared/ui.ts           el() DOM helper and toast
  background.ts          service worker: the only chrome.proxy caller
  popup/                 popup.html / .ts / .css
  options/               options UI: dashboard.ts (Overview), network.ts
                         (network monitor), docs.ts (in-app docs),
                         releases.ts (release history), settings, editors
  theme.css              design tokens shared by both pages
scripts/gen-icons.mjs    logo-source.png to PNG icon set (ImageMagick)
scripts/gen-store-shots.mjs  README + Web Store screenshots, captured from the built UI
build.mjs                esbuild driver and static copier
test/pac.test.mjs        PAC, parity, matcher, sanitiser, and sync tests
test/*.test.mjs          one suite per area: badge, errors, health, history
                         (the activation timeline in state.ts), rejected (rule
                         lists), scope, tabs, update
```

## Screenshots

`npm run shots` rewrites `img/store/` by loading the **real** `dist/`
pages in headless Chrome behind a small `chrome.*` shim that serves a scripted
config from memory (`scripts/gen-store-shots.mjs`). Nothing is mocked up by
hand, so a screenshot cannot show a layout the code no longer produces — after
a UI change, re-run it and commit the result.

Two details the harness depends on:

- The stage is served over **HTTP**, not `file://`. The pages load their bundle
  with `<script type="module">`, and module scripts are fetched with CORS
  semantics a file origin can never satisfy — from a file the page renders blank.
- **No scene may touch the network.** The shim's `fetch` throws on anything it
  was not handed an answer for, so a listing shot can never quietly depend on the
  internet — and a new lookup added to the UI fails the run rather than appearing
  as an empty readout. A scene that shows the exit line declares the answer it
  expects (`exitIp`). The popup scene leaves `exitIpCheck` off, because there the
  lookup fires on open; the options scenes turn it on, so *Test connection* is
  captured as the live control it is rather than greyed out under a note.

Edit `CONFIG`, `TAB` and `SCENES` at the top of the script to change what the
shots show. A scene layers its own `settings` over the shared config, and may
also supply a whole `config`, a seeded `session`, a list of open `tabs` and the
`exitIp` it expects — which is how the Overview scene has something true to say
rather than a grid of empty states.

Every scene is composed on a 1280×800 canvas — the size the store requires, so
this is a 1x capture — with the headline above and the real UI in an `<iframe>`
below, lit by the options page's own brand wash. The rounded corners are the
frame's: it clips the iframe with `border-radius` and `overflow: hidden`, so
nothing here depends on a transparent capture. The popup scene fills a 720×520
frame, exactly what `popup.css` pins; the options scenes use a 1200×670 frame
that bleeds off the bottom edge, so only its top corners are rounded.

The options page boots on the Overview, so a scene names a sidebar entry with
`clickNav` to capture anything else — a page (`'Route inspector'`, `'Network
monitor'`, `'Docs'`) or a profile by name (`'Office routing'`). It is matched and
clicked the way a user would, rather than by reaching into private state, so a
renamed nav entry fails the run instead of silently shooting the wrong page.

The network-monitor scene is driven rather than drawn. The shim's
`chrome.webRequest` events are dispatchable, and the scene's `traffic` array
fires real `onBeforeRequest` / `onCompleted` / `onErrorOccurred` events through
the live panel, so the shot shows the panel's own rendering and its own computed
"Routed via" column. Two timings matter: the traffic goes out a turn *after* the
nav click, because the monitor attaches its listeners behind a permission check
and a storage read and anything fired in the same tick arrives before it is
listening; and each request completes on its own timer, because finishing in the
tick it started makes every row read 0 ms. That traffic is why the capture's
`--virtual-time-budget` is 2200 rather than 1200.

## Testing philosophy

Most of `shared/` is written to run outside a browser — the routing core calls
no `chrome.*` at all — so `node --test` covers it directly. Every suite bundles
the module it is testing with esbuild on the fly and imports the result, which is
why there is no build step in front of `npm test`.

`pac.test.mjs` is the routing suite and the biggest one. It:

1. generates real PAC scripts from fixture configs,
2. executes them in a `node:vm` context exactly as a browser resolver would,
3. asserts routing results **and** parity with the TS-side `resolveRoute()`
   (which powers the popup preview),
4. checks compiler invariants, such as no `new RegExp` in the hot path,
5. and covers `sanitizeConfig()` and the sync push/pull decisions besides.

The rest take one area each: `health` (the Overview's audit), `rejected` (which
rule-list lines were dropped, and why), `tabs` (the page a tab is trying to
reach), `badge` (what the per-tab badge reads, and the next minute a clock rule
changes it), `scope` (which profile an incognito window routes by, and the
override keys that keep the two scopes apart) and `update` (version comparison
for the staged-update banner).

Two suites do stub `chrome.storage.session` — `errors` and `history`, the latter
covering the Overview's activation timeline — because what they assert is
ordering under concurrent writes, and a stub with a hook that can stall a write
is the only way to interleave them on purpose.

UI code is deliberately thin enough to verify by hand.

## Conventions

- Storage writes are the only way the UI affects behaviour; never call
  `chrome.proxy` outside `background.ts`.
- `sanitizeConfig()` must accept arbitrary JSON without throwing; it guards both
  storage reads and user imports. Extend it whenever the schema grows.
- Generated PAC must stay ES5-flavoured (`var`, no arrows or template literals)
  for the resolver sandbox, and must never call `dnsResolve`.
- Keep bundles lean: no runtime dependencies, only `devDependencies`.

## Release

1. Bump `version` in `static/manifest.json` and `package.json` (the Web Store
   requires a strictly increasing manifest version on every upload).
2. Commit, then tag: `git tag v1.x.y && git push --tags`.
3. CI builds, tests, and attaches `sockitt.zip` to a GitHub release. That zip
   has `manifest.json` at its root, exactly the layout the Chrome Web Store
   dashboard expects, so the same artifact serves both direct installs and
   store submission.

## Chrome Web Store

The published item is
[Sockitt — Proxy Switcher](https://chromewebstore.google.com/detail/sockitt-%E2%80%94-proxy-switcher/ebfioiljhjgijbmnnpgadkgmokjbjkca),
item ID `ebfioiljhjgijbmnnpgadkgmokjbjkca`. That is the ID an installed copy
reports and the one to use in any store link.

> Note: it is **not** the ID derived from the local signing key below
> (`fmpcgjkpojmmaciakgknagcogmlfofkg`). A store item takes its ID from whichever
> key created it, so these differing values mean the listing was created from an
> upload that did not use that key. Confirm in the Developer Dashboard which
> upload path the item actually expects before the next release — a `.crx`
> signed with the wrong key is rejected.

## Signing (verified CRX uploads)

If the item is opted in to **verified CRX uploads**, each store upload must be a
`.crx` signed with our private key.

- The **private key lives outside the repo** at `../sockitt-signing-key.pem`
  (the `personal/` folder), is gitignored, and must be backed up securely.
  Losing it means the item can no longer be updated.
- Produce a signed package with `npm run crx`, which builds `dist/` and writes
  `sockitt.crx` signed with that key (override the path with `SOCKITT_CRX_KEY`,
  or the browser with `CHROME`). Upload `sockitt.crx` to the store.
- The matching **public key** (SubjectPublicKeyInfo PEM) is the value pasted
  into the store's verified-upload field. The extension ID derived from it is
  `fmpcgjkpojmmaciakgknagcogmlfofkg` — which is *not* the published item's ID;
  see the note above.
- The GitHub release keeps shipping the unpacked `sockitt.zip` for
  Load-unpacked installs; `sockitt.crx` is only for store uploads and is never
  committed.
