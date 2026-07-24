import { Config, DIRECT, PALETTE, Profile, SwitchRule, uid } from './types';

const KEY = 'sockitt';

export function defaultConfig(): Config {
  return { version: 1, activeId: SYSTEM_DEFAULT, profiles: [] };
}

const SYSTEM_DEFAULT = 'system';

export async function loadConfig(): Promise<Config> {
  const stored = await chrome.storage.local.get(KEY);
  const raw = stored[KEY];
  const config = sanitizeConfig(raw);
  return config ?? defaultConfig();
}

export async function saveConfig(config: Config): Promise<void> {
  await chrome.storage.local.set({ [KEY]: config });
}

export function onConfigChanged(fn: (config: Config) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    const config = sanitizeConfig(changes[KEY].newValue);
    if (config) fn(config);
  });
}

/**
 * Validate untrusted config data (storage or an imported JSON file) into a
 * well-formed Config, or null if it is beyond repair. Unknown fields drop,
 * broken references fall back to direct.
 */
export function sanitizeConfig(raw: unknown): Config | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.profiles)) return null;

  const profiles: Profile[] = [];
  for (const item of o.profiles) {
    const p = sanitizeProfile(item);
    if (p) profiles.push(p);
  }
  const ids = new Set(profiles.map((p) => p.id));

  const validTarget = (t: unknown): string =>
    typeof t === 'string' && (t === DIRECT || ids.has(t)) ? t : DIRECT;

  for (const p of profiles) {
    if (p.kind !== 'switch') continue;
    p.defaultTargetId = validTarget(p.defaultTargetId);
    for (const r of p.rules) r.targetId = validTarget(r.targetId);
  }

  let activeId = typeof o.activeId === 'string' ? o.activeId : SYSTEM_DEFAULT;
  if (activeId !== DIRECT && activeId !== SYSTEM_DEFAULT && !ids.has(activeId)) {
    activeId = SYSTEM_DEFAULT;
  }
  return { version: 1, activeId, profiles };
}

function sanitizeProfile(raw: unknown): Profile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' && o.id ? o.id : uid();
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : 'Unnamed';
  const color =
    typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : PALETTE[0];

  if (o.kind === 'proxy') {
    const port = Number(o.port);
    return {
      kind: 'proxy',
      id,
      name,
      color,
      host: typeof o.host === 'string' ? o.host.trim() : '',
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 1080,
      bypass: Array.isArray(o.bypass) ? o.bypass.filter((b): b is string => typeof b === 'string') : [],
    };
  }
  if (o.kind === 'switch') {
    const rules: SwitchRule[] = [];
    if (Array.isArray(o.rules)) {
      for (const r of o.rules) {
        if (typeof r !== 'object' || r === null) continue;
        const rr = r as Record<string, unknown>;
        const type = rr.type;
        if (
          type !== 'hostWildcard' && type !== 'hostRegex' &&
          type !== 'urlWildcard' && type !== 'urlRegex' && type !== 'ipCidr'
        ) continue;
        rules.push({
          id: typeof rr.id === 'string' && rr.id ? rr.id : uid(),
          enabled: rr.enabled !== false,
          type,
          pattern: typeof rr.pattern === 'string' ? rr.pattern : '',
          targetId: typeof rr.targetId === 'string' ? rr.targetId : DIRECT,
        });
      }
    }
    return {
      kind: 'switch',
      id,
      name,
      color,
      rules,
      defaultTargetId: typeof o.defaultTargetId === 'string' ? o.defaultTargetId : DIRECT,
    };
  }
  return null;
}

export function newProxyProfile(existing: Profile[]): Profile {
  return {
    kind: 'proxy',
    id: uid(),
    name: nextName(existing, 'Proxy'),
    color: PALETTE[existing.length % PALETTE.length]!,
    host: '127.0.0.1',
    port: 1080,
    bypass: ['<local>'],
  };
}

export function newSwitchProfile(existing: Profile[]): Profile {
  return {
    kind: 'switch',
    id: uid(),
    name: nextName(existing, 'Auto Switch'),
    color: PALETTE[(existing.length + 1) % PALETTE.length]!,
    rules: [],
    defaultTargetId: DIRECT,
  };
}

function nextName(existing: Profile[], base: string): string {
  const names = new Set(existing.map((p) => p.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) {
    if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  }
}
