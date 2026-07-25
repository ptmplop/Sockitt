/** Reserved target/profile ids for the two built-in modes. */
export const DIRECT = 'direct';
export const SYSTEM = 'system';

/** A routing destination: a profile id, or the built-in 'direct'. */
export type TargetId = string;

export type RuleType =
  | 'hostWildcard'
  | 'hostRegex'
  | 'urlWildcard'
  | 'urlRegex'
  | 'ipCidr'
  | 'keyword'
  | 'hostLevels'
  | 'weekday'
  | 'time';

export interface SwitchRule {
  id: string;
  enabled: boolean;
  type: RuleType;
  pattern: string;
  targetId: TargetId;
}

interface ProfileBase {
  id: string;
  name: string;
  /** Custom avatar initials (1–3 chars); derived from name when unset. */
  initials?: string;
  color: string;
}

/** Proxy protocols Chromium can route through. */
export type ProxyScheme = 'socks5' | 'socks4' | 'http' | 'https';

export interface ProxyProfile extends ProfileBase {
  kind: 'proxy';
  scheme: ProxyScheme;
  host: string;
  port: number;
  /**
   * Optional proxy credentials. Only meaningful for http/https proxies —
   * Chromium cannot authenticate SOCKS proxies. Supplied at runtime via
   * chrome.webRequest.onAuthRequired (needs the optional webRequest +
   * webRequestAuthProvider + host permissions).
   */
  username?: string;
  password?: string;
  /**
   * Hosts reached directly even when this profile is active.
   * Supports: <local>, exact hosts, *.suffix wildcards, IPv4 CIDR.
   */
  bypass: string[];
}

/** true for schemes Chromium can authenticate with a username/password. */
export function schemeSupportsAuth(scheme: ProxyScheme): boolean {
  return scheme === 'http' || scheme === 'https';
}

/**
 * Optional permissions needed to answer proxy auth challenges. Single source
 * of truth: the options page requests exactly what the background registers
 * against — a divergent copy would make the grant stop satisfying the check.
 */
export const AUTH_PERMS: chrome.permissions.Permissions = {
  permissions: ['webRequest', 'webRequestAuthProvider'],
  origins: ['<all_urls>'],
};

/** true when the profile carries credentials the auth handler would serve. */
export function hasCredentials(p: ProxyProfile): boolean {
  return schemeSupportsAuth(p.scheme) && Boolean(p.username || p.password);
}

export const SCHEME_LABELS: Record<ProxyScheme, string> = {
  socks5: 'SOCKS5',
  socks4: 'SOCKS4',
  http: 'HTTP',
  https: 'HTTPS',
};

export interface SwitchProfile extends ProfileBase {
  kind: 'switch';
  rules: SwitchRule[];
  defaultTargetId: TargetId;
}

/** Alias profile — activating or targeting it routes via its target. */
export interface VirtualProfile extends ProfileBase {
  kind: 'virtual';
  targetId: TargetId;
}

export type RuleListFormat = 'autoproxy' | 'switchy';

/**
 * Online (or pasted) rule list. URLs matching the list route to
 * `matchTargetId`; whitelist entries and non-matches go to `defaultTargetId`.
 */
export interface RuleListProfile extends ProfileBase {
  kind: 'rulelist';
  format: RuleListFormat;
  url: string;
  /** Auto-update interval in hours; 0 disables. */
  updateIntervalH: number;
  matchTargetId: TargetId;
  defaultTargetId: TargetId;
  /** Raw list text (fetched or pasted). */
  text: string;
  lastUpdated?: number;
}

export type Profile = ProxyProfile | SwitchProfile | VirtualProfile | RuleListProfile;

export interface Settings {
  /** Toolbar click cycles through quickSwitchIds instead of opening the popup. */
  quickSwitch: boolean;
  quickSwitchIds: string[];
  /** Mirror config to chrome.storage.sync across browsers. */
  syncEnabled: boolean;
  /** Profile to activate on browser startup; '' keeps the last used. */
  startupProfileId: string;
  /** Re-apply our proxy settings if another extension overrides them. */
  revertExternal: boolean;
  confirmDeletion: boolean;
  /** Quick-added rules go to the bottom (true) or top (false) of the table. */
  addToBottom: boolean;
  /** Reload the active tab after switching profiles from the popup. */
  refreshOnSwitch: boolean;
  /** Per-tab badge showing where the tab routes (needs optional "tabs" permission). */
  badgeResult: boolean;
  /**
   * Master switch for every ipconfig.is lookup: the popup's exit-IP readout AND
   * the proxy connection test. Off (the default) means Sockitt never contacts
   * ipconfig.is on its own. Turning it on requests the ipconfig.is origin grant.
   */
  exitIpCheck: boolean;
  /** Profile for incognito windows; '' follows the regular profile. */
  incognitoProfileId: string;
}

/**
 * Config schema version. Synced payloads carry it in their meta record, and a
 * device refuses to adopt a payload from a different schema — an older
 * install's sanitizer would silently strip fields it doesn't know (e.g. the
 * v3 scheme/username/password) and push the gutted config back to every
 * device. Bump on any field change an old sanitizer would destroy.
 * v4: settings gained exitIpCheck and incognitoProfileId.
 */
export const CONFIG_VERSION = 4;

export interface Config {
  version: number;
  /** Monotonic revision (ms timestamp) used for sync conflict resolution. */
  rev: number;
  /** 'direct' | 'system' | a profile id. */
  activeId: string;
  profiles: Profile[];
  settings: Settings;
}

export interface RouteResult {
  /** Resolved terminal target: a proxy profile id or 'direct'. */
  targetId: TargetId;
  /** Rule that decided it, if any (undefined = default or non-switch). */
  ruleId?: string;
  /** True when the target profile's bypass list sent the request direct. */
  bypassed?: boolean;
}

export const PALETTE = [
  '#46c9e5', // cyan
  '#3b82f6', // blue
  '#6d5dfc', // violet
  '#7c3aed', // indigo
  '#f472b6', // pink
  '#f5576c', // red
  '#fb923c', // orange
  '#ffb020', // amber
  '#84cc16', // lime
  '#2dd4a7', // green
  '#14b8a6', // teal
  '#64748b', // slate
] as const;

export function defaultSettings(): Settings {
  return {
    quickSwitch: false,
    quickSwitchIds: [],
    syncEnabled: false,
    startupProfileId: '',
    revertExternal: false,
    confirmDeletion: true,
    addToBottom: true,
    refreshOnSwitch: false,
    badgeResult: false,
    exitIpCheck: false, // privacy default: no ipconfig.is contact until the user opts in
    incognitoProfileId: '',
  };
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export function profileById(config: Config, id: string): Profile | undefined {
  return config.profiles.find((p) => p.id === id);
}

export function proxyProfiles(config: Config): ProxyProfile[] {
  return config.profiles.filter((p): p is ProxyProfile => p.kind === 'proxy');
}

export function switchProfiles(config: Config): SwitchProfile[] {
  return config.profiles.filter((p): p is SwitchProfile => p.kind === 'switch');
}

/** Every target id a profile references directly. */
export function referencedTargets(profile: Profile): TargetId[] {
  switch (profile.kind) {
    case 'proxy':
      return [];
    case 'switch':
      return [profile.defaultTargetId, ...profile.rules.map((r) => r.targetId)];
    case 'virtual':
      return [profile.targetId];
    case 'rulelist':
      return [profile.matchTargetId, profile.defaultTargetId];
  }
}

/**
 * Ids reachable from `fromId` by following target references. Used to keep
 * the UI from creating cycles (the compiler independently guards too).
 */
export function reachableFrom(config: Config, fromId: string): Set<string> {
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const p = profileById(config, id);
    if (p) for (const t of referencedTargets(p)) walk(t);
  };
  walk(fromId);
  return seen;
}
