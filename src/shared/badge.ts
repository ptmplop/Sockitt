import { initialsFor } from './avatar';
import { compileRule, pacRequestUrl, resolveRoute } from './match';
import { staticTerminal } from './pac';
import { TabTarget } from './tabs';
import { Config, Profile, SwitchRule, profileById } from './types';

const MINUTES_PER_DAY = 1440;

/** The badge colour for a route that carries no profile — direct, or bypassed. */
export const NEUTRAL = '#8b93a7';

/** What the per-tab route badge should read, or null when it must be cleared. */
export interface BadgePaint {
  text: string;
  color: string;
}

/**
 * Whether this tab has a per-tab route worth saying anything about — the cheap
 * half of the decision, split out so the caller can skip loading the scope's
 * temporary overrides for a tab that is going to be cleared either way. Both
 * rejections are silence, not 'DIR': under an unconditional profile the toolbar
 * icon already names the route, and a chrome:// or blank tab has none.
 */
export function badgeApplies(
  config: Config,
  active: Profile | undefined,
  page: TabTarget | null
): boolean {
  if (!active || staticTerminal(config, active) !== null) return false;
  return page !== null;
}

/**
 * The whole per-tab badge decision, as a pure function of the state it reads.
 *
 * Split out of the worker so it can be tested: everything around it in
 * updateTabBadge is chrome.* plumbing, and the parts that were wrong were the
 * parts that never ran outside a browser. Returning null means CLEAR — the
 * caller must act on it, because a tab-scoped badge outlives the navigation
 * that painted it and would otherwise sit there reading out a dead route.
 *
 * `now` is a parameter rather than an ambient read for the same reason it is
 * one in resolveRoute: `time` and `weekday` rules make the answer a function of
 * the clock, and a badge is only ever correct for the instant it was painted.
 */
export function badgePaintFor(
  config: Config,
  active: Profile | undefined,
  page: TabTarget | null,
  tempRules: SwitchRule[] = [],
  now: Date = new Date()
): BadgePaint | null {
  if (!badgeApplies(config, active, page) || !active || !page) return null;
  const route = resolveRoute(config, active, pacRequestUrl(page.url), page.host, tempRules, now);
  const target = profileById(config, route.targetId);
  // A bypassed host goes direct however it got here, so it must not keep the
  // proxy's colour: 'DIR' on the proxy's own colour is the one combination that
  // reads as "routed through it" at a glance.
  return target && !route.bypassed
    ? { text: initialsFor(target), color: target.color }
    : { text: 'DIR', color: NEUTRAL };
}

/**
 * Every minute-of-day at which some rule in `rules` starts or stops matching.
 *
 * `time` flips twice: at `from` it begins matching, and at `to + 1` it stops —
 * timeInRange is inclusive of `to`, so the last matching minute is `to` itself.
 * `weekday` flips only at midnight, when getDay() moves. Everything else is
 * URL-dependent and never changes on its own.
 */
function clockBoundaries(rules: SwitchRule[], into: Set<number>): void {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.type === 'weekday') {
      const c = compileRule(rule);
      if (c.op === 'weekday') into.add(0);
    } else if (rule.type === 'time') {
      const c = compileRule(rule);
      if (c.op !== 'time') continue; // unparseable pattern compiles inert
      into.add(c.from % MINUTES_PER_DAY);
      into.add((c.to + 1) % MINUTES_PER_DAY);
    }
  }
}

/**
 * Minutes from `now` until the next moment a clock-dependent rule reachable
 * from `liveIds` changes its answer, or null when no such rule exists.
 *
 * The badge is otherwise only ever repainted by an event, so without this a
 * route painted at 16:55 under a 09:00-17:00 rule keeps asserting that profile
 * indefinitely. Scheduling the BOUNDARY rather than polling every minute is the
 * difference between a handful of worker wake-ups a day and 1440 of them.
 */
export function minutesToNextClockChange(
  config: Config,
  liveIds: Set<string>,
  now: Date = new Date()
): number | null {
  const boundaries = new Set<number>();
  for (const p of config.profiles) {
    if (p.kind === 'switch' && liveIds.has(p.id)) clockBoundaries(p.rules, boundaries);
  }
  if (!boundaries.size) return null;
  const mins = now.getHours() * 60 + now.getMinutes();
  let best = Infinity;
  for (const b of boundaries) {
    // Strictly ahead: firing again for the boundary we just woke on would loop.
    const delta = b > mins ? b - mins : b + MINUTES_PER_DAY - mins;
    if (delta < best) best = delta;
  }
  return best;
}
