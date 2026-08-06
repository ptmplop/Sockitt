import { initialsFor, textColorFor } from './shared/avatar';
import { NEUTRAL, badgeApplies, badgePaintFor, minutesToNextClockChange } from './shared/badge';
import { pacRequestUrl, resolveRoute } from './shared/match';
import { compilePac, fixedServersValue, pacDirective, staticTerminal } from './shared/pac';
import { RULE_LIST_MAX_BYTES } from './shared/rulelist';
import { livePath } from './shared/health';
import { incognitoActiveId } from './shared/scope';
import {
  APPLIED_KEY,
  CONTROL_KEY,
  PENDING_RELOAD_KEY,
  POPUP_PORT,
  RELOAD_KEY,
  TAB_EXIT_KEY,
  TAB_EXIT_RESULT_KEY,
  TEST_KEY,
  TEST_RESULT_KEY,
  loadConfig,
  loadTempRules,
  onConfigChanged,
  onTempRulesChanged,
  recordActivation,
  saveConfig,
  saveConfigRaw,
} from './shared/state';
import {
  ERROR_KEY,
  ProxyErrorSource,
  ProxyRef,
  asProxyAlert,
  badgeTextFor,
  clearProxyAlert,
  errorSummaryLine,
  loadProxyAlert,
  recordProxyError,
} from './shared/errors';
import { EXIT_IP_URL, checkExitIp } from './shared/exitip';
import { tabTarget } from './shared/tabs';
import { applyFromSync, onSyncChanged, pullFromSync, pushToSync } from './shared/sync';
import {
  Config,
  DIRECT,
  Profile,
  ProxyProfile,
  ProxyScheme,
  SCHEME_LABELS,
  SYSTEM,
  SwitchRule,
  TABS_PERMS,
  profileById,
  proxyProfiles,
  reachableFrom,
  schemeSupportsAuth,
} from './shared/types';
import { clearPendingUpdate, savePendingUpdate } from './shared/update';

const DANGER = '#f5576c';
const REVERT_COOLDOWN_MS = 30_000;
const ALARM_PREFIX = 'rl:';

let lastRevert = 0;
let lastActiveId: string | undefined;
/** The incognito scope's profile as last applied — see the reload in applyActiveInner. */
let lastIncognitoId: string | undefined;
/**
 * Open popup lifetime ports. A count, not a flag: when this worker is recycled
 * the popup reconnects, and the new port can arrive before the dead one's
 * disconnect is delivered — a flag would read "closed" for that overlap and let
 * a reload through.
 */
let popupPorts = 0;
/** Most recently applied config; lets tab events gate without a storage read. */
let cachedConfig: Config | null = null;
/**
 * Serialises applies. Nothing else did: every entry point was a bare
 * `void applyActive()`, so a rule-list alarm, a sync pull and a user switch
 * could run concurrently, each having snapshotted config at a different moment.
 * The proxy settled correctly (last write wins, and they converge), but each
 * run also repaints the badge from its OWN snapshot — so the run that STARTED
 * first could finish last and repaint a route the user had already changed.
 * Chaining makes the last apply to start the last to finish, which is the only
 * ordering under which its snapshot is by definition the current one. Same
 * shape as the history and error-log write chains elsewhere in the codebase.
 */
let applyChain: Promise<void> = Promise.resolve();

/**
 * Queue an apply behind any already in flight. See applyChain.
 *
 * The testInFlight check has to happen HERE, at dequeue time, not at the call
 * site: a queued apply may wait behind a long-running one, and a probe can
 * start in that gap. Running it then would stomp the probe's PAC with the real
 * configuration mid-measurement. Deferring to reapplyAfterTest is exactly what
 * the probe's own `finally` is written to pick up.
 */
function queueApply(): Promise<void> {
  applyChain = applyChain
    .then(() => {
      if (testInFlight) {
        reapplyAfterTest = true;
        return;
      }
      return applyActive();
    })
    .catch(() => undefined);
  return applyChain;
}

/* ---------------- proxy application ---------------- */

function hasBypass(bypass: string[]): boolean {
  return bypass.some((b) => b.trim().length > 0);
}

/**
 * What a scope's activeId is CALLED, and the profile behind it — the toolbar's
 * half of settingsValueFor, split out because painting an icon shouldn't have to
 * compile a PAC to learn a name. settingsValueFor is built on it, so the two
 * can't drift into naming the same route differently.
 */
function labelFor(config: Config, activeId: string): { label: string; profile: Profile | null } {
  if (activeId === DIRECT) return { label: 'Direct', profile: null };
  if (activeId === SYSTEM) return { label: 'System', profile: null };
  const profile = profileById(config, activeId);
  return profile ? { label: profile.name, profile } : { label: 'System', profile: null };
}

function settingsValueFor(
  config: Config,
  tempRules: SwitchRule[]
): { value: chrome.proxy.ProxyConfig; label: string; profile: Profile | null } {
  const { activeId } = config;
  const { label, profile } = labelFor(config, activeId);
  // Direct, System, or an activeId naming a profile that is gone (System too).
  if (!profile) {
    return { value: activeId === DIRECT ? { mode: 'direct' } : { mode: 'system' }, label, profile };
  }

  const terminal = staticTerminal(config, profile);
  if (terminal === 'direct') {
    return { value: { mode: 'direct' }, label: profile.name, profile };
  }
  // A proxy with an empty bypass list can take the fast fixed_servers path.
  // With a bypass list, compile a PAC instead so bypass entries mean the same
  // thing regardless of how the profile was reached (Chrome-native bypass
  // semantics differ from Sockitt's PAC semantics).
  if (terminal && !hasBypass(terminal.bypass)) {
    return {
      value: fixedServersValue(terminal.scheme, terminal.host, terminal.port, terminal.bypass),
      label: profile.name,
      profile,
    };
  }
  return {
    value: {
      mode: 'pac_script',
      pacScript: { data: compilePac(config, profile, tempRules), mandatory: true },
    },
    label: profile.name,
    profile,
  };
}

/**
 * Apply, unless a connection test is running — its proxy must not be stomped
 * mid-probe. The test's finally re-applies fresh config afterward, so any
 * change that arrives during the test is still reflected.
 */
function applyActiveGuarded(): void {
  if (testInFlight) {
    reapplyAfterTest = true; // the test's finally re-applies fresh config
    // The badge is not the proxy's to hold. It is pure chrome.action state and
    // touches nothing a probe owns, but deferring it with the apply left it
    // contradicting the popup's own Route readout for the length of the probe —
    // and the popup fires one on open and after every override edit, which is
    // exactly when the badge is being read.
    void loadConfig()
      .then((c) => {
        cachedConfig = c;
        return refreshActiveTabBadge(c);
      })
      .catch(() => undefined);
    return;
  }
  void queueApply();
}

/**
 * Surface a failure to apply the proxy so it can never be a silent fail-open.
 * Without this, a throw in settingsValueFor/compilePac (e.g. a malformed host
 * or rule) or a rejected settings.set would leave chrome.proxy on the previous
 * route while the popup still shows the newly-selected profile as active.
 * Recorded exactly like a proxy error, so it lands in the same log and the same
 * badge — a route that never applied and a route that fails are, to the user,
 * the same problem.
 */
async function recordApplyError(e: unknown): Promise<void> {
  const message = e instanceof Error ? e.message : String(e);
  console.error('Sockitt: could not apply proxy settings —', e);
  // The message goes in BOTH fields on purpose: `error` is the collapse key, so
  // two different throws stay two entries, and `details` is what every surface
  // actually renders under the headline. Without the second the thrown reason —
  // often the only thing naming the bad field — would be stored and shown nowhere.
  await raiseProxyError({ source: 'apply', error: message, details: message, fatal: true });
}

/**
 * `signal` (default true) writes APPLIED_KEY so open UI re-checks the route.
 * A tab-exit probe restores the route with signal:false — it returns to the
 * pre-probe route, so it's not a change; signalling would make the popup
 * re-check → re-probe → restore → signal … in an endless proxy-churn loop.
 */
async function applyActive(signal = true): Promise<void> {
  try {
    await applyActiveInner(signal);
  } catch (e) {
    await recordApplyError(e);
  }
}

async function applyActiveInner(signal = true): Promise<void> {
  const config = await loadConfig();
  cachedConfig = config;
  const tempRules = await loadTempRules(config.activeId, 'regular');
  const { value, label, profile } = settingsValueFor(config, tempRules);

  await chrome.proxy.settings.set({ value, scope: 'regular' });
  await applyIncognito(config);
  const pinned = await actionIsPinned();

  // Independent action/session updates — no ordering dependency between them.
  // APPLIED_KEY lands after settings.set above, so a popup exit-IP check it
  // triggers rides the NEW route, never the one being replaced.
  await Promise.all([
    chrome.storage.session.remove(ERROR_KEY),
    signal
      ? chrome.storage.session.set({ [APPLIED_KEY]: { activeId: config.activeId, at: Date.now() } })
      : Promise.resolve(),
    chrome.action.setBadgeText({ text: '' }),
    chrome.action.setTitle({ title: pinned ? `Sockitt — ${label}` : 'Sockitt' }),
    paintIcon(pinned ? profile : null),
    chrome.action.setPopup({ popup: config.settings.quickSwitch ? '' : 'popup.html' }),
    // Independent of the global paint above rather than sequenced after it: a
    // tab's own icon is separate state, and wins wherever it is set.
    paintScopedTabs(config, pinned),
  ]);

  // The session timeline reads this. Appended after settings.set, so it records
  // routes that were actually applied rather than ones we tried to apply;
  // repeats of the same profile are dropped by recordActivation itself.
  await recordActivation(config.activeId, Date.now());

  const current = await chrome.proxy.settings.get({});
  await publishControl(current.levelOfControl);
  if (current.levelOfControl === 'controlled_by_other_extensions') {
    await chrome.action.setBadgeBackgroundColor({ color: DANGER });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setTitle({
      title: `Sockitt — ${label} (another extension is controlling the proxy)`,
    });
  }

  // Reload the active tab only when the *active profile* actually changed and
  // the setting is on — done here, after proxy.settings.set, so the reload
  // can't race ahead of the new route (the old popup-side reload could).
  const switched = lastActiveId !== undefined && lastActiveId !== config.activeId;
  lastActiveId = config.activeId;

  // The incognito scope switches on its own — from the popup in an incognito
  // window, or from Settings — and that is a route change like any other, so
  // "reload after switching" has to answer for it too. Tracked separately
  // because activeId doesn't move when it happens.
  const incognitoId = config.settings.incognitoProfileId;
  const incognitoSwitched = lastIncognitoId !== undefined && lastIncognitoId !== incognitoId;
  lastIncognitoId = incognitoId;

  // Which windows the change actually reached. A regular switch reaches
  // incognito windows too while they follow the regular profile; once they have
  // a profile of their own the two scopes move independently, and reloading a
  // window on the other one would discard a page for a route change it never saw.
  let only: 'regular' | 'incognito' | undefined;
  if (incognitoSwitched && !switched) only = 'incognito';
  else if (switched && !incognitoSwitched && incognitoId) only = 'regular';

  // A this-tab override/rule/bypass change (from the popup) also alters how the
  // active tab routes, but leaves activeId unchanged — so `switched` misses it.
  // The popup sets RELOAD_KEY for those; honour it here, after settings.set, so
  // the re-fetch rides the new route. Consume it unconditionally so it can't
  // linger. Both signals resolve to at most ONE action on the tab: they mean the
  // same tab, and reloading it twice is just a second flash of the same page.
  const reloadStore = await chrome.storage.session.get(RELOAD_KEY);
  const request = reloadStore[RELOAD_KEY] as Record<string, unknown> | undefined;
  if (request) await chrome.storage.session.remove(RELOAD_KEY);
  const retryUrl = navigableUrl(request?.url);
  if (retryUrl) {
    // A re-navigation is honoured whatever refreshOnSwitch says: the popup only
    // asks for one when the page never loaded, so there is no page to disturb —
    // and without it the rule just added wouldn't be tried until the request
    // that is hanging right now finally gives up. It also subsumes the switch
    // reload: re-issuing the navigation is the stronger of the two.
    await reloadActiveTab({
      tabId: typeof request?.tabId === 'number' ? request.tabId : undefined,
      url: retryUrl,
    });
  } else if (config.settings.refreshOnSwitch && (switched || incognitoSwitched || request)) {
    await reloadActiveTab({ only });
  }

  rebuildCredentials(config);
  registerAuthListener();
  await refreshActiveTabBadge(config);
  await scheduleBadgeClock(config);
  await scheduleRuleListUpdates(config);
  if (config.settings.syncEnabled) await pushToSync(config);
}

/**
 * Republish who Chrome says owns the proxy settings.
 *
 * The worker already reads levelOfControl after every apply, and already badges
 * the toolbar when another extension has taken over — but until now nothing
 * said so anywhere a user would look. UI pages never call chrome.proxy
 * themselves (the worker is the sole caller, by design), so the answer rides
 * session storage like every other worker→UI signal.
 */
async function publishControl(level: string | undefined): Promise<void> {
  await chrome.storage.session
    .set({ [CONTROL_KEY]: { level: level ?? 'unknown', at: Date.now() } })
    .catch(() => undefined);
}

/* ---------------- proxy failure reporting ---------------- */

/**
 * One-shot timer that ends an incident. Named (not prefixed with ALARM_PREFIX)
 * so scheduleRuleListUpdates, which only manages "rl:" alarms, leaves it alone.
 */
const ERROR_DECAY_ALARM = 'sockitt-error-decay';
/**
 * Repaints the route badge on a clock boundary — see scheduleBadgeClock. Named
 * outside ALARM_PREFIX so scheduleRuleListUpdates, which clears every "rl:"
 * alarm it does not want, leaves it alone.
 */
const BADGE_CLOCK_ALARM = 'sockitt-badge-clock';
/**
 * No further failure for this long and the alert — badge count included — is
 * dropped. Nothing else tells us a proxy started working again: Chrome reports
 * failures, never recoveries. So "the failures stopped" is the signal, and a
 * still-broken proxy simply re-raises on its next request.
 */
const ERROR_QUIET_MS = 30_000;
/** Precise, worker-lifetime half of the decay pair — see armErrorDecay. */
let decayTimer: ReturnType<typeof setTimeout> | undefined;

function proxyRef(p: ProxyProfile): ProxyRef {
  return { id: p.id, name: p.name, endpoint: `${SCHEME_LABELS[p.scheme]} ${p.host}:${p.port}` };
}

/** The active profile's display name, without compiling a PAC just to get it. */
function activeLabel(config: Config): string {
  if (config.activeId === DIRECT) return 'Direct';
  return profileById(config, config.activeId)?.name ?? 'System';
}

/**
 * Who was carrying traffic when a failure happened. Chrome's proxy error event
 * names no server at all, so this is the honest best answer: the active
 * profile, plus EITHER the single server it sends everything through, OR the
 * set of servers it could have picked for that particular request. Guessing one
 * of the latter would be worse than saying there are several.
 */
function describeRoute(config: Config): {
  profileId: string;
  profileName: string;
  via?: ProxyRef;
  candidates?: ProxyRef[];
} {
  const { activeId } = config;
  if (activeId === DIRECT) return { profileId: DIRECT, profileName: 'Direct' };
  const profile = profileById(config, activeId);
  if (activeId === SYSTEM || !profile) return { profileId: SYSTEM, profileName: 'System' };

  const base = { profileId: profile.id, profileName: profile.name };
  const terminal = staticTerminal(config, profile);
  if (terminal && terminal !== 'direct') return { ...base, via: proxyRef(terminal) };
  if (terminal === 'direct') return base; // unconditionally direct — no server involved

  const reachable = reachableFrom(config, profile.id);
  const candidates = proxyProfiles(config)
    .filter((p) => reachable.has(p.id))
    .map(proxyRef);
  return candidates.length ? { ...base, candidates } : base;
}

/** Record a failure, extend the incident, and paint the toolbar. */
async function raiseProxyError(input: {
  source: ProxyErrorSource;
  error: string;
  details: string;
  fatal: boolean;
}): Promise<void> {
  try {
    // cachedConfig is null on a worker woken BY this very event; fall back to a
    // read, and to an unnamed route if even that fails — a failure must be
    // reported whether or not we can say what was carrying it.
    const config = cachedConfig ?? (await loadConfig().catch(() => null));
    const route = config ? describeRoute(config) : { profileId: '', profileName: 'Unknown' };
    const alert = await recordProxyError({ ...input, ...route, at: Date.now() });
    if (!alert) return;
    // Re-arm before painting: if the paint throws, the incident must still be
    // able to end on its own.
    await armErrorDecay();
    // Non-fatal proxy errors are recoverable warnings; they belong in the log
    // and the popup, but they do not earn a red toolbar badge on their own.
    if (!alert.fatalStreak) return;
    const suffix = alert.streak > 1 ? ` ×${alert.streak}` : '';
    await Promise.allSettled([
      chrome.action.setBadgeBackgroundColor({ color: DANGER }),
      chrome.action.setBadgeText({ text: badgeTextFor(alert.streak) }),
      chrome.action.setTitle({ title: `Sockitt — proxy error${suffix}: ${errorSummaryLine(alert)}` }),
    ]);
  } catch {
    // Reporting a failure must never itself become a failure path.
  }
}

/**
 * Push the end-of-incident deadline out. Two timers, deliberately:
 *   - the ALARM survives the worker being suspended. A lone setTimeout would
 *     die with it and leave the badge stuck on forever, which is the bug this
 *     whole path exists to fix.
 *   - the TIMEOUT is the exact one. chrome.alarms clamps a short delay to 30s
 *     on Chrome 120+ and to a full minute on older builds, and a count that
 *     lingers a minute after the proxy recovered is its own kind of confusion.
 * Whichever fires first wins; decayProxyAlert is idempotent, so the loser is a
 * no-op. create() with the same name replaces any pending alarm.
 */
function armErrorDecay(): Promise<void> {
  clearTimeout(decayTimer);
  decayTimer = setTimeout(() => void decayProxyAlert(), ERROR_QUIET_MS);
  return chrome.alarms.create(ERROR_DECAY_ALARM, {
    delayInMinutes: ERROR_QUIET_MS / 60_000,
  });
}

/** The quiet period elapsed: if nothing failed meanwhile, the incident is over. */
async function decayProxyAlert(): Promise<void> {
  const alert = await loadProxyAlert();
  if (!alert) return; // already cleared by a re-apply, or dismissed
  if (Date.now() - alert.lastAt < ERROR_QUIET_MS) {
    await armErrorDecay(); // a newer failure landed — start the wait again
    return;
  }
  clearTimeout(decayTimer);
  // The storage listener below repaints the toolbar, so every path that clears
  // the alert (here, a re-apply, or Dismiss on the options page) converges.
  await clearProxyAlert();
}

/**
 * Repaint the toolbar once the alert is gone. Derives the badge from the live
 * state rather than blindly clearing it, so it cannot race a concurrent apply
 * into showing "all fine" when another extension has taken proxy control, or
 * when a fresh failure arrived while this was in flight.
 */
async function restoreBadgeAfterAlert(): Promise<void> {
  try {
    const config = cachedConfig ?? (await loadConfig());
    const label = activeLabel(config);
    const current = await chrome.proxy.settings.get({});
    if (current.levelOfControl === 'controlled_by_other_extensions') {
      await chrome.action.setBadgeBackgroundColor({ color: DANGER });
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setTitle({
        title: `Sockitt — ${label} (another extension is controlling the proxy)`,
      });
      return;
    }
    if (await loadProxyAlert()) return; // a new failure landed; it owns the badge
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: `Sockitt — ${label}` });
    await refreshActiveTabBadge(config);
  } catch {
    // Storage or the action API unavailable — the next apply repaints anyway.
  }
}

/* ---------------- proxy authentication (http/https, optional perms) ---------------- */

const credByEndpoint = new Map<string, { username: string; password: string }>();
/** false until the map reflects stored config in THIS worker instance. */
let credsLoaded = false;
/**
 * requestIds already answered once. Chrome re-fires onAuthRequired for the
 * same request when the supplied credentials are rejected — answering again
 * with the same pair would loop forever and suppress the browser's own
 * dialog, so a repeat challenge gets {} and the user can type a correction.
 */
const answeredChallenges = new Set<string>();
const MAX_TRACKED_CHALLENGES = 500;

/**
 * Endpoint→credentials for every http/https proxy that has credentials. Keys
 * are lowercased: challenger.host arrives canonicalized, while profile.host
 * is whatever the user typed.
 */
function rebuildCredentials(config: Config): void {
  credByEndpoint.clear();
  for (const p of proxyProfiles(config)) {
    if (schemeSupportsAuth(p.scheme) && (p.username || p.password)) {
      credByEndpoint.set(`${p.host.trim().toLowerCase()}:${p.port}`, {
        username: p.username ?? '',
        password: p.password ?? '',
      });
    }
  }
  credsLoaded = true;
}

function credentialsFor(challenger: {
  host: string;
  port: number;
}): { username: string; password: string } | undefined {
  return credByEndpoint.get(`${challenger.host.toLowerCase()}:${challenger.port}`);
}

/**
 * asyncBlocking: the handler may respond after a storage read, so a freshly
 * woken worker (whose in-memory map is empty) can still answer the very
 * challenge that woke it.
 */
function onAuthRequired(
  details: chrome.webRequest.OnAuthRequiredDetails,
  asyncCallback?: (response: chrome.webRequest.BlockingResponse) => void
): chrome.webRequest.BlockingResponse | undefined {
  // asyncBlocking delivers the answer via the callback; the return value is
  // ignored. respond() returns undefined so `return respond(...)` typechecks.
  const respond = (r: chrome.webRequest.BlockingResponse): undefined => {
    asyncCallback?.(r);
    return undefined;
  };
  if (!details.isProxy || !details.challenger) return respond({});
  // Keyed on request AND challenger: a repeat from the same proxy means our
  // credentials were rejected, but a redirect that crosses onto a second
  // authenticating proxy re-uses the requestId and still deserves an answer.
  const challengeKey = `${details.requestId}|${details.challenger.host}:${details.challenger.port}`;
  if (answeredChallenges.has(challengeKey)) return respond({}); // rejected creds — don't loop
  if (answeredChallenges.size >= MAX_TRACKED_CHALLENGES) {
    // Evict only the oldest marker (Sets iterate in insertion order): a
    // wholesale clear would forget in-flight challenges mid-burst and let a
    // rejected pair be re-answered.
    const oldest = answeredChallenges.values().next().value;
    if (oldest !== undefined) answeredChallenges.delete(oldest);
  }
  answeredChallenges.add(challengeKey);
  if (credsLoaded) {
    const cred = credentialsFor(details.challenger);
    return respond(cred ? { authCredentials: cred } : {});
  }
  void loadConfig()
    .then((config) => {
      rebuildCredentials(config);
      const cred = credentialsFor(details.challenger!);
      respond(cred ? { authCredentials: cred } : {});
    })
    // A dropped callback would hold the request forever under asyncBlocking.
    .catch(() => respond({}));
}

/**
 * Register at the worker's top level, in the first synchronous turn — MV3
 * only wakes a suspended worker for events whose listeners were registered
 * there. chrome.webRequest exists only once the optional permission has been
 * granted (in a past or current session); until then this is a silent no-op
 * and the permissions.onAdded hook below retries after a grant.
 */
function registerAuthListener(): void {
  try {
    if (!chrome.webRequest?.onAuthRequired) return;
    if (chrome.webRequest.onAuthRequired.hasListener(onAuthRequired)) return;
    chrome.webRequest.onAuthRequired.addListener(
      onAuthRequired,
      { urls: ['<all_urls>'] },
      ['asyncBlocking']
    );
  } catch {
    // API surface incomplete (e.g. webRequestAuthProvider missing) — the
    // options page only ever requests the permissions together, so retrying
    // on the next grant is enough.
  }
}

/** After a revoke→re-grant the old registration may be dead; start fresh. */
function reregisterAuthListener(): void {
  try {
    chrome.webRequest?.onAuthRequired?.removeListener(onAuthRequired);
  } catch {
    // never registered
  }
  registerAuthListener();
}

/**
 * Incognito windows can follow their own profile (settings.incognitoProfileId,
 * '' = same as regular). Needs "Allow in Incognito" at chrome://extensions;
 * without it the regular settings span incognito as before.
 *
 * Relies on the manifest's default "incognito": spanning mode — the single
 * worker sees incognito auth challenges too. Switching to "split" would
 * silently break proxy auth for incognito windows.
 *
 * The overrides compiled in are the incognito scope's own (see shared/scope):
 * one set of temporary rules driving both scopes would carry a route chosen in
 * an incognito window over into regular ones.
 */
async function applyIncognito(config: Config): Promise<void> {
  try {
    const allowed = await chrome.extension.isAllowedIncognitoAccess();
    if (!allowed) return;
    const id = incognitoActiveId(config, allowed);
    if (!id) {
      await chrome.proxy.settings.clear({ scope: 'incognito_persistent' });
    } else {
      const tempRules = await loadTempRules(id, 'incognito');
      const { value } = settingsValueFor({ ...config, activeId: id }, tempRules);
      await chrome.proxy.settings.set({ value, scope: 'incognito_persistent' });
    }
  } catch {
    // Incognito access revoked mid-flight or scope unsupported — regular
    // settings keep spanning incognito, which is the pre-feature behavior.
  }
}

/* ---------------- on-demand proxy test (options page "Test connection") ---------------- */

let testInFlight = false;
/** A config/temp-rule change arrived while a test held the proxy; re-apply after. */
let reapplyAfterTest = false;
/** Epoch ms until which proxy-error events are ignored (see runProxyTest). */
let suppressProxyErrorsUntil = 0;
/**
 * Set while a test proxy is applied. If the worker dies mid-test (crash, not
 * idle suspension — the in-flight fetch keeps it alive), the temporary proxy
 * would outlive it; the top-level wake check below restores from this marker.
 */
const TESTING_KEY = 'sockitt-testing';

/**
 * Briefly route ALL traffic through the profile under test (no bypass, so the
 * probe definitely traverses it), measure an exit-IP lookup, then restore the
 * real configuration via applyActive. Session-storage in/out because UI pages
 * never touch chrome.proxy directly.
 */
async function runProxyTest(req: {
  profileId: string;
  nonce: number;
  scheme?: ProxyScheme;
  host?: string;
  port?: number;
}): Promise<void> {
  if (testInFlight) {
    // Answer rather than silently drop — the options page disabled its button
    // and is waiting for a result.
    await chrome.storage.session
      .set({
        [TEST_RESULT_KEY]: {
          nonce: req.nonce,
          profileId: req.profileId,
          ok: false,
          error: 'another test is already running',
        },
      })
      .catch(() => undefined);
    return;
  }
  testInFlight = true;
  // Page traffic routed through the (possibly dead) test proxy will emit
  // proxy errors; suppress the error banner/badge for the window so a late
  // event can't paint a false failure over the restored config.
  suppressProxyErrorsUntil = Date.now() + 12_000;
  const result: Record<string, unknown> = { nonce: req.nonce, profileId: req.profileId, ok: false };
  try {
    const config = await loadConfig();
    // Master privacy switch: never contact ipconfig.is when the user has it off.
    if (!config.settings.exitIpCheck) throw new Error('IP lookups are turned off in Settings');
    const profile = profileById(config, req.profileId);
    if (!profile || profile.kind !== 'proxy') throw new Error('profile not found');
    // The request carries the editor's current (possibly unsaved) values so a
    // test needs no config save — which is what previously kicked off a racing
    // applyActive. While testInFlight is set, every applyActive is deferred
    // (see applyActiveGuarded), so nothing else touches the regular scope
    // during the probe; the finally restores the real route afterward.
    const scheme = req.scheme ?? profile.scheme;
    const host = req.host ?? profile.host;
    const port = req.port ?? profile.port;
    await chrome.storage.session.set({ [TESTING_KEY]: true });
    await chrome.proxy.settings.set({
      value: fixedServersValue(scheme, host, port, []),
      scope: 'regular',
    });
    const applied = await chrome.proxy.settings.get({});
    if (applied.levelOfControl === 'controlled_by_other_extensions') {
      throw new Error('another extension controls the proxy settings');
    }
    const info = await checkExitIp(8000);
    Object.assign(result, { ok: true, ...info });
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  } finally {
    // testInFlight stays true across the restore so a second test can't race
    // it; applyActive loads fresh config, so a change deferred during the test
    // is captured here. reapplyAfterTest covers a change that lands during the
    // restore itself. Keep suppressing errors briefly for in-flight requests.
    suppressProxyErrorsUntil = Date.now() + 3000;
    reapplyAfterTest = false;
    await applyActive().catch(() => undefined);
    await chrome.storage.session.remove(TESTING_KEY).catch(() => undefined);
    testInFlight = false;
    if (reapplyAfterTest) void queueApply();
  }
  try {
    await chrome.storage.session.set({ [TEST_RESULT_KEY]: result });
  } catch {
    // session storage unavailable — the options page just never hears back
  }
}

/** PAC return directive for a resolved route: the terminal proxy's, or DIRECT. */
function probeDirectiveFor(config: Config, route: { targetId: string; bypassed?: boolean }): string {
  if (route.bypassed || route.targetId === DIRECT) return 'DIRECT';
  const t = profileById(config, route.targetId);
  return t && t.kind === 'proxy' ? pacDirective(t.scheme, t.host, t.port) : 'DIRECT';
}

/**
 * Probe where the CURRENT TAB exits: send only the exit-IP lookup through the
 * tab's resolved proxy via a targeted PAC (every other host keeps its normal
 * route, so nothing the user is browsing is disturbed), measure it, then restore
 * the real config. Reuses runProxyTest's concurrency contract — one probe/test at
 * a time (testInFlight), proxy errors suppressed across the window, and the real
 * route restored in the finally even if the fetch throws.
 */
async function runTabExitProbe(req: { nonce: number; tabUrl: string; tabHost: string }): Promise<void> {
  const respond = (r: Record<string, unknown>) =>
    chrome.storage.session.set({ [TAB_EXIT_RESULT_KEY]: { nonce: req.nonce, ...r } }).catch(() => undefined);
  if (testInFlight) {
    // A test/probe holds the proxy; the popup retries 'busy' shortly.
    await respond({ ok: false, error: 'busy' });
    return;
  }
  testInFlight = true;
  suppressProxyErrorsUntil = Date.now() + 12_000;
  const result: Record<string, unknown> = { ok: false };
  try {
    const config = await loadConfig();
    // Master privacy switch: never contact ipconfig.is when the user has it off.
    if (!config.settings.exitIpCheck) throw new Error('IP lookups are turned off in Settings');
    const active = profileById(config, config.activeId);
    // DIRECT / System / no active profile can't be probed with a targeted PAC —
    // the popup handles those with a plain (passive) lookup and never asks here.
    if (!active) throw new Error('active profile does not route');
    // Regular scope: the probe measures by swapping the regular proxy, so it is
    // only ever asked for a regular window's tab (the popup won't ask from an
    // incognito one — there is no way to measure that scope from here).
    const tempRules = await loadTempRules(config.activeId, 'regular');
    const route = resolveRoute(config, active, pacRequestUrl(req.tabUrl), req.tabHost, tempRules);
    const directive = probeDirectiveFor(config, route);
    const exitHost = new URL(EXIT_IP_URL).hostname;
    await chrome.storage.session.set({ [TESTING_KEY]: true });
    await chrome.proxy.settings.set({
      value: {
        mode: 'pac_script',
        pacScript: { data: compilePac(config, active, tempRules, { host: exitHost, directive }), mandatory: true },
      },
      scope: 'regular',
    });
    const applied = await chrome.proxy.settings.get({});
    if (applied.levelOfControl === 'controlled_by_other_extensions') {
      throw new Error('another extension controls the proxy settings');
    }
    const info = await checkExitIp(8000);
    Object.assign(result, { ok: true, targetId: route.bypassed ? DIRECT : route.targetId, ...info });
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  } finally {
    // Restore the real route. Signal only when a genuine change landed during
    // the probe (pending) — the restore itself returns to the pre-probe route,
    // and signalling that would make the popup re-check → re-probe → restore →
    // signal in an endless loop. `pending` is false on the no-change (loop)
    // path, so that path stays silent; a real change still re-checks normally.
    suppressProxyErrorsUntil = Date.now() + 3000;
    const pending = reapplyAfterTest;
    reapplyAfterTest = false;
    await applyActive(pending).catch(() => undefined);
    await chrome.storage.session.remove(TESTING_KEY).catch(() => undefined);
    testInFlight = false;
    if (reapplyAfterTest) void queueApply();
  }
  await respond(result);
}

/**
 * How long a deferred reload stays valid. Normally it is consumed the moment
 * the popup closes; the TTL only covers the case where this worker never saw
 * that disconnect (killed mid-flight), so a stale entry can't reload a tab out
 * of the blue much later.
 */
const PENDING_RELOAD_TTL_MS = 5 * 60_000;
/**
 * A deferred RE-NAVIGATION gets a much shorter window. It only makes sense in
 * the moment — the user just routed a page that hadn't loaded and is about to
 * close the popup — and if this worker's write lost the race with the popup's
 * disconnect, the entry survives to the NEXT popup close. A late reload is
 * invisible; a late navigation would move a tab the user is now reading.
 */
const PENDING_NAV_TTL_MS = 60_000;

/** Never navigate a tab anywhere but a web page, whatever storage says. */
function navigableUrl(url: unknown): string | undefined {
  return typeof url === 'string' && /^https?:/i.test(url) ? url : undefined;
}

/**
 * Re-fetch a tab over the current route: re-issue the navigation it was waiting
 * on when `url` is given, else reload what it is showing. A pending navigation
 * cannot be reloaded — chrome.tabs.reload re-fetches the committed document and
 * abandons the navigation, which for a page that never loaded means throwing
 * away the very request the user is trying to fix.
 */
async function refetchTab(tabId: number, url?: string): Promise<void> {
  if (url) await chrome.tabs.update(tabId, { url });
  else await chrome.tabs.reload(tabId);
}

/**
 * Re-fetch a tab so it rides the new route — but not while the popup is open.
 * Chrome dismisses the action popup when the tab underneath it navigates, so
 * acting immediately would close the popup mid-edit. Deferring also collapses a
 * burst of changes (switch profile, add a rule, set an override) into one
 * re-fetch when the popup closes.
 *
 * `tabId` names the tab the popup was showing; without one the active tab is
 * used, which is what a plain profile switch means.
 */
async function reloadActiveTab(
  target: { tabId?: number; url?: string; only?: 'regular' | 'incognito' } = {}
): Promise<void> {
  try {
    let tabId = target.tabId;
    if (tabId === undefined) {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      // `only` narrows a reload to the scope that changed; a named tabId doesn't
      // need it, since the caller asking for that exact tab already knows.
      if (target.only && tab && (tab.incognito ? 'incognito' : 'regular') !== target.only) return;
      tabId = tab?.id;
    }
    if (tabId === undefined) return;
    const url = navigableUrl(target.url);
    if (popupPorts > 0) {
      await chrome.storage.session.set({ [PENDING_RELOAD_KEY]: { tabId, url, at: Date.now() } });
      return;
    }
    await refetchTab(tabId, url);
  } catch {
    // no active tab or no permission — nothing to reload
  }
}

/** Run the reload held back while the popup was open, if there is one. */
async function flushPendingReload(): Promise<void> {
  try {
    const store = await chrome.storage.session.get(PENDING_RELOAD_KEY);
    const pending = store[PENDING_RELOAD_KEY] as
      | { tabId?: unknown; at?: unknown; url?: unknown }
      | undefined;
    // Remove first: a reload that can't run (tab closed) must not linger and
    // fire on some later popup close.
    await chrome.storage.session.remove(PENDING_RELOAD_KEY);
    if (typeof pending?.tabId !== 'number') return;
    const url = navigableUrl(pending.url);
    const ttl = url ? PENDING_NAV_TTL_MS : PENDING_RELOAD_TTL_MS;
    if (Date.now() - (typeof pending.at === 'number' ? pending.at : 0) > ttl) return;
    await refetchTab(pending.tabId, url);
  } catch {
    // tab gone, or no permission — nothing to reload
  }
}

/* ---------------- toolbar icon ---------------- */

/** The manifest's own icons — the Sockitt mark, shown when no profile is active. */
const DEFAULT_ICON = { 16: 'img/icon-16.png', 32: 'img/icon-32.png' };

/** The profile's coloured initials tile, at both toolbar sizes. */
function tileImageData(profile: Profile): Record<number, ImageData> {
  const imageData: Record<number, ImageData> = {};
  for (const size of [16, 32]) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, size * 0.26);
    ctx.fillStyle = profile.color;
    ctx.fill();
    const initials = initialsFor(profile);
    ctx.fillStyle = textColorFor(profile.color);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fontSize = Math.round(size * (initials.length > 2 ? 0.42 : 0.52));
    ctx.font = `700 ${fontSize}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(initials, size / 2, size / 2 + size * 0.04, size * 0.9);
    imageData[size] = ctx.getImageData(0, 0, size, size);
  }
  return imageData;
}

async function paintIcon(profile: Profile | null): Promise<void> {
  try {
    // System/Direct: hand the toolbar back to the manifest icon. setIcon
    // overrides it for the rest of the session, so "no profile" has to restore
    // the mark explicitly — it does not fall back on its own.
    if (!profile) return void (await chrome.action.setIcon({ path: DEFAULT_ICON }));
    await chrome.action.setIcon({ imageData: tileImageData(profile) });
  } catch {
    await chrome.action.setBadgeBackgroundColor({ color: profile?.color ?? NEUTRAL });
  }
}

/**
 * Whether Sockitt has a toolbar button of its own — the only place its icon can
 * be kept truthful.
 *
 * Unpinned, the icon is seen in exactly one place: the extensions ("puzzle")
 * menu. Chromium's menu row reads the icon when the menu is built, and its only
 * update subscription is on the DEFAULT icon image, so a per-window repaint
 * never reaches it — whatever it showed on opening stays until it is opened
 * again. Nor can a paint be got in first: nothing can be drawn before Chrome has
 * started this worker, measured at ~264ms after a window appears.
 *
 * So while unpinned the icon names nothing at all. It is Sockitt's own mark,
 * which cannot be out of date, and the popup answers what the icon no longer
 * does. Pinned, the button repaints in place the moment anything lands, and
 * every window gets the profile it actually routes on.
 */
async function actionIsPinned(): Promise<boolean> {
  try {
    const { isOnToolbar } = await chrome.action.getUserSettings();
    return isOnToolbar !== false;
  } catch {
    return true; // no getUserSettings (pre-Chrome 91) — behave as before
  }
}

type Toolbar = { imageData: Record<number, ImageData> | null; title: string };

/**
 * The toolbar a window routing on `activeId` should be wearing.
 *
 * setIcon/setTitle without a tabId are global, so an incognito window inherited
 * the REGULAR profile's mark and name while its traffic went through the
 * incognito profile — the icon naming one route and the connection taking
 * another. A tab-scoped icon is the only per-window toolbar Chrome offers.
 */
function toolbarFor(config: Config, activeId: string, incognito: boolean): Toolbar {
  const { label, profile } = labelFor(config, activeId);
  let imageData: Record<number, ImageData> | null = null;
  try {
    imageData = profile ? tileImageData(profile) : null;
  } catch {
    imageData = null; // canvas unavailable — fall back to the manifest mark
  }
  return { imageData, title: incognito ? `Sockitt — ${label} (incognito)` : `Sockitt — ${label}` };
}

/** The toolbar an incognito window should wear, computed once per sweep. */
function incognitoToolbar(config: Config): Toolbar {
  // Being able to see an incognito tab at all means "Allow in Incognito" is
  // granted — Chrome hides them from extensions that don't have it.
  const id = incognitoActiveId(config, true);
  return toolbarFor(config, id ?? config.activeId, id !== null);
}

/** Sockitt's own mark, naming nothing — what an unpinned icon shows. */
const PLAIN_TOOLBAR: Toolbar = { imageData: null, title: 'Sockitt' };

async function applyTabToolbar(tabId: number, toolbar: Toolbar): Promise<void> {
  try {
    const { imageData, title } = toolbar;
    await chrome.action.setIcon(imageData ? { tabId, imageData } : { tabId, path: DEFAULT_ICON });
    await chrome.action.setTitle({ tabId, title });
  } catch {
    // tab closed mid-paint, or one whose action state is not ours to set
  }
}

/**
 * Whether any tab has been given a toolbar of its own. Session storage, not a
 * module variable, for the same reason the badge's flag is: the worker is
 * recycled long before the state it painted goes away.
 */
const TOOLBAR_PAINTING_KEY = 'sockitt-toolbar-painting';

/**
 * Give incognito tabs the toolbar of the scope they route on — and take it back
 * when Sockitt is unpinned.
 *
 * Every incognito tab is painted, not just the active one: the pinned button is
 * on screen continuously and must not flash the regular profile while the user
 * moves between incognito tabs. Tabs following the regular profile are painted
 * too rather than left to the global icon, because there is no reset for a
 * tab-scoped icon — one already set has to be kept in step with a switch
 * instead of lifted.
 *
 * That same no-reset trap is why unpinning has to sweep: an icon painted while
 * pinned would otherwise sit on its tab naming a profile after the toolbar
 * button it belonged to is gone. Overwriting with the plain mark is the only
 * way to take it back.
 */
async function paintScopedTabs(config: Config, pinned: boolean): Promise<void> {
  const store = await chrome.storage.session.get(TOOLBAR_PAINTING_KEY);
  const wasPainting = store[TOOLBAR_PAINTING_KEY] === true;
  if (!pinned && !wasPainting) return; // nothing painted, nothing to take back

  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);

  if (!pinned) {
    // Sweep every tab, not only the incognito ones: an older version painted
    // regular tabs too, and those marks outlive the update that stopped.
    await Promise.all(
      tabs.filter((t) => t.id !== undefined).map((t) => applyTabToolbar(t.id!, PLAIN_TOOLBAR))
    );
    await chrome.storage.session.remove(TOOLBAR_PAINTING_KEY);
    return;
  }

  const incognito = tabs.filter((t) => t.incognito && t.id !== undefined);
  if (!incognito.length) return;
  if (!wasPainting) await chrome.storage.session.set({ [TOOLBAR_PAINTING_KEY]: true });
  const toolbar = incognitoToolbar(config);
  await Promise.all(incognito.map((t) => applyTabToolbar(t.id!, toolbar)));
}

/** Paint from the stored config — for events that carry none. */
async function refreshScopedTabs(): Promise<void> {
  try {
    const config = cachedConfig ?? (await loadConfig());
    await paintScopedTabs(config, await actionIsPinned());
  } catch {
    // nothing to paint
  }
}

/**
 * Repaint ONE incognito tab, for the navigation path.
 *
 * Chrome drops tab-scoped action state when a navigation commits — the same
 * reason the per-tab route badge is redrawn from onUpdated — so a tab painted
 * when its window opened loses its mark the moment the user goes anywhere,
 * falling back to the global icon: the REGULAR profile, which is exactly the
 * answer this feature exists to stop showing.
 */
async function repaintIncognitoTab(tabId: number): Promise<void> {
  try {
    if (!(await actionIsPinned())) return; // unpinned: the mark, and nothing else
    const config = cachedConfig ?? (await loadConfig());
    await applyTabToolbar(tabId, incognitoToolbar(config));
  } catch {
    // tab gone
  }
}

/* ---------------- quick switch ---------------- */

async function cycleProfile(): Promise<void> {
  const config = await loadConfig();
  let ids = config.settings.quickSwitchIds.filter(
    (id) => id === DIRECT || id === SYSTEM || profileById(config, id)
  );
  if (ids.length < 2) {
    ids = [DIRECT, SYSTEM, ...config.profiles.map((p) => p.id)];
  }
  const index = ids.indexOf(config.activeId);
  config.activeId = ids[(index + 1) % ids.length]!;
  await saveConfig(config); // storage change triggers applyActive
}

/* ---------------- rule list auto-update ---------------- */

async function scheduleRuleListUpdates(config: Config): Promise<void> {
  const wanted = new Map<string, number>(); // alarm name -> period minutes
  for (const p of config.profiles) {
    if (p.kind === 'rulelist' && p.url && p.updateIntervalH > 0) {
      wanted.set(ALARM_PREFIX + p.id, p.updateIntervalH * 60);
    }
  }
  const existing = await chrome.alarms.getAll();
  for (const alarm of existing) {
    if (!alarm.name.startsWith(ALARM_PREFIX)) continue;
    const period = wanted.get(alarm.name);
    if (period === undefined || alarm.periodInMinutes !== period) {
      await chrome.alarms.clear(alarm.name);
    } else {
      wanted.delete(alarm.name); // already scheduled correctly
    }
  }
  for (const [name, periodInMinutes] of wanted) {
    await chrome.alarms.create(name, { periodInMinutes, delayInMinutes: 1 });
  }
}

async function updateRuleList(profileId: string): Promise<void> {
  const config = await loadConfig();
  const profile = profileById(config, profileId);
  if (!profile || profile.kind !== 'rulelist' || !profile.url) return;
  try {
    const response = await fetch(profile.url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!text.trim()) throw new Error('empty response');
    // This runs unattended off an alarm, and the body it stores is parsed
    // synchronously inside compilePac before the next chrome.proxy.settings.set.
    // Keep the previous list rather than let a remote host pick that cost.
    if (text.length > RULE_LIST_MAX_BYTES) throw new Error('list too large');
    profile.text = text;
    profile.lastUpdated = Date.now();
    // saveConfigRaw (no rev bump): an unattended fetch must not masquerade as a
    // user edit that syncs this device's activeId to the others.
    await saveConfigRaw(config);
  } catch {
    // Network failures keep the previous list; next alarm retries.
  }
}

/* ---------------- per-tab result badge (optional "tabs" permission) ---------------- */

/**
 * Whether the last applied config had the badge on. Session storage, not a
 * module variable: the worker is recycled after ~30s idle, so by the time the
 * user switches the feature off the process that painted the badges is usually
 * gone. Session storage expires exactly when tab badges do — at browser
 * restart — which makes it the right lifetime to reason about them from.
 */
const BADGE_PAINTING_KEY = 'sockitt-badge-painting';

/**
 * Whether THIS worker has already recorded that badges are painted. Only a
 * memo for the session write above — the flag itself is the durable record.
 */
let paintedBadge = false;

/**
 * Drop the tab's badge OVERRIDE rather than blanking it. Text '' is still an
 * override, and would hide the GLOBAL badge — the red proxy-error '!' included
 * — for this tab alone; null removes it so the global text shows through
 * again. (MV3's own typings omit the documented null, hence the cast.)
 *
 * The COLOUR override has to be dealt with separately, and differently: unlike
 * text it has no null form (`color` is required by the action schema, so
 * passing null throws), and it outranks the global colour on its own — a tab
 * that once carried a route badge would otherwise render the global '!' it now
 * inherits in the last route's colour. DANGER is the right colour to leave
 * behind because the error badge is the ONLY global text Sockitt ever raises;
 * every other path blanks it (applyActiveInner).
 */
async function clearTabBadge(tabId: number): Promise<void> {
  await Promise.all([
    chrome.action
      .setBadgeText({ tabId, text: null } as unknown as chrome.action.BadgeTextDetails)
      .catch(() => undefined),
    chrome.action.setBadgeBackgroundColor({ tabId, color: DANGER }).catch(() => undefined),
  ]);
}

/**
 * Repaint the route badge on EVERY window's active tab after a profile/rule
 * change — not just the focused window's.
 *
 * A tab-scoped badge is state that outlives navigation, tab switching and the
 * worker itself, and the only two events wired to repaint it (onActivated,
 * onUpdated) fire for neither a window focus change nor a background window. A
 * single-tab refresh therefore left every other window asserting the route of a
 * profile that was no longer active, indefinitely. `{ active: true }` with no
 * window filter is the same unfiltered shape paintScopedTabs already relies on
 * for the tab-scoped icon, and needs no permission beyond the ids.
 */
async function refreshActiveTabBadge(config: Config): Promise<void> {
  const on = config.settings.badgeResult;
  const store = await chrome.storage.session.get(BADGE_PAINTING_KEY);

  if (!on) {
    // Switching the feature off has to undo itself. A tab-scoped badge outlives
    // navigation and every later updateTabBadge returns early once the feature
    // is off, so without this sweep the last route painted would sit on each
    // tab until that tab was closed.
    //
    // ABSENT is treated as "unknown, may have painted", not as "nothing to do":
    // an extension reload drops session storage but NOT the painted badges, and
    // that path runs no applyActive, so the flag would read clean while badges
    // sat on every tab. The sweep is recorded only once it has actually run —
    // writing the flag first would let a worker die between the two and record
    // a sweep that never happened.
    //
    // Gated on the grant as well, so the default configuration — feature off,
    // "tabs" never granted — does no sweep at all. Nothing can have painted a
    // badge without that permission, so "unknown" is only genuinely unknown for
    // someone who has held it.
    if (
      store[BADGE_PAINTING_KEY] !== false &&
      (await chrome.permissions.contains(TABS_PERMS).catch(() => false))
    ) {
      await clearAllTabBadges();
      // Reset the memo with the flag, or a paint after the feature is switched
      // back on would skip its own record — leaving the NEXT switch-off reading
      // "already swept" over badges that had since been repainted.
      paintedBadge = false;
      await chrome.storage.session.set({ [BADGE_PAINTING_KEY]: false }).catch(() => undefined);
    }
    return;
  }
  try {
    const tabs = await chrome.tabs.query({ active: true });
    await Promise.all(
      tabs.map((t) => (t.id === undefined ? undefined : updateTabBadge(t.id, config)))
    );
  } catch {
    // no active tab
  }
}

/**
 * Wake once at the next moment a `time`/`weekday` rule changes its answer, so
 * the badge stops asserting a route the PAC has already stopped taking.
 *
 * These conditions are the only ones whose answer moves without an event: every
 * other badge trigger is a navigation, a tab switch or a config write. A
 * ONE-SHOT alarm at the boundary rather than a periodic one — polling every
 * minute would wake the worker 1440 times a day to change nothing. Each firing
 * re-arms for the next boundary (see the onAlarm handler).
 *
 * Both scopes count: an incognito tab resolves against the incognito profile,
 * so a time rule live only there still has to move the badge.
 */
async function scheduleBadgeClock(config: Config): Promise<void> {
  // Nothing to wake for unless the feature can actually paint: the setting on
  // AND the grant it needs held. Without this the alarm outlived a revoke.
  const armed =
    config.settings.badgeResult && (await chrome.permissions.contains(TABS_PERMS).catch(() => false));
  // The incognito scope is counted WITHOUT checking incognito access, on
  // purpose. Granting that access reloads the extension without firing
  // onInstalled or onStartup, so a gate evaluated while it was off would leave
  // the scope with no boundary alarm until the next config write — the exact
  // staleness this exists to prevent. An extra wake costs nothing; a missing one
  // is the bug.
  const live = livePath(config, config.activeId);
  for (const id of livePath(config, incognitoActiveId(config, true) ?? config.activeId)) {
    live.add(id);
  }
  const minutes = armed ? minutesToNextClockChange(config, live) : null;
  if (minutes === null) {
    await chrome.alarms.clear(BADGE_CLOCK_ALARM).catch(() => undefined);
    return;
  }
  // At least a minute out: Chrome clamps shorter delays anyway, and a boundary
  // that resolved to "now" must not re-arm itself in a tight loop.
  //
  // Capped at an hour because the delay is ELAPSED time while the boundary is a
  // WALL-CLOCK one: a DST shift, a timezone change or a laptop suspend would
  // otherwise leave a 15-hour wait pointing at the wrong instant. Re-arming
  // hourly re-reads the clock and self-corrects, at a cost of at most 24 wakes a
  // day — and only for the profiles that actually carry a time or weekday rule.
  await chrome.alarms.create(BADGE_CLOCK_ALARM, {
    delayInMinutes: Math.min(60, Math.max(1, minutes)),
  });
}

/** Remove every tab-scoped badge. tabs.query needs no permission for ids. */
async function clearAllTabBadges(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((t) => (t.id === undefined ? undefined : clearTabBadge(t.id))));
  } catch {
    // no tabs to clean up
  }
}

/**
 * Paint or CLEAR the per-tab route badge. Always resolves to one or the other
 * so a stale badge from a previous profile can't linger.
 */
async function updateTabBadge(tabId: number, config: Config | null = cachedConfig): Promise<void> {
  const cfg = config ?? (await loadConfig());
  const clear = () => clearTabBadge(tabId);

  if (!cfg.settings.badgeResult) return; // feature off — the sweep already cleaned up
  try {
    // Without "tabs" the route can't be read, so nothing may be claimed about
    // it: clear rather than return, or a badge painted while the permission was
    // held would sit on the tab reading out a route no longer being checked.
    if (!(await chrome.permissions.contains(TABS_PERMS))) return void (await clear());
    // A FATAL incident owns the toolbar, so DROP this tab's override and let the
    // global '!' through. Returning instead left the previous route's badge in
    // place — which both went stale for the length of the incident and hid the
    // very '!' it meant to preserve, since a tab-scoped badge always outranks
    // the global one. A non-fatal alert paints no global badge (raiseProxyError
    // returns before painting unless fatalStreak), so it has no claim on the
    // toolbar: fall through and keep reading out the true route.
    const alert = await loadProxyAlert();
    if (alert?.fatalStreak) return void (await clear());
    const tab = await chrome.tabs.get(tabId);
    // An incognito tab is routed by the incognito scope, so it has to be read
    // out from that scope's profile and that scope's overrides — resolving it
    // against the active profile answered for a route it does not take. (Being
    // able to see the tab at all means incognito access is granted.)
    const scopedId = tab.incognito ? incognitoActiveId(cfg, true) : null;
    const activeId = scopedId ?? cfg.activeId;
    const active = profileById(cfg, activeId);
    // The page being loaded, not the one being replaced — otherwise the badge
    // reads out the previous page's route for as long as a navigation takes,
    // which on a host that never answers is half a minute of the wrong answer,
    // and disagrees with the popup's Route readout the whole time.
    const page = tabTarget(tab);
    // Cheap rejections first: no need to read the scope's overrides for a tab
    // that gets cleared whatever they say. This runs on every navigation.
    if (!badgeApplies(cfg, active, page)) return void (await clear());
    const tempRules = await loadTempRules(activeId, scopedId ? 'incognito' : 'regular');
    const paint = badgePaintFor(cfg, active, page, tempRules);
    if (!paint) return void (await clear());
    // Several awaits have passed since the feature gate at the top, and the sweep
    // that undoes a switch-off is one-shot: a paint landing after it would sit
    // there for good, with the feature off and nothing left to clear it. Recheck
    // against the live config rather than the snapshot this resolved against.
    if (cachedConfig && !cachedConfig.settings.badgeResult) return void (await clear());
    // One await, not two: these are the badge's only writes, and issuing them
    // separately let a superseded invocation land its colour after a newer one's
    // text, leaving one profile's initials on another's colour.
    await Promise.all([
      chrome.action.setBadgeBackgroundColor({ tabId, color: paint.color }),
      chrome.action.setBadgeText({ tabId, text: paint.text }),
    ]);
    // Record the paint HERE, where it happens. The off-sweep is gated on this
    // flag, and refreshActiveTabBadge — the only writer until now — is not on
    // the path the tab listeners take, so badges painted by a navigation or a
    // tab switch were never accounted for and the sweep skipped them. Memoised
    // per worker so this costs one session write per lifetime, not one a paint.
    if (!paintedBadge) {
      // Set AFTER the write lands, not before: an optimistic memo would suppress
      // every later attempt, so a single failed write would leave the flag
      // saying "nothing painted" for the rest of the worker's life — and the
      // off-sweep this exists to authorise would never run.
      await chrome.storage.session.set({ [BADGE_PAINTING_KEY]: true });
      paintedBadge = true;
    }
  } catch {
    // tab gone or URL unavailable — nothing to paint
  }
}

/* ---------------- sync ---------------- */

async function maybePullSync(): Promise<void> {
  const config = await loadConfig();
  if (!config.settings.syncEnabled) return;
  const remote = await pullFromSync(config.rev);
  if (remote && remote.settings.syncEnabled) await applyFromSync(remote, config);
}

/* ---------------- wiring ---------------- */

// First synchronous turn: the auth listener must be registered here (not from
// an async path) or Chrome won't wake this worker for proxy 407 challenges.
registerAuthListener();

// If a previous worker instance died while a test proxy was applied, restore
// the real configuration now (the marker only survives a mid-test death).
void chrome.storage.session
  .get(TESTING_KEY)
  .then((s) => {
    if (s[TESTING_KEY]) {
      void chrome.storage.session.remove(TESTING_KEY);
      void queueApply();
    }
  })
  .catch(() => undefined);

// Re-apply the incognito scope on every worker start. Enabling "Allow in
// Incognito" reloads the extension but fires neither onInstalled nor
// onStartup, so this is the only path that picks up a freshly granted access
// (or a config set while access was off). Cheap and idempotent — it touches
// only the incognito scope, gated on isAllowedIncognitoAccess.
void loadConfig()
  .then(async (config) => {
    await applyIncognito(config);
    // The toolbars too: a window may have opened, or the extension been pinned
    // or unpinned, while this worker was not running.
    await paintScopedTabs(config, await actionIsPinned());
  })
  .catch(() => undefined);

// Pull BEFORE applying/pushing so a stale device can't overwrite newer remote
// data on wake-up. applyActive's own pushToSync is a no-op right after a pull
// (rev already matches), so no echo.
chrome.runtime.onInstalled.addListener(() => {
  void maybePullSync().then(() => queueApply());
});

/**
 * Chrome downloaded a new version but is holding the swap until Sockitt falls
 * idle — which a worker woken by every alarm, proxy event and popup connection
 * may not do for days. This fires once, at a worker that will not outlive the
 * wait, so the version is written down for the options page to raise a banner
 * about. Nothing here applies it: see shared/update.ts for why that is the
 * user's to do.
 *
 * A listener of its own rather than a line inside the two around it — those
 * carry the sync-and-apply path, and this is bookkeeping that must not be able
 * to disturb it.
 */
chrome.runtime.onUpdateAvailable.addListener((details) => {
  void savePendingUpdate(details.version);
});

/**
 * The staged version landed, so the note about it is spent. readPendingUpdate
 * would ignore it anyway once the running version caught up; this just keeps
 * the record from outliving what it describes.
 */
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'update') void clearPendingUpdate();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await maybePullSync();
    const config = await loadConfig();
    const startup = config.settings.startupProfileId;
    const valid =
      startup && (startup === DIRECT || startup === SYSTEM || profileById(config, startup));
    if (valid && config.activeId !== startup) {
      config.activeId = startup;
      // saveConfigRaw, not saveConfig: the startup profile is a per-device
      // preference. Bumping rev here would push this device's activeId to the
      // whole fleet on every browser start, so devices with different startup
      // profiles fight over the shared activeId. Raw save still triggers
      // applyActive via onConfigChanged; it just doesn't masquerade as a user edit.
      await saveConfigRaw(config);
    } else {
      await queueApply();
    }
  })();
});

// The popup's lifetime port — see reloadActiveTab. Registered on the first
// synchronous turn so a popup opening against a cold worker still connects.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== POPUP_PORT) return;
  popupPorts++;
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError; // reading it keeps a disconnect from logging
    popupPorts = Math.max(0, popupPorts - 1);
    if (popupPorts === 0) void flushPendingReload();
  });
});

onConfigChanged((config) => {
  cachedConfig = config;
  applyActiveGuarded();
});
onTempRulesChanged(() => applyActiveGuarded());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes[TEST_KEY]) return;
  const req = changes[TEST_KEY].newValue as
    | { profileId?: unknown; nonce?: unknown; scheme?: unknown; host?: unknown; port?: unknown }
    | undefined;
  if (req && typeof req.profileId === 'string' && typeof req.nonce === 'number') {
    void runProxyTest({
      profileId: req.profileId,
      nonce: req.nonce,
      scheme: typeof req.scheme === 'string' ? (req.scheme as ProxyScheme) : undefined,
      host: typeof req.host === 'string' ? req.host : undefined,
      port: typeof req.port === 'number' ? req.port : undefined,
    });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes[TAB_EXIT_KEY]) return;
  const req = changes[TAB_EXIT_KEY].newValue as
    | { nonce?: unknown; tabUrl?: unknown; tabHost?: unknown }
    | undefined;
  if (req && typeof req.nonce === 'number' && typeof req.tabUrl === 'string' && typeof req.tabHost === 'string') {
    void runTabExitProbe({ nonce: req.nonce, tabUrl: req.tabUrl, tabHost: req.tabHost });
  }
});

onSyncChanged(() => void maybePullSync());

chrome.permissions.onAdded.addListener((added) => {
  // Only auth-related grants warrant touching the listener — reregistering on
  // an unrelated grant (e.g. "tabs") would trade a wake-eligible first-turn
  // registration for an async one until the next worker restart.
  if (added.permissions?.some((p) => p === 'webRequest' || p === 'webRequestAuthProvider')) {
    reregisterAuthListener();
  }
  // A "tabs" grant can land long after the setting was switched on (an imported
  // or synced config carries the setting but not the grant). Paint immediately
  // rather than waiting for the next tab switch or navigation, so the grant
  // visibly does something.
  if (added.permissions?.includes('tabs')) {
    void loadConfig().then(async (config) => {
      await refreshActiveTabBadge(config);
      // The clock alarm is gated on this grant too, so the grant has to arm it —
      // nothing else will until the next config write.
      await scheduleBadgeClock(config).catch(() => undefined);
    });
  }
  // The navigation-start listener can only be registered once the API exists,
  // which is the moment this fires. Registered from an async turn it is not
  // wake-eligible until the next worker start — the same trade the auth
  // listener makes — but a worker awake enough to receive this grant is awake
  // for the navigations that immediately follow it.
  if (added.permissions?.includes('webNavigation')) registerNavListener();
});

/**
 * The revoke edge, the counterpart the grant above always had and this never
 * did. A tab-scoped badge outlives the permission that painted it, and
 * updateTabBadge can only clear a tab some event happens to name — which for a
 * tab in an unfocused window is neither onActivated (a window focus change
 * fires no tab event) nor onUpdated. Without this sweep those badges keep
 * reading out routes Sockitt is no longer allowed to check. tabs.query needs no
 * permission for ids, so it still works after the grant is gone.
 */
chrome.permissions.onRemoved.addListener((removed) => {
  if (!removed.permissions?.includes('tabs')) return;
  paintedBadge = false;
  void (async () => {
    await clearAllTabBadges();
    await chrome.storage.session.set({ [BADGE_PAINTING_KEY]: false }).catch(() => undefined);
    // The clock alarm exists only to repaint a badge that can no longer be
    // painted; leaving it armed would wake the worker on every boundary forever.
    await chrome.alarms.clear(BADGE_CLOCK_ALARM).catch(() => undefined);
  })();
});

/**
 * A window coming to the front changes which tab the user is reading the badge
 * on, and Chrome fires no tab event for it: onActivated means the active tab
 * changed WITHIN a window, which this is not. Without this, the tab in front of
 * the user kept whatever route was painted before the last profile change.
 */
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  void chrome.tabs
    .query({ active: true, windowId })
    .then(([tab]) => {
      if (tab?.id !== undefined) void updateTabBadge(tab.id);
    })
    .catch(() => undefined); // the window closed between the event and the query
});

chrome.action.onClicked.addListener(() => void cycleProfile());

chrome.commands.onCommand.addListener((command) => {
  if (command === 'cycle-profile') void cycleProfile();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ERROR_DECAY_ALARM) {
    void decayProxyAlert();
  } else if (alarm.name === BADGE_CLOCK_ALARM) {
    // Re-arm FIRST, and independently of the repaint. The alarm is one-shot and
    // this handler is its only re-armer, so a repaint that throws would end the
    // chain for good — the badge would then never move on a clock boundary
    // again until some unrelated apply happened to rebuild the alarm.
    void loadConfig().then(async (config) => {
      await scheduleBadgeClock(config).catch(() => undefined);
      await refreshActiveTabBadge(config).catch(() => undefined);
    });
  } else if (alarm.name.startsWith(ALARM_PREFIX)) {
    void updateRuleList(alarm.name.slice(ALARM_PREFIX.length));
  }
});

/**
 * The toolbar belongs to the worker, but the alert can be cleared from several
 * places — a re-apply, the quiet-period alarm, or Dismiss on the options page.
 * Watching the key itself means every one of them repaints, instead of each
 * having to remember to.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes[ERROR_KEY]) return;
  const { oldValue, newValue } = changes[ERROR_KEY];
  if (oldValue !== undefined && newValue === undefined) {
    void restoreBadgeAfterAlert();
    return;
  }
  // The RAISED edge, and only the edge. The '!' is painted globally, so every
  // tab already carrying a route badge would go on showing it — the per-tab
  // override wins — and hide the alert entirely. Sweep them once so the error is
  // what the toolbar says; each tab repaints its route from onActivated/
  // onUpdated once the incident ends.
  //
  // ERROR_KEY is rewritten on EVERY failed request while an incident runs (the
  // streak counter moves), so testing newValue alone would run a browser-wide
  // sweep per failure. Only the transition from "no fatal alert" to "fatal
  // alert" has anything to undo.
  if (newValue === undefined) return;
  if (asProxyAlert(oldValue)?.fatalStreak) return; // already swept for this incident
  if (!asProxyAlert(newValue)?.fatalStreak) return;
  // Nothing can have been painted with the feature off, so there is nothing to
  // sweep. Only skip on a POSITIVE reading: a worker woken by this very error
  // has no cached config, and not knowing is a reason to sweep, not to skip.
  if (cachedConfig && !cachedConfig.settings.badgeResult) return;
  void clearAllTabBadges();
});

chrome.proxy.settings.onChange.addListener((details) => {
  // Published on every change, not just the hostile one: the dashboard's
  // control pill has to be able to go back to green when the other extension
  // lets go, and onChange is the only event that says so.
  void publishControl(details.levelOfControl);
  if (details.levelOfControl !== 'controlled_by_other_extensions') return;
  void (async () => {
    const config = await loadConfig();
    if (!config.settings.revertExternal) return;
    const now = Date.now();
    if (now - lastRevert < REVERT_COOLDOWN_MS) return;
    lastRevert = now;
    await queueApply();
  })();
});

// A tab-scoped icon can only be set on a tab that exists, so each incognito tab
// is painted as it appears — including the first tab of a new incognito window,
// which is what makes the very act of opening one show the right profile.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.incognito) void refreshScopedTabs();
});

/**
 * Repaint when a navigation STARTS — the case tabs.onUpdated cannot report.
 *
 * Measured on Chrome 151: navigating a tab to a host that never answers fires
 * NO tabs.onUpdated at all (zero events over ten seconds), because that event's
 * `status: 'loading'` edge is delivered at the COMMIT, and a navigation nothing
 * answers never commits. Meanwhile tab.pendingUrl already names the new page —
 * so the badge had the right answer available and no reason to go and look. It
 * went on reading out the previous page's proxy for the whole hang, which is
 * precisely when someone looks at the toolbar to ask why nothing is loading.
 *
 * onBeforeNavigate is the only announcement made in that window, and by the
 * time it arrives tab.pendingUrl is set, so updateTabBadge needs no new input —
 * tabTarget already prefers the pending page over the one being replaced.
 *
 * Optional and degradable: without the grant the badge behaves as it did
 * before, correct on every navigation that completes.
 */
let navListenerRegistered = false;
function registerNavListener(): void {
  // The API object does not exist until the permission is granted.
  if (navListenerRegistered || !chrome.webNavigation) return;
  navListenerRegistered = true;
  chrome.webNavigation.onBeforeNavigate.addListener((details) => {
    // Main frame only: a subframe navigating does not change what the TAB is,
    // and the badge answers for the tab.
    if (details.frameId !== 0) return;
    void updateTabBadge(details.tabId);
  });
}

// First synchronous turn where possible, so the event can wake a dormant worker.
registerNavListener();

chrome.tabs.onActivated.addListener((info) => void updateTabBadge(info.tabId));

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Repaint on cross-page navigation (changeInfo.url) AND on load status — a
  // same-URL hard refresh reports no url change, but Chrome clears the per-tab
  // badge on the navigation commit, so we must redraw it as the page reloads.
  if (!changeInfo.url && !changeInfo.status) return;
  void updateTabBadge(tabId);
  // The tab-scoped ICON goes the same way at the same moment, and takes the
  // incognito window's whole toolbar with it. Both edges are honoured for the
  // same reason as above; painting twice is idempotent.
  if (tab.incognito) void repaintIncognitoTab(tabId);
});

// Pinning or unpinning changes whether the global icon may name a profile at
// all (see claimsGlobalIcon), and nothing else announces it. Chrome 127+; older
// builds pick the change up on the next switch.
chrome.action.onUserSettingsChanged?.addListener(() => applyActiveGuarded());

// activeTab is granted only after the user interacts with the action; the
// badge/reload paths degrade gracefully when it isn't.

chrome.proxy.onProxyError.addListener((details) => {
  // Ignore errors that a connection test provoked by routing page traffic
  // through the candidate proxy — otherwise a late event paints a false
  // failure over the already-restored working configuration.
  if (testInFlight || Date.now() < suppressProxyErrorsUntil) return;
  // error and details are kept apart, not concatenated: the code is what the
  // options page explains and groups on, the detail is the PAC message beneath.
  void raiseProxyError({
    source: 'proxy',
    error: details.error || 'Proxy error',
    details: details.details ?? '',
    fatal: details.fatal,
  });
});
