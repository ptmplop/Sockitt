import { avatarEl, builtinTile } from '../shared/avatar';
import { BUILTIN_FILL, paintRoute } from '../shared/colour';
import { EXIT_IP_PERMS, EXIT_IP_URL, ExitInfo, checkExitIp, flagSrc } from '../shared/exitip';
import { HealthIssue, auditConfig } from '../shared/health';
import { ProxyAlert, ProxyErrorEntry, errorHeadline } from '../shared/errors';
import { hostLooksReal, pacRequestUrl, resolveRoute } from '../shared/match';
import { parseRuleList } from '../shared/rulelist';
import {
  APPLIED_KEY,
  ActivationEntry,
  CONTROL_KEY,
  TEST_KEY,
  TEST_RESULT_KEY,
  loadHistory,
  loadTempRules,
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
  SwitchRule,
  TABS_PERMS,
  profileById,
} from '../shared/types';
import { el, icon, relativeTime, toast } from '../shared/ui';
import { FULL, RULE_LABEL, YardLayout, YardTrace, colourOf, layoutYard, traceYard } from '../shared/yard';
import { yardSvg } from './yardview';

/**
 * The Overview — the options tab's landing page.
 *
 * It answers one question first, the way the track map draws it: where is
 * traffic going right now? The active profile at display size; under it the
 * map of how that profile routes, with a field to trace any URL along it and,
 * at the end of each line, the destination with its open tabs, its latency and
 * — for the route ipconfig.is itself takes — the exit address. Below the map,
 * what needs attention and what this session has done.
 *
 * Everything here is derived: the page owns no state of its own and writes
 * nothing except through the host callbacks, which is what lets it be
 * repainted wholesale from any storage event. The one exception is the trace
 * field, which is never rebuilt, so a storage event cannot take a half-typed
 * URL away.
 */
export interface DashboardHost {
  /** The page's live config snapshot. A getter: a captured object would go stale. */
  config: () => Config;
  alert: () => ProxyAlert | null;
  errorLog: () => ProxyErrorEntry[];
  /** Select a profile editor or one of the extension pages. */
  open: (id: string) => void;
  /** Make a profile active. */
  activate: (id: string) => void;
  /** Persist a config mutation made from here. */
  save: () => void;
  /** Create a proxy profile and open its editor. */
  createProxy: () => void;
  /** Request the optional proxy-auth permissions; resolves true when granted. */
  requestAuth: () => Promise<boolean>;
  /** Request the ipconfig.is origin; resolves true when granted. */
  requestExitIp: () => Promise<boolean>;
  /** Refetch a rule list by id (shared with the rule-list editor). */
  refetchRuleList: (profileId: string) => Promise<void>;
  /** Open the inspector with a URL already in it. */
  inspect: (url: string) => void;
  /** Settings that are on but inert until the user acts — listed under Needs attention. */
  asks: () => PermAsk[];
}

/**
 * A setting that is switched on but cannot work until the user does something
 * — a grant only they can give, or a step no extension API can take. options.ts
 * finds them; the Overview and Settings list them.
 */
export interface PermAsk {
  id: string;
  tone: 'warn' | 'info';
  /** A theme.css icon name. */
  icon: string;
  title: string;
  body: string;
  action?: { label: string; run: () => void };
}

export function askRow(ask: PermAsk): HTMLElement {
  return el(
    'li',
    { class: `todo-${ask.tone}` },
    icon(ask.icon),
    el('div', {}, el('h3', {}, ask.title), el('p', {}, ask.body)),
    ask.action ? el('button', { class: 'btn sm', type: 'button', onclick: ask.action.run }, ask.action.label) : el('span')
  );
}

let host: DashboardHost;
let root: HTMLElement | null = null;
/** One repaint function per section, and the node each repaints. */
let refreshers: Array<() => void> = [];
let sectionNodes: Array<HTMLElement | null> = [];
/** Bumped per build, so a late async answer cannot paint into a detached tree. */
let generation = 0;

/* exit lookup — cached so a repaint does not re-run it */
let exitInfo: ExitInfo | null = null;
let exitError: string | null = null;
let exitAt = 0;
let exitBusy = false;
let exitSeq = 0;
let exitStartedAt = 0;
let exitForId = '';

const REL_TICK_MS = 30_000;
let relTimer: ReturnType<typeof setInterval> | undefined;

/** Who Chrome says owns the proxy — surfaced only when it is not us. */
let controlLevel = '';
let authGranted = false;
let history: ActivationEntry[] = [];
let appliedAt = 0;
/** -1 not measured yet, -2 the API would not say. */
let syncBytes = -1;

/** The URL in the trace field. Module scope, so it survives every rebuild. */
let traceText = '';
/** Per-site overrides on the active profile (regular windows) — they are junction 0. */
let overrides: SwitchRule[] = [];

/** Tabs per destination on the map, by yard target id; null until counted or without access. */
let tally: Map<string, number> | null = null;
let tabsGranted: boolean | null = null;
let tabsSeq = 0;

/** The last connection test per proxy, so a verdict outlives the 30 s repaint. */
interface TestVerdict {
  ok: boolean;
  ip?: string;
  iso?: string;
  country?: string;
  ms?: number;
  error?: string;
  at: number;
}
const verdicts = new Map<string, TestVerdict>();
const testing = new Set<string>();
let verdictsWired = false;

/* ---------------- naming ---------------- */

function nameOf(config: Config, id: string): string {
  if (id === DIRECT) return 'Direct';
  if (id === SYSTEM) return 'System';
  return profileById(config, id)?.name ?? 'Unknown';
}

function ruleCount(n: number): string {
  return `${n} rule${n === 1 ? '' : 's'}`;
}

/** The line under the active profile's name: what kind of thing it is, in a sentence. */
function summaryOf(config: Config, id: string): Array<Node | string> {
  if (id === DIRECT) return ['No proxy — every request goes straight out'];
  if (id === SYSTEM) return ['Your operating system’s proxy settings decide'];
  const p = profileById(config, id);
  if (!p) return ['Unknown profile'];
  const dest = (target: string): HTMLElement =>
    paintRoute(el('b', { class: 'rname' }, nameOf(config, target)), colourOf(config, target));
  switch (p.kind) {
    case 'proxy':
      return [
        `${SCHEME_LABELS[p.scheme]} proxy · `,
        el('span', { class: 'mono' }, `${p.host || '(no host)'}:${p.port}`),
        p.bypass.length ? ` · bypasses ${p.bypass.length} entr${p.bypass.length === 1 ? 'y' : 'ies'}` : '',
      ];
    case 'switch': {
      const on = p.rules.filter((r) => r.enabled).length;
      return [
        `Auto switch · ${on === p.rules.length ? ruleCount(on) : `${on} of ${ruleCount(p.rules.length)} on`} · everything else goes `,
        dest(p.defaultTargetId),
      ];
    }
    case 'rulelist': {
      const n = parseRuleList(p.format, p.text).count;
      return [`Rule list · ${n.toLocaleString()} entr${n === 1 ? 'y' : 'ies'} · matches go `, dest(p.matchTargetId), ', the rest ', dest(p.defaultTargetId)];
    }
    case 'virtual':
      return ['Alias for ', dest(p.targetId)];
  }
}

/** "on since 12:22", from the activation history when it knows. */
function sinceLine(config: Config): string {
  const last = [...history].reverse().find((e) => e.id === config.activeId);
  if (last) return ` · on since ${new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return appliedAt ? ` · applied ${relativeTime(appliedAt)}` : '';
}

/* ---------------- the failure banner ---------------- */

function alertSection(): { node: HTMLElement; refresh: () => void } {
  const node = el('div', { class: 'ov-alerts' });
  const refresh = (): void => {
    const config = host.config();
    const alert = host.alert();
    const out: HTMLElement[] = [];
    if (alert) {
      const via = alert.via ? profileById(config, alert.via.id) : undefined;
      const title =
        alert.source === 'apply'
          ? 'Sockitt could not apply the proxy settings'
          : alert.via
            ? `${alert.via.name} is failing`
            : alert.candidates?.length
              ? `A proxy in ${alert.profileName} is failing`
              : 'Requests are failing at the proxy';
      const doubt =
        !alert.via && alert.candidates?.length
          ? ` ${alert.profileName} picks a server per request and Chrome does not say which one failed: ${alert.candidates.map((c) => c.name).join(' or ')}.`
          : '';
      out.push(
        el(
          'div',
          { class: 'callout bad', role: 'alert' },
          el(
            'div',
            {},
            el('h2', { class: 'callout-t' }, title),
            el(
              'p',
              {},
              `${alert.streak} request${alert.streak === 1 ? '' : 's'} failed, the last ${relativeTime(alert.lastAt)}, with `,
              el('span', { class: 'mono' }, errorHeadline(alert)),
              `.${doubt}`
            )
          ),
          el(
            'div',
            { class: 'acts' },
            via && via.kind === 'proxy'
              ? el('button', { class: 'btn', type: 'button', onclick: () => void requestTest(via) }, `Test ${via.name}`)
              : null,
            el('button', { class: 'btn primary', type: 'button', onclick: () => host.open('@errors') }, 'Open errors')
          )
        )
      );
    }
    if (controlLevel === 'controlled_by_other_extensions' || controlLevel === 'not_controllable') {
      const hostile = controlLevel === 'controlled_by_other_extensions';
      out.push(
        el(
          'div',
          { class: `callout${hostile ? ' bad' : ' info'}`, role: hostile ? 'alert' : undefined },
          el(
            'div',
            {},
            el('h2', { class: 'callout-t' }, hostile ? 'Another extension is controlling the proxy' : 'Proxy settings are locked by policy'),
            el(
              'p',
              {},
              hostile
                ? 'Chrome is applying another extension’s proxy settings, so none of the routes below are in force. Chrome gives the proxy to the most recently installed extension, and Sockitt can’t take it back. Turn that extension off, and Sockitt’s routes apply again on their own.'
                : 'This machine’s policy fixes the proxy settings; Sockitt can show its routes but cannot apply them.'
            )
          ),
          hostile
            ? el(
                'div',
                { class: 'acts' },
                // Chrome's own proxy setting names the extension in control and
                // has a Disable button — measured to hand the proxy straight
                // back. A link cannot open a chrome:// page; tabs.create can,
                // without the tabs permission.
                el(
                  'button',
                  {
                    class: 'btn primary',
                    type: 'button',
                    onclick: () => {
                      void chrome.tabs
                        .create({ url: 'chrome://settings/system' })
                        .catch(() => chrome.tabs.create({ url: 'chrome://extensions' }))
                        .catch(() => undefined);
                    },
                  },
                  'Show which extension'
                )
              )
            : null
        )
      );
    }
    node.replaceChildren(...out);
    node.hidden = out.length === 0;
  };
  return { node, refresh };
}

/* ---------------- the head: the active profile at display size ---------------- */

function headSection(): { node: HTMLElement; refresh: () => void } {
  const node = el('section', { class: 'ov-head' });
  const refresh = (): void => {
    const config = host.config();
    const id = config.activeId;
    node.replaceChildren(
      el('p', { class: 't-label' }, 'Routing now'),
      el('h1', { class: 't-display' }, nameOf(config, id)),
      el('p', { class: 'ov-sub' }, ...summaryOf(config, id), sinceLine(config))
    );
  };
  return { node, refresh };
}

/* ---------------- the trace field ---------------- */

/** Parse what was typed into the URL and host the resolver takes, or a reason it can't. */
function parseTrace(raw: string): { url: string; host: string; shown: string } | { error: string } | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (!hostLooksReal(u.hostname)) throw new Error('not a host');
    return { url: pacRequestUrl(u.href), host: u.hostname, shown: u.hostname };
  } catch {
    return { error: 'That isn’t a URL or a host name Sockitt can read.' };
  }
}

let traceOut: HTMLElement | null = null;

function traceSection(): HTMLElement {
  const input = el('input', {
    class: 'input mono',
    type: 'url',
    value: traceText,
    spellcheck: false,
    placeholder: 'Paste a URL to see which rule takes it',
    id: 'trace-url',
    oninput: () => {
      traceText = input.value;
      paintYard();
    },
  }) as HTMLInputElement;
  const clear = el('button', {
    class: 'trace-x',
    type: 'button',
    title: 'Clear',
    onclick: () => {
      input.value = '';
      traceText = '';
      paintYard();
      input.focus();
    },
  });
  clear.setAttribute('aria-label', 'Clear the URL');
  clear.append(icon('x', 'sm'));
  traceOut = el('p', { class: 'trace-out', role: 'status' });
  return el(
    'section',
    { class: 'trace', ariaLabel: 'Trace a URL' },
    el('label', { class: 't-label', htmlFor: 'trace-url' }, 'Trace a URL'),
    el('div', { class: 'search trace-in' }, input, clear),
    traceOut
  );
}

/** The sentence under the trace field, from what the map and the resolver say. */
function traceSentence(config: Config, layout: YardLayout, t: YardTrace, host_: string, url: string): Array<Node | string> {
  const active = profileById(config, config.activeId);
  const name = (id: string): HTMLElement =>
    paintRoute(el('b', { class: 'rname' }, nameOf(config, id)), colourOf(config, id));
  const hostNode = el('b', { class: 'mono host' }, host_);
  if (!active) {
    return config.activeId === SYSTEM
      ? [hostNode, ' goes wherever your operating system’s settings send it — Sockitt cannot see those rules.']
      : [hostNode, ' goes straight out: Direct is active.'];
  }
  // Where it finally lands, through any chain of profiles past this map.
  const route = resolveRoute(config, active, url, host_, overrides);
  const final = route.bypassed ? DIRECT : route.targetId;
  const onward: Array<Node | string> =
    final !== t.targetId && profileById(config, t.targetId)?.kind !== 'proxy'
      ? [', which sends it on to ', name(final)]
      : route.bypassed && t.targetId !== DIRECT
        ? [', whose bypass list sends it direct']
        : [];
  if (t.override) return [hostNode, ' has an override until the browser restarts, ahead of every rule, to ', name(t.targetId), ...onward, '.'];
  if (t.rule && t.ruleIndex !== null) {
    const skipped = layout.kind === 'switch' && t.ruleIndex > 0 ? ` Rules 1 to ${t.ruleIndex} don’t match it.` : '';
    return [hostNode, ` matches rule ${t.ruleIndex + 1}, `, el('span', { class: 'mono' }, t.rule.pattern), ', so it goes to ', name(t.targetId), ...onward, `.${skipped}`];
  }
  if (t.junctionKey === 'bypass') return [hostNode, ' is on the bypass list, so it goes ', name(DIRECT), '.'];
  if (t.junctionKey === 'list') return [hostNode, ' is on the list, so it goes to ', name(t.targetId), ...onward, '.'];
  if (layout.kind === 'switch') return [hostNode, ' matches no rule, so it takes the default, ', name(t.targetId), ...onward, '.'];
  if (layout.kind === 'rulelist') return [hostNode, ' is not on the list, so it goes to ', name(t.targetId), ...onward, '.'];
  return [hostNode, ' goes through ', name(t.targetId), ...onward, '.'];
}

/* ---------------- the map ---------------- */

let yardHolder: HTMLElement | null = null;

function yardSection(): { node: HTMLElement; refresh: () => void } {
  yardHolder = el('div', { class: 'yard' });
  const wrap = el('div', { class: 'yard-wrap' }, yardHolder);
  return { node: wrap, refresh: paintYard };
}

/** Repaint the map and the trace sentence. Cheap: called on every keystroke in the trace field. */
function paintYard(): void {
  if (!yardHolder || !root?.isConnected) return;
  const config = host.config();
  const layout = layoutYard(config, config.activeId, FULL, overrides);
  const parsed = parseTrace(traceText);
  let trace: YardTrace | null = null;
  if (parsed && 'url' in parsed) trace = traceYard(config, layout, parsed.url, parsed.host, overrides);

  if (traceOut) {
    if (!parsed) traceOut.replaceChildren('The map lights the path one request would take, rule by rule, without sending anything.');
    else if ('error' in parsed) traceOut.replaceChildren(parsed.error);
    else traceOut.replaceChildren(...traceSentence(config, layout, trace!, parsed.host, parsed.url));
  }

  const origin = parsed && 'url' in parsed
    ? { title: parsed.shown, sub: 'the traced URL', mono: true }
    : { title: 'All requests', sub: tally ? `${[...tally.values()].reduce((a, b) => a + b, 0)} open tabs` : 'from every tab' };

  const drawing = yardSvg({
    layout,
    trace,
    origin,
    ariaLabel: yardLabel(config, layout, trace),
  });
  yardHolder.replaceChildren(drawing, termini(config, layout, trace));
  shownLayout = layout;
}

/** The map last drawn, so the key under it explains only what is on it. */
let shownLayout: YardLayout | null = null;

/**
 * One profile's full map with one request lit — the Inspector's drawing. The
 * same map and the same line ends the Overview draws, for any profile.
 */
export function tracedYard(
  h: DashboardHost,
  startId: string,
  req: { url: string; host: string; shown: string } | null,
  temp: SwitchRule[]
): HTMLElement {
  host = h;
  const config = h.config();
  const layout = layoutYard(config, startId, FULL, temp);
  const trace = req ? traceYard(config, layout, req.url, req.host, temp) : null;
  const drawing = yardSvg({
    layout,
    trace,
    origin: req ? { title: req.shown, sub: 'the traced URL', mono: true } : { title: 'All requests', sub: `into ${nameOf(config, startId)}` },
    ariaLabel: yardLabel(config, layout, trace),
  });
  return el('div', { class: 'yard-wrap' }, el('div', { class: 'yard' }, drawing, termini(config, layout, trace, false)));
}

/** The map, said in words — for a screen reader, which the drawing gives nothing. */
function yardLabel(config: Config, layout: YardLayout, trace: YardTrace | null): string {
  const parts: string[] = [];
  if (layout.viaAlias) parts.push(`Through the alias ${layout.viaAlias}.`);
  for (const j of layout.junctions) {
    if (j.key === 'overrides') parts.push(`Overrides for ${j.fullText} go first.`);
    else if (j.key === 'bypass') parts.push(`Its bypass list (${j.fullText}) goes direct.`);
    else if (j.key === 'list') parts.push(`List matches go to ${j.targets.map((t) => nameOf(config, t)).join(', ') || nameOf(config, layout.defaultTarget)}.`);
    else parts.push(`Rule ${j.label}${j.off ? ' (off)' : ''}: ${j.fullText}${j.targets.length ? ` to ${j.targets.map((t) => nameOf(config, t)).join(', ')}` : ''}.`);
  }
  parts.push(`Everything else goes to ${nameOf(config, layout.defaultTarget)}.`);
  if (trace) parts.push(`The traced URL ends at ${nameOf(config, trace.targetId)}.`);
  return `Track map of ${nameOf(config, config.activeId)}. ${parts.join(' ')}`;
}

/** Where each line ends: the destination, its tabs, its test, its exit. */
/**
 * `live` is the Overview's map of what is routing now: tabs counted per line,
 * and the measured exit. The Inspector draws any profile, active or not, where
 * both would describe some other map's traffic.
 */
function termini(config: Config, layout: YardLayout, trace: YardTrace | null, live = true): HTMLElement {
  const list = el('ol', { class: 'termini', ariaLabel: 'Where each line ends' });
  list.style.height = `${layout.height}px`;
  const exitTarget = exitRouteTarget(config, layout);
  const alert = host.alert();
  for (const t of layout.tracks) {
    const p = profileById(config, t.id);
    const verdict = verdicts.get(t.id);
    const failing = (alert?.via?.id === t.id) || (verdict && !verdict.ok && !testing.has(t.id));
    const taken = trace && trace.targetId === t.id;

    const stop = paintRoute(el('span', { class: `term-stop${t.dashed ? ' dashed' : ''}` }), t.colour);
    const name = el(
      'p',
      { class: 'term-name' },
      p ? el('button', { class: 'term-link', type: 'button', onclick: () => host.open(p.id) }, p.name) : el('span', {}, nameOf(config, t.id)),
      t.isDefault && layout.kind !== 'proxy' && layout.kind !== 'direct' && layout.kind !== 'system' ? el('span', { class: 'meta' }, 'everything else') : null,
      taken ? el('span', { class: 'took' }, trace!.ruleIndex !== null ? `takes it, rule ${trace!.ruleIndex + 1}` : trace!.override ? 'takes it, override' : 'takes it') : null
    );

    let sub: Node | string;
    if (p?.kind === 'proxy') sub = el('span', { class: 'mono' }, `${p.scheme} ${p.host || '(no host)'}:${p.port}`);
    else if (p?.kind === 'switch') sub = 'Auto switch · decides again';
    else if (p?.kind === 'rulelist') sub = 'Rule list · decides again';
    else if (p?.kind === 'virtual') sub = `Alias for ${nameOf(config, p.targetId)}`;
    else if (t.id === SYSTEM) sub = 'Your OS settings';
    else sub = 'No proxy, your own connection';

    const figs: Array<HTMLElement> = [];
    const count = tally?.get(t.id);
    if (live && tally) figs.push(el('span', { class: 'tnum' }, `${count ?? 0} tab${count === 1 ? '' : 's'}`));
    if (p?.kind === 'proxy') {
      const result = el('span', { class: 'test-result', dataset: { profile: p.id } });
      if (testing.has(p.id)) result.textContent = 'Testing…';
      else if (verdict) {
        result.classList.add('st', verdict.ok ? 'good' : 'bad');
        result.textContent = verdict.ok ? `${verdict.ms} ms` : 'Failed';
        result.title = verdict.ok ? `Tested ${relativeTime(verdict.at)} · exits ${verdict.ip}${verdict.country ? ` · ${verdict.country}` : ''}` : (verdict.error ?? 'Connection failed');
      }
      figs.push(result);
    }
    if (failing && !verdict) figs.push(el('span', { class: 'st bad' }, 'Failing'));
    if (!live) {
      // Nothing measured belongs on a map of a profile that may not be routing.
    } else if (exitTarget === t.id && exitInfo && !exitBusy) {
      const src = flagSrc(exitInfo.iso);
      figs.push(
        el(
          'span',
          { class: 'exit-at', title: `ipconfig.is sees this route exit from ${exitInfo.ip}${exitInfo.country ? `, ${exitInfo.country}` : ''} · ${exitInfo.ms} ms · ${relativeTime(exitAt)}` },
          'exits ',
          el('span', { class: 'mono' }, exitInfo.ip),
          src ? el('img', { class: 'flag', src, alt: exitInfo.country ?? '', width: 16, height: 12 }) : null
        )
      );
    } else if (exitTarget === t.id && exitBusy) {
      figs.push(el('span', { class: 'exit-at muted' }, 'measuring exit…'));
    }

    const action =
      p?.kind === 'proxy'
        ? el(
            'button',
            {
              class: 'btn sm test-btn',
              type: 'button',
              dataset: { profile: p.id },
              disabled: !config.settings.exitIpCheck || testing.has(p.id),
              title: config.settings.exitIpCheck ? `Route one request through ${p.name} to ipconfig.is` : 'Turn on IP address lookups to test connections',
              onclick: () => void requestTest(p),
            },
            'Test'
          )
        : el('span');

    const li = el(
      'li',
      { class: `term${failing ? ' failing' : ''}${trace && !taken ? ' faded' : ''}` },
      stop,
      el('div', { class: 'term-body' }, name, el('p', { class: 'term-sub' }, sub), figs.length ? el('p', { class: 'term-fig' }, ...figs) : null),
      action
    );
    li.style.top = `${t.y}px`;
    list.append(li);
  }
  return list;
}

/** The map destination ipconfig.is itself is routed to — where the measured exit belongs. */
function exitRouteTarget(config: Config, layout: YardLayout): string | null {
  const u = new URL(EXIT_IP_URL);
  return traceYard(config, layout, pacRequestUrl(u.href), u.hostname, overrides).targetId;
}

/** The key under the map, and the one control the map itself cannot hold. */
function keySection(): { node: HTMLElement; refresh: () => void } {
  const node = el('div', { class: 'yard-key' });
  const refresh = (): void => {
    const config = host.config();
    const junctions = shownLayout?.junctions ?? [];
    const rules = junctions.filter((j) => j.shape === 'square');
    const off = rules.find((j) => j.off);
    const on = rules.find((j) => !j.off);
    const items: Array<HTMLElement | null> = [
      on ? el('span', {}, el('span', { class: 'kj' }, on.label), 'a rule, tried in order; the first match takes the request') : null,
      off ? el('span', {}, el('span', { class: 'kj off' }, off.label), 'a rule that is off') : null,
      el('span', {}, paintRoute(el('span', { class: 'kk' }), '#3b82f6'), 'a destination, in its profile’s colour'),
    ];
    const tail: HTMLElement[] = [];
    if (tabsGranted === false) {
      tail.push(
        el(
          'button',
          {
            class: 'linklike',
            type: 'button',
            onclick: async () => {
              const ok = await chrome.permissions.request(TABS_PERMS).catch(() => false);
              if (ok) {
                tabsGranted = true;
                void countTabs();
              } else toast('Permission declined');
            },
          },
          'Count the tabs on each line'
        )
      );
    }
    if (!config.settings.exitIpCheck) {
      tail.push(
        el(
          'button',
          {
            class: 'linklike',
            type: 'button',
            onclick: async () => {
              if (!(await host.requestExitIp())) {
                toast('Permission declined');
                return;
              }
              host.config().settings.exitIpCheck = true;
              host.save();
            },
          },
          'Show exit addresses'
        )
      );
    } else if (exitError) {
      tail.push(el('button', { class: 'linklike', type: 'button', title: exitError, onclick: () => void runExitCheck(true) }, 'Exit lookup failed — retry'));
    }
    const kept = items.filter((n): n is HTMLElement => n !== null);
    if (tail.length) kept.push(el('span', { class: 'yard-key-acts' }, ...tail));
    node.replaceChildren(...kept);
  };
  return { node, refresh };
}

/* ---------------- what needs attention ---------------- */

function attentionSection(): { node: HTMLElement; refresh: () => void } {
  const node = el('section', { class: 'ledger-col' });
  node.setAttribute('aria-labelledby', 'todo-h');
  const refresh = (): void => {
    const config = host.config();
    const report = auditConfig(config, { authGranted, now: Date.now() });
    // The audit already says when a proxy's sign-in is not allowed, with the
    // same fix; listing the ask too would say it twice.
    const asks = host.asks().filter((a) => a.id !== 'auth');
    const rows = [...asks.map(askRow), ...report.issues.map(issueRow)];
    const count = asks.length + report.issues.length;
    rows.push(
      el(
        'li',
        { class: 'todo-ok' },
        icon('check'),
        el(
          'div',
          {},
          el('h3', {}, count ? 'Everything else checks out' : 'Nothing needs attention'),
          el('p', {}, 'Every profile compiles, every rule can run, and every list is current.')
        )
      )
    );
    node.replaceChildren(
      el('h2', { class: 'ledger-h', id: 'todo-h' }, 'Needs attention', count ? el('span', { class: 'meta tnum' }, String(count)) : null),
      el('ul', { class: 'todo' }, ...rows)
    );
  };
  return { node, refresh };
}

function issueRow(issue: HealthIssue): HTMLElement {
  const level = issue.level === 'error' ? 'bad' : issue.level === 'warn' ? 'warn' : 'info';
  return el(
    'li',
    { class: `todo-${level}` },
    icon(level === 'bad' ? 'x' : level === 'warn' ? 'alert' : 'info'),
    el('div', {}, el('h3', {}, issue.title), issue.detail ? el('p', {}, issue.detail) : null),
    el('button', { class: 'btn sm', type: 'button', onclick: () => void applyFix(issue) }, issue.fix.label)
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
    case 'update-list':
      if (issue.profileId) await host.refetchRuleList(issue.profileId);
      return;
    case 'add-proxy':
      host.createProxy();
      return;
  }
}

/* ---------------- this session ---------------- */

function sessionSection(): { node: HTMLElement; refresh: () => void } {
  const node = el('section', { class: 'ledger-col' });
  node.setAttribute('aria-labelledby', 'sess-h');
  const refresh = (): void => {
    const config = host.config();
    const log = host.errorLog();
    const now = Date.now();
    const head = el('h2', { class: 'ledger-h', id: 'sess-h' }, 'This session');
    const children: Node[] = [head];

    if (history.length) {
      const start = history[0]!.at;
      const span = Math.max(now - start, 60_000);
      const bar = el('div', { class: 'tl', role: 'img' });
      const said: string[] = [];
      history.forEach((entry, i) => {
        const until = history[i + 1]?.at ?? now;
        const seg = paintRoute(el('i', { title: `${nameOf(config, entry.id)} — ${hm(entry.at)} to ${i === history.length - 1 ? 'now' : hm(until)}` }), colourOf(config, entry.id));
        seg.style.flex = String(Math.max(until - entry.at, span / 200));
        bar.append(seg);
        said.push(`${nameOf(config, entry.id)} from ${hm(entry.at)}`);
      });
      bar.setAttribute('aria-label', `${said.join(', ')}, until now`);
      const shown = history.slice(-6);
      const earlier = history.length - shown.length;
      const switches = el(
        'ol',
        { class: 'switches' },
        ...shown.map((entry, i) =>
          el(
            'li',
            {},
            el('span', { class: 'mono' }, hm(entry.at)),
            paintRoute(el('span', { class: `key${entry.id === SYSTEM ? ' system' : ''}` }), colourOf(config, entry.id)),
            el('span', { class: 'sw-name' }, nameOf(config, entry.id)),
            i === shown.length - 1 ? el('span', { class: 'meta' }, 'now') : el('span')
          )
        )
      );
      children.push(bar, switches);
      if (earlier > 0) children.push(el('p', { class: 'meta switches-more' }, `…and ${earlier} earlier`));
    } else {
      children.push(el('p', { class: 'meta' }, 'Switches made in this browser session show here. The log starts fresh with the browser.'));
    }

    const errors = log.reduce((sum, e) => sum + e.count, 0);
    const alert = host.alert();
    const sync = !config.settings.syncEnabled
      ? 'sync off'
      : syncBytes >= 0
        ? `sync on, ${(syncBytes / 1024).toFixed(1)} of 100 KB used`
        : syncBytes === -1
          ? 'sync on'
          : 'sync on, size unavailable';
    children.push(
      el(
        'p',
        { class: 'sess-sum' },
        `${history.length ? Math.max(0, history.length - 1) : 0} switch${history.length === 2 ? '' : 'es'} · `,
        errors
          ? el('button', { class: `linklike st ${alert ? 'bad' : 'warn'}`, type: 'button', onclick: () => host.open('@errors') }, `${errors} proxy error${errors === 1 ? '' : 's'}`)
          : 'no proxy errors',
        ` · ${sync}`
      )
    );
    node.replaceChildren(...children);
  };
  return { node, refresh };
}

function hm(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ---------------- connection tests ---------------- */

async function requestTest(profile: ProxyProfile): Promise<void> {
  const config = host.config();
  if (!config.settings.exitIpCheck) {
    toast('Turn on IP address lookups in Settings to test');
    return;
  }
  if (!(await host.requestExitIp())) {
    toast('Needs access to ipconfig.is');
    return;
  }
  wireVerdicts();
  testing.add(profile.id);
  repaintDashboard();
  await chrome.storage.session.set({
    [TEST_KEY]: { profileId: profile.id, nonce: Date.now(), scheme: profile.scheme, host: profile.host, port: profile.port },
  });
  // The worker answers within ~8 s; a test it drops still has to give the button back.
  setTimeout(() => {
    if (!testing.delete(profile.id)) return;
    repaintDashboard();
  }, 15_000);
}

/** Keep each proxy's last verdict, so it survives the repaint that follows it. */
function wireVerdicts(): void {
  if (verdictsWired) return;
  verdictsWired = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes[TEST_RESULT_KEY]) return;
    const r = changes[TEST_RESULT_KEY].newValue as (Omit<TestVerdict, 'at'> & { profileId?: string }) | undefined;
    if (!r?.profileId) return;
    testing.delete(r.profileId);
    verdicts.set(r.profileId, { ok: !!r.ok, ip: r.ip, iso: r.iso, country: r.country, ms: r.ms, error: r.error, at: Date.now() });
    repaintDashboard();
  });
}

/* ---------------- tabs on each line ---------------- */

async function countTabs(): Promise<void> {
  const mine = ++tabsSeq;
  const granted = await chrome.permissions.contains(TABS_PERMS).catch(() => false);
  if (mine !== tabsSeq || !root?.isConnected) return;
  tabsGranted = granted;
  if (!granted) {
    tally = null;
    repaintDashboard();
    return;
  }
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  if (mine !== tabsSeq || !root?.isConnected) return;
  const config = host.config();
  const layout = layoutYard(config, config.activeId, FULL, overrides);
  const next = new Map<string, number>();
  for (const tab of tabs) {
    const target = tabTarget(tab);
    if (!target) continue;
    const t = traceYard(config, layout, pacRequestUrl(target.url), target.host, overrides);
    next.set(t.targetId, (next.get(t.targetId) ?? 0) + 1);
  }
  tally = next;
  repaintDashboard();
}

/* ---------------- the exit lookup ---------------- */

async function runExitCheck(force = false): Promise<void> {
  const config = host.config();
  if (!config.settings.exitIpCheck) return;
  if (exitBusy && !force) return;
  if (!force && exitInfo && Date.now() - exitAt < 60_000) return;
  if (!(await chrome.permissions.contains(EXIT_IP_PERMS).catch(() => false))) return;
  const mine = ++exitSeq;
  exitBusy = true;
  exitStartedAt = Date.now();
  exitError = null;
  exitForId = config.activeId;
  repaintDashboard();
  try {
    const info = await checkExitIp(8000);
    if (mine !== exitSeq) return;
    exitInfo = info;
    exitAt = Date.now();
  } catch (e) {
    if (mine !== exitSeq) return;
    exitInfo = null;
    exitError = e instanceof Error ? e.message : 'lookup failed';
  } finally {
    if (mine === exitSeq) {
      exitBusy = false;
      repaintDashboard();
    }
  }
}

/* ---------------- the panel ---------------- */

export function dashboardPanel(h: DashboardHost): HTMLElement {
  host = h;
  generation++;
  wireVerdicts();

  const alerts = alertSection();
  const head = headSection();
  const yard = yardSection();
  const key = keySection();
  const attention = attentionSection();
  const session = sessionSection();

  const panel = el(
    'div',
    { class: 'pane ov' },
    alerts.node,
    head.node,
    el('div', { class: 'band' }, traceSection(), yard.node, key.node),
    el('div', { class: 'ledger' }, attention.node, session.node)
  );
  root = panel;

  const sections = [alerts, head, yard, key, attention, session];
  refreshers = sections.map((s) => s.refresh);
  sectionNodes = sections.map((s) => s.node);
  for (const refresh of refreshers) refresh();

  // Deferred reads: each repaints when it lands, so first paint never waits.
  const mine = generation;
  void (async () => {
    const config = host.config();
    const [granted, session, log, temp] = await Promise.all([
      chrome.permissions.contains(AUTH_PERMS).catch(() => false),
      chrome.storage.session.get([CONTROL_KEY, APPLIED_KEY]).catch(() => ({}) as Record<string, unknown>),
      loadHistory(),
      loadTempRules(config.activeId, 'regular').catch(() => [] as SwitchRule[]),
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
    overrides = temp;
    repaintDashboard();
    void countTabs();
  })();

  void measureSync();
  void runExitCheck();
  void document.fonts?.ready.then(() => {
    if (mine === generation) repaintDashboard();
  });

  clearInterval(relTimer);
  relTimer = setInterval(() => {
    if (root?.isConnected) {
      repaintDashboard();
      void countTabs();
    } else clearInterval(relTimer);
  }, REL_TICK_MS);

  return panel;
}

async function measureSync(): Promise<void> {
  const mine = generation;
  try {
    const bytes = await chrome.storage.sync.getBytesInUse(null);
    if (mine !== generation || !root?.isConnected) return;
    syncBytes = bytes;
  } catch {
    syncBytes = -2;
  }
  repaintDashboard();
}

/**
 * Repaint every section in place. Safe from any storage listener: the trace
 * field is not a section, so nothing being typed is ever rebuilt. A section
 * holding focus is repainted and focus is put back on the control that took
 * its place — the control pressed is very often the one whose result the
 * repaint is there to show.
 */
export function repaintDashboard(): void {
  if (!root?.isConnected) return;
  refreshers.forEach((refresh, i) => {
    const section = sectionNodes[i];
    const focused = document.activeElement;
    if (!section || !(focused instanceof Element) || focused === section || !section.contains(focused)) {
      refresh();
      return;
    }
    const key = focusKey(focused);
    refresh();
    if (section.contains(document.activeElement)) return;
    const twin = [...section.querySelectorAll<HTMLElement>('button, a, input, select')].find((n) => focusKey(n) === key);
    if (twin) twin.focus({ preventScroll: true });
    else {
      section.tabIndex = -1;
      section.focus({ preventScroll: true });
    }
  });
}

function focusKey(node: Element): string {
  const data = (node as HTMLElement).dataset ?? {};
  const cls = (node.getAttribute('class') ?? '').split(/\s+/).filter((c) => !['lit', 'faded', 'good', 'bad', 'st'].includes(c)).join(' ');
  return [node.tagName, cls, data.profile ?? '', (node.textContent ?? '').trim().slice(0, 80)].join('|');
}

export function dashboardMounted(): boolean {
  return Boolean(root?.isConnected);
}

export function setAuthGranted(granted: boolean): void {
  if (granted === authGranted) return;
  authGranted = granted;
  repaintDashboard();
}

export function setControlLevel(level: string): void {
  if (level === controlLevel) return;
  controlLevel = level;
  repaintDashboard();
}

export function setHistory(entries: ActivationEntry[]): void {
  history = entries;
  repaintDashboard();
}

/** Overrides changed (the popup set or ended one): they are the map's first junction. */
export function setOverrides(rules: SwitchRule[]): void {
  overrides = rules;
  repaintDashboard();
  void countTabs();
}

/**
 * The worker applied a route. Re-measure the exit only when the destination
 * actually changed — re-applying after a rule edit or a permission grant must
 * not become a steady trickle of lookups to a third party.
 */
export function setApplied(activeId: string, at: number): void {
  appliedAt = at;
  if (activeId === exitForId && exitInfo) {
    repaintDashboard();
    void countTabs();
    return;
  }
  if (activeId === exitForId && exitBusy && exitStartedAt >= at) {
    repaintDashboard();
    return;
  }
  exitForId = activeId;
  exitInfo = null;
  exitError = null;
  void runExitCheck(true);
  void countTabs();
}

/** The first-run tile and the editor's tile share one look. */
export function tileFor(config: Config, id: string, size: number): HTMLElement {
  const p: Profile | undefined = id === DIRECT || id === SYSTEM ? undefined : profileById(config, id);
  if (!p) return builtinTile(id === SYSTEM ? 'S' : 'D', size);
  return avatarEl(p, size);
}

/** For callers that need a destination's colour without importing the layout module. */
export function lineColour(config: Config, id: string): string {
  return id === DIRECT || id === SYSTEM ? BUILTIN_FILL : colourOf(config, id);
}

export { RULE_LABEL };
