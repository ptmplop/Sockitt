import { BUILTIN_FILL, paintRoute } from '../shared/colour';
import { EXIT_IP_PERMS, EXIT_IP_URL, checkExitIp, flagSrc } from '../shared/exitip';
import {
  TraceEdge,
  compileRule,
  overrideFor,
  pacRequestUrl,
  patternError,
  resolveRoute,
  testBypass,
  testCondition,
} from '../shared/match';
import { parseRuleList } from '../shared/rulelist';
import { Scope, incognitoActiveId } from '../shared/scope';
import {
  APPLIED_KEY,
  OPEN_PAGE_KEY,
  OptionsPageRequest,
  POPUP_PORT,
  RELOAD_KEY,
  ReloadRequest,
  TAB_EXIT_KEY,
  TAB_EXIT_RESULT_KEY,
  addTempRule,
  applyTheme,
  loadConfig,
  loadTempRules,
  loadUiPrefs,
  onThemeChanged,
  removeTempRule,
  saveConfig,
} from '../shared/state';
import { brandMark } from '../shared/mark';
import { StripModel, routeStrip } from '../shared/strip';
import { TabTarget, tabTarget } from '../shared/tabs';
import { ERROR_KEY, ProxyAlert, asProxyAlert, errorSummaryLine, loadProxyAlert } from '../shared/errors';
import {
  Config,
  DIRECT,
  PROFILE_KINDS,
  Profile,
  ProxyProfile,
  RULE_LIST_FORMAT_LABELS,
  RuleListFormat,
  SCHEME_LABELS,
  SYSTEM,
  SwitchProfile,
  SwitchRule,
  profileById,
  proxyProfiles,
  uid,
} from '../shared/types';
import { el, toast } from '../shared/ui';

const app = document.getElementById('app')!;

/**
 * The tab the popup is about: the page it shows, or the page it is trying to
 * reach (see shared/tabs.ts). The id rides along so a retry can name that exact
 * tab instead of whichever one happens to be active when the worker gets to it.
 */
type ActiveTab = TabTarget & { id?: number };

let config: Config;
let tab: ActiveTab | null = null;
/** Live proxy failure, if any. One line under the header — see alertLine. */
let proxyAlert: ProxyAlert | null = null;
/**
 * Every override on this window's profile, one per site — all of them, since
 * all of them route. Only the one covering the tab is shown (tabOverride).
 */
let tempRules: SwitchRule[] = [];
/** Switcher filter — only surfaced when there are many profiles. */
let filterText = '';
/** Whether this popup was opened from an incognito window (see detectScope). */
let incognitoWindow = false;
/** Whether Chrome lets Sockitt drive incognito at all ("Allow in Incognito"). */
let incognitoAllowed = false;

/* ---- which scope this window is on ---- */

/**
 * The popup speaks for the window it was opened in. In an incognito window with
 * its own profile that is NOT the active one — so every readout below (the
 * route strip, the exit line, the tick in the list) is resolved from here
 * rather than from config.activeId, which describes windows this user isn't
 * looking at.
 *
 * Null when there is no separate scope: no incognito access, no incognito
 * profile, or a plain regular window. Then the window rides the regular
 * settings and the regular answers are the true ones.
 */
function scopedId(): string | null {
  return incognitoWindow ? incognitoActiveId(config, incognitoAllowed) : null;
}

/** The profile THIS window routes by. */
function scopeActiveId(): string {
  return scopedId() ?? config.activeId;
}

/** True when this window has a proxy scope of its own to read and to set. */
function ownScope(): boolean {
  return scopedId() !== null;
}

/**
 * What the list ticks. In an incognito window that is the incognito CHOICE
 * — '' meaning "same as regular windows", which is a row of its own — so the
 * list shows one tick, on the thing a click there would change.
 */
function selectedId(): string {
  return incognitoWindow && incognitoAllowed ? config.settings.incognitoProfileId : config.activeId;
}

/** Which scope's overrides this window reads and writes. */
function scope(): Scope {
  return ownScope() ? 'incognito' : 'regular';
}

/**
 * Which window this popup belongs to. windows.getCurrent is the authority — it
 * answers for the window hosting the popup — with the active tab as a fallback
 * for the case where it can't be read. In spanning mode (see the manifest) the
 * popup page itself runs in the regular profile, so chrome.extension
 * .inIncognitoContext is false here even in an incognito window and cannot be
 * used for this.
 */
async function detectScope(): Promise<boolean> {
  incognitoAllowed = await chrome.extension.isAllowedIncognitoAccess().catch(() => false);
  try {
    incognitoWindow = (await chrome.windows.getCurrent()).incognito === true;
    return true;
  } catch {
    incognitoWindow = false;
    return false;
  }
}

/* ---- exit-IP check (the "This tab" section) ---- */

type ExitInfo = { ip: string; iso?: string; country?: string; ms: number };
type ExitState =
  | { phase: 'idle' }
  | { phase: 'no-perm' }
  | { phase: 'off-scope' }
  | { phase: 'checking' }
  | ({ phase: 'ok' } & ExitInfo)
  | { phase: 'error'; message: string };

let exit: ExitState = { phase: 'idle' };
let exitTimer: ReturnType<typeof setTimeout> | undefined;
/** Monotonic guard: a stale in-flight check must not overwrite a newer one. */
let exitSeq = 0;
/** Last good reading — shown dimmed during a recheck so the line never blanks. */
let lastExit: ExitInfo | null = null;
/** Matches a tab-exit probe request to its worker response. */
let probeNonce = 0;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Route key for equality: DIRECT and bypassed collapse together, else proxy id. */
function routeKey(r: { targetId: string; bypassed?: boolean }): string {
  return r.bypassed || r.targetId === DIRECT ? DIRECT : r.targetId;
}

/**
 * True when the current tab exits differently from how the exit-IP host is
 * routed — so a plain lookup would report the wrong exit and the tab's own route
 * must be probed. Direct/System always route the two the same, so those (and a
 * matching route) take the cheaper plain lookup.
 */
function tabNeedsProbe(active: Profile): boolean {
  if (!tab) return false;
  const exitHost = new URL(EXIT_IP_URL).hostname;
  const tabRoute = resolveRoute(config, active, pacRequestUrl(tab.url), tab.host, tempRules);
  const exitRoute = resolveRoute(config, active, pacRequestUrl(EXIT_IP_URL), exitHost, tempRules);
  return routeKey(tabRoute) !== routeKey(exitRoute);
}

/** One tab-exit probe round-trip to the worker; resolves with its raw response. */
function sendTabExitProbe(tabUrl: string, tabHost: string, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const nonce = ++probeNonce;
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area !== 'session' || !changes[TAB_EXIT_RESULT_KEY]) return;
      const r = changes[TAB_EXIT_RESULT_KEY].newValue as Record<string, unknown> | undefined;
      if (r && r.nonce === nonce) finish(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timed out' }), timeoutMs);
    const finish = (r: Record<string, unknown>): void => {
      clearTimeout(timer);
      chrome.storage.onChanged.removeListener(listener);
      resolve(r);
    };
    chrome.storage.onChanged.addListener(listener);
    void chrome.storage.session
      .set({ [TAB_EXIT_KEY]: { nonce, tabUrl, tabHost } })
      .catch(() => finish({ ok: false, error: 'send failed' }));
  });
}

/**
 * Probe where the tab exits, retrying briefly while the worker holds a test.
 * `stillCurrent` stops the retry loop once a newer check supersedes this one, so
 * a superseded probe can't keep churning the proxy.
 */
async function probeTabExit(tabUrl: string, tabHost: string, stillCurrent: () => boolean): Promise<ExitInfo> {
  const deadline = Date.now() + 12_000;
  for (;;) {
    // Bail before touching the worker if a newer check already superseded this
    // one — a probe churns the proxy, so a doomed one shouldn't even start.
    if (!stillCurrent()) throw new Error('superseded');
    const r = await sendTabExitProbe(tabUrl, tabHost, Math.max(1500, deadline - Date.now()));
    if (r.ok && typeof r.ip === 'string') {
      return { ip: r.ip, iso: r.iso as string | undefined, country: r.country as string | undefined, ms: Number(r.ms) };
    }
    if (r.error === 'busy' && Date.now() < deadline) {
      await delay(350);
      continue;
    }
    throw new Error(typeof r.error === 'string' ? r.error : 'probe failed');
  }
}

/**
 * Where the CURRENT TAB exits. When the tab routes the same as the exit-IP host
 * (plain proxy, or both Direct), a plain lookup already reports it; when they
 * differ (an override/rule sends the tab elsewhere), probe the tab's own route.
 */
async function fetchTabExit(stillCurrent: () => boolean): Promise<ExitInfo> {
  const active = config.profiles.find((p) => p.id === scopeActiveId());
  if (!tab || !active || !tabNeedsProbe(active)) return checkExitIp(6000);
  return probeTabExit(tab.url, tab.host, stillCurrent);
}

async function maybeCheckExit(): Promise<void> {
  if (!config.settings.exitIpCheck) {
    exit = { phase: 'idle' };
    return;
  }
  // The lookup can't be run on this window's route. Sockitt's pages are regular-
  // profile pages (spanning mode), so a fetch from here — and the worker's own
  // tab probe, which swaps the REGULAR proxy to measure — both report the
  // regular scope. Reporting that as "where this tab exits" would be a wrong
  // answer given confidently, and the probe would churn other windows' proxy to
  // produce it, so say what is and isn't known instead.
  if (ownScope()) {
    exitSeq++; // a check from before the scope was known must not land now
    exit = { phase: 'off-scope' };
    updateExitLine();
    return;
  }
  const has = await chrome.permissions.contains(EXIT_IP_PERMS).catch(() => false);
  if (!has) {
    exitSeq++; // invalidate any in-flight check so it can't overwrite this
    exit = { phase: 'no-perm' };
    updateExitLine();
    return;
  }
  await runExitCheck();
}

async function runExitCheck(): Promise<void> {
  const seq = ++exitSeq;
  exit = { phase: 'checking' };
  updateExitLine();
  try {
    const info = await fetchTabExit(() => seq === exitSeq);
    if (seq !== exitSeq) return;
    exit = { phase: 'ok', ...info };
    lastExit = info;
  } catch (e) {
    if (seq !== exitSeq) return;
    exit = { phase: 'error', message: e instanceof Error ? e.message : String(e) };
  }
  updateExitLine();
}

/**
 * Patch the exit line in place. A full render() here would land mid-user-
 * interaction (checks resolve seconds after open) and destroy open dropdowns.
 */
function updateExitLine(): void {
  const slot = document.querySelector('.here-exit');
  if (!slot) return;
  // Drop the prior readout. querySelectorAll (not querySelector) so a stack
  // that somehow accumulated gets fully cleared, never leaving a duplicate
  // flag/IP — and never leaving the row taller than the space reserved for it.
  slot.querySelectorAll(':scope > .exit-line').forEach((n) => n.remove());
  const line = exitLine();
  if (line) slot.append(line);
}

/** Debounced: the background announces each proxy application; re-check then. */
function scheduleExitCheck(): void {
  clearTimeout(exitTimer);
  exitTimer = setTimeout(() => void maybeCheckExit(), 350);
}

async function enableExitCheck(): Promise<void> {
  // Button click = the user gesture chrome.permissions.request needs.
  const granted = await chrome.permissions.request(EXIT_IP_PERMS).catch(() => false);
  if (granted) await runExitCheck();
}

/** The sock earns a wiggle when the route changes. */
function wiggleSock(): void {
  const mark = document.querySelector<HTMLElement>('.pop-top .mark');
  if (!mark || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  mark.classList.remove('wiggle');
  void mark.offsetWidth; // restart the animation if one is mid-flight
  mark.classList.add('wiggle');
}

/**
 * Tell the worker this popup is open, for as long as it is. Nothing is ever
 * sent over the port — the worker watches only connect/disconnect, and holds
 * back "reload on switch" while a port is up, because navigating the tab under
 * an open popup makes Chrome dismiss it mid-edit. Closing the popup tears this
 * page down with the port, which is the signal to run the held-back reload.
 */
function markPopupOpen(): void {
  const connect = (): void => {
    try {
      const port = chrome.runtime.connect({ name: POPUP_PORT });
      // A disconnect while this page is still alive means the worker was
      // recycled, not that we closed — reconnect so the hold keeps holding.
      // (When the popup itself closes, the timer dies with the page.)
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        setTimeout(connect, 100);
      });
    } catch {
      // Worker unreachable: reloads simply happen immediately, as they used to.
    }
  };
  connect();
}

async function init(): Promise<void> {
  markPopupOpen();
  // The theme goes on before the first paint, so a dark popup never opens light.
  const [loaded, alert, prefs] = await Promise.all([loadConfig(), loadProxyAlert(), loadUiPrefs()]);
  applyTheme(prefs.theme);
  onThemeChanged(applyTheme);
  config = loaded;
  proxyAlert = alert;
  const scopeKnown = await detectScope();
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    // Fallback only: the tab answers for the last focused window, which is the
    // popup's own — but only windows.getCurrent answers for it by definition, so
    // a reading from there is never second-guessed.
    if (!scopeKnown && active?.incognito) incognitoWindow = true;
    const target = tabTarget(active);
    tab = target ? { ...target, id: active?.id } : null;
  } catch {
    tab = null;
  }
  // After the scope is known: in an incognito window the overrides to load are
  // that scope's, on that scope's profile.
  tempRules = await loadTempRules(scopeActiveId(), scope());
  render();
  // fitHost measures the host, so it measures again once the face the host is
  // set in has arrived — fonts.ready alone can resolve before that load starts.
  void document.fonts.load('600 16px "IBM Plex Mono"').then(() => fitHost(), () => undefined);
  document.fonts.addEventListener('loadingdone', () => fitHost());
  void maybeCheckExit();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    if (changes[APPLIED_KEY]) scheduleExitCheck();
    // A failure can start — or stop — while the popup sits open, so the
    // alert line tracks the alert rather than the moment the popup was opened.
    if (changes[ERROR_KEY]) {
      proxyAlert = asProxyAlert(changes[ERROR_KEY].newValue);
      updateAlertLine();
    }
  });
  document.addEventListener('keydown', onKeydown);
}

/**
 * Re-read the latest stored config, apply `mutate` to that fresh copy, persist
 * it, and adopt it as the popup's snapshot. The popup can sit open while the
 * background applies sync or rule-list changes; mutating and writing back our
 * load-time snapshot (the module-global `config`) would blind-clobber those.
 * `mutate` must locate its target by id in `fresh`; return false to abort the
 * save (e.g. the profile was deleted from another surface meanwhile).
 *
 * Commits run one at a time. Two that overlapped would both read the same
 * stored copy and the second save would drop the first one's change — which a
 * pattern field committing on blur makes easy: its change event fires on the
 * very click that picks a profile in the list.
 */
let commitChain: Promise<unknown> = Promise.resolve();
function commitConfig(mutate: (fresh: Config) => boolean | void): Promise<boolean> {
  const run = commitChain.then(async () => {
    const fresh = await loadConfig();
    if (mutate(fresh) === false) return false;
    await saveConfig(fresh);
    config = fresh;
    return true;
  });
  commitChain = run.catch(() => undefined);
  return run;
}

/**
 * Pick the profile for THIS window. In an incognito window that means setting
 * the incognito profile ('' = follow the regular one), not activeId: a picker
 * that changed windows the user cannot see, while the window in front of them
 * carried on through the incognito proxy, is the switcher looking active and
 * being inert. Regular windows are untouched either way.
 */
async function setActive(id: string): Promise<void> {
  const picksIncognito = incognitoWindow && incognitoAllowed;
  // Where the window will route after this change, and on whose overrides.
  const nextId = picksIncognito ? id || config.activeId : id;
  const nextScope: Scope = picksIncognito && id ? 'incognito' : 'regular';
  // Load the new profile's overrides before the single render so the section
  // never flashes the previous profile's state. The background applies the
  // proxy (and reloads the tab if refreshOnSwitch is on) off the storage write.
  tempRules = await loadTempRules(nextId, nextScope);
  // Recheck the exit IP for the new route, but keep the previous reading shown
  // dimmed (lastExit) rather than blanking to "checking…".
  if (config.settings.exitIpCheck && exit.phase === 'ok') {
    exitSeq++; // invalidate any in-flight check
    exit = { phase: 'checking' };
  }
  // Re-read and change only the one field, so a background sync/rule-list change
  // that landed while the popup was open isn't overwritten by our stale snapshot.
  await commitConfig((fresh) => {
    if (picksIncognito) fresh.settings.incognitoProfileId = id;
    else fresh.activeId = id;
  });
  render();
  wiggleSock();
}

/**
 * The override standing in for the site in this tab, if any. An override is an
 * always-temporary rule (session storage) for one site, each site keeps its own,
 * and the popup shows only the one covering the page in front of it — never one
 * set on another site.
 */
function tabOverride(): SwitchRule | undefined {
  return tab ? overrideFor(tempRules, pacRequestUrl(tab.url), tab.host) : undefined;
}

/**
 * Give this site an override. The scope is this window's, not simply the
 * profile's: an override set in an incognito window drives the incognito
 * settings alone, and never follows the user back into a regular window.
 */
async function setOverride(profileId: string, rule: SwitchRule): Promise<void> {
  await requestTabReload();
  tempRules = await addTempRule(profileId, scope(), rule);
  scheduleExitCheck(); // the tab's route just changed — re-probe where it exits
}

/** Remove one site's override; every other site keeps its own. */
async function removeOverride(profileId: string, id: string): Promise<void> {
  await requestTabReload();
  tempRules = await removeTempRule(profileId, scope(), id);
  scheduleExitCheck();
}

/**
 * A this-tab override/rule change alters how THIS site routes, so with
 * "reload on switch" on the page should re-fetch over the new route. Ask the
 * worker to reload the active tab AFTER it applies the change (set here, before
 * the save that wakes applyActive, which consumes RELOAD_KEY). Doing it worker-
 * side — not here — keeps the reload from racing ahead of the proxy update.
 *
 * A page that has not loaded yet is re-requested by URL instead of reloaded, and
 * whatever "reload on switch" says. Two reasons: chrome.tabs.reload would
 * re-fetch the document still on screen and abandon the navigation the user is
 * waiting on, and there is no loaded page here to disturb — the request hanging
 * right now is the very one the new rule was added to fix, so trying it again is
 * the whole point of adding the rule.
 */
async function requestTabReload(): Promise<void> {
  if (!tab) return;
  const request: ReloadRequest = tab.pending
    ? { at: Date.now(), tabId: tab.id, url: tab.url }
    : { at: Date.now() };
  if (tab.pending || config.settings.refreshOnSwitch) {
    await chrome.storage.session.set({ [RELOAD_KEY]: request });
  }
}

function statusFor(profile: Profile): string {
  switch (profile.kind) {
    case 'proxy':
      return `${SCHEME_LABELS[profile.scheme]} · ${profile.host}:${profile.port}`;
    case 'switch': {
      const n = profile.rules.filter((r) => r.enabled).length + tempRulesFor(profile.id).length;
      return `Auto switch · ${n} active rule${n === 1 ? '' : 's'}`;
    }
    case 'virtual': {
      const target = config.profiles.find((p) => p.id === profile.targetId);
      return `Alias → ${target?.name ?? 'Direct'}`;
    }
    case 'rulelist': {
      const n = parseRuleList(profile.format, profile.text).count;
      return `Rule list · ${n} entr${n === 1 ? 'y' : 'ies'}`;
    }
  }
}

function subFor(profile: Profile): string {
  switch (profile.kind) {
    case 'proxy':
      return `${profile.host}:${profile.port}`;
    case 'switch':
      return `${profile.rules.length} rule${profile.rules.length === 1 ? '' : 's'}`;
    case 'virtual':
      return 'alias';
    case 'rulelist':
      return RULE_LIST_FORMAT_LABELS[profile.format];
  }
}

function tempRulesFor(profileId: string): SwitchRule[] {
  return scopeActiveId() === profileId ? tempRules : [];
}

/* ---- rendering ----
   One 400×600 column: header, the proxy alert (only while one is live), this
   tab's route as a strip, the controls for this site, the switcher, a footer.
   Only the switcher scrolls; everything above it holds its height. */

/** A theme.css mask icon (see the --i-* tokens), painted in currentColor. */
function icon(name: string, size?: 'sm' | 'lg'): HTMLElement {
  const node = el('span', { class: `ic${size ? ` ${size}` : ''}` });
  node.style.setProperty('--i', `var(--i-${name})`);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

/** The colour a route destination is drawn in: a profile's own, or the built-ins' neutral. */
function routeColour(targetId: string): string {
  if (targetId === DIRECT || targetId === SYSTEM) return BUILTIN_FILL;
  return profileById(config, targetId)?.color ?? BUILTIN_FILL;
}

function routeName(targetId: string): string {
  if (targetId === DIRECT) return 'Direct';
  if (targetId === SYSTEM) return 'System';
  return profileById(config, targetId)?.name ?? 'Direct';
}

/** A profile's line key — the short length of its own track that names it everywhere. */
function lineKey(targetId: string): HTMLElement {
  const key = paintRoute(el('span', { class: `key${targetId === SYSTEM ? ' system' : ''}` }), routeColour(targetId));
  key.setAttribute('aria-hidden', 'true');
  return key;
}

/* ---- the proxy alert ---- */

/**
 * What a proxy error code means, as the end of a sentence about the server.
 * Matched on a substring, like errors.ts's advice table, so "net::ERR_…" and a
 * bare "ERR_…" both land; an unknown code falls back to the code itself.
 */
const ALERT_PREDICATES: Array<[string, string]> = [
  ['ERR_PROXY_CONNECTION_FAILED', 'can’t be reached'],
  ['ERR_TUNNEL_CONNECTION_FAILED', 'won’t open a tunnel'],
  ['ERR_PROXY_AUTH_UNSUPPORTED', 'wants a login Chrome can’t send'],
  ['ERR_PROXY_AUTH_REQUESTED', 'asks for a password'],
  ['ERR_PROXY_CERTIFICATE_INVALID', 'has a certificate Chrome rejects'],
  ['ERR_SOCKS_CONNECTION_HOST_UNREACHABLE', 'can’t reach the site'],
  ['ERR_SOCKS_CONNECTION_FAILED', 'fails the SOCKS handshake'],
  ['ERR_NAME_NOT_RESOLVED', 'can’t be found'],
  ['ERR_CONNECTION_TIMED_OUT', 'times out'],
  ['ERR_TIMED_OUT', 'times out'],
  ['ERR_CONNECTION_REFUSED', 'refuses connections'],
  ['ERR_MANDATORY_PROXY_CONFIGURATION_FAILED', 'can’t be used'],
];

/**
 * The one server the failure is pinned on, when that is knowable: the route's
 * only server, or the only one it could have picked. With several candidates
 * Chrome's error names none of them, and guessing would be worse than saying so.
 */
function failingProxyId(a: ProxyAlert): string | undefined {
  return a.via?.id ?? (a.candidates?.length === 1 ? a.candidates[0]!.id : undefined);
}

/**
 * Who the alert is about, named no more precisely than the worker could. With
 * several candidates the line says "A proxy" — the one line has no room for a
 * list, and the tooltip and the error log name them all.
 */
function alertSubject(a: ProxyAlert, room: 'line' | 'full'): string {
  const failing = failingProxyId(a);
  if (failing) return profileById(config, failing)?.name ?? a.via?.name ?? a.candidates?.[0]?.name ?? a.profileName;
  const c = a.candidates ?? [];
  if (c.length > 1) {
    if (room === 'line') return 'A proxy';
    const names = c.map((x) => x.name);
    return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  }
  if (a.profileId === SYSTEM) return 'The system proxy';
  return a.profileName;
}

/** "Work SOCKS5 refuses connections" — the alert's headline in words. */
function alertHeadline(a: ProxyAlert, room: 'line' | 'full' = 'line'): string {
  if (a.source === 'apply') return 'Sockitt couldn’t apply the proxy settings';
  const code = a.error.toUpperCase();
  if (code.includes('PAC_SCRIPT_FAILED')) return 'The routing script failed';
  if (code.includes('PAC_STATUS_NOT_OK')) return 'The routing script didn’t load';
  const hit = ALERT_PREDICATES.find(([needle]) => code.includes(needle));
  return hit ? `${alertSubject(a, room)} ${hit[1]}` : `${alertSubject(a, room)}: ${a.error}`;
}

/**
 * The live failure, as one line under the header that opens the error log.
 * It sits in the flow, so its arrival moves what is below it; that is why it
 * only ever exists while requests are actually failing.
 */
function alertLine(): HTMLElement | null {
  const a = proxyAlert;
  if (!a) return null;
  const count = `${a.streak} failed`;
  const full = alertHeadline(a, 'full');
  const btn = el(
    'button',
    {
      class: 'alert one',
      type: 'button',
      title: `${full} (${errorSummaryLine(a)}) · ${count}. Opens the proxy error log.`,
      onclick: () => void openErrorPage(),
    },
    icon('alert'),
    el('span', { class: 'alert-text' }, el('b', {}, alertHeadline(a)), ` · ${count}`),
    icon('chevron', 'sm')
  );
  btn.setAttribute('aria-label', `${full}, ${count}. Opens the proxy error log.`);
  return btn;
}

/** Open the options page on its Proxy errors panel (see OPEN_PAGE_KEY). */
function openErrorPage(): Promise<void> {
  return openOptionsAt('errors');
}

/** Open the options page and ask it to go somewhere particular when it gets there. */
async function openOptionsAt(page: OptionsPageRequest): Promise<void> {
  await chrome.storage.session.set({ [OPEN_PAGE_KEY]: { page, at: Date.now() } }).catch(() => undefined);
  chrome.runtime.openOptionsPage();
}

/**
 * Follow the alert while the popup is open. The line itself is swapped in
 * place; the strip above the controls is rebuilt too, since a broken line is
 * part of what it draws. The controls are rebuilt only when nothing in them
 * holds focus — a failure arrives at its own pace, and must not close a
 * dropdown the user has open or swallow the pattern they are typing.
 */
function updateAlertLine(): void {
  const slot = app.querySelector('.alert-slot');
  if (!slot) return;
  slot.replaceChildren(...[alertLine()].filter((n): n is HTMLElement => n !== null));
  const here = app.querySelector('.here');
  if (here) here.replaceWith(hereSection());
  fitHost();
  const site = app.querySelector('.site');
  if (site && !site.contains(document.activeElement)) {
    const next = siteSection();
    if (next) site.replaceWith(next);
  }
}

/**
 * How the live alert bears on THIS tab's route. An apply failure or a broken
 * routing script is not a server a different route could get around, so those
 * never do. A server the failure is pinned on is that server whichever profile
 * now routes through it; a set of candidates only means something on the
 * profile it was worked out for.
 *
 * - touches: the tab's route runs through a server the failure may be on.
 * - broken:  that server is the one it IS on — the strip draws the break.
 * - presetId: where an override should send the tab instead. Never the failing
 *   server; when that one is not known, never the tab's own route, which is the
 *   suspect as far as this tab is concerned.
 */
function failureFor(targetId: string): { touches: boolean; broken: boolean; presetId?: string } {
  const a = proxyAlert;
  const none = { touches: false, broken: false };
  if (!a || a.source !== 'proxy' || /PAC_/i.test(a.error)) return none;
  if (targetId === DIRECT || profileById(config, targetId)?.kind !== 'proxy') return none;
  const failing = failingProxyId(a);
  const touches = failing
    ? failing === targetId
    : a.profileId === scopeActiveId() && (a.candidates ?? []).some((c) => c.id === targetId);
  if (!touches) return none;
  const avoid = failing ?? targetId;
  const presetId = proxyProfiles(config).find((p) => p.id !== avoid && p.id !== targetId)?.id;
  return { touches, broken: failing === targetId, presetId };
}

/* ---- header ---- */

function header(): HTMLElement {
  // Names the window the popup is speaking for. Only in an incognito window,
  // where a switcher that looks identical to the regular one changes a
  // different setting. The markup says "incognito"; CSS capitalises it.
  const scopeLabel =
    incognitoWindow && incognitoAllowed
      ? el(
          'span',
          {
            class: 'dh-scope',
            title: ownScope()
              ? 'Incognito window - routed by its own profile. Picking a profile here changes only incognito windows.'
              : 'Incognito window - following the regular windows’ profile. Picking a profile here changes only incognito windows.',
          },
          'incognito'
        )
      : null;
  const options = el(
    'button',
    {
      class: 'btn quiet icon cog',
      type: 'button',
      title: 'Options',
      onclick: () => chrome.runtime.openOptionsPage(),
      dataset: { focus: 'options' },
    },
    icon('sliders', 'lg')
  );
  options.setAttribute('aria-label', 'Options');
  return el(
    'header',
    { class: 'pop-top' },
    el('span', { class: 'brand' }, brandMark(), 'Sockitt'),
    scopeLabel,
    el('span', { class: 'grow' }),
    options
  );
}

/* ---- this tab: the host, its route as a strip, why, and where it exits ---- */

interface RouteView {
  strip: StripModel;
  why: Array<Node | string>;
  /** The route's kind in a word: what the rig reads back off `.route-tag`. */
  tag: string;
}

const mono = (text: string): HTMLElement => el('span', { class: 'mono' }, text);

/** "All traffic, except <local> and *.intranet" — a proxy's bypass list, briefly. */
function allTrafficWhy(bypass: string[]): Array<Node | string> {
  if (!bypass.length) return ['All traffic'];
  const shown = bypass.slice(0, bypass.length > 3 ? 2 : bypass.length);
  const rest = bypass.length - shown.length;
  const out: Array<Node | string> = ['All traffic, except '];
  shown.forEach((entry, i) => {
    if (i > 0) out.push(i === shown.length - 1 && !rest ? ' and ' : ', ');
    out.push(mono(entry));
  });
  if (rest) out.push(` and ${rest} more`);
  return out;
}

/**
 * How the active profile routes this tab, for the strip and the sentence under
 * it. Resolved by the same resolveRoute the PAC is tested against, with its
 * trace saying which junction decided: the last hop that was not an alias.
 */
function routeView(t: ActiveTab): RouteView {
  const activeId = scopeActiveId();
  if (activeId === DIRECT) {
    return {
      strip: { how: { kind: 'all' }, dest: { name: 'Direct', colour: BUILTIN_FILL }, label: 'This tab connects directly, through no proxy' },
      why: ['No proxy - this tab connects directly'],
      tag: 'no proxy',
    };
  }
  const profile = profileById(config, activeId);
  if (activeId === SYSTEM || !profile) {
    return {
      strip: {
        how: { kind: 'all' },
        dest: { name: 'System', colour: BUILTIN_FILL, system: true },
        label: 'Your operating system’s proxy settings route this tab',
      },
      why: ['Your operating system’s proxy settings decide'],
      tag: 'OS settings',
    };
  }

  const trace: TraceEdge[] = [];
  const route = resolveRoute(config, profile, pacRequestUrl(t.url), t.host, tempRules, new Date(), trace);
  const decided = [...trace].reverse().find((e) => e.kind !== 'alias');
  const destId = route.bypassed ? DIRECT : route.targetId;
  const failure = route.bypassed ? { broken: false } : failureFor(route.targetId);
  const dest = { name: routeName(destId), colour: routeColour(destId) };
  const failingNote = failure.broken ? `, which is failing` : '';

  if (route.bypassed) {
    const via = profileById(config, route.targetId);
    const viaName = via?.name ?? 'The proxy';
    return {
      strip: {
        how: { kind: 'bypass', viaColour: routeColour(route.targetId) },
        dest,
        label: `${viaName}’s bypass list sends this site direct`,
      },
      why: [`On ${viaName}’s bypass list, so it goes direct`],
      tag: 'bypass',
    };
  }

  if (!decided) {
    // Nothing chose: a plain proxy, or an alias straight onto one.
    const isAlias = profile.kind === 'virtual';
    const target = profileById(config, route.targetId);
    return {
      strip: {
        how: { kind: 'all' },
        dest,
        broken: failure.broken,
        label: route.targetId === DIRECT ? 'This tab connects directly' : `All traffic goes through ${dest.name}${failingNote}`,
      },
      why: isAlias
        ? [`Through ${profile.name}, an alias for ${dest.name}`]
        : target?.kind === 'proxy'
          ? allTrafficWhy(target.bypass)
          : ['All traffic'],
      tag: isAlias ? 'alias' : 'all traffic',
    };
  }

  const owner = profileById(config, decided.from);
  const ownerName = owner?.name ?? profile.name;
  switch (decided.kind) {
    case 'temp-rule':
      return {
        strip: {
          how: { kind: 'override' },
          dest,
          broken: failure.broken,
          label: `An override sends this site to ${dest.name} before any rule is tried${failingNote}`,
        },
        why: ['Overridden for this site until the browser restarts'],
        tag: 'override',
      };
    case 'rule': {
      const rules = owner?.kind === 'switch' ? owner.rules : [];
      let index = rules.findIndex((r) => r.id === route.ruleId);
      if (index < 0) index = rules.findIndex((r) => r.enabled && r.pattern === decided.pattern && r.type === decided.ruleType);
      const n = index + 1;
      const label = n > 0 ? String(n) : '·';
      return {
        strip: {
          how: { kind: 'rule', label },
          dest,
          broken: failure.broken,
          label: `Rule ${label} in ${ownerName} sends this tab to ${dest.name}${failingNote}`,
        },
        why: [`Rule ${label}, `, mono(decided.pattern ?? ''), `, in ${ownerName}`],
        tag: 'rule',
      };
    }
    case 'default':
      return {
        strip: {
          how: { kind: 'default' },
          dest,
          broken: failure.broken,
          label: `No rule matched, so ${ownerName}’s default sends this tab to ${dest.name}${failingNote}`,
        },
        why: [owner && owner.id !== profile.id ? `No rule in ${ownerName} matched - its default route` : 'No rule matched - the default route'],
        tag: 'default',
      };
    case 'list-match':
      return {
        strip: {
          how: { kind: 'all' },
          dest,
          broken: failure.broken,
          label: `Listed in ${ownerName}, so this tab goes to ${dest.name}${failingNote}`,
        },
        why: [`Listed in ${ownerName}`],
        tag: 'rule list',
      };
    case 'list-default':
    default:
      return {
        strip: {
          how: { kind: 'default' },
          dest,
          broken: failure.broken,
          label: `Not listed in ${ownerName}, so its default sends this tab to ${dest.name}${failingNote}`,
        },
        why: [`Not listed in ${ownerName} - the default route`],
        tag: 'rule list',
      };
  }
}

/**
 * A quiet one-line readout under the route: where THIS tab actually exits —
 * "Exits from 🇳🇱 198.51.100.24 · 41 ms".
 *
 * Every phase renders exactly one line, and the line exists from the first
 * paint (empty while idle) whenever the setting is on. The check resolves a
 * second or two after the popup opens, so a line that appeared — or grew from
 * one row to two — at that moment would shove everything below it down under
 * the user's cursor mid-click. The fixed height in CSS is what holds the space.
 */
function exitLine(): HTMLElement | null {
  if (!config.settings.exitIpCheck) return null;
  const okLine = (info: ExitInfo, dim: boolean): HTMLElement => {
    const src = flagSrc(info.iso);
    return el(
      'span',
      {
        class: `exit-line${dim ? ' dim' : ''}`,
        // The country name is off the line — the flag carries it. Keep it in
        // the tooltip (and the flag's alt) so it is still there for anyone who
        // doesn't read flags, or reads the page with a screen reader.
        title: `This tab exits via ${info.ip}${info.country ? ` · ${info.country}` : ''}`,
      },
      el('span', { class: 'exit-lead' }, 'Exits from'),
      src ? el('img', { class: 'flag', src, alt: info.country ?? '', width: 18, height: 13 }) : null,
      el('span', { class: 'mono exit-ip' }, info.ip),
      el('span', { class: 'exit-ms' }, `· ${info.ms} ms`)
    );
  };
  switch (exit.phase) {
    case 'idle':
      // The check hasn't reported yet — hold the row, say nothing.
      return el('span', { class: 'exit-line' });
    case 'no-perm':
      return el(
        'span',
        { class: 'exit-line' },
        el(
          'button',
          { class: 'linklike exit-enable', type: 'button', onclick: () => void enableExitCheck(), dataset: { focus: 'exit-enable' } },
          'Show where this tab exits…'
        )
      );
    case 'off-scope':
      return el(
        'span',
        {
          class: 'exit-line',
          title:
            'Sockitt can only measure the exit IP of regular windows. This window is on the incognito profile, which Chrome keeps separate - the reading would be the regular route’s, not this one’s.',
        },
        'Exit check runs in regular windows'
      );
    case 'checking':
      // Keep the last good reading visible (dimmed) instead of blanking.
      return lastExit ? okLine(lastExit, true) : el('span', { class: 'exit-line' }, 'Checking where this tab exits…');
    case 'ok':
      return okLine(exit, false);
    case 'error':
      return el('span', { class: 'exit-line err', title: exit.message }, el('span', { class: 'st bad' }, 'Exit check failed'));
  }
}

/**
 * The host this section is about, and the route its requests take. When the
 * host comes from a navigation still in flight it says so — otherwise this
 * would look like a readout of the page on screen, which is precisely what it
 * is not.
 */
function hereSection(): HTMLElement {
  const section = el('section', { class: 'here' });
  section.setAttribute('aria-label', 'This tab');
  const t = tab;
  const label = t?.pending
    ? el(
        'span',
        {
          class: 't-label here-state',
          title:
            'This page has not loaded yet - the site is the one the tab is trying to open, so you can route it without waiting for it to give up.',
        },
        icon('clock', 'sm'),
        'Loading'
      )
    : el('span', { class: 't-label' }, 'This tab');
  section.append(
    el(
      'div',
      { class: 'here-host' },
      t ? el('span', { class: 'h', title: t.host }, t.host) : el('span', { class: 'h none' }, '-'),
      label
    )
  );
  if (!t) {
    section.append(el('p', { class: 'here-why' }, 'No web page here. Sockitt routes http(s) sites only.'));
  } else {
    const view = routeView(t);
    const why = el('p', { class: 'here-why' }, ...view.why);
    // Clamped to two lines (CSS); the tooltip keeps the rest.
    if ((why.textContent ?? '').length > 80) why.title = why.textContent ?? '';
    section.append(
      routeStrip(view.strip),
      why,
      // The route's kind as one word, for the rig; the sentence above says it
      // to everyone else, so this one stays out of the page and the a11y tree.
      el('span', { class: 'route-tag', hidden: true }, view.tag)
    );
  }
  if (config.settings.exitIpCheck) section.append(el('div', { class: 'here-exit' }, exitLine()));
  return section;
}

/**
 * A long host steps down a size or two before it is cut — the long ones are
 * exactly the internal names someone opens the popup to route. Past that it
 * loses its head, never its tail (CSS). Measured, so it runs after layout,
 * and again once the bundled face has loaded.
 */
function fitHost(): void {
  const h = app.querySelector<HTMLElement>('.here-host .h');
  if (!h) return;
  h.classList.remove('long', 'longer');
  for (const size of ['long', 'longer']) {
    if (h.scrollWidth <= h.clientWidth) return;
    h.classList.remove('long');
    h.classList.add(size);
  }
}

/* ---- for this site: the controls ---- */

/**
 * The click handler for a per-site button, which render() replaces with
 * something else in the same place: End and the rule's ✕ trade places, and so
 * do ✕ and Add rule. The second click of a double-click lands on the
 * replacement and undoes the first, or deletes a rule nobody meant to touch, so
 * a repeat click (detail > 1) is dropped. Keyboard activation reports detail 0
 * and always goes through.
 */
function singleClick(fn: () => Promise<void>): (e: MouseEvent) => void {
  return (e) => {
    if (e.detail > 1) return;
    void fn();
  };
}

/** First enabled permanent rule whose condition matches the current site. */
function matchedRuleFor(profile: SwitchProfile, url: string, host: string): SwitchRule | undefined {
  return profile.rules.find((r) => r.enabled && testCondition(compileRule(r), url, host));
}

/**
 * A route picker with the chosen route's line key inside it: proxies, then
 * Direct, plus the current value if it is some other profile. `placeholder`
 * opens it on an empty first choice, and `exclude` leaves out the route the
 * site is already on — overriding a site onto its own route changes nothing.
 */
function routeSelect(opts: {
  value: string;
  label: string;
  focusKey: string;
  placeholder?: string;
  exclude?: string;
  onChange?: (v: string) => void;
}): { wrap: HTMLElement; select: HTMLSelectElement } {
  const select = el('select', { class: 'input', dataset: { focus: opts.focusKey } }) as HTMLSelectElement;
  select.setAttribute('aria-label', opts.label);
  if (opts.placeholder) select.append(el('option', { value: '' }, opts.placeholder));
  const ids = [...proxyProfiles(config).map((p) => p.id), DIRECT];
  if (opts.value && !ids.includes(opts.value) && profileById(config, opts.value)) ids.push(opts.value);
  for (const id of ids) {
    if (id === opts.exclude && id !== opts.value) continue;
    select.append(el('option', { value: id }, routeName(id)));
  }
  select.value = [...select.options].some((o) => o.value === opts.value) ? opts.value : (select.options[0]?.value ?? '');
  const wrap = el('span', { class: 'via' }, select);
  const paintKey = (): void => {
    wrap.querySelector(':scope > .key')?.remove();
    wrap.classList.toggle('keyed', select.value !== '');
    if (select.value) wrap.prepend(lineKey(select.value));
  };
  paintKey();
  select.onchange = () => {
    paintKey();
    opts.onChange?.(select.value);
  };
  return { wrap, select };
}

/** Open a select's list — the answer to pressing Set before choosing a route. */
function openPicker(select: HTMLSelectElement): void {
  select.focus();
  try {
    select.showPicker();
  } catch {
    // No picker API, or no user activation left: focus alone says where to go.
  }
}

/**
 * "Set & reload" must reload, whatever "reload on switch" says: the page in
 * front of the user is the one that just failed. A request that names the tab
 * and its URL is honoured unconditionally by the worker (the same path a page
 * still loading takes); requestTabReload, which runs after this, only ever
 * replaces it with an equivalent reload.
 */
async function requestTabRetry(): Promise<void> {
  if (!tab) return;
  const request: ReloadRequest = { at: Date.now(), tabId: tab.id, url: tab.url };
  await chrome.storage.session.set({ [RELOAD_KEY]: request });
}

function siteLine(cls: string, label: HTMLElement, ...rest: Array<Node | null>): HTMLElement {
  return el('div', { class: `site-line sm-field${cls ? ` ${cls}` : ''}` }, label, ...rest);
}

const lab = (text: string, forId?: string): HTMLElement =>
  forId ? el('label', { class: 't-label', htmlFor: forId }, text) : el('span', { class: 't-label' }, text);

/**
 * The per-site controls of an Auto switch profile: the rule this site matches
 * (or one to add), and the override — always temporary, one per site, and
 * first in line ahead of every rule while it lasts.
 */
function switchSiteLines(active: SwitchProfile, t: ActiveTab): HTMLElement[] {
  const matchUrl = pacRequestUrl(t.url);
  // The page hasn't loaded, so every change here ends in "…and try it again";
  // the buttons say so rather than leaving the user to guess and hit reload.
  const pending = t.pending;
  // Only an override covering THIS site belongs here, and only it pauses the
  // rule; the ones set on other sites stay on those sites.
  const override = tabOverride();
  const route = resolveRoute(config, active, matchUrl, t.host, tempRules);
  const currentKey = routeKey(route);

  /** The quick "*.currenthost → target" rule both rows below create. */
  const siteRule = (targetId: string): SwitchRule => ({
    id: uid(),
    enabled: true,
    type: 'hostWildcard',
    pattern: `*.${t.host}`,
    targetId,
  });

  /* --- the rule row: edit the matching rule or add one; paused while overridden --- */
  const matched = matchedRuleFor(active, matchUrl, t.host);
  const n = matched ? active.rules.indexOf(matched) + 1 : 0;
  let ruleLine: HTMLElement;
  if (override) {
    // Nothing here routes while the override stands, so nothing here is a control.
    const text = matched
      ? [mono(matched.pattern), ` to ${routeName(matched.targetId)}, paused`]
      : [`Default route to ${routeName(active.defaultTargetId)}, paused`];
    ruleLine = siteLine('greyed', lab(matched ? `Rule ${n}` : 'No rule'), el('p', { class: 'site-held' }, ...text));
  } else if (matched) {
    const pattern = el('input', {
      class: 'input mono qf',
      type: 'text',
      id: 'site-pat',
      value: matched.pattern,
      spellcheck: false,
      title: matched.pattern,
      dataset: { focus: 'rule-pattern' },
    });
    pattern.setAttribute('autocomplete', 'off');
    // Committed on change — Enter, or leaving the field — like a cell in the
    // options page's rule table. An invalid pattern stays in the field, marked,
    // and is not saved.
    pattern.onchange = async () => {
      const next = pattern.value.trim();
      if (!next || next === matched.pattern) {
        pattern.value = matched.pattern;
        pattern.classList.remove('invalid');
        return;
      }
      const problem = patternError({ type: matched.type, pattern: next });
      pattern.classList.toggle('invalid', problem !== null);
      if (problem) {
        pattern.title = problem;
        toast(problem, 2600);
        return;
      }
      await requestTabReload();
      const ok = await commitConfig((fresh) => {
        const p = fresh.profiles.find((x) => x.id === active.id);
        if (!p || p.kind !== 'switch') return false;
        const r = p.rules.find((x) => x.id === matched.id);
        if (!r) return false;
        r.pattern = next;
      });
      if (ok) {
        toast('Rule updated');
        render();
        scheduleExitCheck();
      }
    };
    const target = routeSelect({
      value: matched.targetId,
      label: `Rule ${n} routes via`,
      focusKey: 'rule-target',
      onChange: async (v) => {
        await requestTabReload();
        const ok = await commitConfig((fresh) => {
          const p = fresh.profiles.find((x) => x.id === active.id);
          if (!p || p.kind !== 'switch') return false;
          const r = p.rules.find((x) => x.id === matched.id);
          if (!r) return false;
          r.targetId = v;
        });
        if (ok) {
          render();
          scheduleExitCheck();
        }
      },
    });
    // Deleting is permanent — the rule may cover more than this one site, so the
    // name says which pattern goes, not just "this site". Matches how a rule is
    // deleted in Options: a plain ✕, no confirmation.
    const del = el(
      'button',
      {
        class: 'btn quiet icon ov-remove',
        type: 'button',
        title: `Delete rule ${n} (${matched.pattern})`,
        dataset: { focus: 'rule-delete' },
        onclick: singleClick(async () => {
          await requestTabReload();
          const ok = await commitConfig((fresh) => {
            const p = fresh.profiles.find((x) => x.id === active.id);
            if (!p || p.kind !== 'switch') return false;
            const before = p.rules.length;
            p.rules = p.rules.filter((r) => r.id !== matched.id);
            return p.rules.length !== before; // already deleted elsewhere — no save
          });
          if (ok) {
            toast('Rule deleted');
            render();
            scheduleExitCheck();
          }
        }),
      },
      icon('x')
    );
    del.setAttribute('aria-label', `Delete rule ${n}, ${matched.pattern}`);
    pattern.setAttribute('aria-label', `Rule ${n} pattern`);
    ruleLine = siteLine('', lab(`Rule ${n}`, 'site-pat'), el('div', { class: 'site-ctl' }, pattern, target.wrap), del);
  } else {
    const target = routeSelect({
      value: proxyProfiles(config)[0]?.id ?? DIRECT,
      label: `New rule for *.${t.host} routes via`,
      focusKey: 'rule-target',
    });
    const add = el(
      'button',
      {
        class: 'btn sm',
        type: 'button',
        title: pending
          ? `Add a rule routing *.${t.host} and request the page again over it`
          : `Add a rule routing *.${t.host}`,
        dataset: { focus: 'rule-add' },
        onclick: singleClick(async () => {
          const rule = siteRule(target.select.value);
          await requestTabReload();
          const ok = await commitConfig((fresh) => {
            const p = fresh.profiles.find((x) => x.id === active.id);
            if (!p || p.kind !== 'switch') return false;
            if (fresh.settings.addToBottom) p.rules.push(rule);
            else p.rules.unshift(rule);
          });
          if (ok) {
            toast(pending ? 'Rule added - retrying' : 'Rule added');
            render();
            scheduleExitCheck();
          }
        }),
      },
      pending ? 'Add & retry' : 'Add rule'
    );
    // What the new rule would match, as a caption under the picker: inline, the
    // row has no room left for a real host once the picker and button are in.
    ruleLine = siteLine(
      'no-rule',
      lab('No rule'),
      el('div', { class: 'site-ctl' }, target.wrap),
      add,
      el('p', { class: 'site-cap', title: `A new rule would match *.${t.host}` }, 'for ', mono(`*.${t.host}`))
    );
  }

  /* --- the override row --- */
  let overrideLine: HTMLElement;
  if (override) {
    const end = el(
      'button',
      {
        class: 'btn sm ov-remove ov-end',
        type: 'button',
        title: 'End this override; the rules route this site again',
        dataset: { focus: 'ov-end' },
        onclick: singleClick(async () => {
          await removeOverride(active.id, override.id);
          toast('Override removed');
          render();
        }),
      },
      'End'
    );
    end.setAttribute('aria-label', `End the override for ${override.pattern}`);
    overrideLine = siteLine(
      'override set',
      lab('Override'),
      el(
        'p',
        { class: 'ov-chip' },
        el('span', { class: 'mono', title: override.pattern }, override.pattern),
        icon('arrow', 'sm'),
        lineKey(override.targetId),
        el('b', { title: routeName(override.targetId) }, routeName(override.targetId))
      ),
      end
    );
  } else {
    // While the proxy carrying this tab is failing, the override is the fix:
    // a working route chosen for the user, and the one ink button in view.
    const failure = failureFor(route.bypassed ? DIRECT : route.targetId);
    const fix = failure.touches && failure.presetId !== undefined;
    const picker = routeSelect({
      value: fix ? failure.presetId! : '',
      label: 'Override this site until the browser restarts, via',
      focusKey: 'ov-select',
      placeholder: fix ? undefined : 'Until restart: choose a route',
      exclude: currentKey,
    });
    picker.select.id = 'site-ovr';
    const set = el(
      'button',
      {
        class: `btn sm ov-set${fix ? ' primary' : ''}`,
        type: 'button',
        title: pending
          ? `Route *.${t.host} this way until the browser restarts, and request the page again over it`
          : fix
            ? `Route *.${t.host} this way until the browser restarts, and reload the page over it`
            : `Route *.${t.host} this way until the browser restarts`,
        dataset: { focus: 'ov-set' },
        onclick: singleClick(async () => {
          const targetId = picker.select.value;
          // Nothing chosen yet: a Set that routed the site through whichever
          // proxy happened to be listed first would be a silent reroute.
          if (!targetId) {
            openPicker(picker.select);
            return;
          }
          if (fix && !pending) await requestTabRetry();
          await setOverride(active.id, siteRule(targetId));
          toast(pending ? 'Override set - retrying' : fix ? 'Override set - reloading' : 'Override set');
          render();
        }),
      },
      pending ? 'Set & retry' : fix ? 'Set & reload' : 'Set'
    );
    overrideLine = siteLine('override', lab('Override', 'site-ovr'), el('div', { class: 'site-ctl' }, picker.wrap), set);
  }

  // The route in force comes first: the override while there is one.
  return override ? [overrideLine, ruleLine] : [ruleLine, overrideLine];
}

/**
 * Plain-proxy per-site control: send THIS host straight to the network via
 * profile.bypass. Detection uses the real bypass resolver (testBypass) so it
 * never contradicts the route above — three states: a removable entry this
 * control added, an already-Direct note when a broader bypass rule covers the
 * host, or the add button.
 */
function proxyBypassLine(profile: ProxyProfile, host: string, matchUrl: string): HTMLElement {
  const entry = `*.${host}`;
  const bypass = profile.bypass ?? [];
  const literalIdx = bypass.findIndex((e) => e === entry || e === host);

  // Sent direct by an entry this control added — show the real stored entry and let it be removed.
  if (literalIdx >= 0) {
    const stored = bypass[literalIdx]!;
    const remove = el(
      'button',
      {
        class: 'btn quiet icon ov-remove',
        type: 'button',
        title: 'Stop sending this site direct',
        dataset: { focus: 'bypass-remove' },
        onclick: singleClick(async () => {
          // Same as the rule/override controls: this changes how the site
          // routes, so the page should re-fetch over the new route (and a page
          // that never loaded is re-requested outright).
          await requestTabReload();
          const ok = await commitConfig((fresh) => {
            const p = fresh.profiles.find((x) => x.id === profile.id);
            if (!p || p.kind !== 'proxy') return false;
            p.bypass = p.bypass.filter((e) => e !== stored);
          });
          if (!ok) return;
          toast('Bypass removed');
          render();
          scheduleExitCheck();
        }),
      },
      icon('x')
    );
    remove.setAttribute('aria-label', `Stop sending ${stored} direct`);
    return siteLine(
      'bypass set',
      lab('This site'),
      el('p', { class: 'ov-chip' }, el('span', { class: 'mono', title: stored }, stored), icon('arrow', 'sm'), lineKey(DIRECT), el('b', {}, 'Direct')),
      remove
    );
  }

  // Already Direct via a broader bypass entry (<local>, a parent wildcard, a CIDR block…) — read only.
  if (testBypass(bypass, matchUrl, host)) {
    return siteLine('', lab('This site'), el('p', { class: 'site-held' }, 'Already sent direct by this proxy’s bypass list. Edit it in Options.'));
  }

  // Not bypassed — offer to add it.
  return siteLine(
    '',
    lab('This site'),
    el('div', { class: 'site-ctl' }, el('span', { class: 'site-pat mono', title: `Would add ${entry} to the bypass list` }, entry)),
    el(
      'button',
      {
        class: 'btn sm',
        type: 'button',
        title: `Send ${host} straight to the network, past this proxy`,
        dataset: { focus: 'bypass-add' },
        onclick: singleClick(async () => {
          await requestTabReload();
          const ok = await commitConfig((fresh) => {
            const p = fresh.profiles.find((x) => x.id === profile.id);
            if (!p || p.kind !== 'proxy') return false;
            p.bypass = [...p.bypass, entry];
          });
          if (!ok) return;
          toast(`Bypassing ${host}`);
          render();
          scheduleExitCheck();
        }),
      },
      'Send this site direct'
    )
  );
}

/** "Per-site routing needs an auto switch profile." with the way to make one. */
function needsSwitchLine(): HTMLElement {
  return el(
    'div',
    { class: 'site-one' },
    el('p', { class: 'site-note' }, 'Per-site routing needs an auto switch profile.'),
    el(
      'button',
      { class: 'btn sm', type: 'button', dataset: { focus: 'new-switch' }, onclick: () => void openOptionsAt('new-switch') },
      'New auto switch'
    )
  );
}

/**
 * The controls for this site, for whichever kind of profile the window routes
 * by — editable only where the kind supports per-site routing at all.
 */
function siteSection(): HTMLElement | null {
  const t = tab;
  if (!t || config.profiles.length === 0) return null;
  const section = (...children: HTMLElement[]): HTMLElement => {
    const node = el('section', { class: 'site' }, ...children);
    node.setAttribute('aria-label', 'Routing for this site');
    return node;
  };
  const activeId = scopeActiveId();
  const profile = profileById(config, activeId);
  if (activeId === DIRECT || activeId === SYSTEM || !profile) return section(needsSwitchLine());
  switch (profile.kind) {
    case 'switch':
      return section(...switchSiteLines(profile, t));
    case 'proxy':
      return section(proxyBypassLine(profile, t.host, pacRequestUrl(t.url)), needsSwitchLine());
    case 'virtual':
      return section(
        el('p', { class: 'site-note' }, 'This alias points at another profile - edit its rules from that profile in Options.')
      );
    case 'rulelist':
      return section(el('p', { class: 'site-note' }, 'Routing follows this list’s entries. Edit the list in Options.'));
  }
}

/* ---- the switcher ---- */

/** The rule-list format, short enough for a row: "AutoProxy", "Domain list". */
const LIST_FORMAT_SHORT: Record<RuleListFormat, string> = {
  autoproxy: 'AutoProxy',
  switchy: RULE_LIST_FORMAT_LABELS.switchy,
};

/** The right-hand side of a row: an endpoint for a proxy, the kind for the rest. */
function rowSub(p: Profile): { text: string; mono: boolean } {
  switch (p.kind) {
    case 'proxy':
      return { text: `${p.host}:${p.port}`, mono: true };
    case 'switch':
      return { text: `Auto switch · ${p.rules.length} rule${p.rules.length === 1 ? '' : 's'}`, mono: false };
    case 'rulelist':
      return { text: `Rule list · ${LIST_FORMAT_SHORT[p.format]}`, mono: false };
    case 'virtual':
      return { text: `Alias · ${routeName(p.targetId)}`, mono: false };
  }
}

/**
 * One switcher row: number, line key, name, detail, and the tick on the one in
 * use. A radio in a radiogroup — one row is a tab stop, the arrows move between
 * them, and nothing switches until a row is pressed (moving focus must never
 * reroute traffic). The number is a shortcut hint, filled in by applyFilter
 * from the rows actually showing.
 */
function swRow(opts: { id: string; keyId: string; name: string; sub: string; subMono: boolean; title?: string; search?: string }): HTMLElement {
  const active = selectedId() === opts.id;
  const row = el(
    'button',
    {
      class: `row sw-row${active ? ' active' : ''}`,
      type: 'button',
      dataset: { id: opts.id, focus: `row:${opts.id}` },
      onclick: () => {
        if (selectedId() === opts.id) return;
        void setActive(opts.id);
      },
    },
    el('span', { class: 'n' }),
    lineKey(opts.keyId),
    el('span', { class: 'nm' }, opts.name),
    el('span', { class: `sub${opts.subMono ? ' mono' : ''}` }, opts.sub),
    el('span', { class: 'on' }, active ? icon('check', 'sm') : null, active ? el('span', { class: 'vh' }, 'Active') : null)
  );
  if (opts.title) row.title = opts.title;
  row.setAttribute('role', 'radio');
  row.setAttribute('aria-checked', String(active));
  row.querySelector('.n')!.setAttribute('aria-hidden', 'true');
  if (opts.search !== undefined) row.dataset.search = opts.search;
  return row;
}

/**
 * The "no separate profile" choice, offered only in an incognito window: the
 * list needs a row for it, because with the incognito profile cleared there is
 * nothing else in the list for the tick to sit on — and because it is how the
 * user undoes a choice made here, without going to the options page for it.
 * Its detail names the profile it currently defers to, so choosing it is not
 * a choice made blind.
 */
function followRegularRow(): HTMLElement {
  return swRow({
    id: '',
    keyId: config.activeId,
    name: 'Same as regular windows',
    sub: `Follows ${routeName(config.activeId)}`,
    subMono: false,
    title: `Incognito windows route the way regular windows do - now through ${routeName(config.activeId)}`,
  });
}

function switcher(): HTMLElement[] {
  const total = config.profiles.length;
  const list = el('div', { class: 'sw' });
  list.setAttribute('role', 'radiogroup');
  list.setAttribute('aria-label', incognitoWindow && incognitoAllowed ? 'Profile for incognito windows' : 'Profile');
  list.addEventListener('keydown', onListKeydown);

  if (incognitoWindow && incognitoAllowed) {
    list.append(el('div', { class: 't-label sw-label' }, 'This incognito window'), followRegularRow(), el('div', { class: 'sw-sep' }));
  }
  list.append(
    swRow({ id: DIRECT, keyId: DIRECT, name: 'Direct', sub: 'No proxy', subMono: false, search: 'direct no proxy' }),
    swRow({ id: SYSTEM, keyId: SYSTEM, name: 'System', sub: 'OS settings', subMono: false, search: 'system os settings' })
  );
  if (total === 0) {
    list.append(
      el(
        'div',
        { class: 'sw-empty' },
        el('p', { class: 'sw-empty-title' }, 'No profiles yet'),
        el('p', { class: 'sw-empty-text' }, 'Add a proxy to start routing sites through it.'),
        el(
          'button',
          { class: 'btn primary', type: 'button', dataset: { focus: 'create-first' }, onclick: () => chrome.runtime.openOptionsPage() },
          'Create your first proxy'
        )
      )
    );
  } else {
    // Profiles in the order every surface lists them, by kind, with no group
    // labels: the detail on each row says what it is, and the room the labels
    // would take is what lets a typical list fit without scrolling.
    for (const kind of PROFILE_KINDS) {
      for (const p of config.profiles.filter((x) => x.kind === kind)) {
        const sub = rowSub(p);
        list.append(
          swRow({
            id: p.id,
            keyId: p.id,
            name: p.name,
            sub: sub.text,
            subMono: sub.mono,
            title: statusFor(p),
            search: `${p.name} ${sub.text} ${subFor(p)}`.toLowerCase(),
          })
        );
      }
    }
    list.append(el('p', { class: 'sw-none hidden' }, 'No profiles match.'));
  }

  // Type-to-filter surfaces only once the list gets long enough to warrant it;
  // no autofocus (Esc must stay free to close the popup).
  if (total < 12) return [list];
  const rows = total + 2; // Direct and System filter like any profile
  const input = el('input', {
    class: 'input',
    type: 'search',
    placeholder: `Filter ${rows} profiles`,
    value: filterText,
    spellcheck: false,
    dataset: { focus: 'filter' },
    oninput: () => {
      filterText = input.value;
      applyFilter();
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      visibleRows()[0]?.click();
    },
  });
  input.setAttribute('aria-label', 'Filter profiles');
  input.setAttribute('autocomplete', 'off');
  const find = el('div', { class: 'sw-find' }, el('div', { class: 'search' }, input), el('span', { class: 'sw-count meta' }));
  return [find, list];
}

/** The rows a digit or Enter would reach: the ones showing, in order. */
function visibleRows(): HTMLElement[] {
  return [...app.querySelectorAll<HTMLElement>('.sw .row')].filter((r) => !r.classList.contains('hidden'));
}

/**
 * Hide/show rows against the filter, in place (never a re-render, so the input
 * keeps focus while typing), then renumber what shows and say what the keys do.
 */
function applyFilter(): void {
  const list = app.querySelector('.sw');
  if (!list) return;
  const q = filterText.trim().toLowerCase();
  let filterable = 0;
  let shown = 0;
  list.querySelectorAll<HTMLElement>('.row').forEach((row) => {
    const search = row.dataset.search;
    if (search === undefined) return; // the incognito choice is never filtered out
    filterable++;
    const show = !q || search.includes(q);
    row.classList.toggle('hidden', !show);
    if (show) shown++;
  });
  list.querySelector('.sw-none')?.classList.toggle('hidden', !q || shown > 0);
  const count = app.querySelector<HTMLElement>('.sw-count');
  if (count) count.textContent = q ? `${shown} of ${filterable}` : '';

  const rows = visibleRows();
  rows.forEach((row, i) => {
    const digit = i < 9 ? String(i + 1) : '';
    row.querySelector('.n')!.textContent = digit;
    if (digit) row.setAttribute('aria-keyshortcuts', digit);
    else row.removeAttribute('aria-keyshortcuts');
  });
  // Roving tab stop: the ticked row when it shows, else the first that does.
  const stop = rows.find((r) => r.classList.contains('active')) ?? rows[0];
  list.querySelectorAll<HTMLElement>('.row').forEach((row) => (row.tabIndex = row === stop ? 0 : -1));

  const hint = app.querySelector('.keys-hint');
  if (hint) {
    const n = Math.min(rows.length, 9);
    hint.textContent = q
      ? rows.length
        ? 'Enter switches to the first match'
        : ''
      : n > 1
        ? `Press 1-${n} to switch`
        : n === 1
          ? 'Press 1 to switch'
          : '';
  }
}

/** Arrow keys move between rows — focus only; a row switches when pressed. */
function onListKeydown(e: KeyboardEvent): void {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const rows = visibleRows();
  const at = rows.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  let next = -1;
  if (e.key === 'ArrowDown') next = Math.min(rows.length - 1, at + 1);
  else if (e.key === 'ArrowUp') next = Math.max(0, at - 1);
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = rows.length - 1;
  if (next < 0) return;
  e.preventDefault();
  rows.forEach((r, i) => (r.tabIndex = i === next ? 0 : -1));
  rows[next]!.focus();
}

/**
 * 1–9 pick the Nth row showing, from anywhere but a text field or a select
 * (where a digit is typing) and never with a modifier held — the shortcuts of
 * the browser and the OS stay theirs. e.code covers layouts that put the
 * digits on the shifted level (AZERTY), where the unshifted key is "&". Escape
 * is never handled: it closes the popup.
 */
function onKeydown(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest('input, select, textarea, [contenteditable="true"]')) return;
  const digit = /^[1-9]$/.test(e.key) ? e.key : e.shiftKey ? null : (/^Digit([1-9])$/.exec(e.code)?.[1] ?? null);
  if (!digit) return;
  const row = visibleRows()[Number(digit) - 1];
  if (!row) return;
  e.preventDefault();
  row.focus({ preventScroll: true });
  row.click();
}

/* ---- footer ---- */

function footer(): HTMLElement {
  return el(
    'footer',
    { class: 'pop-foot' },
    el(
      'button',
      { class: 'foot-open', type: 'button', dataset: { focus: 'open-sockitt' }, onclick: () => chrome.runtime.openOptionsPage() },
      'Open Sockitt',
      icon('external', 'sm')
    ),
    el('span', { class: 'keys-hint meta' })
  );
}

/* ---- render ---- */

/**
 * After a re-render, keyboard focus goes back to the control it was on — or
 * to that control's twin, when the action replaced it (End becomes a route
 * picker, a deleted rule's ✕ becomes Add rule). A mouse user never sees a
 * ring from this: script focus only shows one after keyboard use.
 */
const FOCUS_TWINS: Record<string, string> = {
  'ov-end': 'ov-select',
  'ov-set': 'ov-end',
  'rule-delete': 'rule-target',
  'rule-add': 'rule-pattern',
  'rule-pattern': 'rule-target',
  'bypass-add': 'bypass-remove',
  'bypass-remove': 'bypass-add',
};

function render(): void {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focus : undefined;
  app.replaceChildren(
    header(),
    // Always present, so an alert that arrives while the popup is open is
    // announced: a live region has to exist before its content changes.
    el('div', { class: 'alert-slot', ariaLive: 'polite' }, alertLine()),
    hereSection(),
    ...[siteSection()].filter((n): n is HTMLElement => n !== null),
    ...switcher(),
    footer()
  );
  applyFilter();
  fitHost();

  if (focused) {
    const find = (key: string): HTMLElement | undefined =>
      [...app.querySelectorAll<HTMLElement>('[data-focus]')].find((n) => n.dataset.focus === key);
    const twin = FOCUS_TWINS[focused];
    (find(focused) ?? (twin ? find(twin) : undefined))?.focus({ preventScroll: true });
  }

  // Keep the ticked row in view: left alone when it already shows in full (a
  // list that barely overflows then keeps its top, and the cut falls at the
  // bottom where it says "more"), centred when it is out of sight — not
  // 'nearest', which leaves it flush against a fold.
  const list = app.querySelector<HTMLElement>('.sw');
  const ticked = list?.querySelector<HTMLElement>('.row.active:not(.hidden)');
  if (list && ticked && list.scrollHeight > list.clientHeight) {
    const top = ticked.offsetTop;
    const inView = top >= list.scrollTop && top + ticked.offsetHeight <= list.scrollTop + list.clientHeight;
    if (!inView) list.scrollTop = top - list.clientHeight / 2 + ticked.offsetHeight / 2;
  }
}

void init();
