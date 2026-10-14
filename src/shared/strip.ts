import { BUILTIN_FILL, paintRoute } from './colour';
import { el, svg } from './ui';

/**
 * One request's route, drawn small — the popup's answer for the tab in front
 * of you, and the activity log's for a request you opened.
 *
 * It is the Overview's track map reduced to the one path that was taken:
 * requests enter on the left on the ink trunk; the junction that decided them
 * is drawn where they leave it (a numbered rule, a pinned override, a bypass
 * diamond); the branch runs at 45° onto the destination's own line, which ends
 * at a stop bar beside the destination's name. When nothing decides — a plain
 * proxy, an alias, Direct — the strip is one flat line in the destination's
 * colour. Geometry is fixed (368 wide); the name sits where the line ends, so
 * the stop bar always closes the line it belongs to.
 */
export interface StripModel {
  how:
    | { kind: 'all' } // the profile routes everything one way
    | { kind: 'rule'; label: string } // a rule took it; label is its number
    | { kind: 'override' } // a per-site override took it, ahead of every rule
    | { kind: 'list' } // a rule list found it on its list
    | { kind: 'default' } // an auto switch's default took it — no rule matched
    | { kind: 'bypass'; viaColour: string }; // a proxy's bypass list sent it direct
  dest: { name: string; colour: string; system?: boolean };
  /** The destination's proxy is failing: the line breaks before its stop. */
  broken?: boolean;
  /** Read-out for assistive tech; the drawing itself is aria-hidden. */
  label: string;
}

const END = 226;

export function routeStrip(model: StripModel): HTMLElement {
  const flat = model.how.kind === 'all' || model.how.kind === 'default';
  const H = flat ? 24 : 50;
  const drawing = svg('svg', { viewBox: `0 0 368 ${H}`, 'aria-hidden': 'true', focusable: 'false' });
  const destColour = model.dest.colour || BUILTIN_FILL;
  const lineEnd = model.broken ? END - 34 : END;

  const path = (d: string, cls: string, colour?: string): SVGPathElement => {
    const node = svg('path', { d, class: cls });
    if (colour) paintRoute(node, colour);
    drawing.append(node);
    return node;
  };
  const start = (y: number): void => {
    drawing.append(svg('rect', { class: 'y-start', x: 0, y: y - 11, width: 4, height: 22, rx: 1 }));
  };
  const brk = (y: number): void => {
    const x = lineEnd + 9;
    drawing.append(
      svg('path', { class: 'y-break', d: `M${x + 6} ${y - 11} L${x} ${y + 11} M${x + 14} ${y - 11} L${x + 8} ${y + 11}` })
    );
  };

  switch (model.how.kind) {
    case 'all':
      start(12);
      path(`M4 12 H${lineEnd}`, `trk${model.dest.system ? ' system' : ''}`, destColour);
      if (model.broken) brk(12);
      break;
    case 'default':
      // Through the switch with no rule taking it: the trunk, then the default's line.
      start(12);
      path('M4 12 H120', 'trk trunk');
      path(`M120 12 H${lineEnd}`, `trk${model.dest.system ? ' system' : ''}`, destColour);
      if (model.broken) brk(12);
      break;
    case 'rule': {
      start(13);
      path('M106 13 H368', 'trk trunk faded');
      path('M4 13 H106', 'trk trunk');
      path(`M96 13 H106 A10 10 0 0 1 113.07 15.93 L133.21 36.07 A10 10 0 0 0 140.28 39 H${lineEnd}`, 'trk', destColour);
      drawing.append(svg('rect', { class: 'jn lit', x: 86, y: 3, width: 20, height: 20, rx: 4.5 }));
      drawing.append(svg('text', { class: 'jn-num lit', x: 96, y: 13 }, model.how.label));
      if (model.broken) brk(39);
      break;
    }
    case 'list': {
      // A rule list decides in one step: on the list, or not.
      start(13);
      path('M106 13 H368', 'trk trunk faded');
      path('M4 13 H106', 'trk trunk');
      path(`M96 13 H106 A10 10 0 0 1 113.07 15.93 L133.21 36.07 A10 10 0 0 0 140.28 39 H${lineEnd}`, 'trk', destColour);
      drawing.append(svg('rect', { class: 'jn lit', x: 86, y: 3, width: 20, height: 20, rx: 4.5 }));
      drawing.append(svg('path', { class: 'jn-pin on-lit', d: 'M91 9 H101 M91 13 H101 M91 17 H98' }));
      if (model.broken) brk(39);
      break;
    }
    case 'override': {
      start(13);
      path('M56 13 H368', 'trk trunk faded');
      path('M4 13 H56', 'trk trunk');
      path(`M46 13 H56 A10 10 0 0 1 63.07 15.93 L83.21 36.07 A10 10 0 0 0 90.28 39 H${lineEnd}`, 'trk', destColour);
      const jn = svg('rect', { class: 'jn ovr', x: 36, y: 3, width: 20, height: 20, rx: 4.5 });
      paintRoute(jn, destColour);
      drawing.append(jn);
      drawing.append(
        svg('path', { class: 'jn-pin', d: 'M42.5 7.5 H49.5 M43.75 7.5 V11 L41.75 14 H50.25 L48.25 11 V7.5 M46 14 V18.5' })
      );
      if (model.broken) brk(39);
      break;
    }
    case 'bypass': {
      // Headed into the proxy, turned aside at its bypass list onto Direct.
      start(13);
      path('M106 13 H368', 'trk faded', model.how.viaColour);
      path('M4 13 H106', 'trk', model.how.viaColour);
      path(`M96 13 H106 A10 10 0 0 1 113.07 15.93 L133.21 36.07 A10 10 0 0 0 140.28 39 H${lineEnd}`, 'trk', destColour);
      const jn = svg('rect', { class: 'jn byp', x: 89, y: 6, width: 14, height: 14, rx: 2.5, transform: 'rotate(45 96 13)' });
      paintRoute(jn, BUILTIN_FILL);
      drawing.append(jn);
      break;
    }
  }

  const dest = paintRoute(
    el('p', { class: 'strip-dest' }, el('span', { class: 'stop' }), el('span', { class: 'nm', title: model.dest.name }, model.dest.name)),
    destColour
  );

  const node = el('div', { class: `strip${flat ? ' flat' : ''}`, role: 'img' }, drawing, dest);
  node.setAttribute('aria-label', model.label);
  return node;
}
