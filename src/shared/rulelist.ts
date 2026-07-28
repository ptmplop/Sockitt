import { type CompiledCondition, regexSourceIsSafe } from './match';
import { RuleListFormat } from './types';

export interface ParsedRuleList {
  whitelist: CompiledCondition[];
  blacklist: CompiledCondition[];
  /** Parsed entry count (for the options UI). */
  count: number;
  /**
   * Non-comment lines that could not be read as an entry. Surfaced in the
   * editor: a list whose rules silently compile to something that can never
   * match is worse than one that says so.
   */
  ignored: number;
}

const EMPTY: ParsedRuleList = { whitelist: [], blacklist: [], count: 0, ignored: 0 };
const RE_SPECIALS = /[.+^${}()|[\]\\]/g;

/** Tiny memo — rule lists are large and parsed from several places. */
const cache = new Map<string, ParsedRuleList>();

export function parseRuleList(format: RuleListFormat, text: string): ParsedRuleList {
  if (!text.trim()) return EMPTY;
  const key = `${format}:${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const parsed = format === 'autoproxy' ? parseAutoProxy(text) : parseDomainList(text);
  if (cache.size >= 4) cache.delete(cache.keys().next().value!);
  cache.set(key, parsed);
  return parsed;
}

/**
 * How much of a list body the format sniffs look at. A header or an `@with`
 * directive sits at the top or nowhere, and the editor re-sniffs on every
 * keystroke — there is no reason to walk megabytes to decide.
 */
const SNIFF_CHARS = 4000;

/**
 * Horizontal whitespace only (`[^\S\n]`), never `\s`. `\s` matches `\n`, so
 * `(^|\n)\s*` gives the engine one start position per line of a blank-line run
 * and each one rescans the rest of the run — quadratic in the run length, on
 * text fetched from a remote URL.
 */
const SWITCHY_DIRECTIVE = /(^|\n)[^\S\n]*@with[^\S\n]+results?\b/i;

/**
 * True when the text is a SwitchyOmega/ZeroOmega conditions list. Sockitt reads
 * neither of its dialects — its typed conditions (`UrlRegex:`, `Keyword:`,
 * `Ip:` …) and its `!` bypass lines have no equivalent here — and pasting one
 * in used to parse "successfully" with half the rules inert. Detected so the
 * editor can say so outright.
 */
export function looksLikeSwitchyOmega(text: string): boolean {
  const head = text.slice(0, SNIFF_CHARS).trimStart();
  return head.startsWith('[SwitchyOmega Conditions') || SWITCHY_DIRECTIVE.test(head);
}

/**
 * Hard cap on a fetched list body. Parsing runs synchronously inside
 * `compilePac`, which the worker calls *before* `chrome.proxy.settings.set`, so
 * an unbounded remote body is an unbounded stall on the routing path. The
 * largest list anyone subscribes to (GFWList) is a couple of hundred kilobytes.
 */
export const RULE_LIST_MAX_BYTES = 4 * 1024 * 1024;

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
  let ignored = 0;

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
    } else {
      ignored++; // an unparseable or unsafe regex, or a bare ||
    }
  }
  return { whitelist, blacklist, count, ignored };
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
 * Domain list: one host or URL pattern per line — the shape most published
 * blocklists ship in.
 *
 *   example.com          that host exactly
 *   *.example.com        the host or any subdomain
 *   .example.com         the same, in hosts-file/adblock spelling
 *   ad*.example.com      host wildcard (* and ? supported)
 *   http://example.com/api*    URL prefix, trailing * implied
 *   @@*.safe.example     whitelist (wins over every match)
 *   # ; ! [              a whole-line comment / header
 *   example.com  # why    a trailing comment, after whitespace
 *
 * A path only discriminates on http:// — see urlEntryIsUnreachable.
 *
 * Formerly labelled "Switchy" after SwitchyOmega's rule lists, which it never
 * implemented — see looksLikeSwitchyOmega above.
 */
export function parseDomainList(text: string): ParsedRuleList {
  const whitelist: CompiledCondition[] = [];
  const blacklist: CompiledCondition[] = [];
  let count = 0;
  let ignored = 0;

  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || /^[#;![]/.test(line)) continue;
    line = line.replace(TRAILING_COMMENT, '').trimEnd();
    if (!line) continue;
    let bucket = blacklist;
    if (line.startsWith('@@')) {
      bucket = whitelist;
      line = line.slice(2).trim();
      if (!line) continue;
    }
    const cond = domainListEntry(line);
    if (cond.op !== 'never') {
      bucket.push(cond);
      count++;
    } else {
      ignored++;
    }
  }
  return { whitelist, blacklist, count, ignored };
}

/**
 * A trailing comment. The marker must be preceded by whitespace so a URL
 * fragment (`https://x.example/p#frag`) is not mistaken for one, and it must be
 * an explicit `#` or `;` rather than "everything after the first space" —
 * otherwise a typed condition like `HostWildcard *.foo.example` would quietly
 * truncate to a valid-looking hostname instead of being reported as unreadable.
 *
 * Exactly one `\s`, never `\s+`. With the quantifier, a whitespace run that is
 * *not* followed by a marker makes the engine retry from every offset in the
 * run — quadratic in its length, and list bodies come off the network, so the
 * run length is the list author's to choose. The caller trims the single space
 * this leaves behind.
 */
const TRAILING_COMMENT = /\s[#;].*$/;

function domainListEntry(entry: string): CompiledCondition {
  // Internal whitespace means this is not a host or a URL — overwhelmingly a
  // typed condition from another tool ("UrlRegex: ^https?://…"), which used to
  // compile to a host wildcard of the whole literal and match nothing, forever,
  // without a word to the user.
  if (/\s/.test(entry)) return { op: 'never' };
  if (entry.includes('://')) {
    if (urlEntryIsUnreachable(entry)) return { op: 'never' };
    return { op: 'urlRegex', source: `^${wildcardUrlSource(/[*?]$/.test(entry) ? entry : entry + '*')}` };
  }
  // A bare entry is a hostname pattern, so it may hold only the characters a
  // hostname can — this rejects paths, ports, CIDRs and stray type prefixes.
  if (/[^a-z0-9._*?-]/i.test(entry)) return { op: 'never' };
  return hostWildcardEntry(entry);
}

/**
 * Chrome hands a PAC script only `scheme://host/` for every scheme but http,
 * stripping the path and query for privacy — `pacRequestUrl` mirrors that. So a
 * URL entry on a stripped scheme whose path cannot *also* match a bare `/` can
 * never fire, however well formed it looks: `https://cdn.example/px` is only
 * ever tested against `https://cdn.example/`. Report it rather than compile a
 * rule the request URL is incapable of satisfying.
 *
 * Deliberately not applied to AutoProxy's `|prefix` lines, which have the same
 * blind spot: those come from a third-party subscription the user cannot edit,
 * and GFWList carries thousands of them — flagging what nobody can act on is
 * noise. A domain list is written by the person reading the count.
 */
function urlEntryIsUnreachable(entry: string): boolean {
  const sep = entry.indexOf('://');
  const scheme = entry.slice(0, sep).toLowerCase();
  if (scheme === 'http' || /[*?]/.test(scheme)) return false;
  const authority = entry.slice(sep + 3);
  const slash = authority.indexOf('/');
  if (slash < 0) return false; // no path at all — the origin form still matches
  const path = authority.slice(slash);
  // Wildcard-derived sources only ever hold `.*`/`.`, so this is linear and
  // cannot throw.
  return !new RegExp(`^${wildcardUrlSource(/[*?]$/.test(path) ? path : path + '*')}`).test('/');
}

function hostWildcardEntry(line: string): CompiledCondition {
  // A trailing dot is the FQDN root, and a leading dot is the hosts-file and
  // adblock spelling of "this domain and its subdomains" — the form published
  // blocklists ship (`.doubleclick.net`). Both used to compile to a hostEq no
  // host can ever equal: a counted entry that silently did nothing.
  // compileAutoProxyEntry already strips both from `||domain`; read a
  // domain-list entry the same way.
  const trimmed = line.toLowerCase().replace(/\.+$/, '');
  if (!trimmed) return { op: 'never' };
  const p = /^\.+[a-z0-9*?]/.test(trimmed) ? '*.' + trimmed.replace(/^\.+/, '') : trimmed;
  const bare = p.replace(/^\*\*?\./, '');
  if (/^\*\*?\./.test(p) && !/[*?]/.test(bare)) {
    return { op: 'suffix', suffix: '.' + bare, alsoBare: bare };
  }
  if (!/[*?]/.test(p)) return { op: 'hostEq', host: p };
  return { op: 'hostRegex', source: `^${wildcardUrlSource(p)}$` };
}
