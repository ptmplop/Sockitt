import {
  Config,
  DIRECT,
  ProxyProfile,
  RouteResult,
  SwitchProfile,
  SwitchRule,
  profileById,
} from './types';

/**
 * Compiled form of a single condition. `suffix` and `cidr` exist so the PAC
 * generator can emit cheap string/integer comparisons instead of regexes.
 */
export type CompiledCondition =
  | { op: 'suffix'; suffix: string; alsoBare: string }
  | { op: 'hostEq'; host: string }
  | { op: 'hostRegex'; source: string }
  | { op: 'urlRegex'; source: string }
  | { op: 'cidr'; base: number; mask: number }
  | { op: 'local' }
  | { op: 'never' };

const RE_SPECIALS = /[.+^${}()|[\]\\]/g;

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

/**
 * Compile one host-wildcard pattern. `*.example.com` (and `**.example.com`)
 * match example.com and every subdomain — same convenience the original
 * extension provided; plain patterns with wildcards elsewhere become regexes.
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

export function compileRule(rule: SwitchRule): CompiledCondition {
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

export function testCondition(c: CompiledCondition, url: string, host: string): boolean {
  const h = host.toLowerCase();
  switch (c.op) {
    case 'suffix':
      return h === c.alsoBare || h.endsWith(c.suffix);
    case 'hostEq':
      return h === c.host;
    case 'hostRegex':
      return new RegExp(c.source).test(h);
    case 'urlRegex':
      return new RegExp(c.source).test(url);
    case 'cidr': {
      const ip = ipv4ToInt(h);
      return ip !== null && ((ip & c.mask) >>> 0) === c.base;
    }
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
 * Pure TS twin of the generated PAC: resolve which target a URL routes to
 * under a switch profile. Used by the popup's live preview.
 */
export function resolveRoute(config: Config, profile: SwitchProfile, url: string, host: string): RouteResult {
  let targetId: string = profile.defaultTargetId;
  let ruleId: string | undefined;
  for (const rule of profile.rules) {
    if (!rule.enabled) continue;
    if (testCondition(compileRule(rule), url, host)) {
      targetId = rule.targetId;
      ruleId = rule.id;
      break;
    }
  }
  const target = profileById(config, targetId);
  if (!target || target.kind !== 'proxy') {
    return { targetId: DIRECT, ruleId };
  }
  if (testBypass(target.bypass, url, host)) {
    return { targetId: target.id, ruleId, bypassed: true };
  }
  return { targetId: target.id, ruleId };
}

/** Validate a rule pattern; returns an error string or null if fine. */
export function patternError(rule: Pick<SwitchRule, 'type' | 'pattern'>): string | null {
  const p = rule.pattern.trim();
  if (!p) return 'Pattern is empty';
  if (rule.type === 'hostRegex' || rule.type === 'urlRegex') {
    try {
      new RegExp(p);
    } catch (e) {
      return e instanceof Error ? e.message : 'Invalid regex';
    }
  }
  if (rule.type === 'ipCidr' && !parseCidr(p)) return 'Use IPv4 or IPv4/prefix, e.g. 10.0.0.0/8';
  return null;
}

export type { ProxyProfile };
