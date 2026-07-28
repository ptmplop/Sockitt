# Development guide

## Prerequisites

- Node.js 20+ (developed on 26)
- ImageMagick (`brew install imagemagick`), only if you regenerate icons
- A Chromium browser for manual testing

## Setup and commands

```sh
npm install

npm run typecheck   # strict tsc, no emit (esbuild does the emitting)
npm test            # node --test: executes generated PAC in a node:vm sandbox
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
  shared/state.ts        chrome.storage load / save / sanitise
  shared/avatar.ts       initials-avatar helpers
  shared/ui.ts           el() DOM helper and toast
  background.ts          service worker: the only chrome.proxy caller
  popup/                 popup.html / .ts / .css
  options/               options UI, settings, and docs.ts (in-app docs)
  theme.css              design tokens shared by both pages
scripts/gen-icons.mjs    logo-source.png to PNG icon set (ImageMagick)
scripts/gen-store-shots.mjs  README + Web Store screenshots, captured from the built UI
build.mjs                esbuild driver and static copier
test/pac.test.mjs        PAC, parity, and matcher tests
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
- The shim answers the popup's **tab-exit probe** the way the service worker
  would. When the current tab routes differently from `ipconfig.is` (the usual
  case under a switch profile) the popup asks the worker to probe the tab's own
  route; unanswered, the readout sits on "Checking…" until it times out.

Edit `CONFIG`/`TAB`/`EXIT` at the top of the script to change what the scenes
show. The popup scene is captured at exactly the 720×520 that `popup.css` pins,
on a transparent background so its rounded corners survive. The options page
boots on the first profile; a scene can name a sidebar entry with `clickNav`
(`'Docs'`, `'Route inspector'`, `'Settings'`) to capture that page instead.

## Testing philosophy

The logic that decides where a request goes lives in `shared/` and is pure (no
`chrome.*` calls), so it runs under plain Node. The test suite:

1. bundles `shared/` with esbuild on the fly,
2. generates real PAC scripts from fixture configs,
3. executes them in a `node:vm` context exactly as a browser resolver would,
4. asserts routing results **and** parity with the TS-side `resolveRoute()`
   (which powers the popup preview),
5. checks compiler invariants, such as no `new RegExp` in the hot path.

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
