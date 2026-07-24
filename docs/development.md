# Development guide

## Prerequisites

- Node.js 20+ (developed on 26)
- `librsvg` (`brew install librsvg`) — only if you regenerate icons
- A Chromium browser for manual testing

## Setup & commands

```sh
npm install

npm run typecheck   # strict tsc, no emit — esbuild does the emitting
npm test            # node --test: executes generated PAC in a node:vm sandbox
npm run build       # minified production build → dist/
npm run watch       # rebuild on change, inline sourcemaps (html/css copied once)
npm run zip         # builds then packs dist/ → sockitt.zip
npm run icons       # regen img/ assets from img/logo-source.png (needs ImageMagick)
```

Load `dist/` via `chrome://extensions` → Developer mode → Load unpacked.
After `npm run watch` rebuilds, click the reload arrow on the extension card;
the popup/options pages pick up changes on reopen.

## Project layout

```
static/manifest.json     MV3 manifest (copied verbatim into dist/)
src/
  shared/types.ts        data model + small helpers
  shared/match.ts        condition compiler / evaluator (browser + node)
  shared/pac.ts          PAC script generator (pure, node-testable)
  shared/state.ts        chrome.storage load/save/sanitise
  shared/ui.ts           el() DOM helper + toast
  background.ts          service worker: the only chrome.proxy caller
  popup/                 popup.html/.ts/.css
  options/               options.html/.ts/.css
  theme.css              design tokens shared by both pages
scripts/gen-icons.mjs    SVG → PNG rasteriser
build.mjs                esbuild driver + static copier
test/pac.test.mjs        PAC + parity + matcher tests
```

## Testing philosophy

The logic that decides where a request goes lives in `shared/` and is pure —
no `chrome.*` calls — so it runs under plain Node. The test suite:

1. bundles `shared/` with esbuild on the fly,
2. generates real PAC scripts from fixture configs,
3. executes them in a `node:vm` context exactly as a browser resolver would,
4. asserts routing results **and** parity with the TS-side `resolveRoute()`
   (which powers the popup preview),
5. checks compiler invariants (e.g. no `new RegExp` in the hot path).

UI code is deliberately thin enough to verify by hand.

## Conventions

- Storage writes are the only way UI affects behaviour; never call
  `chrome.proxy` outside `background.ts`.
- `sanitizeConfig()` must accept arbitrary JSON without throwing — it guards
  both storage reads and user imports. Extend it whenever the schema grows.
- Generated PAC must stay ES5-flavoured (`var`, no arrows/templates) for the
  resolver sandbox, and must never call `dnsResolve`.
- Keep bundles lean: no runtime dependencies. `devDependencies` only.

## Release

1. Bump `version` in `static/manifest.json` and `package.json` (the Web Store
   requires a strictly increasing manifest version on every upload).
2. Commit, then tag: `git tag v1.x.y && git push --tags`.
3. CI builds, tests, and attaches `sockitt.zip` to a GitHub release — that zip
   has `manifest.json` at its root, exactly the layout the Chrome Web Store
   dashboard expects, so the same artifact is used for both direct installs
   and store submission.
