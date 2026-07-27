# Architecture

## Design in one paragraph

UI pages never touch proxy APIs. The popup and options app read and write a
single config object in `chrome.storage.local`; the service worker
([`src/background.ts`](../src/background.ts)) observes storage changes, compiles
the active profile into browser proxy settings, applies them via `chrome.proxy`,
and repaints the toolbar icon. One writer, one applier, no races, and the UI
stays a thin view over stored state.

```
popup ──┐                                 ┌─> chrome.proxy.settings
        ├─> chrome.storage ──> background ─┤
options ┘        (config)                  └─> action icon / badge / title
```

## Modules

| File | Role |
|---|---|
| `src/shared/types.ts` | Data model: `Config`, `ProxyProfile`, `SwitchProfile`, `RuleListProfile`, `VirtualProfile`, `SwitchRule`, `Settings` |
| `src/shared/match.ts` | Compiles conditions to matcher primitives; TS-side evaluator and `resolveRoute()` |
| `src/shared/pac.ts` | Generates the PAC script from the profile graph; per-scheme proxy directives |
| `src/shared/state.ts` | Storage load/save and `sanitizeConfig` (also validates imports and sync); session override rules |
| `src/shared/rulelist.ts` | AutoProxy/GFWList and Switchy list parsing (base64 decode plus a small memo) |
| `src/shared/sync.ts` | Config mirroring over `chrome.storage.sync`: byte-bounded chunks, rule-list bodies excluded (refetchable), pre-push revision check, last-write-wins by revision |
| `src/shared/errors.ts` | Proxy failure model: the live alert, the session error log (repeats collapsed), and the plain-English vocabulary both UI surfaces render |
| `src/shared/avatar.ts` | Initials avatars (DiceBear-initials style, generated locally) |
| `src/background.ts` | The applier: proxy settings, icon painting, error badge, quick-switch, alarms, sync, and HTTP(S) proxy auth |
| `src/popup/` | Switcher UI and live per-site route management |
| `src/options/` | Profile and rule management UI, settings, and the in-app docs page |

There is no UI framework. `src/shared/ui.ts` is a small `el()` helper; each page
re-renders its DOM from state, which at this scale is faster than a framework
runtime would be.

## How profiles become proxy settings

| Active profile | `chrome.proxy` mode |
|---|---|
| Direct | `direct` |
| System | `system` |
| Proxy with an empty bypass list (or an alias chain ending at one) | `fixed_servers` with the profile's scheme (`socks5` / `socks4` / `http` / `https`) |
| Anything conditional: Auto Switch, rule list, or a proxy that has a bypass list | `pac_script` with generated code, `mandatory: true` |

Profiles form a graph: switch rules and rule lists can target other profiles.
The compiler emits one function per reachable profile and resolves cycles to
DIRECT. `staticTerminal()` collapses unconditional alias chains so they still
take the `fixed_servers` fast path. A proxy that carries a bypass list is
compiled to a PAC instead, so bypass entries mean the same thing however the
proxy is reached. The session override rule, when set, is injected above the
active switch profile's permanent rules at compile time.

`mandatory: true` means a failing proxy fails the request rather than falling
back to a direct connection. This is deliberate, so a dead proxy can never
silently leak traffic.

## The PAC compiler

`compilePac()` emits a self-contained, ES5-flavoured script shaped for
per-request speed inside Chrome's PAC sandbox:

- **Regexes are constructed once** at the top level into a table `R`; the hot
  path only calls `.test()`. A unit test asserts no `new RegExp` appears inside
  `FindProxyForURL`.
- **`*.host` wildcards never become regexes.** They compile to a suffix string
  comparison (`E(h, ".example.com")`) plus a bare-domain equality check.
- **CIDR rules become one integer op.** The pattern is pre-parsed at compile
  time into base and mask integers; at request time the host is parsed to an
  IPv4 int at most once and tested with `(ip & mask) === base`.
- **Rule-list domains become a dictionary.** Exact hosts and `||domain`
  suffixes compile into an object walked label by label, so a large list stays
  near constant time. Keys are prefixed to sidestep the `__proto__` object trap.
- **Per-request values are computed on demand.** The host IP, host-label count,
  weekday, and minute-of-day are derived at most once per request, and only when
  some reachable condition needs them.
- **No DNS calls.** `dnsResolve` is never emitted; PAC-side DNS would add a
  blocking lookup to every request.

Each proxy scheme emits its own PAC directive: `SOCKS5`, `SOCKS` (SOCKS4),
`PROXY` (HTTP), or `HTTPS`. Rules with invalid patterns compile to nothing (the
options UI flags them red), so one bad regex cannot take down routing.

## Route preview parity

The popup shows where the current tab would route by evaluating the same
compiled conditions in TypeScript (`resolveRoute()` in `match.ts`). Because
Chrome strips the path from https URLs before the PAC sees them, the preview
matches against `pacRequestUrl()` so it agrees with real routing. A test runs
every fixture through both the generated PAC (in a Node VM) and `resolveRoute()`
and asserts they agree, so the preview cannot drift from reality.

## Which page "this tab" means

Chrome leaves `tab.url` on the old document until a navigation commits, and a
navigation to a host you cannot reach commits only when it gives up — tens of
seconds for a dropped SYN, and never a URL change in a tab that was empty to
begin with. Reading `tab.url` alone therefore answers with the previous page, or
with nothing at all, in exactly the moment the popup is opened to ask why a site
will not load. `tabTarget()` (`shared/tabs.ts`) prefers `tab.pendingUrl` — the
address in flight — and marks the result `pending`; the activeTab grant covers
the whole tab rather than just its committed origin, so no extra permission is
needed. The popup and the per-tab badge both resolve routes against it.

A `pending` target also changes what "re-fetch this page" means: `tabs.reload`
would reload the document still on screen and abandon the navigation being
waited on, so the worker re-issues the navigation by URL instead. That happens
whether or not "reload on switch" is set — nothing has committed, so there is no
page to disturb, and the request hanging right then is the one the new rule was
added to fix.

## Proxy authentication

HTTP and HTTPS proxies can carry a username and password. Because Chrome's proxy
config cannot hold credentials, the worker answers proxy auth challenges through
`chrome.webRequest.onAuthRequired`. The listener is registered synchronously at
the worker's top level (MV3 only wakes a suspended worker for listeners
registered in the first synchronous turn) and uses `asyncBlocking`, so a
freshly woken worker can read credentials from storage before responding.
Challenger host and port are matched, lowercased, against an
endpoint-to-credentials map; a repeat challenge for the same request means the
proxy rejected the stored credentials, so the handler answers it empty rather
than looping, which hands control to the browser's own login dialog. This
needs the optional `webRequest`, `webRequestAuthProvider`, and all-sites
permissions, which the options page requests only when a user sets
credentials; credentials are excluded from sync and never leave the device.
SOCKS proxies cannot be authenticated by Chromium.

## Popup ↔ worker channels

The config in `chrome.storage.local` is the only channel that *changes*
behaviour, but a few request/response pairs need a side channel. They all ride
`chrome.storage.session` (keys declared together in `state.ts`), so both ends
stay wake-safe: a worker that was asleep is started by the write and reads the
request from storage rather than from a message it missed.

| Key | Direction | Purpose |
|---|---|---|
| `sockitt-error` | worker → UI | The live proxy failure ("requests are failing right now"), absent once it clears |
| `sockitt-error-log` | worker → UI | Failure history for the session, newest first, repeats collapsed |
| `sockitt-open-page` | popup → options | Which options page to open (`openOptionsPage` takes no target, and may focus a page that is already up) |
| `sockitt-applied` | worker → UI | "Settings applied" tick, so an open popup re-checks its exit IP against the new route |
| `sockitt-test` / `-result` | options ↔ worker | Connection test request and its outcome |
| `sockitt-tab-exit` / `-result` | popup ↔ worker | Probe where the *current tab* exits when it routes differently from `ipconfig.is` |
| `sockitt-reload` | popup → worker | A this-tab rule/override/bypass change should re-fetch the tab once the new route is applied — carrying a `tabId` and `url` when the page never loaded and the navigation has to be re-issued rather than reloaded |
| `sockitt-pending-reload` | worker (internal) | A reload (or re-navigation) deferred until the popup closes |

One thing is **not** storage: the popup holds a `chrome.runtime.connect` port
open for as long as it is open, and never sends a message over it. The worker
watches only connect/disconnect. Chrome dismisses the action popup when the tab
underneath it navigates, so while that port is up a "reload on switch" is
recorded rather than performed, and runs on disconnect — which also collapses a
burst of edits into a single reload. The popup reconnects if the worker is
recycled, so the deferral cannot be lost to a worker restart, and the pending
reload is itself kept in session storage (with a short TTL) so it survives one.

## Error surfacing

`chrome.proxy.onProxyError` and a failure to apply settings at all feed one
path, `raiseProxyError()`. It records two things in `chrome.storage.session`:

- an **alert** (`sockitt-error`) — "requests are failing right now", carrying a
  `streak` count that drives the toolbar badge (`!`, `!4`, `!9+`);
- a **log entry** (`sockitt-error-log`) — the history behind it, capped at 50,
  with identical consecutive failures collapsed into one entry plus a count so a
  proxy that has been down for an hour is one line, not a thousand.

Chrome's event says a proxy failed but never *which* one, so the worker stamps
each entry with the route in force at the time: the exact server when the active
profile routes everything the same way (`staticTerminal`), or the reachable
proxy set when it decides per request. Guessing one of the latter would be worse
than naming the shortlist.

**Clearing is the interesting part.** Chrome reports failures and never
recoveries, so "the proxy works again" has to be inferred from the failures
stopping. Every failure re-arms a 30-second decay, as *both* a
`chrome.alarms` alarm and a `setTimeout`: the alarm survives the worker being
suspended (a lone timeout would die with it and leave the badge stuck on
forever, the bug this replaced), while the timeout is the one that fires
punctually, since `chrome.alarms` clamps short delays to 30s on Chrome 120+ and
to a full minute below that. Whichever fires first wins; `decayProxyAlert()` is
idempotent. Applying settings clears the alert immediately too, and a proxy that
is still down simply re-raises on its next request.

The badge belongs to the worker, but the alert can be dropped from several
places (a re-apply, the decay, Dismiss on the options page), so a
`storage.onChanged` listener watches the *cleared edge* of `sockitt-error` and
repaints once for all of them. It re-derives the badge from live state rather
than blindly blanking it, so it cannot race a concurrent apply into showing "all
fine" when another extension has taken proxy control, or when a fresh failure
landed while the repaint was in flight.

The UI never shows this as a banner. The popup renders a warning triangle inside
its fixed-height top bar — a banner there would push both panes down inside a
720x520 window, shifting whatever the user was about to click — and the detail
lives on the options page's **Proxy errors** panel, which has room for the
carrier, the advice, and the log.

After applying settings the worker also checks `levelOfControl`, and if another
extension holds proxy control the badge and title say so instead of pretending
to work.

## Storage and lifecycle

The whole config is one JSON document under the `sockitt` key in
`chrome.storage.local`. `sanitizeConfig()` validates every load, and the same
routine backs the options page's Import feature, so untrusted files cannot
smuggle malformed state in. The MV3 worker is effectively stateless: any wake-up
(`onStartup`, `onInstalled`, a storage change) re-derives everything from
storage.
