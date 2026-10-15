import { el, svg } from './ui';
import { MARK_SOCK, MARK_TRIMS, MARK_VIEWBOX } from './mark-paths';

/**
 * The Sockitt mark, drawn inline rather than loaded as an image. Its cuff, heel
 * and toe are painted var(--brand-trim), which the dark theme swaps from indigo
 * to lavender, so the mark follows this device's Theme setting; an <img> could
 * only follow the operating system's colour scheme.
 *
 * Wrapped in a span: the popup's wiggle restarts its animation by reading
 * offsetWidth, which an SVG root doesn't have. Decorative - the name beside it
 * is the label.
 */
export function brandMark(): HTMLElement {
  const drawing = svg(
    'svg',
    { viewBox: MARK_VIEWBOX, 'aria-hidden': 'true', focusable: 'false' },
    svg('path', { class: 'm-sock', d: MARK_SOCK }),
    ...MARK_TRIMS.map((d) => svg('path', { class: 'm-trim', d }))
  );
  return el('span', { class: 'mark' }, drawing);
}
