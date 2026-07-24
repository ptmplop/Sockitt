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
  await syncAuthHandler();
  await refreshActiveTabBadge(config);
  await scheduleRuleListUpdates(config);
  if (config.settings.syncEnabled) await pushToSync(config);
}

/* ---------------- proxy authentication (http/https, optional perms) ---------------- */

const AUTH_PERMS: chrome.permissions.Permissions = {
  permissions: ['webRequest', 'webRequestAuthProvider'],
  origins: ['<all_urls>'],
};
const credByEndpoint = new Map<string, { username: string; password: string }>();
let authListenerAdded = false;

/** Endpoint→credentials for every http/https proxy that has a username. */
function rebuildCredentials(config: Config): void {
  credByEndpoint.clear();
  for (const p of proxyProfiles(config)) {
    if (schemeSupportsAuth(p.scheme) && p.username) {
      credByEndpoint.set(`${p.host}:${p.port}`, { username: p.username, password: p.password ?? '' });
    }
  }
}

/** Synchronous: MV3 blocking onAuthRequired can't await, so look up in memory. */
function onAuthRequired(
  details: chrome.webRequest.OnAuthRequiredDetails
): chrome.webRequest.BlockingResponse {
  if (!details.isProxy || !details.challenger) return {};
  const cred = credByEndpoint.get(`${details.challenger.host}:${details.challenger.port}`);
  return cred ? { authCredentials: cred } : {};
}

/**
 * Register the proxy-auth handler once, only when credentials exist and the
 * optional webRequest/webRequestAuthProvider/host permissions have been
 * granted (the options page requests them when a user saves credentials).
 */
async function syncAuthHandler(): Promise<void> {
  if (authListenerAdded || credByEndpoint.size === 0) return;
  const granted = await chrome.permissions.contains(AUTH_PERMS).catch(() => false);
  if (!granted || !chrome.webRequest?.onAuthRequired) return;
  try {
    chrome.webRequest.onAuthRequired.addListener(onAuthRequired, { urls: ['<all_urls>'] }, ['blocking']);
    authListenerAdded = true;
  } catch {
    // APIs unavailable despite the permission check — leave unregistered
  }
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

chrome.permissions.onAdded.addListener(() => void syncAuthHandler());

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
