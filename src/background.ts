import { initialsFor, textColorFor } from './shared/avatar';
import { pacRequestUrl, resolveRoute } from './shared/match';
import { compilePac, fixedServersValue, staticTerminal } from './shared/pac';
import {
  loadConfig,
  loadTempRules,
  onConfigChanged,
  onTempRulesChanged,
  saveConfig,
  saveConfigRaw,
} from './shared/state';
import { applyFromSync, onSyncChanged, pullFromSync, pushToSync } from './shared/sync';
import {
  Config,
  DIRECT,
  Profile,
  SYSTEM,
  SwitchRule,
  profileById,
  proxyProfiles,
  schemeSupportsAuth,
} from './shared/types';

const ERROR_KEY = 'sockitt-error';
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

async function applyActive(): Promise<void> {
  const config = await loadConfig();
  cachedConfig = config;
  const tempRules = await loadTempRules(config.activeId);
  const { value, label, profile } = settingsValueFor(config, tempRules);

  await chrome.proxy.settings.set({ value, scope: 'regular' });

  // Independent action/session updates — no ordering dependency between them.
  await Promise.all([
    chrome.storage.session.remove(ERROR_KEY),
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

// Pull BEFORE applying/pushing so a stale device can't overwrite newer remote
// data on wake-up. applyActive's own pushToSync is a no-op right after a pull
// (rev already matches), so no echo.
chrome.runtime.onInstalled.addListener(() => {
  void maybePullSync().then(applyActive);
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
  void applyActive();
});
onTempRulesChanged(() => void applyActive());

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
  if (changeInfo.url) void updateTabBadge(tabId);
});

// activeTab is granted only after the user interacts with the action; the
// badge/reload paths degrade gracefully when it isn't.

chrome.proxy.onProxyError.addListener((details) => {
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
