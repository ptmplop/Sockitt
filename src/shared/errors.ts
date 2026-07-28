import { uid } from './types';

/**
 * Proxy failure reporting: the live alert, the session-scoped error log, and
 * the vocabulary both UI surfaces render.
 *
 * Two separate things, deliberately:
 *   - the ALERT (ERROR_KEY) is "requests are failing right now". It is raised by
 *     a failure and dropped again once the failures stop, so a proxy that comes
 *     back does not leave a permanent red mark on the toolbar.
 *   - the LOG (ERROR_LOG_KEY) is the history behind it, so the options page can
 *     say what failed, when, how often, and through which server.
 *
 * Both live in chrome.storage.session: a diagnostic buffer that is gone on the
 * next browser start, and never written to disk alongside the config.
 */

/** The current unresolved failure, or absent when nothing is failing. */
export const ERROR_KEY = 'sockitt-error';
/** Newest-first history of failures this browser session. */
export const ERROR_LOG_KEY = 'sockitt-error-log';

/** Log cap. Old entries fall off the end; the newest failure always survives. */
export const MAX_ERROR_ENTRIES = 50;

/** Where the failure came from. */
export type ProxyErrorSource =
  /** chrome.proxy.onProxyError — the browser could not use the route. */
  | 'proxy'
  /** Sockitt could not apply the settings at all (a throw, or a rejected set). */
  | 'apply';

/** A proxy server, named well enough for the UI to link back to its editor. */
export interface ProxyRef {
  id: string;
  name: string;
  /** "SOCKS5 127.0.0.1:1080" */
  endpoint: string;
}

/** Everything the worker knows at the moment of a failure. */
export interface ProxyErrorEntry {
  id: string;
  /** First occurrence of this failure (ms). */
  at: number;
  /** Most recent occurrence of this same failure (ms). */
  lastAt: number;
  /** Identical repeats collapsed into one entry. */
  count: number;
  source: ProxyErrorSource;
  /** Chrome's net error code, e.g. "net::ERR_PROXY_CONNECTION_FAILED". */
  error: string;
  /** Chrome's extra detail — a PAC runtime error carries its message here. */
  details: string;
  /** Fatal errors fail the request; non-fatal ones are recoverable warnings. */
  fatal: boolean;
  /** The profile that was active when it happened ('direct' / 'system' / an id). */
  profileId: string;
  profileName: string;
  /**
   * The one server the route used, when the active profile routes everything
   * the same way. Chrome's error event names no server, so this is inferred
   * from the configuration — see describeRoute() in background.ts.
   */
  via?: ProxyRef;
  /**
   * Every server the active profile could have chosen, when it routes
   * per-request. Which one actually failed is genuinely not knowable here.
   */
  candidates?: ProxyRef[];
}

/**
 * The live alert: the newest entry plus how long the current run of failures
 * is. The streak drives the toolbar badge count and resets when the alert
 * clears, so it reads "errors happening now", not "errors ever this session".
 */
export interface ProxyAlert extends ProxyErrorEntry {
  /** Failures since this alert was raised. */
  streak: number;
  /** True once any failure in the streak was fatal — the badge follows this. */
  fatalStreak: boolean;
}

/** The fields a caller supplies; the rest are derived when the entry is stored. */
export type ProxyErrorInput = Omit<ProxyErrorEntry, 'id' | 'at' | 'lastAt' | 'count'> & {
  at: number;
};

/* ---------------- validation ---------------- */

/**
 * Session storage is ours, but not necessarily ours from THIS version: an
 * extension update leaves the previous build's records in place, and a shape
 * we no longer expect must degrade to "no data" rather than throw inside a
 * render. Everything read back goes through here.
 */
function isProxyRef(v: unknown): v is ProxyRef {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.name === 'string' && typeof o.endpoint === 'string';
}

export function asProxyErrorEntry(v: unknown): ProxyErrorEntry | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.error !== 'string' || typeof o.at !== 'number') return null;
  const candidates = Array.isArray(o.candidates) ? o.candidates.filter(isProxyRef) : undefined;
  return {
    id: typeof o.id === 'string' && o.id ? o.id : uid(),
    at: o.at,
    lastAt: typeof o.lastAt === 'number' ? o.lastAt : o.at,
    count: typeof o.count === 'number' && o.count >= 1 ? Math.floor(o.count) : 1,
    source: o.source === 'apply' ? 'apply' : 'proxy',
    error: o.error,
    details: typeof o.details === 'string' ? o.details : '',
    fatal: o.fatal !== false,
    profileId: typeof o.profileId === 'string' ? o.profileId : '',
    profileName: typeof o.profileName === 'string' && o.profileName ? o.profileName : 'Unknown',
    via: isProxyRef(o.via) ? o.via : undefined,
    candidates: candidates?.length ? candidates : undefined,
  };
}

export function asProxyAlert(v: unknown): ProxyAlert | null {
  const entry = asProxyErrorEntry(v);
  if (!entry) return null;
  const o = v as Record<string, unknown>;
  return {
    ...entry,
    streak: typeof o.streak === 'number' && o.streak >= 1 ? Math.floor(o.streak) : entry.count,
    fatalStreak: typeof o.fatalStreak === 'boolean' ? o.fatalStreak : entry.fatal,
  };
}

/* ---------------- storage ---------------- */

export async function loadErrorLog(): Promise<ProxyErrorEntry[]> {
  try {
    const stored = await chrome.storage.session.get(ERROR_LOG_KEY);
    const raw = stored[ERROR_LOG_KEY];
    if (!Array.isArray(raw)) return [];
    return raw
      .map(asProxyErrorEntry)
      .filter((e): e is ProxyErrorEntry => e !== null)
      .slice(0, MAX_ERROR_ENTRIES);
  } catch {
    return []; // session storage unavailable — the UI just shows an empty log
  }
}

export async function loadProxyAlert(): Promise<ProxyAlert | null> {
  try {
    const stored = await chrome.storage.session.get(ERROR_KEY);
    return asProxyAlert(stored[ERROR_KEY]);
  } catch {
    return null;
  }
}

/** Drop the live alert. The log is untouched — the history is the point. */
export async function clearProxyAlert(): Promise<void> {
  await chrome.storage.session.remove(ERROR_KEY).catch(() => undefined);
}

/** Drop the alert AND the history (the options page's "Clear log"). */
export async function clearErrorLog(): Promise<void> {
  await chrome.storage.session.remove([ERROR_KEY, ERROR_LOG_KEY]).catch(() => undefined);
}

/**
 * Two reports of the same problem. A dead proxy re-reports on every request, so
 * without this the log would be a hundred identical lines and the real story —
 * that it started at 14:02 and has not stopped — would be invisible.
 */
function isSameFailure(entry: ProxyErrorEntry, input: ProxyErrorInput): boolean {
  return (
    entry.source === input.source &&
    entry.error === input.error &&
    entry.details === input.details &&
    entry.profileId === input.profileId &&
    entry.via?.id === input.via?.id
  );
}

/**
 * Serialize log writes. A burst of failures arrives as separate events in the
 * same worker; each append is a read-modify-write on session storage, and
 * interleaving them would silently drop entries (and reset the streak).
 */
let writeChain: Promise<unknown> = Promise.resolve();

/** Record a failure, collapse it if it repeats, and raise/extend the alert. */
export function recordProxyError(input: ProxyErrorInput): Promise<ProxyAlert | null> {
  const next = writeChain.then(() => writeProxyError(input)).catch(() => null);
  writeChain = next;
  return next;
}

async function writeProxyError(input: ProxyErrorInput): Promise<ProxyAlert | null> {
  const [log, previous] = await Promise.all([loadErrorLog(), loadProxyAlert()]);
  const head = log[0];
  let entry: ProxyErrorEntry;
  if (head && isSameFailure(head, input)) {
    // Keep the entry's identity — its id, and the time this run started — and
    // take everything else from the NEWEST occurrence. The collapse key is
    // deliberately narrow (correcting a port is the same failure recurring, not
    // a new one), so the entry has to carry today's address, today's candidate
    // set and today's profile name; otherwise the page that exists to name the
    // failing server would point at one the user has already fixed.
    entry = {
      ...input,
      id: head.id,
      at: head.at,
      lastAt: input.at,
      count: head.count + 1,
      // Severity is the exception: it accumulates rather than being replaced, so
      // a line that includes a hard failure can never be relabelled a warning.
      fatal: head.fatal || input.fatal,
    };
    log[0] = entry;
  } else {
    entry = { ...input, id: uid(), lastAt: input.at, count: 1 };
    log.unshift(entry);
    if (log.length > MAX_ERROR_ENTRIES) log.length = MAX_ERROR_ENTRIES;
  }
  const alert: ProxyAlert = {
    ...entry,
    // Continue the run only while an alert is actually live: once it has been
    // cleared (the quiet period elapsed, or a re-apply), the next failure is a
    // new incident and counts from one.
    streak: (previous?.streak ?? 0) + 1,
    fatalStreak: (previous?.fatalStreak ?? false) || input.fatal,
  };
  await chrome.storage.session.set({ [ERROR_LOG_KEY]: log, [ERROR_KEY]: alert });
  return alert;
}

/* ---------------- presentation ---------------- */

/**
 * Toolbar badge text for a run of failures. A single error is just "!" — the
 * familiar something-is-wrong mark; the number appears only once it adds
 * information (it is repeating), and saturates at 9+ because the badge fits
 * about four characters.
 */
export function badgeTextFor(streak: number): string {
  if (streak <= 1) return '!';
  return streak < 10 ? `!${streak}` : '!9+';
}

/** The failure's headline: a net:: code, or plain text for an apply failure. */
export function errorHeadline(entry: ProxyErrorEntry): string {
  return entry.source === 'apply' ? 'Could not apply the proxy settings' : entry.error;
}

/**
 * Headline plus the specifics, for the one-line surfaces that have no room for
 * a second row — the toolbar tooltip and the popup indicator. Capped, because
 * a PAC runtime error's detail can run to several lines and Chrome truncates a
 * long title mid-word rather than telling you it did.
 */
export function errorSummaryLine(entry: ProxyErrorEntry, max = 120): string {
  const headline = errorHeadline(entry);
  const full = entry.details && entry.details !== headline ? `${headline} — ${entry.details}` : headline;
  return full.length > max ? `${full.slice(0, max - 1)}…` : full;
}

/**
 * Plain-English meaning and next step for the codes a proxy actually produces.
 * Matched on a substring so Chrome variants ("net::ERR_..." vs bare "ERR_...")
 * both land, and unknown codes fall through to null rather than to a guess.
 */
const ERROR_ADVICE: Array<[string, string]> = [
  [
    'ERR_PROXY_CONNECTION_FAILED',
    'The browser could not reach the proxy server at all. Check the host and port, that the server is actually running, and that nothing in between (a firewall, a VPN, an SSH tunnel that has dropped) is blocking it.',
  ],
  [
    'ERR_TUNNEL_CONNECTION_FAILED',
    'The proxy answered but refused to open a tunnel to the site — typically an HTTP(S) proxy that blocks CONNECT to that host or port, or one that needs credentials.',
  ],
  [
    'ERR_PROXY_AUTH_UNSUPPORTED',
    'The proxy demanded an authentication scheme the browser will not use over this protocol. SOCKS proxies cannot be authenticated by Chromium at all — use an IP allow-list or a local tunnel instead.',
  ],
  [
    'ERR_PROXY_AUTH_REQUESTED',
    'The proxy asked for a username and password. Set them in the proxy profile — and grant the authentication permission when Sockitt asks, or the challenge goes unanswered.',
  ],
  [
    'ERR_PROXY_CERTIFICATE_INVALID',
    'An HTTPS proxy presented a certificate the browser rejected. Check the certificate and that the host matches the one it was issued for.',
  ],
  [
    'ERR_PAC_SCRIPT_FAILED',
    'The generated routing script threw while deciding a route. This points at a rule pattern rather than at the server — the detail below usually names it, and the Route inspector will reproduce it.',
  ],
  [
    'ERR_PAC_STATUS_NOT_OK',
    'The routing script could not be loaded. If a System profile is active, the PAC URL configured in your operating system is the one failing.',
  ],
  [
    'ERR_MANDATORY_PROXY_CONFIGURATION_FAILED',
    'The route could not be used and Sockitt routes are mandatory, so the requests failed instead of quietly going direct. That part is by design — it is what stops a dead proxy leaking your traffic.',
  ],
  [
    'ERR_SOCKS_CONNECTION_HOST_UNREACHABLE',
    'The SOCKS proxy is up but could not reach the destination host from its side.',
  ],
  [
    'ERR_SOCKS_CONNECTION_FAILED',
    'The SOCKS handshake failed. Check the protocol version (SOCKS5 vs SOCKS4) and that the server really is a SOCKS proxy on that port.',
  ],
  [
    'ERR_NAME_NOT_RESOLVED',
    'The proxy hostname did not resolve. Check it for a typo, or use its IP address.',
  ],
  [
    'ERR_CONNECTION_TIMED_OUT',
    'The proxy accepted nothing in time. It may be overloaded, or reachable only from another network.',
  ],
  ['ERR_TIMED_OUT', 'The connection to the proxy timed out.'],
  [
    'ERR_CONNECTION_REFUSED',
    'The proxy host is reachable but nothing is listening on that port. Check the port, and that the proxy process is running.',
  ],
];

export function errorAdvice(entry: ProxyErrorEntry): string | null {
  if (entry.source === 'apply') {
    return 'Sockitt could not hand these settings to the browser, so the previous route is still in force. This usually means a profile is malformed — an empty proxy host, or a rule the compiler rejected.';
  }
  const code = entry.error.toUpperCase();
  return ERROR_ADVICE.find(([needle]) => code.includes(needle))?.[1] ?? null;
}

/** "Bangkok — SOCKS5 203.0.113.42:1080" */
export function describeRef(ref: ProxyRef): string {
  return `${ref.name} — ${ref.endpoint}`;
}

/**
 * True when the active profile IS the proxy that failed — the common case of a
 * plain proxy profile. Worth knowing: rendering it as a hop ("Frankfurt →
 * Frankfurt") reads like a misprint.
 */
export function viaIsSelf(entry: ProxyErrorEntry): boolean {
  return entry.via?.id === entry.profileId;
}

/** One line naming the route that was carrying traffic. */
export function describeCarrier(entry: ProxyErrorEntry): string {
  if (entry.via) {
    return viaIsSelf(entry) ? describeRef(entry.via) : `${entry.profileName} → ${describeRef(entry.via)}`;
  }
  if (entry.candidates?.length) {
    return `${entry.profileName} (routes per request; ${entry.candidates.length} possible server${
      entry.candidates.length === 1 ? '' : 's'
    })`;
  }
  return entry.profileName;
}

/**
 * A plain-text report for a bug report or a support thread. Deliberately
 * includes the proxy host and port — that is what makes it useful — and just as
 * deliberately never any credential, which no entry carries in the first place.
 */
export function formatErrorReport(
  entries: ProxyErrorEntry[],
  alert: ProxyAlert | null,
  version: string
): string {
  const stamp = (ms: number): string => new Date(ms).toISOString();
  const lines = [
    `Sockitt proxy error log (v${version || 'unknown'})`,
    `generated ${stamp(Date.now())}`,
    alert
      ? `status: failing — ${alert.streak} error${alert.streak === 1 ? '' : 's'} since ${stamp(alert.at)}`
      : 'status: no active proxy errors',
    `entries: ${entries.length}`,
    '',
  ];
  for (const e of entries) {
    lines.push(
      `[${stamp(e.at)}] ${errorHeadline(e)}${e.count > 1 ? ` (×${e.count}, last ${stamp(e.lastAt)})` : ''}`,
      `  route: ${describeCarrier(e)}`,
      ...(e.candidates?.length ? e.candidates.map((c) => `    candidate: ${describeRef(c)}`) : []),
      ...(e.details ? [`  detail: ${e.details}`] : []),
      `  fatal: ${e.fatal}`,
      ''
    );
  }
  return lines.join('\n');
}
