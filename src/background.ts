import { initialsFor, textColorFor } from './shared/avatar';
import { resolveRoute } from './shared/match';
import { compilePac, fixedServersValue, staticTerminal } from './shared/pac';
import {
  loadConfig,
  loadTempRules,
  onConfigChanged,
  onTempRulesChanged,
  saveConfig,
} from './shared/state';
import { applyFromSync, onSyncChanged, pullFromSync, pushToSync } from './shared/sync';
import { Config, DIRECT, Profile, SYSTEM, SwitchRule, profileById } from './shared/types';

const ERROR_KEY = 'sockitt-error';
const NEUTRAL = '#8b93a7';
const REVERT_COOLDOWN_MS = 30_000;
const ALARM_PREFIX = 'rl:';

let lastRevert = 0;

/* ---------------- proxy application ---------------- */

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
  if (terminal) {
    return {
      value: fixedServersValue(terminal.host, terminal.port, terminal.bypass),
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
  const tempRules = await loadTempRules(config.activeId);
  const { value, label, profile } = settingsValueFor(config, tempRules);

  await chrome.proxy.settings.set({ value, scope: 'regular' });
  await chrome.storage.session.remove(ERROR_KEY);
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: `Sockitt — ${label}` });
  await paintIcon(profile);
  await chrome.action.setPopup({ popup: config.settings.quickSwitch ? '' : 'popup.html' });

  const current = await chrome.proxy.settings.get({});
  if (current.levelOfControl === 'controlled_by_other_extensions') {
    await chrome.action.setBadgeBackgroundColor({ color: '#f5576c' });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setTitle({
      title: `Sockitt — ${label} (another extension is controlling the proxy)`,
    });
  }

  await scheduleRuleListUpdates(config);
  if (config.settings.syncEnabled) await pushToSync(config);
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
    await saveConfig(config);
  } catch {
    // Network failures keep the previous list; next alarm retries.
  }
}

/* ---------------- per-tab result badge (optional "tabs" permission) ---------------- */

async function updateTabBadge(tabId: number): Promise<void> {
  const config = await loadConfig();
  if (!config.settings.badgeResult) return;
  const active = profileById(config, config.activeId);
  if (!active || staticTerminal(config, active) !== null) return; // unconditional — the icon already says it
  try {
    const granted = await chrome.permissions.contains({ permissions: ['tabs'] });
    if (!granted) return;
    const errorStore = await chrome.storage.session.get(ERROR_KEY);
    if (errorStore[ERROR_KEY]) return; // don't paint over the error badge
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !/^https?:/i.test(tab.url)) {
      await chrome.action.setBadgeText({ tabId, text: '' });
      return;
    }
    const tempRules = await loadTempRules(config.activeId);
    const host = new URL(tab.url).hostname;
    const route = resolveRoute(config, active, tab.url, host, tempRules);
    const target = profileById(config, route.targetId);
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
  if (remote && remote.settings.syncEnabled) await applyFromSync(remote);
}

/* ---------------- wiring ---------------- */

chrome.runtime.onInstalled.addListener(() => {
  void applyActive().then(maybePullSync);
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
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
    await maybePullSync();
  })();
});

onConfigChanged(() => void applyActive());
onTempRulesChanged(() => void applyActive());

onSyncChanged(() => void maybePullSync());

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
