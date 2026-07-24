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

/** White text on dark tiles, near-black on light ones (e.g. amber). */
export function textColorFor(background: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(background);
  if (!m) return '#fff';
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h!, 16) / 255);
  const lum = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return lum > 0.6 ? 'rgba(10,14,22,0.85)' : '#fff';
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
