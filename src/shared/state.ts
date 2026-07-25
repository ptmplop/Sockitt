import {
  CONFIG_VERSION,
  Config,
  DIRECT,
  PALETTE,
  Profile,
  ProxyScheme,
  RuleType,
  Settings,
  SwitchRule,
  SYSTEM,
  defaultSettings,
  schemeSupportsAuth,
  uid,
} from './types';

const KEY = 'sockitt';
const TEMP_KEY = 'sockitt-temp';

/* Session-storage channels shared between the worker and the UI pages. */
/** Last proxy error, set by the worker, shown by the popup. */
export const ERROR_KEY = 'sockitt-error';
/** Written by the worker after each proxy application (popup exit-IP re-check). */
export const APPLIED_KEY = 'sockitt-applied';
/** Proxy-test request (options page → worker). */
export const TEST_KEY = 'sockitt-test';
/** Proxy-test response (worker → options page). */
export const TEST_RESULT_KEY = 'sockitt-test-result';
/** Set by the popup when a this-tab override/rule change should reload the tab
 *  once the worker has applied the new route (consumed by applyActive). */
export const RELOAD_KEY = 'sockitt-reload';

// Compiler-enforced: adding a RuleType without listing it here fails to build,
// rather than silently dropping rules of the new type on load/import/sync.
const RULE_TYPE_SET: Record<RuleType, true> = {
  hostWildcard: true,
  hostRegex: true,
  urlWildcard: true,
  urlRegex: true,
  ipCidr: true,
  keyword: true,
  hostLevels: true,
  weekday: true,
  time: true,
};
function isRuleType(t: unknown): t is RuleType {
  // Object.hasOwn, not `in`: `in` walks the prototype chain, so "toString",
  // "constructor", "__proto__" etc. would validate as rule types, survive
  // sanitization, and make compileRule return undefined — which throws in
  // compilePac/resolveRoute and silently leaves the proxy unapplied.
  return typeof t === 'string' && Object.hasOwn(RULE_TYPE_SET, t);
}

/**
 * A proxy host is embedded into a PAC directive ("SOCKS5 host:port") and a
 * fixed_servers rule. Strip anything that could break out of that directive: a
 * ';' would splice an extra proxy into the fallback chain, and whitespace or a
 * slash is never valid in a bare host. Everything from the first offending
 * character on is dropped. An empty result is surfaced at apply time, not here.
 */
export function sanitizeHost(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().split(/[\s;/\\]/)[0] ?? '';
}

/** UI-side validator for the proxy Host field. Returns an error or null. */
export function proxyHostError(host: string): string | null {
  const h = host.trim();
  if (!h) return 'Host is required';
  if (h !== sanitizeHost(h)) return 'Host cannot contain spaces, ";" or "/"';
  return null;
}

// Same compiler-enforced pattern for schemes: a new ProxyScheme fails to build
// here, rather than being silently rewritten to socks5 on load/import/sync.
const SCHEME_SET: Record<ProxyScheme, true> = {
  socks5: true,
  socks4: true,
  http: true,
  https: true,
};
function isScheme(s: unknown): s is ProxyScheme {
  return typeof s === 'string' && Object.hasOwn(SCHEME_SET, s);
}

export function defaultConfig(): Config {
  return {
    version: CONFIG_VERSION,
    rev: 0,
    activeId: SYSTEM,
    profiles: [],
    settings: defaultSettings(),
  };
}

export async function loadConfig(): Promise<Config> {
  const stored = await chrome.storage.local.get(KEY);
  return sanitizeConfig(stored[KEY]) ?? defaultConfig();
}

/** Save from a UI surface: bumps the sync revision. */
export async function saveConfig(config: Config): Promise<void> {
  config.rev = Math.max(Date.now(), config.rev + 1);
  await chrome.storage.local.set({ [KEY]: config });
}

/** Save without bumping rev — used when applying a config pulled from sync. */
export async function saveConfigRaw(config: Config): Promise<void> {
  await chrome.storage.local.set({ [KEY]: config });
}

export function onConfigChanged(fn: (config: Config) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    const config = sanitizeConfig(changes[KEY].newValue);
    if (config) fn(config);
  });
}

/* ---------- temp rules (session-scoped: gone on browser restart) ---------- */

type TempRuleMap = Record<string, SwitchRule[]>;

export async function loadTempRules(profileId: string): Promise<SwitchRule[]> {
  try {
    const stored = await chrome.storage.session.get(TEMP_KEY);
    const map = stored[TEMP_KEY] as TempRuleMap | undefined;
    return map?.[profileId]?.filter(isValidRule) ?? [];
  } catch {
    return [];
  }
}

export async function saveTempRules(profileId: string, rules: SwitchRule[]): Promise<void> {
  const stored = await chrome.storage.session.get(TEMP_KEY);
  const map = (stored[TEMP_KEY] as TempRuleMap | undefined) ?? {};
  if (rules.length) map[profileId] = rules;
  else delete map[profileId];
  await chrome.storage.session.set({ [TEMP_KEY]: map });
}

export function onTempRulesChanged(fn: () => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[TEMP_KEY]) fn();
  });
}

/* ---------- sanitising ---------- */

/**
 * Validate untrusted config data (storage, sync, or an imported JSON file)
 * into a well-formed Config, or null if it is beyond repair. Handles v1
 * configs (no settings/rev/new kinds). Unknown fields drop, broken
 * references fall back to direct.
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
    switch (p.kind) {
      case 'switch':
        p.defaultTargetId = validTarget(p.defaultTargetId);
        for (const r of p.rules) r.targetId = validTarget(r.targetId);
        break;
      case 'virtual':
        p.targetId = validTarget(p.targetId);
        break;
      case 'rulelist':
        p.matchTargetId = validTarget(p.matchTargetId);
        p.defaultTargetId = validTarget(p.defaultTargetId);
        break;
      case 'proxy':
        break;
    }
  }

  let activeId = typeof o.activeId === 'string' ? o.activeId : SYSTEM;
  if (activeId !== DIRECT && activeId !== SYSTEM && !ids.has(activeId)) {
    activeId = SYSTEM;
  }

  return {
    version: CONFIG_VERSION,
    rev: typeof o.rev === 'number' && Number.isFinite(o.rev) ? o.rev : 0,
    activeId,
    profiles,
    settings: sanitizeSettings(o.settings, ids),
  };
}

function sanitizeSettings(raw: unknown, ids: Set<string>): Settings {
  const d = defaultSettings();
  if (typeof raw !== 'object' || raw === null) return d;
  const o = raw as Record<string, unknown>;
  const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === 'boolean' ? v : fallback;
  const startup = typeof o.startupProfileId === 'string' ? o.startupProfileId : '';
  const incognito = typeof o.incognitoProfileId === 'string' ? o.incognitoProfileId : '';
  return {
    quickSwitch: bool(o.quickSwitch, d.quickSwitch),
    quickSwitchIds: Array.isArray(o.quickSwitchIds)
      ? o.quickSwitchIds.filter(
          (v): v is string =>
            typeof v === 'string' && (v === DIRECT || v === SYSTEM || ids.has(v))
        )
      : [],
    syncEnabled: bool(o.syncEnabled, d.syncEnabled),
    startupProfileId:
      startup === '' || startup === DIRECT || startup === SYSTEM || ids.has(startup)
        ? startup
        : '',
    revertExternal: bool(o.revertExternal, d.revertExternal),
    confirmDeletion: bool(o.confirmDeletion, d.confirmDeletion),
    addToBottom: bool(o.addToBottom, d.addToBottom),
    refreshOnSwitch: bool(o.refreshOnSwitch, d.refreshOnSwitch),
    badgeResult: bool(o.badgeResult, d.badgeResult),
    exitIpCheck: bool(o.exitIpCheck, d.exitIpCheck),
    incognitoProfileId:
      incognito === '' || incognito === DIRECT || incognito === SYSTEM || ids.has(incognito)
        ? incognito
        : '',
  };
}

function isValidRule(r: unknown): r is SwitchRule {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.pattern === 'string' &&
    typeof o.targetId === 'string' &&
    isRuleType(o.type)
  );
}

function sanitizeProfile(raw: unknown): Profile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' && o.id ? o.id : uid();
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : 'Unnamed';
  const color =
    typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : PALETTE[0];
  const initials =
    typeof o.initials === 'string' && o.initials.trim() ? o.initials.trim().slice(0, 3) : undefined;
  const base = { id, name, initials, color };

  switch (o.kind) {
    case 'proxy': {
      const port = Number(o.port);
      const scheme: ProxyScheme = isScheme(o.scheme) ? o.scheme : 'socks5';
      const username = typeof o.username === 'string' && o.username ? o.username : undefined;
      const password = typeof o.password === 'string' && o.password ? o.password : undefined;
      return {
        kind: 'proxy',
        ...base,
        scheme,
        host: sanitizeHost(o.host),
        port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 1080,
        // Credentials only apply to http/https; drop them otherwise.
        username: schemeSupportsAuth(scheme) ? username : undefined,
        password: schemeSupportsAuth(scheme) ? password : undefined,
        bypass: Array.isArray(o.bypass)
          ? o.bypass.filter((b): b is string => typeof b === 'string')
          : [],
      };
    }
    case 'switch': {
      const rules: SwitchRule[] = [];
      if (Array.isArray(o.rules)) {
        for (const r of o.rules) {
          if (typeof r !== 'object' || r === null) continue;
          const rr = r as Record<string, unknown>;
          if (!isRuleType(rr.type)) continue;
          rules.push({
            id: typeof rr.id === 'string' && rr.id ? rr.id : uid(),
            enabled: rr.enabled !== false,
            type: rr.type,
            pattern: typeof rr.pattern === 'string' ? rr.pattern : '',
            targetId: typeof rr.targetId === 'string' ? rr.targetId : DIRECT,
          });
        }
      }
      return {
        kind: 'switch',
        ...base,
        rules,
        defaultTargetId: typeof o.defaultTargetId === 'string' ? o.defaultTargetId : DIRECT,
      };
    }
    case 'virtual':
      return {
        kind: 'virtual',
        ...base,
        targetId: typeof o.targetId === 'string' ? o.targetId : DIRECT,
      };
    case 'rulelist': {
      const interval = Number(o.updateIntervalH);
      return {
        kind: 'rulelist',
        ...base,
        format: o.format === 'switchy' ? 'switchy' : 'autoproxy',
        url: typeof o.url === 'string' ? o.url.trim() : '',
        updateIntervalH:
          Number.isFinite(interval) && interval >= 0 && interval <= 720 ? interval : 24,
        matchTargetId: typeof o.matchTargetId === 'string' ? o.matchTargetId : DIRECT,
        defaultTargetId: typeof o.defaultTargetId === 'string' ? o.defaultTargetId : DIRECT,
        text: typeof o.text === 'string' ? o.text : '',
        lastUpdated: typeof o.lastUpdated === 'number' ? o.lastUpdated : undefined,
      };
    }
    default:
      return null;
  }
}

/* ---------- factories ---------- */

function nextName(existing: Profile[], base: string): string {
  const names = new Set(existing.map((p) => p.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) {
    if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  }
}

function nextColor(existing: Profile[]): string {
  return PALETTE[existing.length % PALETTE.length]!;
}

export function newProxyProfile(existing: Profile[]): Profile {
  return {
    kind: 'proxy',
    id: uid(),
    name: nextName(existing, 'Proxy'),
    color: nextColor(existing),
    scheme: 'socks5',
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
    color: nextColor(existing),
    rules: [],
    defaultTargetId: DIRECT,
  };
}

export function newVirtualProfile(existing: Profile[]): Profile {
  return {
    kind: 'virtual',
    id: uid(),
    name: nextName(existing, 'Alias'),
    color: nextColor(existing),
    targetId: DIRECT,
  };
}

export function newRuleListProfile(existing: Profile[]): Profile {
  return {
    kind: 'rulelist',
    id: uid(),
    name: nextName(existing, 'Rule List'),
    color: nextColor(existing),
    format: 'autoproxy',
    url: '',
    updateIntervalH: 24,
    matchTargetId: existing.find((p) => p.kind === 'proxy')?.id ?? DIRECT,
    defaultTargetId: DIRECT,
    text: '',
  };
}
