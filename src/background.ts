import { initialsFor, textColorFor } from './shared/avatar';
import { pacRequestUrl, resolveRoute } from './shared/match';
import { compilePac, fixedServersValue, pacDirective, staticTerminal } from './shared/pac';
import {
  APPLIED_KEY,
  ERROR_KEY,
  RELOAD_KEY,
  TAB_EXIT_KEY,
  TAB_EXIT_RESULT_KEY,
  TEST_KEY,
  TEST_RESULT_KEY,
  loadConfig,
  loadTempRules,
  onConfigChanged,
  onTempRulesChanged,
  saveConfig,
  saveConfigRaw,
} from './shared/state';
import { EXIT_IP_URL, checkExitIp } from './shared/exitip';
import { applyFromSync, onSyncChanged, pullFromSync, pushToSync } from './shared/sync';
import {
  Config,
  DIRECT,
  Profile,
  ProxyScheme,
  SYSTEM,
  SwitchRule,
  profileById,
  proxyProfiles,
  schemeSupportsAuth,
} from './shared/types';

const NEUTRAL = '#8b93a7';
const REVERT_COOLDOWN_MS = 30_000;
const ALARM_PREFIX = 'rl:';

let lastRevert = 0;
let lastActiveId: string | undefined;
/** Most recently applied config; lets tab events gate without a storage read. */
let cachedConfig: Config | null = null;

/* ---------------- proxy application ---------------- */

function hasBypass(bypass: string[]): boolean {
  return bypass.some((b) => b.trim().length > 0);
}

function settingsValueFor(
  config: Config,
  tempRules: SwitchRule[]
): { value: chrome.proxy.ProxyConfig; label: string; profile: Profile | null } {
  const { activeId } = config;
  if (activeId === DIRECT) return { value: { mode: 'direct' }, label: 'Direct', profile: null };
  if (activeId === SYSTEM) return { value: { mode: 'system' }, label: 'System', profile: null };
  const profile = profileById(config, activeId);
  if (!profile) return { value: { mode: 'system' }, label: 'System', profile: null };

  const terminal = staticTerminal(config, profile);
  if (terminal === 'direct') {
    return { value: { mode: 'direct' }, label: profile.name, profile };
  }
  // A proxy with an empty bypass list can take the fast fixed_servers path.
  // With a bypass list, compile a PAC instead so bypass entries mean the same
  // thing regardless of how the profile was reached (Chrome-native bypass
  // semantics differ from Sockitt's PAC semantics).
  if (terminal && !hasBypass(terminal.bypass)) {
    return {
      value: fixedServersValue(terminal.scheme, terminal.host, terminal.port, terminal.bypass),
      label: profile.name,
      profile,
    };
  }
  return {
    value: {
      mode: 'pac_script',
      pacScript: { data: compilePac(config, profile, tempRules), mandatory: true },
    },
    label: profile.name,
    profile,
  };
}

/**
 * Apply, unless a connection test is running — its proxy must not be stomped
 * mid-probe. The test's finally re-applies fresh config afterward, so any
 * change that arrives during the test is still reflected.
 */
function applyActiveGuarded(): void {
  if (testInFlight) {
    reapplyAfterTest = true; // the test's finally re-applies fresh config
    return;
  }
  void applyActive();
}

/**
 * Surface a failure to apply the proxy so it can never be a silent fail-open.
 * Without this, a throw in settingsValueFor/compilePac (e.g. a malformed host
 * or rule) or a rejected settings.set would leave chrome.proxy on the previous
 * route while the popup still shows the newly-selected profile as active.
 * Mirrors onProxyError's fatal treatment: red "!" badge + ERROR_KEY, which the
 * popup renders.
 */
async function recordApplyError(e: unknown): Promise<void> {
  const message = e instanceof Error ? e.message : String(e);
  console.error('Sockitt: could not apply proxy settings —', e);
  await Promise.allSettled([
    chrome.storage.session.set({ [ERROR_KEY]: { message, at: Date.now(), fatal: true } }),
    chrome.action.setBadgeBackgroundColor({ color: '#f5576c' }),
    chrome.action.setBadgeText({ text: '!' }),
    chrome.action.setTitle({ title: `Sockitt — proxy not applied (${message})` }),
  ]);
}

/**
 * `signal` (default true) writes APPLIED_KEY so open UI re-checks the route.
 * A tab-exit probe restores the route with signal:false — it returns to the
 * pre-probe route, so it's not a change; signalling would make the popup
 * re-check → re-probe → restore → signal … in an endless proxy-churn loop.
 */
async function applyActive(signal = true): Promise<void> {
  try {
    await applyActiveInner(signal);
  } catch (e) {
    await recordApplyError(e);
  }
}

async function applyActiveInner(signal = true): Promise<void> {
  const config = await loadConfig();
  cachedConfig = config;
  const tempRules = await loadTempRules(config.activeId);
  const { value, label, profile } = settingsValueFor(config, tempRules);

  await chrome.proxy.settings.set({ value, scope: 'regular' });
  await applyIncognito(config);

  // Independent action/session updates — no ordering dependency between them.
  // APPLIED_KEY lands after settings.set above, so a popup exit-IP check it
  // triggers rides the NEW route, never the one being replaced.
  await Promise.all([
    chrome.storage.session.remove(ERROR_KEY),
    signal
      ? chrome.storage.session.set({ [APPLIED_KEY]: { activeId: config.activeId, at: Date.now() } })
      : Promise.resolve(),
    chrome.action.setBadgeText({ text: '' }),
    chrome.action.setTitle({ title: `Sockitt — ${label}` }),
    paintIcon(profile),
    chrome.action.setPopup({ popup: config.settings.quickSwitch ? '' : 'popup.html' }),
  ]);

  const current = await chrome.proxy.settings.get({});
  if (current.levelOfControl === 'controlled_by_other_extensions') {
    await chrome.action.setBadgeBackgroundColor({ color: '#f5576c' });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setTitle({
      title: `Sockitt — ${label} (another extension is controlling the proxy)`,
    });
  }

  // Reload the active tab only when the *active profile* actually changed and
  // the setting is on — done here, after proxy.settings.set, so the reload
  // can't race ahead of the new route (the old popup-side reload could).
  const switched = lastActiveId !== undefined && lastActiveId !== config.activeId;
  lastActiveId = config.activeId;
  if (switched && config.settings.refreshOnSwitch) await reloadActiveTab();

  // A this-tab override/rule change (from the popup) also alters how the active
  // tab routes, but leaves activeId unchanged — so `switched` misses it. The
  // popup sets RELOAD_KEY for those; honour it here, after settings.set, so the
  // reload rides the new route. Consume it unconditionally so it can't linger.
  const reloadStore = await chrome.storage.session.get(RELOAD_KEY);
  if (reloadStore[RELOAD_KEY]) {
    await chrome.storage.session.remove(RELOAD_KEY);
    if (!switched && config.settings.refreshOnSwitch) await reloadActiveTab();
  }

  rebuildCredentials(config);
  registerAuthListener();
  await refreshActiveTabBadge(config);
  await scheduleRuleListUpdates(config);
  if (config.settings.syncEnabled) await pushToSync(config);
}

/* ---------------- proxy authentication (http/https, optional perms) ---------------- */

const credByEndpoint = new Map<string, { username: string; password: string }>();
/** false until the map reflects stored config in THIS worker instance. */
let credsLoaded = false;
/**
 * requestIds already answered once. Chrome re-fires onAuthRequired for the
 * same request when the supplied credentials are rejected — answering again
 * with the same pair would loop forever and suppress the browser's own
 * dialog, so a repeat challenge gets {} and the user can type a correction.
 */
const answeredChallenges = new Set<string>();
const MAX_TRACKED_CHALLENGES = 500;

/**
 * Endpoint→credentials for every http/https proxy that has credentials. Keys
 * are lowercased: challenger.host arrives canonicalized, while profile.host
 * is whatever the user typed.
 */
function rebuildCredentials(config: Config): void {
  credByEndpoint.clear();
  for (const p of proxyProfiles(config)) {
    if (schemeSupportsAuth(p.scheme) && (p.username || p.password)) {
      credByEndpoint.set(`${p.host.trim().toLowerCase()}:${p.port}`, {
        username: p.username ?? '',
        password: p.password ?? '',
      });
    }
  }
  credsLoaded = true;
}

function credentialsFor(challenger: {
  host: string;
  port: number;
}): { username: string; password: string } | undefined {
  return credByEndpoint.get(`${challenger.host.toLowerCase()}:${challenger.port}`);
}

/**
 * asyncBlocking: the handler may respond after a storage read, so a freshly
 * woken worker (whose in-memory map is empty) can still answer the very
 * challenge that woke it.
 */
function onAuthRequired(
  details: chrome.webRequest.OnAuthRequiredDetails,
  asyncCallback?: (response: chrome.webRequest.BlockingResponse) => void
): chrome.webRequest.BlockingResponse | undefined {
  // asyncBlocking delivers the answer via the callback; the return value is
  // ignored. respond() returns undefined so `return respond(...)` typechecks.
  const respond = (r: chrome.webRequest.BlockingResponse): undefined => {
    asyncCallback?.(r);
    return undefined;
  };
  if (!details.isProxy || !details.challenger) return respond({});
  // Keyed on request AND challenger: a repeat from the same proxy means our
  // credentials were rejected, but a redirect that crosses onto a second
  // authenticating proxy re-uses the requestId and still deserves an answer.
  const challengeKey = `${details.requestId}|${details.challenger.host}:${details.challenger.port}`;
  if (answeredChallenges.has(challengeKey)) return respond({}); // rejected creds — don't loop
  if (answeredChallenges.size >= MAX_TRACKED_CHALLENGES) {
    // Evict only the oldest marker (Sets iterate in insertion order): a
    // wholesale clear would forget in-flight challenges mid-burst and let a
    // rejected pair be re-answered.
    const oldest = answeredChallenges.values().next().value;
    if (oldest !== undefined) answeredChallenges.delete(oldest);
  }
  answeredChallenges.add(challengeKey);
  if (credsLoaded) {
    const cred = credentialsFor(details.challenger);
    return respond(cred ? { authCredentials: cred } : {});
  }
  void loadConfig()
    .then((config) => {
      rebuildCredentials(config);
      const cred = credentialsFor(details.challenger!);
      respond(cred ? { authCredentials: cred } : {});
    })
    // A dropped callback would hold the request forever under asyncBlocking.
    .catch(() => respond({}));
}

/**
 * Register at the worker's top level, in the first synchronous turn — MV3
 * only wakes a suspended worker for events whose listeners were registered
 * there. chrome.webRequest exists only once the optional permission has been
 * granted (in a past or current session); until then this is a silent no-op
 * and the permissions.onAdded hook below retries after a grant.
 */
function registerAuthListener(): void {
  try {
    if (!chrome.webRequest?.onAuthRequired) return;
    if (chrome.webRequest.onAuthRequired.hasListener(onAuthRequired)) return;
    chrome.webRequest.onAuthRequired.addListener(
      onAuthRequired,
      { urls: ['<all_urls>'] },
      ['asyncBlocking']
    );
  } catch {
    // API surface incomplete (e.g. webRequestAuthProvider missing) — the
    // options page only ever requests the permissions together, so retrying
    // on the next grant is enough.
  }
}

/** After a revoke→re-grant the old registration may be dead; start fresh. */
function reregisterAuthListener(): void {
  try {
    chrome.webRequest?.onAuthRequired?.removeListener(onAuthRequired);
  } catch {
    // never registered
  }
  registerAuthListener();
}

/**
 * Incognito windows can follow their own profile (settings.incognitoProfileId,
 * '' = same as regular). Needs "Allow in Incognito" at chrome://extensions;
 * without it the regular settings span incognito as before.
 *
 * Relies on the manifest's default "incognito": spanning mode — the single
 * worker sees incognito auth challenges too. Switching to "split" would
 * silently break proxy auth for incognito windows.
 */
async function applyIncognito(config: Config): Promise<void> {
  try {
    const allowed = await chrome.extension.isAllowedIncognitoAccess();
    if (!allowed) return;
    const id = config.settings.incognitoProfileId;
    if (!id) {
      await chrome.proxy.settings.clear({ scope: 'incognito_persistent' });
      return;
    }
    const { value } = settingsValueFor({ ...config, activeId: id }, []);
    await chrome.proxy.settings.set({ value, scope: 'incognito_persistent' });
  } catch {
    // Incognito access revoked mid-flight or scope unsupported — regular
    // settings keep spanning incognito, which is the pre-feature behavior.
  }
}

/* ---------------- on-demand proxy test (options page "Test connection") ---------------- */

let testInFlight = false;
/** A config/temp-rule change arrived while a test held the proxy; re-apply after. */
let reapplyAfterTest = false;
/** Epoch ms until which proxy-error events are ignored (see runProxyTest). */
let suppressProxyErrorsUntil = 0;
/**
 * Set while a test proxy is applied. If the worker dies mid-test (crash, not
 * idle suspension — the in-flight fetch keeps it alive), the temporary proxy
 * would outlive it; the top-level wake check below restores from this marker.
 */
const TESTING_KEY = 'sockitt-testing';

/**
 * Briefly route ALL traffic through the profile under test (no bypass, so the
 * probe definitely traverses it), measure an exit-IP lookup, then restore the
 * real configuration via applyActive. Session-storage in/out because UI pages
 * never touch chrome.proxy directly.
 */
async function runProxyTest(req: {
  profileId: string;
  nonce: number;
  scheme?: ProxyScheme;
  host?: string;
  port?: number;
}): Promise<void> {
  if (testInFlight) {
    // Answer rather than silently drop — the options page disabled its button
    // and is waiting for a result.
    await chrome.storage.session
      .set({
        [TEST_RESULT_KEY]: {
          nonce: req.nonce,
          profileId: req.profileId,
          ok: false,
          error: 'another test is already running',
        },
      })
      .catch(() => undefined);
    return;
  }
  testInFlight = true;
  // Page traffic routed through the (possibly dead) test proxy will emit
  // proxy errors; suppress the error banner/badge for the window so a late
  // event can't paint a false failure over the restored config.
  suppressProxyErrorsUntil = Date.now() + 12_000;
  const result: Record<string, unknown> = { nonce: req.nonce, profileId: req.profileId, ok: false };
  try {
    const config = await loadConfig();
    // Master privacy switch: never contact ipconfig.is when the user has it off.
    if (!config.settings.exitIpCheck) throw new Error('IP lookups are turned off in Settings');
    const profile = profileById(config, req.profileId);
    if (!profile || profile.kind !== 'proxy') throw new Error('profile not found');
    // The request carries the editor's current (possibly unsaved) values so a
    // test needs no config save — which is what previously kicked off a racing
    // applyActive. While testInFlight is set, every applyActive is deferred
    // (see applyActiveGuarded), so nothing else touches the regular scope
    // during the probe; the finally restores the real route afterward.
    const scheme = req.scheme ?? profile.scheme;
    const host = req.host ?? profile.host;
    const port = req.port ?? profile.port;
    await chrome.storage.session.set({ [TESTING_KEY]: true });
    await chrome.proxy.settings.set({
      value: fixedServersValue(scheme, host, port, []),
      scope: 'regular',
    });
    const applied = await chrome.proxy.settings.get({});
    if (applied.levelOfControl === 'controlled_by_other_extensions') {
      throw new Error('another extension controls the proxy settings');
    }
    const info = await checkExitIp(8000);
    Object.assign(result, { ok: true, ...info });
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  } finally {
    // testInFlight stays true across the restore so a second test can't race
    // it; applyActive loads fresh config, so a change deferred during the test
    // is captured here. reapplyAfterTest covers a change that lands during the
    // restore itself. Keep suppressing errors briefly for in-flight requests.
    suppressProxyErrorsUntil = Date.now() + 3000;
    reapplyAfterTest = false;
    await applyActive().catch(() => undefined);
    await chrome.storage.session.remove(TESTING_KEY).catch(() => undefined);
    testInFlight = false;
    if (reapplyAfterTest) void applyActive();
  }
  try {
    await chrome.storage.session.set({ [TEST_RESULT_KEY]: result });
  } catch {
    // session storage unavailable — the options page just never hears back
  }
}

/** PAC return directive for a resolved route: the terminal proxy's, or DIRECT. */
function probeDirectiveFor(config: Config, route: { targetId: string; bypassed?: boolean }): string {
  if (route.bypassed || route.targetId === DIRECT) return 'DIRECT';
  const t = profileById(config, route.targetId);
  return t && t.kind === 'proxy' ? pacDirective(t.scheme, t.host, t.port) : 'DIRECT';
}

/**
 * Probe where the CURRENT TAB exits: send only the exit-IP lookup through the
 * tab's resolved proxy via a targeted PAC (every other host keeps its normal
 * route, so nothing the user is browsing is disturbed), measure it, then restore
 * the real config. Reuses runProxyTest's concurrency contract — one probe/test at
 * a time (testInFlight), proxy errors suppressed across the window, and the real
 * route restored in the finally even if the fetch throws.
 */
async function runTabExitProbe(req: { nonce: number; tabUrl: string; tabHost: string }): Promise<void> {
  const respond = (r: Record<string, unknown>) =>
    chrome.storage.session.set({ [TAB_EXIT_RESULT_KEY]: { nonce: req.nonce, ...r } }).catch(() => undefined);
  if (testInFlight) {
    // A test/probe holds the proxy; the popup retries 'busy' shortly.
    await respond({ ok: false, error: 'busy' });
    return;
  }
  testInFlight = true;
  suppressProxyErrorsUntil = Date.now() + 12_000;
  const result: Record<string, unknown> = { ok: false };
  try {
    const config = await loadConfig();
    // Master privacy switch: never contact ipconfig.is when the user has it off.
    if (!config.settings.exitIpCheck) throw new Error('IP lookups are turned off in Settings');
    const active = profileById(config, config.activeId);
    // DIRECT / System / no active profile can't be probed with a targeted PAC —
    // the popup handles those with a plain (passive) lookup and never asks here.
    if (!active) throw new Error('active profile does not route');
    const tempRules = await loadTempRules(config.activeId);
    const route = resolveRoute(config, active, pacRequestUrl(req.tabUrl), req.tabHost, tempRules);
    const directive = probeDirectiveFor(config, route);
    const exitHost = new URL(EXIT_IP_URL).hostname;
    await chrome.storage.session.set({ [TESTING_KEY]: true });
    await chrome.proxy.settings.set({
      value: {
        mode: 'pac_script',
        pacScript: { data: compilePac(config, active, tempRules, { host: exitHost, directive }), mandatory: true },
      },
      scope: 'regular',
    });
    const applied = await chrome.proxy.settings.get({});
    if (applied.levelOfControl === 'controlled_by_other_extensions') {
      throw new Error('another extension controls the proxy settings');
    }
    const info = await checkExitIp(8000);
    Object.assign(result, { ok: true, targetId: route.bypassed ? DIRECT : route.targetId, ...info });
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  } finally {
    // Restore the real route. Signal only when a genuine change landed during
    // the probe (pending) — the restore itself returns to the pre-probe route,
    // and signalling that would make the popup re-check → re-probe → restore →
    // signal in an endless loop. `pending` is false on the no-change (loop)
    // path, so that path stays silent; a real change still re-checks normally.
    suppressProxyErrorsUntil = Date.now() + 3000;
    const pending = reapplyAfterTest;
    reapplyAfterTest = false;
    await applyActive(pending).catch(() => undefined);
    await chrome.storage.session.remove(TESTING_KEY).catch(() => undefined);
    testInFlight = false;
    if (reapplyAfterTest) void applyActive();
  }
  await respond(result);
}

async function reloadActiveTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id !== undefined) await chrome.tabs.reload(tab.id);
  } catch {
    // no active tab or no permission — nothing to reload
  }
}

/* ---------------- toolbar icon ---------------- */

async function paintIcon(profile: Profile | null): Promise<void> {
  try {
    const imageData: Record<number, ImageData> = {};
    for (const size of [16, 32]) {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d')!;
      if (profile) {
        ctx.beginPath();
        ctx.roundRect(0, 0, size, size, size * 0.26);
        ctx.fillStyle = profile.color;
        ctx.fill();
        const initials = initialsFor(profile);
        ctx.fillStyle = textColorFor(profile.color);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const fontSize = Math.round(size * (initials.length > 2 ? 0.42 : 0.52));
        ctx.font = `700 ${fontSize}px system-ui, -apple-system, sans-serif`;
        ctx.fillText(initials, size / 2, size / 2 + size * 0.04, size * 0.9);
      } else {
        const mid = size / 2;
        const stroke = Math.max(1.5, size * 0.14);
        ctx.strokeStyle = NEUTRAL;
        ctx.lineWidth = stroke;
        ctx.beginPath();
        ctx.arc(mid, mid, mid - stroke / 2 - 0.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = NEUTRAL;
        ctx.beginPath();
        ctx.arc(mid, mid, size * 0.2, 0, Math.PI * 2);
        ctx.fill();
      }
      imageData[size] = ctx.getImageData(0, 0, size, size);
    }
    await chrome.action.setIcon({ imageData });
  } catch {
    await chrome.action.setBadgeBackgroundColor({ color: profile?.color ?? NEUTRAL });
  }
}

/* ---------------- quick switch ---------------- */

async function cycleProfile(): Promise<void> {
  const config = await loadConfig();
  let ids = config.settings.quickSwitchIds.filter(
    (id) => id === DIRECT || id === SYSTEM || profileById(config, id)
  );
  if (ids.length < 2) {
    ids = [DIRECT, SYSTEM, ...config.profiles.map((p) => p.id)];
  }
  const index = ids.indexOf(config.activeId);
  config.activeId = ids[(index + 1) % ids.length]!;
  await saveConfig(config); // storage change triggers applyActive
}

/* ---------------- rule list auto-update ---------------- */

async function scheduleRuleListUpdates(config: Config): Promise<void> {
  const wanted = new Map<string, number>(); // alarm name -> period minutes
  for (const p of config.profiles) {
    if (p.kind === 'rulelist' && p.url && p.updateIntervalH > 0) {
      wanted.set(ALARM_PREFIX + p.id, p.updateIntervalH * 60);
    }
  }
  const existing = await chrome.alarms.getAll();
  for (const alarm of existing) {
    if (!alarm.name.startsWith(ALARM_PREFIX)) continue;
    const period = wanted.get(alarm.name);
    if (period === undefined || alarm.periodInMinutes !== period) {
      await chrome.alarms.clear(alarm.name);
    } else {
      wanted.delete(alarm.name); // already scheduled correctly
    }
  }
  for (const [name, periodInMinutes] of wanted) {
    await chrome.alarms.create(name, { periodInMinutes, delayInMinutes: 1 });
  }
}

async function updateRuleList(profileId: string): Promise<void> {
  const config = await loadConfig();
  const profile = profileById(config, profileId);
  if (!profile || profile.kind !== 'rulelist' || !profile.url) return;
  try {
    const response = await fetch(profile.url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!text.trim()) throw new Error('empty response');
    profile.text = text;
    profile.lastUpdated = Date.now();
    // saveConfigRaw (no rev bump): an unattended fetch must not masquerade as a
    // user edit that syncs this device's activeId to the others.
    await saveConfigRaw(config);
  } catch {
    // Network failures keep the previous list; next alarm retries.
  }
}

/* ---------------- per-tab result badge (optional "tabs" permission) ---------------- */

/** Repaint the focused tab's badge after a profile/temp-rule change. */
async function refreshActiveTabBadge(config: Config): Promise<void> {
  if (!config.settings.badgeResult) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id !== undefined) await updateTabBadge(tab.id, config);
  } catch {
    // no active tab
  }
}

/**
 * Paint or CLEAR the per-tab route badge. Always resolves to one or the other
 * so a stale badge from a previous profile can't linger.
 */
async function updateTabBadge(tabId: number, config: Config | null = cachedConfig): Promise<void> {
  const cfg = config ?? (await loadConfig());
  const clear = () => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => undefined);

  if (!cfg.settings.badgeResult) return; // feature off — leave global badge alone
  const active = profileById(cfg, cfg.activeId);
  // Unconditional profile (proxy/alias/direct): the icon already says it.
  if (!active || staticTerminal(cfg, active) !== null) return void (await clear());
  try {
    if (!(await chrome.permissions.contains({ permissions: ['tabs'] }))) return;
    const errorStore = await chrome.storage.session.get(ERROR_KEY);
    if (errorStore[ERROR_KEY]) return; // leave the global error badge visible
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !/^https?:/i.test(tab.url)) return void (await clear());
    const tempRules = await loadTempRules(cfg.activeId);
    const host = new URL(tab.url).hostname;
    const route = resolveRoute(cfg, active, pacRequestUrl(tab.url), host, tempRules);
    const target = profileById(cfg, route.targetId);
    const text = target && !route.bypassed ? initialsFor(target) : 'DIR';
    await chrome.action.setBadgeBackgroundColor({ tabId, color: target?.color ?? NEUTRAL });
    await chrome.action.setBadgeText({ tabId, text });
  } catch {
    // tab gone or URL unavailable — nothing to paint
  }
}

/* ---------------- sync ---------------- */

async function maybePullSync(): Promise<void> {
  const config = await loadConfig();
  if (!config.settings.syncEnabled) return;
  const remote = await pullFromSync(config.rev);
  if (remote && remote.settings.syncEnabled) await applyFromSync(remote, config);
}

/* ---------------- wiring ---------------- */

// First synchronous turn: the auth listener must be registered here (not from
// an async path) or Chrome won't wake this worker for proxy 407 challenges.
registerAuthListener();

// If a previous worker instance died while a test proxy was applied, restore
// the real configuration now (the marker only survives a mid-test death).
void chrome.storage.session
  .get(TESTING_KEY)
  .then((s) => {
    if (s[TESTING_KEY]) {
      void chrome.storage.session.remove(TESTING_KEY);
      void applyActive();
    }
  })
  .catch(() => undefined);

// Re-apply the incognito scope on every worker start. Enabling "Allow in
// Incognito" reloads the extension but fires neither onInstalled nor
// onStartup, so this is the only path that picks up a freshly granted access
// (or a config set while access was off). Cheap and idempotent — it touches
// only the incognito scope, gated on isAllowedIncognitoAccess.
void loadConfig().then(applyIncognito).catch(() => undefined);

// Pull BEFORE applying/pushing so a stale device can't overwrite newer remote
// data on wake-up. applyActive's own pushToSync is a no-op right after a pull
// (rev already matches), so no echo.
chrome.runtime.onInstalled.addListener(() => {
  void maybePullSync().then(() => applyActive());
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await maybePullSync();
    const config = await loadConfig();
    const startup = config.settings.startupProfileId;
    const valid =
      startup && (startup === DIRECT || startup === SYSTEM || profileById(config, startup));
    if (valid && config.activeId !== startup) {
      config.activeId = startup;
      await saveConfig(config); // triggers applyActive via onConfigChanged
    } else {
      await applyActive();
    }
  })();
});

onConfigChanged((config) => {
  cachedConfig = config;
  applyActiveGuarded();
});
onTempRulesChanged(() => applyActiveGuarded());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes[TEST_KEY]) return;
  const req = changes[TEST_KEY].newValue as
    | { profileId?: unknown; nonce?: unknown; scheme?: unknown; host?: unknown; port?: unknown }
    | undefined;
  if (req && typeof req.profileId === 'string' && typeof req.nonce === 'number') {
    void runProxyTest({
      profileId: req.profileId,
      nonce: req.nonce,
      scheme: typeof req.scheme === 'string' ? (req.scheme as ProxyScheme) : undefined,
      host: typeof req.host === 'string' ? req.host : undefined,
      port: typeof req.port === 'number' ? req.port : undefined,
    });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes[TAB_EXIT_KEY]) return;
  const req = changes[TAB_EXIT_KEY].newValue as
    | { nonce?: unknown; tabUrl?: unknown; tabHost?: unknown }
    | undefined;
  if (req && typeof req.nonce === 'number' && typeof req.tabUrl === 'string' && typeof req.tabHost === 'string') {
    void runTabExitProbe({ nonce: req.nonce, tabUrl: req.tabUrl, tabHost: req.tabHost });
  }
});

onSyncChanged(() => void maybePullSync());

chrome.permissions.onAdded.addListener((added) => {
  // Only auth-related grants warrant touching the listener — reregistering on
  // an unrelated grant (e.g. "tabs") would trade a wake-eligible first-turn
  // registration for an async one until the next worker restart.
  if (added.permissions?.some((p) => p === 'webRequest' || p === 'webRequestAuthProvider')) {
    reregisterAuthListener();
  }
});

chrome.action.onClicked.addListener(() => void cycleProfile());

chrome.commands.onCommand.addListener((command) => {
  if (command === 'cycle-profile') void cycleProfile();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(ALARM_PREFIX)) {
    void updateRuleList(alarm.name.slice(ALARM_PREFIX.length));
  }
});

chrome.proxy.settings.onChange.addListener((details) => {
  if (details.levelOfControl !== 'controlled_by_other_extensions') return;
  void (async () => {
    const config = await loadConfig();
    if (!config.settings.revertExternal) return;
    const now = Date.now();
    if (now - lastRevert < REVERT_COOLDOWN_MS) return;
    lastRevert = now;
    await applyActive();
  })();
});

chrome.tabs.onActivated.addListener((info) => void updateTabBadge(info.tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Repaint on cross-page navigation (changeInfo.url) AND on load status — a
  // same-URL hard refresh reports no url change, but Chrome clears the per-tab
  // badge on the navigation commit, so we must redraw it as the page reloads.
  if (changeInfo.url || changeInfo.status) void updateTabBadge(tabId);
});

// activeTab is granted only after the user interacts with the action; the
// badge/reload paths degrade gracefully when it isn't.

chrome.proxy.onProxyError.addListener((details) => {
  // Ignore errors that a connection test provoked by routing page traffic
  // through the candidate proxy — otherwise a late event paints a false
  // failure over the already-restored working configuration.
  if (testInFlight || Date.now() < suppressProxyErrorsUntil) return;
  void (async () => {
    await chrome.storage.session.set({
      [ERROR_KEY]: {
        message: details.details || details.error,
        at: Date.now(),
        fatal: details.fatal,
      },
    });
    if (details.fatal) {
      await chrome.action.setBadgeBackgroundColor({ color: '#f5576c' });
      await chrome.action.setBadgeText({ text: '!' });
    }
  })();
});
