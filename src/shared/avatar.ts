import { Profile } from './types';
import { el } from './ui';

/**
 * DiceBear-"initials"-style avatars, generated locally: a coloured rounded
 * tile with 1–3 uppercase characters. Custom initials win; otherwise they
 * derive from the name (first letters of the first two words, or the first
 * two letters of a single word).
 */
export function initialsFor(profile: Pick<Profile, 'name' | 'initials'>): string {
  const custom = profile.initials?.trim();
  if (custom) return custom.slice(0, 3).toUpperCase();
  const words = profile.name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** The dark ink option — 85% black over the tile, so a trace of the hue shows through. */
const DARK_INK = 'rgba(10,14,22,0.85)';
const DARK_INK_RGB = [10, 14, 22] as const;

/** sRGB channel -> linear light. */
function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]: readonly number[]): number {
  return 0.2126 * toLinear(r!) + 0.7152 * toLinear(g!) + 0.0722 * toLinear(b!);
}

function contrast(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * Ink for text painted on a profile's colour — the avatar initials, the selected
 * popup row, and the toolbar badge glyph.
 *
 * Picks whichever of white or near-black actually contrasts better, measured the
 * WCAG way (gamma-corrected luminance). A naive linear average with a fixed
 * threshold used to send white onto the pink, red, teal and blue swatches, where
 * it lands at 2.5–3.7:1 — unreadable at the 10px the initials are set in, and
 * worse still across a whole filled row.
 */
export function textColorFor(background: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(background);
  if (!m) return '#fff';
  const bg = [m[1], m[2], m[3]].map((h) => parseInt(h!, 16));
  // The dark option is translucent, so compare the colour it actually composites to.
  const dark = DARK_INK_RGB.map((c, i) => 0.85 * c + 0.15 * bg[i]!);
  return contrast([255, 255, 255], bg) >= contrast(dark, bg) ? '#fff' : DARK_INK;
}

export function avatarEl(
  profile: Pick<Profile, 'name' | 'initials' | 'color'>,
  size: number
): HTMLElement {
  const node = el('span', { class: 'avatar' }, initialsFor(profile));
  node.style.width = node.style.height = `${size}px`;
  node.style.fontSize = `${Math.round(size * 0.4)}px`;
  node.style.background = profile.color;
  node.style.color = textColorFor(profile.color);
  return node;
}

/** Neutral tile for the built-in Direct / System entries. */
export function builtinTile(letter: string, size: number): HTMLElement {
  const node = el('span', { class: 'avatar builtin' }, letter);
  node.style.width = node.style.height = `${size}px`;
  node.style.fontSize = `${Math.round(size * 0.4)}px`;
  return node;
}
