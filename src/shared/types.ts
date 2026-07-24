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

export interface ProxyProfile extends ProfileBase {
  kind: 'proxy';
  host: string;
  port: number;
  /**
   * Hosts reached directly even when this profile is active.
   * Supports: <local>, exact hosts, *.suffix wildcards, IPv4 CIDR.
   */
  bypass: string[];
}

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
}

export interface Config {
  version: 2;
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
  '#6d5dfc', // violet
  '#2dd4a7', // green
  '#ffb020', // amber
  '#f5576c', // red
  '#f472b6', // pink
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
