import { compileRule, patternError, testCondition } from './match';
import { parseRuleList } from './rulelist';
import {
  Config,
  DIRECT,
  Profile,
  ProxyProfile,
  RuleListProfile,
  SwitchProfile,
  SwitchRule,
  hasCredentials,
  referencedTargets,
  reachableFrom,
} from './types';

/**
 * Configuration audit — the checks behind the dashboard's health card.
 *
 * Deliberately PURE: no chrome.* calls, no DOM, no clock of its own. Everything
 * it needs that lives outside the config (whether the auth permission is held,
 * what time it is) arrives in HealthContext, so the whole thing runs in a Node
 * test without a browser. The UI turns an issue into a button; this file never
 * knows what a button is.
 *
 * The bar for a check: it must describe something the user did not intend and
 * cannot see. "You have a disabled rule" is visible in the editor and is not a
 * finding. "Every rule below this one can never run" is neither.
 */

export type IssueLevel = 'error' | 'warn' | 'info';

/**
 * The action offered alongside a finding. Named rather than supplied as a
 * callback so the audit stays pure — the options page owns navigation and
 * mutation, and maps these to real work.
 */
export type IssueFix =
  /** Open the named profile's editor. */
  | { kind: 'open'; label: string }
  /** Append <local> to a proxy profile's bypass list. */
  | { kind: 'add-local-bypass'; label: string }
  /** Refetch a rule list now. */
  | { kind: 'update-list'; label: string }
  /** Request the optional proxy-authentication permissions. */
  | { kind: 'grant-auth'; label: string };

export interface HealthIssue {
  /**
   * Stable across repaints for the same finding, so a re-audit two seconds
   * later does not make the list flicker into a different order or re-animate.
   * Derived from the check name plus the ids it concerns — never an index.
   */
  id: string;
  level: IssueLevel;
  /** One line, naming the thing that is wrong. */
  title: string;
  /** The specifics, when the title cannot carry them. */
  detail?: string;
  profileId?: string;
  ruleId?: string;
  fix: IssueFix;
}

export interface HealthReport {
  issues: HealthIssue[];
  /** 0–100. 100 means every check passed. */
  score: number;
  counts: Record<IssueLevel, number>;
}

export interface HealthContext {
  /** True when AUTH_PERMS is currently granted. */
  authGranted: boolean;
  /** Epoch ms — injected so staleness checks are testable. */
  now: number;
}

/**
 * Score weights. An error is something that will fail or already has; a warning
 * is something that silently does not do what it looks like it does; a note is
 * a smell. Three errors take the score to 55, which is the intent — the card
 * should look bad when the configuration is bad.
 */
const WEIGHT: Record<IssueLevel, number> = { error: 15, warn: 7, info: 3 };

/** Patterns that match every request, so nothing after them can ever run. */
function isCatchAll(rule: SwitchRule): boolean {
  const p = rule.pattern.trim();
  switch (rule.type) {
    case 'hostWildcard':
    case 'urlWildcard':
      return p === '*' || p === '*.*' || p === '**';
    case 'hostRegex':
    case 'urlRegex':
      return p === '.*' || p === '^.*$' || p === '^' || p === '';
    case 'keyword':
      return p === '';
    default:
      // Time and weekday rules match only sometimes, CIDR and host-levels only
      // some hosts. None of them can shadow anything unconditionally.
      return false;
  }
}

/** A proxy reaches localhost directly, which is almost always what is wanted. */
function bypassesLocal(profile: ProxyProfile): boolean {
  return profile.bypass.some((entry) => {
    const e = entry.trim().toLowerCase();
    return e === '<local>' || e === 'localhost' || e === '127.0.0.1';
  });
}

function auditProxy(p: ProxyProfile, ctx: HealthContext, out: HealthIssue[]): void {
  if (!p.host.trim()) {
    out.push({
      id: `empty-host:${p.id}`,
      level: 'error',
      title: `${p.name} has no host`,
      detail:
        'Sockitt cannot hand these settings to the browser, so activating this profile leaves the previous route in force.',
      profileId: p.id,
      fix: { kind: 'open', label: 'Fix' },
    });
  }
  if (hasCredentials(p) && !ctx.authGranted) {
    out.push({
      id: `auth-missing:${p.id}`,
      level: 'warn',
      title: `${p.name} has credentials but cannot use them`,
      detail:
        'The proxy will ask for a username and password and nothing will answer, so requests fail with ERR_PROXY_AUTH_REQUESTED.',
      profileId: p.id,
      fix: { kind: 'grant-auth', label: 'Grant' },
    });
  }
  if (!bypassesLocal(p)) {
    out.push({
      id: `no-local:${p.id}`,
      level: 'info',
      title: `${p.name} sends localhost through the proxy`,
      detail:
        'Without <local> in the bypass list, a dev server on 127.0.0.1 is dialled from the proxy’s side of the connection — where it does not exist.',
      profileId: p.id,
      fix: { kind: 'add-local-bypass', label: 'Add <local>' },
    });
  }
}

function auditSwitch(p: SwitchProfile, out: HealthIssue[]): void {
  const enabled = p.rules.filter((r) => r.enabled);

  for (const rule of p.rules) {
    const err = patternError(rule);
    if (err) {
      out.push({
        id: `pattern:${p.id}:${rule.id}`,
        // A rule that will not compile takes the whole PAC down with it at
        // apply time — this is not a style note.
        level: 'error',
        title: `Invalid pattern in ${p.name}`,
        detail: `“${rule.pattern || '(empty)'}” — ${err}`,
        profileId: p.id,
        ruleId: rule.id,
        fix: { kind: 'open', label: 'Fix' },
      });
    }
  }

  // Everything below an unconditional rule is dead code.
  const catchAllAt = enabled.findIndex(isCatchAll);
  if (catchAllAt >= 0 && catchAllAt < enabled.length - 1) {
    const rule = enabled[catchAllAt]!;
    const buried = enabled.length - catchAllAt - 1;
    out.push({
      id: `catchall:${p.id}:${rule.id}`,
      level: 'warn',
      title: `${buried} rule${buried === 1 ? '' : 's'} in ${p.name} can never run`,
      detail: `“${rule.pattern}” matches everything, and rules are tried in order — nothing below it is ever reached.`,
      profileId: p.id,
      ruleId: rule.id,
      fix: { kind: 'open', label: 'Reorder' },
    });
  }

  // A later duplicate of an earlier enabled rule is equally dead, and is much
  // easier to create by accident (quick-add from the popup, twice).
  const seen = new Map<string, SwitchRule>();
  for (const rule of enabled) {
    // \u0000, not a space: a pattern may contain spaces, so a space-joined
    // key could let two different rules collide into one. Written as an
    // escape rather than a literal — a raw NUL in the source makes git treat
    // the whole file as binary, which costs every future diff and blame.
    const key = `${rule.type}\u0000${rule.pattern.trim()}`;
    const first = seen.get(key);
    if (first && first.targetId !== rule.targetId) {
      out.push({
        id: `dupe:${p.id}:${rule.id}`,
        level: 'warn',
        title: `Duplicate rule in ${p.name}`,
        detail: `“${rule.pattern}” appears twice with different targets. The first one wins; the second never applies.`,
        profileId: p.id,
        ruleId: rule.id,
        fix: { kind: 'open', label: 'Review' },
      });
      // One report per pattern — a triplicate is the same mistake.
      seen.delete(key);
    } else if (!first) {
      seen.set(key, rule);
    }
  }

  if (p.rules.length > 0 && enabled.length === 0) {
    out.push({
      id: `all-off:${p.id}`,
      level: 'warn',
      title: `Every rule in ${p.name} is switched off`,
      detail: 'It routes everything to its default target, exactly as if it had no rules at all.',
      profileId: p.id,
      fix: { kind: 'open', label: 'Open' },
    });
  }

  if (
    enabled.length > 0 &&
    p.defaultTargetId === DIRECT &&
    enabled.every((r) => r.targetId === DIRECT)
  ) {
    out.push({
      id: `all-direct:${p.id}`,
      level: 'info',
      title: `${p.name} never uses a proxy`,
      detail: 'Every enabled rule and the default all point at Direct, so activating it changes nothing.',
      profileId: p.id,
      fix: { kind: 'open', label: 'Open' },
    });
  }
}

const HOUR_MS = 3_600_000;

function auditRuleList(p: RuleListProfile, ctx: HealthContext, out: HealthIssue[]): void {
  if (!p.text.trim()) {
    out.push({
      id: `list-empty:${p.id}`,
      level: 'error',
      title: `${p.name} is empty`,
      detail: p.url
        ? 'Nothing has been fetched yet, so every request takes the default route.'
        : 'No URL and no pasted text — this profile has no rules to match against.',
      profileId: p.id,
      fix: p.url ? { kind: 'update-list', label: 'Fetch now' } : { kind: 'open', label: 'Open' },
    });
    return;
  }

  // Stale only counts against a list that is supposed to refresh itself and has
  // a URL to refresh from. Twice the interval, so a laptop that was asleep over
  // one refresh window does not raise a finding.
  if (p.url && p.updateIntervalH > 0 && p.lastUpdated) {
    const age = ctx.now - p.lastUpdated;
    if (age > p.updateIntervalH * HOUR_MS * 2) {
      out.push({
        id: `list-stale:${p.id}`,
        level: 'warn',
        title: `${p.name} has not refreshed`,
        detail: `Last fetched ${Math.floor(age / (24 * HOUR_MS))} day(s) ago; it is set to update every ${p.updateIntervalH} h.`,
        profileId: p.id,
        fix: { kind: 'update-list', label: 'Fetch now' },
      });
    }
  }

  const parsed = parseRuleList(p.format, p.text);
  if (parsed.count === 0) {
    out.push({
      id: `list-unparsed:${p.id}`,
      level: 'error',
      title: `No rules could be read from ${p.name}`,
      detail: 'The body is not empty, but nothing in it parsed as an entry — check the list format.',
      profileId: p.id,
      fix: { kind: 'open', label: 'Open' },
    });
  } else if (parsed.ignored > parsed.count / 10) {
    out.push({
      id: `list-ignored:${p.id}`,
      level: 'info',
      title: `${parsed.ignored} lines in ${p.name} were skipped`,
      detail: `${parsed.count} entries loaded. Skipped lines are usually a different list dialect.`,
      profileId: p.id,
      fix: { kind: 'open', label: 'Open' },
    });
  }
}

/**
 * A profile that can reach itself again by following targets. The PAC compiler
 * and resolveRoute both guard against this independently (they stop on a
 * revisit), so it is not fatal — but the route it produces is not the one the
 * configuration reads as, which is worth saying out loud.
 */
function auditCycles(config: Config, out: HealthIssue[]): void {
  for (const p of config.profiles) {
    const loops = referencedTargets(p).some(
      (t) => t !== DIRECT && t !== p.id && reachableFrom(config, t).has(p.id)
    );
    const selfRef = referencedTargets(p).includes(p.id);
    if (!loops && !selfRef) continue;
    out.push({
      id: `cycle:${p.id}`,
      level: 'error',
      title: `${p.name} routes back to itself`,
      detail:
        'Following its targets leads back here. Routing stops at the loop and falls through to Direct, which is almost certainly not what this is meant to do.',
      profileId: p.id,
      fix: { kind: 'open', label: 'Open' },
    });
  }
}

/**
 * A rule whose pattern is a plain hostname that its own profile's chain would
 * never see, because an earlier profile in the chain already sent that host
 * elsewhere, is out of scope here — it needs a request to reason about. What is
 * in scope: the active profile resolving nothing but Direct.
 */
function auditShape(config: Config, out: HealthIssue[]): void {
  const proxies = config.profiles.filter((p) => p.kind === 'proxy');
  const routers = config.profiles.filter((p) => p.kind !== 'proxy');
  if (proxies.length === 0 && routers.length > 0) {
    out.push({
      id: 'no-proxies',
      level: 'info',
      title: 'No proxy servers are configured',
      detail: 'Switch, rule-list and alias profiles can only send traffic to a proxy that exists.',
      fix: { kind: 'open', label: 'Add one' },
    });
  }
}

export function auditConfig(config: Config, ctx: HealthContext): HealthReport {
  const issues: HealthIssue[] = [];
  for (const profile of config.profiles) {
    switch (profile.kind) {
      case 'proxy':
        auditProxy(profile, ctx, issues);
        break;
      case 'switch':
        auditSwitch(profile, issues);
        break;
      case 'rulelist':
        auditRuleList(profile, ctx, issues);
        break;
      case 'virtual':
        // Alias targets are validated by sanitizeConfig (a dangling one is
        // rewritten to Direct), and a loop is caught by auditCycles.
        break;
    }
  }
  auditCycles(config, issues);
  auditShape(config, issues);

  // Errors first, then warnings, then notes — the card is read top-down and
  // the top line should be the worst thing wrong.
  const order: Record<IssueLevel, number> = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);

  const counts: Record<IssueLevel, number> = { error: 0, warn: 0, info: 0 };
  let penalty = 0;
  for (const issue of issues) {
    counts[issue.level]++;
    penalty += WEIGHT[issue.level];
  }
  return { issues, score: Math.max(0, 100 - penalty), counts };
}

/**
 * Rule counts for the stat strip: how many rules exist, how many are live, and
 * how many will not compile. Separate from the audit because the strip wants
 * the numbers whether or not anything is wrong.
 */
export function ruleStats(config: Config): { total: number; enabled: number; invalid: number } {
  let total = 0;
  let enabled = 0;
  let invalid = 0;
  for (const p of config.profiles) {
    if (p.kind !== 'switch') continue;
    for (const rule of p.rules) {
      total++;
      if (rule.enabled) enabled++;
      if (patternError(rule)) invalid++;
    }
  }
  return { total, enabled, invalid };
}

/** Entries loaded across every rule-list profile. */
export function listedEntryCount(config: Config): number {
  let n = 0;
  for (const p of config.profiles) {
    if (p.kind === 'rulelist') n += parseRuleList(p.format, p.text).count;
  }
  return n;
}

/**
 * The set of profiles the active one can actually reach, for highlighting the
 * live path in the routing map. Built on reachableFrom so it follows the same
 * edges the compiler does.
 */
export function livePath(config: Config, activeId: string): Set<string> {
  return reachableFrom(config, activeId);
}

/**
 * True when this switch rule is currently satisfiable at all — a time or
 * weekday rule outside its window matches nothing right now. Used by the map to
 * dim edges that exist but are asleep.
 */
export function ruleActiveNow(rule: SwitchRule, now: Date): boolean {
  if (rule.type !== 'time' && rule.type !== 'weekday') return true;
  // Any URL will do: these two conditions ignore it entirely.
  return testCondition(compileRule(rule), 'http://x/', 'x', now);
}

/** Every profile that is not referenced by any other profile — the graph's roots. */
export function rootProfiles(config: Config): Profile[] {
  const referenced = new Set<string>();
  for (const p of config.profiles) {
    for (const t of referencedTargets(p)) if (t !== p.id) referenced.add(t);
  }
  return config.profiles.filter((p) => !referenced.has(p.id));
}
