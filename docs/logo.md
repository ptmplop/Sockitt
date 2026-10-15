# The logo

Sockitt's mark is a sock bent into an S: the S of Sockitt, the SOCKS of the
proxies it switches. Since 1.28.0 it is the 1.x logo redrawn flat.

- **Kept:** the violet sock and its shape.
- **Dropped:** the shading, the ribbing and the speed lines.
- **New:** the old logo's darker heel and toe became a *trim colour* that
  also covers the cuff, like a sock knitted in two yarns.

The masters are SVG files in [`img/logo/`](../img/logo). Every edge of the sock is a straight line or a tangent arc.

## Versions

| Version | File | Use |
|---|---|---|
| Horizontal (primary) | `sockitt-horizontal.svg` | README, website header, store marquee |
| Stacked | `sockitt-stacked.svg` | Square spaces, the README banner |
| Symbol | `sockitt-symbol.svg` | Avatars, anywhere the name is already nearby |
| Wordmark | `sockitt-wordmark.svg` | Only where the symbol already appears nearby |
| In-app mark | `logo-mark.svg`, `logo-mark-dark.svg` | The square mark the pages draw inline |
| Toolbar tile | `sockitt-toolbar.svg` | `img/icon-16/32/48.png` |
| Store icon | `sockitt-store-icon.svg` | `img/icon-128.png`: 96 px tile + 16 px transparent padding |
| App icon | `sockitt-app-icon.svg`, `sockitt-maskable.svg` | Web, PWA and social: white sock on a violet tile |
| Favicon | `sockitt-favicon.svg` | A site favicon whose trim follows the browser's colour scheme |

Every lockup comes in these colourways:

- **Light grounds:** no suffix.
- `-dark`: dark grounds.
- `-on-violet`: on the brand violet.
- One colour: `-black`, `-white`, `-violet`, `-navy`.

## Colour: Violet + Trim

The sock is always violet. The trim (cuff, heel and toe) swaps with the background so it never sinks into it.

| Role | Light grounds | Dark grounds | On violet |
|---|---|---|---|
| Sock | **Violet** `#7543E8` | Violet | **White** `#FFFFFF` |
| Trim | **Indigo** `#2C1B6F` | **Lavender** `#B9A3E9` | Indigo |
| Wordmark | **Navy** `#0A0F39` | **Moon** `#ECEEF1` | White |

All four come from the 1.x logo:

- **Violet** is its sock, and the app's `--brand` token.
- **Indigo** is its heel and toe; the app calls it `--brand-trim`.
- **Lavender** is its highlight.
- **Navy** is its wordmark.

Moon is the app's dark-theme ink.

Contrast (WCAG; graphics need at least 3:1):

| Colour | On | Ratio |
|---|---|---|
| Violet | white | 5.6 |
| Violet | the app's dark page | 3.4 |
| Indigo | white | 14.1 |
| Lavender | the app's dark page | 8.6 |
| Indigo | the app's dark page | 1.4 |

The last row is why the trim swaps on dark grounds. The trim sits at 2.5:1 against the violet on purpose. The sock's outline carries the mark, and the trim is a second voice.

**Print.** CMYK starting points, converted naively from RGB, so proof them:

| Colour | C | M | Y | K |
|---|---|---|---|---|
| Violet | 50 | 71 | 0 | 9 |
| Indigo | 60 | 76 | 0 | 56 |
| Lavender | 21 | 30 | 0 | 9 |
| Navy | 82 | 74 | 0 | 78 |

No Pantone matches have been chosen.

## Clear space and minimum size

**Clear space:** keep one cuff height (about a quarter of the sock's height) clear on every side.

**Minimum sizes:**

| Version | Screen | Print |
|---|---|---|
| Horizontal | 96 px wide | 25 mm |
| Stacked | 72 px wide | 18 mm |
| Symbol, colour | 16 px | 5 mm |
| Symbol, one colour | 32 px | 8 mm |

Below 32 px, use `sockitt-symbol-small-*` for one colour. It drops the seams, which fill in at that size.

**One colour:** thin seams stand in for the trim colour. The `-white` files have slightly wider seams, because light on dark spreads.

## Type

The wordmark is set in Archivo, weight 650, width 108 %, tracking -10/1000. That is the setting the app uses for its brand text.

- The two t's share one crossbar, carried over from the 1.x wordmark.
- It is supplied as outlines, so don't retype it.
- Archivo is under the SIL Open Font License 1.1. It ships in `static/fonts/`.

## In the extension

- **Toolbar icon.** The toolbar shows the Sockitt icon only when no profile is active. Profiles paint their own coloured tiles with initials, and in Sockitt colour means a route. So the default icon is the sock on a **white** tile, which reads as "no route". The white tile also keeps the indigo trim visible on Chrome's dark toolbar. The tile's corner radius is 26 %, the same as the profile tiles in `background.ts`.
- **In-app mark.** The options page and popup draw the mark inline (`src/shared/mark.ts`). Its trim is `var(--brand-trim)`, so it follows the device's Theme setting rather than only the operating system's colour scheme.
- **README banner.** `img/logo-banner.png` and `img/logo-banner-dark.png`, chosen by a `<picture>` element to match the reader's GitHub theme.
- **Store promo tiles.** `img/store/promo-*.png`: a saturated violet field. The small tile has no text, as the store's guidance asks.

`npm run icons` (needs `rsvg-convert`) rebuilds the icons, banners and promo tiles from these masters. It also regenerates `src/shared/mark-paths.ts`, so the inline mark can't drift from `logo-mark.svg`.

## Don'ts

- **Colour**
  - Don't put the light colourway (indigo trim) on dark grounds; use `-dark`.
  - Don't recolour the trim outside indigo and lavender.
  - Don't make the sock any colour but violet, or white on violet.
- **Effects:** don't add shading, ribbing, speed lines, gradients, shadows or outlines.
- **Wordmark:** don't retype it, re-space it, or split the shared "tt" crossbar.
- **Shape:** don't rotate, flip, stretch or tilt the sock. It reads as an S only upright.
- **Toolbar:** don't put the mark on a coloured tile there, because coloured tiles mean profiles.
- **Lockups:** don't change the size relationship or the gap between the sock and the name.
