import { type CompiledCondition, regexSourceIsSafe } from './match';
import { RuleListFormat } from './types';

export interface ParsedRuleList {
  whitelist: CompiledCondition[];
  blacklist: CompiledCondition[];
  /** Parsed entry count (for the options UI). */
  count: number;
}

const EMPTY: ParsedRuleList = { whitelist: [], blacklist: [], count: 0 };
const RE_SPECIALS = /[.+^${}()|[\]\\]/g;

/** Tiny memo — rule lists are large and parsed from several places. */
const cache = new Map<string, ParsedRuleList>();

export function parseRuleList(format: RuleListFormat, text: string): ParsedRuleList {
  if (!text.trim()) return EMPTY;
  const key = `${format}:${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const parsed = format === 'autoproxy' ? parseAutoProxy(text) : parseSwitchy(text);
  if (cache.size >= 4) cache.delete(cache.keys().next().value!);
  cache.set(key, parsed);
  return parsed;
}

/** GFWList ships base64-encoded; decode when the payload looks like it. */
export function maybeDecodeBase64(text: string): string {
  const head = text.slice(0, 200).trim();
  if (head.startsWith('[') || head.startsWith('!') || head.includes('||')) return text;
  if (!/^[A-Za-z0-9+/=\r\n\s]+$/.test(text.slice(0, 4000))) return text;
  try {
    const decoded = atob(text.replace(/\s+/g, ''));
    return decoded.includes('[AutoProxy') || decoded.includes('||') ? decoded : text;
  } catch {
    return text;
  }
}

function wildcardUrlSource(pattern: string): string {
  return pattern.replace(RE_SPECIALS, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
}

/**
 * AutoProxy format (used by GFWList):
 *   ! comment      [AutoProxy 0.x] header
 *   @@rule         whitelist (highest priority)
 *   ||domain       host is domain or a subdomain of it
 *   |http://pre    URL prefix
 *   /regex/        URL regex
 *   plain          URL substring (may contain * wildcards)
 */
export function parseAutoProxy(raw: string): ParsedRuleList {
  const text = maybeDecodeBase64(raw);
  const whitelist: CompiledCondition[] = [];
  const blacklist: CompiledCondition[] = [];
  let count = 0;

  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('!') || line.startsWith('[')) continue;
    let bucket = blacklist;
    if (line.startsWith('@@')) {
      bucket = whitelist;
      line = line.slice(2).trim();
      if (!line) continue; // a bare @@ would otherwise whitelist everything
    }
    const cond = compileAutoProxyEntry(line);
    if (cond.op !== 'never') {
      bucket.push(cond);
      count++;
    }
  }
  return { whitelist, blacklist, count };
}

function compileAutoProxyEntry(entry: string): CompiledCondition {
  if (entry.startsWith('||')) {
    // Strip any path/port/anchor; wildcards inside domains fall back to regex.
    const domain = entry.slice(2).replace(/[/^:].*$/, '').replace(/^\.+|\.+$/g, '').toLowerCase();
    if (!domain) return { op: 'never' };
    if (/[*?]/.test(domain)) {
      return { op: 'hostRegex', source: `(^|\\.)${wildcardUrlSource(domain)}$` };
    }
    return { op: 'suffix', suffix: '.' + domain, alsoBare: domain };
  }
  if (entry.startsWith('|')) {
    const prefix = entry.slice(1);
    if (!prefix) return { op: 'never' };
    return { op: 'urlRegex', source: `^${wildcardUrlSource(prefix)}` };
  }
  if (entry.length > 1 && entry.startsWith('/') && entry.endsWith('/')) {
    try {
      const source = entry.slice(1, -1);
      new RegExp(source);
      // List regex is remote/pasted content on the per-request hot path — a
      // catastrophic-backtracking source would wedge proxy resolution.
      if (!regexSourceIsSafe(source)) return { op: 'never' };
      return { op: 'urlRegex', source };
    } catch {
      return { op: 'never' };
    }
  }
  if (/[*?]/.test(entry)) {
    return { op: 'urlRegex', source: wildcardUrlSource(entry) };
  }
  return { op: 'urlKeyword', text: entry };
}

/**
 * Switchy format: one pattern per line. '#', ';', '!', '[' lines are
 * comments; '@@' prefixes a whitelist entry; entries containing '://' are
 * URL wildcards, everything else is a host wildcard.
 */
export function parseSwitchy(text: string): ParsedRuleList {
  const whitelist: CompiledCondition[] = [];
  const blacklist: CompiledCondition[] = [];
  let count = 0;

  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || /^[#;![]/.test(line)) continue;
    let bucket = blacklist;
    if (line.startsWith('@@')) {
      bucket = whitelist;
      line = line.slice(2).trim();
      if (!line) continue;
    }
    const cond: CompiledCondition = line.includes('://')
      ? { op: 'urlRegex', source: `^${wildcardUrlSource(/[*?]$/.test(line) ? line : line + '*')}` }
      : hostWildcardEntry(line);
    if (cond.op !== 'never') {
      bucket.push(cond);
      count++;
    }
  }
  return { whitelist, blacklist, count };
}

function hostWildcardEntry(line: string): CompiledCondition {
  const p = line.toLowerCase();
  const bare = p.replace(/^\*\*?\./, '');
  if (/^\*\*?\./.test(p) && !/[*?]/.test(bare)) {
    return { op: 'suffix', suffix: '.' + bare, alsoBare: bare };
  }
  if (!/[*?]/.test(p)) return { op: 'hostEq', host: p };
  return { op: 'hostRegex', source: `^${wildcardUrlSource(p)}$` };
}
