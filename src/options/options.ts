import { avatarEl, builtinTile, initialsFor } from '../shared/avatar';
import { BUILTIN_FILL, paintRoute } from '../shared/colour';
import {
  PermAsk,
  askRow,
  dashboardMounted,
  dashboardPanel,
  lineColour,
  tracedYard,
  repaintDashboard,
  setApplied,
  setAuthGranted,
  setControlLevel,
  setHistory,
  setOverrides,
} from './dashboard';
import { COMPACT, FULL, YardLayout, edgeRuleIndex, layoutYard } from '../shared/yard';
import { yardSvg } from './yardview';
import { FetchRoute, listFetchRoute } from '../shared/listroute';
import { Explanation, ListFetchFailure, RouteName, explainListFailure } from '../shared/listfetch';
import { docsPanel } from './docs';
import { brandMark } from '../shared/mark';
import { EXIT_IP_PERMS, flagSrc } from '../shared/exitip';
import { TraceEdge, hostLooksReal, pacRequestUrl, patternError, resolveRoute } from '../shared/match';
import { RULE_LIST_MAX_BYTES, looksLikeSwitchyOmega, parseRuleList } from '../shared/rulelist';
import { networkPanel } from './network';
import { releasesPanel } from './releases';
import {
  ERROR_KEY,
  ERROR_LOG_KEY,
  ProxyAlert,
  ProxyErrorEntry,
  clearErrorLog,
  clearProxyAlert,
  describeCarrier,
  errorAdvice,
  errorHeadline,
  formatErrorReport,
  loadErrorLog,
  loadProxyAlert,
  viaIsSelf,
} from '../shared/errors';
import {
  APPLIED_KEY,
  CONTROL_KEY,
  HISTORY_KEY,
  LandingPage,
  OPEN_PAGE_KEY,
  TEST_KEY,
  TEST_RESULT_KEY,
  ThemePref,
  UiPrefs,
  applyTheme,
  defaultUiPrefs,
  loadConfig,
  loadHistory,
  loadTempRules,
  loadUiPrefs,
  onTempRulesChanged,
  onThemeChanged,
  newProxyProfile,
  newRuleListProfile,
  newSwitchProfile,
  newVirtualProfile,
  onConfigChanged,
  proxyHostError,
  sanitizeConfig,
  saveConfig,
  saveUiPrefs,
} from '../shared/state';
import { INLINE_TEXT_MAX, SYNC_ERROR_KEY, applyFromSync, clearSync, pullFromSync, remoteSyncState } from '../shared/sync';
import {
  AUTH_PERMS,
  CONFIG_VERSION,
  Config,
  DIRECT,
  KIND_LABEL,
  PALETTE,
  PROFILE_KINDS,
  Profile,
  ProxyProfile,
  ProxyScheme,
  RULE_LIST_FORMAT_LABELS,
  RuleListProfile,
  RuleType,
  SCHEME_LABELS,
  SwitchProfile,
  SwitchRule,
  SYSTEM,
  BADGE_PERMS,
  NAV_PERMS,
  TABS_PERMS,
  VirtualProfile,
  hasCredentials,
  proxyProfiles,
  reachableFrom,
  schemeSupportsAuth,
  uid,
} from '../shared/types';
import { el, icon, relativeTime, toast } from '../shared/ui';
import { PendingUpdate, UPDATE_KEY, loadPendingUpdate } from '../shared/update';

const app = document.getElementById('app')!;
const DASH_ID = '@dash';
const SETTINGS_ID = '@settings';
const DOCS_ID = '@docs';
const INSPECT_ID = '@inspect';
const ERRORS_ID = '@errors';
const NETWORK_ID = '@network';
/** The Profiles tab with nothing chosen yet — it picks one on arrival. */
const PROFILES_ID = '@profiles';
/** Reached from the Documentation page; it has no tab of its own. */
const RELEASES_ID = '@releases';
/**
 * The nav entries that are pages rather than profiles. Kept as one set so a new
 * page cannot be forgotten by the "selected profile was deleted" check below —
 * forgetting it there silently bounces the user off the page on any config change.
 * A page with no tab of its own belongs here too: it is still somewhere the user
 * can be standing when the config changes under them.
 */
const PAGE_IDS = new Set<string>([
  DASH_ID,
  PROFILES_ID,
  // The two built-ins have a pane on the Profiles page of their own.
  DIRECT,
  SYSTEM,
  SETTINGS_ID,
  DOCS_ID,
  INSPECT_ID,
  ERRORS_ID,
  NETWORK_ID,
  RELEASES_ID,
]);

let fieldSeq = 0;

/**
 * A labelled form field: gives the control an id and points the <label> at it
 * (for/id), so screen readers announce the control and clicking the label
 * focuses it. Attribute-only — the rendered layout is unchanged. Trailing nodes
 * (a hint note, a validation-error slot) follow the control.
 */
function field(
  label: string,
  control: HTMLElement,
  opts: { cls?: string; style?: Partial<CSSStyleDeclaration>; extra?: (Node | string | false | null)[] } = {}
): HTMLElement {
  if (!control.id) control.id = `fld-${++fieldSeq}`;
  return el(
    'div',
    { class: opts.cls ? `field ${opts.cls}` : 'field', style: opts.style },
    el('label', { htmlFor: control.id }, label),
    control,
    ...(opts.extra ?? [])
  );
}

/** What one profile of each kind is called. */
const KIND_ONE: Record<Profile['kind'], string> = {
  proxy: 'Proxy',
  switch: 'Auto switch',
  rulelist: 'Rule list',
  virtual: 'Alias',
};

/**
 * The title a page opens on, and the line under it. Every page has one; the
 * permission notices go in the slot under it (updatePermBanners).
 */
function pageHead(title: string, sub?: string | Node, ...trailing: Array<Node | null>): HTMLElement {
  return el(
    'header',
    { class: 'page-head' },
    el('div', { class: 'page-head-text' }, el('h1', { class: 't-title' }, title), sub ? el('p', { class: 'ink2' }, sub) : null),
    trailing.length ? el('div', { class: 'page-head-acts' }, ...trailing) : null
  );
}

/** The head every editor opens on: the profile's tile and name, what it is, and what you can do to it. */
function editorHead(profile: Profile): HTMLElement {
  const active = config.activeId === profile.id;
  const kind = profile.kind === 'proxy' ? `${SCHEME_LABELS[profile.scheme]} proxy` : KIND_ONE[profile.kind];
  const what: Record<Profile['kind'], string> = {
    proxy: 'everything goes through it, except the bypass list',
    switch: 'rules are tried top to bottom, and the first match takes the request',
    rulelist: 'requests on the list go one way, the rest another',
    virtual: 'one name for a route, retargeted in one place',
  };
  return el(
    'header',
    { class: 'ed-head' },
    avatarEl(profile, 44),
    el('div', { class: 'ed-title' }, el('h1', { class: 't-title' }, profile.name), el('p', { class: 'ink2' }, `${kind} · ${what[profile.kind]}`)),
    el(
      'div',
      { class: 'ed-acts' },
      active
        ? el('span', { class: 'st good' }, 'Active')
        : el('button', { class: 'btn primary', type: 'button', onclick: () => dashboardHost.activate(profile.id) }, 'Switch to it'),
      el('button', { class: 'btn quiet', type: 'button', onclick: () => duplicateProfile(profile) }, 'Duplicate'),
      el('button', { class: 'btn quiet danger', type: 'button', onclick: () => deleteProfile(profile) }, 'Delete')
    )
  );
}

let config: Config;
let selectedId: string | null = null;
/** Per-device page preferences — deliberately not part of Config; see state.ts. */
let uiPrefs: UiPrefs = defaultUiPrefs();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let syncError: string | null = null;
/** Proxy-failure state, mirrored from session storage (see shared/errors.ts). */
let proxyAlert: ProxyAlert | null = null;
let errorLog: ProxyErrorEntry[] = [];
/** Route-inspector state, module-level so it survives re-renders. */
let inspectUrl = '';
let inspectStartId = ''; // '' = the active profile

const RULE_TYPES: Record<RuleType, string> = {
  hostWildcard: 'Host wildcard',
  hostRegex: 'Host regex',
  urlWildcard: 'URL wildcard',
  urlRegex: 'URL regex',
  ipCidr: 'IP / CIDR',
  keyword: 'URL keyword',
  hostLevels: 'Host levels',
  weekday: 'Weekday',
  time: 'Time of day',
};

let savePending = false;

function scheduleSave(): void {
  savePending = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    savePending = false;
    void saveConfig(config).then(() => toast('Saved'));
  }, 300);
}

/**
 * Move to a page and paint it, from the top.
 *
 * The scroll reset is the point: these are separate pages sharing one scroll
 * position, so stepping from the foot of a long Documentation page into the
 * release history landed you halfway down it, past the newest entry.
 */
function goTo(id: string): void {
  selectedId = id;
  render();
  window.scrollTo({ top: 0 });
}

/**
 * Switch to the in-app Docs page and land on one card. render() replaces the
 * tree synchronously, so the anchor exists by the time we look for it.
 */
function openDocsAt(anchor: string): void {
  selectedId = DOCS_ID;
  render();
  document.getElementById(anchor)?.scrollIntoView({
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'start',
  });
}

function selected(): Profile | null {
  return config.profiles.find((p) => p.id === selectedId) ?? null;
}

function confirmMaybe(message: string): boolean {
  return !config.settings.confirmDeletion || confirm(message);
}

/* ---------- the top bar ---------- */

/** A profile, or one of the two built-ins — the things the Profiles page can show. */
function isProfileId(id: string | null): boolean {
  return !!id && (id === DIRECT || id === SYSTEM || config.profiles.some((p) => p.id === id));
}

interface NavTab {
  id: string;
  label: string;
  lit: (id: string | null) => boolean;
}

/**
 * Six sections across the top. The profiles used to be the sidebar's spine;
 * they are a page of their own now, with the active one always on the right of
 * this bar, where it can be switched from anywhere.
 */
const NAV_TABS: NavTab[] = [
  { id: DASH_ID, label: 'Overview', lit: (id) => id === DASH_ID },
  { id: PROFILES_ID, label: 'Profiles', lit: (id) => id === PROFILES_ID || isProfileId(id) },
  { id: NETWORK_ID, label: 'Activity', lit: (id) => id === NETWORK_ID || id === ERRORS_ID },
  { id: INSPECT_ID, label: 'Inspector', lit: (id) => id === INSPECT_ID },
  { id: SETTINGS_ID, label: 'Settings', lit: (id) => id === SETTINGS_ID },
  { id: DOCS_ID, label: 'Docs', lit: (id) => id === DOCS_ID || id === RELEASES_ID },
];

/** Where the Profiles tab lands: what was open, else the active profile, else the first. */
function profilesLanding(): string {
  if (isProfileId(selectedId)) return selectedId!;
  if (config.profiles.some((p) => p.id === config.activeId)) return config.activeId;
  return config.profiles[0]?.id ?? PROFILES_ID;
}

function topNav(): HTMLElement {
  const asks = pendingAsks();
  const tabs = el(
    'nav',
    { class: 'tabs', ariaLabel: 'Sections' },
    ...NAV_TABS.map((t) => {
      const btn = el(
        'button',
        {
          class: 'tab',
          type: 'button',
          onclick: () => goTo(t.id === PROFILES_ID ? profilesLanding() : t.id),
        },
        t.label,
        // The count rides the tab only while failures are live; the page
        // itself is always reachable, because the log outlives the incident.
        t.id === NETWORK_ID && proxyAlert
          ? el(
              'span',
              { class: 'count tnum' },
              icon('alert', 'sm'),
              proxyAlert.streak > 99 ? '99+' : String(proxyAlert.streak),
              el('span', { class: 'vh' }, ' failing requests')
            )
          : null,
        // Settings switched on that cannot work until the user says yes.
        t.id === SETTINGS_ID && asks
          ? el('span', { class: 'count warn tnum' }, icon('alert', 'sm'), String(asks), el('span', { class: 'vh' }, asks === 1 ? ' setting needs your OK' : ' settings need your OK'))
          : null
      );
      if (t.lit(selectedId)) btn.setAttribute('aria-current', 'page');
      return btn;
    })
  );
  return el(
    'header',
    { class: 'top' },
    el(
      'div',
      { class: 'wrap top-in' },
      el(
        'button',
        { class: 'brand', type: 'button', title: 'Overview', onclick: () => goTo(DASH_ID) },
        brandMark(),
        el('span', {}, 'Sockitt')
      ),
      tabs,
      el('div', { class: 'top-end' }, routePicker())
    )
  );
}

const PICK_ID = 'route-pick';
/**
 * A run of changes inside this window collapses into one activation: a focused
 * closed <select> steps its value on every arrow key, and each step would
 * otherwise be a config write, a proxy re-apply and a sync push.
 */
const PICK_DEBOUNCE_MS = 260;
let pickTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The active profile, on every page. A native select, so the list is the
 * platform's own and works with a keyboard and a screen reader; the line key
 * beside it is the colour the profile routes in, which an option cannot show.
 */
function routePicker(): HTMLElement {
  const select = el('select', { class: 'picker-select', id: PICK_ID }) as HTMLSelectElement;
  select.append(el('option', { value: DIRECT }, 'Direct'), el('option', { value: SYSTEM }, 'System'));
  for (const kind of PROFILE_KINDS) {
    const members = config.profiles.filter((p) => p.kind === kind);
    if (!members.length) continue;
    const group = el('optgroup', {}) as HTMLOptGroupElement;
    group.label = KIND_LABEL[kind];
    for (const p of members) group.append(el('option', { value: p.id }, p.name));
    select.append(group);
  }
  select.value = config.activeId;
  select.onchange = () => {
    const id = select.value;
    const hadFocus = document.activeElement === select;
    clearTimeout(pickTimer);
    pickTimer = setTimeout(() => {
      dashboardHost.activate(id);
      if (hadFocus) document.getElementById(PICK_ID)?.focus();
    }, PICK_DEBOUNCE_MS);
  };
  const key = paintRoute(
    el('span', { class: `key${config.activeId === SYSTEM ? ' system' : ''}` }),
    lineColour(config, config.activeId)
  );
  return el('label', { class: 'picker', htmlFor: PICK_ID }, el('span', { class: 't-label' }, 'Routing'), key, select);
}

/* ---------- the Profiles page's list ---------- */

/** What the list's filter field holds. Module scope, so a repaint keeps it. */
let profileFilter = '';
/** Whether the New menu is open. Transient; closing it is part of choosing. */
let newMenuOpen = false;

const NEW_KINDS: Array<[string, string, (existing: Profile[]) => Profile]> = [
  ['Proxy server', 'SOCKS5, SOCKS4, HTTP or HTTPS, with a bypass list', newProxyProfile],
  ['Auto switch', 'Rules that send each site its own way', newSwitchProfile],
  ['Rule list', 'A subscribed list, such as AutoProxy or GFWList', newRuleListProfile],
  ['Alias', 'One name for a route you retarget often', newVirtualProfile],
];

function newMenu(): HTMLElement {
  const button = el(
    'button',
    {
      class: 'btn sm new-btn',
      type: 'button',
      ariaExpanded: String(newMenuOpen),
      ariaHasPopup: 'menu',
      onclick: () => {
        newMenuOpen = !newMenuOpen;
        refreshChrome();
        if (newMenuOpen) document.querySelector<HTMLElement>('.new-wrap .menu-it')?.focus();
      },
    },
    icon('plus', 'sm'),
    'New',
    icon('chevron', 'sm')
  );
  const menu = newMenuOpen
    ? el(
        'div',
        { class: 'menu', role: 'menu', ariaLabel: 'New profile' },
        ...NEW_KINDS.map(([title, desc, factory]) =>
          el(
            'button',
            {
              class: 'menu-it',
              role: 'menuitem',
              type: 'button',
              onclick: () => {
                newMenuOpen = false;
                addProfile(factory);
              },
            },
            el('b', {}, title),
            el('span', {}, desc)
          )
        )
      )
    : null;
  return el('div', { class: 'new-wrap' }, button, menu);
}

/** Close the New menu on a click elsewhere or on Escape — wired once. */
function wireMenuDismissal(): void {
  document.addEventListener('click', (e) => {
    if (!newMenuOpen) return;
    if ((e.target as Element | null)?.closest?.('.new-wrap')) return;
    newMenuOpen = false;
    refreshChrome();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !newMenuOpen) return;
    newMenuOpen = false;
    refreshChrome();
    document.querySelector<HTMLElement>('.new-btn')?.focus();
  });
}

/** What each profile is, in the list's right-hand column. */
function listSub(p: Profile): { text: string; mono: boolean } {
  switch (p.kind) {
    case 'proxy':
      return { text: p.scheme, mono: true };
    case 'switch':
      return { text: config.activeId === p.id ? 'Active' : `${p.rules.length} rule${p.rules.length === 1 ? '' : 's'}`, mono: false };
    case 'rulelist': {
      const n = parseRuleList(p.format, p.text).count;
      return { text: config.activeId === p.id ? 'Active' : `${n.toLocaleString()} entr${n === 1 ? 'y' : 'ies'}`, mono: false };
    }
    case 'virtual':
      return { text: nameFor(p.targetId), mono: false };
  }
}

function nameFor(id: string): string {
  if (id === DIRECT) return 'Direct';
  if (id === SYSTEM) return 'System';
  return config.profiles.find((p) => p.id === id)?.name ?? 'Direct';
}

function profileColumn(): HTMLElement {
  const row = (id: string, name: string, sub: { text: string; mono: boolean }, colour: string, system = false): HTMLElement => {
    const active = config.activeId === id;
    const node = el(
      'button',
      { class: 'plist-row', type: 'button', onclick: () => goTo(id) },
      paintRoute(el('span', { class: `key${system ? ' system' : ''}` }), colour),
      el('span', { class: 'nm' }, name),
      el('span', { class: `sub${sub.mono ? ' mono' : ''}` }, active && sub.text !== 'Active' ? 'Active' : sub.text)
    );
    node.dataset.search = `${name} ${sub.text}`.toLowerCase();
    if (selectedId === id) node.setAttribute('aria-current', 'page');
    return node;
  };

  const groups: HTMLElement[] = [
    el(
      'div',
      { class: 'plist-group' },
      el('p', { class: 't-label' }, 'Built in'),
      row(DIRECT, 'Direct', { text: 'No proxy', mono: false }, BUILTIN_FILL),
      row(SYSTEM, 'System', { text: 'OS settings', mono: false }, BUILTIN_FILL, true)
    ),
  ];
  const labels: Record<Profile['kind'], string> = {
    proxy: 'Proxy servers',
    switch: 'Auto switch',
    rulelist: 'Rule lists',
    virtual: 'Aliases',
  };
  for (const kind of PROFILE_KINDS) {
    const members = config.profiles.filter((p) => p.kind === kind);
    if (!members.length) {
      if (kind === 'virtual' && config.profiles.length) {
        groups.push(
          el(
            'div',
            { class: 'plist-group plist-hint' },
            el('p', { class: 't-label' }, labels[kind]),
            el(
              'p',
              { class: 'plist-empty' },
              'One name for a route you change often. Point rules at an alias, then retarget them all at once. ',
              el('button', { class: 'linklike', type: 'button', onclick: () => addProfile(newVirtualProfile) }, 'New alias')
            )
          )
        );
      }
      continue;
    }
    groups.push(
      el('div', { class: 'plist-group' }, el('p', { class: 't-label' }, labels[kind]), ...members.map((p) => row(p.id, p.name, listSub(p), p.color)))
    );
  }

  const filter = el('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Filter profiles',
    ariaLabel: 'Filter profiles',
    value: profileFilter,
    spellcheck: false,
    oninput: (e: Event) => {
      profileFilter = (e.currentTarget as HTMLInputElement).value;
      applyProfileFilter();
    },
  });

  return el(
    'aside',
    { class: 'plist', ariaLabel: 'Profiles' },
    el('div', { class: 'plist-head' }, el('h2', { class: 't-h3' }, 'Profiles'), newMenu()),
    el('div', { class: 'search plist-find' }, filter),
    ...groups,
    el('p', { class: 'plist-none meta hidden' }, 'No profile matches.')
  );
}

/** Hide rows that don't match, in place — never a rebuild, so typing keeps focus. */
function applyProfileFilter(): void {
  const list = app.querySelector('.plist');
  if (!list) return;
  const q = profileFilter.trim().toLowerCase();
  let any = false;
  list.querySelectorAll<HTMLElement>('.plist-group').forEach((group) => {
    let shown = false;
    group.querySelectorAll<HTMLElement>('.plist-row').forEach((r) => {
      const hit = !q || (r.dataset.search ?? '').includes(q);
      r.classList.toggle('hidden', !hit);
      if (hit) shown = true;
    });
    group.classList.toggle('hidden', !!q && (!shown || group.classList.contains('plist-hint')));
    if (shown) any = true;
  });
  list.querySelector('.plist-none')?.classList.toggle('hidden', any || !q);
}

/* ---------- the footer ---------- */

function footer(): HTMLElement {
  let version = '';
  try {
    version = chrome.runtime.getManifest().version;
  } catch {
    /* a preview build */
  }
  const link = (href: string, text: string, title?: string): HTMLElement =>
    el('a', { href, target: '_blank', rel: 'noopener noreferrer', title: title ?? '' }, text);
  return el(
    'footer',
    { class: 'foot' },
    el(
      'div',
      { class: 'wrap foot-in' },
      el('span', {}, version ? `Sockitt ${version}` : 'Sockitt'),
      link('https://ipconfig.is', 'Check your IP', 'Open ipconfig.is in a new tab'),
      link('https://github.com/ptmplop/Sockitt', 'Source on GitHub'),
      // A plain link, not their widget: an MV3 page cannot run a third party's
      // script, and it should contact nobody until it is clicked.
      link('https://buymeacoffee.com/ipbadger', 'Buy me a coffee', 'Support Sockitt - opens buymeacoffee.com in a new tab'),
      el('span', { class: 'grow' }, 'MIT licensed')
    )
  );
}

/* ---------- first run, and the built-ins ---------- */

/** Three ways in, for an install with nothing set up yet. */
function startList(): HTMLElement {
  const item = (n: string, title: string, text: string, ...actions: HTMLElement[]): HTMLElement =>
    el('li', {}, el('span', { class: 'start-n mono' }, n), el('div', {}, el('h3', {}, title), el('p', {}, text)), el('div', { class: 'start-acts' }, ...actions));
  return el(
    'section',
    { class: 'starts', ariaLabel: 'Three ways to start' },
    el('h2', { class: 't-h3' }, 'Three ways to start'),
    el(
      'ol',
      {},
      item('1', 'Add a proxy server', 'SOCKS5, SOCKS4, HTTP or HTTPS. It gets its own line on the map, and the toolbar switches to it in one click.',
        el('button', { class: 'btn primary', type: 'button', onclick: () => addProfile(newProxyProfile) }, 'Add a proxy server')),
      item('2', 'Start an auto switch', 'Send some sites through a proxy and everything else direct, by host, keyword, IP range or time of day.',
        el('button', { class: 'btn', type: 'button', onclick: () => addProfile(newSwitchProfile) }, 'Start an auto switch')),
      item('3', 'Bring your setup across', 'Import a backup from another Sockitt, or turn Sync on and your profiles arrive from your other browsers.',
        el('button', { class: 'btn', type: 'button', onclick: importConfig }, 'Import…'),
        el('button', { class: 'btn quiet', type: 'button', onclick: () => goTo(SETTINGS_ID) }, 'Sync settings'))
    )
  );
}

/** A one-line map: everything to the active built-in, nothing deciding. */
function builtinMap(id: string, compact: boolean): HTMLElement {
  const layout = layoutYard(config, id, compact ? COMPACT : FULL);
  const names = new Map([[id, { name: id === SYSTEM ? 'System' : 'Direct', sub: id === SYSTEM ? 'your OS settings' : 'no proxy' }]]);
  return el(
    'figure',
    { class: compact ? 'ed-map' : 'yard-wrap' },
    yardSvg({
      layout,
      names: compact ? names : undefined,
      origin: compact ? undefined : { title: 'All requests', sub: 'from every tab' },
      ariaLabel: `All requests go to ${id === SYSTEM ? 'System, your operating system’s settings' : 'Direct, with no proxy'}.`,
    })
  );
}

function firstRunPane(): HTMLElement {
  const id = config.activeId === DIRECT ? DIRECT : SYSTEM;
  const layout = layoutYard(config, id, FULL);
  const terminus = paintRoute(
    el(
      'li',
      { class: 'term' },
      el('span', { class: `term-stop${id === SYSTEM ? ' dashed' : ''}` }),
      el(
        'div',
        { class: 'term-body' },
        el('p', { class: 'term-name' }, id === SYSTEM ? 'System' : 'Direct', el('span', { class: 'meta' }, id === SYSTEM ? 'your OS settings' : 'no proxy')),
        el('p', { class: 'term-sub' }, id === SYSTEM ? 'Whatever the OS says - often no proxy at all' : 'Your own connection')
      ),
      el('span')
    ),
    BUILTIN_FILL
  );
  terminus.style.top = `${layout.trunkY}px`;
  const ends = el('ol', { class: 'termini', ariaLabel: 'Where the line ends' }, terminus);
  ends.style.height = `${layout.height}px`;
  return el(
    'div',
    { class: 'pane ov first' },
    el(
      'section',
      { class: 'ov-head' },
      el('p', { class: 't-label' }, 'Routing now'),
      el('h1', { class: 't-display' }, id === SYSTEM ? 'System' : 'Direct'),
      el('p', { class: 'ov-sub' }, id === SYSTEM ? 'Your operating system’s proxy settings decide. Sockitt isn’t routing anything yet.' : 'Every request goes straight out. Sockitt isn’t routing anything yet.')
    ),
    el(
      'div',
      { class: 'band' },
      el(
        'div',
        { class: 'yard-wrap' },
        el(
          'div',
          { class: 'yard' },
          yardSvg({ layout, origin: { title: 'All requests', sub: 'from every tab' }, ariaLabel: `All requests go to ${id === SYSTEM ? 'System' : 'Direct'}.` }),
          ends
        )
      )
    ),
    startList()
  );
}

/** Direct and System have nothing to edit, but they are profiles you can pick. */
function builtinPane(id: string): HTMLElement {
  const system = id === SYSTEM;
  const active = config.activeId === id;
  return el(
    'div',
    { class: 'ed-pane' },
    el(
      'header',
      { class: 'ed-head' },
      builtinTile(system ? 'S' : 'D', 44),
      el(
        'div',
        { class: 'ed-title' },
        el('h1', { class: 't-title' }, system ? 'System' : 'Direct'),
        el('p', { class: 'ink2' }, system ? 'Built in · your operating system’s proxy settings' : 'Built in · no proxy')
      ),
      el(
        'div',
        { class: 'ed-acts' },
        active
          ? el('span', { class: 'st good' }, 'Active')
          : el('button', { class: 'btn primary', type: 'button', onclick: () => dashboardHost.activate(id) }, `Switch to ${system ? 'System' : 'Direct'}`)
      )
    ),
    builtinMap(id, true),
    el(
      'p',
      { class: 'ed-note' },
      system
        ? 'System hands every request to your operating system’s own proxy settings - a PAC file, a manual proxy, or none. Sockitt cannot see those rules, so the map ends here. Nothing to set up.'
        : 'Direct sends every request straight to the network, through your own connection. It is also where any rule set to Direct, and any bypass list, ends up. Nothing to set up.'
    )
  );
}

function addProfile(factory: (existing: Profile[]) => Profile): void {
  const profile = factory(config.profiles);
  config.profiles.push(profile);
  selectedId = profile.id;
  scheduleSave();
  render();
  // The very first proxy is a small occasion.
  if (profile.kind === 'proxy' && proxyProfiles(config).length === 1) confettiBurst();
}

/** A brief, dependency-free burst of PALETTE-coloured pieces. */
function confettiBurst(): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const layer = el('div', { class: 'confetti-layer' });
  document.body.append(layer);
  for (let i = 0; i < 36; i++) {
    const piece = el('span', { class: 'confetti' });
    piece.style.background = PALETTE[i % PALETTE.length]!;
    piece.style.left = `${innerWidth / 2}px`;
    piece.style.top = '30%';
    layer.append(piece);
    const dx = (Math.random() - 0.5) * innerWidth * 0.7;
    const dy = innerHeight * (0.4 + Math.random() * 0.5);
    const rot = (Math.random() - 0.5) * 720;
    piece.animate(
      [
        { transform: 'translate(0, 0) rotate(0)', opacity: 1 },
        {
          transform: `translate(${dx * 0.7}px, ${-80 - Math.random() * 140}px) rotate(${rot / 2}deg)`,
          opacity: 1,
          offset: 0.3,
        },
        { transform: `translate(${dx}px, ${dy}px) rotate(${rot}deg)`, opacity: 0 },
      ],
      { duration: 900 + Math.random() * 500, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
    );
  }
  setTimeout(() => layer.remove(), 1500);
}

/* ---------- shared editor chrome ---------- */

function identityPanel(profile: Profile): HTMLElement {
  const name = el('input', {
    class: 'input',
    value: profile.name,
    spellcheck: false,
    oninput: () => {
      profile.name = name.value.trim() || 'Unnamed';
      initials.placeholder = initialsFor({ name: profile.name });
      scheduleSave();
      renderPreview();
      refreshChrome();
      app.querySelector('.ed-title h1')?.replaceChildren(profile.name);
    },
  }) as HTMLInputElement;

  const initials = el('input', {
    class: 'input',
    value: profile.initials ?? '',
    maxLength: 3,
    placeholder: initialsFor({ name: profile.name }),
    spellcheck: false,
    oninput: () => {
      const v = initials.value.trim();
      profile.initials = v ? v.slice(0, 3) : undefined;
      scheduleSave();
      renderPreview();
      refreshChrome();
    },
  }) as HTMLInputElement;

  // The head's tile is the preview: it is the toolbar icon in miniature.
  const renderPreview = (): void => {
    app.querySelector('.ed-head > .avatar')?.replaceWith(avatarEl(profile, 44));
  };

  const swatches = el(
    'div',
    { class: 'sw-grid', role: 'radiogroup', ariaLabel: 'Line colour' },
    ...PALETTE.map((color) => {
      const on = profile.color.toLowerCase() === color;
      const b = el('button', {
        class: 'swatch',
        type: 'button',
        role: 'radio',
        title: color,
        ariaLabel: color,
        onclick: () => {
          profile.color = color;
          scheduleSave();
          render();
        },
      });
      b.style.background = color;
      b.setAttribute('aria-checked', String(on));
      return b;
    })
  );

  return section(
    'Name and colour',
    'The colour is this profile’s line on every map, and its toolbar icon.',
    el(
      'div',
      { class: 'ident-grid' },
      field('Name', name),
      field('Toolbar initials', initials, { cls: 'fld-s' }),
      el('div', { class: 'field ident-colours' }, el('span', { class: 'field-label' }, 'Line colour'), swatches)
    )
  );
}

/**
 * One editor section: a title and a line on the left, the controls on the
 * right. Every editor and the Settings page is made of these.
 */
function section(title: string, sub: string | Node | null, ...body: Array<Node | null | false>): HTMLElement {
  return el(
    'section',
    { class: 'pform' },
    el('div', { class: 'pform-h' }, el('h2', { class: 't-h3' }, title), sub ? el('p', { class: 'meta' }, sub) : null),
    el('div', { class: 'pform-body' }, ...body.filter((n): n is Node => Boolean(n)))
  );
}

function deleteProfile(profile: Profile): void {
  if (!confirmMaybe(`Delete “${profile.name}”? Rules pointing at it will go Direct.`)) return;
  config.profiles = config.profiles.filter((p) => p.id !== profile.id);
  for (const p of config.profiles) {
    switch (p.kind) {
      case 'switch':
        if (p.defaultTargetId === profile.id) p.defaultTargetId = DIRECT;
        for (const r of p.rules) if (r.targetId === profile.id) r.targetId = DIRECT;
        break;
      case 'virtual':
        if (p.targetId === profile.id) p.targetId = DIRECT;
        break;
      case 'rulelist':
        if (p.matchTargetId === profile.id) p.matchTargetId = DIRECT;
        if (p.defaultTargetId === profile.id) p.defaultTargetId = DIRECT;
        break;
      case 'proxy':
        break;
    }
  }
  config.settings.quickSwitchIds = config.settings.quickSwitchIds.filter((id) => id !== profile.id);
  if (config.settings.startupProfileId === profile.id) config.settings.startupProfileId = '';
  if (config.settings.incognitoProfileId === profile.id) config.settings.incognitoProfileId = '';
  if (config.activeId === profile.id) config.activeId = SYSTEM;
  selectedId = config.profiles[0]?.id ?? PROFILES_ID;
  scheduleSave();
  render();
}

/**
 * A copy to change without touching the original — every rule with a fresh id,
 * so editing the copy's rules can never reach back into the source's.
 */
function duplicateProfile(profile: Profile): void {
  const copy = JSON.parse(JSON.stringify(profile)) as Profile;
  copy.id = uid();
  copy.name = `${profile.name} copy`;
  copy.initials = undefined;
  if (copy.kind === 'switch') copy.rules = copy.rules.map((r) => ({ ...r, id: uid() }));
  config.profiles.push(copy);
  selectedId = copy.id;
  scheduleSave();
  render();
  toast('Duplicated');
}

/**
 * Routing-target selector. Offers Direct plus every profile that would not
 * create a cycle back to the profile being edited.
 */
function targetSelect(ownerId: string, value: string, onChange: (v: string) => void): HTMLSelectElement {
  const select = el('select', { class: 'input' }) as HTMLSelectElement;
  select.append(el('option', { value: DIRECT }, 'Direct'));
  for (const p of config.profiles) {
    if (p.id === ownerId) continue;
    if (reachableFrom(config, p.id).has(ownerId)) continue; // would cycle
    select.append(el('option', { value: p.id }, p.name));
  }
  select.value = [...select.options].some((o) => o.value === value) ? value : DIRECT;
  select.onchange = () => onChange(select.value);
  return select;
}

/* ---------- proxy editor ---------- */

/**
 * Whether each optional permission is currently granted; null until the first
 * check resolves. Kept fresh so the banners below can flag settings that
 * arrived without their grant — an optional permission never travels with a
 * config, so an import or another device can only ever carry the setting.
 */
let authPermGranted: boolean | null = null;
let tabsPermGranted: boolean | null = null;
/**
 * "webNavigation" — the badge's second grant, tracked apart from "tabs" because
 * installs that enabled the badge before it existed hold one and not the other.
 * Without it the badge is correct but late: it cannot see a navigation that
 * never commits, which is the case it most needs to see.
 */
let navPermGranted: boolean | null = null;
/**
 * "Allow in Incognito" — Chrome's own switch, not an optional permission, so it
 * cannot be requested and never fires permissions.onAdded. Tracked here with
 * the two above because it fails the same way: a setting that is on and inert.
 * Granting it reloads the extension, which reloads this page, so a stale answer
 * cannot outlive the change.
 */
let incognitoAccessGranted: boolean | null = null;
/**
 * Whether Sockitt has a toolbar button. Not a permission either, but it fails
 * the same way: unpinned, Chrome gives the icon nowhere it can be kept current,
 * so it stops naming the active profile (see the worker's actionIsPinned).
 */
let actionPinned: boolean | null = null;
/**
 * A version Chrome has downloaded but not swapped in. Not a permission either,
 * but it belongs with the three above for the same reason: something is set up
 * and not taking effect, and nothing on this page would otherwise say so.
 */
let pendingUpdate: PendingUpdate | null = null;

/**
 * Kept apart from refreshPermState: this answer moves on a storage write rather
 * than on a grant, so it has its own triggers and no business being awaited
 * alongside four permission checks that run on every one of theirs.
 */
async function refreshUpdateState(): Promise<void> {
  const next = await loadPendingUpdate();
  if (next?.version === pendingUpdate?.version) return;
  pendingUpdate = next;
  updatePermBanners();
}

async function refreshPermState(): Promise<void> {
  const [auth, tabs, nav, incognito, userSettings] = await Promise.all([
    chrome.permissions.contains(AUTH_PERMS).catch(() => false),
    chrome.permissions.contains(TABS_PERMS).catch(() => false),
    chrome.permissions.contains(NAV_PERMS).catch(() => false),
    chrome.extension.isAllowedIncognitoAccess().catch(() => false),
    chrome.action.getUserSettings().catch(() => ({ isOnToolbar: true })),
  ]);
  const pinned = userSettings.isOnToolbar !== false;
  // Neither of these is a permission, so neither fires permissions.onAdded — the
  // change gate below has to know they moved or the banners would not follow.
  const asideMoved = incognito !== incognitoAccessGranted || pinned !== actionPinned;
  incognitoAccessGranted = incognito;
  actionPinned = pinned;
  // Told BEFORE the change gate below, not after: this page tracks the answer
  // for its own banner and returns early when nothing moved, so gating the
  // dashboard on that would starve it of the very first answer. setAuthGranted
  // does its own no-op check.
  setAuthGranted(auth);
  if (auth === authPermGranted && tabs === tabsPermGranted && nav === navPermGranted && !asideMoved)
    return;
  authPermGranted = auth;
  tabsPermGranted = tabs;
  navPermGranted = nav;
  updatePermBanners();
}

async function requestAuthPermission(): Promise<boolean> {
  const has = await chrome.permissions.contains(AUTH_PERMS).catch(() => false);
  if (has) {
    authPermGranted = true;
    updatePermBanners();
    return true;
  }
  const granted = await chrome.permissions.request(AUTH_PERMS).catch(() => false);
  toast(granted ? 'Authentication enabled' : 'Permission needed for proxy auth');
  authPermGranted = granted;
  updatePermBanners();
  return granted;
}

/**
 * The "tabs" grant the per-tab badge needs. Called both when the toggle is
 * switched on and when a config arrives with the setting already true, so the
 * setting and the grant can be brought back into agreement from either side.
 */
async function requestTabsPermission(): Promise<boolean> {
  if (await chrome.permissions.contains(BADGE_PERMS).catch(() => false)) {
    tabsPermGranted = true;
    navPermGranted = true;
  } else {
    // Both at once: Chrome's "tabs" warning absorbs "webNavigation", so this is
    // one prompt saying what "tabs" alone already said.
    const granted = await chrome.permissions.request(BADGE_PERMS).catch(() => false);
    toast(granted ? 'Per-tab badge enabled' : 'Permission needed for the per-tab badge');
    tabsPermGranted = granted || (await chrome.permissions.contains(TABS_PERMS).catch(() => false));
    navPermGranted = granted;
  }
  updatePermBanners();
  return tabsPermGranted;
}

/** Credentials exist but the permission to answer challenges doesn't. */
function authPermMissing(): boolean {
  return authPermGranted === false && proxyProfiles(config).some(hasCredentials);
}

/** The badge setting is on but the permission that makes it paint isn't. */
function badgePermMissing(): boolean {
  return tabsPermGranted === false && config.settings.badgeResult;
}

/**
 * The badge can paint, but cannot see a navigation start — so it goes stale for
 * exactly as long as a page takes to fail. The state an install that enabled
 * the badge before "webNavigation" was asked for sits in.
 */
function badgeNavPermMissing(): boolean {
  return navPermGranted === false && tabsPermGranted === true && config.settings.badgeResult;
}

/** A profile is chosen for incognito, but Chrome won't let Sockitt near it. */
function incognitoAccessMissing(): boolean {
  return incognitoAccessGranted === false && !!config.settings.incognitoProfileId;
}

/** No toolbar button, so no icon that can be kept up to date. */
function actionUnpinned(): boolean {
  return actionPinned === false;
}

/**
 * Sockitt's own row on the extensions page, where "Allow in Incognito" lives.
 * A link cannot go there — chrome:// is not navigable from an extension page —
 * but tabs.create can, and the ?id= form opens the Details view directly rather
 * than leaving the user to find Sockitt in a list.
 */
function openExtensionDetails(): void {
  void chrome.tabs
    .create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })
    .catch(() => undefined);
}

/** ipconfig.is origin grant, needed by the exit-IP check and the proxy test. */
async function ensureExitIpPermission(): Promise<boolean> {
  const has = await chrome.permissions.contains(EXIT_IP_PERMS).catch(() => false);
  if (has) return true;
  return chrome.permissions.request(EXIT_IP_PERMS).catch(() => false);
}

/**
 * Every setting that is switched on but inert until the user acts. Most need a
 * grant only the user can give; two (pinning, a staged update) need something
 * no extension API can do at all, so they say where to go instead of offering
 * a button that would only pretend to. Listed on Settings, under the Overview's
 * "Needs attention", and counted on the Settings tab while any needs a yes.
 */
function permAsks(): PermAsk[] {
  const asks: PermAsk[] = [];
  if (authPermMissing()) {
    asks.push({
      id: 'auth',
      tone: 'warn',
      icon: 'lock',
      title: 'Proxy sign-in isn’t allowed yet',
      body: 'A proxy has a username and password, but Chrome won’t let Sockitt answer a proxy’s sign-in until you allow it, so requests through it stop at a login prompt.',
      action: { label: 'Allow sign-in', run: () => void requestAuthPermission() },
    });
  }
  if (badgePermMissing()) {
    asks.push({
      id: 'badge',
      tone: 'warn',
      icon: 'alert',
      title: 'The route badge can’t see your tabs',
      body: 'It is switched on, but the optional “tabs” permission it needs hasn’t been granted, so the badge stays blank.',
      action: { label: 'Allow', run: () => void requestTabsPermission() },
    });
  }
  if (badgeNavPermMissing()) {
    asks.push({
      id: 'badge-nav',
      tone: 'warn',
      icon: 'alert',
      title: 'The route badge can’t see a page start loading',
      body: 'Chrome reports a navigation only when it commits, so a site that hangs - the moment you look at the badge to ask why - leaves it naming the last page’s profile. Navigation access fixes that, and adds no new warning: the badge’s permission already covers it.',
      action: { label: 'Allow', run: () => void requestTabsPermission() },
    });
  }
  if (incognitoAccessMissing()) {
    asks.push({
      id: 'incognito',
      tone: 'warn',
      icon: 'incognito',
      title: 'Chrome hasn’t let Sockitt into incognito',
      body: `Incognito windows are set to use ${nameFor(config.settings.incognitoProfileId)}, but until you switch on Allow in Incognito they follow the regular profile. No extension can grant itself that, so this opens Sockitt’s details for you to flip it.`,
      action: { label: 'Open Sockitt’s details', run: openExtensionDetails },
    });
  }
  if (actionUnpinned()) {
    // No button: pinning is done from Chrome's own puzzle-piece menu, which no
    // extension API can open.
    asks.push({
      id: 'pin',
      tone: 'info',
      icon: 'pin',
      title: 'Sockitt isn’t pinned to the toolbar',
      body: 'Unpinned, its icon shows the plain mark instead of the active profile, and the puzzle-piece menu reads it once and never updates it. Click the puzzle piece in the toolbar, then the pin beside Sockitt.',
    });
  }
  if (pendingUpdate) {
    // No button, for the same reason the unpinned notice has none: nothing
    // Sockitt can call would finish this. chrome.runtime.reload() does apply a
    // staged version, but it would also tear the worker down mid-connection-test
    // — and a test holds the live proxy configuration and puts it back in a
    // finally that a reload never reaches. Restarting the browser is both the
    // safe way and the user's own.
    const waited = pendingUpdate.at > 0 ? ` It arrived ${agoInWords(pendingUpdate.at)}.` : '';
    asks.push({
      id: 'update',
      tone: 'info',
      icon: 'refresh',
      title: `Sockitt ${pendingUpdate.version} is downloaded but not running`,
      body: `This window still runs ${chrome.runtime.getManifest().version}. Chrome swaps a new version in only while Sockitt is idle, and Sockitt wakes often enough that it may not be offered one for days.${waited} Restarting the browser finishes it now.`,
    });
  }
  return asks;
}

/** The ones that need a yes — what the Settings tab counts. Information alone is not a count. */
function pendingAsks(): number {
  return permAsks().filter((a) => a.tone === 'warn').length;
}

/**
 * What needs a yes, in the tinted panel — the same count the Settings tab
 * carries — and, under it, what is only worth knowing: those have no button,
 * because no extension can do them, so they are not asks.
 */
function asksSections(asks: PermAsk[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  const needs = asks.filter((a) => a.tone === 'warn');
  const notes = asks.filter((a) => a.tone !== 'warn');
  if (needs.length) {
    const node = el(
      'section',
      { class: 'asks' },
      el('h2', { class: 't-h3', id: 'asks-h' }, 'Needs your OK', el('span', { class: 'meta tnum' }, String(needs.length))),
      el('ul', { class: 'todo' }, ...needs.map(askRow))
    );
    node.setAttribute('aria-labelledby', 'asks-h');
    out.push(node);
  }
  if (notes.length) {
    const node = el('section', { class: 'notes' }, el('h2', { class: 'vh', id: 'notes-h' }, 'Worth knowing'), el('ul', { class: 'todo' }, ...notes.map(askRow)));
    node.setAttribute('aria-labelledby', 'notes-h');
    out.push(node);
  }
  return out;
}

/** Repaint the lists in place — never a full render, which would eat a half-typed field. */
function paintAsks(): void {
  const slot = app.querySelector<HTMLElement>('.asks-slot');
  if (!slot) return;
  slot.replaceChildren(...asksSections(permAsks()));
}

/** "yesterday", "3 days ago" — relativeTime's abbreviations read badly in a sentence. */
function agoInWords(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/**
 * Bring every place an ask is shown up to date, in place: permission state can
 * change while the user is mid-typing in an editor (the prompt is triggered
 * from a field's onchange), and a full render would wipe the uncommitted
 * sibling field.
 */
function updatePermBanners(): void {
  paintAsks();
  refreshNav();
  refreshListRoute?.();
  if (selectedId === DASH_ID && dashboardMounted()) repaintDashboard();
}

/* ---------- the editors' map ---------- */

/**
 * Names for a compact map's line ends. Read from the map's own kind, not the
 * profile's: an alias draws the profile it points at, and its lines mean what
 * that profile's do.
 */
function mapNames(layout: YardLayout): Map<string, { name: string; sub?: string }> {
  const names = new Map<string, { name: string; sub?: string }>();
  for (const t of layout.tracks) {
    let sub: string | undefined;
    if (layout.kind === 'proxy') sub = t.isDefault ? 'everything else' : 'the bypass list';
    else if (t.isDefault && (layout.kind === 'switch' || layout.kind === 'rulelist')) sub = 'everything else';
    else if (layout.kind === 'rulelist') sub = 'on the list';
    names.set(t.id, { name: nameFor(t.id), sub });
  }
  return names;
}

/** The map at the top of an editor: how this profile routes, compact. */
function editorMapSvg(profile: Profile, hilite: string | null = null): SVGSVGElement {
  const layout = layoutYard(config, profile.id, COMPACT);
  const parts = layout.junctions.map((j) =>
    j.key === 'bypass'
      ? `its bypass list (${j.fullText}) goes direct`
      : j.key === 'list'
        ? `list entries go to ${j.targets.map(nameFor).join(', ') || nameFor(layout.defaultTarget)}`
        : `rule ${j.label}${j.off ? ' (off)' : ''} ${j.fullText}${j.targets.length ? ` to ${j.targets.map(nameFor).join(', ')}` : ''}`
  );
  return yardSvg({
    layout,
    names: mapNames(layout),
    hilite,
    ariaLabel: `Track map of ${profile.name}: ${parts.length ? parts.join('; ') + '; ' : ''}everything else goes to ${nameFor(layout.defaultTarget)}.`,
  });
}

/**
 * A target picker with the chosen destination's line key inside it. Offers
 * Direct plus every profile that would not create a cycle back to the owner.
 */
function viaSelect(ownerId: string, value: string, onChange: (v: string) => void, opts: { quiet?: boolean; label?: string } = {}): HTMLElement {
  const select = targetSelect(ownerId, value, () => undefined);
  if (opts.label) select.setAttribute('aria-label', opts.label);
  const key = el('span', { class: 'key' });
  const paint = (): void => {
    paintRoute(key, lineColour(config, select.value));
    key.classList.toggle('system', select.value === SYSTEM);
  };
  paint();
  select.onchange = () => {
    paint();
    onChange(select.value);
  };
  return el('div', { class: `via${opts.quiet ? ' quiet' : ''}` }, key, select);
}

/* ---------- proxy editor ---------- */

function proxyEditor(profile: ProxyProfile): HTMLElement {
  const mapHolder = el('figure', { class: 'ed-map' }, editorMapSvg(profile));
  const repaintMap = (): void => mapHolder.replaceChildren(editorMapSvg(profile));

  const seg = el(
    'div',
    { class: 'seg', role: 'radiogroup', ariaLabel: 'Protocol' },
    ...Object.entries(SCHEME_LABELS).map(([value, label]) =>
      el(
        'label',
        {},
        el('input', {
          type: 'radio',
          name: `proto-${profile.id}`,
          value,
          checked: profile.scheme === value,
          onchange: () => {
            // Deliberately keep username/password: a transient flip through a
            // SOCKS option must not destroy saved credentials. The sanitizer
            // drops them at the load boundary if the profile stays on a scheme
            // that can't use them.
            profile.scheme = value as ProxyScheme;
            scheduleSave();
            render();
          },
        }),
        label
      )
    )
  );

  // role="alert" makes each error a live region, so a screen reader announces
  // the validation message when it appears.
  const hostErr = el('span', { class: 'note error', role: 'alert' });
  const host = el('input', {
    class: 'input mono',
    value: profile.host,
    placeholder: '127.0.0.1',
    spellcheck: false,
    oninput: () => {
      invalidateTest();
      const err = proxyHostError(host.value);
      host.classList.toggle('invalid', err !== null);
      host.ariaInvalid = err !== null ? 'true' : 'false';
      host.title = err ?? '';
      hostErr.textContent = err ?? '';
      // Only a valid host is committed: a blank or directive-breaking value
      // would be applied and fail silently to DIRECT.
      if (!err) {
        profile.host = host.value.trim();
        scheduleSave();
      }
    },
  }) as HTMLInputElement;

  const portErr = el('span', { class: 'note error', role: 'alert' });
  const port = el('input', {
    class: 'input mono',
    value: String(profile.port),
    type: 'number',
    min: '1',
    max: '65535',
    oninput: () => {
      invalidateTest();
      const n = Number(port.value);
      const ok = Number.isInteger(n) && n >= 1 && n <= 65535;
      port.classList.toggle('invalid', !ok);
      port.ariaInvalid = ok ? 'false' : 'true';
      portErr.textContent = ok ? '' : 'Use a port between 1 and 65535';
      if (ok) {
        profile.port = n;
        scheduleSave();
      }
    },
  }) as HTMLInputElement;

  const bypass = el('textarea', {
    class: 'input mono',
    rows: 4,
    value: profile.bypass.join('\n'),
    placeholder: '<local>\n*.internal.example\n10.0.0.0/8',
    spellcheck: false,
    oninput: () => {
      profile.bypass = bypass.value.split('\n').map((s) => s.trim()).filter(Boolean);
      scheduleSave();
      repaintMap();
    },
  }) as HTMLTextAreaElement;

  const testResult = el('span', { class: 'note test-result', dataset: { profile: profile.id } });
  /**
   * Drop a previous verdict once the address it was about changes; a test in
   * flight is marked stale instead, and watchProxyTests drops its answer.
   */
  const invalidateTest = (): void => {
    if (!testResult.textContent) return;
    if ((testBtn as HTMLButtonElement).disabled) testResult.dataset.stale = '1';
    testResult.replaceChildren();
    testResult.removeAttribute('title');
    testResult.classList.remove('ok', 'bad');
  };

  const ipLookupsOn = config.settings.exitIpCheck;
  const testBtn = el(
    'button',
    {
      class: 'btn test-btn',
      type: 'button',
      disabled: !ipLookupsOn,
      dataset: { profile: profile.id },
      onclick: () => void startProxyTest(profile, testBtn as HTMLButtonElement, testResult),
    },
    'Test connection'
  );

  const signIn = schemeSupportsAuth(profile.scheme)
    ? authSection(profile, invalidateTest)
    : el(
        'p',
        { class: 'note' },
        'Chromium cannot sign in to a SOCKS proxy - secure it by IP allow-list, or reach it through a local tunnel (',
        el('span', { class: 'mono nowrap' }, 'ssh -D'),
        ').'
      );

  return el(
    'div',
    { class: 'ed-pane' },
    editorHead(profile),
    mapHolder,
    section(
      'Server',
      'Where Chrome connects.',
      el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Protocol'), seg),
      el('div', { class: 'pform-row port' }, field('Host', host, { extra: [hostErr] }), field('Port', port, { extra: [portErr] }))
    ),
    section('Sign-in', schemeSupportsAuth(profile.scheme) ? 'Only if the proxy asks for one.' : null, signIn),
    section(
      'Bypass list',
      'Goes straight out, never through the proxy.',
      field('One host or pattern per line', bypass, {
        extra: [el('span', { class: 'note' }, '<local> covers localhost, 127.0.0.1 and plain names with no dot. *.suffix wildcards and IPv4 CIDR blocks work too.')],
      })
    ),
    section(
      'Test',
      el('span', {}, 'One request through the proxy to ', el('span', { class: 'mono' }, 'ipconfig.is'), '.'),
      el('div', { class: 'test-row' }, testBtn, testResult),
      el(
        'p',
        { class: 'note' },
        ipLookupsOn
          ? 'Routes your browsing through this proxy for a few seconds to fetch ipconfig.is - exit address, country, latency - then puts your configuration back.'
          : 'The test asks ipconfig.is, a service the Sockitt developer runs - turn on IP address lookups in Settings to use it.'
      )
    ),
    identityPanel(profile)
  );
}

/**
 * Route one request through a proxy to ipconfig.is and report into `out`. The
 * worker owns chrome.proxy, so the request — with the profile's current
 * values, saved or not — goes over session storage; watchProxyTests paints the
 * verdict into every result node for that profile and gives the button back.
 */
async function startProxyTest(profile: ProxyProfile, button: HTMLButtonElement, out: HTMLElement): Promise<void> {
  out.classList.remove('ok', 'bad');
  if (!config.settings.exitIpCheck) {
    out.textContent = 'Turn on IP address lookups in Settings to test.';
    return;
  }
  if (!(await ensureExitIpPermission())) {
    out.textContent = 'Needs access to ipconfig.is to run the check.';
    return;
  }
  if (hasCredentials(profile) && !(await chrome.permissions.contains(AUTH_PERMS).catch(() => false))) {
    // Without the auth grant a 407 goes unanswered and the test would fail a
    // proxy that is actually fine.
    out.textContent = 'Credentials are set but sign-in is not allowed yet - allow it under Sign-in first.';
    return;
  }
  button.disabled = true;
  out.textContent = 'Testing - briefly routing through this proxy…';
  out.removeAttribute('title');
  delete out.dataset.stale;
  await chrome.storage.session.set({
    [TEST_KEY]: { profileId: profile.id, nonce: Date.now(), scheme: profile.scheme, host: profile.host, port: profile.port },
  });
}

function authSection(profile: ProxyProfile, invalidateTest: () => void): HTMLElement {
  const changed = (): void => {
    invalidateTest();
    scheduleSave();
    if (hasCredentials(profile)) void requestAuthPermission().then(() => paintNote());
    else {
      updatePermBanners();
      paintNote();
    }
  };
  const username = el('input', {
    class: 'input',
    value: profile.username ?? '',
    autocomplete: 'off',
    spellcheck: false,
    onchange: () => {
      profile.username = username.value.trim() || undefined;
      changed();
    },
  }) as HTMLInputElement;
  const password = el('input', {
    class: 'input',
    type: 'password',
    value: profile.password ?? '',
    autocomplete: 'off',
    onchange: () => {
      profile.password = password.value || undefined;
      changed();
    },
  }) as HTMLInputElement;

  const note = el('div', { class: 'auth-note' });
  const paintNote = (): void => {
    if (hasCredentials(profile) && authPermGranted === false) {
      note.replaceChildren(
        el(
          'div',
          { class: 'callout' },
          el('p', {}, 'Chrome won’t let Sockitt answer a proxy’s sign-in until you allow it, so requests through this proxy stop at a login prompt. Sockitt asks only now that it has a password to send.'),
          el('div', { class: 'acts' }, el('button', { class: 'btn', type: 'button', onclick: () => void requestAuthPermission().then(paintNote) }, 'Allow sign-in'))
        )
      );
    } else {
      note.replaceChildren(
        el('p', { class: 'note' }, 'Used only for HTTP and HTTPS proxies. Answering a sign-in needs an optional permission, asked for when you set credentials. Credentials stay on this device - they are never synced.')
      );
    }
  };
  paintNote();

  return el(
    'div',
    { class: 'auth' },
    el('div', { class: 'pform-row' }, field('Username', username), field('Password', password)),
    note
  );
}

/* ---------- switch editor ---------- */

function switchEditor(profile: SwitchProfile): HTMLElement {
  /** The rule whose row is pointed at — its junction is drawn heavier. */
  let hilite: string | null = null;
  const mapHolder = el('figure', { class: 'ed-map' });
  const repaintMap = (): void => mapHolder.replaceChildren(editorMapSvg(profile, hilite));
  repaintMap();

  const rulesBox = el('div', { class: 'rules' });

  const ruleRow = (rule: SwitchProfile['rules'][number], index: number): HTMLElement => {
    const typeSel = el('select', { class: 'input' }) as HTMLSelectElement;
    for (const [value, label] of Object.entries(RULE_TYPES)) typeSel.append(el('option', { value }, label));
    typeSel.value = rule.type;
    typeSel.setAttribute('aria-label', `Condition, rule ${index + 1}`);

    const pattern = el('input', {
      class: 'input mono',
      value: rule.pattern,
      placeholder: placeholderFor(rule.type),
      spellcheck: false,
      ariaLabel: `Pattern, rule ${index + 1}`,
    }) as HTMLInputElement;

    const markValidity = (): void => {
      const err = patternError(rule);
      pattern.classList.toggle('invalid', !!err);
      pattern.ariaInvalid = err ? 'true' : 'false';
      pattern.title = err ?? '';
    };
    markValidity();

    typeSel.onchange = () => {
      rule.type = typeSel.value as RuleType;
      pattern.placeholder = placeholderFor(rule.type);
      markValidity();
      scheduleSave();
      repaintMap();
    };
    pattern.oninput = () => {
      rule.pattern = pattern.value;
      markValidity();
      scheduleSave();
      repaintMap();
    };

    const enabled = el('input', {
      class: 'toggle',
      type: 'checkbox',
      ariaLabel: `Rule ${index + 1} on`,
      checked: rule.enabled,
      onchange: () => {
        rule.enabled = enabled.checked;
        row.classList.toggle('disabled', !rule.enabled);
        scheduleSave();
        repaintMap();
      },
    }) as HTMLInputElement;

    const row = el(
      'div',
      { class: `rule${rule.enabled ? '' : ' disabled'}`, dataset: { id: rule.id } },
      el('button', {
        class: 'grip',
        type: 'button',
        title: 'Drag to reorder, or focus and press Alt + ↑ / ↓',
        ariaLabel: `Reorder rule ${index + 1}`,
        draggable: true,
      }),
      el('span', { class: 'rule-n mono' }, String(index + 1)),
      el('div', { class: 'quiet-sel' }, typeSel),
      pattern,
      viaSelect(profile.id, rule.targetId, (v) => {
        rule.targetId = v;
        scheduleSave();
        repaintMap();
      }, { quiet: true, label: `Route via, rule ${index + 1}` }),
      enabled,
      el('button', {
        class: 'btn quiet icon sm rule-x',
        type: 'button',
        title: 'Delete rule',
        ariaLabel: `Delete rule ${index + 1}`,
        onclick: () => {
          profile.rules = profile.rules.filter((r) => r.id !== rule.id);
          scheduleSave();
          render();
        },
      }, icon('x', 'sm'))
    );
    row.querySelector('.grip')!.append(icon('grip', 'sm'));
    // Pointing at a rule finds it on the map.
    const point = (on: boolean): void => {
      const next = on ? rule.id : null;
      if (hilite === next) return;
      hilite = next;
      repaintMap();
    };
    row.addEventListener('mouseenter', () => point(true));
    row.addEventListener('mouseleave', () => point(row.contains(document.activeElement)));
    row.addEventListener('focusin', () => point(true));
    row.addEventListener('focusout', (e) => point(row.contains(e.relatedTarget as Node | null)));
    wireDrag(row, rulesBox, () => {
      const order = [...rulesBox.querySelectorAll<HTMLElement>('.rule:not(.rule-default)')].map((n) => n.dataset.id);
      profile.rules.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      renumberRules();
      scheduleSave();
      repaintMap();
    });
    return row;
  };

  /**
   * Reordering never re-renders — it moves the live row and sorts the model — so
   * the numbers and the screen-reader names are put right here.
   */
  const renumberRules = (): void => {
    rulesBox.querySelectorAll<HTMLElement>('.rule:not(.rule-default)').forEach((n, i) => {
      const k = i + 1;
      n.querySelector('.rule-n')!.textContent = String(k);
      n.querySelector('.grip')?.setAttribute('aria-label', `Reorder rule ${k}`);
      n.querySelector('.toggle')?.setAttribute('aria-label', `Rule ${k} on`);
      n.querySelector('.rule-x')?.setAttribute('aria-label', `Delete rule ${k}`);
      n.querySelector('select.input')?.setAttribute('aria-label', `Condition, rule ${k}`);
      n.querySelector('input.mono')?.setAttribute('aria-label', `Pattern, rule ${k}`);
      n.querySelector('.via select')?.setAttribute('aria-label', `Route via, rule ${k}`);
    });
  };

  rulesBox.append(
    el(
      'div',
      { class: 'rule-head', ariaHidden: 'true' },
      el('span'),
      el('span', {}, '#'),
      el('span', {}, 'Condition'),
      el('span', {}, 'Pattern'),
      el('span', {}, 'Route via'),
      el('span', {}, 'On'),
      el('span')
    ),
    ...profile.rules.map(ruleRow),
    el(
      'div',
      { class: 'rule rule-default' },
      el('span'),
      el('span'),
      el('span', { class: 'rule-default-t' }, el('b', {}, 'Everything else'), el('span', { class: 'meta' }, ' when no rule above matches')),
      viaSelect(profile.id, profile.defaultTargetId, (v) => {
        profile.defaultTargetId = v;
        scheduleSave();
        repaintMap();
      }, { quiet: true, label: 'Route everything else via' }),
      el('span'),
      el('span')
    )
  );

  const addRule = el(
    'button',
    {
      class: 'btn sm',
      type: 'button',
      onclick: () => {
        profile.rules.push({ id: uid(), enabled: true, type: 'hostWildcard', pattern: '', targetId: proxyProfiles(config)[0]?.id ?? DIRECT });
        scheduleSave();
        render();
        [...app.querySelectorAll<HTMLInputElement>('.rules .rule:not(.rule-default) input.mono')].pop()?.focus();
      },
    },
    icon('plus', 'sm'),
    'Add rule'
  );

  return el(
    'div',
    { class: 'ed-pane' },
    editorHead(profile),
    mapHolder,
    el(
      'section',
      { class: 'rules-sec', ariaLabel: 'Rules' },
      el('div', { class: 'rules-head' }, el('h2', { class: 't-h3' }, 'Rules'), el('p', { class: 'meta' }, 'Drag to reorder. Point at a rule to find it on the map.'), addRule),
      rulesBox
    ),
    identityPanel(profile)
  );
}

function placeholderFor(type: RuleType): string {
  switch (type) {
    case 'hostWildcard': return '*.example.com';
    case 'hostRegex': return '(^|\\.)example\\.(com|net)$';
    case 'urlWildcard': return 'https://example.com/api/*';
    case 'urlRegex': return '^https?://example\\.com/';
    case 'ipCidr': return '10.0.0.0/8';
    case 'keyword': return 'tracker';
    case 'hostLevels': return '2-4';
    case 'weekday': return 'mon-fri';
    case 'time': return '09:00-17:30';
  }
}

/* ---------- rule list editor ---------- */

/**
 * Put the caret on a 1-based line of a textarea and bring it into view.
 *
 * scrollTop is set by proportion rather than by measuring the line: the field
 * is a fixed line-height monospace box, so line N is at (N-1)/total of the
 * scroll height, and that needs no layout read. Centred where there is room, so
 * the offending line lands in the middle of the box rather than at its edge.
 */
function selectLine(field: HTMLTextAreaElement, line: number): void {
  const lines = field.value.split('\n');
  if (line < 1 || line > lines.length) return;
  let start = 0;
  for (let i = 0; i < line - 1; i++) start += (lines[i]?.length ?? 0) + 1;
  field.focus();
  field.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
  const ratio = (line - 1) / Math.max(1, lines.length);
  field.scrollTop = Math.max(0, ratio * field.scrollHeight - field.clientHeight / 2);
}

/**
 * What the rule-list editor's route line needs beyond the config: the per-site
 * overrides on the active profile, which the PAC tries first, and who controls
 * Chrome's proxy setting. Module scope, so a repaint does not wait on storage.
 */
const listRouteCtx: { overrides: SwitchRule[]; control: string } = { overrides: [], control: '' };
/** Repaints the open rule-list editor's route line; replaced by each editor. */
let refreshListRoute: (() => void) | null = null;

async function loadListRouteCtx(): Promise<void> {
  const [overrides, session] = await Promise.all([
    loadTempRules(config.activeId, 'regular').catch(() => [] as SwitchRule[]),
    chrome.storage.session.get(CONTROL_KEY).catch(() => ({}) as Record<string, unknown>),
  ]);
  listRouteCtx.overrides = overrides;
  const level = (session as Record<string, { level?: unknown } | undefined>)[CONTROL_KEY]?.level;
  listRouteCtx.control = typeof level === 'string' ? level : '';
}

/** Long enough for a 4 MB list over a slow proxy; short enough that a server that never answers gives the button back. */
const LIST_FETCH_TIMEOUT_S = 60;

/** The last fetch of each list, as the editor shows it under Update now. Session-only. */
const listFetchResults = new Map<string, { ok: boolean; text: string; at: number }>();

/**
 * A fetch route named for the explainer — the proxy's name, endpoint and
 * protocol. Chrome's own word on who controls the proxy comes first: while
 * another extension (or a policy) holds it, Sockitt's route is not the one the
 * request takes, so naming it would blame the wrong proxy.
 */
function routeNameFor(r: FetchRoute, control = listRouteCtx.control): RouteName {
  if (control === 'controlled_by_other_extensions') return { via: 'other' };
  if (control === 'not_controllable') return { via: 'policy' };
  if (r.targetId === DIRECT || r.targetId === '') return { via: 'direct' };
  if (r.targetId === SYSTEM) return { via: 'system' };
  const p = config.profiles.find((x) => x.id === r.targetId);
  if (p?.kind !== 'proxy') return { via: 'proxy', name: nameFor(r.targetId) };
  return { via: 'proxy', name: p.name, endpoint: `${SCHEME_LABELS[p.scheme]} ${p.host}:${p.port}`, scheme: p.scheme };
}

/** "directly" / "through Work SOCKS5", for the success line. */
function fetchedVia(named: RouteName): string {
  switch (named.via) {
    case 'direct':
      return 'directly';
    case 'system':
      return 'through your system’s proxy settings';
    case 'other':
      return 'through another extension’s proxy settings';
    case 'policy':
      return 'through the proxy your system’s policy sets';
    case 'proxy':
      return `through ${named.name}`;
  }
}

/** The only codes chrome.proxy ever reports for a request (measured; Chromium forwards no others). */
const PROXY_FAULTS = new Set(['net::ERR_PROXY_CONNECTION_FAILED', 'net::ERR_TUNNEL_CONNECTION_FAILED', 'net::ERR_PROXY_AUTH_UNSUPPORTED']);

/**
 * Prefetch the URL to learn what kind of answer came back, when the reply
 * itself cannot be read: a <link rel=prefetch> needs no permission and no
 * cross-origin consent, and fires load for a 2xx and error for anything else
 * (measured on Chromium 155). true = 2xx, false = an error, undefined = no word.
 * A prefetch is cached for a few minutes, so a URL whose status changed since
 * the last failed attempt can read as it was — a narrow case, and a cache-
 * busting query could break signed URLs, so it is left at that.
 */
function prefetchVerdict(url: string, ms = 15_000): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = url;
    const done = (v: boolean | undefined): void => {
      clearTimeout(timer);
      link.remove();
      resolve(v);
    };
    const timer = setTimeout(() => done(undefined), ms);
    link.onload = () => done(true);
    link.onerror = () => done(false);
    document.head.append(link);
  });
}

/** A URL as Chrome reports it in webRequest: parsed, fragment dropped. */
function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    return u.href;
  } catch {
    return raw;
  }
}

/**
 * Fetch a list body, and when that fails, find out why. fetch() says only
 * "Failed to fetch" for every network failure, so the page gathers what else
 * it can see (all measured in real Chromium, 2026-10-14):
 *
 *   - chrome.proxy.onProxyError, with the always-granted `proxy` permission.
 *     It reports only a proxy that could not be reached or refused a tunnel,
 *     and for ALL traffic in the browser, within a few ms of the request that
 *     failed — so an event counts only on a proxied route, only at the moment
 *     this fetch failed, and never when a probe shows something did answer.
 *   - the exact net:: code from webRequest, when the optional grant happens to
 *     be in place, matched by request id (with it, cross-origin rules no
 *     longer apply either).
 *   - after a failure on a route that cannot raise a sign-in prompt (direct,
 *     or a SOCKS proxy), a no-cors probe: an opaque reply means SOME HTTP
 *     answer arrived; a rejection means none did. Then a prefetch says whether
 *     that answer was a 2xx (the list is there, but unreadable) or an error.
 *     Through an HTTP(S) proxy a second request could raise a second sign-in
 *     prompt, so those routes are explained without it.
 *   - elapsed time: Chrome gives up connecting after 30 seconds on its own.
 */
async function fetchListBody(
  url: string,
  named: RouteName,
  signInBlocked: boolean
): Promise<{ ok: true; text: string } | { ok: false; why: Explanation }> {
  let host = '';
  let https = true;
  try {
    const u = new URL(url);
    host = u.hostname;
    https = u.protocol === 'https:';
  } catch {
    /* listFetchRoute has already refused anything unparseable */
  }
  const fail = (f: ListFetchFailure): { ok: false; why: Explanation } => ({ ok: false, why: explainListFailure(f, named, host, https) });

  const proxyEvents: Array<{ code: string; at: number }> = [];
  const onProxyError = (d: { error?: string }): void => {
    if (d.error) proxyEvents.push({ code: d.error, at: performance.now() });
  };
  const ours = new Set<string>();
  let netError: string | undefined;
  const target = canonicalUrl(url);
  const onBeforeRequest = (d: chrome.webRequest.OnBeforeRequestDetails): undefined => {
    if ((d.initiator ?? '').startsWith(location.origin) && canonicalUrl(d.url) === target) ours.add(d.requestId);
    return undefined;
  };
  const onRequestError = (d: chrome.webRequest.OnErrorOccurredDetails): void => {
    if (ours.has(d.requestId)) netError = d.error;
  };
  const exactCodes =
    !!chrome.webRequest?.onErrorOccurred &&
    (await chrome.permissions.contains({ permissions: ['webRequest'], origins: ['<all_urls>'] }).catch(() => false));
  // Listening before the fetch starts: the event often arrives before the rejection.
  chrome.proxy?.onProxyError?.addListener(onProxyError);
  if (exactCodes) {
    chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, { urls: ['<all_urls>'] });
    chrome.webRequest.onErrorOccurred.addListener(onRequestError, { urls: ['<all_urls>'] });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIST_FETCH_TIMEOUT_S * 1000);
  const started = performance.now();
  try {
    let response: Response;
    try {
      response = await fetch(url, { cache: 'no-cache', signal: controller.signal });
    } catch {
      const failedAt = performance.now();
      // A sign-in Sockitt may not answer: the fetch either waited at Chrome's
      // prompt until the page gave up, or failed when the prompt was cancelled.
      if (controller.signal.aborted) return fail(signInBlocked ? { kind: 'signin' } : { kind: 'timeout', seconds: LIST_FETCH_TIMEOUT_S });
      // Chrome's own connect limit: a TLS handshake, a CONNECT or a SOCKS
      // greeting that never completes fails at 30 s with no other sign.
      if (failedAt - started >= 29_000) return fail({ kind: 'timeout', seconds: 30, connect: true });
      // This fetch's own event lands within a few ms of its rejection, either
      // side of it; anything earlier was some other request through the proxy.
      await new Promise((r) => setTimeout(r, 100));
      if (netError) return fail({ kind: 'network', netError });
      const fault =
        named.via === 'direct'
          ? undefined
          : proxyEvents.find(
              (e) =>
                e.at >= failedAt - 50 &&
                e.at <= failedAt + 100 &&
                PROXY_FAULTS.has(e.code) &&
                // A plain-http fetch is never tunnelled, so a tunnel failure is someone else's.
                !(e.code === 'net::ERR_TUNNEL_CONNECTION_FAILED' && !https)
            )?.code;
      let probe = !exactCodes && (named.via === 'direct' || (named.via === 'proxy' && /^socks/i.test(named.scheme ?? '')));
      // Another extension can take the proxy while a fetch is out, and its
      // proxy may want a sign-in of its own: ask Chrome who holds it now.
      if (probe) {
        const level = (await chrome.proxy?.settings?.get({}).catch(() => undefined))?.levelOfControl;
        if (level === 'controlled_by_other_extensions' || level === 'not_controllable') probe = false;
      }
      let answered = false;
      let listOk: boolean | undefined;
      if (probe) {
        try {
          await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
          answered = true;
        } catch {
          /* nothing answered either time */
        }
        if (answered) listOk = await prefetchVerdict(url);
      }
      // A proxy fault counts only when nothing contradicts it: a probe that got
      // an answer through the same route means the proxy was there.
      if (fault && !answered) {
        // A proxy with a sign-in answers CONNECT with a 407 before it looks at
        // the address, so a refused tunnel right after a prompt Sockitt could
        // not answer is almost always that sign-in.
        if (signInBlocked && fault === 'net::ERR_TUNNEL_CONNECTION_FAILED') return fail({ kind: 'signin', tunnel: true });
        return fail({ kind: 'network', proxyError: fault });
      }
      if (signInBlocked) return fail({ kind: 'signin' });
      return fail({ kind: 'network', answered, listOk });
    }
    if (!response.ok) return fail({ kind: 'status', status: response.status, statusText: response.statusText });
    let text: string;
    try {
      text = await response.text();
    } catch {
      if (controller.signal.aborted) return fail({ kind: 'timeout', seconds: LIST_FETCH_TIMEOUT_S });
      // The request's own error event trails the rejection, as above.
      if (exactCodes) await new Promise((r) => setTimeout(r, 100));
      return fail({ kind: 'body', netError });
    }
    if (!text.trim()) return fail({ kind: 'empty' });
    // Parsing is synchronous and sits on the PAC-compile path, so an unbounded
    // body is an unbounded stall — refuse it here rather than store something
    // the worker will choke on later.
    if (text.length > RULE_LIST_MAX_BYTES) return fail({ kind: 'too-large', maxBytes: RULE_LIST_MAX_BYTES });
    return { ok: true, text };
  } finally {
    clearTimeout(timer);
    chrome.proxy?.onProxyError?.removeListener(onProxyError);
    if (exactCodes) {
      chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
      chrome.webRequest.onErrorOccurred.removeListener(onRequestError);
    }
  }
}

/**
 * Fetch a rule list's body and store it. One copy, shared by the editor's
 * "Update now" and the dashboard's "Fetch now" — the care here is in the
 * re-find and the rollback, and two copies of that is one too many.
 *
 * Always repaints when it returns, whatever the outcome, so the caller's button
 * comes back without every call site having to remember to restore it. The
 * outcome is kept per list, so the editor can say it in full after the repaint.
 */
async function refetchRuleList(profileId: string): Promise<void> {
  const repaint = (): void => {
    if (selectedId === DASH_ID && dashboardMounted()) repaintDashboard();
    else render();
  };
  const before = config.profiles.find((p) => p.id === profileId);
  if (!before || before.kind !== 'rulelist') {
    toast('Profile no longer exists');
    repaint();
    return;
  }
  if (!before.url) {
    toast('Set a URL first');
    repaint();
    return;
  }
  // Fresh: the Overview's "Fetch now" can run before any editor loaded this.
  await loadListRouteCtx();
  const url = before.url;
  const route = listFetchRoute(config, url, listRouteCtx.overrides, profileId);
  if (route.invalid) {
    listFetchResults.set(profileId, { ok: false, text: route.invalid, at: Date.now() });
    toast(`Update failed: ${route.invalid}`, 5000);
    repaint();
    return;
  }
  const named = routeNameFor(route);
  const viaProxy = config.profiles.find((x) => x.id === route.targetId);
  const signInBlocked =
    named.via === 'proxy' && viaProxy?.kind === 'proxy' && hasCredentials(viaProxy) && authPermGranted === false;
  const result = await fetchListBody(url, named, signInBlocked);
  // The page's snapshot can be swapped out across that await — a popup write,
  // a second options tab or a sync pull all reassign `config` — which orphans
  // the profile captured before it. Writing to that one would drop the fetch on
  // the floor while the toast claimed success, so re-find it by id the way the
  // popup's commitConfig does.
  const live = config.profiles.find((p) => p.id === profileId);
  // Edited while the fetch was out: whatever came back belongs to the old
  // address — a body to throw away, or a failure the new one may not share.
  if (live?.kind === 'rulelist' && live.url !== url) {
    listFetchResults.set(profileId, { ok: false, text: 'The address changed while the list was being fetched, so nothing was saved - press Update now again.', at: Date.now() });
    toast('The address changed - press Update now again', 5000);
    repaint();
    return;
  }
  if (!result.ok) {
    listFetchResults.set(profileId, { ok: false, text: result.why.detail, at: Date.now() });
    toast(`Update failed: ${result.why.short}`, 5000);
    repaint();
    return;
  }
  try {
    if (!live || live.kind !== 'rulelist') throw new Error('Profile no longer exists');
    const prevText = live.text;
    const prevUpdated = live.lastUpdated;
    live.text = result.text;
    live.lastUpdated = Date.now();
    try {
      await saveConfig(config);
    } catch (e) {
      // Never leave a fetched body in a config that was not written: the editor
      // still shows the old text and the old count, and the next keystroke would
      // write that old text straight back over it.
      live.text = prevText;
      live.lastUpdated = prevUpdated;
      throw e;
    }
    // A list that decides its own address can move its next fetch: say so, or
    // "fetched directly" sits under a line that now says otherwise.
    const next = routeNameFor(listFetchRoute(config, url, listRouteCtx.overrides, profileId));
    const moved = fetchedVia(next) !== fetchedVia(named) ? ` The new list sends the next one ${fetchedVia(next)}.` : '';
    listFetchResults.set(profileId, { ok: true, text: `Fetched ${fetchedVia(named)}.${moved}`, at: Date.now() });
    toast('List updated');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    listFetchResults.set(profileId, { ok: false, text: `The list arrived but couldn’t be saved: ${message}`, at: Date.now() });
    toast(`Update failed: ${message}`, 5000);
  }
  repaint();
}

function ruleListEditor(profile: RuleListProfile): HTMLElement {
  const url = el('input', {
    class: 'input mono',
    value: profile.url,
    placeholder: 'https://example.com/gfwlist.txt',
    spellcheck: false,
    oninput: () => {
      profile.url = url.value.trim();
      refreshSizeWarn();
      // Settled, not per keystroke: the line is a live region.
      clearTimeout(routeTimer);
      routeTimer = setTimeout(paintFetchRoute, 250);
      // The last result was about the old address.
      if (listFetchResults.delete(profile.id)) fetchResult.replaceChildren();
      scheduleSave();
    },
  }) as HTMLInputElement;

  /*
   * Where "Update now" — and the automatic update — will fetch this URL
   * through. Not the OS route: the fetch is an ordinary request, so it takes
   * whatever the active profile decides for the list's host (System is the
   * only profile that hands it to the OS settings). Said here, before anyone
   * presses the button, because a list host that is only reachable through a
   * proxy needs a route there before its first fetch can succeed.
   */
  let routeTimer: ReturnType<typeof setTimeout> | undefined;
  const fetchRoute = el('p', { class: 'fetch-route', ariaLive: 'polite' });
  // The last Update now, in full: the toast says it in a line and is gone.
  const fetchResult = el('div', { class: 'fetch-result' });
  const last = listFetchResults.get(profile.id);
  if (last) {
    fetchResult.append(
      el(
        'p',
        // status, not alert: the editor is rebuilt on every save, and an alert
        // would announce a failure again each time.
        { role: 'status' },
        el('span', { class: `st ${last.ok ? 'good' : 'bad'}` }, last.ok ? 'Updated' : 'Update failed'),
        ` ${relativeTime(last.at)}. ${last.text}`
      )
    );
  }
  fetchRoute.title = 'Fetches follow whichever profile is active when they run - Update now, or the automatic update.';
  const paintFetchRoute = (): void => {
    const r = listFetchRoute(config, url.value, listRouteCtx.overrides, profile.id);
    if (r.invalid === '') {
      fetchRoute.replaceChildren();
      fetchRoute.hidden = true;
      return;
    }
    fetchRoute.hidden = false;
    if (r.invalid) {
      fetchRoute.replaceChildren(el('span', { class: 'st warn' }, r.invalid));
      return;
    }
    const ownLead: Array<Node | string> =
      r.targetId === DIRECT
        ? ['go ', el('b', {}, 'direct')]
        : r.targetId === SYSTEM
          ? ['use ', el('b', {}, 'your system’s proxy settings')]
          : ['go through ', el('b', {}, nameFor(r.targetId))];
    // Chrome's word on who holds the proxy comes first: while another extension
    // or a policy does, Sockitt's own route is not the one a fetch takes.
    if (listRouteCtx.control === 'controlled_by_other_extensions' || listRouteCtx.control === 'not_controllable') {
      const other = listRouteCtx.control === 'controlled_by_other_extensions';
      fetchRoute.replaceChildren(
        el(
          'span',
          { class: 'st warn' },
          other
            ? 'Fetches use another extension’s proxy settings - it controls the browser’s proxy right now.'
            : 'Fetches use the proxy this machine’s policy sets.'
        ),
        el('span', { class: 'meta' }, 'With Sockitt in control they would ', ...ownLead, ` - ${r.why}.`)
      );
      return;
    }
    const key = paintRoute(el('span', { class: `key${r.targetId === SYSTEM ? ' system' : ''}` }), lineColour(config, r.targetId));
    const parts: Array<Node | string> = [key, el('span', {}, 'Fetches ', ...ownLead, ` - ${r.why}.`)];
    if (r.selfRouted) {
      parts.push(el('span', { class: 'meta' }, ' This list decides its own address, so a refresh that changes the list can change where the next one goes.'));
    }
    // A sign-in Sockitt may not answer holds the fetch at Chrome's prompt
    // instead of failing it — the one way a fetch can hang without an error.
    const via = config.profiles.find((x) => x.id === r.targetId);
    if (via?.kind === 'proxy' && hasCredentials(via) && authPermGranted === false) {
      parts.push(
        el('span', { class: 'st warn' }, `${via.name} has a sign-in that Sockitt isn’t allowed to answer yet, so fetches through it will stop at a sign-in prompt - allow it under Sign-in in ${via.name}.`)
      );
    }
    fetchRoute.replaceChildren(...parts);
  };

  const format = el('select', { class: 'input' }) as HTMLSelectElement;
  format.append(
    el('option', { value: 'autoproxy' }, RULE_LIST_FORMAT_LABELS.autoproxy),
    el('option', { value: 'switchy' }, `${RULE_LIST_FORMAT_LABELS.switchy} (one per line)`)
  );
  format.value = profile.format;
  format.onchange = () => {
    profile.format = format.value as RuleListProfile['format'];
    scheduleSave();
    render();
  };

  const interval = el('input', {
    class: 'input mono',
    type: 'number',
    min: '0',
    max: '720',
    value: String(profile.updateIntervalH),
    oninput: () => {
      const n = Number(interval.value);
      if (Number.isFinite(n) && n >= 0 && n <= 720) {
        profile.updateIntervalH = n;
        scheduleSave();
      }
    },
  }) as HTMLInputElement;

  const source = el('textarea', {
    class: 'input mono rl-source',
    value: profile.text,
    // Format-aware: the AutoProxy sample used to show for both, so a domain
    // list demonstrated syntax it rejects — type it in verbatim and the editor
    // answers "2 lines ignored".
    placeholder:
      profile.format === 'autoproxy'
        ? '! Paste list content here, or set a URL and press Update now.\n||example.com\n|http://example.org/api\n@@||allowed.example.com'
        : '# Paste list content here, or set a URL and press Update now.\nexample.com\n*.ads.example.net\n@@safe.example.com',
    spellcheck: false,
    oninput: () => {
      profile.text = source.value;
      refreshReadout();
      refreshSizeWarn();
      scheduleSave();
    },
  }) as HTMLTextAreaElement;

  const status = el('span', { class: 'note' });

  // Name the most likely cause outright rather than leaving a bare count.
  const formatWarn = el(
    'span',
    { class: 'note warn', role: 'alert' },
    'This looks like a SwitchyOmega conditions list. Sockitt reads AutoProxy/GFWList ' +
      'and plain domain lists - SwitchyOmega’s typed conditions (UrlRegex:, Keyword:, ' +
      'Ip:) and its ! bypass lines are not supported and will be ignored.'
  );

  /**
   * Re-read the list and repaint the count. Runs on every keystroke: the point
   * of the readout is to tell you whether what you are typing parses, and a
   * figure describing the text as it was when the editor opened cannot do that.
   * Measured at 2 ms for 6,000 entries, so it stays well inside a frame and
   * needs no debounce — which would put the lag back.
   */
  /**
   * The ignored lines themselves, named. The count above says a line was
   * dropped; on anything longer than a screen that is a puzzle with no way in,
   * because nothing on the page said which line or why.
   *
   * Clicking one selects it in the textarea and scrolls it into view, so the
   * fix starts where the problem is.
   */
  const rejects = el('div', { class: 'rl-rejects' });

  const refreshRejects = (parsed: ReturnType<typeof parseRuleList>): void => {
    rejects.hidden = parsed.rejected.length === 0;
    if (rejects.hidden) return;
    const rows: HTMLElement[] = parsed.rejected.map((r) =>
      el(
        'button',
        {
          class: 'rl-reject',
          type: 'button',
          title: 'Select this line',
          onclick: () => selectLine(source, r.line),
        },
        el('span', { class: 'rl-reject-no mono' }, String(r.line)),
        el(
          'span',
          { class: 'rl-reject-body' },
          el('span', { class: 'rl-reject-text mono' }, r.text),
          el('span', { class: 'rl-reject-why' }, r.reason)
        )
      )
    );
    const hidden = parsed.ignored - parsed.rejected.length;
    if (hidden > 0) rows.push(el('p', { class: 'note' }, `…and ${hidden} more not listed.`));
    rejects.replaceChildren(...rows);
  };

  const refreshReadout = (): void => {
    const parsed = parseRuleList(profile.format, profile.text);
    status.textContent =
      `${parsed.count} entr${parsed.count === 1 ? 'y' : 'ies'} parsed` +
      // Silence about unreadable lines is what let a half-dead list look loaded.
      (parsed.ignored ? ` · ${parsed.ignored} line${parsed.ignored === 1 ? '' : 's'} ignored` : '') +
      (profile.lastUpdated ? ` · updated ${new Date(profile.lastUpdated).toLocaleString()}` : '');
    formatWarn.hidden = !looksLikeSwitchyOmega(profile.text);
    refreshRejects(parsed);
  };
  refreshReadout();

  // The readout says how many lines were understood; this says where to look
  // when that number is not what you expected.
  const syntaxHelp = el(
    'span',
    { class: 'note' },
    'Not sure of the syntax? ',
    el(
      'button',
      { class: 'linklike', type: 'button', onclick: () => openDocsAt('doc-rule-lists') },
      'See Docs → Rule lists'
    ),
    ' for both formats, with examples.'
  );

  // A pasted list with no URL and a body over the sync inline cap is dropped
  // from sync (slimConfig) and can't be refetched, so devices that never held
  // the text end up with an empty list. Warn where the paste happens.
  const sizeWarn = el('span', { class: 'note error', role: 'alert' });
  const refreshSizeWarn = (): void => {
    const tooBig = !profile.url && profile.text.length > INLINE_TEXT_MAX;
    sizeWarn.hidden = !tooBig;
    sizeWarn.textContent = tooBig
      ? 'This pasted list is too large to sync (over ~8 KB). Other devices won’t receive it - add a URL so they can fetch it, or paste it on each device.'
      : '';
  };
  refreshSizeWarn();

  const updateNow = el(
    'button',
    {
      class: 'btn',
      onclick: () => {
        // Deliberately not disabled when there is no URL: a disabled button
        // takes no focus, so the reason would only ever reach a mouse. The URL
        // field is a few rows up, so answer the click by pointing at it. No
        // repaint on this path — rebuilding the pane would throw the focus away.
        if (!profile.url) {
          toast('Set a URL first, or paste the list below');
          url.focus();
          return;
        }
        updateNow.textContent = 'Updating…';
        (updateNow as HTMLButtonElement).disabled = true;
        // refetchRuleList repaints when it settles, which rebuilds this button
        // in either outcome — there is nothing to restore by hand.
        void refetchRuleList(profile.id);
      },
    },
    'Update now'
  );

  const mapHolder = el('figure', { class: 'ed-map' }, editorMapSvg(profile));
  const repaintMap = (): void => mapHolder.replaceChildren(editorMapSvg(profile));

  paintFetchRoute();
  refreshListRoute = () => {
    if (fetchRoute.isConnected) paintFetchRoute();
  };
  void loadListRouteCtx().then(() => refreshListRoute?.());

  return el(
    'div',
    { class: 'ed-pane' },
    editorHead(profile),
    mapHolder,
    section(
      'Source',
      'Where the list comes from, and how often it is fetched again.',
      el(
        'div',
        { class: 'pform-row url' },
        field('URL', url, { extra: [fetchRoute] }),
        // The unit belongs under the control, not in the label: a two-line label
        // in a narrow column used to push this input off the URL input's baseline.
        field('Auto-update', interval, { extra: [el('span', { class: 'note' }, 'Hours · 0 = off')] })
      ),
      el('div', { class: 'rl-actions' }, field('Format', format), updateNow),
      fetchResult,
      el('p', { class: 'note' },
        'Unless Sockitt can already read every site, the URL’s host must allow cross-origin requests - raw.githubusercontent.com does. GFWList base64 payloads are decoded automatically.')
    ),
    section(
      'Routing',
      'Entries on the list go one way; the rest, and any whitelist line, the other.',
      el(
        'div',
        { class: 'pform-row' },
        field(
          'On the list, route via',
          viaSelect(profile.id, profile.matchTargetId, (v) => {
            profile.matchTargetId = v;
            scheduleSave();
            repaintMap();
          })
        ),
        field(
          'Everything else, via',
          viaSelect(profile.id, profile.defaultTargetId, (v) => {
            profile.defaultTargetId = v;
            scheduleSave();
            repaintMap();
          })
        )
      )
    ),
    section('List content', el('span', {}, status), el('div', { class: 'field' }, source, rejects, formatWarn, sizeWarn, syntaxHelp)),
    identityPanel(profile)
  );
}

/* ---------- virtual (alias) editor ---------- */

function virtualEditor(profile: VirtualProfile): HTMLElement {
  const mapHolder = el('figure', { class: 'ed-map' }, editorMapSvg(profile));
  // Who leans on this alias: retargeting it moves every one of them at once,
  // which is the reason to have one — so say who that is.
  const users = config.profiles.filter(
    (p) =>
      (p.kind === 'switch' && (p.defaultTargetId === profile.id || p.rules.some((r) => r.targetId === profile.id))) ||
      (p.kind === 'rulelist' && (p.matchTargetId === profile.id || p.defaultTargetId === profile.id))
  );
  return el(
    'div',
    { class: 'ed-pane' },
    editorHead(profile),
    mapHolder,
    section(
      'Target',
      'Switching to the alias, or any rule pointed at it, routes here.',
      field(
        'Routes via',
        viaSelect(profile.id, profile.targetId, (v) => {
          profile.targetId = v;
          scheduleSave();
          mapHolder.replaceChildren(editorMapSvg(profile));
        })
      ),
      el(
        'p',
        { class: 'note' },
        users.length
          ? `Used by ${users.map((u) => u.name).join(', ')}. Retargeting the alias moves all of ${users.length === 1 ? 'it' : 'them'} at once.`
          : 'Point switch rules and rule lists at an alias, then swap its target to retarget them all at once.'
      )
    ),
    identityPanel(profile)
  );
}

/* ---------- settings ---------- */

/**
 * One setting: what it is and what it does on the left, its control on the
 * right. A button's row names it with plain text — a <label> for a button
 * would say the same thing twice to a screen reader.
 */
function settingRow(label: string, description: string | Node | null, control: HTMLElement, ...extra: Array<Node | null | false>): HTMLElement {
  // The label points at the field itself, inside any wrapper (keyed() puts a
  // select in a div with its line key).
  const target = control.matches('input, select, textarea') ? control : control.querySelector<HTMLElement>('input, select, textarea');
  if (target && !target.id) target.id = `fld-${++fieldSeq}`;
  return el(
    'div',
    { class: 'srow' },
    el(
      'div',
      { class: 'srow-text' },
      target ? el('label', { class: 'srow-t', htmlFor: target.id }, label) : el('span', { class: 'srow-t' }, label),
      description ? el('p', {}, description) : null,
      ...extra.filter((n): n is Node => Boolean(n))
    ),
    el('div', { class: 'srow-ctl' }, control)
  );
}

function toggleRow(
  label: string,
  description: string | Node,
  checked: boolean,
  onChange: (v: boolean) => void | Promise<boolean | void>,
  ...extra: Array<Node | null | false>
): HTMLElement {
  const input = el('input', {
    class: 'toggle',
    type: 'checkbox',
    checked,
    onchange: async () => {
      const result = await onChange(input.checked);
      if (result === false) input.checked = !input.checked; // rejected (e.g. permission denied)
      scheduleSave();
    },
  }) as HTMLInputElement;
  return settingRow(label, description, input, ...extra);
}

/** A titled group of settings rows. */
function settingsGroup(title: string, sub: string, ...rows: Array<Node | null | false>): HTMLElement {
  const id = `set-${title.toLowerCase().replace(/\W+/g, '-')}`;
  const node = el(
    'section',
    { class: 'sset' },
    el('div', { class: 'sset-h' }, el('h2', { class: 't-h3', id }, title), el('p', { class: 'meta' }, sub)),
    el('div', { class: 'srows' }, ...rows.filter((n): n is Node => Boolean(n)))
  );
  node.setAttribute('aria-labelledby', id);
  return node;
}

/**
 * A select whose values are routes, with the chosen route's line key inside
 * it. '' (no route chosen — "the last one used", "same as regular windows")
 * shows no key.
 */
function keyed(select: HTMLSelectElement, resolve: (value: string) => string = (v) => v): HTMLElement {
  const key = el('span', { class: 'key' });
  const paint = (): void => {
    const v = resolve(select.value);
    key.classList.toggle('hidden', !v);
    if (v) paintRoute(key, lineColour(config, v));
    key.classList.toggle('system', v === SYSTEM);
  };
  paint();
  select.addEventListener('change', paint);
  return el('div', { class: 'via' }, key, select);
}

function settingsPanel(): HTMLElement {
  const s = config.settings;

  const quickList = el(
    'div',
    { class: 'ticks' },
    ...[
      { id: DIRECT, name: 'Direct' },
      { id: SYSTEM, name: 'System' },
      ...config.profiles.map((p) => ({ id: p.id, name: p.name })),
    ].map((entry) => {
      const check = el('input', {
        class: 'check',
        type: 'checkbox',
        checked: s.quickSwitchIds.includes(entry.id),
        onchange: () => {
          s.quickSwitchIds = check.checked
            ? [...s.quickSwitchIds, entry.id]
            : s.quickSwitchIds.filter((id) => id !== entry.id);
          scheduleSave();
        },
      }) as HTMLInputElement;
      return el('label', { class: 'chk' }, check, entry.name);
    })
  );

  const startup = el('select', { class: 'input' }) as HTMLSelectElement;
  startup.append(
    el('option', { value: '' }, 'The last one used'),
    el('option', { value: DIRECT }, 'Direct'),
    el('option', { value: SYSTEM }, 'System')
  );
  for (const p of config.profiles) startup.append(el('option', { value: p.id }, p.name));
  startup.value = s.startupProfileId;
  startup.onchange = () => {
    s.startupProfileId = startup.value;
    scheduleSave();
  };

  const incognito = el('select', { class: 'input' }) as HTMLSelectElement;
  incognito.append(
    el('option', { value: '' }, 'Same as regular windows'),
    el('option', { value: DIRECT }, 'Direct'),
    el('option', { value: SYSTEM }, 'System')
  );
  for (const p of config.profiles) incognito.append(el('option', { value: p.id }, p.name));
  incognito.value = s.incognitoProfileId;
  incognito.onchange = () => {
    s.incognitoProfileId = incognito.value;
    scheduleSave();
    // Choosing a profile is what makes missing incognito access matter — and
    // clearing it is what stops it mattering. Neither reaches the asks on its
    // own, because no permission event fires for Chrome's own switch.
    updatePermBanners();
  };

  const landing = el('select', { class: 'input' }) as HTMLSelectElement;
  landing.append(el('option', { value: 'overview' }, 'Overview'), el('option', { value: 'last' }, 'The page I had open last'));
  landing.value = uiPrefs.landing;
  landing.onchange = () => {
    uiPrefs = { ...uiPrefs, landing: landing.value as LandingPage };
    void saveUiPrefs(uiPrefs).then(() => toast('Saved'));
  };

  const theme = el('select', { class: 'input' }) as HTMLSelectElement;
  theme.append(
    el('option', { value: 'system' }, 'Match the system'),
    el('option', { value: 'light' }, 'Light'),
    el('option', { value: 'dark' }, 'Dark')
  );
  theme.value = uiPrefs.theme;
  theme.onchange = () => {
    uiPrefs = { ...uiPrefs, theme: theme.value as ThemePref };
    applyTheme(uiPrefs.theme);
    void saveUiPrefs(uiPrefs).then(() => toast('Saved'));
  };

  // The requirement belongs on the field in BOTH states. It used to replace the
  // description when access was missing — so whoever had it granted was never
  // told what the setting depends on (and could not tell that revoking it would
  // quietly undo this), while whoever had not was told the requirement instead
  // of what the setting does. A second line says which, and names the exact
  // switch rather than pointing at a page with dozens of them.
  const incognitoAccessNote = el('p', { class: 'srow-note' });
  void chrome.extension
    .isAllowedIncognitoAccess()
    .then((allowed) => {
      if (allowed) {
        incognitoAccessNote.replaceChildren(
          el('span', { class: 'st good' }, 'In force'),
          ' - Sockitt is allowed in incognito (Extensions › Sockitt › Details › Allow in Incognito).'
        );
        return;
      }
      incognitoAccessNote.replaceChildren(
        el('span', { class: 'st warn' }, 'Waiting for Chrome'),
        ' - until Sockitt is allowed in incognito, those windows follow the regular profile. ',
        el('button', { class: 'linklike', type: 'button', onclick: openExtensionDetails }, 'Open Sockitt’s details')
      );
    })
    .catch(() => undefined);

  // Sync reaches nothing unless the BROWSER is syncing, and each browser
  // arranges that its own way — a machine that never receives anything is far
  // more often a browser that was never signed in than anything Sockitt did.
  // Sockitt cannot detect it either: storage.sync accepts every write and keeps
  // it locally when there is no sync behind it, so this has to be said rather
  // than reported. The full setup, per browser, lives in the docs.
  const syncNeeds = el(
    'span',
    {},
    'Your other machines pick up changes; the newest change wins. The browser itself has to be syncing, with Extensions among what it carries - Chrome reaches your other Chromes and Brave your other Braves, never each other. ',
    el('button', { class: 'linklike', type: 'button', onclick: () => openDocsAt('doc-sync') }, 'How each browser sets that up')
  );
  // A warning only while Sync is OFF: it is the consequence of flipping the
  // switch, and only pending while the switch is armed. Once Sync is on it
  // stays as history, in the ordinary tone. The toggle's handler repaints it.
  const syncWarn = el('p', { class: 'srow-note' });
  const paintSyncWarn = (on: boolean): void => {
    syncWarn.replaceChildren(
      on ? '' : el('span', { class: 'st warn' }, 'Before you set a machine up'),
      on ? '' : ' - ',
      'turned on with a configuration already in sync, this machine’s is replaced by it; turned on when nothing is synced, this machine’s becomes the shared one. Turning Sync off deletes the shared copy; each machine keeps what it has.'
    );
  };
  paintSyncWarn(s.syncEnabled);

  return el(
    'div',
    { class: 'pane set' },
    pageHead('Settings', 'Changes save as you make them. With Sync on, they reach your other browsers too.'),
    el('div', { class: 'asks-slot' }),
    settingsGroup(
      'Switching',
      'What the toolbar icon does, and which profile runs where.',
      toggleRow(
        'Quick switch',
        'A click on the toolbar icon steps through the profiles ticked below instead of opening the popup. Tick at least two - with fewer it cycles Direct, System and every profile. The keyboard shortcut always works; set it at chrome://extensions/shortcuts.',
        s.quickSwitch,
        (v) => {
          s.quickSwitch = v;
        },
        quickList
      ),
      settingRow('On browser startup', 'The profile Sockitt turns on when the browser opens.', keyed(startup)),
      settingRow(
        'Incognito windows use',
        'Their own profile, shown in the toolbar and the popup of those windows; regular windows are unaffected.',
        keyed(incognito),
        s.incognitoProfileId ? incognitoAccessNote : null
      ),
      toggleRow('Reload the tab after switching', 'Once you close the popup, so the page loads over its new route.', s.refreshOnSwitch, (v) => {
        s.refreshOnSwitch = v;
      })
    ),
    settingsGroup(
      'Behaviour',
      'Guard rails, and what Sockitt is allowed to look at.',
      toggleRow(
        'Route badge',
        'The toolbar icon names the profile the current tab goes through. Sockitt reads the tab’s address to work it out locally; nothing is stored or sent. Asks once for “Read your browsing history”, which is what reading a tab’s address is called.',
        s.badgeResult,
        async (v) => {
          if (!v) {
            s.badgeResult = false;
            updatePermBanners(); // the setting is off; nothing left to ask for
            return;
          }
          if (!(await requestTabsPermission())) return false;
          s.badgeResult = true;
          updatePermBanners();
        }
      ),
      toggleRow(
        'IP address lookups',
        el(
          'span',
          {},
          'The popup’s exit line - flag, address and latency - and the proxy test ask ',
          el('span', { class: 'mono' }, 'ipconfig.is'),
          ', a service the Sockitt developer runs. Off until you turn it on; turning it on asks for access to that one site.'
        ),
        s.exitIpCheck,
        async (v) => {
          if (v && !(await ensureExitIpPermission())) {
            toast('Permission declined');
            return false;
          }
          s.exitIpCheck = v;
        }
      ),
      toggleRow('Rules added in the popup go last', 'Off puts them first, ahead of every rule you already have.', s.addToBottom, (v) => {
        s.addToBottom = v;
      }),
      toggleRow('Confirm before deleting', 'Ask before a profile is deleted or everything is reset.', s.confirmDeletion, (v) => {
        s.confirmDeletion = v;
      })
    ),
    // Stored per device, outside the synced configuration on purpose — see the
    // UI-preferences note in state.ts.
    settingsGroup(
      'Appearance',
      'This device only - never synced.',
      settingRow('Theme', 'Follow the system, or keep this browser light or dark.', theme),
      settingRow('This page opens on', 'The Overview, or wherever you were last.', landing)
    ),
    settingsGroup(
      'Sync',
      'Through your browser’s own sync, never a Sockitt server.',
      syncError
        ? el('div', { class: 'callout bad', role: 'alert' }, el('div', {}, el('h3', {}, 'The last sync failed'), el('p', { class: 'mono' }, syncError)))
        : null,
      toggleRow(
        'Sync profiles and rules',
        syncNeeds,
        s.syncEnabled,
        async (v) => {
          if (!v) {
            s.syncEnabled = false;
            void clearSync();
            paintSyncWarn(false);
            return;
          }
          // A remote written by an incompatible schema must not be joined:
          // enabling would push this config over it, and old installs (which
          // have no version gate) would adopt the overwrite — wiping the group.
          const state = await remoteSyncState();
          if (state === 'newer') {
            toast('Sync unavailable: your synced data was written by a newer Sockitt - update this machine first', 4000);
            return false; // snap the toggle back off
          }
          if (state === 'legacy') {
            toast('Sync unavailable: your synced data was written by Sockitt 1.6.2 or older - update every device, or toggle Sync off to clear it and reseed from this machine', 5000);
            return false;
          }
          // Joining: adopt an existing synced config instead of overwriting it
          // with this machine's (so enabling sync on a fresh install can't wipe
          // the group). pullFromSync(-1) returns any present remote;
          // applyFromSync restores this machine's rule-list bodies and
          // credentials, which never travel through sync.
          const remote = await pullFromSync(-1);
          if (remote) {
            remote.settings.syncEnabled = true;
            // force: this is an explicit join — adopt the remote even if this
            // machine's rev is higher (the newest-rev-wins guard is for the
            // automatic background pull, not this deliberate adoption).
            await applyFromSync(remote, config, { force: true });
            config = remote;
            selectedId = SETTINGS_ID;
            toast('Adopted synced configuration');
            render();
            return;
          }
          s.syncEnabled = true;
          paintSyncWarn(true);
        },
        syncWarn
      )
    ),
    settingsGroup(
      'Backup',
      'Everything, as one file.',
      settingRow(
        'Export',
        'Every profile, rule and setting as a JSON file - proxy passwords included, in plain text, so keep it somewhere safe.',
        el('button', { class: 'btn', type: 'button', onclick: exportConfig }, 'Export')
      ),
      settingRow('Import', 'Replaces what is here with the file’s contents.', el('button', { class: 'btn', type: 'button', onclick: importConfig }, 'Import…')),
      settingRow(
        'Reset everything',
        'Deletes every profile and rule and returns to System. Settings are kept.',
        el('button', { class: 'btn danger', type: 'button', onclick: resetConfig }, 'Reset…')
      )
    )
  );
}

/* ---------- drag reorder ---------- */

function wireDrag(row: HTMLElement, container: HTMLElement, commit: () => void): void {
  const grip = row.querySelector<HTMLElement>('.grip')!;
  // The grip is a real button, so reordering is not mouse-only: Alt + arrow
  // moves the row one place and keeps focus on the handle for a second press.
  grip.addEventListener('keydown', (e) => {
    const up = e.key === 'ArrowUp';
    if (!e.altKey || (!up && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    // The row above the first rule is .rule-head and the one below the last is
    // the default ("Everything else"), so check the class rather than merely
    // that a sibling exists.
    const neighbour = up ? row.previousElementSibling : row.nextElementSibling;
    if (!neighbour?.classList.contains('rule') || neighbour.classList.contains('rule-default')) return;
    container.insertBefore(row, up ? neighbour : neighbour.nextElementSibling);
    commit();
    grip.focus();
  });
  grip.addEventListener('dragstart', (e) => {
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setDragImage(row, 20, 20);
    row.classList.add('dragging');
  });
  grip.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    commit();
  });
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    const dragging = container.querySelector<HTMLElement>('.rule.dragging');
    if (!dragging || dragging === row) return;
    const rect = row.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    container.insertBefore(dragging, before ? row : row.nextSibling);
  });
  container.addEventListener('drop', (e) => e.preventDefault());
}

/* ---------- import / export / reset ---------- */

function exportConfig(): void {
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const a = el('a', {
    href: URL.createObjectURL(blob),
    download: `sockitt-backup-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
  // The backup is the full config — a restore must round-trip everything —
  // so say out loud when that includes secrets.
  if (proxyProfiles(config).some((p) => p.username || p.password)) {
    toast('Exported - the backup contains proxy passwords in plain text, keep it safe', 4500);
  } else {
    toast('Exported');
  }
}

function importConfig(): void {
  const input = el('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const parsed = sanitizeConfig(JSON.parse(await file.text()));
      if (!parsed) throw new Error('not a Sockitt backup');
      config = parsed;
      selectedId = config.profiles[0]?.id ?? null;
      await saveConfig(config);
      toast('Imported');
      render();
      // A backup carries settings, never the optional permissions they depend
      // on. Ask for the badge's grant here, while the file-picker gesture is
      // still live — otherwise the setting reads as on and does nothing until
      // the user thinks to toggle it off and back on. Declined (or asked too
      // late for the gesture) leaves the banner to offer it again.
      if (config.settings.badgeResult) await requestTabsPermission();
      void refreshPermState();
    } catch (e) {
      alert(`Import failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  input.click();
}

function resetConfig(): void {
  if (!confirmMaybe('Delete all profiles and rules?')) return;
  config = {
    version: CONFIG_VERSION,
    rev: config.rev,
    activeId: SYSTEM,
    profiles: [],
    settings: { ...config.settings, quickSwitchIds: [], startupProfileId: '', incognitoProfileId: '' },
  };
  selectedId = null;
  void saveConfig(config);
  render();
}

/* ---------- route inspector ---------- */

/** What was typed, as a URL: an address, or just a host. */
function parseInspect(raw: string): URL | null {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return hostLooksReal(u.hostname) ? u : null;
  } catch {
    return null;
  }
}

/** A route, named in its own line colour. */
function routeName(id: string): HTMLElement {
  return el(
    'span',
    { class: 'rv' },
    paintRoute(el('span', { class: `key${id === SYSTEM ? ' system' : ''}` }), lineColour(config, id)),
    el('b', {}, nameFor(id))
  );
}

/** What one hop did, in words. */
function inspectStep(e: TraceEdge): Array<Node | string> {
  switch (e.kind) {
    case 'rule': {
      const n = edgeRuleIndex(config, e);
      return [`Rule ${n >= 0 ? n + 1 : ''} matches, `, el('span', { class: 'mono' }, e.pattern ?? ''), e.ruleType ? ` (${RULE_TYPES[e.ruleType].toLowerCase()})` : '', ', and sends it to'];
    }
    case 'temp-rule':
      return ['An override set from the popup matches, ', el('span', { class: 'mono' }, e.pattern ?? ''), ', ahead of every rule, and sends it to'];
    case 'default':
      return ['No rule matches, so the default takes it, to'];
    case 'alias':
      return ['An alias, pointing at'];
    case 'list-match':
      return ['It is on the list, so it goes to'];
    case 'list-default':
      return ['It is not on the list, so it goes to'];
  }
}

function inspectorPanel(): HTMLElement {
  const mapSlot = el('div', { class: 'insp-map' });
  const steps = el('div', { class: 'insp-steps', role: 'status' });
  // Monotonic guard: runs await session storage, so a fast second keystroke
  // could otherwise interleave with the first and paint a stale chain.
  let inspectSeq = 0;

  const urlInput = el('input', {
    class: 'input mono',
    type: 'search',
    value: inspectUrl,
    placeholder: 'https://example.com/path, or just a host',
    ariaLabel: 'Address to inspect',
    spellcheck: false,
  }) as HTMLInputElement;

  const startSel = el('select', { class: 'input' }) as HTMLSelectElement;
  startSel.setAttribute('aria-label', 'Start at');
  // '' follows whatever is active, so it is named for it — and keyed in its colour.
  startSel.append(el('option', { value: '' }, `${nameFor(config.activeId)} (active)`));
  for (const p of config.profiles) startSel.append(el('option', { value: p.id }, p.name));
  startSel.value = [...startSel.options].some((o) => o.value === inspectStartId) ? inspectStartId : '';

  const paint = async (): Promise<void> => {
    const seq = ++inspectSeq;
    inspectUrl = urlInput.value;
    inspectStartId = startSel.value;
    const startId = startSel.value || config.activeId;
    const raw = urlInput.value.trim();
    const u = raw ? parseInspect(raw) : null;
    // Match real routing: the overrides set from the popup take part only when
    // inspecting the profile that is actually active.
    const temp = startId === config.activeId && startId !== DIRECT && startId !== SYSTEM ? await loadTempRules(config.activeId, 'regular').catch(() => []) : [];
    if (seq !== inspectSeq) return; // a newer run owns the page
    const req = u ? { url: pacRequestUrl(u.href), host: u.hostname, shown: u.hostname } : null;
    mapSlot.replaceChildren(tracedYard(dashboardHost, startId, req, temp));

    if (!raw) {
      steps.replaceChildren(el('p', { class: 'ink2' }, 'Type an address above and its path lights up on the map, with every step it takes written out here.'));
      return;
    }
    if (!u || !req) {
      steps.replaceChildren(el('p', { class: 'st warn' }, 'That doesn’t read as an address or a host name.'));
      return;
    }
    if (startId === DIRECT || startId === SYSTEM) {
      steps.replaceChildren(
        el(
          'p',
          { class: 'ink2' },
          el('b', { class: 'mono host' }, u.hostname),
          startId === DIRECT ? ' goes straight out: Direct is active.' : ' goes wherever your operating system’s settings send it - Sockitt cannot see those rules.'
        )
      );
      return;
    }
    const start = config.profiles.find((p) => p.id === startId);
    if (!start) {
      steps.replaceChildren(el('p', { class: 'st warn' }, 'That profile no longer exists.'));
      return;
    }
    const trace: TraceEdge[] = [];
    const route = resolveRoute(config, start, req.url, req.host, temp, new Date(), trace);

    const list = el('ol', { class: 'steps' });
    list.append(el('li', {}, el('span', { class: 'step-n mono' }, '1'), el('p', {}, 'Starts at ', routeName(start.id), '.')));
    trace.forEach((edge, i) => {
      list.append(el('li', {}, el('span', { class: 'step-n mono' }, String(i + 2)), el('p', {}, ...inspectStep(edge), ' ', routeName(edge.to), '.')));
    });
    const terminal = config.profiles.find((p) => p.id === route.targetId);
    const landing: Array<Node | string> =
      route.targetId === DIRECT
        ? ['Goes out with no proxy, over your own connection.']
        : terminal && terminal.kind === 'proxy'
          ? route.bypassed
            ? [`${terminal.name}’s bypass list matches it, so it goes out `, el('b', {}, 'Direct'), ' instead.']
            : ['Goes out through ', el('b', {}, terminal.name), ' at ', el('span', { class: 'mono' }, `${SCHEME_LABELS[terminal.scheme]} ${terminal.host}:${terminal.port}`), '.']
          : ['Goes out with no proxy.'];
    list.append(el('li', { class: 'step-end' }, el('span', { class: 'step-n' }, icon('arrow', 'sm')), el('p', {}, ...landing)));

    const out: HTMLElement[] = [el('h2', { class: 't-h3' }, 'Step by step'), list];
    if (req.url !== u.href) {
      out.push(
        el(
          'p',
          { class: 'meta' },
          `Chrome hides the path of ${u.protocol}// addresses from proxy routing, so this was matched as `,
          el('span', { class: 'mono' }, req.url),
          '.'
        )
      );
    }
    steps.replaceChildren(...out);
  };

  urlInput.oninput = () => void paint();
  startSel.onchange = () => void paint();
  void paint();

  return el(
    'div',
    { class: 'pane insp' },
    pageHead(
      'Inspector',
      'Type an address to see how it would route right now: which rule takes it, every profile it passes through, and where it lands. It runs the same rules as real routing - popup overrides included - and sends nothing.'
    ),
    el('div', { class: 'insp-form' }, el('div', { class: 'search insp-url' }, urlInput), el('div', { class: 'insp-start' }, el('span', { class: 't-label' }, 'Start at'), keyed(startSel, (v) => v || config.activeId))),
    el('div', { class: 'band insp-band' }, mapSlot),
    steps
  );
}

/* ---------- proxy errors ---------- */

/** A route named in a log entry; a button to its editor while it still exists. */
function errorRoute(id: string, name: string, endpoint?: string): HTMLElement {
  const profile = config.profiles.find((p) => p.id === id);
  const inner: Node[] = [
    paintRoute(el('span', { class: `key${id === SYSTEM ? ' system' : ''}` }), profile ? profile.color : BUILTIN_FILL),
    // The recorded name, not today's: resolving it against the current config
    // would rewrite history for a profile renamed or deleted since.
    el('b', {}, name),
  ];
  if (endpoint) inner.push(el('span', { class: 'mono meta' }, endpoint));
  if (!profile) return el('span', { class: 'rv' }, ...inner);
  return el('button', { class: 'rv', type: 'button', title: `Open ${profile.name}`, onclick: () => goTo(profile.id) }, ...inner);
}

/**
 * Which proxy was carrying traffic. For a profile that routes everything the
 * same way this is exact; for one that decides per request it is a shortlist,
 * because Chrome's error event genuinely does not name the server — saying so
 * is more useful than picking one and being wrong.
 */
function errorCarrier(entry: ProxyErrorEntry): HTMLElement {
  if (entry.via) {
    return viaIsSelf(entry)
      ? el('p', { class: 'carrier' }, 'Through ', errorRoute(entry.via.id, entry.via.name, entry.via.endpoint), '.')
      : el(
          'p',
          { class: 'carrier' },
          errorRoute(entry.profileId, entry.profileName),
          ' routes everything through ',
          errorRoute(entry.via.id, entry.via.name, entry.via.endpoint),
          '.'
        );
  }
  if (entry.candidates?.length) {
    return el(
      'div',
      { class: 'carrier' },
      el(
        'p',
        {},
        errorRoute(entry.profileId, entry.profileName),
        ' picks a server per request, and Chrome does not say which one failed. It can route to:'
      ),
      el('p', { class: 'carrier-list' }, ...entry.candidates.map((c) => errorRoute(c.id, c.name, c.endpoint)))
    );
  }
  return el('p', { class: 'carrier' }, 'While ', errorRoute(entry.profileId, entry.profileName), ' was active.');
}

function errorStatus(): HTMLElement {
  if (proxyAlert) {
    const alert = proxyAlert;
    const via = alert.via ? config.profiles.find((p) => p.id === alert.via!.id) : undefined;
    const heading =
      alert.streak > 1 ? `${alert.streak} requests failed, the last ${agoInWords(alert.lastAt)}` : `A request failed ${agoInWords(alert.lastAt)}`;
    const advice = errorAdvice(alert);
    return el(
      'div',
      { class: 'callout bad err-live', role: 'alert' },
      el(
        'div',
        {},
        el('h3', {}, heading),
        el('p', {}, el('span', { class: 'mono' }, errorHeadline(alert)), alert.details ? ` - ${alert.details}` : ''),
        errorCarrier(alert),
        advice ? el('p', {}, advice) : null,
        el(
          'p',
          { class: 'meta' },
          `Started ${agoInWords(alert.at)}. This clears itself once 30 seconds go by with no further error: Chrome reports failures but never recoveries, so a quiet spell is what working again looks like from here.`
        )
      ),
      el(
        'div',
        { class: 'acts' },
        via && via.kind === 'proxy'
          ? el('button', { class: 'btn primary', type: 'button', dataset: { errAction: 'test' }, onclick: () => goTo(via.id) }, `Check ${via.name}`)
          : null,
        el('button', { class: 'btn', type: 'button', dataset: { errAction: 'copy' }, onclick: () => void copyErrorReport() }, 'Copy report'),
        el('button', { class: 'btn quiet', type: 'button', dataset: { errAction: 'dismiss' }, onclick: () => void clearProxyAlert() }, 'Dismiss')
      )
    );
  }
  const last = errorLog[0];
  return el(
    'div',
    { class: 'err-quiet' },
    el('p', { class: 'st good' }, last ? 'No errors right now' : 'No proxy errors'),
    el(
      'p',
      { class: 'ink2' },
      last
        ? `The last failure was ${agoInWords(last.lastAt)}, and nothing has failed since. The log below is kept so you can still see what happened.`
        : 'Nothing has failed since this browser started. If a proxy does go down, Sockitt fails the request rather than quietly sending it direct - so you will see the page error, a red mark on the toolbar icon, and the details here.'
    ),
    last ? el('div', { class: 'acts' }, el('button', { class: 'btn', type: 'button', dataset: { errAction: 'copy' }, onclick: () => void copyErrorReport() }, 'Copy report')) : null
  );
}

function errorRow(entry: ProxyErrorEntry): HTMLElement {
  return el(
    'li',
    { class: 'elog-row' },
    el(
      'span',
      { class: 'elog-when mono', title: new Date(entry.at).toLocaleString() },
      new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
      entry.count > 1 ? el('span', { class: 'elog-n', title: `Last repeat ${new Date(entry.lastAt).toLocaleTimeString()}` }, `×${entry.count}`) : null
    ),
    el(
      'div',
      { class: 'elog-body' },
      el('p', { class: 'elog-code mono' }, errorHeadline(entry)),
      entry.details ? el('p', { class: 'elog-detail' }, entry.details) : null,
      el('p', { class: 'meta' }, describeCarrier(entry))
    ),
    el('span', { class: `st ${entry.fatal ? 'bad' : 'warn'}` }, entry.fatal ? 'Failed' : 'Warning')
  );
}

async function copyErrorReport(): Promise<void> {
  let version = '';
  try {
    version = chrome.runtime.getManifest().version;
  } catch {
    // not running as an extension (a preview build) — the report still stands
  }
  try {
    await navigator.clipboard.writeText(formatErrorReport(errorLog, proxyAlert, version));
    toast('Report copied');
  } catch {
    toast('Could not copy - the browser blocked clipboard access', 3000);
  }
}

function errorsPanel(): HTMLElement {
  return el(
    'div',
    { class: 'errs' },
    errorStatus(),
    el(
      'section',
      { class: 'elog' },
      el(
        'div',
        { class: 'elog-head' },
        el('h2', { class: 't-h3' }, 'Log'),
        el(
          'p',
          { class: 'meta' },
          'Newest first. Repeats of one failure collapse into a line with a count, so a proxy down for an hour reads as one entry, not a thousand.'
        ),
        errorLog.length
          ? el(
              'button',
              {
                class: 'btn quiet danger',
                type: 'button',
                dataset: { errAction: 'clear' },
                onclick: () => {
                  if (!confirmMaybe('Clear the proxy error log?')) return;
                  void clearErrorLog();
                },
              },
              'Clear log'
            )
          : null
      ),
      errorLog.length ? el('ol', { class: 'elog-list' }, ...errorLog.map(errorRow)) : el('p', { class: 'meta' }, 'Nothing logged yet.'),
      errorLog.length
        ? el('p', { class: 'meta' }, 'A copied report includes your proxy addresses and ports, but never a username or password - the log does not record them.')
        : null
    )
  );
}

/* ---------- the Activity page ---------- */

/** Requests recorded by the monitor this visit — the Requests sub-tab's figure. */
let requestCount = 0;

function activitySubtabs(sub: 'requests' | 'errors'): HTMLElement {
  const tab = (id: string, label: string, count: Node | null): HTMLElement => {
    const b = el('button', { class: 'subtab', type: 'button', onclick: () => goTo(id) }, label, count);
    if ((id === NETWORK_ID) === (sub === 'requests')) b.setAttribute('aria-current', 'page');
    return b;
  };
  const errCount = proxyAlert
    ? el('span', { class: 'count tnum' }, icon('alert', 'sm'), proxyAlert.streak > 99 ? '99+' : String(proxyAlert.streak), el('span', { class: 'vh' }, ' failing requests'))
    : errorLog.length
      ? el('span', { class: 'meta tnum' }, String(errorLog.length))
      : null;
  return el(
    'nav',
    { class: 'subtabs', ariaLabel: 'Activity views' },
    tab(NETWORK_ID, 'Requests', el('span', { class: 'meta tnum req-count' }, requestCount ? requestCount.toLocaleString() : '')),
    tab(ERRORS_ID, 'Proxy errors', errCount)
  );
}

function activityPage(sub: 'requests' | 'errors'): HTMLElement {
  return el(
    'div',
    { class: 'pane act' },
    pageHead(
      'Activity',
      sub === 'requests'
        ? 'Every request this browser makes while the page is open, and the route Sockitt gave it. Nothing is kept once you leave.'
        : 'Requests a proxy failed. Kept for this browser session only - never written to your configuration, never synced.'
    ),
    activitySubtabs(sub),
    sub === 'requests' ? networkPanel(networkHost) : errorsPanel()
  );
}

/**
 * Repaint the errors view without losing the reader's place. A proxy that is
 * down reports on every failed request, and this page is precisely where
 * someone sits while that happens — a full render() would rebuild the log
 * several times a second and drop keyboard focus to the body each time. So
 * swap only the view, and put the focused action back afterwards.
 */
function repaintErrorsPage(): void {
  const view = app.querySelector('.act .errs');
  const tabs = app.querySelector<HTMLElement>('.act .subtabs');
  if (!view || !tabs) {
    render(); // first paint, or some other page is up — nothing to preserve
    return;
  }
  // Focus goes back by role, not by node: the whole subtree is replaced, so the
  // element the user was on no longer exists to re-focus.
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.errAction : undefined;
  const fresh = errorsPanel();
  view.replaceWith(fresh);
  swapKeepingFocus(tabs, activitySubtabs('errors'));
  if (focused) fresh.querySelector<HTMLElement>(`[data-err-action="${focused}"]`)?.focus();
  refreshNav(); // the tab's count moves with the alert
}

/** The Requests view is live; only the sub-tabs' error figure moves under it. */
function repaintActivityTabs(): void {
  const tabs = app.querySelector<HTMLElement>('.act .subtabs');
  if (tabs) swapKeepingFocus(tabs, activitySubtabs(selectedId === ERRORS_ID ? 'errors' : 'requests'));
}

/** How long a run of failure events is allowed to collapse into one repaint. */
const ERROR_COALESCE_MS = 400;

/** Mirror the worker's failure state into this page and keep it current. */
function watchProxyErrors(): void {
  // Monotonic guard: a burst of failures fires a burst of change events, each
  // starting an async read. Without this an earlier read can resolve last and
  // paint older state, which then sits there until the next event.
  let seq = 0;
  const refresh = async (): Promise<void> => {
    const mine = ++seq;
    const [alert, log] = await Promise.all([loadProxyAlert(), loadErrorLog()]);
    if (mine !== seq) return;
    proxyAlert = alert;
    errorLog = log;
    // Never a full render: it would eat unsaved text in an open editor. The
    // pages that show this data repaint in place; everywhere else only the nav
    // badge moves.
    if (selectedId === ERRORS_ID) repaintErrorsPage();
    else if (selectedId === NETWORK_ID) {
      repaintActivityTabs();
      refreshNav();
    } else if (selectedId === DASH_ID) {
      repaintDashboard();
      refreshNav();
    } else refreshNav();
  };
  // Coalesce the burst. A proxy that is down fails every request through it,
  // and each failure is its own storage write — so an open Overview was
  // repainting many times a second for as long as the proxy stayed broken.
  // Only the last state in a burst is worth painting, and the trailing edge is
  // imperceptible on the first failure after a quiet spell.
  let pending: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      void refresh();
    }, ERROR_COALESCE_MS);
  };

  void refresh();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    if (changes[ERROR_KEY] || changes[ERROR_LOG_KEY]) schedule();
  });
}

/**
 * The rest of the worker→page signals the dashboard reads. Each is cheap and
 * each moves something visible: who owns the proxy, the session timeline, and
 * the exit IP (which is only meaningful for the route currently applied, so a
 * new apply invalidates the measurement rather than leaving a stale one up).
 */
function watchDashboardSignals(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !dashboardMounted()) return;
    if (changes[CONTROL_KEY]) {
      const record = changes[CONTROL_KEY].newValue as { level?: unknown } | undefined;
      setControlLevel(typeof record?.level === 'string' ? record.level : '');
    }
    if (changes[HISTORY_KEY]) void loadHistory().then(setHistory);
    if (changes[APPLIED_KEY]) {
      const applied = changes[APPLIED_KEY].newValue as
        | { activeId?: unknown; at?: unknown }
        | undefined;
      setApplied(
        typeof applied?.activeId === 'string' ? applied.activeId : '',
        typeof applied?.at === 'number' ? applied.at : Date.now()
      );
    }
  });
}

/** A request older than this is stale — see watchPageRequests. */
const PAGE_REQUEST_TTL_MS = 15_000;

/**
 * Honour the popup's "open Options on…" requests: the errors view, or a new
 * auto switch. Handled both at boot and live, because
 * chrome.runtime.openOptionsPage may create a page or focus one that is
 * already open, and the popup cannot tell which.
 */
function watchPageRequests(): void {
  const open = (raw: unknown): void => {
    const request = raw as { page?: unknown; at?: unknown } | undefined;
    if (request?.page !== 'errors' && request?.page !== 'new-switch') return;
    // Consume it either way, so a request that never reached a page cannot
    // hijack some unrelated visit to Options later on.
    void chrome.storage.session.remove(OPEN_PAGE_KEY).catch(() => undefined);
    if (typeof request.at === 'number' && Date.now() - request.at > PAGE_REQUEST_TTL_MS) return;
    if (request.page === 'new-switch') {
      // The popup's "New auto switch": make one and open its editor, which is
      // what the button was pressed for.
      addProfile(newSwitchProfile);
      return;
    }
    if (selectedId === ERRORS_ID) return;
    selectedId = ERRORS_ID;
    render();
  };
  void chrome.storage.session
    .get(OPEN_PAGE_KEY)
    .then((stored) => open(stored[OPEN_PAGE_KEY]))
    .catch(() => undefined);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[OPEN_PAGE_KEY]) open(changes[OPEN_PAGE_KEY].newValue);
  });
}

/* ---------- render ---------- */

let topNode: HTMLElement | null = null;

/** What a control is, independent of the node that draws it — for putting focus back. */
function controlKey(n: Element): string {
  return `${n.tagName}|${n.getAttribute('class') ?? ''}|${(n.textContent ?? '').trim().slice(0, 60)}`;
}

/** Rebuild one region in place, putting a keyboard user back where they were. */
function swapKeepingFocus(old: HTMLElement, fresh: HTMLElement): void {
  const focused = old.contains(document.activeElement) ? document.activeElement : null;
  const key = focused ? controlKey(focused) : '';
  old.replaceWith(fresh);
  if (focused) {
    [...fresh.querySelectorAll<HTMLElement>('button, a, input, select')]
      .find((n) => controlKey(n) === key)
      ?.focus({ preventScroll: true });
  }
}

/** The top bar alone — a count moved (proxy errors), nothing else did. */
function refreshNav(): void {
  if (!topNode?.isConnected) return;
  const fresh = topNav();
  swapKeepingFocus(topNode, fresh);
  topNode = fresh;
}

/** The top bar and the Profiles list — a name or the active profile changed. */
function refreshChrome(): void {
  refreshNav();
  const list = app.querySelector<HTMLElement>('.plist');
  if (list) {
    swapKeepingFocus(list, profileColumn());
    applyProfileFilter();
  }
}

function editorFor(profile: Profile): HTMLElement {
  switch (profile.kind) {
    case 'proxy': return proxyEditor(profile);
    case 'switch': return switchEditor(profile);
    case 'rulelist': return ruleListEditor(profile);
    case 'virtual': return virtualEditor(profile);
  }
}

/** The Profiles page: the list beside whatever it has selected. */
function profilesPage(): HTMLElement {
  const profile = selected();
  let editor: HTMLElement;
  if (selectedId === DIRECT || selectedId === SYSTEM) editor = builtinPane(selectedId);
  else if (profile) editor = editorFor(profile);
  else
    editor = el(
      'div',
      { class: 'ed-pane' },
      el('header', { class: 'ed-head' }, el('div', { class: 'ed-title' }, el('h1', { class: 't-title' }, 'No profiles yet'))),
        startList()
    );
  return el('div', { class: 'pane prof' }, profileColumn(), el('div', { class: 'ed' }, editor));
}

/**
 * The page for whatever is selected. One branch per page, top to bottom.
 */
function contentFor(): HTMLElement {
  if (selectedId === DASH_ID) {
    // Nothing to map yet — the first-run page says what to do first.
    return config.profiles.length ? dashboardPanel(dashboardHost) : firstRunPane();
  }
  if (selectedId === DOCS_ID) return docsPanel(() => goTo(RELEASES_ID));
  if (selectedId === RELEASES_ID) return releasesPanel(() => goTo(DOCS_ID));
  if (selectedId === INSPECT_ID) return inspectorPanel();
  if (selectedId === NETWORK_ID) return activityPage('requests');
  if (selectedId === ERRORS_ID) return activityPage('errors');
  if (selectedId === SETTINGS_ID) return settingsPanel();
  return profilesPage();
}

function render(): void {
  topNode = topNav();
  const content = contentFor();
  app.replaceChildren(
    el('div', { class: 'page' }, topNode, el('main', { class: 'main' }, el('div', { class: 'wrap content' }, content)), footer())
  );
  applyProfileFilter();
  paintAsks();

  // Remember where we were, for the "reopen the last page" landing option.
  if (selectedId && selectedId !== uiPrefs.lastPage) {
    uiPrefs = { ...uiPrefs, lastPage: selectedId };
    void saveUiPrefs(uiPrefs);
  }
}

/** The monitor's window onto this page — a live config read, and a way out. */
const networkHost = {
  config: () => config,
  open: (id: string) => {
    selectedId = id;
    render();
  },
  // Held in prefs, not in the panel: the panel is rebuilt on every navigation,
  // so a flag living there means stopping the monitor and stepping away starts
  // it again on the way back.
  recording: () => uiPrefs.monitorRecording,
  setRecording: (on: boolean) => {
    uiPrefs = { ...uiPrefs, monitorRecording: on };
    void saveUiPrefs(uiPrefs);
  },
  inspect: (url: string) => {
    inspectUrl = url;
    inspectStartId = '';
    goTo(INSPECT_ID);
  },
  test: (profileId: string, button: HTMLButtonElement, out: HTMLElement) => {
    const p = config.profiles.find((x) => x.id === profileId);
    if (p?.kind === 'proxy') void startProxyTest(p, button, out);
  },
  setCount: (n: number) => {
    if (n === requestCount) return;
    requestCount = n;
    const node = app.querySelector('.req-count');
    if (node) node.textContent = n ? n.toLocaleString() : '';
  },
};

/**
 * The dashboard's window onto this page. Closures rather than a snapshot: the
 * panel outlives several `config` reassignments (a sync pull, a popup write),
 * and a captured object would quietly go stale under it.
 */
const dashboardHost = {
  config: () => config,
  alert: () => proxyAlert,
  errorLog: () => errorLog,
  open: (id: string) => {
    selectedId = id;
    render();
  },
  activate: (id: string) => {
    config.activeId = id;
    // Immediate, not debounced: switching the active profile is the one action
    // here whose whole point is that the browser reacts now.
    void saveConfig(config).then(() => toast('Switched'));
    render();
  },
  save: () => {
    // Repaint FIRST, synchronously. The caller has already mutated the
    // in-memory config, so every card is correct right now — and the storage
    // echo cannot do this for us: saveConfig bumps rev on this very object, so
    // onConfigChanged sees an unchanged rev, takes its rule-list-merge branch
    // and returns without rendering. Without this the finding the user just
    // fixed sat on the health card until the 30-second tick swept it away.
    if (dashboardMounted()) repaintDashboard();
    void saveConfig(config).then(() => toast('Saved'));
  },
  createProxy: () => addProfile(newProxyProfile),
  requestAuth: () => requestAuthPermission(),
  requestExitIp: () => ensureExitIpPermission(),
  refetchRuleList,
  inspect: (url: string) => {
    inspectUrl = url;
    inspectStartId = '';
    goTo(INSPECT_ID);
  },
  asks: () => permAsks(),
};

/**
 * Adopt config written by the background (rule-list auto-update, quick-switch
 * cycle, or a sync pull) so the page's long-lived snapshot can't silently
 * revert those writes on the next edit. Skipped while the user has an edit
 * pending (their in-progress change wins, last-write-wins as everywhere else).
 */
onConfigChanged((incoming) => {
  if (savePending) return;
  if (incoming.rev === config.rev) {
    // Same rev: either the echo of this page's own save, or a background
    // rule-list refresh (updateRuleList deliberately keeps rev unchanged so
    // an unattended fetch doesn't masquerade as a user edit). Merge just the
    // fetched list bodies — adopting wholesale would clobber deliberate
    // unsaved state in this snapshot, but ignoring them entirely would make
    // the next edit here write stale list text back over the fetch.
    let changed = false;
    for (const p of config.profiles) {
      if (p.kind !== 'rulelist') continue;
      const inc = incoming.profiles.find((q) => q.id === p.id);
      if (inc?.kind === 'rulelist' && (inc.text !== p.text || inc.lastUpdated !== p.lastUpdated)) {
        p.text = inc.text;
        p.lastUpdated = inc.lastUpdated;
        changed = true;
      }
    }
    if (changed && selected()?.kind === 'rulelist') render();
    return;
  }
  config = incoming;
  if (selectedId && !PAGE_IDS.has(selectedId) && !config.profiles.some((p) => p.id === selectedId)) {
    selectedId = config.profiles[0]?.id ?? null;
  }
  render();
});

function watchSyncError(): void {
  void chrome.storage.session.get(SYNC_ERROR_KEY).then((s) => {
    const err = (s as Record<string, { message: string }>)[SYNC_ERROR_KEY];
    if (err?.message && err.message !== syncError) {
      syncError = err.message;
      if (selectedId === SETTINGS_ID) render();
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes[SYNC_ERROR_KEY]) return;
    const next = changes[SYNC_ERROR_KEY].newValue as { message: string } | undefined;
    syncError = next?.message ?? null;
    if (selectedId === SETTINGS_ID) render();
  });
}

/** "Exit 203.0.113.42 🇺🇸 · 45 ms" — shared by the live result and the reopen paint. */
/** Watch for connection-test results and paint the open editor's result line. */
function watchProxyTests(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes[TEST_RESULT_KEY]) return;
    const r = changes[TEST_RESULT_KEY].newValue as
      | {
          profileId?: string;
          ok?: boolean;
          ip?: string;
          iso?: string;
          country?: string;
          ms?: number;
          error?: string;
        }
      | undefined;
    if (!r?.profileId) return;
    // Update the open editor in place — a full render would eat unsaved input.
    // Re-enable only the button for the result's own profile: a dropped
    // concurrent request returns its own busy-response, so a blanket re-enable
    // would wrongly reactivate a still-running test.
    const sel = `[data-profile="${CSS.escape(r.profileId)}"]`;
    const btn = document.querySelector<HTMLButtonElement>(`.test-btn${sel}`);
    if (btn) btn.disabled = false;
    const span = document.querySelector<HTMLElement>(`.test-result${sel}`);
    if (!span) return;
    if (span.dataset.stale) {
      // The address or the credentials changed while this test was running, so
      // its verdict describes a server that is no longer configured. The button
      // is re-enabled above; say nothing rather than something untrue.
      delete span.dataset.stale;
      return;
    }
    span.classList.remove('ok', 'bad');
    if (r.ok) {
      const src = flagSrc(r.iso);
      // Build DOM (not textContent) so the flag SVG sits inline with the text.
      span.replaceChildren(
        document.createTextNode(`Connection successful · ${r.ip ?? '?'} `),
        ...(src ? [el('img', { class: 'test-flag', src, alt: '', width: 16, height: 12 }), document.createTextNode(' ')] : []),
        document.createTextNode(`· ${r.ms} ms`)
      );
      span.title = r.country ? `${r.ip} · ${r.country}` : `${r.ip ?? ''}`;
      span.classList.add('ok');
    } else {
      span.textContent = `Connection failed - ${r.error ?? 'unknown error'}`;
      span.removeAttribute('title');
      span.classList.add('bad');
    }
  });
}

/**
 * Where the options tab opens. Overview by default — the page's whole job on
 * arrival is to say where traffic is going and whether it works, which no
 * profile editor can answer. 'last' reopens whatever was up before, for people
 * who live in one editor; a page that has since been deleted falls back to
 * Overview rather than to an empty pane.
 */
function landingPage(prefs: UiPrefs): string | null {
  if (prefs.landing === 'last' && prefs.lastPage) {
    const stillThere =
      PAGE_IDS.has(prefs.lastPage) || config.profiles.some((p) => p.id === prefs.lastPage);
    if (stillThere) return prefs.lastPage;
  }
  return DASH_ID;
}

void Promise.all([loadConfig(), loadUiPrefs()]).then(([c, prefs]) => {
  config = c;
  uiPrefs = prefs;
  applyTheme(uiPrefs.theme);
  // Another tab or the popup's own page may change it; this page follows.
  onThemeChanged((theme) => {
    uiPrefs = { ...uiPrefs, theme };
    applyTheme(theme);
  });
  selectedId = landingPage(prefs);
  wireMenuDismissal();
  watchSyncError();
  watchProxyTests();
  render();
  // After first paint — these can re-render, and refreshNav() needs the bar
  // render() has just installed.
  watchProxyErrors();
  watchPageRequests();
  watchDashboardSignals();
  // The popup sets and clears per-site overrides; they are junction 0 on the map.
  const reloadOverrides = (): void => {
    void loadTempRules(config.activeId, 'regular')
      .catch(() => [])
      .then((rules) => setOverrides(rules));
    void loadListRouteCtx().then(() => refreshListRoute?.());
  };
  onTempRulesChanged(reloadOverrides);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[CONTROL_KEY]) void loadListRouteCtx().then(() => refreshListRoute?.());
  });
  // Flag settings that arrived without their permission — imported or synced
  // configs, profiles created before auth support, or a grant revoked from
  // chrome://extensions.
  void refreshPermState();
  // A staged update the worker has already written down, and any that lands
  // while this page sits open — the wait can run for days, so this page is
  // quite likely to be the thing that is open when Chrome announces one.
  void refreshUpdateState();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[UPDATE_KEY]) void refreshUpdateState();
  });
  // Pinning is done from Chrome's own menu, with this page sitting open behind
  // it — so the banner has to answer to that, not only to a reload. Chrome 127+;
  // older builds pick it up the next time this page is opened.
  chrome.action.onUserSettingsChanged?.addListener(() => void refreshPermState());
  chrome.permissions.onAdded.addListener(() => {
    void refreshPermState();
    if (dashboardMounted()) repaintDashboard();
  });
  chrome.permissions.onRemoved.addListener(() => {
    void refreshPermState();
    if (dashboardMounted()) repaintDashboard();
  });
});
