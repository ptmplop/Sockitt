# Design system

Sockitt's two pages — the popup and the options tab — are drawn from one
stylesheet of tokens and shared components, `src/theme.css`, with a page file
each (`src/popup/popup.css`, `src/options/options.css`). This document is the
spec those files implement. Read it before changing anything visual.

The system was introduced in 1.26.0, replacing the dark-sidebar, gradient-card
look the extension shipped with until then. The layout did not move: the
options tab is still a sidebar beside a content column, the popup is still a
switcher beside a "this tab" pane, and every control is where it was.

## The five things that changed

These are the differences visible in a 200px thumbnail, and the test for any
future change: if a page reads as the old one in new colours, it is not done.

1. **Frame.** The near-black sidebar and top bar are gone. The window is a
   lavender *canvas*; the sidebar sits on it with no box of its own, and the
   content is one white *sheet* with a hairline edge and 14px corners. In the
   popup the switcher is on the canvas and the right-hand pane is the sheet.
2. **Surfaces.** Panels are white with a hairline border and no drop shadow.
   Elevation is reserved for things that genuinely float (a toast). Where the
   Overview sets things side by side they share one surface divided by a
   hairline: the five figures are one strip, and each 7 + 5 pair of cards is
   one panel — never a grid of separate boxes a gutter apart.
3. **Type.** DM Sans (variable, with optical sizing) for everything, JetBrains
   Mono for addresses, hosts, patterns and timings. Titles are sentence case.
   Nothing is set in tracked uppercase, and nothing is smaller than 12px.
4. **Signature.** The Overview opens on the *route band*: the active profile at
   display size, the route it produces drawn as a line in that profile's own
   colour, and the exit address as a large mono readout — on the logo's
   lavender, the one tinted surface on the page.
5. **Colour and action.** No gradients and no glows. The palette is the logo's:
   sock violet for selection, links and focus; the sock's deep shadow for the
   one primary action a view has; the wordmark's navy for text.

## Tokens

| Token | Value | Use |
|---|---|---|
| `--canvas` | `#f3f2f8` | the window behind the sheet; the sidebar; the popup switcher |
| `--sheet` | `#ffffff` | the content sheet, panels, fields |
| `--wash` | `#f7f6fb` | quiet fills: table heads, code, row hover |
| `--lavender` | `#f2eefd` | the route band and the popup's route answer — nothing else |
| `--text` | `#16172f` | body and titles (the wordmark navy, softened) |
| `--text-dim` | `#5a5c76` | secondary copy; 6.5:1 on white, 5.8:1 on the canvas |
| `--line` | ink at 9% | hairlines: panel borders, dividers |
| `--line-strong` | ink at 15% | dividers that must hold against a fill |
| `--field-border` | ink at 22% | form control edges — a visible hairline (1.6:1), not a 3:1 boundary: fields are identified by their labels |
| `--violet` | `#7543e8` | the logo's sock: selection, links, focus, the live route |
| `--violet-ink` | `#5b2fd6` | violet as text on a violet tint |
| `--action` | `#2d1b70` | the logo's sock shadow: the primary button, the toggle "on" |
| `--danger-ink`, `--amber-ink`, `--ok-ink` | | status as text; each 4.5:1 on white and on its tint |
| `--danger`, `--amber`, `--ok` | | status as an icon, a bar or a tint — never as text |

The pre-1.26 names (`--bg`, `--bg-elev`, `--accent`, `--accent-2`,
`--accent-ink`, `--border`, `--border-strong`, `--surface`, `--surface-hover`)
are kept as aliases: `scripts/gen-store-shots.mjs` reads some of them.

Radii: 14px the sheet, 12px panels, 8px controls and rows, 6px small buttons
and code, 28% profile tiles (square boxes only).

## Type

`--font` is DM Sans, `--mono` JetBrains Mono. Both are vendored subsets of the
upstream releases in `static/fonts/` — its README says how they were cut, and
why not the npm copies — copied to `dist/fonts/` by `build.mjs` and preloaded,
with `font-display: block` so the popup never flashes the fallback face. The
mono is cut without its code ligatures, so `::` in an address or an error code
reads as typed.

| Role | Size / weight |
|---|---|
| Overview route band name | 30px / 600 — the one display size below the page title |
| Page title (`.dash-title`, `.doc-title`) | 24px / 600 — every page opens on one; an editor's names the profile |
| Overview figures (`.dash-stat-fig`) | 22px / 600 |
| Panel title (`.panel h3`) | 15px / 600, sentence case |
| Body, controls | 14px options, 13.5px popup / 400–500 |
| Labels, nav group names | 13px / 500–600, `--text-dim` |
| Meta, notes, table cells | 12.5–13px |
| Floor | 12px — no 9.5–11px caps anywhere |

Figures that are compared or re-render in place use `tabular-nums` — only on
elements holding figures alone, because DM Sans's `tnum` also widens the
space, and on a sentence it opens up every word gap.

## Components

- **Panel** (`.card.panel`): white, `--line` border, 12px radius, 20/22px
  padding; `h3` is a plain sentence-case title.
- **Button** (`.btn`): 32px; white face, `--field-border` edge. `.primary` is
  `--action` with white text — one per view. `.ghost` is text only. Focus is
  the shared `--ring`.
- **Field** (`.input`): 34px, white, `--field-border`; focus turns the edge
  violet and adds a soft violet halo. Selects draw their own chevron.
- **Toggle**: 36×20, `--action` when on.
- **Profile tile** (`.avatar`): the profile's colour, flat, initials in 650.
  It is the toolbar icon in miniature, so it is the one place colour carries
  identity. Built-in Direct / System use slate.
- **Callout** (`.warn-banner`, `.banner`): a tinted panel led by an icon, the
  message in regular weight; never a wall of bold amber.
- **Status** is an icon plus coloured text: a triangle and red ink for
  failing, a tick and green ink for clear. Never a dot, never a pill.
- **Selection**: in the sidebar and the popup switcher the selected row is a
  piece of the sheet — white, hairline-edged — lifted out of the canvas.
- **The route line** (Overview band) is drawn in the active profile's colour
  deepened toward ink (`--route-ink`), so even the palest profile's line shows
  solid from dashed; it is dashed on the link that leaves a profile deciding
  per request.
- **Repaints** keep the keyboard where it was and never replay an entrance: a
  card rebuilt under focus puts it back on the control that took its place,
  and the map and ring draw in only on first paint.

## Never

- Pills or chips: rounded-full badges, bordered tag chips, a status word in a
  capsule. Qualifiers are plain text ("Active", "· rule", "Incognito").
- Dots: no coloured dot as a status prefix, a "live" marker or decoration.
  A legend key in a chart is a square swatch, not a dot.
- Gradients on surfaces or buttons, glows, coloured shadows.
- Uppercase tracked eyebrows, gradient ticks, text under 12px.
- A coloured edge down one side of a card to mean "important" or "current".
  Emphasis is the border's tint or the words; severity is an icon.
- Animation at rest. Motion is for state changes (a toggle, a disclosure).
- A large logo inside a page. The mark lives in the sidebar and the popup
  header.

## Verifying a change

Every defect in this system's history was found in a screenshot or a
measurement, never by reading CSS. Render the real `dist/` behind a `chrome.*`
shim (the same technique as `scripts/gen-store-shots.mjs`) and look at every
page, including the states a happy path never shows: a failing proxy, an empty
install, the permission banners, a long profile list, an incognito window, a
navigation still loading, an 820px window and a short one. Sweep text contrast
against the composited background, per-element overflow, and the console.
