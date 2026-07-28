import { avatarEl, builtinTile, initialsFor, textColorFor } from '../shared/avatar';
import { ExitInfo, checkExitIp, flagSrc } from '../shared/exitip';
import {
  HealthIssue,
  auditConfig,
  listedEntryCount,
  livePath,
  ruleStats,
} from '../shared/health';
import { ProxyAlert, ProxyErrorEntry, errorHeadline } from '../shared/errors';
import { pacRequestUrl, resolveRoute } from '../shared/match';
import { parseRuleList } from '../shared/rulelist';
import {
  APPLIED_KEY,
  ActivationEntry,
  CONTROL_KEY,
  TEST_KEY,
  TEST_RESULT_KEY,
  loadHistory,
} from '../shared/state';
import { tabTarget } from '../shared/tabs';
import {
  AUTH_PERMS,
  Config,
  DIRECT,
  Profile,
  ProxyProfile,
  SCHEME_LABELS,
  SYSTEM,
  TABS_PERMS,
  profileById,
  referencedTargets,
} from '../shared/types';
import { el, relativeTime, svg, toast } from '../shared/ui';

/**
 * The Overview page — the options tab's landing surface.
 *
 * Everything here is derived: the dashboard owns no state of its own and writes
 * nothing except through the host callbacks below. That is what lets it be
 * repainted wholesale from a storage event without eating an edit in progress —
 * there is no edit in progress to eat, apart from the URL tester, whose card
 * deliberately does not participate in repaints.
 */
export interface DashboardHost {
  /** The page's live config snapshot. A getter, not a value: render() rebuilds
   *  the panel but storage repaints do not, and a captured object would go stale. */
  config: () => Config;
  alert: () => ProxyAlert | null;
  errorLog: () => ProxyErrorEntry[];
  /** Select a profile editor or one of the extension pages. */
  open: (id: string) => void;
  /** Make a profile active. */
  activate: (id: string) => void;
  /** Persist a config mutation made from here. */
  save: () => void;
  /** Request the optional proxy-auth permissions; resolves true when granted. */
  requestAuth: () => Promise<boolean>;
  /** Request the ipconfig.is origin; resolves true when granted. */
  requestExitIp: () => Promise<boolean>;
  /** Refetch a rule list by id (shared with the rule-list editor). */
  refetchRuleList: (profileId: string) => Promise<void>;
}

let host: DashboardHost;
let root: HTMLElement | null = null;
/** One repaint function per card. Rebuilt whenever the panel is constructed. */
let refreshers: Array<() => void> = [];
/**
 * Bumped on every panel build. Async card fills compare against it before
 * touching the DOM, so a permission check or a tab query that resolves after
 * the user has navigated away cannot paint into a detached tree.
 */
let generation = 0;
/** Cached so a repaint (every few seconds) does not re-run the exit lookup. */
let exitInfo: ExitInfo | null = null;
let exitError: string | null = null;
let exitAt = 0;
let exitBusy = false;
/** The profile the cached measurement belongs to — see invalidateExit. */
let exitForId = '';

const REL_TICK_MS = 30_000;
let relTimer: ReturnType<typeof setInterval> | undefined;

/* ---------------- shared bits ---------------- */

const ICON = {
  shield:
    '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z"/></svg>',
  globe:
    '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></svg>',
  you:
    '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8M12 18v3"/></svg>',
  lock:
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
};

/** Neutral display record for a routing node: a profile, or Direct / System. */
interface NodeInfo {
  id: string;
  name: string;
  color: string;
  initials: string;
  /** Second line — an endpoint, or what the profile is. */
  sub: string;
  builtin: boolean;
}

const BUILTIN_COLOR = '#4a5162';

function nodeInfo(config: Config, id: string): NodeInfo {
  if (id === DIRECT) {
    return { id, name: 'Direct', color: BUILTIN_COLOR, initials: 'D', sub: 'no proxy', builtin: true };
  }
  if (id === SYSTEM) {
    return { id, name: 'System', color: BUILTIN_COLOR, initials: 'S', sub: 'OS settings', builtin: true };
  }
  const p = profileById(config, id);
  if (!p) {
    return { id, name: 'Unknown', color: BUILTIN_COLOR, initials: '?', sub: 'missing', builtin: true };
  }
  return {
    id,
    name: p.name,
    color: p.color,
    initials: initialsFor(p),
    sub: subtitleFor(config, p),
    builtin: false,
  };
}

/**
 * A target's display name and nothing else.
 *
 * subtitleFor MUST use this rather than nodeInfo: nodeInfo calls subtitleFor,
 * so an alias pointing at an alias that points back would recurse until the
 * stack gave out. A cyclic configuration is exactly the kind this page exists
 * to show you, so it has to survive being drawn.
 */
function nameOf(config: Config, id: string): string {
  if (id === DIRECT) return 'Direct';
  if (id === SYSTEM) return 'System';
  return profileById(config, id)?.name ?? 'Unknown';
}

function subtitleFor(config: Config, p: Profile): string {
  switch (p.kind) {
    case 'proxy':
      return `${SCHEME_LABELS[p.scheme]} ${p.host || '(no host)'}:${p.port}`;
    case 'switch': {
      const on = p.rules.filter((r) => r.enabled).length;
      return `${on} rule${on === 1 ? '' : 's'} · default ${nameOf(config, p.defaultTargetId)}`;
    }
    case 'rulelist':
      return `${parseRuleList(p.format, p.text).count.toLocaleString()} entries`;
    case 'virtual':
      return `alias → ${nameOf(config, p.targetId)}`;
  }
}

/** A profile tile at any size, for profiles and the two built-ins alike. */
function tileFor(config: Config, id: string, size: number): HTMLElement {
  const p = id === DIRECT || id === SYSTEM ? null : profileById(config, id);
  if (!p) return builtinTile(id === SYSTEM ? 'S' : 'D', size);
  return avatarEl(p, size);
}

/**
 * `panel` is deliberately in the class list: it brings the card padding, the
 * column layout and — the point — the h3 eyebrow with its gradient tick, so the
 * dashboard's headings are the same object as every other card's rather than a
 * lookalike that drifts. .dash-card only tightens the spacing.
 */
function card(cls: string, ...children: (Node | string | null | false)[]): HTMLElement {
  return el('section', { class: `card panel dash-card ${cls}` }, ...children);
}

function cardHead(title: string, ...trailing: (Node | string | null | false)[]): HTMLElement {
  return el('h3', {}, title, trailing.length ? el('span', { class: 'dash-rt' }, ...trailing) : null);
}

/* ---------------- hero: the live route console ---------------- */

/** The hop chain the active profile actually produces, as display rows. */
function chainFor(config: Config): { label: string; sub?: string; conditional: boolean }[] {
  const id = config.activeId;
  if (id === DIRECT) return [{ label: 'Internet', conditional: false }];
  if (id === SYSTEM) return [{ label: 'System proxy', sub: 'set by your OS', conditional: false }, { label: 'Internet', conditional: false }];

  const hops: { label: string; sub?: string; conditional: boolean }[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = id;

  while (cursor && cursor !== DIRECT && !seen.has(cursor)) {
    seen.add(cursor);
    const p: Profile | undefined = profileById(config, cursor);
    if (!p) break;
    if (p.kind === 'proxy') {
      hops.push({ label: p.name, sub: `${SCHEME_LABELS[p.scheme]} ${p.host}:${p.port}`, conditional: false });
      cursor = undefined;
    } else if (p.kind === 'virtual') {
      hops.push({ label: p.name, sub: 'alias', conditional: false });
      cursor = p.targetId;
    } else {
      // A switch or rule-list profile picks per request; the chain stops being
      // a line here and becomes a fan-out. Say so rather than picking one.
      const targets = new Set(referencedTargets(p).map((t) => nodeInfo(config, t).name));
      hops.push({
        label: p.name,
        sub: `routes per request → ${[...targets].join(' · ')}`,
        conditional: true,
      });
      cursor = undefined;
    }
  }
  hops.push({ label: 'Internet', conditional: false });
  return hops;
}

function heroCard(): { node: HTMLElement; refresh: () => void } {
  const node = el('section', { class: 'hero-console' });

  const refresh = (): void => {
    const config = host.config();
    const alert = host.alert();
    const activeId = config.activeId;
    const info = nodeInfo(config, activeId);
    const profile = profileById(config, activeId);

    const failing = Boolean(alert);
    const state = el(
      'span',
      { class: `hero-state ${failing ? 'bad' : 'ok'}` },
      el('i', {}),
      el('span', {}, failing ? 'Proxy failing' : 'Routing')
    );
    if (failing && alert) state.title = errorHeadline(alert);

    const identity = el(
      'div',
      { class: 'hero-id' },
      tileFor(config, activeId, 54),
      el(
        'div',
        { class: 'hero-idtext' },
        el('div', { class: 'hero-name' }, info.name),
        el('div', { class: 'hero-meta' }, profile ? subtitleFor(config, profile) : info.sub),
        state
      )
    );

    const hops = chainFor(config);
    const flow = el('div', { class: 'flow' });
    flow.append(
      el('span', { class: 'hop start', innerHTML: ICON.you }, el('span', {}, 'You'))
    );
    for (const hop of hops) {
      flow.append(el('span', { class: `wire${hop.conditional ? ' conditional' : ''}` }));
      const isEnd = hop.label === 'Internet';
      const chip = el(
        'span',
        { class: `hop${isEnd ? ' term' : ''}` },
        isEnd ? el('span', { class: 'hop-ic', innerHTML: ICON.globe }) : null,
        el('span', { class: 'hop-name' }, hop.label)
      );
      if (hop.sub) chip.title = hop.sub;
      flow.append(chip);
    }

    const control = controlPill();
    node.replaceChildren(
      ...[identity, flow, exitBlock(), switcherRow(), control].filter((n): n is HTMLElement => n !== null)
    );
  };

  return { node, refresh };
}

/** The exit-IP readout, or the affordance that turns lookups on. */
function exitBlock(): HTMLElement {
  const config = host.config();
  const box = el('div', { class: 'hero-exit' }, el('div', { class: 'hero-exit-lbl' }, 'Exit'));

  if (!config.settings.exitIpCheck) {
    box.append(
      el('div', { class: 'hero-exit-off' }, 'IP lookups are off'),
      el(
        'button',
        {
          class: 'hero-btn',
          onclick: async () => {
            if (!(await host.requestExitIp())) {
              toast('Permission declined');
              return;
            }
            host.config().settings.exitIpCheck = true;
            host.save();
          },
        },
        'Turn on'
      )
    );
    return box;
  }

  if (exitBusy) {
    box.append(el('div', { class: 'hero-exit-off' }, 'Measuring…'));
    return box;
  }
  if (exitError) {
    box.append(
      el('div', { class: 'hero-exit-off bad' }, exitError),
      el('button', { class: 'hero-btn', onclick: () => void runExitCheck(true) }, 'Retry')
    );
    return box;
  }
  if (!exitInfo) {
    box.append(el('button', { class: 'hero-btn', onclick: () => void runExitCheck(true) }, 'Measure'));
    return box;
  }

  const src = flagSrc(exitInfo.iso);
  box.append(
    el(
      'div',
      { class: 'hero-ip' },
      el('span', {}, exitInfo.ip),
      src ? el('img', { class: 'hero-flag', src, alt: '', width: 20, height: 15 }) : null
    ),
    el(
      'div',
      { class: 'hero-exit-sub' },
      `${exitInfo.country ? exitInfo.country + ' · ' : ''}${exitInfo.ms} ms · ${relativeTime(exitAt)}`
    )
  );
  return box;
}

/**
 * Measure the exit through the route that is live right now. Runs in the page,
 * exactly as the popup's readout does — the request rides the browser's current
 * proxy settings, which is the whole point of the number.
 */
async function runExitCheck(force = false): Promise<void> {
  const config = host.config();
  if (!config.settings.exitIpCheck || exitBusy) return;
  // Re-measuring on every repaint would put a network request behind every
  // error event; a fresh-enough answer stands.
  if (!force && exitInfo && Date.now() - exitAt < 60_000) return;
  if (!(await chrome.permissions.contains({ origins: ['https://ipconfig.is/*'] }).catch(() => false))) {
    return;
  }
  exitBusy = true;
  exitError = null;
  exitForId = config.activeId;
  repaintDashboard();
  try {
    exitInfo = await checkExitIp(8000);
    exitAt = Date.now();
  } catch (e) {
    exitInfo = null;
    exitError = e instanceof Error ? e.message : 'lookup failed';
  } finally {
    exitBusy = false;
    repaintDashboard();
  }
}

/** Headings for the switcher's option groups, in the order the sidebar uses. */
const SWITCH_GROUPS: Array<[Profile['kind'], string]> = [
  ['proxy', 'Proxies'],
  ['switch', 'Auto switch'],
  ['rulelist', 'Rule lists'],
  ['virtual', 'Aliases'],
];

/**
 * Inline profile switcher — the fastest path from "landed" to "switched".
 *
 * A dropdown rather than a row of pills: pills were fine at four profiles and a
 * wall of them at fifteen, wrapping to three lines and burying the one that was
 * actually active. A select stays one control at any size, and optgroups keep
 * the kinds apart the way the sidebar does.
 *
 * The chip beside it is not decoration and not a duplicate of the select's own
 * value: a native option list is plain text, so it cannot show the colour and
 * initials every other surface identifies a profile by — and it shows what the
 * browser is USING, which during the moment between picking and applying is not
 * yet what the select says.
 */
function switcherRow(): HTMLElement {
  const config = host.config();

  const select = el('select', { class: 'hero-select' }) as HTMLSelectElement;
  select.id = 'dash-switch';
  // Names only. The optgroup already says what kind a profile is, and the
  // closed select shows its chosen option verbatim — appending the subtitle put
  // "Work — 6 rules · default Direct" here, word for word what the card's own
  // heading says two inches away.
  select.append(el('option', { value: DIRECT }, 'Direct'));
  select.append(el('option', { value: SYSTEM }, 'System'));
  for (const [kind, label] of SWITCH_GROUPS) {
    const members = config.profiles.filter((p) => p.kind === kind);
    if (!members.length) continue;
    const group = el('optgroup', {}) as HTMLOptGroupElement;
    group.label = label;
    for (const p of members) group.append(el('option', { value: p.id }, p.name));
    select.append(group);
  }
  select.value = config.activeId;
  select.onchange = () => host.activate(select.value);

  const active = nodeInfo(config, config.activeId);
  return el(
    'div',
    { class: 'hero-switch' },
    el('label', { class: 'hero-switch-lbl', htmlFor: select.id }, 'Switch'),
    select,
    el(
      'div',
      { class: 'hero-active', title: active.sub },
      el('span', { class: 'hero-active-tag' }, 'Active'),
      tileFor(config, config.activeId, 20),
      el('span', { class: 'hero-active-name' }, active.name)
    )
  );
}

/** Who Chrome says owns the proxy — surfaced only when it is not us. */
let controlLevel = '';

function controlPill(): HTMLElement | null {
  if (controlLevel !== 'controlled_by_other_extensions' && controlLevel !== 'not_controllable') {
    return null;
  }
  const hostile = controlLevel === 'controlled_by_other_extensions';
  return el(
    'div',
    { class: 'hero-control' },
    el('span', { class: 'hero-control-ic', innerHTML: ICON.shield }),
    el(
      'span',
      {},
      hostile
        ? 'Another extension is controlling the proxy — Sockitt’s routes are not in force.'
        : 'Proxy settings are locked by policy on this machine.'
    ),
    hostile
      ? el(
          'button',
          {
            class: 'hero-btn',
            onclick: () => {
              // Re-applying is what takes control back; the worker does it on
              // any config write, and a rev bump is the cheapest honest one.
              host.save();
              toast('Reclaiming proxy control…');
            },
          },
          'Reclaim'
        )
      : null
  );
}

/* ---------------- stat strip ---------------- */

function statTile(opts: {
  label: string;
  figure: string;
  unit?: string;
  foot: string;
  visual?: Node | null;
  tone?: 'crit' | 'warn';
  onclick: () => void;
}): HTMLElement {
  const tile = el(
    'button',
    { class: `card dash-stat${opts.tone ? ' ' + opts.tone : ''}`, type: 'button', onclick: opts.onclick },
    el('span', { class: 'dash-stat-lbl' }, opts.label),
    el(
      'span',
      { class: 'dash-stat-fig' },
      opts.figure,
      opts.unit ? el('small', {}, opts.unit) : null
    ),
    opts.visual ?? el('span', { class: 'dash-stat-spacer' }),
    el('span', { class: 'dash-stat-foot' }, opts.foot)
  );
  return tile;
}

/** A proportional bar built from [flex, colour] pairs. */
function segments(parts: Array<[number, string]>): HTMLElement {
  const bar = el('span', { class: 'dash-seg' });
  for (const [weight, color] of parts) {
    if (weight <= 0) continue;
    const piece = el('i', {});
    piece.style.flex = String(weight);
    piece.style.background = color;
    bar.append(piece);
  }
  return bar;
}

function meter(fraction: number, color?: string): HTMLElement {
  const bar = el('span', { class: 'dash-meter' });
  const fill = el('i', {});
  fill.style.width = `${Math.min(100, Math.max(2, fraction * 100))}%`;
  if (color) fill.style.background = color;
  bar.append(fill);
  return bar;
}

/**
 * Errors bucketed over the session. Real time-series data — the log carries a
 * timestamp per entry and a repeat count — so this is a measurement, not a
 * decoration.
 */
function sparkline(log: ProxyErrorEntry[]): SVGElement {
  const W = 120;
  const H = 26;
  const BUCKETS = 16;
  const node = svg('svg', { class: 'dash-spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
  node.setAttribute('aria-hidden', 'true');
  if (!log.length) return node;

  const now = Date.now();
  const oldest = Math.min(...log.map((e) => e.at));
  const span = Math.max(now - oldest, 60_000);
  const counts = new Array<number>(BUCKETS).fill(0);
  for (const entry of log) {
    const idx = Math.min(BUCKETS - 1, Math.floor(((entry.at - oldest) / span) * BUCKETS));
    counts[idx] = (counts[idx] ?? 0) + entry.count;
  }
  const max = Math.max(...counts, 1);
  const step = W / (BUCKETS - 1);
  const points = counts.map((v, i) => [i * step, H - (v / max) * (H - 3) - 1] as const);

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const grad = svg('linearGradient', { id: 'dash-spark-g', x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.append(
    svg('stop', { offset: '0', 'stop-color': '#ef4d64', 'stop-opacity': '0.28' }),
    svg('stop', { offset: '1', 'stop-color': '#ef4d64', 'stop-opacity': '0' })
  );
  node.append(
    svg('defs', {}, grad),
    svg('path', { d: `${line} L${W},${H} L0,${H} Z`, fill: 'url(#dash-spark-g)' }),
    svg('path', {
      d: line,
      fill: 'none',
      stroke: '#ef4d64',
      'stroke-width': '1.6',
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    })
  );
  const last = points[points.length - 1];
  if (last) node.append(svg('circle', { cx: last[0].toFixed(1), cy: last[1].toFixed(1), r: '2.4', fill: '#ef4d64' }));
  return node;
}

/**
 * Bytes the config occupies in chrome.storage.sync, against the 100 KB quota.
 * -1 is "not measured yet", -2 is "the API would not say" (signed out, or sync
 * disabled by policy) — which must read differently from a pending measurement,
 * or the tile says "measuring…" for the rest of the session.
 */
let syncBytes = -1;
const SYNC_QUOTA = 102_400;
/** When the worker last handed settings to the browser. */
let appliedAt = 0;

function statStrip(): { node: HTMLElement; refresh: () => void } {
  const node = el('div', { class: 'dash-stats' });

  const refresh = (): void => {
    const config = host.config();
    const rules = ruleStats(config);
    const log = host.errorLog();
    const alert = host.alert();
    const report = auditConfig(config, { authGranted, now: Date.now() });

    // Written out rather than suffixed with "s" — "3 proxys", "2 switchs" and
    // "1 virtual" were what deriving them from the stored kind produced.
    const kinds: Array<[Profile['kind'], string, string, string]> = [
      ['proxy', '#46c9e5', 'proxy', 'proxies'],
      ['switch', '#2dd4a7', 'switch', 'switches'],
      ['rulelist', '#f472b6', 'list', 'lists'],
      ['virtual', '#ffb020', 'alias', 'aliases'],
    ];
    const byKind = kinds.map(
      ([kind, color]) => [config.profiles.filter((p) => p.kind === kind).length, color] as [number, string]
    );
    const kindFoot = kinds
      .map(([, , one, many], i) => [byKind[i]?.[0] ?? 0, one, many] as const)
      .filter(([n]) => n > 0)
      .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
      .join(' · ');

    const errorCount = log.reduce((sum, e) => sum + e.count, 0);
    const listed = listedEntryCount(config);

    node.replaceChildren(
      statTile({
        label: 'Profiles',
        figure: String(config.profiles.length),
        foot: kindFoot || 'none yet',
        visual: segments(byKind),
        onclick: () => host.open(config.profiles[0]?.id ?? '@settings'),
      }),
      statTile({
        label: 'Rules',
        figure: String(rules.total),
        unit: listed ? `+${listed.toLocaleString()} listed` : undefined,
        foot: rules.invalid
          ? `${rules.enabled} on · ${rules.invalid} invalid`
          : `${rules.enabled} on · ${rules.total - rules.enabled} off`,
        visual: segments([
          [rules.enabled, '#6d5dfc'],
          [rules.total - rules.enabled, 'rgba(20,26,44,.15)'],
        ]),
        tone: rules.invalid ? 'crit' : undefined,
        onclick: () => host.open('@inspect'),
      }),
      statTile({
        label: 'Errors this session',
        figure: String(errorCount),
        foot: alert
          ? `failing now · ${relativeTime(alert.lastAt)}`
          : log[0]
            ? `last ${relativeTime(log[0].lastAt)}`
            : 'nothing has failed',
        visual: log.length ? sparkline(log) : null,
        tone: alert ? 'crit' : undefined,
        onclick: () => host.open('@errors'),
      }),
      statTile({
        label: 'Sync',
        figure: config.settings.syncEnabled ? 'On' : 'Off',
        foot: !config.settings.syncEnabled
          ? 'this device only'
          : syncBytes >= 0
            ? `${(syncBytes / 1024).toFixed(1)} KB of 100 KB`
            : syncBytes === -1
              ? 'measuring…'
              : 'size unavailable',
        visual:
          config.settings.syncEnabled && syncBytes >= 0 ? meter(syncBytes / SYNC_QUOTA) : null,
        onclick: () => host.open('@settings'),
      }),
      statTile({
        label: 'Config health',
        figure: String(report.score),
        unit: '/100',
        foot: report.issues.length
          ? `${report.counts.error} error · ${report.counts.warn} warning · ${report.counts.info} note`
          : 'everything checks out',
        visual: segments([
          [report.counts.error * 3, '#ef4d64'],
          [report.counts.warn * 2, '#e6920a'],
          [report.counts.info, '#46c9e5'],
          [Math.max(1, report.score / 8), 'rgba(20,26,44,.10)'],
        ]),
        tone: report.counts.error ? 'crit' : report.counts.warn ? 'warn' : undefined,
        onclick: () => document.getElementById('dash-health')?.scrollIntoView({ block: 'center', behavior: motionOk() ? 'smooth' : 'auto' }),
      })
    );
  };

  return { node, refresh };
}

function motionOk(): boolean {
  return !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ---------------- routing map ---------------- */

const NODE_W = 190;
const NODE_H = 46;
const GAP_X = 82;
const GAP_Y = 16;
/** Space a node's two text lines have: box width, less the tile and the padding. */
const NODE_TEXT_W = NODE_W - 40 - 10;

/**
 * Ellipsise to fit. SVG text neither wraps nor clips to its parent, so a long
 * endpoint ("HTTPS proxy.fra.example:8443") runs straight out of its box and
 * across whatever is beside it. Measured by average advance rather than by
 * getComputedTextLength, which needs the node to be in the document — these are
 * built before the panel is mounted.
 */
function fitText(text: string, perChar: number): string {
  const max = Math.floor(NODE_TEXT_W / perChar);
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Distance from a profile to a terminal, following its targets. Proxies and the
 * built-ins are 0; everything else is one more than the deepest thing it can
 * reach. The visiting set makes a cycle terminate rather than recurse forever —
 * the compiler guards the same way, so a looped config still draws.
 */
function depthOf(config: Config, id: string, visiting = new Set<string>()): number {
  if (id === DIRECT || id === SYSTEM || visiting.has(id)) return 0;
  const p = profileById(config, id);
  if (!p || p.kind === 'proxy') return 0;
  visiting.add(id);
  const targets = referencedTargets(p);
  let deepest = 0;
  for (const t of targets) deepest = Math.max(deepest, depthOf(config, t, visiting));
  visiting.delete(id);
  return deepest + 1;
}

function routingMap(): { node: HTMLElement; refresh: () => void } {
  const holder = el('div', { class: 'dash-map-wrap' });
  // The hover hint rides the eyebrow, not the legend: as a fourth legend item
  // it wrapped to a line of its own on every width the card actually gets.
  const node = card(
    'dash-c7',
    cardHead('Routing map', 'hover a line or a profile'),
    holder,
    el('div', { class: 'dash-map-legend' })
  );

  const refresh = (): void => {
    const config = host.config();
    const legend = node.querySelector('.dash-map-legend')!;

    // Every node that takes part: all profiles, plus Direct if anything points
    // at it, plus whichever built-in is active.
    const ids = config.profiles.map((p) => p.id);
    const pointsAtDirect = config.profiles.some((p) => referencedTargets(p).includes(DIRECT));
    if (pointsAtDirect || config.activeId === DIRECT) ids.push(DIRECT);
    if (config.activeId === SYSTEM) ids.push(SYSTEM);

    if (ids.length < 2) {
      holder.replaceChildren(
        el(
          'p',
          { class: 'dash-empty' },
          'The map draws itself once profiles point at each other — add an Auto switch profile and give it a rule.'
        )
      );
      legend.replaceChildren();
      return;
    }

    const maxDepth = Math.max(...ids.map((id) => depthOf(config, id)));
    const columns = new Map<number, string[]>();
    for (const id of ids) {
      const col = maxDepth - depthOf(config, id);
      const list = columns.get(col) ?? [];
      list.push(id);
      columns.set(col, list);
    }

    const pos = new Map<string, { x: number; y: number }>();
    let rows = 0;
    for (const [col, list] of columns) {
      list.forEach((id, row) => {
        pos.set(id, { x: col * (NODE_W + GAP_X), y: row * (NODE_H + GAP_Y) });
      });
      rows = Math.max(rows, list.length);
    }

    const width = (maxDepth + 1) * NODE_W + maxDepth * GAP_X;
    const height = rows * NODE_H + (rows - 1) * GAP_Y;
    const live = livePath(config, config.activeId);

    const sheet = svg('svg', {
      class: 'dash-map',
      viewBox: `-2 -2 ${width + 4} ${height + 4}`,
      role: 'img',
      'aria-label': 'How your profiles route into each other',
    });

    const defs = svg('defs', {});
    const hot = svg('linearGradient', { id: 'dash-edge-hot', x1: '0', y1: '0', x2: '1', y2: '0' });
    hot.append(
      svg('stop', { offset: '0', 'stop-color': '#6d5dfc' }),
      svg('stop', { offset: '1', 'stop-color': '#46c9e5' })
    );
    defs.append(hot);
    sheet.append(defs);

    // Edges first so nodes paint over their endpoints.
    const edgeNodes: SVGPathElement[] = [];
    for (const p of config.profiles) {
      const from = pos.get(p.id);
      if (!from) continue;
      // Collapse repeated targets: eleven rules pointing at one proxy is one
      // edge labelled "11 rules", not eleven overlapping curves.
      const tally = new Map<string, number>();
      const conditional = new Set<string>();
      // Targets reached when nothing matches. Tracked apart from the rule count
      // because a target can be both — "6 rules · default" is the honest label,
      // and picking one of the two would misdescribe the edge.
      const fallback = new Set<string>();
      if (p.kind === 'switch') {
        for (const rule of p.rules) {
          if (!rule.enabled) continue;
          tally.set(rule.targetId, (tally.get(rule.targetId) ?? 0) + 1);
          conditional.add(rule.targetId);
        }
        tally.set(p.defaultTargetId, tally.get(p.defaultTargetId) ?? 0);
        fallback.add(p.defaultTargetId);
      } else if (p.kind === 'rulelist') {
        tally.set(p.matchTargetId, 0);
        conditional.add(p.matchTargetId);
        tally.set(p.defaultTargetId, tally.get(p.defaultTargetId) ?? 0);
        fallback.add(p.defaultTargetId);
      } else if (p.kind === 'virtual') {
        tally.set(p.targetId, 0);
      }

      for (const [targetId, count] of tally) {
        const to = pos.get(targetId);
        if (!to) continue;
        const x1 = from.x + NODE_W;
        const y1 = from.y + NODE_H / 2;
        const x2 = to.x;
        const y2 = to.y + NODE_H / 2;
        const mx = (x1 + x2) / 2;
        const isLive = live.has(p.id) && live.has(targetId);
        const path = svg('path', {
          class: `dash-edge${isLive ? ' live' : ''}`,
          d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
          stroke: isLive ? 'url(#dash-edge-hot)' : '#a8adbd',
        });
        // Dashed means "only sometimes". An edge that is also the fallback is
        // always taken when nothing else matches, so it draws solid.
        if (conditional.has(targetId) && !fallback.has(targetId)) {
          path.setAttribute('stroke-dasharray', '5 4');
        }
        path.dataset.from = p.id;
        path.dataset.to = targetId;

        // What this edge is, on the edge itself rather than beside it. Drawn
        // labels were tried and removed: a profile's edges fan out to targets
        // that other profiles also point at, so the text stacked no matter
        // where along the curve it was anchored, and the map — whose whole job
        // is to be read at a glance — became the busiest thing on the page.
        // The shape already carries the important half (solid vs dashed), and
        // the count is a hover away.
        const parts: string[] = [];
        if (p.kind === 'virtual') parts.push('alias');
        if (count > 0) parts.push(`${count} rule${count === 1 ? '' : 's'}`);
        if (p.kind === 'rulelist' && conditional.has(targetId)) parts.push('match');
        if (fallback.has(targetId)) parts.push('default');
        path.append(
          svg('title', {}, `${p.name} → ${nameOf(config, targetId)}${parts.length ? ` (${parts.join(' · ')})` : ''}`)
        );

        sheet.append(path);
        edgeNodes.push(path);
      }
    }

    const nodeGroups: SVGGElement[] = [];
    for (const id of ids) {
      const at = pos.get(id);
      if (!at) continue;
      const info = nodeInfo(config, id);
      const isLive = live.has(id);
      const group = svg('g', {
        class: `dash-node${id === config.activeId ? ' active' : ''}${isLive ? '' : ' faded'}`,
        tabindex: '0',
        role: 'button',
        'aria-label': `${info.name} — ${info.sub}`,
      });
      group.dataset.id = id;
      group.append(
        svg('rect', { class: 'bx', x: at.x, y: at.y, width: NODE_W, height: NODE_H, rx: '11' }),
        svg('rect', { x: at.x + 11, y: at.y + 13, width: 20, height: 20, rx: '5', fill: info.color }),
        svg(
          'text',
          {
            x: at.x + 21,
            y: at.y + 27,
            'text-anchor': 'middle',
            'font-size': '8.5',
            'font-weight': '700',
            fill: info.builtin ? '#f2f4f9' : textColorFor(info.color),
          },
          info.initials
        ),
        // 6.3 and 5.7 are the measured average advances of the two type styles
        // this card uses (11.5px bold sans, 9.5px mono).
        svg('text', { class: 't1', x: at.x + 40, y: at.y + 21 }, fitText(info.name, 6.3)),
        svg('text', { class: 't2', x: at.x + 40, y: at.y + 34 }, fitText(info.sub, 5.7))
      );
      group.append(svg('title', {}, `${info.name} — ${info.sub}`));

      const focusOn = (): void => {
        for (const edge of edgeNodes) {
          const related = edge.dataset.from === id || edge.dataset.to === id;
          edge.classList.toggle('muted', !related);
        }
        for (const other of nodeGroups) {
          const oid = other.dataset.id;
          const related =
            oid === id ||
            edgeNodes.some(
              (e) =>
                (e.dataset.from === id && e.dataset.to === oid) ||
                (e.dataset.to === id && e.dataset.from === oid)
            );
          other.classList.toggle('muted', !related);
        }
      };
      const focusOff = (): void => {
        for (const edge of edgeNodes) edge.classList.remove('muted');
        for (const other of nodeGroups) other.classList.remove('muted');
      };
      group.addEventListener('mouseenter', focusOn);
      group.addEventListener('focus', focusOn);
      group.addEventListener('mouseleave', focusOff);
      group.addEventListener('blur', focusOff);
      const activate = (): void => {
        if (id !== DIRECT && id !== SYSTEM) host.open(id);
      };
      group.addEventListener('click', activate);
      group.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      });

      sheet.append(group);
      nodeGroups.push(group);
    }

    holder.replaceChildren(sheet);
    legend.replaceChildren(
      el('span', {}, el('b', {}, 'Solid'), ' unconditional'),
      el('span', {}, el('b', {}, 'Dashed'), ' decided per request'),
      el('span', {}, el('b', {}, 'Colour'), ' the path traffic takes right now')
    );

    if (motionOk()) {
      edgeNodes.forEach((path, i) => {
        if (path.hasAttribute('stroke-dasharray')) return;
        const len = path.getTotalLength();
        path.animate(
          [
            { strokeDasharray: `${len}`, strokeDashoffset: `${len}` },
            { strokeDasharray: `${len}`, strokeDashoffset: '0' },
          ],
          { duration: 520, delay: 60 * i, easing: 'cubic-bezier(.4,0,.2,1)' }
        );
      });
    }
  };

  return { node, refresh };
}

/* ---------------- config health ---------------- */

let authGranted = false;

function healthCard(): { node: HTMLElement; refresh: () => void } {
  const node = card('dash-c5', cardHead('Config health'));
  node.id = 'dash-health';

  const refresh = (): void => {
    const config = host.config();
    const report = auditConfig(config, { authGranted, now: Date.now() });

    const CIRC = 2 * Math.PI * 33;
    const arc = svg('circle', {
      cx: '39',
      cy: '39',
      r: '33',
      fill: 'none',
      stroke: 'url(#dash-ring)',
      'stroke-width': '9',
      'stroke-linecap': 'round',
      'stroke-dasharray': CIRC.toFixed(1),
      'stroke-dashoffset': (CIRC * (1 - report.score / 100)).toFixed(1),
    });
    const grad = svg('linearGradient', { id: 'dash-ring', x1: '0', y1: '0', x2: '1', y2: '1' });
    grad.append(
      svg('stop', { offset: '0', 'stop-color': '#6d5dfc' }),
      svg('stop', { offset: '1', 'stop-color': '#46c9e5' })
    );
    const ring = svg('svg', { width: '78', height: '78', viewBox: '0 0 78 78' });
    ring.setAttribute('aria-hidden', 'true');
    ring.append(
      svg('defs', {}, grad),
      svg('circle', { cx: '39', cy: '39', r: '33', fill: 'none', stroke: 'rgba(20,26,44,.09)', 'stroke-width': '9' }),
      arc
    );
    if (motionOk()) {
      arc.animate(
        [{ strokeDashoffset: `${CIRC}` }, { strokeDashoffset: arc.getAttribute('stroke-dashoffset')! }],
        { duration: 800, easing: 'cubic-bezier(.4,0,.2,1)' }
      );
    }

    const summary = report.issues.length
      ? `${report.issues.length} thing${report.issues.length === 1 ? '' : 's'} to look at`
      : 'Nothing to fix';
    const detail = report.issues.length
      ? report.issues[0]!.title
      : 'Every profile compiles, every rule can run, and every list is current.';

    const children: Node[] = [
      cardHead('Config health'),
      el(
        'div',
        { class: 'dash-health-top' },
        el('div', { class: 'dash-ring' }, ring, el('span', { class: 'dash-ring-val' }, String(report.score))),
        el(
          'div',
          { class: 'dash-health-sum' },
          el('div', { class: 'dash-health-t' }, summary),
          el('div', { class: 'dash-health-s' }, detail)
        )
      ),
    ];
    if (report.issues.length) {
      children.push(el('div', { class: 'dash-issues' }, ...report.issues.map(issueRow)));
    }
    node.replaceChildren(...children);
  };

  return { node, refresh };
}

function issueRow(issue: HealthIssue): HTMLElement {
  const level = issue.level === 'error' ? 'crit' : issue.level;
  const action = el(
    'button',
    { class: 'dash-mini', type: 'button', onclick: () => void applyFix(issue) },
    issue.fix.label
  );
  return el(
    'div',
    { class: `dash-issue ${level}` },
    el('span', { class: 'dash-issue-bar' }),
    el(
      'span',
      { class: 'dash-issue-txt' },
      el('b', {}, issue.title),
      issue.detail ? el('span', { class: 'dash-issue-detail' }, issue.detail) : null
    ),
    action
  );
}

async function applyFix(issue: HealthIssue): Promise<void> {
  const config = host.config();
  switch (issue.fix.kind) {
    case 'open':
      host.open(issue.profileId ?? '@settings');
      return;
    case 'grant-auth':
      if (await host.requestAuth()) {
        authGranted = true;
        toast('Authentication enabled');
        repaintDashboard();
      }
      return;
    case 'add-local-bypass': {
      const profile = issue.profileId ? profileById(config, issue.profileId) : undefined;
      if (!profile || profile.kind !== 'proxy') return;
      profile.bypass = ['<local>', ...profile.bypass];
      host.save();
      toast('Added <local> to the bypass list');
      return;
    }
    case 'update-list': {
      if (!issue.profileId) return;
      await host.refetchRuleList(issue.profileId);
      return;
    }
  }
}

/* ---------------- proxy servers ---------------- */

function serversCard(): { node: HTMLElement; refresh: () => void } {
  const node = card('dash-c7', cardHead('Proxy servers'));

  const refresh = (): void => {
    const config = host.config();
    const proxies = config.profiles.filter((p): p is ProxyProfile => p.kind === 'proxy');
    const lookupsOn = config.settings.exitIpCheck;

    if (!proxies.length) {
      node.replaceChildren(
        cardHead('Proxy servers'),
        el('p', { class: 'dash-empty' }, 'No proxy servers yet. Create one from the sidebar and it will appear here.')
      );
      return;
    }

    const testAll = el(
      'button',
      {
        class: 'dash-mini',
        type: 'button',
        disabled: !lookupsOn,
        title: lookupsOn
          ? 'Test each server in turn'
          : 'Turn on IP address lookups in Settings to test connections',
        onclick: () => void testSequentially(proxies),
      },
      'Test all'
    );

    node.replaceChildren(
      cardHead('Proxy servers', testAll),
      el('div', { class: 'dash-srv-list' }, ...proxies.map((p) => serverRow(p, lookupsOn)))
    );
  };

  return { node, refresh };
}

function serverRow(profile: ProxyProfile, lookupsOn: boolean): HTMLElement {
  // The classes and data-profile attribute are the ones watchProxyTests() in
  // options.ts already paints into, so a result lands here with no extra
  // listener — the same contract the proxy editor uses.
  const result = el('span', { class: 'test-result dash-srv-res', dataset: { profile: profile.id } });
  const button = el(
    'button',
    {
      class: 'dash-mini test-btn',
      type: 'button',
      disabled: !lookupsOn,
      dataset: { profile: profile.id },
      onclick: () => void requestTest(profile, result, button as HTMLButtonElement),
    },
    'Test'
  );
  return el(
    'div',
    { class: 'dash-srv' },
    avatarEl(profile, 22),
    el(
      'div',
      { class: 'dash-srv-id' },
      el('div', { class: 'dash-srv-nm' }, profile.name),
      el('div', { class: 'dash-srv-ep mono' }, `${SCHEME_LABELS[profile.scheme]} ${profile.host || '(no host)'}:${profile.port}`)
    ),
    result,
    button
  );
}

async function requestTest(
  profile: ProxyProfile,
  result: HTMLElement,
  button: HTMLButtonElement
): Promise<void> {
  const config = host.config();
  result.classList.remove('ok', 'bad');
  if (!config.settings.exitIpCheck) {
    result.textContent = 'Turn on IP address lookups in Settings.';
    return;
  }
  if (!(await host.requestExitIp())) {
    result.textContent = 'Needs access to ipconfig.is.';
    return;
  }
  button.disabled = true;
  result.textContent = 'Testing…';
  await chrome.storage.session.set({
    [TEST_KEY]: {
      profileId: profile.id,
      nonce: Date.now(),
      scheme: profile.scheme,
      host: profile.host,
      port: profile.port,
    },
  });
}

/**
 * Test All, one at a time. The worker refuses a concurrent test outright (it
 * owns the single proxy scope), so firing them together would produce one
 * result and a row of "another test is already running".
 */
async function testSequentially(proxies: ProxyProfile[]): Promise<void> {
  for (const profile of proxies) {
    const result = document.querySelector<HTMLElement>(
      `.dash-srv-res[data-profile="${CSS.escape(profile.id)}"]`
    );
    const button = document.querySelector<HTMLButtonElement>(
      `.test-btn[data-profile="${CSS.escape(profile.id)}"]`
    );
    if (!result || !button) continue;
    await requestTest(profile, result, button);
    // Wait for this one's verdict before starting the next. The worker's own
    // timeout is 8 s and the restore adds a little; 14 s is the giving-up point.
    await waitForResult(profile.id, 14_000);
  }
}

function waitForResult(profileId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      chrome.storage.onChanged.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ): void => {
      if (area !== 'session' || !changes[TEST_RESULT_KEY]) return;
      const value = changes[TEST_RESULT_KEY].newValue as { profileId?: string } | undefined;
      if (value?.profileId === profileId) done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.storage.onChanged.addListener(listener);
  });
}

/* ---------------- where your tabs go ---------------- */

/**
 * Own sequence, NOT the panel's `generation`: this card re-queries on every
 * repaint, and bumping the shared counter would invalidate the panel's own
 * deferred reads (the sync measurement, the permission check) every few seconds.
 */
let tabsSeq = 0;

function tabsCard(): { node: HTMLElement; refresh: () => void } {
  const node = card('dash-c5', cardHead('Where your tabs go'));

  const refresh = (): void => {
    const mine = ++tabsSeq;
    void (async () => {
      const granted = await chrome.permissions.contains(TABS_PERMS).catch(() => false);
      if (mine !== tabsSeq || !root?.isConnected) return;
      if (!granted) {
        node.replaceChildren(
          cardHead('Where your tabs go'),
          el(
            'div',
            { class: 'dash-locked' },
            el('span', { class: 'dash-locked-ic', innerHTML: ICON.lock }),
            el('p', {}, el('b', {}, 'See where each open tab routes'), el('br', {}), 'Needs the optional “tabs” permission — the same one the per-tab badge uses. Sockitt reads tab URLs only to resolve them locally; nothing is stored or sent.'),
            el(
              'button',
              {
                class: 'dash-mini',
                type: 'button',
                onclick: async () => {
                  const ok = await chrome.permissions.request(TABS_PERMS).catch(() => false);
                  if (ok) repaintDashboard();
                  else toast('Permission declined');
                },
              },
              'Grant access'
            )
          )
        );
        return;
      }

      const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
      if (mine !== tabsSeq || !root?.isConnected) return;
      const config = host.config();
      const active = profileById(config, config.activeId);

      const tally = new Map<string, number>();
      let counted = 0;
      for (const tab of tabs) {
        const target = tabTarget(tab);
        if (!target) continue;
        counted++;
        let key = DIRECT;
        if (config.activeId === SYSTEM) {
          key = SYSTEM;
        } else if (active) {
          const route = resolveRoute(config, active, pacRequestUrl(target.url), target.host);
          key = route.bypassed ? DIRECT : route.targetId;
        }
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }

      if (mine !== tabsSeq || !root?.isConnected) return;
      node.replaceChildren(
        cardHead('Where your tabs go', `${counted} tab${counted === 1 ? '' : 's'}`),
        counted === 0
          ? el('p', { class: 'dash-empty' }, 'No ordinary web pages are open — extension and settings tabs are not routed.')
          : donut(config, tally, counted)
      );
    })();
  };

  return { node, refresh };
}

function donut(config: Config, tally: Map<string, number>, total: number): HTMLElement {
  const entries = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const R = 40;
  const CIRC = 2 * Math.PI * R;
  const ring = svg('svg', { width: '108', height: '108', viewBox: '0 0 108 108' });
  ring.setAttribute('aria-hidden', 'true');

  let offset = 0;
  for (const [id, count] of entries) {
    const info = nodeInfo(config, id);
    const fraction = count / total;
    // A 2.5px gap between arcs; without it two adjacent segments of similar
    // colour read as one.
    const arc = Math.max(0, fraction * CIRC - 2.5);
    ring.append(
      svg('circle', {
        cx: '54',
        cy: '54',
        r: String(R),
        fill: 'none',
        stroke: info.color,
        'stroke-width': '15',
        'stroke-dasharray': `${arc.toFixed(2)} ${(CIRC - arc).toFixed(2)}`,
        'stroke-dashoffset': (-offset * CIRC).toFixed(2),
      })
    );
    offset += fraction;
  }

  return el(
    'div',
    { class: 'dash-donut-row' },
    el(
      'div',
      { class: 'dash-donut' },
      ring,
      el(
        'div',
        { class: 'dash-donut-mid' },
        el('b', {}, String(total)),
        el('span', {}, total === 1 ? 'tab' : 'tabs')
      )
    ),
    el(
      'div',
      { class: 'dash-legend' },
      ...entries.map(([id, count]) => {
        const info = nodeInfo(config, id);
        const swatch = el('i', {});
        swatch.style.background = info.color;
        return el(
          'div',
          { class: 'dash-legend-li' },
          swatch,
          el('span', { class: 'dash-legend-n' }, info.name),
          el('span', { class: 'dash-legend-v' }, `${count} · ${Math.round((count / total) * 100)}%`)
        );
      })
    )
  );
}

/* ---------------- session timeline ---------------- */

let history: ActivationEntry[] = [];

function timelineCard(): { node: HTMLElement; refresh: () => void } {
  const node = card('dash-c12', cardHead('This session'));

  const refresh = (): void => {
    const config = host.config();
    const log = host.errorLog();
    const now = Date.now();

    if (history.length === 0) {
      node.replaceChildren(
        cardHead('This session'),
        el(
          'p',
          { class: 'dash-empty' },
          'The timeline fills in as you switch profiles. It is session-scoped — it starts fresh with the browser.'
        )
      );
      return;
    }

    const start = history[0]!.at;
    const span = Math.max(now - start, 60_000);
    const bar = el('div', { class: 'dash-tl' });
    history.forEach((entry, i) => {
      const until = history[i + 1]?.at ?? now;
      const info = nodeInfo(config, entry.id);
      const seg = el('i', {
        title: `${info.name} — ${new Date(entry.at).toLocaleTimeString()} to ${
          i === history.length - 1 ? 'now' : new Date(until).toLocaleTimeString()
        }`,
      });
      seg.style.flex = String(Math.max(until - entry.at, span / 200));
      seg.style.background = info.color;
      bar.append(seg);
    });

    const marks = el('div', { class: 'dash-tl-marks' });
    for (const entry of log) {
      if (entry.at < start) continue;
      const mark = el('i', { title: `${errorHeadline(entry)} — ${new Date(entry.at).toLocaleTimeString()}` });
      mark.style.left = `${(((entry.at - start) / span) * 100).toFixed(2)}%`;
      marks.append(mark);
    }

    node.replaceChildren(
      cardHead('This session', `since ${new Date(start).toLocaleTimeString()}`),
      bar,
      marks,
      el(
        'div',
        { class: 'dash-tl-axis' },
        el('span', {}, new Date(start).toLocaleTimeString()),
        el('span', {}, `${history.length} switch${history.length === 1 ? '' : 'es'}`),
        el('span', {}, 'now')
      )
    );
  };

  return { node, refresh };
}

/* ---------------- rule lists ---------------- */

function ruleListsCard(): { node: HTMLElement; refresh: () => void } {
  const node = card('dash-c6', cardHead('Rule lists'));

  const refresh = (): void => {
    const config = host.config();
    const lists = config.profiles.filter((p) => p.kind === 'rulelist');
    if (!lists.length) {
      node.replaceChildren(
        cardHead('Rule lists'),
        el(
          'p',
          { class: 'dash-empty' },
          'No rule lists. They route by a published domain list — AutoProxy/GFWList, or one domain per line.'
        )
      );
      return;
    }

    const rows = el('div', { class: 'dash-rl-list' });
    for (const list of lists) {
      if (list.kind !== 'rulelist') continue;
      const parsed = parseRuleList(list.format, list.text);
      const age = list.lastUpdated ? Date.now() - list.lastUpdated : null;
      const intervalMs = list.updateIntervalH * 3_600_000;
      // How far through its refresh window this list is. Over 1 means overdue.
      const wear = age !== null && intervalMs > 0 ? age / intervalMs : 0;
      const stale = wear > 1;

      const sub = el(
        'div',
        { class: `dash-rl-sub${stale ? ' stale' : ''}` },
        `${parsed.count.toLocaleString()} entries · ${
          list.lastUpdated ? `fetched ${relativeTime(list.lastUpdated)}` : 'never fetched'
        }${list.updateIntervalH > 0 ? ` · every ${list.updateIntervalH} h` : ' · auto-update off'}`
      );

      const fill = el('i', {});
      fill.style.width = `${Math.min(100, Math.max(3, wear * 100))}%`;
      fill.style.background = stale ? 'var(--amber)' : 'var(--ok)';

      const button = el(
        'button',
        {
          class: 'dash-mini',
          type: 'button',
          disabled: !list.url,
          title: list.url ? `Fetch ${list.url}` : 'This list has no URL — paste its content in the editor',
          onclick: async () => {
            (button as HTMLButtonElement).disabled = true;
            button.textContent = 'Fetching…';
            await host.refetchRuleList(list.id);
          },
        },
        'Fetch now'
      );

      rows.append(
        el(
          'div',
          { class: 'dash-rl' },
          avatarEl(list, 22),
          el(
            'div',
            { class: 'dash-rl-id' },
            el('div', { class: 'dash-rl-nm' }, list.name),
            sub,
            list.updateIntervalH > 0 ? el('div', { class: 'dash-freshbar' }, fill) : null
          ),
          button
        )
      );
    }

    node.replaceChildren(cardHead('Rule lists'), rows);
  };

  return { node, refresh };
}

/* ---------------- inline route tester ---------------- */

function testerCard(): { node: HTMLElement; refresh: () => void } {
  const input = el('input', {
    class: 'input mono',
    value: 'https://example.com/',
    spellcheck: false,
    ariaLabel: 'URL to resolve',
  }) as HTMLInputElement;
  const verdict = el('div', { class: 'dash-verdict' });

  const run = (): void => {
    const config = host.config();
    const raw = input.value.trim();
    if (!raw) {
      verdict.replaceChildren(el('span', { class: 'note' }, 'Type a URL or a hostname.'));
      return;
    }
    let url: URL;
    try {
      url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      verdict.replaceChildren(el('span', { class: 'note error' }, 'That is not a URL Sockitt can parse.'));
      return;
    }

    const active = profileById(config, config.activeId);
    if (!active) {
      verdict.replaceChildren(
        el(
          'span',
          { class: 'note' },
          config.activeId === SYSTEM
            ? 'A System profile is active — your operating system decides, and Sockitt cannot see its rules.'
            : 'Direct is active, so every request goes straight out.'
        )
      );
      return;
    }

    const route = resolveRoute(config, active, pacRequestUrl(url.href), url.hostname);
    const target = route.bypassed ? DIRECT : route.targetId;
    const info = nodeInfo(config, target);
    // The reason has to fit the profile that produced it: "no rule matched" is
    // nonsense from a plain proxy, which has no rules to match.
    const why = route.bypassed
      ? 'the bypass list sends it direct'
      : route.ruleId
        ? 'matched a rule'
        : active.kind === 'proxy'
          ? 'everything routes through this proxy'
          : active.kind === 'virtual'
            ? 'alias'
            : 'nothing matched — the default target';
    verdict.replaceChildren(
      el('span', { class: 'chain-chip' }, tileFor(config, config.activeId, 18), nodeInfo(config, config.activeId).name),
      el('span', { class: 'dash-arrow' }, why),
      el('span', { class: 'chain-chip' }, tileFor(config, target, 18), info.name)
    );
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run();
  });

  const node = card(
    'dash-c6',
    cardHead('Try a URL'),
    el(
      'div',
      { class: 'dash-tester' },
      input,
      el('button', { class: 'btn primary', type: 'button', onclick: run }, 'Resolve')
    ),
    verdict,
    el(
      'p',
      { class: 'note' },
      'Resolved locally by the same matcher the generated routing script uses — no request is made. ',
      el(
        'button',
        { class: 'linklike', type: 'button', onclick: () => host.open('@inspect') },
        'Open the full inspector'
      ),
      ' for the step-by-step trace.'
    )
  );

  run();
  // Deliberately not repainted: this card holds the one text field on the page,
  // and a storage event must never take a half-typed URL away.
  return { node, refresh: () => undefined };
}

/* ---------------- panel ---------------- */

export function dashboardPanel(h: DashboardHost): HTMLElement {
  host = h;
  generation++;
  refreshers = [];

  const cards = [
    heroCard(),
    statStrip(),
    routingMap(),
    healthCard(),
    serversCard(),
    tabsCard(),
    timelineCard(),
    ruleListsCard(),
    testerCard(),
  ];

  const bento = el('div', { class: 'dash-bento' }, ...cards.map((c) => c.node));
  refreshers = cards.map((c) => c.refresh);

  const headSub = el('span', { class: 'dash-head-sub' });
  const panel = el(
    'div',
    { class: 'pane dash' },
    el('div', { class: 'dash-head' }, el('h2', { class: 'dash-title' }, 'Overview'), headSub),
    bento
  );
  root = panel;

  // The head line rides the refresh list so it ages with everything else on the
  // 30-second tick, rather than freezing at whatever it said on first paint.
  refreshers.push(() => {
    headSub.textContent = appliedAt ? `Route applied ${relativeTime(appliedAt)}` : '';
  });

  for (const refresh of refreshers) refresh();

  // Deferred reads: each fills in and repaints when it lands, so first paint is
  // never held up by a permission check or a storage measurement.
  const mine = generation;
  void (async () => {
    const [granted, session, log] = await Promise.all([
      chrome.permissions.contains(AUTH_PERMS).catch(() => false),
      chrome.storage.session
        .get([CONTROL_KEY, APPLIED_KEY])
        .catch(() => ({}) as Record<string, unknown>),
      loadHistory(),
    ]);
    if (mine !== generation || !root?.isConnected) return;
    authGranted = granted;
    const store = session as Record<string, { level?: unknown; at?: unknown; activeId?: unknown }>;
    const level = store[CONTROL_KEY]?.level;
    controlLevel = typeof level === 'string' ? level : '';
    const at = store[APPLIED_KEY]?.at;
    if (typeof at === 'number') appliedAt = at;
    const forId = store[APPLIED_KEY]?.activeId;
    if (typeof forId === 'string') exitForId = forId;
    history = log;
    repaintDashboard();
  })();

  void measureSync();
  void runExitCheck();

  clearInterval(relTimer);
  relTimer = setInterval(() => {
    if (root?.isConnected) repaintDashboard();
    else clearInterval(relTimer);
  }, REL_TICK_MS);

  return panel;
}

async function measureSync(): Promise<void> {
  const mine = generation;
  try {
    const bytes = await chrome.storage.sync.getBytesInUse(null);
    if (mine !== generation || !root?.isConnected) return;
    syncBytes = bytes;
    repaintDashboard();
  } catch {
    // sync unavailable (signed out, or disabled by policy) — the tile says so
    // rather than claiming zero bytes or measuring forever.
    syncBytes = -2;
    repaintDashboard();
  }
}

/**
 * Repaint every card in place. Safe to call from any storage listener: no card
 * except the tester holds user input, and the tester opts out.
 */
export function repaintDashboard(): void {
  if (!root?.isConnected) return;
  for (const refresh of refreshers) refresh();
}

/** True when the dashboard is the mounted page. */
export function dashboardMounted(): boolean {
  return Boolean(root?.isConnected);
}

/** Adopt a control-level change pushed by the worker. */
export function setControlLevel(level: string): void {
  if (level === controlLevel) return;
  controlLevel = level;
  repaintDashboard();
}

/** Adopt a fresh activation history (the worker appends to it). */
export function setHistory(entries: ActivationEntry[]): void {
  history = entries;
  repaintDashboard();
}

/**
 * The worker applied a route.
 *
 * Re-measures the exit only when the destination actually changed: the worker
 * re-applies on every rule edit and every permission grant too, and firing an
 * ipconfig.is lookup at each of those would turn an options tab left open into
 * a steady trickle of requests to a third party — not the deal this extension
 * makes anywhere else.
 */
export function setApplied(activeId: string, at: number): void {
  appliedAt = at;
  if (activeId === exitForId && (exitInfo || exitBusy)) {
    repaintDashboard();
    return;
  }
  exitForId = activeId;
  exitInfo = null;
  exitError = null;
  void runExitCheck(true);
}
