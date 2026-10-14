import { TraceEdge, hostLooksReal, pacRequestUrl, resolveRoute } from './match';
import { Config, DIRECT, SYSTEM, SwitchRule, profileById } from './types';
import { edgeRuleIndex } from './yard';

/**
 * Where a rule list's own URL is fetched through, and why.
 *
 * The fetch is an ordinary request — "Update now" on the options page, or the
 * worker's auto-update alarm — so Chrome routes it by whatever proxy setting is
 * in force, which is normally the ACTIVE profile's decision for the list's host.
 * Never the OS route as such: that applies only while System is active
 * (measured in real Chromium, 2026-10-14). This is that decision, from the same
 * resolver the PAC twin uses, so the editor can say it before anyone presses
 * the button — and a failure can say which route it failed on.
 */
export interface FetchRoute {
  /** DIRECT, SYSTEM, or the proxy profile the fetch goes through. '' when nothing can be fetched. */
  targetId: string;
  /** Completes "Fetches go … — ". Empty when the URL is empty or invalid. */
  why: string;
  /** Set when the URL cannot be fetched at all; the words say why. */
  invalid?: string;
  /** This list decides its own address — a refresh can change the next fetch's route. */
  selfRouted?: boolean;
}

/**
 * Chrome never sends these through a proxy, whatever the proxy settings say:
 * its implicit bypass rules cover localhost, *.localhost, the IPv4 loopback
 * block, ::1 and link-local addresses (measured under both fixed servers and a
 * mandatory PAC that returned a proxy — the request still went direct).
 */
export function isImplicitlyDirect(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (h === '[::1]') return true;
  // fe80::/10 — the first hextet is fe80 to febf.
  if (/^\[fe[89ab][0-9a-f]:/.test(h)) return true;
  return false;
}

/** What one decisive hop says, from the active profile's point of view. */
function hopWords(config: Config, e: TraceEdge, selfId: string | undefined): string {
  const from = profileById(config, e.from);
  const name = from?.name ?? 'the active profile';
  switch (e.kind) {
    case 'temp-rule':
      return 'an override set from the popup';
    case 'rule': {
      const n = edgeRuleIndex(config, e);
      return n >= 0 ? `rule ${n + 1} in ${name}` : `a rule in ${name}`;
    }
    case 'default':
      return `the default of ${name}`;
    case 'list-match':
      return e.from === selfId ? 'this list covers its own address' : `the list in ${name}`;
    case 'list-default':
      return e.from === selfId ? 'this list doesn’t cover its own address, so its default applies' : `the default of ${name}`;
    case 'alias':
      return `the alias ${name}`;
  }
}

/**
 * The route a fetch of `url` takes right now. `overrides` are the per-site
 * overrides on the active profile (regular windows — the worker and the options
 * page both run there); `selfId` is the rule list whose URL this is.
 */
export function listFetchRoute(
  config: Config,
  url: string,
  overrides: SwitchRule[] = [],
  selfId?: string,
  now: Date = new Date()
): FetchRoute {
  const raw = url.trim();
  if (!raw) return { targetId: '', why: '', invalid: '' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return {
      targetId: '',
      why: '',
      invalid: /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
        ? 'That address can’t be read - check it for spaces or a bad port.'
        : 'That isn’t a full address - it needs to start with https:// or http://.',
    };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { targetId: '', why: '', invalid: `Sockitt fetches lists over https:// or http:// only, not ${u.protocol}//.` };
  }
  if (!hostLooksReal(u.hostname)) {
    return { targetId: '', why: '', invalid: 'That address has no usable host name.' };
  }
  // fetch() refuses these outright, before any request is made.
  if (u.username || u.password) {
    return { targetId: '', why: '', invalid: 'Chrome won’t fetch an address with a user name or password in it - the part before the @.' };
  }
  if (isImplicitlyDirect(u.hostname)) {
    return { targetId: DIRECT, why: 'Chrome never sends a local address through a proxy' };
  }

  const activeId = config.activeId;
  if (activeId === DIRECT) return { targetId: DIRECT, why: 'Direct is the active profile' };
  if (activeId === SYSTEM) return { targetId: SYSTEM, why: 'System is the active profile' };
  const active = profileById(config, activeId);
  // The worker applies System when the active profile no longer exists.
  if (!active) return { targetId: SYSTEM, why: 'the active profile no longer exists, so your system’s settings apply' };

  const edges: TraceEdge[] = [];
  const route = resolveRoute(config, active, pacRequestUrl(u.href), u.hostname, overrides, now, edges);
  const decisive = edges.filter((e) => e.kind !== 'alias');
  const selfRouted = !!selfId && decisive.some((e) => e.from === selfId && (e.kind === 'list-match' || e.kind === 'list-default'));

  if (route.bypassed) {
    const proxy = profileById(config, route.targetId);
    return { targetId: DIRECT, why: `the host is on ${proxy?.name ?? 'the proxy'}’s bypass list`, selfRouted };
  }

  let why: string;
  if (decisive.length) {
    const hops = decisive.slice(0, 3).map((e) => hopWords(config, e, selfId));
    // Name the profile all of this hangs off on the first hop — the one it
    // belongs to — unless that hop already says so.
    const first = decisive[0]!;
    if (first.from === activeId && first.kind !== 'temp-rule' && first.from !== selfId) hops[0] += ', the active profile';
    else if (active.kind === 'virtual') hops[0] += `, through the active alias ${active.name}`;
    why = hops.join(', then ');
  } else if (active.kind === 'virtual') {
    why = `the active alias ${active.name} points there`;
  } else {
    why = 'it’s the active profile';
  }
  return { targetId: route.targetId, why, selfRouted };
}
