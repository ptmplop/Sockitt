import { BUILTIN_FILL } from './colour';
import { TraceEdge, compileRule, testBypass, testCondition, overrideFor } from './match';
import { parseRuleList } from './rulelist';
import { Config, DIRECT, Profile, RuleType, SYSTEM, SwitchRule, profileById } from './types';

/**
 * The track map: how a profile routes, laid out as railway track.
 *
 * Requests enter on the left and run along the trunk. Each rule of an auto
 * switch is a junction, placed in the order the rules are tried, and a rule
 * that sends traffic somewhere other than the default branches off at 45° onto
 * that destination's own line. Whatever no rule takes runs straight on: the
 * trunk becomes the default destination's line. A proxy's bypass list is a
 * junction of its own (a diamond) that drops onto Direct; a rule list is one
 * junction for the whole list.
 *
 * This module only computes geometry — junction positions, which track each
 * destination gets, the branch paths and where they merge. It has no DOM, so
 * the layout is tested directly (test/yard.test.mjs) and the views (Overview,
 * editors, inspector) only paint what it returns.
 *
 * Tracks are stacked so the destination first reached by an EARLIER junction
 * sits LOWER. A branch from junction i then never has to pass a track whose
 * first junction comes after i, which is what keeps the common case — rules
 * grouped by destination — free of crossings. Interleaved rules (A, B, A) can
 * still cross a higher track; the view draws a casing under every diagonal so
 * a crossing reads as passing over, never as a join.
 */

export interface YardGeometry {
  /** Where the trunk runs. Room above it for the junction labels. */
  trunkY: number;
  /** Centre of the first junction. The origin label and start bar sit left of it. */
  firstX: number;
  /** Between junction centres. */
  spacing: number;
  /** Between tracks. */
  trackGap: number;
  /** Corner radius of a branch's two turns. */
  radius: number;
  /** The narrowest the drawing may be. */
  minWidth: number;
  /** Horizontal run every track keeps after its last merge. */
  tail: number;
  /** At most this many junctions; past it the rest fold into the last. */
  maxJunctions: number;
}

/** The Overview's full map, with labels over each junction. */
export const FULL: YardGeometry = {
  trunkY: 56,
  firstX: 200,
  spacing: 120,
  trackGap: 104,
  radius: 18,
  minWidth: 760,
  tail: 64,
  maxJunctions: 6,
};

/** An editor's compact map: numbers only, the table beside it carries the text. */
export const COMPACT: YardGeometry = {
  trunkY: 32,
  firstX: 120,
  spacing: 100,
  trackGap: 74,
  radius: 14,
  minWidth: 716,
  tail: 56,
  maxJunctions: 6,
};

/** Where the start bar ends and the trunk begins. */
export function startX(g: YardGeometry): number {
  return g.firstX - 81;
}

export type YardKind = 'switch' | 'proxy' | 'rulelist' | 'direct' | 'system';

export interface YardJunction {
  /** Stable identity: a rule id, or 'overrides' / 'fold' / 'bypass' / 'list'. */
  key: string;
  shape: 'square' | 'wide' | 'diamond' | 'pin' | 'list';
  /** Inside the box: a rule's number, or the folded range ("6–24"). */
  label: string;
  /** Centre x. */
  x: number;
  /** Half the box's width — branches leave from its right edge. */
  half: number;
  /** A rule that is switched off: drawn dashed, never branches. */
  off: boolean;
  /** Above the box, first line: what kind of condition. */
  caption: string;
  /** Above the box, second line: the pattern, shortened to fit. */
  text: string;
  /** The pattern in full, for a tooltip. */
  fullText: string;
  /** Destinations this junction branches to (never the trunk's own default). */
  targets: string[];
  /** 0-based indexes of the rules it stands for. */
  ruleIndexes: number[];
}

export interface YardTrack {
  /** A profile id, DIRECT or SYSTEM. */
  id: string;
  y: number;
  /** Where its horizontal line begins: the trunk's start, or its first merge. */
  startX: number;
  colour: string;
  /** System: drawn dashed. */
  dashed: boolean;
  /** The trunk's own continuation: where everything no junction takes goes. */
  isDefault: boolean;
}

export interface YardBranch {
  junctionKey: string;
  targetId: string;
  /** Junction to merge point, as an SVG path. */
  d: string;
  /** The straight 45° run, for the casing drawn under it: x1, y1, x2, y2. */
  diagonal: [number, number, number, number];
  /** Where the branch lands on its track. */
  mergeX: number;
}

export interface YardLayout {
  kind: YardKind;
  /** The profile the map was drawn for (an alias is drawn as what it points at). */
  profileId: string;
  /** The alias the map was reached through, when it was. */
  viaAlias: string | null;
  width: number;
  height: number;
  trunkY: number;
  startX: number;
  /** The trunk is ink up to here (requests not yet decided); past it, the default's line. */
  trunkEnd: number;
  /** Where everything no junction takes goes. */
  defaultTarget: string;
  junctions: YardJunction[];
  /** Every destination's line, the default (at trunkY) first. */
  tracks: YardTrack[];
  branches: YardBranch[];
}

export const RULE_LABEL: Record<RuleType, string> = {
  hostWildcard: 'Host wildcard',
  hostRegex: 'Host regex',
  urlWildcard: 'URL wildcard',
  urlRegex: 'URL regex',
  ipCidr: 'IP range',
  keyword: 'URL keyword',
  hostLevels: 'Host levels',
  weekday: 'Weekday',
  time: 'Time of day',
};

/** A destination's colour: its profile's, or the built-ins' slate. */
export function colourOf(config: Config, id: string): string {
  if (id === DIRECT || id === SYSTEM) return BUILTIN_FILL;
  return profileById(config, id)?.color ?? BUILTIN_FILL;
}

/** Mono at 12.5px advances 7.5px a glyph; shorten from the middle to fit `px`. */
export function fitPattern(text: string, px: number): string {
  const max = Math.max(4, Math.floor(px / 7.5));
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

/**
 * A list in the room of one pattern: all of it when it fits, else its first
 * entry and how many more ("<local> +1") — a list cut in its middle reads as
 * one entry that does not exist.
 */
export function fitList(items: string[], px: number): string {
  const all = items.join(', ');
  if (fitPattern(all, px) === all) return all;
  const more = ` +${items.length - 1}`;
  return fitPattern(items[0] ?? '', px - more.length * 7.5) + more;
}

/**
 * Follow aliases to the profile that actually decides. Cycle-safe: a loop of
 * aliases ends where it would revisit, the same rule the PAC compiler uses.
 */
export function resolveAlias(config: Config, id: string): { id: string; via: string | null } {
  const seen = new Set<string>();
  let via: string | null = null;
  let cursor = id;
  for (;;) {
    const p = profileById(config, cursor);
    if (!p || p.kind !== 'virtual' || seen.has(cursor)) return { id: cursor, via };
    seen.add(cursor);
    via ??= p.name;
    cursor = p.targetId;
  }
}

interface JunctionSeed {
  key: string;
  shape: YardJunction['shape'];
  label: string;
  off: boolean;
  caption: string;
  fullText: string;
  /** A junction that stands for several entries names them one by one. */
  items?: string[];
  targets: string[];
  ruleIndexes: number[];
}

/** The junctions a profile has, in the order requests meet them. */
function seedsFor(
  profile: Profile,
  defaultTarget: string,
  overrides: SwitchRule[],
  g: YardGeometry
): JunctionSeed[] {
  const seeds: JunctionSeed[] = [];
  const distinct = (ids: string[]): string[] => [...new Set(ids.filter((t) => t !== defaultTarget))];

  if (profile.kind === 'switch') {
    const live = overrides.filter((r) => r.enabled);
    if (live.length) {
      seeds.push({
        key: 'overrides',
        shape: 'pin',
        label: '',
        off: false,
        caption: live.length === 1 ? 'Override' : 'Overrides',
        fullText: live.map((r) => r.pattern).join(', '),
        items: live.map((r) => r.pattern),
        targets: distinct(live.map((r) => r.targetId)),
        ruleIndexes: [],
      });
    }
    const rules = profile.rules;
    const shown = rules.length <= g.maxJunctions ? rules.length : g.maxJunctions - 1;
    rules.slice(0, shown).forEach((rule, i) => {
      seeds.push({
        key: rule.id,
        shape: 'square',
        label: String(i + 1),
        off: !rule.enabled,
        caption: `${RULE_LABEL[rule.type]}${rule.enabled ? '' : ' · off'}`,
        fullText: rule.pattern,
        targets: rule.enabled ? distinct([rule.targetId]) : [],
        ruleIndexes: [i],
      });
    });
    if (rules.length > shown) {
      const rest = rules.slice(shown);
      const enabled = rest.filter((r) => r.enabled);
      seeds.push({
        key: 'fold',
        shape: 'wide',
        label: `${shown + 1}–${rules.length}`,
        off: enabled.length === 0,
        caption: `${rest.length} more rules`,
        fullText: rest.map((r) => r.pattern).join(', '),
        items: rest.map((r) => r.pattern),
        targets: distinct(enabled.map((r) => r.targetId)),
        ruleIndexes: rest.map((_, i) => shown + i),
      });
    }
  } else if (profile.kind === 'proxy') {
    if (profile.bypass.length) {
      seeds.push({
        key: 'bypass',
        shape: 'diamond',
        label: '',
        off: false,
        caption: 'Bypass list',
        fullText: profile.bypass.join(', '),
        items: profile.bypass,
        targets: [DIRECT],
        ruleIndexes: [],
      });
    }
  } else if (profile.kind === 'rulelist') {
    const count = parseRuleList(profile.format, profile.text).count;
    seeds.push({
      key: 'list',
      shape: 'list',
      label: '',
      off: false,
      caption: 'Rule list',
      fullText: `${count.toLocaleString()} entr${count === 1 ? 'y' : 'ies'}`,
      targets: distinct([profile.matchTargetId]),
      ruleIndexes: [],
    });
  }
  return seeds;
}

/**
 * Lay out the map for `profileId` (an alias is followed to what it points at).
 * `overrides` are the per-site overrides in force on that profile — they are
 * tried before every rule, so they get the first junction.
 */
export function layoutYard(
  config: Config,
  profileId: string,
  g: YardGeometry = FULL,
  overrides: SwitchRule[] = []
): YardLayout {
  const { id, via } = resolveAlias(config, profileId);
  const profile = profileById(config, id);
  const sx = startX(g);

  let kind: YardKind;
  let defaultTarget: string;
  if (id === SYSTEM) {
    kind = 'system';
    defaultTarget = SYSTEM;
  } else if (!profile) {
    kind = 'direct';
    defaultTarget = DIRECT;
  } else if (profile.kind === 'proxy') {
    kind = 'proxy';
    defaultTarget = profile.id;
  } else if (profile.kind === 'switch') {
    kind = 'switch';
    defaultTarget = profile.defaultTargetId;
  } else if (profile.kind === 'rulelist') {
    kind = 'rulelist';
    defaultTarget = profile.defaultTargetId;
  } else {
    kind = 'direct';
    defaultTarget = DIRECT;
  }

  const seeds = profile && profile.kind !== 'virtual' ? seedsFor(profile, defaultTarget, overrides, g) : [];

  // Junction centres. A wide (folded) box takes a little more room after it.
  const junctions: YardJunction[] = [];
  let x = g.firstX;
  for (const seed of seeds) {
    const half = seed.shape === 'wide' ? Math.max(22, 6 + seed.label.length * 4) : seed.shape === 'diamond' ? 10 : 11;
    if (seed.shape === 'wide') x += half - 11;
    junctions.push({
      ...seed,
      x,
      half,
      text: seed.items && seed.items.length > 1 ? fitList(seed.items, g.spacing - 14) : fitPattern(seed.fullText, g.spacing - 14),
    });
    x += g.spacing + (seed.shape === 'wide' ? half - 11 : 0);
  }

  // Tracks below the trunk: the destination first reached by the EARLIEST
  // junction goes lowest (see the note at the top).
  const firstAt = new Map<string, number>();
  junctions.forEach((j, i) => j.targets.forEach((t) => firstAt.has(t) || firstAt.set(t, i)));
  const below = [...firstAt.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const yOf = new Map<string, number>(below.map((t, k) => [t, g.trunkY + (k + 1) * g.trackGap]));

  // Branches, junction by junction.
  const r = g.radius;
  const kr = r * Math.SQRT1_2;
  const mr = r - kr;
  const branches: YardBranch[] = [];
  const firstMerge = new Map<string, number>();
  for (const j of junctions) {
    for (const t of j.targets) {
      const y = yOf.get(t)!;
      const x0 = j.x + j.half + 1;
      const x3 = x0 + (y - g.trunkY) + (2 * kr - 2 * mr); // 45°: the diagonal's run equals its fall
      const d1x = x0 + kr;
      const d1y = g.trunkY + mr;
      const d2x = x3 - kr;
      const d2y = y - mr;
      const f = (n: number): string => (Math.round(n * 100) / 100).toString();
      branches.push({
        junctionKey: j.key,
        targetId: t,
        d: `M${f(j.x)} ${g.trunkY} H${f(x0)} A${r} ${r} 0 0 1 ${f(d1x)} ${f(d1y)} L${f(d2x)} ${f(d2y)} A${r} ${r} 0 0 0 ${f(x3)} ${y}`,
        diagonal: [d1x, d1y, d2x, d2y],
        mergeX: x3,
      });
      firstMerge.set(t, Math.min(firstMerge.get(t) ?? Infinity, x3));
    }
  }

  const lastJ = junctions.length ? junctions[junctions.length - 1]! : null;
  const maxMerge = branches.reduce((m, b) => Math.max(m, b.mergeX), 0);
  const width = Math.ceil(Math.max(g.minWidth, lastJ ? lastJ.x + lastJ.half + 64 : 0, maxMerge + g.tail));
  const height = g.trunkY + below.length * g.trackGap + (g === COMPACT ? 24 : 36);

  // The trunk stays ink while requests can still be decided, and the default
  // line leaves the last junction where its branches do — a switch, not a
  // seam further along. A proxy decides only at its bypass diamond, so with no
  // bypass list its line runs from the start; Direct and System are one line
  // throughout.
  const decides = kind === 'switch' || kind === 'rulelist' || kind === 'proxy';
  const trunkEnd = decides && lastJ ? lastJ.x + lastJ.half + 1 : sx;

  const tracks: YardTrack[] = [
    {
      id: defaultTarget,
      y: g.trunkY,
      startX: trunkEnd,
      colour: colourOf(config, defaultTarget),
      dashed: defaultTarget === SYSTEM,
      isDefault: true,
    },
    ...below.map((t) => ({
      id: t,
      y: yOf.get(t)!,
      startX: firstMerge.get(t)!,
      colour: colourOf(config, t),
      dashed: t === SYSTEM,
      isDefault: false,
    })),
  ];

  return {
    kind,
    profileId: id,
    viaAlias: via,
    width,
    height,
    trunkY: g.trunkY,
    startX: sx,
    trunkEnd,
    defaultTarget,
    junctions,
    tracks,
    branches,
  };
}

/** A branch's diagonal crosses a track it does not belong to — the view cases it. */
export function crossings(layout: YardLayout): Array<{ branch: YardBranch; track: YardTrack }> {
  const out: Array<{ branch: YardBranch; track: YardTrack }> = [];
  for (const b of layout.branches) {
    const [x1, y1, x2, y2] = b.diagonal;
    for (const t of layout.tracks) {
      if (t.id === b.targetId || t.isDefault) continue;
      if (t.y <= y1 || t.y >= y2) continue;
      const xAt = x1 + ((t.y - y1) * (x2 - x1)) / (y2 - y1);
      if (xAt > t.startX) out.push({ branch: b, track: t });
    }
  }
  return out;
}

/* ---------------- tracing one request ---------------- */

/**
 * The 0-based index of the rule a traced hop took, in the profile it left —
 * resolveRoute records a rule's pattern and type, not its position. The first
 * enabled rule with that pattern, type and target is the one first-match order
 * would reach, so a duplicate further down can never be named instead. -1 when
 * the hop was not a rule.
 */
export function edgeRuleIndex(config: Config, edge: TraceEdge): number {
  if (edge.kind !== 'rule') return -1;
  const p = profileById(config, edge.from);
  if (p?.kind !== 'switch') return -1;
  return p.rules.findIndex((r) => r.enabled && r.type === edge.ruleType && r.pattern === edge.pattern && r.targetId === edge.to);
}

export interface YardTrace {
  /** The junction that took the request; null when nothing did (the default). */
  junctionKey: string | null;
  /** The destination it was sent to on this map (a track id). */
  targetId: string;
  /** 0-based rule index, for "rule 3"; null for an override, bypass or the default. */
  ruleIndex: number | null;
  /** The override that took it, if one did. */
  override: SwitchRule | null;
  /** The rule that took it, if one did. */
  rule: SwitchRule | null;
}

/**
 * Which junction takes a request, by the same tests the resolver and the
 * compiled PAC run, in the same order: overrides, then rules top to bottom.
 * Only the drawn profile's own decision — where the destination then sends it
 * (a nested switch, a bypass list) is resolveRoute's to say.
 */
export function traceYard(
  config: Config,
  layout: YardLayout,
  url: string,
  host: string,
  overrides: SwitchRule[] = [],
  now: Date = new Date()
): YardTrace {
  const profile = profileById(config, layout.profileId);
  const none: YardTrace = { junctionKey: null, targetId: layout.defaultTarget, ruleIndex: null, override: null, rule: null };
  if (!profile) return none;

  if (profile.kind === 'switch') {
    const ovr = overrideFor(overrides, url, host, now);
    if (ovr) {
      return { junctionKey: ovr.targetId === layout.defaultTarget ? null : 'overrides', targetId: ovr.targetId, ruleIndex: null, override: ovr, rule: null };
    }
    const index = profile.rules.findIndex((r) => r.enabled && testCondition(compileRule(r), url, host, now));
    if (index < 0) return none;
    const rule = profile.rules[index]!;
    const junction = layout.junctions.find((j) => j.ruleIndexes.includes(index));
    return {
      junctionKey: rule.targetId === layout.defaultTarget ? null : (junction?.key ?? null),
      targetId: rule.targetId,
      ruleIndex: index,
      override: null,
      rule,
    };
  }
  if (profile.kind === 'proxy') {
    if (testBypass(profile.bypass, url, host)) {
      return { junctionKey: 'bypass', targetId: DIRECT, ruleIndex: null, override: null, rule: null };
    }
    return none;
  }
  if (profile.kind === 'rulelist') {
    const parsed = parseRuleList(profile.format, profile.text);
    const hit = (conds: ReturnType<typeof parseRuleList>['blacklist']) => conds.some((c) => testCondition(c, url, host, now));
    const matched = !hit(parsed.whitelist) && hit(parsed.blacklist);
    if (!matched || profile.matchTargetId === layout.defaultTarget) return { ...none, targetId: matched ? profile.matchTargetId : layout.defaultTarget };
    return { junctionKey: 'list', targetId: profile.matchTargetId, ruleIndex: null, override: null, rule: null };
  }
  return none;
}
