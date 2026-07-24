import { parseRuleList } from './rulelist';
import {
  Config,
  DIRECT,
  Profile,
  ProxyProfile,
  RouteResult,
  SwitchRule,
  profileById,
} from './types';

/**
 * Compiled form of a single condition. Shapes are chosen so the PAC generator
 * can emit cheap string/integer comparisons instead of regexes wherever
 * possible; `testCondition` is the TS twin used for the popup preview.
 */
export type CompiledCondition =
  | { op: 'suffix'; suffix: string; alsoBare: string }
  | { op: 'hostEq'; host: string }
  | { op: 'hostRegex'; source: string }
  | { op: 'urlRegex'; source: string }
  | { op: 'urlKeyword'; text: string }
  | { op: 'cidr'; base: number; mask: number }
  | { op: 'hostLevels'; min: number; max: number }
  | { op: 'weekday'; mask: number }
  | { op: 'time'; from: number; to: number }
  | { op: 'local' }
  | { op: 'never' };

const RE_SPECIALS = /[.+^${}()|[\]\\]/g;
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function wildcardToRegexSource(pattern: string): string {
  const escaped = pattern
    .replace(RE_SPECIALS, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return `^${escaped}$`;
}

export function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  let out = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet > 255) return null;
    out = ((out << 8) | octet) >>> 0;
  }
  return out;
}

export function parseCidr(text: string): { base: number; mask: number } | null {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(text.trim());
  const ip = m ? ipv4ToInt(m[1]!) : ipv4ToInt(text.trim());
  if (ip === null) return null;
  const bits = m ? Number(m[2]) : 32;
  if (bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (ip & mask) >>> 0, mask };
}

/** "2" or "2-4" → inclusive host-label-count range. */
export function parseLevels(text: string): { min: number; max: number } | null {
  const m = /^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const min = Number(m[1]);
  const max = m[2] !== undefined ? Number(m[2]) : min;
  return min >= 1 && max >= min ? { min, max } : null;
}

/** "mon,tue" / "mon-fri" / "0,6" → weekday bitmask (bit 0 = Sunday). */
export function parseWeekdays(text: string): number | null {
  let mask = 0;
  const dayIndex = (token: string): number => {
    if (/^[0-6]$/.test(token)) return Number(token);
    return DAY_NAMES.indexOf(token.slice(0, 3));
  };
  for (const part of text.toLowerCase().split(',')) {
    const range = part.trim().split('-');
    if (range.length === 1) {
      const d = dayIndex(range[0]!);
      if (d < 0) return null;
      mask |= 1 << d;
    } else if (range.length === 2) {
      let a = dayIndex(range[0]!);
      const b = dayIndex(range[1]!);
      if (a < 0 || b < 0) return null;
      for (;;) {
        mask |= 1 << a;
        if (a === b) break;
        a = (a + 1) % 7;
      }
    } else {
      return null;
    }
  }
  return mask || null;
}

/** "09:00-17:30" → minutes-of-day range; may wrap midnight (22:00-06:00). */
export function parseTimeRange(text: string): { from: number; to: number } | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)\s*-\s*([01]?\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  if (!m) return null;
  return {
    from: Number(m[1]) * 60 + Number(m[2]),
    to: Number(m[3]) * 60 + Number(m[4]),
  };
}

/**
 * Compile one host-wildcard pattern. `*.example.com` (and `**.example.com`)
 * match example.com and every subdomain; plain patterns with wildcards
 * elsewhere become regexes.
 */
export function compileHostWildcard(pattern: string): CompiledCondition {
  const p = pattern.trim().toLowerCase();
  if (!p) return { op: 'never' };
  const bare = p.replace(/^\*\*?\./, '');
  if (/^\*\*?\./.test(p) && !/[*?]/.test(bare)) {
    return { op: 'suffix', suffix: '.' + bare, alsoBare: bare };
  }
  if (!/[*?]/.test(p)) return { op: 'hostEq', host: p };
  return { op: 'hostRegex', source: wildcardToRegexSource(p) };
}

export function compileRule(rule: Pick<SwitchRule, 'type' | 'pattern'>): CompiledCondition {
  const pattern = rule.pattern.trim();
  if (!pattern) return { op: 'never' };
  try {
    switch (rule.type) {
      case 'hostWildcard':
        return compileHostWildcard(pattern);
      case 'hostRegex':
        new RegExp(pattern);
        return { op: 'hostRegex', source: pattern };
      case 'urlWildcard': {
        // A trailing * is implied so "https://api.github.com/" style prefixes work.
        const p = /[*?]$/.test(pattern) ? pattern : pattern + '*';
        return { op: 'urlRegex', source: wildcardToRegexSource(p) };
      }
      case 'urlRegex':
        new RegExp(pattern);
        return { op: 'urlRegex', source: pattern };
      case 'ipCidr': {
        const cidr = parseCidr(pattern);
        return cidr ? { op: 'cidr', ...cidr } : { op: 'never' };
      }
      case 'keyword':
        return { op: 'urlKeyword', text: pattern };
      case 'hostLevels': {
        const levels = parseLevels(pattern);
        return levels ? { op: 'hostLevels', ...levels } : { op: 'never' };
      }
      case 'weekday': {
        const mask = parseWeekdays(pattern);
        return mask ? { op: 'weekday', mask } : { op: 'never' };
      }
      case 'time': {
        const range = parseTimeRange(pattern);
        return range ? { op: 'time', ...range } : { op: 'never' };
      }
    }
  } catch {
    return { op: 'never' }; // invalid regex — rule is inert, options UI flags it
  }
}

/** Compile one bypass-list entry (Chrome bypass syntax subset). */
export function compileBypassEntry(entry: string): CompiledCondition {
  const e = entry.trim().toLowerCase();
  if (!e) return { op: 'never' };
  if (e === '<local>') return { op: 'local' };
  if (/^[\d.]+(\/\d{1,2})?$/.test(e)) {
    const cidr = parseCidr(e);
    if (cidr) return { op: 'cidr', ...cidr };
  }
  return compileHostWildcard(e);
}

/**
 * The URL as Chrome hands it to a PAC script. Chrome strips the path and query
 * from https:// (and ftp/wss) URLs for privacy, passing only `scheme://host/`;
 * http:// URLs keep their full path. The popup preview and per-tab badge must
 * match against THIS, not the raw tab URL, or they disagree with real routing.
 */
export function pacRequestUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:') return url;
    return `${u.protocol}//${u.host}/`;
  } catch {
    return url;
  }
}

export function hostLevelCount(host: string): number {
  let levels = 1;
  for (let i = 0; i < host.length; i++) if (host.charCodeAt(i) === 46) levels++;
  return levels;
}

export function timeInRange(mins: number, from: number, to: number): boolean {
  return from <= to ? mins >= from && mins <= to : mins >= from || mins <= to;
}

/**
 * Compiled-regex memo. Conditions carry regex SOURCE strings (the PAC
 * generator emits them as text), so the TS-side tester would otherwise build
 * a fresh RegExp per rule per evaluation — noticeable when the popup or the
 * per-tab badge walks a large rule set. Flagless regexes are stateless, so
 * sharing instances is safe. Bounded defensively: huge rule lists could
 * otherwise grow it without limit.
 */
const RE_CACHE = new Map<string, RegExp>();
function cachedRegex(source: string): RegExp {
  let re = RE_CACHE.get(source);
  if (!re) {
    if (RE_CACHE.size >= 1000) RE_CACHE.clear();
    re = new RegExp(source);
    RE_CACHE.set(source, re);
  }
  return re;
}

export function testCondition(
  c: CompiledCondition,
  url: string,
  host: string,
  now: Date = new Date()
): boolean {
  const h = host.toLowerCase();
  switch (c.op) {
    case 'suffix':
      return h === c.alsoBare || h.endsWith(c.suffix);
    case 'hostEq':
      return h === c.host;
    case 'hostRegex':
      return cachedRegex(c.source).test(h);
    case 'urlRegex':
      return cachedRegex(c.source).test(url);
    case 'urlKeyword':
      return url.includes(c.text);
    case 'cidr': {
      const ip = ipv4ToInt(h);
      return ip !== null && ((ip & c.mask) >>> 0) === c.base;
    }
    case 'hostLevels': {
      const levels = hostLevelCount(h);
      return levels >= c.min && levels <= c.max;
    }
    case 'weekday':
      return (c.mask & (1 << now.getDay())) !== 0;
    case 'time':
      return timeInRange(now.getHours() * 60 + now.getMinutes(), c.from, c.to);
    case 'local':
      return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || !h.includes('.');
    case 'never':
      return false;
  }
}

export function testBypass(bypass: string[], url: string, host: string): boolean {
  return bypass.some((entry) => testCondition(compileBypassEntry(entry), url, host));
}

/**
 * Pure TS twin of the generated PAC: resolve where a URL routes when
 * `profile` is active, following virtual/switch/rulelist chains. Used by the
 * popup preview and by tests to enforce parity with the compiled PAC.
 */
export function resolveRoute(
  config: Config,
  profile: Profile,
  url: string,
  host: string,
  tempRules: SwitchRule[] = [],
  now: Date = new Date()
): RouteResult {
  const visited = new Set<string>();

  const finish = (target: ProxyProfile, ruleId?: string): RouteResult => {
    if (testBypass(target.bypass, url, host)) {
      return { targetId: target.id, ruleId, bypassed: true };
    }
    return { targetId: target.id, ruleId };
  };

  const walk = (p: Profile | undefined, ruleId?: string): RouteResult => {
    if (!p || visited.has(p.id)) return { targetId: DIRECT, ruleId };
    visited.add(p.id);
    switch (p.kind) {
      case 'proxy':
        return finish(p, ruleId);
      case 'virtual':
        return p.targetId === DIRECT
          ? { targetId: DIRECT, ruleId }
          : walk(profileById(config, p.targetId), ruleId);
      case 'switch': {
        const rules = p.id === profile.id ? [...tempRules, ...p.rules] : p.rules;
        for (const rule of rules) {
          if (!rule.enabled) continue;
          if (testCondition(compileRule(rule), url, host, now)) {
            return rule.targetId === DIRECT
              ? { targetId: DIRECT, ruleId: rule.id }
              : walk(profileById(config, rule.targetId), rule.id);
          }
        }
        return p.defaultTargetId === DIRECT
          ? { targetId: DIRECT, ruleId }
          : walk(profileById(config, p.defaultTargetId), ruleId);
      }
      case 'rulelist': {
        const parsed = parseRuleList(p.format, p.text);
        const hit = (conds: CompiledCondition[]) =>
          conds.some((c) => testCondition(c, url, host, now));
        const targetId = hit(parsed.whitelist)
          ? p.defaultTargetId
          : hit(parsed.blacklist)
            ? p.matchTargetId
            : p.defaultTargetId;
        return targetId === DIRECT
          ? { targetId: DIRECT, ruleId }
          : walk(profileById(config, targetId), ruleId);
      }
    }
  };

  return walk(profile);
}

/** Validate a rule pattern; returns an error string or null if fine. */
export function patternError(rule: Pick<SwitchRule, 'type' | 'pattern'>): string | null {
  const p = rule.pattern.trim();
  if (!p) return 'Pattern is empty';
  switch (rule.type) {
    case 'hostRegex':
    case 'urlRegex':
      try {
        new RegExp(p);
      } catch (e) {
        return e instanceof Error ? e.message : 'Invalid regex';
      }
      return null;
    case 'ipCidr':
      return parseCidr(p) ? null : 'Use IPv4 or IPv4/prefix, e.g. 10.0.0.0/8';
    case 'hostLevels':
      return parseLevels(p) ? null : 'Use a count or range, e.g. 2 or 2-4';
    case 'weekday':
      return parseWeekdays(p) !== null ? null : 'Use day names or ranges, e.g. mon-fri or sat,sun';
    case 'time':
      return parseTimeRange(p) ? null : 'Use HH:MM-HH:MM, e.g. 09:00-17:30';
    default:
      return null;
  }
}

export type { ProxyProfile };
