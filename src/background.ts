import { compilePac, fixedServersValue } from './shared/pac';
import { loadConfig, onConfigChanged } from './shared/state';
import { Config, DIRECT, SYSTEM, profileById } from './shared/types';

const ERROR_KEY = 'sockitt-error';
const NEUTRAL = '#8b93a7';

function settingsValueFor(config: Config): {
  value: chrome.proxy.ProxyConfig;
  label: string;
  color: string;
} {
  const { activeId } = config;
  if (activeId === DIRECT) {
    return { value: { mode: 'direct' }, label: 'Direct', color: NEUTRAL };
  }
  if (activeId === SYSTEM) {
    return { value: { mode: 'system' }, label: 'System', color: NEUTRAL };
  }
  const profile = profileById(config, activeId);
  if (!profile) {
    return { value: { mode: 'system' }, label: 'System', color: NEUTRAL };
  }
  if (profile.kind === 'proxy') {
    return {
      value: fixedServersValue(profile.host, profile.port, profile.bypass),
      label: profile.name,
      color: profile.color,
    };
  }
  return {
    value: {
      mode: 'pac_script',
      pacScript: { data: compilePac(config, profile), mandatory: true },
    },
    label: profile.name,
    color: profile.color,
  };
}

async function applyActive(): Promise<void> {
  const config = await loadConfig();
  const { value, label, color } = settingsValueFor(config);
  await chrome.proxy.settings.set({ value, scope: 'regular' });
  await chrome.storage.session.remove(ERROR_KEY);
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: `Sockitt — ${label}` });
  await paintIcon(color);

  const current = await chrome.proxy.settings.get({});
  if (current.levelOfControl === 'controlled_by_other_extensions') {
    await chrome.action.setBadgeBackgroundColor({ color: '#f5576c' });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setTitle({
      title: `Sockitt — ${label} (another extension is controlling the proxy)`,
    });
  }
}

async function paintIcon(color: string): Promise<void> {
  try {
    const imageData: Record<number, ImageData> = {};
    for (const size of [16, 32]) {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d')!;
      const mid = size / 2;
      const stroke = Math.max(1.5, size * 0.14);
      ctx.strokeStyle = color;
      ctx.lineWidth = stroke;
      ctx.beginPath();
      ctx.arc(mid, mid, mid - stroke / 2 - 0.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(mid, mid, size * 0.2, 0, Math.PI * 2);
      ctx.fill();
      imageData[size] = ctx.getImageData(0, 0, size, size);
    }
    await chrome.action.setIcon({ imageData });
  } catch {
    // Rasterization unavailable — static manifest icon stays; still signal color.
    await chrome.action.setBadgeBackgroundColor({ color });
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
