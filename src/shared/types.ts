/** Reserved target/profile ids for the two built-in modes. */
export const DIRECT = 'direct';
export const SYSTEM = 'system';

/** A rule's routing destination: a proxy profile id, or the built-in 'direct'. */
export type TargetId = string;

export type RuleType =
  | 'hostWildcard'
  | 'hostRegex'
  | 'urlWildcard'
  | 'urlRegex'
  | 'ipCidr';

export interface SwitchRule {
  id: string;
  enabled: boolean;
  type: RuleType;
  pattern: string;
  targetId: TargetId;
}

export interface ProxyProfile {
  kind: 'proxy';
  id: string;
  name: string;
  color: string;
  host: string;
  port: number;
  /**
   * Hosts reached directly even when this profile is active.
   * Supports: <local>, exact hosts, *.suffix wildcards, IPv4 CIDR.
   */
  bypass: string[];
}

export interface SwitchProfile {
  kind: 'switch';
  id: string;
  name: string;
  color: string;
  rules: SwitchRule[];
  defaultTargetId: TargetId;
}

export type Profile = ProxyProfile | SwitchProfile;

export interface Config {
  version: 1;
  /** 'direct' | 'system' | a profile id. */
  activeId: string;
  profiles: Profile[];
}

export interface RouteResult {
  /** Resolved terminal target: a proxy profile or direct. */
  targetId: TargetId;
  /** Rule that decided it, if any (undefined = switch default or non-switch). */
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
