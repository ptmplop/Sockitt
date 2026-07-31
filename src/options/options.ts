import { avatarEl, builtinTile, initialsFor } from '../shared/avatar';
import {
  dashboardMounted,
  dashboardPanel,
  repaintDashboard,
  setApplied,
  setAuthGranted,
  setControlLevel,
  setHistory,
} from './dashboard';
import { docsPanel } from './docs';
import { EXIT_IP_PERMS, flagSrc } from '../shared/exitip';
import { TraceEdge, pacRequestUrl, patternError, resolveRoute } from '../shared/match';
import { RULE_LIST_MAX_BYTES, looksLikeSwitchyOmega, parseRuleList } from '../shared/rulelist';
import { networkPanel } from './network';
import { releasesPanel } from './releases';
import {
  ERROR_KEY,
  ERROR_LOG_KEY,
  ProxyAlert,
  ProxyErrorEntry,
  ProxyRef,
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
  UiPrefs,
  defaultUiPrefs,
  loadConfig,
  loadHistory,
  loadTempRules,
  loadUiPrefs,
  newProxyProfile,
  newRuleListProfile,
  newSwitchProfile,
  newVirtualProfile,
  onConfigChanged,
  proxyHostError,
  sanitizeConfig,
  saveConfig,
  saveConfigRaw,
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
  SYSTEM,
  TABS_PERMS,
  VirtualProfile,
  hasCredentials,
  proxyProfiles,
  reachableFrom,
  schemeSupportsAuth,
  uid,
} from '../shared/types';
import { el, relativeTime, toast } from '../shared/ui';

const app = document.getElementById('app')!;
const DASH_ID = '@dash';
const SETTINGS_ID = '@settings';
const DOCS_ID = '@docs';
const INSPECT_ID = '@inspect';
const ERRORS_ID = '@errors';
const NETWORK_ID = '@network';
/** Reached from the Documentation page; deliberately not in the sidebar. */
const RELEASES_ID = '@releases';
/**
 * The nav entries that are pages rather than profiles. Kept as one set so a new
 * page cannot be forgotten by the "selected profile was deleted" check below —
 * forgetting it there silently bounces the user off the page on any config change.
 * A page with no sidebar entry belongs here too: it is still somewhere the user
 * can be standing when the config changes under them.
 */
const PAGE_IDS = new Set<string>([
  DASH_ID,
  SETTINGS_ID,
  DOCS_ID,
  INSPECT_ID,
  ERRORS_ID,
  NETWORK_ID,
  RELEASES_ID,
]);

/**
 * Feather-style icons for the "Extension" nav items. Crisp, uniformly sized
 * SVGs replace the old font glyphs (⚙ / ⌕ / ?), which rendered at very
 * different visual sizes at the tile's ~9px glyph size (the ⌕ magnifier
 * especially looked tiny next to the gear).
 */
const NAV_ICON = {
  // A bento of unequal panes — the dashboard's own layout, at 14px.
  overview:
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="10" rx="1.5"/><rect x="13" y="3" width="8" height="6" rx="1.5"/><rect x="3" y="15" width="8" height="6" rx="1.5"/><rect x="13" y="11" width="8" height="10" rx="1.5"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  // Points down when the disclosure it sits in is open; CSS does the turning.
  chevron:
    '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>',
  // A trace, the way a monitor draws one.
  activity:
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 12 7 12 10 5 14 19 17 12 21 12"/></svg>',
  help:
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  grip:
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="9" y1="6" x2="9" y2="6"/><line x1="15" y1="6" x2="15" y2="6"/><line x1="9" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="15" y2="12"/><line x1="9" y1="18" x2="9" y2="18"/><line x1="15" y1="18" x2="15" y2="18"/></svg>',
  plus:
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  alert:
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

/** Neutral tile holding a nav-icon SVG — same tile as builtinTile, crisp glyph. */
function iconTile(svg: string, size: number): HTMLElement {
  const node = el('span', { class: 'avatar builtin', innerHTML: svg });
  node.style.width = node.style.height = `${size}px`;
  return node;
}

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

let config: Config;
let selectedId: string | null = null;
/**
 * Whether the sidebar's Create disclosure is open.
 *
 * Module scope because sidebar() is rebuilt on every render(), so a flag held
 * inside it would close the list under anyone whose click caused a repaint.
 * Not persisted: it is transient, and it resets itself — addProfile() closes it,
 * since creating the thing is what the list was open for.
 */
let createOpen = false;
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

/* ---------- sidebar ---------- */

/**
 * The four things you can make, behind one row.
 *
 * They used to be four permanent rows under a CREATE label at the foot of the
 * nav: five rows and most of a screen-height of sidebar spent on an action
 * taken rarely, as far from where a new install starts as the nav allows. The
 * four identical + tiles were most of the weight, so the options here carry no
 * tile at all — the row above them says Create, and their text lines up with
 * the labels of the tiled rows so the indent reads as belonging rather than as
 * a mistake.
 *
 * A disclosure rather than a popup menu: the sidebar has no floating surface
 * anywhere, and one would need anchoring, outside-click and escape handling to
 * behave. This is a row that opens.
 */
function createDisclosure(): HTMLElement {
  const option = (label: string, factory: (existing: Profile[]) => Profile) =>
    el(
      'button',
      { class: 'nav-item nav-sub', onclick: () => addProfile(factory) },
      el('span', { class: 'name' }, label)
    );

  const toggle = el(
    'button',
    {
      class: `nav-item nav-create-toggle${createOpen ? ' open' : ''}`,
      ariaExpanded: String(createOpen),
      onclick: () => {
        createOpen = !createOpen;
        render();
      },
    },
    iconTile(NAV_ICON.plus, 22),
    el('span', { class: 'name' }, 'Create'),
    el('span', { class: 'nav-chevron', innerHTML: NAV_ICON.chevron })
  );

  // Wrapped, not appended as siblings: under 820px .nav becomes a multi-column
  // grid, and loose rows would be dealt into its columns with an indent that
  // then means nothing. The container spans every column instead — the same
  // move .nav .section-label already makes there.
  return el(
    'div',
    { class: 'nav-create' },
    toggle,
    createOpen
      ? el(
          'div',
          { class: 'nav-create-list', role: 'group', ariaLabel: 'Create a profile' },
          option('Proxy', newProxyProfile),
          option('Auto switch', newSwitchProfile),
          option('Rule list', newRuleListProfile),
          option('Alias', newVirtualProfile)
        )
      : null
  );
}

function sidebar(): HTMLElement {
  const item = (p: Profile) =>
    el(
      'button',
      {
        class: `nav-item${p.id === selectedId ? ' selected' : ''}`,
        onclick: () => {
          selectedId = p.id;
          render();
        },
      },
      avatarEl(p, 22),
      el('span', { class: 'name' }, p.name),
      config.activeId === p.id ? el('span', { class: 'badge' }, 'ACTIVE') : null
    );

  const groups = PROFILE_KINDS.flatMap((kind) => {
    const items = config.profiles.filter((p) => p.kind === kind);
    return items.length
      ? [el('div', { class: 'section-label' }, KIND_LABEL[kind]), ...items.map(item)]
      : [];
  });

  return el(
    'aside',
    { class: 'side' },
    el(
      'div',
      { class: 'brand' },
      el('img', { class: 'mark', src: 'img/logo-mark.png', alt: '' }),
      el(
        'span',
        { class: 'brand-text' },
        el('span', { class: 'brand-name' }, 'Sockitt'),
        el('span', { class: 'brand-sub' }, 'Proxy Switcher')
      )
    ),
    el(
      'nav',
      { class: 'nav' },
      // The home, above the profile groups rather than inside "Extension" —
      // it is where the page opens, not one of its tools.
      el(
        'button',
        {
          class: `nav-item${selectedId === DASH_ID ? ' selected' : ''}`,
          onclick: () => {
            selectedId = DASH_ID;
            render();
          },
        },
        iconTile(NAV_ICON.overview, 22),
        el('span', { class: 'name' }, 'Overview')
      ),
      createDisclosure(),
      ...groups,
      el('div', { class: 'section-label' }, 'Extension'),
      el(
        'button',
        {
          class: `nav-item${selectedId === SETTINGS_ID ? ' selected' : ''}`,
          onclick: () => {
            selectedId = SETTINGS_ID;
            render();
          },
        },
        iconTile(NAV_ICON.settings, 22),
        el('span', { class: 'name' }, 'Settings')
      ),
      el(
        'button',
        {
          class: `nav-item${selectedId === ERRORS_ID ? ' selected' : ''}`,
          onclick: () => {
            selectedId = ERRORS_ID;
            render();
          },
        },
        iconTile(NAV_ICON.alert, 22),
        el('span', { class: 'name' }, 'Proxy errors'),
        // The count only rides the nav while failures are live; the page itself
        // is always reachable, because the log outlives the incident.
        proxyAlert
          ? el('span', { class: 'badge alert' }, proxyAlert.streak > 9 ? '9+' : String(proxyAlert.streak))
          : null
      ),
      el(
        'button',
        {
          class: `nav-item${selectedId === INSPECT_ID ? ' selected' : ''}`,
          onclick: () => {
            selectedId = INSPECT_ID;
            render();
          },
        },
        iconTile(NAV_ICON.search, 22),
        el('span', { class: 'name' }, 'Route inspector')
      ),
      el(
        'button',
        {
          class: `nav-item${selectedId === NETWORK_ID ? ' selected' : ''}`,
          onclick: () => {
            selectedId = NETWORK_ID;
            render();
          },
        },
        iconTile(NAV_ICON.activity, 22),
        el('span', { class: 'name' }, 'Network monitor')
      ),
      el(
        'button',
        {
          // Lit for the release history too. It has no entry of its own and is
          // only reachable from Docs, so leaving the whole sidebar unlit there
          // reads as having fallen off the page rather than gone a level down.
          class: `nav-item${selectedId === DOCS_ID || selectedId === RELEASES_ID ? ' selected' : ''}`,
          onclick: () => {
            selectedId = DOCS_ID;
            render();
          },
        },
        iconTile(NAV_ICON.help, 22),
        el('span', { class: 'name' }, 'Docs')
      )
    ),
    el(
      'div',
      { class: 'tools' },
      el('button', { class: 'btn ghost', onclick: exportConfig }, 'Export'),
      el('button', { class: 'btn ghost', onclick: importConfig }, 'Import'),
      el('button', { class: 'btn ghost danger', onclick: resetConfig }, 'Reset')
    ),
    el(
      'div',
      { class: 'side-footer' },
      el(
        'a',
        {
          class: 'side-link ipcheck',
          href: 'https://ipconfig.is',
          target: '_blank',
          rel: 'noopener noreferrer',
          title: 'Open ipconfig.is in a new tab to check your current IP and location',
          innerHTML:
            '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></svg>',
        },
        el('span', {}, 'Check your IP')
      ),
      el(
        'a',
        {
          class: 'side-link',
          href: 'https://github.com/ptmplop/Sockitt',
          target: '_blank',
          rel: 'noopener noreferrer',
          innerHTML:
            '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>',
        },
        el('span', {}, 'View on GitHub')
      ),
      // Buy Me a Coffee ship a <script> widget, which an MV3 extension cannot
      // use: the default extension CSP is script-src 'self', and remotely
      // hosted code is barred from the store outright. It would also mean a
      // third party seeing every visit to this page, which is not a trade this
      // extension makes anywhere else. So: a plain link, wearing their colours,
      // that contacts nobody until it is clicked.
      el(
        'a',
        {
          class: 'side-link bmc',
          href: 'https://buymeacoffee.com/ipbadger',
          target: '_blank',
          rel: 'noopener noreferrer',
          title: 'Support Sockitt — opens buymeacoffee.com in a new tab',
          innerHTML:
            '<svg class="bmc-cup" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M4 9h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/>' +
            '<path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17"/>' +
            '<path d="M8 3v2M12 2.5V5"/>' +
            '</svg>',
        },
        el('span', {}, 'Buy me a coffee')
      )
    )
  );
}

function addProfile(factory: (existing: Profile[]) => Profile): void {
  const profile = factory(config.profiles);
  config.profiles.push(profile);
  selectedId = profile.id;
  // The list was open to do this; leaving it open would push the profile groups
  // down on a page that has just navigated away to the new profile's editor.
  createOpen = false;
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
  const preview = el('div', { class: 'id-preview' });
  const renderPreview = () => preview.replaceChildren(avatarEl(profile, 56));
  renderPreview();

  const name = el('input', {
    class: 'input',
    value: profile.name,
    spellcheck: false,
    oninput: () => {
      profile.name = name.value.trim() || 'Unnamed';
      initials.placeholder = initialsFor({ name: profile.name });
      scheduleSave();
      renderPreview();
      refreshSidebar();
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
      refreshSidebar();
    },
  }) as HTMLInputElement;

  return el(
    'div',
    { class: 'card panel' },
    el('h3', {}, 'Identity'),
    el(
      'div',
      { class: 'id-row' },
      preview,
      el(
        'div',
        { class: 'id-fields' },
        field('Name', name),
        field('Initials', initials, { extra: [el('span', { class: 'note' }, 'Toolbar icon text')] }),
        el(
          'div',
          { class: 'field id-colors' },
          el('label', {}, 'Colour'),
          el(
            'div',
            { class: 'swatches' },
            ...PALETTE.map((color) =>
              el('button', {
                class: `swatch${profile.color === color ? ' selected' : ''}`,
                style: { background: color },
                title: color,
                onclick: () => {
                  profile.color = color;
                  scheduleSave();
                  render();
                },
              })
            )
          )
        )
      )
    )
  );
}

function dangerZone(profile: Profile): HTMLElement {
  return el(
    'div',
    { class: 'card panel danger-zone' },
    el('h3', {}, 'Danger zone'),
    el(
      'div',
      { class: 'danger-row' },
      el('span', { class: 'muted' }, 'Remove this profile and any rules pointing at it.'),
      el(
        'button',
        {
          class: 'btn danger',
          onclick: () => {
            if (!confirmMaybe(`Delete “${profile.name}”?`)) return;
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
            config.settings.quickSwitchIds = config.settings.quickSwitchIds.filter(
              (id) => id !== profile.id
            );
            if (config.settings.startupProfileId === profile.id) config.settings.startupProfileId = '';
            if (config.settings.incognitoProfileId === profile.id) config.settings.incognitoProfileId = '';
            if (config.activeId === profile.id) config.activeId = SYSTEM;
            selectedId = config.profiles[0]?.id ?? null;
            scheduleSave();
            render();
          },
        },
        'Delete profile'
      )
    )
  );
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

async function refreshPermState(): Promise<void> {
  const [auth, tabs, incognito, userSettings] = await Promise.all([
    chrome.permissions.contains(AUTH_PERMS).catch(() => false),
    chrome.permissions.contains(TABS_PERMS).catch(() => false),
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
  if (auth === authPermGranted && tabs === tabsPermGranted && !asideMoved) return;
  authPermGranted = auth;
  tabsPermGranted = tabs;
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
  if (await chrome.permissions.contains(TABS_PERMS).catch(() => false)) {
    tabsPermGranted = true;
  } else {
    const granted = await chrome.permissions.request(TABS_PERMS).catch(() => false);
    toast(granted ? 'Per-tab badge enabled' : 'Permission needed for the per-tab badge');
    tabsPermGranted = granted;
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
 * `action` is optional: pinning is done from Chrome's own puzzle-piece menu,
 * which no extension API can open, so that banner has to say where to go rather
 * than offer to take you there. A button that only pretended to would be worse
 * than none.
 */
function warnBanner(message: string, action?: string, onclick?: () => void): HTMLElement {
  return el(
    'div',
    { class: 'warn-banner' },
    el('span', {}, message),
    action ? el('button', { class: 'btn sm', onclick }, action) : null
  );
}

/** One banner per setting that is switched on but inert without its grant. */
function permWarningBanners(): HTMLElement[] {
  const banners: HTMLElement[] = [];
  if (authPermMissing()) {
    banners.push(
      warnBanner(
        'A proxy profile has credentials, but the permission to answer authentication challenges hasn’t been granted — proxy auth is inactive.',
        'Enable authentication',
        () => void requestAuthPermission()
      )
    );
  }
  if (badgePermMissing()) {
    banners.push(
      warnBanner(
        'The per-tab route badge is switched on, but the optional "tabs" permission hasn’t been granted — the badge stays blank.',
        'Enable badge',
        () => void requestTabsPermission()
      )
    );
  }
  if (incognitoAccessMissing()) {
    banners.push(
      warnBanner(
        'Incognito windows are set to use their own profile, but Chrome hasn’t allowed Sockitt in incognito — those windows follow the regular profile instead. Turn on "Allow in Incognito" under Details.',
        'Open Sockitt’s details',
        openExtensionDetails
      )
    );
  }
  if (actionUnpinned()) {
    banners.push(
      warnBanner(
        'Sockitt isn’t pinned to the toolbar, so its icon shows the plain Sockitt mark instead of the active profile. Unpinned, the icon appears only in Chrome’s puzzle-piece menu, which reads it once when the menu opens and never updates it — it could show a profile that has since changed, or another window’s. To pin: click the puzzle piece in the toolbar, then the pin beside Sockitt.'
      )
    );
  }
  return banners;
}

/**
 * Toggle the banners in place instead of re-rendering the page: permission
 * state can change while the user is mid-typing in the editor (the prompt is
 * triggered from a field's onchange), and a full render would wipe the
 * uncommitted sibling field.
 */
function updatePermBanners(): void {
  const content = document.querySelector('.content');
  if (!content) return;
  content.querySelectorAll(':scope > .warn-banner').forEach((n) => n.remove());
  // Prepend in reverse so the banners keep permWarningBanners' order above the
  // panel, whatever else the content column already holds.
  for (const banner of permWarningBanners().reverse()) content.prepend(banner);
}

function proxyEditor(profile: ProxyProfile): HTMLElement {
  const schemeSel = el('select', { class: 'input' }) as HTMLSelectElement;
  for (const [value, label] of Object.entries(SCHEME_LABELS)) {
    schemeSel.append(el('option', { value }, label));
  }
  schemeSel.value = profile.scheme;
  schemeSel.onchange = () => {
    // Deliberately keep username/password: a transient flip through a SOCKS
    // option (misclick, arrow-keying past) must not destroy saved credentials.
    // The sanitizer drops them at the load boundary if the profile is left on
    // a scheme that can't use them.
    profile.scheme = schemeSel.value as ProxyScheme;
    scheduleSave();
    render();
  };

  // role="alert" makes each error node a live region, so a screen reader
  // announces the validation message when it appears — the invalid state is no
  // longer signalled by border colour + hover title alone.
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
      // Only commit a valid host — a blank or directive-breaking value must not
      // be saved and applied, where it would fail silently to DIRECT.
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
    value: profile.bypass.join('\n'),
    placeholder: '<local>\n*.internal.example\n10.0.0.0/8',
    spellcheck: false,
    oninput: () => {
      profile.bypass = bypass.value.split('\n').map((s) => s.trim()).filter(Boolean);
      scheduleSave();
    },
  }) as HTMLTextAreaElement;

  const testResult = el('span', {
    class: 'note test-result',
    dataset: { profile: profile.id },
  });
  /**
   * Drop a previous verdict once the address it was about changes. The line is
   * written by the test click and by watchProxyTests, and nothing else cleared
   * it — so a green "Connection successful · 203.0.113.9 · 45 ms" would sit
   * under a host the user had since retyped, which is a claim about a server
   * that is no longer configured.
   *
   * A test already in flight is the same claim arriving late: the worker will
   * still answer, and watchProxyTests keys only on the profile id, so its
   * verdict would land under the edited address. Mark the line instead, and let
   * watchProxyTests drop that answer.
   */
  const invalidateTest = (): void => {
    if (!testResult.textContent) return;
    if ((testBtn as HTMLButtonElement).disabled) testResult.dataset.stale = '1';
    testResult.replaceChildren();
    testResult.removeAttribute('title');
    testResult.classList.remove('ok', 'bad');
  };

  const authPanel = schemeSupportsAuth(profile.scheme)
    ? // Credentials decide the verdict as much as the address does — the test
      // refuses to run without the auth grant precisely so a 407 cannot be
      // misread as a dead proxy.
      authSection(profile, invalidateTest)
    : el('div', { class: 'field' }, el('span', { class: 'note' },
        'Chromium cannot authenticate SOCKS proxies — secure the proxy by IP allow-list or a local tunnel (e.g. ssh -D).'));

  const ipLookupsOn = config.settings.exitIpCheck;
  const testBtn = el(
    'button',
    {
      class: 'btn test-btn',
      disabled: !ipLookupsOn, // the test is an ipconfig.is lookup — gated by the master switch
      dataset: { profile: profile.id },
      onclick: async () => {
        testResult.classList.remove('ok', 'bad');
        if (!config.settings.exitIpCheck) {
          testResult.textContent = 'Turn on IP address lookups in Settings to test.';
          return;
        }
        if (!(await ensureExitIpPermission())) {
          testResult.textContent = 'Needs access to ipconfig.is to run the check.';
          return;
        }
        if (
          hasCredentials(profile) &&
          !(await chrome.permissions.contains(AUTH_PERMS).catch(() => false))
        ) {
          // Without the auth grant a 407 goes unanswered and the test would
          // paint a red dot on a proxy that is actually fine.
          testResult.textContent =
            'Credentials are set but the auth permission is missing — click Enable authentication first.';
          return;
        }
        (testBtn as HTMLButtonElement).disabled = true;
        testResult.textContent = 'Testing — briefly routing through this proxy…';
        testResult.removeAttribute('title');
        delete testResult.dataset.stale; // this verdict will be about what is on screen now
        // The worker owns chrome.proxy; hand it the request — with the editor's
        // current (possibly unsaved) values — over session storage, so the
        // test needs no save and triggers no racing re-apply.
        await chrome.storage.session.set({
          [TEST_KEY]: {
            profileId: profile.id,
            nonce: Date.now(),
            scheme: profile.scheme,
            host: profile.host,
            port: profile.port,
          },
        });
      },
    },
    'Test connection'
  );
  const testRow = el(
    'div',
    { class: 'field' },
    el('label', {}, 'Connection test'),
    el('div', { class: 'test-row' }, testBtn, testResult),
    el(
      'span',
      { class: 'note' },
      ipLookupsOn
        ? 'Routes your browsing through this proxy for a few seconds to fetch ipconfig.is (exit IP, country, latency), then restores your configuration.'
        : 'The connection test uses ipconfig.is — turn on IP address lookups in Settings to enable it.'
    )
  );

  return el(
    'div',
    { class: 'pane' },
    identityPanel(profile),
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Proxy server'),
      el(
        'div',
        { class: 'field-grid trio' },
        field('Protocol', schemeSel),
        field('Host', host, { extra: [hostErr] }),
        field('Port', port, { extra: [portErr] })
      ),
      authPanel,
      testRow
    ),
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Bypass list'),
      field('One entry per line — these hosts connect directly', bypass, {
        extra: [
          el('span', { class: 'note' }, '<local> matches plain hostnames and localhost. Also accepts *.suffix wildcards and IPv4 CIDR blocks.'),
        ],
      })
    ),
    dangerZone(profile)
  );
}

function authSection(profile: ProxyProfile, invalidateTest: () => void): HTMLElement {
  const username = el('input', {
    class: 'input',
    value: profile.username ?? '',
    placeholder: 'username (optional)',
    autocomplete: 'off',
    spellcheck: false,
    onchange: () => {
      invalidateTest();
      profile.username = username.value.trim() || undefined;
      scheduleSave();
      if (hasCredentials(profile)) void requestAuthPermission();
      else updatePermBanners(); // may have just cleared the banner's cause
    },
  }) as HTMLInputElement;

  const password = el('input', {
    class: 'input',
    type: 'password',
    value: profile.password ?? '',
    placeholder: 'password',
    autocomplete: 'off',
    onchange: () => {
      invalidateTest();
      profile.password = password.value || undefined;
      scheduleSave();
      if (hasCredentials(profile)) void requestAuthPermission();
      else updatePermBanners(); // may have just cleared the banner's cause
    },
  }) as HTMLInputElement;

  return el(
    'div',
    { class: 'field' },
    el('label', {}, 'Authentication'),
    el(
      // "plain": these two fields carry no labels of their own, so they opt out
      // of the label/control/note bands the other field grids share.
      'div',
      { class: 'field-grid plain' },
      el('div', { class: 'field' }, username),
      el('div', { class: 'field' }, password)
    ),
    el(
      'span',
      { class: 'note' },
      'Credentials are used only for HTTP/HTTPS proxies. Answering proxy auth needs an optional permission (webRequest + all sites); Sockitt asks for it when you set credentials here. Credentials stay on this device — they are not synced.'
    ),
    el(
      'button',
      {
        class: 'btn',
        style: { alignSelf: 'flex-start' },
        onclick: () => void requestAuthPermission(),
      },
      'Enable authentication'
    )
  );
}

/* ---------- switch editor ---------- */

function switchEditor(profile: SwitchProfile): HTMLElement {
  const rulesBox = el('div', { class: 'rules' });

  const ruleRow = (rule: SwitchProfile['rules'][number], index: number): HTMLElement => {
    const typeSel = el('select', { class: 'input' }) as HTMLSelectElement;
    for (const [value, label] of Object.entries(RULE_TYPES)) {
      typeSel.append(el('option', { value }, label));
    }
    typeSel.value = rule.type;

    const pattern = el('input', {
      class: 'input mono',
      value: rule.pattern,
      placeholder: placeholderFor(rule.type),
      spellcheck: false,
      // The rule table is a grid with column headers rather than per-input
      // labels, so name the field for screen readers directly.
      ariaLabel: 'Rule pattern',
    }) as HTMLInputElement;

    const markValidity = () => {
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
    };
    pattern.oninput = () => {
      rule.pattern = pattern.value;
      markValidity();
      scheduleSave();
    };

    const enabled = el('input', {
      class: 'toggle',
      type: 'checkbox',
      // Without a name a screen reader reads a column of identical "checkbox"es.
      ariaLabel: `Rule ${index + 1} enabled`,
      checked: rule.enabled,
      onchange: () => {
        rule.enabled = enabled.checked;
        row.classList.toggle('disabled', !rule.enabled);
        scheduleSave();
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
        innerHTML: NAV_ICON.grip,
      }),
      typeSel,
      pattern,
      targetSelect(profile.id, rule.targetId, (v) => {
        rule.targetId = v;
        scheduleSave();
      }),
      enabled,
      el('button', {
        class: 'btn ghost icon',
        title: 'Delete rule',
        innerHTML: '&#10005;',
        onclick: () => {
          profile.rules = profile.rules.filter((r) => r.id !== rule.id);
          scheduleSave();
          render();
        },
      })
    );
    wireDrag(row, rulesBox, () => {
      const order = [...rulesBox.querySelectorAll<HTMLElement>('.rule')].map((n) => n.dataset.id);
      profile.rules.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      renumberRules();
      scheduleSave();
    });
    return row;
  };

  /**
   * The rule aria-labels carry a position, and reordering deliberately never
   * re-renders — it moves the live row and sorts the model — so without this a
   * dragged rule announces the place it was built in, forever.
   */
  const renumberRules = (): void => {
    rulesBox.querySelectorAll<HTMLElement>('.rule').forEach((n, i) => {
      n.querySelector('.grip')?.setAttribute('aria-label', `Reorder rule ${i + 1}`);
      n.querySelector('.toggle')?.setAttribute('aria-label', `Rule ${i + 1} enabled`);
    });
  };

  rulesBox.append(
    el('div', { class: 'rule-head' },
      el('span'), el('span', {}, 'Condition'), el('span', {}, 'Pattern'),
      el('span', {}, 'Route via'), el('span', {}, 'On'), el('span')),
    ...profile.rules.map(ruleRow)
  );

  return el(
    'div',
    { class: 'pane' },
    identityPanel(profile),
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Rules — first match wins'),
      rulesBox,
      el(
        'button',
        {
          class: 'btn',
          style: { alignSelf: 'flex-start' },
          onclick: () => {
            profile.rules.push({
              id: uid(),
              enabled: true,
              type: 'hostWildcard',
              pattern: '',
              targetId: proxyProfiles(config)[0]?.id ?? DIRECT,
            });
            scheduleSave();
            render();
          },
        },
        '+ Add rule'
      ),
      (() => {
        const sel = targetSelect(profile.id, profile.defaultTargetId, (v) => {
          profile.defaultTargetId = v;
          scheduleSave();
        });
        if (!sel.id) sel.id = `fld-${++fieldSeq}`;
        return el(
          'div',
          { class: 'default-row' },
          el('label', { htmlFor: sel.id }, 'Everything else'),
          sel,
          el('span', { class: 'note' }, 'Used when no rule above matches.')
        );
      })()
    ),
    dangerZone(profile)
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
 * Fetch a rule list's body and store it. One copy, shared by the editor's
 * "Update now" and the dashboard's "Fetch now" — the care here is in the
 * re-find and the rollback, and two copies of that is one too many.
 *
 * Always repaints when it returns, whatever the outcome, so the caller's button
 * comes back without every call site having to remember to restore it.
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
  try {
    const response = await fetch(before.url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!text.trim()) throw new Error('Empty response');
    // Parsing is synchronous and sits on the PAC-compile path, so an unbounded
    // body is an unbounded stall — refuse it here rather than store something
    // the worker will choke on later.
    if (text.length > RULE_LIST_MAX_BYTES) {
      throw new Error(`List is too large (over ${RULE_LIST_MAX_BYTES / 1048576} MB)`);
    }
    // The page's snapshot can be swapped out across that await — a popup write,
    // a second options tab or a sync pull all reassign `config` — which orphans
    // the profile captured before it. Writing to that one would drop the fetch
    // on the floor while the toast claimed success, so re-find it by id the way
    // the popup's commitConfig does.
    const live = config.profiles.find((p) => p.id === profileId);
    if (!live || live.kind !== 'rulelist') throw new Error('Profile no longer exists');
    const prevText = live.text;
    const prevUpdated = live.lastUpdated;
    live.text = text;
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
    toast('List updated');
  } catch (e) {
    toast(`Update failed: ${e instanceof Error ? e.message : e}`);
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
      scheduleSave();
    },
  }) as HTMLInputElement;

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
      'and plain domain lists — SwitchyOmega’s typed conditions (UrlRegex:, Keyword:, ' +
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
      ? 'This pasted list is too large to sync (over ~8 KB). Other devices won’t receive it — add a URL so they can fetch it, or paste it on each device.'
      : '';
  };
  refreshSizeWarn();

  const updateNow = el(
    'button',
    {
      class: 'btn',
      onclick: () => {
        updateNow.textContent = 'Updating…';
        (updateNow as HTMLButtonElement).disabled = true;
        // refetchRuleList repaints when it settles, which rebuilds this button
        // in either outcome — there is nothing to restore by hand.
        void refetchRuleList(profile.id);
      },
    },
    'Update now'
  );

  return el(
    'div',
    { class: 'pane' },
    identityPanel(profile),
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Source'),
      el(
        'div',
        { class: 'field-grid' },
        field('URL', url),
        // The unit belongs under the control, not in the label: a two-line label
        // in a 150px column used to push this input off the URL input's baseline.
        field('Auto-update', interval, { extra: [el('span', { class: 'note' }, 'Hours · 0 = off')] })
      ),
      el(
        'div',
        { class: 'rl-actions' },
        field('Format', format, { style: { flex: '1' } }),
        updateNow
      ),
      field('List content', source, { extra: [status, rejects, formatWarn, sizeWarn, syntaxHelp] }),
      el('span', { class: 'note' },
        'The URL host must allow cross-origin requests (raw.githubusercontent.com does). GFWList base64 payloads are decoded automatically.')
    ),
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Routing'),
      el(
        'div',
        { class: 'field-grid wide' },
        field('Matching entries route via',
          targetSelect(profile.id, profile.matchTargetId, (v) => {
            profile.matchTargetId = v;
            scheduleSave();
          })),
        field('Everything else (and whitelist)',
          targetSelect(profile.id, profile.defaultTargetId, (v) => {
            profile.defaultTargetId = v;
            scheduleSave();
          }))
      )
    ),
    dangerZone(profile)
  );
}

/* ---------- virtual (alias) editor ---------- */

function virtualEditor(profile: VirtualProfile): HTMLElement {
  return el(
    'div',
    { class: 'pane' },
    identityPanel(profile),
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Alias target'),
      field(
        'Activating or targeting this alias routes via',
        targetSelect(profile.id, profile.targetId, (v) => {
          profile.targetId = v;
          scheduleSave();
        }),
        {
          extra: [
            el('span', { class: 'note' },
              'Point switch rules and rule lists at an alias, then swap the alias target to retarget them all at once.'),
          ],
        }
      )
    ),
    dangerZone(profile)
  );
}

/* ---------- settings panel ---------- */

function toggleRow(
  label: string,
  description: string,
  checked: boolean,
  onChange: (v: boolean) => void | Promise<boolean | void>
): HTMLElement {
  const input = el('input', {
    class: 'toggle',
    type: 'checkbox',
    checked,
    onchange: async () => {
      const result = await onChange(input.checked);
      if (result === false) input.checked = !input.checked; // rejected (e.g. permission denied)
      scheduleSave();
      refreshSidebar();
    },
  }) as HTMLInputElement;
  return el(
    'label',
    { class: 'setting-row' },
    el(
      'span',
      { class: 'setting-text' },
      el('span', { class: 'setting-label' }, label),
      el('span', { class: 'note' }, description)
    ),
    input
  );
}

function settingsPanel(): HTMLElement {
  const s = config.settings;

  const quickList = el(
    'div',
    { class: 'quick-list' },
    ...[
      { id: DIRECT, name: 'Direct' },
      { id: SYSTEM, name: 'System' },
      ...config.profiles.map((p) => ({ id: p.id, name: p.name })),
    ].map((entry) => {
      const check = el('input', {
        type: 'checkbox',
        checked: s.quickSwitchIds.includes(entry.id),
        onchange: () => {
          s.quickSwitchIds = check.checked
            ? [...s.quickSwitchIds, entry.id]
            : s.quickSwitchIds.filter((id) => id !== entry.id);
          scheduleSave();
        },
      }) as HTMLInputElement;
      return el('label', { class: 'quick-item' }, check, entry.name);
    })
  );

  const startup = el('select', { class: 'input' }) as HTMLSelectElement;
  startup.append(
    el('option', { value: '' }, 'Last used (default)'),
    el('option', { value: DIRECT }, 'Direct'),
    el('option', { value: SYSTEM }, 'System')
  );
  for (const p of config.profiles) startup.append(el('option', { value: p.id }, p.name));
  startup.value = s.startupProfileId;
  startup.onchange = () => {
    s.startupProfileId = startup.value;
    scheduleSave();
  };

  const incognito = el('select', { class: 'input', style: { maxWidth: '280px' } }) as HTMLSelectElement;
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
    // clearing it is what stops it mattering. Neither reaches the banner on its
    // own, because no permission event fires for Chrome's own switch.
    updatePermBanners();
  };
  const landing = el('select', { class: 'input' }) as HTMLSelectElement;
  landing.append(
    el('option', { value: 'overview' }, 'Overview (default)'),
    el('option', { value: 'last' }, 'The page I had open last')
  );
  landing.value = uiPrefs.landing;
  landing.onchange = () => {
    uiPrefs = { ...uiPrefs, landing: landing.value as LandingPage };
    void saveUiPrefs(uiPrefs).then(() => toast('Saved'));
  };

  const incognitoNote = el(
    'span',
    { class: 'note' },
    'Route incognito windows through their own profile; regular windows are unaffected. Those windows show that profile in the toolbar and the popup, and it can be changed from there too.'
  );
  // The requirement belongs on the field in BOTH states. It used to replace the
  // description above when access was missing — so whoever had it granted was
  // never told what the setting depends on (and could not tell that revoking it
  // would quietly undo this), while whoever had not was told the requirement
  // instead of what the setting does. A second line says which, and names the
  // exact switch rather than pointing at a page with dozens of them.
  const incognitoAccessNote = el('span', { class: 'note' });
  void chrome.extension
    .isAllowedIncognitoAccess()
    .then((allowed) => {
      if (allowed) {
        incognitoAccessNote.textContent =
          'Sockitt is allowed in incognito (Extensions › Sockitt › Details › Allow in Incognito), so this is in force.';
        return;
      }
      incognitoAccessNote.className = 'note warn';
      incognitoAccessNote.setAttribute('role', 'alert');
      incognitoAccessNote.replaceChildren(
        'Needs Chrome to allow Sockitt in incognito first — Extensions › Sockitt › Details › Allow in Incognito. Until then incognito windows follow the regular profile. ',
        el('button', { class: 'linklike', onclick: openExtensionDetails }, 'Open Sockitt’s details')
      );
    })
    .catch(() => undefined);

  return el(
    'div',
    { class: 'pane' },
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Switching'),
      toggleRow(
        'Quick switch',
        'Toolbar click cycles the profiles below instead of opening the popup. Tick at least two — with fewer, the cycle falls back to Direct, System, and every profile. The cycle keyboard shortcut always works (set it at chrome://extensions/shortcuts).',
        s.quickSwitch,
        (v) => {
          s.quickSwitch = v;
        }
      ),
      quickList,
      field('On browser startup, activate', startup, { style: { maxWidth: '280px' } }),
      // The width goes on the select, not the field: this is the one field here
      // carrying two lines of copy, and capping the whole column would set them
      // in a 280px measure — four lines of amber in a ribbon down the page.
      field('Incognito windows use', incognito, {
        extra: [incognitoNote, incognitoAccessNote],
      }),
      toggleRow(
        'Reload tab after switching',
        'Refresh the active tab when you pick a profile — once you close the popup.',
        s.refreshOnSwitch,
        (v) => {
          s.refreshOnSwitch = v;
        }
      )
    ),
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Behaviour'),
      toggleRow(
        'Guard proxy control',
        'If another extension takes over proxy settings, take them back automatically (at most every 30 seconds).',
        s.revertExternal,
        (v) => {
          s.revertExternal = v;
        }
      ),
      toggleRow(
        'Per-tab route badge',
        'Show which profile the current tab routes through as a toolbar badge. Requires the optional "tabs" permission.',
        s.badgeResult,
        async (v) => {
          if (!v) {
            s.badgeResult = false;
            updatePermBanners(); // the setting is off; nothing left to warn about
            return;
          }
          if (!(await requestTabsPermission())) return false;
          s.badgeResult = true;
          updatePermBanners();
        }
      ),
      toggleRow(
        'IP address lookups',
        'The popup’s exit-IP readout — the flag, IP, and latency shown under the active tab — and the proxy connection test. Off by default: both stay off until you turn this on, and turning it off disables them. Enabling asks for the network access it needs.',
        s.exitIpCheck,
        async (v) => {
          if (v && !(await ensureExitIpPermission())) {
            toast('Permission declined');
            return false;
          }
          s.exitIpCheck = v;
        }
      ),
      toggleRow(
        'Quick-added rules go to the bottom',
        'Rules added from the popup append below existing rules (off = they take top priority).',
        s.addToBottom,
        (v) => {
          s.addToBottom = v;
        }
      ),
      toggleRow(
        'Confirm before deleting',
        'Ask before profiles are deleted or everything is reset.',
        s.confirmDeletion,
        (v) => {
          s.confirmDeletion = v;
        }
      ),
      // Stored per device, outside the synced configuration on purpose — see
      // the UI-preferences note in state.ts.
      field('This page opens on', landing, {
        style: { maxWidth: '280px' },
        extra: [
          el(
            'span',
            { class: 'note' },
            'A per-device preference — it is not synced to your other browsers.'
          ),
        ],
      })
    ),
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Sync'),
      syncError ? el('div', { class: 'banner' }, `Sync error: ${syncError}`) : null,
      toggleRow(
        'Sync configuration',
        'Mirror profiles and rules to your browser account (chrome.storage.sync) so other machines pick them up. Newest change wins. Large rule-list bodies are not synced — set a URL so each machine can refresh its own copy.',
        s.syncEnabled,
        async (v) => {
          if (!v) {
            s.syncEnabled = false;
            void clearSync();
            return;
          }
          // A remote written by an incompatible schema must not be joined:
          // enabling would push this config over it, and old installs (which
          // have no version gate) would adopt the overwrite — wiping the group.
          const state = await remoteSyncState();
          if (state === 'newer') {
            toast('Sync unavailable: your synced data was written by a newer Sockitt — update this machine first', 4000);
            return false; // snap the toggle back off
          }
          if (state === 'legacy') {
            toast('Sync unavailable: your synced data was written by Sockitt 1.6.2 or older — update every device, or toggle Sync off to clear it and reseed from this machine', 5000);
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
        }
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
    // The row above the first rule is .rule-head, so check the class rather
    // than merely that a sibling exists.
    const neighbour = up ? row.previousElementSibling : row.nextElementSibling;
    if (!neighbour?.classList.contains('rule')) return;
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
    toast('Exported — the backup contains proxy passwords in plain text, keep it safe', 4500);
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

function inspectChip(id: string): HTMLElement {
  if (id === DIRECT) return el('span', { class: 'chain-chip' }, builtinTile('D', 18), 'Direct');
  if (id === SYSTEM) return el('span', { class: 'chain-chip' }, builtinTile('S', 18), 'System');
  const p = config.profiles.find((x) => x.id === id);
  return p
    ? el('span', { class: 'chain-chip' }, avatarEl(p, 18), p.name)
    : el('span', { class: 'chain-chip' }, builtinTile('D', 18), 'Direct');
}

function inspectEdgeLabel(e: TraceEdge): string {
  switch (e.kind) {
    case 'rule':
      return `rule ${e.pattern} (${e.ruleType ? RULE_TYPES[e.ruleType] : 'rule'}) matched`;
    case 'temp-rule':
      return `popup override ${e.pattern} matched`;
    case 'default':
      return 'no rule matched — everything else';
    case 'alias':
      return 'alias points at';
    case 'list-match':
      return 'rule list matched';
    case 'list-default':
      return 'no list match — default';
  }
}

function inspectorPanel(): HTMLElement {
  const results = el('div', { class: 'inspect-results' });
  // Monotonic guard: runs await session storage, so a fast second keystroke
  // could otherwise interleave with the first and stack a stale chain.
  let inspectSeq = 0;

  const urlInput = el('input', {
    class: 'input mono',
    value: inspectUrl,
    placeholder: 'https://foo.example.com/path  (or just a hostname)',
    spellcheck: false,
  }) as HTMLInputElement;

  const startSel = el('select', { class: 'input' }) as HTMLSelectElement;
  startSel.append(el('option', { value: '' }, 'Active profile'));
  for (const p of config.profiles) startSel.append(el('option', { value: p.id }, p.name));
  startSel.value = [...startSel.options].some((o) => o.value === inspectStartId)
    ? inspectStartId
    : '';

  /** Holds the panel's shape before anything is typed, instead of a bare strip. */
  const emptyState = (): HTMLElement =>
    el(
      'p',
      { class: 'inspect-empty' },
      'Nothing to resolve yet — type a URL above and the chain appears here.'
    );

  const runInspect = async (): Promise<void> => {
    const seq = ++inspectSeq;
    inspectUrl = urlInput.value;
    inspectStartId = startSel.value;
    results.replaceChildren();
    const raw = urlInput.value.trim();
    if (!raw) {
      results.append(emptyState());
      return;
    }

    let u: URL;
    try {
      u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      results.append(el('span', { class: 'note' }, 'That does not parse as a URL or hostname.'));
      return;
    }
    const matchUrl = pacRequestUrl(u.href);

    const startId = startSel.value || config.activeId;
    if (startId === DIRECT || startId === SYSTEM) {
      results.append(
        el(
          'div',
          { class: 'chain' },
          inspectChip(startId),
          el(
            'span',
            { class: 'chain-final note' },
            startId === DIRECT
              ? 'Direct is active — every request goes straight to the network.'
              : 'System is active — the OS proxy settings decide; Sockitt rules do not apply.'
          )
        )
      );
      return;
    }
    const start = config.profiles.find((p) => p.id === startId);
    if (!start) {
      results.append(el('span', { class: 'note' }, 'Profile not found.'));
      return;
    }

    // Match real routing: the popup's session override participates only when
    // inspecting the profile that is actually active.
    const temp = startId === config.activeId ? await loadTempRules(config.activeId, 'regular') : [];
    if (seq !== inspectSeq) return; // a newer run owns the results box
    const trace: TraceEdge[] = [];
    const route = resolveRoute(config, start, matchUrl, u.hostname, temp, new Date(), trace);

    const chain = el('div', { class: 'chain' }, inspectChip(start.id));
    for (const edge of trace) {
      chain.append(
        el('span', { class: 'chain-step' }, el('span', { class: 'chain-why' }, inspectEdgeLabel(edge))),
        inspectChip(edge.to)
      );
    }

    const terminal = config.profiles.find((p) => p.id === route.targetId);
    const verdict =
      route.targetId === DIRECT
        ? 'Goes direct — no proxy.'
        : terminal && terminal.kind === 'proxy'
          ? `Routes via ${terminal.name} — ${SCHEME_LABELS[terminal.scheme]} ${terminal.host}:${terminal.port}${route.bypassed ? ', but its bypass list sends this host direct' : ''}.`
          : 'Goes direct.';

    results.append(
      chain,
      el('div', { class: `chain-final${route.bypassed ? ' bypassed' : ''}` }, verdict)
    );
    if (matchUrl !== u.href) {
      results.append(
        el(
          'span',
          { class: 'note' },
          `Note: Chrome hides the path of ${u.protocol}// URLs from routing, so this was matched as ${matchUrl}.`
        )
      );
    }
  };

  urlInput.oninput = () => void runInspect();
  startSel.onchange = () => void runInspect();

  if (inspectUrl.trim()) void runInspect();
  else results.append(emptyState());

  return el(
    'div',
    { class: 'pane' },
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Route inspector'),
      el(
        'p',
        { class: 'note' },
        'Type a URL to see exactly how it would route right now: which rule fires, the chain it walks, and where it lands. Runs the same resolver as real routing, including the popup override on the active profile.'
      ),
      el('div', { class: 'inspect-form' }, urlInput, startSel),
      results
    )
  );
}


/* ---------- proxy errors page ---------- */

/** The profile that was active, linking to its editor when it still exists. */
function errorProfileChip(entry: ProxyErrorEntry): HTMLElement {
  if (entry.profileId === DIRECT) {
    return el('span', { class: 'chain-chip' }, builtinTile('D', 18), 'Direct');
  }
  const profile = config.profiles.find((p) => p.id === entry.profileId);
  if (!profile) {
    // System, or a profile deleted since. Either way the recorded name is the
    // truthful answer — resolving it against today's config would rewrite history.
    return el('span', { class: 'chain-chip' }, builtinTile('S', 18), entry.profileName);
  }
  return el(
    'button',
    {
      class: 'chain-chip link',
      title: `Open ${profile.name}`,
      onclick: () => {
        selectedId = profile.id;
        render();
      },
    },
    avatarEl(profile, 18),
    profile.name
  );
}

/** A proxy server named in an entry; clicking it opens that proxy's editor. */
function errorProxyChip(ref: ProxyRef): HTMLElement {
  const profile = config.profiles.find((p) => p.id === ref.id);
  const inner = [
    profile ? avatarEl(profile, 18) : builtinTile('P', 18),
    el('span', {}, ref.name),
    el('span', { class: 'err-endpoint mono' }, ref.endpoint),
  ];
  if (!profile) return el('span', { class: 'chain-chip' }, ...inner);
  return el(
    'button',
    {
      class: 'chain-chip link',
      title: `Open ${profile.name} — check the address, or run a connection test`,
      onclick: () => {
        selectedId = profile.id;
        render();
      },
    },
    ...inner
  );
}

/**
 * Which proxy was carrying traffic. For a profile that routes everything the
 * same way this is exact; for one that decides per request it is a shortlist,
 * because Chrome's error event genuinely does not name the server — saying so
 * is more useful than picking one and being wrong.
 */
function errorCarrier(entry: ProxyErrorEntry): HTMLElement {
  if (entry.via) {
    return el(
      'div',
      { class: 'err-carrier' },
      viaIsSelf(entry)
        ? el('div', { class: 'chain' }, errorProxyChip(entry.via))
        : el(
            'div',
            { class: 'chain' },
            errorProfileChip(entry),
            el('span', { class: 'chain-step' }, el('span', { class: 'chain-why' }, 'routes everything via')),
            errorProxyChip(entry.via)
          )
    );
  }
  if (entry.candidates?.length) {
    return el(
      'div',
      { class: 'err-carrier' },
      el('div', { class: 'chain' }, errorProfileChip(entry)),
      el(
        'span',
        { class: 'note' },
        `${entry.profileName} picks a server per request, and the browser does not report which one failed. It can route to:`
      ),
      el('div', { class: 'chain' }, ...entry.candidates.map(errorProxyChip))
    );
  }
  return el('div', { class: 'err-carrier' }, el('div', { class: 'chain' }, errorProfileChip(entry)));
}

function errorStatusCard(): HTMLElement {
  if (proxyAlert) {
    const alert = proxyAlert;
    const heading =
      alert.streak > 1
        ? `${alert.streak} proxy errors, the last one ${relativeTime(alert.lastAt)}`
        : `A proxy error, ${relativeTime(alert.lastAt)}`;
    return el(
      'div',
      { class: 'card panel err-status failing' },
      el('h3', {}, 'Live status'),
      el('div', { class: 'err-status-head' }, el('span', { class: 'err-live-dot' }), el('span', { class: 'err-status-title' }, heading)),
      el('p', { class: 'err-code mono' }, errorHeadline(alert)),
      alert.details ? el('p', { class: 'err-detail' }, alert.details) : null,
      errorCarrier(alert),
      el(
        'p',
        { class: 'note' },
        `Started ${relativeTime(alert.at)}. This clears itself — count and all — once 30 seconds go by with no further error. The browser reports failures but never recoveries, so a quiet spell is what “working again” looks like from here.`
      ),
      el(
        'div',
        { class: 'err-actions' },
        el('button', { class: 'btn', dataset: { errAction: 'dismiss' }, onclick: () => void clearProxyAlert() }, 'Dismiss'),
        el('button', { class: 'btn', dataset: { errAction: 'copy' }, onclick: () => void copyErrorReport() }, 'Copy report')
      )
    );
  }

  const last = errorLog[0];
  if (!last) {
    return el(
      'div',
      { class: 'card panel err-status clear' },
      el('h3', {}, 'Live status'),
      el('div', { class: 'err-status-head' }, el('span', { class: 'err-ok-dot' }), el('span', { class: 'err-status-title' }, 'No proxy errors')),
      el(
        'p',
        { class: 'doc-p' },
        'Nothing has failed since this browser started. If a proxy does go down, Sockitt fails the request rather than quietly sending it direct — so you will see the page error, a red mark on the toolbar icon, and the details here.'
      )
    );
  }
  return el(
    'div',
    { class: 'card panel err-status clear' },
    el('h3', {}, 'Live status'),
    el('div', { class: 'err-status-head' }, el('span', { class: 'err-ok-dot' }), el('span', { class: 'err-status-title' }, 'No errors right now')),
    el(
      'p',
      { class: 'doc-p' },
      `The last failure was ${relativeTime(last.lastAt)} and nothing has failed since. The log below is kept so you can still see what happened.`
    ),
    el(
      'div',
      { class: 'err-actions' },
      el('button', { class: 'btn', dataset: { errAction: 'copy' }, onclick: () => void copyErrorReport() }, 'Copy report')
    )
  );
}

/** Plain-English meaning of the most recent failure, when we have one to give. */
function errorMeaningCard(entry: ProxyErrorEntry): HTMLElement | null {
  const advice = errorAdvice(entry);
  if (!advice) return null;
  return el(
    'div',
    { class: 'card panel' },
    el('h3', {}, 'What this means'),
    el('p', { class: 'doc-p' }, advice),
    el(
      'p',
      { class: 'note' },
      'Route inspector shows where a URL lands; a proxy profile’s Test connection says whether that server is reachable at all.'
    )
  );
}

function errorRow(entry: ProxyErrorEntry): HTMLElement {
  return el(
    'div',
    { class: `err-row${entry.fatal ? '' : ' warn'}` },
    el(
      'div',
      { class: 'err-when' },
      el('span', { class: 'err-time mono', title: new Date(entry.at).toLocaleString() }, new Date(entry.at).toLocaleTimeString()),
      entry.count > 1
        ? el(
            'span',
            { class: 'err-count', title: `Last repeat ${new Date(entry.lastAt).toLocaleTimeString()}` },
            `×${entry.count}`
          )
        : null
    ),
    el(
      'div',
      { class: 'err-body' },
      el('div', { class: 'err-code mono' }, errorHeadline(entry)),
      entry.details ? el('div', { class: 'err-detail' }, entry.details) : null,
      el('div', { class: 'err-route' }, describeCarrier(entry))
    ),
    el('span', { class: `err-tag${entry.fatal ? ' fatal' : ''}` }, entry.fatal ? 'fatal' : 'warning')
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
    toast('Could not copy — the browser blocked clipboard access', 3000);
  }
}

function errorsPanel(): HTMLElement {
  const newest = proxyAlert ?? errorLog[0] ?? null;
  return el(
    'div',
    { class: 'pane' },
    errorStatusCard(),
    newest ? errorMeaningCard(newest) : null,
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Error log'),
      el(
        'p',
        { class: 'note' },
        'Newest first. Repeats of the same failure collapse into one line with a count, so a proxy that has been down for an hour reads as one entry rather than a thousand. Kept for this browser session only — never written to your saved configuration, and never synced.'
      ),
      errorLog.length
        ? el('div', { class: 'err-log' }, ...errorLog.map(errorRow))
        : el('p', { class: 'note' }, 'Nothing logged yet.'),
      el(
        'div',
        { class: 'err-actions' },
        el(
          'button',
          {
            class: 'btn danger',
            dataset: { errAction: 'clear' },
            disabled: !errorLog.length,
            onclick: () => {
              if (!confirmMaybe('Clear the proxy error log?')) return;
              void clearErrorLog();
            },
          },
          'Clear log'
        ),
        // Only alongside something to copy — the Copy report button lives in
        // the status card above, and vanishes with the log.
        errorLog.length
          ? el(
              'span',
              { class: 'note' },
              'A copied report includes your proxy addresses and ports — but never a username or password, which the log does not record.'
            )
          : null
      )
    )
  );
}

/**
 * Repaint the errors page without losing the reader's place. A proxy that is
 * down reports on every failed request, and this page is precisely where
 * someone sits while that happens — a full render() would rebuild the log
 * several times a second, snapping its scroll back to the top and dropping
 * keyboard focus to the body each time. So swap only the pane, and put the
 * scroll position and the focused action back afterwards.
 */
function repaintErrorsPage(): void {
  const pane = app.querySelector('.content > .pane');
  if (!pane) {
    render(); // first paint, or some other page is up — nothing to preserve
    return;
  }
  const scrollTop = pane.querySelector('.err-log')?.scrollTop ?? 0;
  // Focus goes back by role, not by node: the whole subtree is replaced, so the
  // element the user was on no longer exists to re-focus.
  const focused =
    document.activeElement instanceof HTMLElement ? document.activeElement.dataset.errAction : undefined;

  const fresh = errorsPanel();
  pane.replaceWith(fresh);
  const log = fresh.querySelector('.err-log');
  if (log) log.scrollTop = scrollTop;
  if (focused) fresh.querySelector<HTMLElement>(`[data-err-action="${focused}"]`)?.focus();
  refreshSidebar(); // the nav count moves with the alert
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
    else if (selectedId === DASH_ID) {
      repaintDashboard();
      refreshSidebar();
    } else refreshSidebar();
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
 * Honour "open Options on the errors page" from the popup. Handled both at boot
 * and live, because chrome.runtime.openOptionsPage may create a page or focus
 * one that is already open, and the popup cannot tell which.
 */
function watchPageRequests(): void {
  const open = (raw: unknown): void => {
    const request = raw as { page?: unknown; at?: unknown } | undefined;
    if (request?.page !== 'errors') return;
    // Consume it either way, so a request that never reached a page cannot
    // hijack some unrelated visit to Options later on.
    void chrome.storage.session.remove(OPEN_PAGE_KEY).catch(() => undefined);
    if (typeof request.at === 'number' && Date.now() - request.at > PAGE_REQUEST_TTL_MS) return;
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

function emptyPane(): HTMLElement {
  return el(
    'div',
    { class: 'card hero' },
    el('img', { class: 'mark hero-mark', src: 'img/logo-mark.png', alt: '' }),
    el('h2', {}, 'Route traffic your way'),
    el('p', {}, 'Create a proxy profile (SOCKS5, SOCKS4, HTTP, or HTTPS), then add an Auto switch profile to route sites by rule — host wildcards, regex, CIDR blocks, keywords, or time windows.'),
    el(
      'div',
      { class: 'cta' },
      el('button', { class: 'btn primary', onclick: () => addProfile(newProxyProfile) }, 'Create a proxy'),
      el('button', { class: 'btn', onclick: () => addProfile(newSwitchProfile) }, 'Create auto switch')
    )
  );
}

let sideNode: HTMLElement;

function refreshSidebar(): void {
  const fresh = sidebar();
  sideNode.replaceWith(fresh);
  sideNode = fresh;
}

function editorFor(profile: Profile): HTMLElement {
  switch (profile.kind) {
    case 'proxy': return proxyEditor(profile);
    case 'switch': return switchEditor(profile);
    case 'rulelist': return ruleListEditor(profile);
    case 'virtual': return virtualEditor(profile);
  }
}

/**
 * The panel for whatever is selected.
 *
 * Statements rather than the nested conditional this used to be: one branch per
 * page reads top to bottom, and adding the ninth page to an eight-deep ternary
 * had already produced two mis-indented edits that the compiler caught and a
 * reader would not have.
 */
function contentFor(): HTMLElement {
  if (selectedId === DASH_ID) {
    // Nothing to overview yet — a wall of empty cards is a worse welcome than
    // the hero that tells a new install what to do first.
    return config.profiles.length ? dashboardPanel(dashboardHost) : emptyPane();
  }
  if (selectedId === DOCS_ID) return docsPanel(() => goTo(RELEASES_ID));
  if (selectedId === RELEASES_ID) return releasesPanel(() => goTo(DOCS_ID));
  if (selectedId === INSPECT_ID) return inspectorPanel();
  if (selectedId === NETWORK_ID) return networkPanel(networkHost);
  if (selectedId === ERRORS_ID) return errorsPanel();
  if (selectedId === SETTINGS_ID) return settingsPanel();
  const profile = selected();
  return profile ? editorFor(profile) : emptyPane();
}

function render(): void {
  sideNode = sidebar();
  const content = contentFor();
  app.replaceChildren(
    el(
      'div',
      { class: 'layout' },
      sideNode,
      el('div', { class: 'content' }, ...permWarningBanners(), content)
    )
  );
  // Expose the selected nav item to assistive tech (mirrors popup .row's aria-pressed).
  sideNode.querySelector('.nav-item.selected')?.setAttribute('aria-current', 'page');

  // Remember where we were, for the "reopen the last page" landing option.
  // Done here rather than at each call site so a new navigation path cannot
  // forget to record itself.
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
  reapply: () => {
    // saveConfigRaw, not saveConfig: the worker re-applies on any write to the
    // config key, and this one is not an edit. Bumping rev would push a
    // revision to every synced device to fix which extension owns the proxy on
    // this machine — the same reasoning that keeps the startup profile raw.
    void saveConfigRaw(config);
  },
  createProxy: () => addProfile(newProxyProfile),
  requestAuth: () => requestAuthPermission(),
  requestExitIp: () => ensureExitIpPermission(),
  refetchRuleList,
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
      span.textContent = `Connection failed — ${r.error ?? 'unknown error'}`;
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
  selectedId = landingPage(prefs);
  watchSyncError();
  watchProxyTests();
  render();
  // After first paint — these can re-render, and refreshSidebar() needs the
  // sidebar node that render() has just installed.
  watchProxyErrors();
  watchPageRequests();
  watchDashboardSignals();
  // Flag settings that arrived without their permission — imported or synced
  // configs, profiles created before auth support, or a grant revoked from
  // chrome://extensions.
  void refreshPermState();
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
