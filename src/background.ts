import { initialsFor, textColorFor } from './shared/avatar';
import { compilePac, fixedServersValue } from './shared/pac';
import { loadConfig, onConfigChanged } from './shared/state';
import { Config, DIRECT, Profile, SYSTEM, profileById } from './shared/types';

const ERROR_KEY = 'sockitt-error';
const NEUTRAL = '#8b93a7';

/** null profile = a built-in mode; the icon falls back to the neutral mark. */
function settingsValueFor(config: Config): {
  value: chrome.proxy.ProxyConfig;
  label: string;
  profile: Profile | null;
} {
  const { activeId } = config;
  if (activeId === DIRECT) {
    return { value: { mode: 'direct' }, label: 'Direct', profile: null };
  }
  if (activeId === SYSTEM) {
    return { value: { mode: 'system' }, label: 'System', profile: null };
  }
  const profile = profileById(config, activeId);
  if (!profile) {
    return { value: { mode: 'system' }, label: 'System', profile: null };
  }
  if (profile.kind === 'proxy') {
    return {
      value: fixedServersValue(profile.host, profile.port, profile.bypass),
      label: profile.name,
      profile,
    };
  }
  return {
    value: {
      mode: 'pac_script',
      pacScript: { data: compilePac(config, profile), mandatory: true },
    },
    label: profile.name,
    profile,
  };
}

async function applyActive(): Promise<void> {
  const config = await loadConfig();
  const { value, label, profile } = settingsValueFor(config);
  await chrome.proxy.settings.set({ value, scope: 'regular' });
  await chrome.storage.session.remove(ERROR_KEY);
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: `Sockitt — ${label}` });
  await paintIcon(profile);

  const current = await chrome.proxy.settings.get({});
  if (current.levelOfControl === 'controlled_by_other_extensions') {
    await chrome.action.setBadgeBackgroundColor({ color: '#f5576c' });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setTitle({
      title: `Sockitt — ${label} (another extension is controlling the proxy)`,
    });
  }
}

/**
 * Toolbar icon: for a profile, its initials avatar (coloured rounded tile,
 * matching the popup/options avatars); for built-in modes, the neutral
 * ring-and-dot brand mark.
 */
async function paintIcon(profile: Profile | null): Promise<void> {
  try {
    const imageData: Record<number, ImageData> = {};
    for (const size of [16, 32]) {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d')!;
      if (profile) {
        const radius = size * 0.26;
        ctx.beginPath();
        ctx.roundRect(0, 0, size, size, radius);
        ctx.fillStyle = profile.color;
        ctx.fill();
        const initials = initialsFor(profile);
        ctx.fillStyle = textColorFor(profile.color);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const fontSize = Math.round((size * (initials.length > 2 ? 0.42 : 0.52)) / 1);
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
    // Rasterization unavailable — static manifest icon stays; still signal color.
    await chrome.action.setBadgeBackgroundColor({ color: profile?.color ?? NEUTRAL });
  }
}

chrome.runtime.onInstalled.addListener(() => void applyActive());
chrome.runtime.onStartup.addListener(() => void applyActive());
onConfigChanged(() => void applyActive());

chrome.proxy.onProxyError.addListener((details) => {
  void (async () => {
    await chrome.storage.session.set({
      [ERROR_KEY]: { message: details.details || details.error, at: Date.now(), fatal: details.fatal },
    });
    if (details.fatal) {
      await chrome.action.setBadgeBackgroundColor({ color: '#f5576c' });
      await chrome.action.setBadgeText({ text: '!' });
    }
  })();
});
