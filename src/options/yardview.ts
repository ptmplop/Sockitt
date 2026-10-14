import { paintRoute } from '../shared/colour';
import { svg } from '../shared/ui';
import { COMPACT, YardLayout, YardTrace, fitPattern } from '../shared/yard';

/**
 * Paint a track-map layout (shared/yard.ts) as SVG.
 *
 * Draw order is the point of this file: tracks first, then a casing under
 * every diagonal, then the branches, then the junction boxes and their labels
 * — so a branch that crosses another destination's track visibly passes over
 * it, and nothing covers a junction's number.
 *
 * With a trace, the request's path is drawn heavier and everything else fades
 * to a pre-mixed tint (theme.css .faded) — the drawing still shows the whole
 * profile, but the eye follows the one line the request took.
 */
export interface YardPaint {
  layout: YardLayout;
  /** The request being traced, if any. */
  trace?: YardTrace | null;
  /** Origin label: first line, and the quieter second line. */
  origin?: { title: string; sub?: string; mono?: boolean };
  /** Compact maps (editors) carry their destinations' names inside the drawing. */
  names?: Map<string, { name: string; sub?: string }>;
  /** The junction a rules table row is pointing at (hover/focus), drawn lit. */
  hilite?: string | null;
  ariaLabel: string;
}

const LABEL_ROOM = 170;

export function yardSvg(p: YardPaint): SVGSVGElement {
  const { layout } = p;
  const compact = layout.trunkY === COMPACT.trunkY;
  const W = layout.width + (compact ? LABEL_ROOM : 0);
  const node = svg('svg', {
    class: `yard-svg${compact ? ' compact' : ''}`,
    viewBox: `0 0 ${W} ${layout.height}`,
    width: W,
    height: layout.height,
    role: 'img',
  });
  node.setAttribute('aria-label', p.ariaLabel);

  const trace = p.trace ?? null;
  // A trace fades everything off the request's path; a hovered rule (hilite)
  // only draws its own junction and branch heavier and leaves the rest alone.
  const fade = trace !== null;
  const litJ = trace ? trace.junctionKey : (p.hilite ?? null);
  const litTarget = trace ? trace.targetId : null;
  const litBranch = litJ === null ? null : (layout.branches.find((b) => b.junctionKey === litJ && (litTarget === null || b.targetId === litTarget)) ?? null);
  const litJunction = layout.junctions.find((j) => j.key === litJ) ?? null;
  const y0 = layout.trunkY;

  const line = (d: string, cls: string, colour?: string): SVGPathElement => {
    const path = svg('path', { d, class: cls });
    if (colour) paintRoute(path, colour);
    node.append(path);
    return path;
  };

  /* --- tracks --- */
  for (const t of layout.tracks) {
    const dash = t.dashed ? ' system' : '';
    if (t.isDefault) {
      // The default runs on from where the trunk stops deciding.
      const taken = trace !== null && trace.junctionKey === null;
      if (layout.trunkEnd < layout.width) {
        line(`M${layout.trunkEnd} ${y0} H${layout.width}`, `trk${dash}${taken ? ' lit' : fade ? ' faded' : ''}`, t.colour);
      }
      continue;
    }
    // A traced request joins its track at its own branch's merge; the stretch
    // before that belongs to an earlier junction's traffic, so it stays faded.
    if (fade && litBranch && litBranch.targetId === t.id) {
      if (litBranch.mergeX > t.startX) line(`M${t.startX} ${t.y} H${litBranch.mergeX}`, `trk${dash} faded`, t.colour);
      line(`M${litBranch.mergeX} ${t.y} H${layout.width}`, `trk${dash} lit`, t.colour);
    } else {
      line(`M${t.startX} ${t.y} H${layout.width}`, `trk${dash}${fade ? ' faded' : ''}`, t.colour);
    }
  }

  /* --- the trunk: ink while requests are still being decided --- */
  if (layout.trunkEnd > layout.startX) {
    if (fade && litJunction) {
      line(`M${litJunction.x} ${y0} H${layout.trunkEnd}`, 'trk trunk faded');
      line(`M${layout.startX} ${y0} H${litJunction.x + litJunction.half}`, 'trk trunk lit');
    } else {
      line(`M${layout.startX} ${y0} H${layout.trunkEnd}`, `trk trunk${fade ? ' lit' : ''}`);
    }
  }
  node.append(svg('rect', { class: 'y-start', x: layout.startX - 5, y: y0 - 13, width: 5, height: 26, rx: 1 }));

  /* --- casings, then branches --- */
  for (const b of layout.branches) {
    const [x1, y1, x2, y2] = b.diagonal;
    line(`M${x1 + 3} ${y1 + 3} L${x2 - 3} ${y2 - 3}`, 'trk case');
  }
  for (const b of layout.branches) {
    const colour = layout.tracks.find((t) => t.id === b.targetId)?.colour;
    const onPath = b === litBranch || (!trace && litJ !== null && b.junctionKey === litJ);
    line(b.d, `trk${onPath ? ' lit' : fade ? ' faded' : ''}`, colour);
  }
  // SVG paints in document order, so the path being followed goes last: a
  // faded branch or a casing drawn after it would cut a notch into it.
  node.querySelectorAll('path.trk.lit').forEach((n) => node.append(n));

  /* --- junctions --- */
  for (const j of layout.junctions) {
    const on = j.key === litJ;
    const faded = fade && !on;
    const cls = (base: string): string => `${base}${on ? ' lit' : ''}${j.off ? ' off' : ''}${faded && !j.off ? ' faded' : ''}`;
    if (j.shape === 'diamond') {
      const box = svg('rect', {
        class: `jn byp${faded ? ' faded' : ''}`,
        x: j.x - 7,
        y: y0 - 7,
        width: 14,
        height: 14,
        rx: 2.5,
        transform: `rotate(45 ${j.x} ${y0})`,
      });
      paintRoute(box, layout.tracks.find((t) => j.targets.includes(t.id))?.colour ?? '#64748b');
      node.append(box);
    } else {
      node.append(svg('rect', { class: cls('jn'), x: j.x - j.half, y: y0 - 11, width: j.half * 2, height: 22, rx: 5 }));
      if (j.shape === 'pin') {
        node.append(
          svg('path', {
            class: `jn-pin${on ? ' lit' : ''}`,
            d: `M${j.x - 3.5} ${y0 - 5.5} H${j.x + 3.5} M${j.x - 2.25} ${y0 - 5.5} V${y0 - 2} L${j.x - 4.25} ${y0 + 1} H${j.x + 4.25} L${j.x + 2.25} ${y0 - 2} V${y0 - 5.5} M${j.x} ${y0 + 1} V${y0 + 5.5}`,
          })
        );
      } else if (j.shape === 'list') {
        node.append(svg('path', { class: `jn-pin${on ? ' lit' : ''}`, d: `M${j.x - 5} ${y0 - 4} H${j.x + 5} M${j.x - 5} ${y0} H${j.x + 5} M${j.x - 5} ${y0 + 4} H${j.x + 2}` }));
      } else {
        node.append(svg('text', { class: `jn-num${on ? ' lit' : j.off || faded ? ' dim' : ''}`, x: j.x, y: y0 }, j.label));
      }
    }
    if (!compact) {
      const dim = (faded || j.off) ? ' dim' : '';
      const cap = svg('text', { class: `y-kind${dim}`, x: j.x, y: y0 - 40 }, j.caption);
      const pat = svg('text', { class: `y-pat${dim}`, x: j.x, y: y0 - 22 }, j.text);
      if (j.text !== j.fullText) pat.append(svg('title', {}, j.fullText));
      node.append(cap, pat);
    }
  }

  /* --- origin (full maps) --- */
  if (!compact && p.origin) {
    // The label has the room left of the start bar and no more; a long host
    // keeps its two ends, which are the parts that tell hosts apart.
    const room = layout.startX - 16;
    // fitPattern counts 7.5px a character; the origin's mono is set at 12px (7.2px).
    const title = p.origin.mono ? fitPattern(p.origin.title, room * (7.5 / 7.2)) : p.origin.title;
    const org = svg('text', { class: `y-org${p.origin.mono ? ' mono' : ''}`, x: 0, y: y0 - 4 }, title);
    if (title !== p.origin.title) org.append(svg('title', {}, p.origin.title));
    node.append(org);
    if (p.origin.sub) node.append(svg('text', { class: 'y-sub', x: 0, y: y0 + 14 }, p.origin.sub));
  }

  /* --- compact maps name their destinations inside the drawing --- */
  if (compact && p.names) {
    for (const t of layout.tracks) {
      const stop = svg('rect', { class: 'y-stop', x: layout.width, y: t.y - 13, width: 4, height: 26, rx: 1 });
      paintRoute(stop, t.colour);
      node.append(stop);
      const label = p.names.get(t.id);
      if (!label) continue;
      node.append(svg('text', { class: 'y-term', x: layout.width + 18, y: t.y + (label.sub ? -2 : 5) }, label.name));
      if (label.sub) node.append(svg('text', { class: 'y-sub', x: layout.width + 18, y: t.y + 15 }, label.sub));
    }
  }
  return node;
}
