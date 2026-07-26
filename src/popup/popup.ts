import { avatarEl, builtinTile, textColorFor } from '../shared/avatar';
import { EXIT_IP_PERMS, EXIT_IP_URL, checkExitIp, flagSrc } from '../shared/exitip';
import { compileRule, pacRequestUrl, resolveRoute, testBypass, testCondition } from '../shared/match';
import { parseRuleList } from '../shared/rulelist';
import {
  APPLIED_KEY,
  ERROR_KEY,
  POPUP_PORT,
  RELOAD_KEY,
  TAB_EXIT_KEY,
  TAB_EXIT_RESULT_KEY,
  loadConfig,
  loadTempRules,
  saveConfig,
  saveTempRules,
} from '../shared/state';
import {
  Config,
  DIRECT,
  Profile,
  ProxyProfile,
  SCHEME_LABELS,
  SYSTEM,
  SwitchProfile,
  SwitchRule,
  proxyProfiles,
  uid,
} from '../shared/types';
import { el, toast } from '../shared/ui';

const app = document.getElementById('app')!;

interface TabInfo {
  url: string;
  host: string;
}

let config: Config;
let tab: TabInfo | null = null;
let proxyError: { message: string } | null = null;
let tempRules: SwitchRule[] = [];
/** Left-pane profile filter — only surfaced when there are many profiles. */
let filterText = '';

/**
 * Settings glyph for the popup's two "open options" buttons — a Feather-style
 * horizontal-sliders icon (segmented tracks + ring handles so it reads on any
 * background). Matches the line-icon style used on the options page.
 */
const SETTINGS_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<line x1="3" y1="6" x2="12.5" y2="6"/><line x1="19.5" y1="6" x2="21" y2="6"/><circle cx="16" cy="6" r="2.5"/>' +
  '<line x1="3" y1="12" x2="5.5" y2="12"/><line x1="12.5" y1="12" x2="21" y2="12"/><circle cx="9" cy="12" r="2.5"/>' +
  '<line x1="3" y1="18" x2="10.5" y2="18"/><line x1="17.5" y1="18" x2="21" y2="18"/><circle cx="14" cy="18" r="2.5"/>' +
  '</svg>';

/* ---- exit-IP check (detail header) ---- */

type ExitInfo = { ip: string; iso?: string; country?: string; ms: number };
type ExitState =
  | { phase: 'idle' }
  | { phase: 'no-perm' }
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
  const active = config.profiles.find((p) => p.id === config.activeId);
  if (!tab || !active || !tabNeedsProbe(active)) return checkExitIp(6000);
  return probeTabExit(tab.url, tab.host, stillCurrent);
}

async function maybeCheckExit(): Promise<void> {
  if (!config.settings.exitIpCheck) {
    exit = { phase: 'idle' };
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
  const meta = document.querySelector('.dh-meta');
  if (!meta) return;
  // Drop the prior readout. querySelectorAll (not querySelector) so a stack
  // that somehow accumulated gets fully cleared, never leaving a duplicate
  // flag/IP — and never leaving the row taller than the space reserved for it.
  meta.querySelectorAll(':scope > .exit-line').forEach((n) => n.remove());
  const line = exitLine();
  if (line) meta.append(line);
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
  const mark = document.querySelector<HTMLElement>('.topbar .mark');
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
  config = await loadConfig();
  const session = await chrome.storage.session.get(ERROR_KEY).catch(() => ({}));
  proxyError = (session as Record<string, { message: string }>)[ERROR_KEY] ?? null;
  await loadOverride(config.activeId);
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active?.url && /^https?:/i.test(active.url)) {
      tab = { url: active.url, host: new URL(active.url).hostname };
    }
  } catch {
    tab = null;
  }
  render();
  void maybeCheckExit();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[APPLIED_KEY]) scheduleExitCheck();
  });
}

/**
 * Re-read the latest stored config, apply `mutate` to that fresh copy, persist
 * it, and adopt it as the popup's snapshot. The popup can sit open while the
 * background applies sync or rule-list changes; mutating and writing back our
 * load-time snapshot (the module-global `config`) would blind-clobber those.
 * `mutate` must locate its target by id in `fresh`; return false to abort the
 * save (e.g. the profile was deleted from another surface meanwhile).
 */
async function commitConfig(mutate: (fresh: Config) => boolean | void): Promise<boolean> {
  const fresh = await loadConfig();
  if (mutate(fresh) === false) return false;
  await saveConfig(fresh);
  config = fresh;
  return true;
}

async function setActive(id: string): Promise<void> {
  // Load the new profile's override before the single render so the section
  // never flashes the previous profile's state. The background applies the
  // proxy (and reloads the tab if refreshOnSwitch is on) off the storage write.
  await loadOverride(id);
  // Recheck the exit IP for the new route, but keep the previous reading shown
  // dimmed (lastExit) rather than blanking to "checking…".
  if (config.settings.exitIpCheck && exit.phase === 'ok') {
    exitSeq++; // invalidate any in-flight check
    exit = { phase: 'checking' };
  }
  // Re-read and change only activeId, so a background sync/rule-list change that
  // landed while the popup was open isn't overwritten by our stale snapshot.
  await commitConfig((fresh) => {
    fresh.activeId = id;
  });
  render();
  wiggleSock();
}

/**
 * The override is a single, always-temporary rule (session storage). Older
 * versions could store several temp rules; collapse to one so the UI only
 * ever manages a single override slot.
 */
async function loadOverride(profileId: string): Promise<void> {
  const rules = await loadTempRules(profileId);
  tempRules = rules.slice(0, 1);
  // Legacy-state cleanup. Awaited: saveTempRules is a read-modify-write over
  // the shared map, so letting it float would race the user's own override
  // clicks. The branch never fires on the common path (≤1 rule), so first
  // paint doesn't pay for it.
  if (rules.length > 1) await saveTempRules(profileId, tempRules);
}

async function setOverride(profileId: string, rule: SwitchRule | null): Promise<void> {
  tempRules = rule ? [rule] : [];
  await requestTabReload();
  await saveTempRules(profileId, tempRules);
  scheduleExitCheck(); // the tab's route just changed — re-probe where it exits
}

/**
 * A this-tab override/rule change alters how THIS site routes, so with
 * "reload on switch" on the page should re-fetch over the new route. Ask the
 * worker to reload the active tab AFTER it applies the change (set here, before
 * the save that wakes applyActive, which consumes RELOAD_KEY). Doing it worker-
 * side — not here — keeps the reload from racing ahead of the proxy update.
 */
async function requestTabReload(): Promise<void> {
  if (config.settings.refreshOnSwitch && tab) {
    await chrome.storage.session.set({ [RELOAD_KEY]: { at: Date.now() } });
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
      return profile.format;
  }
}

function tempRulesFor(profileId: string): SwitchRule[] {
  return config.activeId === profileId ? tempRules : [];
}

/* ---- right-pane detail header: the active profile, compact ---- */

function detailHead(profile: Profile | undefined): HTMLElement {
  const { activeId } = config;
  let tile: HTMLElement;
  let name: string;
  let status: string;
  let tint = 'transparent';
  let dot: 'on' | 'warn' | 'off' = 'off';

  if (activeId === DIRECT) {
    tile = builtinTile('D', 40);
    name = 'Direct';
    status = 'No proxy — your real connection';
  } else if (activeId === SYSTEM || !profile) {
    tile = builtinTile('S', 40);
    name = 'System';
    status = 'Following OS proxy settings';
  } else {
    tile = avatarEl(profile, 40);
    name = profile.name;
    status = statusFor(profile);
    tint = profile.color;
    dot = profile.kind === 'switch' && tempRules[0] ? 'warn' : 'on';
  }

  const head = el(
    'div',
    { class: 'detail-head' },
    tile,
    el(
      'div',
      { class: 'dh-meta' },
      el(
        'div',
        { class: 'dh-top' },
        el('div', { class: 'dh-name', title: name }, name),
        el('span', { class: `sdot ${dot}` })
      ),
      el('div', { class: 'dh-status' }, status),
      exitLine()
    )
  );
  head.style.setProperty('--tint', tint);
  return head;
}

/**
 * A quiet one-line readout under the status: where THIS tab actually exits —
 * "Exit via 🇹🇭 · 27.145.178.97 · 237 ms".
 *
 * Every phase renders exactly one line, and the line exists from the first
 * paint (empty while idle) whenever the setting is on. The check resolves a
 * second or two after the popup opens, so a line that appeared — or grew from
 * one row to two — at that moment would shove the whole card down under the
 * user's cursor mid-click. The fixed height in CSS is what holds the space.
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
      el('span', { class: 'exit-lead' }, 'Exit via'),
      src ? el('img', { class: 'exit-flag', src, alt: info.country ?? '', width: 20, height: 15 }) : null,
      // The leading separator belongs to the flag — without one, the line would
      // open on a stray "· ".
      el('span', { class: 'exit-ip' }, `${src ? '· ' : ''}${info.ip} · ${info.ms} ms`)
    );
  };
  switch (exit.phase) {
    case 'idle':
      // The check hasn't reported yet — hold the row, say nothing.
      return el('span', { class: 'exit-line' });
    case 'no-perm':
      return el(
        'button',
        { class: 'exit-line exit-enable', onclick: () => void enableExitCheck() },
        'Show where this tab exits…'
      );
    case 'checking':
      // Keep the last good reading visible (dimmed) instead of blanking.
      return lastExit
        ? okLine(lastExit, true)
        : el('span', { class: 'exit-line' }, 'Checking where this tab exits…');
    case 'ok':
      return okLine(exit, false);
    case 'error':
      return el('span', { class: 'exit-line err', title: exit.message }, 'Exit check failed');
  }
}

/* ---- profile rows (left switcher) ---- */

function profileRow(
  id: string,
  tile: HTMLElement,
  name: string,
  sub: string,
  color?: string
): HTMLElement {
  const active = config.activeId === id;
  const row = el(
    'button',
    { class: `row${active ? ' active' : ''}`, onclick: () => setActive(id) },
    tile,
    el(
      'span',
      { class: 'meta' },
      el('span', { class: 'title' }, name),
      el('span', { class: 'sub' }, sub)
    ),
    active ? el('span', { class: 'check', innerHTML: '&#10003;' }) : null
  );
  row.setAttribute('aria-pressed', String(active));
  if (color) {
    row.style.setProperty('--row-color', color);
    row.style.setProperty('--row-ink', textColorFor(color));
  }
  return row;
}

/* ---- shared bits for the "this tab" region ---- */

/** First enabled permanent rule whose condition matches the current site. */
function matchedRuleFor(profile: SwitchProfile, url: string, host: string): SwitchRule | undefined {
  return profile.rules.find((r) => r.enabled && testCondition(compileRule(r), url, host));
}

/** A target picker: Direct + proxies, plus the current value if it's some other profile. */
function siteTargetSelect(current: string, onChange: (v: string) => void): HTMLSelectElement {
  const select = el('select', { class: 'input sm' }) as HTMLSelectElement;
  select.append(el('option', { value: DIRECT }, 'Direct'));
  const proxies = proxyProfiles(config);
  for (const p of proxies) select.append(el('option', { value: p.id }, p.name));
  if (current !== DIRECT && !proxies.some((p) => p.id === current)) {
    const cp = config.profiles.find((p) => p.id === current);
    if (cp) select.append(el('option', { value: current }, cp.name));
  }
  select.value = [...select.options].some((o) => o.value === current) ? current : DIRECT;
  select.onchange = () => onChange(select.value);
  return select;
}

function targetChip(targetId: string, size: number): { tile: HTMLElement; name: string } {
  if (targetId === DIRECT) return { tile: builtinTile('D', size), name: 'Direct' };
  const p = config.profiles.find((x) => x.id === targetId);
  return p ? { tile: avatarEl(p, size), name: p.name } : { tile: builtinTile('D', size), name: 'Direct' };
}

function thisTabHead(host: string | null): HTMLElement {
  return el(
    'div',
    { class: 'this-site-head' },
    el('span', { class: 'ts-label' }, 'This tab'),
    host
      ? el('span', { class: 'ts-host', title: host }, host)
      : el('span', { class: 'ts-host muted' }, '—')
  );
}

/** One readout field: either a route chip (tile + name + tag) or a plain sentence. */
function routeField(
  via: { tile: HTMLElement; name: string; tag: string } | null,
  sentence: string | null
): HTMLElement {
  return via
    ? el(
        'div',
        { class: 'sm-field route' },
        el('span', { class: 'sm-label' }, 'Route'),
        el(
          'span',
          { class: 'route-val' },
          via.tile,
          el('span', { class: 'route-name', title: via.name }, via.name),
          el('span', { class: 'route-tag' }, via.tag)
        )
      )
    : el(
        'div',
        { class: 'sm-field' },
        el('div', { class: 'sm-lead' }, el('span', { class: 'sm-label' }, 'Route')),
        el('div', { class: 'route-sentence' }, sentence ?? '')
      );
}

/** A one-field readout card. */
function routeReadout(
  via: { tile: HTMLElement; name: string; tag: string } | null,
  sentence: string | null
): HTMLElement {
  return el('div', { class: 'card site-mgr' }, routeField(via, sentence));
}

/**
 * Plain-proxy per-site control: send THIS host straight to the network via
 * profile.bypass. Detection uses the real bypass resolver (testBypass) so it
 * never contradicts the Route readout — three states: a removable entry this
 * control added, an already-Direct note when a broader bypass rule covers the
 * host, or the add button.
 */
function proxyBypassControl(profile: ProxyProfile, host: string, matchUrl: string): HTMLElement {
  const entry = `*.${host}`;
  const bypass = profile.bypass ?? [];
  const lead = el('div', { class: 'sm-lead' }, el('span', { class: 'sm-label' }, 'This site'));
  const literalIdx = bypass.findIndex((e) => e === entry || e === host);

  // Sent direct by an entry this control added — show the real stored entry and let it be removed.
  if (literalIdx >= 0) {
    const stored = bypass[literalIdx]!;
    return el(
      'div',
      { class: 'sm-field override set' },
      lead,
      el(
        'div',
        { class: 'sm-ctl' },
        el(
          'span',
          { class: 'ov-chip' },
          el('span', { class: 'mono', title: stored }, stored),
          el('span', { class: 'ov-arrow', innerHTML: '&#8594; Direct' })
        ),
        el('button', {
          class: 'btn ghost icon ov-remove',
          title: 'Stop sending this site direct',
          innerHTML: '&#10005;',
          onclick: () => {
            void commitConfig((fresh) => {
              const p = fresh.profiles.find((x) => x.id === profile.id);
              if (!p || p.kind !== 'proxy') return false;
              p.bypass = p.bypass.filter((e) => e !== stored);
            }).then((ok) => {
              if (!ok) return;
              toast('Bypass removed');
              render();
              scheduleExitCheck();
            });
          },
        })
      )
    );
  }

  // Already Direct via a broader bypass entry (<local>, a parent wildcard, a CIDR block…) — read only.
  if (testBypass(bypass, matchUrl, host)) {
    return el(
      'div',
      { class: 'sm-field' },
      lead,
      el('div', { class: 'route-sentence' }, 'Already sent direct by this proxy’s bypass list — edit it in Options.')
    );
  }

  // Not bypassed — offer to add it.
  return el(
    'div',
    { class: 'sm-field' },
    lead,
    el(
      'div',
      { class: 'sm-ctl' },
      el(
        'button',
        {
          class: 'btn sm',
          title: `Send ${host} straight to the network, past this proxy`,
          onclick: () => {
            void commitConfig((fresh) => {
              const p = fresh.profiles.find((x) => x.id === profile.id);
              if (!p || p.kind !== 'proxy') return false;
              p.bypass = [...p.bypass, entry];
            }).then((ok) => {
              if (!ok) return;
              toast(`Bypassing ${host}`);
              render();
              scheduleExitCheck();
            });
          },
        },
        'Send this site direct'
      )
    )
  );
}

/**
 * The editable per-site card, shown only when an Auto switch profile is active:
 * a hairline-divided field group — route readout, the matching rule, override.
 */
function siteRuleCard(active: SwitchProfile): HTMLElement {
  const matchUrl = pacRequestUrl(tab!.url);
  const override = tempRules[0];
  // Grey out the rule controls only when the override actually captures THIS
  // site — an override set on another site must not lock editing here.
  const overridesThisSite = !!override && testCondition(compileRule(override), matchUrl, tab!.host);

  /** The quick "*.currenthost → target" rule both blocks below create. */
  const siteRule = (targetId: string): SwitchRule => ({
    id: uid(),
    enabled: true,
    type: 'hostWildcard',
    pattern: `*.${tab!.host}`,
    targetId,
  });

  /* --- route field --- */
  const route = resolveRoute(config, active, matchUrl, tab!.host, tempRules);
  const via = route.bypassed
    ? { tile: builtinTile('D', 20), name: 'Direct (bypass)' }
    : targetChip(route.targetId, 20);
  let tag: string;
  if (route.bypassed) tag = 'bypass';
  else if (override && route.ruleId === override.id) tag = 'override';
  else if (route.ruleId) tag = 'rule';
  else tag = 'default';
  const routeField = el(
    'div',
    { class: 'sm-field route' },
    el('span', { class: 'sm-label' }, 'Route'),
    el(
      'span',
      { class: 'route-val' },
      via.tile,
      el('span', { class: 'route-name', title: via.name }, via.name),
      el('span', { class: 'route-tag' }, tag)
    )
  );

  /* --- rule field: edit the matching rule or add one; greyed while overridden --- */
  const matched = matchedRuleFor(active, matchUrl, tab!.host);
  let ruleField: HTMLElement;
  if (matched) {
    const sel = siteTargetSelect(matched.targetId, async (v) => {
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
    });
    sel.disabled = overridesThisSite;
    // Deleting is permanent — the rule may cover more than this one site, so the
    // tooltip names the pattern that goes, not just "this site". Matches how a
    // rule is deleted in Options: a plain ✕, no confirmation.
    const del = el('button', {
      class: 'btn ghost icon ov-remove',
      title: `Delete this rule (${matched.pattern})`,
      innerHTML: '&#10005;',
      disabled: overridesThisSite,
      onclick: async () => {
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
      },
    });
    del.setAttribute('aria-label', `Delete the rule ${matched.pattern}`);
    ruleField = el(
      'div',
      { class: `sm-field${overridesThisSite ? ' greyed' : ''}` },
      el('div', { class: 'sm-lead' }, el('span', { class: 'sm-label' }, 'Rule for this site')),
      el(
        'div',
        { class: 'sm-ctl' },
        el('span', { class: 'sm-pattern', title: matched.pattern }, matched.pattern),
        sel,
        del
      )
    );
  } else {
    const sel = siteTargetSelect(proxyProfiles(config)[0]?.id ?? DIRECT, () => undefined);
    sel.disabled = overridesThisSite;
    const add = el(
      'button',
      {
        class: 'btn sm',
        disabled: overridesThisSite,
        title: `Add a rule routing *.${tab!.host}`,
        onclick: async () => {
          const rule = siteRule(sel.value);
          await requestTabReload();
          const ok = await commitConfig((fresh) => {
            const p = fresh.profiles.find((x) => x.id === active.id);
            if (!p || p.kind !== 'switch') return false;
            if (fresh.settings.addToBottom) p.rules.push(rule);
            else p.rules.unshift(rule);
          });
          if (ok) {
            toast('Rule added');
            render();
            scheduleExitCheck();
          }
        },
      },
      'Add rule'
    );
    ruleField = el(
      'div',
      { class: `sm-field${overridesThisSite ? ' greyed' : ''}` },
      el(
        'div',
        { class: 'sm-lead' },
        el('span', { class: 'sm-label' }, 'No rule for this site'),
        el('span', { class: 'sm-note' }, 'routes via default')
      ),
      el('div', { class: 'sm-ctl' }, sel, add)
    );
  }

  /* --- override field: always temporary, single slot, deletable --- */
  const overrideLead = el(
    'div',
    { class: 'sm-lead' },
    el('span', { class: 'sm-label temp' }, 'Override'),
    el('span', { class: 'sm-note' }, 'temporary · until restart')
  );
  let overrideField: HTMLElement;
  if (override) {
    const chip = targetChip(override.targetId, 18);
    overrideField = el(
      'div',
      { class: 'sm-field override set' },
      overrideLead,
      el(
        'div',
        { class: 'sm-ctl' },
        el(
          'span',
          { class: 'ov-chip' },
          chip.tile,
          el('span', { class: 'mono', title: override.pattern }, override.pattern),
          el('span', { class: 'ov-arrow', innerHTML: '&#8594;' }),
          el('span', { class: 'ov-target' }, chip.name)
        ),
        el('button', {
          class: 'btn ghost icon ov-remove',
          title: 'Remove override',
          innerHTML: '&#10005;',
          onclick: () => {
            void setOverride(active.id, null);
            toast('Override removed');
            render();
          },
        })
      )
    );
  } else {
    const sel = siteTargetSelect(proxyProfiles(config)[0]?.id ?? DIRECT, () => undefined);
    overrideField = el(
      'div',
      { class: 'sm-field override' },
      overrideLead,
      el(
        'div',
        { class: 'sm-ctl' },
        sel,
        el(
          'button',
          {
            class: 'btn sm',
            title: `Temporarily route *.${tab!.host} until the browser restarts`,
            onclick: () => {
              void setOverride(active.id, siteRule(sel.value));
              toast('Override set');
              render();
            },
          },
          'Set'
        )
      )
    );
  }

  return el('div', { class: 'card site-mgr' }, routeField, ruleField, overrideField);
}

/**
 * The right pane's "this tab" region. A live readout of where the active
 * profile sends the current tab — for every profile kind — with editable
 * controls only where the kind actually supports them.
 */
function thisTab(profile: Profile | undefined): (Node | null)[] {
  const { activeId } = config;
  const noProfiles = config.profiles.length === 0;

  if (!tab) {
    return [
      thisTabHead(null),
      el(
        'p',
        { class: 'sm-hint' },
        'No web page here — Sockitt routes http(s) sites only. Switch profiles any time on the left.'
      ),
    ];
  }

  const host = tab.host;
  const matchUrl = pacRequestUrl(tab.url);

  if (activeId === DIRECT) {
    return [
      thisTabHead(host),
      routeReadout({ tile: builtinTile('D', 20), name: 'Direct', tag: 'no proxy' }, null),
      el(
        'p',
        { class: 'sm-hint' },
        noProfiles
          ? 'No proxies yet — create one on the left, then route this site through it.'
          : 'Connects directly — no proxy. To route this site, pick an Auto switch profile on the left.'
      ),
    ];
  }

  if (activeId === SYSTEM || !profile) {
    return [
      thisTabHead(host),
      routeReadout(null, 'Following your OS proxy settings.'),
      el('p', { class: 'sm-hint' }, 'Sockitt can’t inspect the OS PAC’s per-site rules, so it won’t show a route here.'),
    ];
  }

  if (profile.kind === 'switch') {
    return [
      thisTabHead(host),
      siteRuleCard(profile),
      el('p', { class: 'sm-hint' }, 'A rule persists; an override takes priority for this site and clears when the browser restarts.'),
    ];
  }

  // Plain proxy / alias / rule list — read-only route, resolved for real.
  const route = resolveRoute(config, profile, matchUrl, host);
  const via = route.bypassed
    ? { tile: builtinTile('D', 20), name: 'Direct (bypass)' }
    : targetChip(route.targetId, 20);
  let tag: string;
  if (route.bypassed) tag = 'bypass';
  else if (profile.kind === 'proxy') tag = 'all traffic';
  else if (profile.kind === 'virtual') tag = 'alias';
  else tag = 'rule list';

  const chip = { tile: via.tile, name: via.name, tag };

  if (profile.kind === 'proxy') {
    // Route readout + the per-site bypass control share one field-group card.
    const card = el('div', { class: 'card site-mgr' }, routeField(chip, null), proxyBypassControl(profile, host, matchUrl));
    return [thisTabHead(host), card, el('p', { class: 'sm-hint' }, 'Per-site target routing needs an Auto switch profile.')];
  }
  if (profile.kind === 'virtual') {
    return [thisTabHead(host), routeReadout(chip, null), el('p', { class: 'sm-hint' }, 'This alias points at another profile — edit its rules from that profile in Options.')];
  }
  return [thisTabHead(host), routeReadout(chip, null), el('p', { class: 'sm-hint' }, 'Routing follows this list’s entries. Edit the list in Options.')];
}

/* ---- render: two-pane window (switcher left, this-tab right) ---- */

function topBar(): HTMLElement {
  return el(
    'div',
    { class: 'topbar' },
    el('span', { class: 'brand' }, el('img', { class: 'mark', src: 'img/logo-mark.png', alt: '' }), 'Sockitt'),
    el('button', {
      class: 'btn ghost icon cog',
      title: 'Options',
      innerHTML: SETTINGS_ICON,
      onclick: () => chrome.runtime.openOptionsPage(),
    })
  );
}

/**
 * Hide/show left-pane rows against the filter box, in place (never a re-render,
 * so the input keeps focus while typing). Whole groups collapse when empty; the
 * always-available Direct/System modes are never filtered out.
 */
function applyFilter(): void {
  const scroll = app.querySelector('.left-scroll');
  if (!scroll) return;
  const q = filterText.trim().toLowerCase();
  let anyVisible = false;
  scroll.querySelectorAll<HTMLElement>('.pgroup').forEach((group) => {
    let groupVisible = false;
    group.querySelectorAll<HTMLElement>('.row[data-search]').forEach((row) => {
      const show = !q || (row.dataset.search ?? '').includes(q);
      row.classList.toggle('hidden', !show);
      if (show) groupVisible = true;
    });
    group.classList.toggle('hidden', !groupVisible);
    if (groupVisible) anyVisible = true;
  });
  scroll.querySelector('.no-matches')?.classList.toggle('hidden', anyVisible || !q);
}

function leftPane(groups: Array<[string, Profile[]]>): HTMLElement {
  const total = config.profiles.length;

  const builtins = el(
    'div',
    { class: 'builtin-grid' },
    profileRow(DIRECT, builtinTile('D', 27), 'Direct', 'no proxy'),
    profileRow(SYSTEM, builtinTile('S', 27), 'System', 'OS settings')
  );

  const scroll = el('div', { class: 'left-scroll' }, builtins);
  if (total === 0) {
    scroll.append(
      el(
        'div',
        { class: 'empty-block' },
        el('div', { class: 'eb-title' }, 'No profiles yet'),
        el('div', { class: 'eb-text' }, 'Add a proxy to start routing sites through it.'),
        el(
          'button',
          { class: 'btn primary', onclick: () => chrome.runtime.openOptionsPage() },
          'Create your first proxy'
        )
      )
    );
  } else {
    for (const [label, profiles] of groups) {
      if (!profiles.length) continue;
      const group = el('div', { class: 'pgroup' }, el('div', { class: 'section-label' }, label));
      for (const p of profiles) {
        const row = profileRow(p.id, avatarEl(p, 27), p.name, subFor(p), p.color);
        row.dataset.search = `${p.name} ${subFor(p)}`.toLowerCase();
        group.append(row);
      }
      scroll.append(group);
    }
    scroll.append(el('div', { class: 'no-matches hidden' }, 'No profiles match.'));
  }

  const foot = el(
    'div',
    { class: 'left-foot' },
    el(
      'button',
      { class: 'btn ghost foot-manage', onclick: () => chrome.runtime.openOptionsPage() },
      el('span', { class: 'foot-ico', innerHTML: SETTINGS_ICON }),
      'Manage profiles & rules'
    )
  );

  // Type-to-filter surfaces only once the list gets long enough to warrant it;
  // no autofocus (Esc must stay free to close the popup).
  const filter =
    total >= 12
      ? el('input', {
          class: 'left-filter',
          type: 'search',
          placeholder: 'Filter profiles…',
          value: filterText,
          spellcheck: false,
          oninput: (e: Event) => {
            filterText = (e.currentTarget as HTMLInputElement).value;
            applyFilter();
          },
        })
      : null;

  return el('div', { class: 'pane-left' }, filter, scroll, foot);
}

function rightPane(activeProfile: Profile | undefined): HTMLElement {
  return el(
    'div',
    { class: 'pane-right' },
    detailHead(activeProfile),
    el('div', { class: 'detail-scroll' }, ...thisTab(activeProfile))
  );
}

function render(): void {
  const activeProfile = config.profiles.find((p) => p.id === config.activeId);

  const groups: Array<[string, Profile[]]> = [
    ['Proxies', config.profiles.filter((p) => p.kind === 'proxy')],
    ['Auto switch', config.profiles.filter((p) => p.kind === 'switch')],
    ['Rule lists', config.profiles.filter((p) => p.kind === 'rulelist')],
    ['Aliases', config.profiles.filter((p) => p.kind === 'virtual')],
  ];

  const children: Node[] = [topBar()];
  if (proxyError) children.push(el('div', { class: 'banner pop-banner' }, `Proxy error: ${proxyError.message}`));
  children.push(el('div', { class: 'body' }, leftPane(groups), rightPane(activeProfile)));

  app.replaceChildren(...children);

  // Re-apply any active filter, then keep the active profile visible.
  applyFilter();
  app.querySelector('.left-scroll .row.active')?.scrollIntoView({ block: 'nearest' });
}

void init();
