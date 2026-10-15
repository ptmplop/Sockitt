# Design system — Switchyard

Sockitt's two pages — the popup and the options tab — are drawn from one
stylesheet of tokens and shared components, `src/theme.css`, with a page file
each (`src/popup/popup.css`, `src/options/options.css`). This document is the
spec those files implement. Read it before changing anything visual.

Switchyard was introduced in 1.27.0. It replaced the lavender-canvas system of
1.26 and, with it, the layout: the sidebar is gone, and the routes themselves
became the interface.

## The idea: colour means route

A proxy switcher answers one question — where does this request go? — so the
interface is drawn as a rail yard. Requests enter on the left on an ink trunk,
meet junctions, and leave on coloured lines that end at their destination.

1. **Every hue on screen is a route.** A profile's colour is the line its
   traffic runs on, on every surface: the Overview's map, the editors' maps,
   the line key beside its name in every list and select, the activity log's
   mix bar, the popup's strip. The chrome is graphite and white.
2. **Status is an icon and a word**, never a hue alone: a cross and red ink
   for failing, a triangle and amber for a warning, a tick and green for clear.
3. **The brand violet belongs to the logo alone**, and so does its trim.
   Focus rings, links, the selected tab and the primary button are ink.
4. **One tinted surface per page**: the full-bleed band the Overview's map sits
   on (`--yard`). Everything else is white paper divided by hairlines.
5. **One ink action per view.** Everything else is a quiet button with an edge,
   or a text button.

## Tokens

Light values; the dark theme redefines the same names (see *Themes*).

| Token | Light | Use |
|---|---|---|
| `--paper` | `#ffffff` | the page, fields, menus |
| `--ground` | `#f4f5f7` | recessed fills: the selected list row, an opened log row, tick groups |
| `--ground-2` | `#eceef1` | inline code |
| `--yard` | `#f6f7f9` | the band behind a full map — nothing else |
| `--ink` | `#121318` | text, the primary button, toggles on, focus |
| `--ink-2` | `#454a56` | secondary copy (9.4:1 on paper) |
| `--ink-3` | `#626877` | meta and labels (5.6:1 on paper, 5.1:1 on ground) |
| `--trunk` | `#1c1e23` | the trunk: requests not yet decided |
| `--rule`, `--rule-2` | | hairlines; `-2` where one must hold against a fill |
| `--field` | | a button's edge |
| `--field-edge` | `#80868f` | a field's edge, 3.6:1 — fields are found by their edge |
| `--bad`, `--warn`, `--good` | | status as an icon |
| `--bad-ink`, `--warn-ink`, `--good-ink` | | status as text, 4.5:1 on paper and on its tint |
| `--bad-tint`/`-edge`, `--warn-tint`/`-edge` | | callout fills |
| `--brand` | `#7543e8` | the logo's sock. The mark only |
| `--brand-trim` | `#2c1b6f` | the mark's cuff, heel and toe; `#b9a3e9` on dark. The mark only |

Radii: 10px callouts, menus and the popup window; 8px the selected row and
panels; 6px buttons and fields; 4px junction squares and inline code.

## Route colours

`src/shared/colour.ts`. The palette's fills are chosen to be recognisable, not
legible — a mint or an amber line on white is under 2:1 — so every colour is
given two variants per theme, computed in OKLCH by moving lightness only
(trimming chroma where that leaves sRGB), so a deepened amber is still amber:

- **line** — strokes, keys and stop bars: at least 3:1 against paper and
  ground (WCAG 1.4.11);
- **text** — a profile named in its own colour: at least 4.5:1.

Computed, not tabulated: an imported or synced profile can carry any hex.
`paintRoute(node, fill)` puts both themes' variants on an element as custom
properties and adds `.rt`; the stylesheet picks the pair for the theme in force
into `--line` and `--rtext`, so a theme change needs no repaint. The fill
itself is used only for the profile tile (the toolbar icon in miniature) and
the colour swatches. Direct and System share one slate (`BUILTIN_FILL`);
System's line is dashed.

## Type

Two bundled faces, vendored subsets in `static/fonts/` (its README says how
they were cut, and why not npm), preloaded, `font-display: block`:

- **Archivo** (variable, width 62–125%) carries the interface. Its width axis
  is part of the scale: display and titles are set wide, labels narrow, body a
  touch over normal.
- **IBM Plex Mono** (400/500/600) for anything a person might paste: hosts,
  addresses, patterns, ports, error codes, timings.

| Role | Size / weight / width |
|---|---|
| `.t-display` — the Overview's profile name | 46px / 600 / 112% |
| `.t-title` — every page and editor opens on one | 30px / 600 / 110% |
| `.t-h3` — section titles | 16px / 650 / 104% |
| Body | 14px / 400 / 102% (13.5px in the popup) |
| `.t-label` — field labels, list group names | 12.5px / 600 / 92% |
| `.meta` | 13px, `--ink-3` |
| Floor | 12px |

Figures compared down a column or re-rendered in place use `.tnum`, on
figure-only elements: Archivo's `tnum` widens the space too.

## The track map

`src/shared/yard.ts` lays a profile out; `src/options/yardview.ts` paints it;
`src/shared/strip.ts` draws one request's route small. The grammar, shared by
every surface that draws a route:

- **Trunk**: ink, 4px, from a start bar on the left. Requests on it have not
  been decided yet — which is why it is not a colour.
- **Junctions** are rules, in first-match order, numbered: a 22px square with
  the rule's number. A rule that is off is dashed. Past six, the rest fold into
  one wide junction ("6–9"). Overrides set from the popup are a pinned
  junction ahead of rule 1. A proxy's bypass list is a diamond, its branch onto
  Direct. A rule list decides in one step: a single junction with a list glyph.
- **Branches** leave a junction at 45° (two 18px-radius turns) and merge into
  their destination's line. The earliest junction's destination sits lowest,
  so branches nest instead of crossing; where a branch must cross another line
  (interleaved rules), a paper-coloured casing is drawn under it first.
- **Lines** are 6px in the destination's line colour; the default destination
  continues the trunk. Each ends at a 4px stop bar beside its name.
- **Aliases** resolve: a rule pointing at an alias draws the alias's line,
  named for what it points at; an alias's own map is the map of its target.
- **A trace** lights one request's path (8px) and fades everything else to a
  pre-mixed tint (`color-mix` against `--under`), not opacity, so faded lines
  that overlap do not stack darker. `--under` is the surface the map sits on.

The full map (Overview, Inspector) carries each junction's kind and pattern
above it; the compact map (editors) carries numbers only, because the rules
table beside it holds the text. The strip (popup, an opened activity row) is
the map reduced to the one path taken: the junction that decided, and the
destination's line ending at its name; a failing proxy breaks the line.

## Layout

- **Top bar**: the mark (drawn inline by `src/shared/mark.ts`, so its trim
  follows the theme; see [logo.md](logo.md)), six tabs (Overview, Profiles, Activity, Inspector,
  Settings, Docs) and, on the right, the route picker — a native select with
  the active route's line key beside it. Activity carries a red count while
  requests are failing; Settings an amber count while a setting needs a
  permission.
- **Pages** open on a title and the line under it, in a 1240px column.
- **Editors and Settings** are made of sections: a title and one line on the
  left (200–250px), the controls on the right, sections divided by hairlines.
  Every editor opens on its compact map; *Name and colour* is always last.
- **The Profiles page** is a list beside the editor; the list groups by kind
  and every row leads with its line key.
- **Asks**: settings that are on but inert until the user acts are one list —
  *Needs your OK* on Settings, part of *Needs attention* on the Overview —
  never a banner repeated on every page.

## Components

- **Button** (`.btn`): 32px, paper face, `--field` edge. `.primary` is ink.
  `.quiet` has no edge. `.danger` is red ink, never a red fill.
- **Field** (`.input`): 34px, `--field-edge`; focus is a 1px ink ring inside
  the edge. Selects draw their own chevron. A select whose options are routes
  (`.via`) shows the chosen route's line key inside it.
- **Quiet field**: in the rules table, fields read as text until the row is
  pointed at or focused.
- **Toggle**: 34×20, ink when on. **Checkbox**: 16px, ink when on, inside a
  label at least 24px tall.
- **Segmented control** (`.seg`): the proxy's protocol.
- **Callout** (`.callout`): a tinted panel led by an icon; the text stays ink.
- **Line key** (`.key`): a 16×4 length of the route's line. **Tile**
  (`.avatar`): the profile's fill with its initials — only where the profile's
  name is the subject (an editor's head).
- **Focus**: a 2px ink outline held 2px off the control, everywhere.

## Themes

Light by default; dark follows the system unless the device has chosen one
(Settings › Appearance → `UiPrefs.theme`, never synced). The dark tokens are
written twice in `theme.css` — under `prefers-color-scheme: dark` guarded by
`:root:not([data-theme="light"])`, and under `:root[data-theme="dark"]` — and
the two blocks must stay identical. `src/theme-boot.js`, a classic script in
both pages' head, applies a chosen theme from a `localStorage` mirror before
the first paint, so an override never flashes the system's theme first.

## Never

- Pills or chips — a status word in a capsule, bordered tag chips.
- Dots as status, a "live" marker, or decoration.
- A hue that does not mean a route, except status icons and the logo.
- Gradients, glows, coloured shadows; elevation except for things that float
  (a menu, a toast).
- Uppercase tracked eyebrows; text under 12px.
- Animation at rest. Motion is for state changes, and stops under
  `prefers-reduced-motion`.
- Uniform grids of cards.
- An em dash (—) or en dash (–) anywhere in UI text: toolbar titles, toasts,
  docs, release notes, store captions. Use a spaced hyphen ( - ) in a
  sentence and a plain one in a range ("Press 1-6", "24-26 July"). Comments
  in code are not UI and can keep theirs.

## Verifying a change

Every defect in this system's history was found in a screenshot or a
measurement, never by reading CSS. Render the real `dist/` behind a `chrome.*`
shim (the technique `scripts/gen-store-shots.mjs` uses) and look at every page
in both themes, including the states a happy path never shows: a failing
proxy, another extension holding the proxy, an empty install, a missing
permission, a long profile list, an opened activity row, an incognito window,
a navigation still loading, an 860px window and a 640px one. Sweep text
contrast against the composited background, per-element overflow, target
sizes, the console, and a real Tab walk for visible, unclipped focus.
