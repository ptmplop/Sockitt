/**
 * A profile's colour, made safe to draw with.
 *
 * Colour means route in this interface: a profile's own colour is the line its
 * traffic runs on, on every surface. But the palette's fills are chosen to be
 * recognisable, not legible — a mint, an amber or a lime line on white is under
 * 2:1 — so each colour is given two variants per theme:
 *
 *   line  — strokes, keys and stop bars: at least 3:1 against the page (WCAG
 *           1.4.11, the floor for graphics that carry meaning);
 *   text  — a profile named in its own colour: at least 4.5:1.
 *
 * The adjustment is made in OKLCH, moving lightness only (and trimming chroma
 * where that leaves sRGB), so a deepened amber is still amber rather than a
 * muddy brown, and the dark-theme variants lift instead of deepen. Computed,
 * not tabulated: an imported or synced profile can carry any hex at all.
 */

export interface RouteColours {
  /** The colour as chosen — tiles and swatches. */
  fill: string;
  /** Initials on the fill: white or near-black, whichever reads. */
  on: string;
  lineLight: string;
  textLight: string;
  lineDark: string;
  textDark: string;
}

/** The two grounds each variant must hold against, per theme. */
const LIGHT_GROUNDS: Rgb[] = [hex('#ffffff'), hex('#f4f5f7')];
const DARK_GROUNDS: Rgb[] = [hex('#0f1013'), hex('#16181c')];
const INK: Rgb = hex('#121318');

type Rgb = [number, number, number];

function hex(h: string): Rgb {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h.trim());
  if (!m) return [100, 116, 139];
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

const lin = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const unlin = (c: number): number => {
  const v = Math.min(1, Math.max(0, c));
  return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
};

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** sRGB → OKLab (Björn Ottosson's matrices). */
function toOklab([r, g, b]: Rgb): [number, number, number] {
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → linear sRGB; may fall outside [0, 1] for out-of-gamut colours. */
function fromOklab(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** A colour at lightness L, hue h, with chroma trimmed until it is in gamut. */
function atLightness(L: number, C: number, h: number): Rgb {
  let c = C;
  for (;;) {
    const rgb = fromOklab(L, c * Math.cos(h), c * Math.sin(h));
    if (rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4) || c <= 0) {
      // Rounded here, not at the end: the contrast check must judge the colour
      // that is actually shipped, or a 3.00 can round to 2.99.
      return rgb.map((v) => Math.round(unlin(v))) as Rgb;
    }
    c = Math.max(0, c - 0.002);
  }
}

/** Step lightness away from the grounds until every one of them is beaten by `target`. */
function adjust(colour: Rgb, grounds: Rgb[], target: number, direction: -1 | 1): string {
  const worst = (rgb: Rgb): number => Math.min(...grounds.map((g) => contrast(rgb, g)));
  if (worst(colour) >= target) return toHex(colour);
  const [L0, a, b] = toOklab(colour);
  const C = Math.hypot(a, b);
  const h = Math.atan2(b, a);
  let L = L0;
  let rgb = colour;
  for (let i = 0; i < 250 && L > 0 && L < 1; i++) {
    L += 0.004 * direction;
    rgb = atLightness(L, C, h);
    if (worst(rgb) >= target) break;
  }
  return toHex(rgb);
}

const cache = new Map<string, RouteColours>();

export function routeColours(fill: string): RouteColours {
  const key = fill.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  const rgb = hex(key);
  const white: Rgb = [255, 255, 255];
  const result: RouteColours = {
    fill: toHex(rgb),
    on: contrast(white, rgb) >= contrast(INK, rgb) ? '#ffffff' : '#121318',
    lineLight: adjust(rgb, LIGHT_GROUNDS, 3, -1),
    textLight: adjust(rgb, LIGHT_GROUNDS, 4.5, -1),
    lineDark: adjust(rgb, DARK_GROUNDS, 3, 1),
    textDark: adjust(rgb, DARK_GROUNDS, 4.5, 1),
  };
  cache.set(key, result);
  return result;
}

/** The built-ins share one neutral: Direct is a line too, and System its dashed twin. */
export const BUILTIN_FILL = '#64748b';

/**
 * Put a profile's colours on an element as custom properties. The stylesheet's
 * `.rt` rule picks the light or the dark pair, so a theme change needs no
 * repaint. Works on SVG elements too.
 */
export function paintRoute<T extends HTMLElement | SVGElement>(node: T, fill: string): T {
  const c = routeColours(fill);
  node.classList.add('rt');
  node.style.setProperty('--fill', c.fill);
  node.style.setProperty('--on', c.on);
  node.style.setProperty('--line-l', c.lineLight);
  node.style.setProperty('--text-l', c.textLight);
  node.style.setProperty('--line-d', c.lineDark);
  node.style.setProperty('--text-d', c.textDark);
  return node;
}
