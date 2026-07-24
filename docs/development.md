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
  shared/rulelist.ts     AutoProxy/GFWList and Switchy list parsing
  shared/sync.ts         chrome.storage.sync mirroring
  shared/state.ts        chrome.storage load / save / sanitise
  shared/avatar.ts       initials-avatar helpers
  shared/ui.ts           el() DOM helper and toast
  background.ts          service worker: the only chrome.proxy caller
  popup/                 popup.html / .ts / .css
  options/               options UI, settings, and docs.ts (in-app docs)
  theme.css              design tokens shared by both pages
scripts/gen-icons.mjs    logo-source.png to PNG icon set (ImageMagick)
build.mjs                esbuild driver and static copier
test/pac.test.mjs        PAC, parity, and matcher tests
```

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
