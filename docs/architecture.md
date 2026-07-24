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

## Error surfacing

`chrome.proxy.onProxyError` stores the failure in `chrome.storage.session` and
sets a red `!` badge; the popup shows the message. After applying settings the
worker also checks `levelOfControl`, and if another extension holds proxy
control the badge and title say so instead of pretending to work.

## Storage and lifecycle

The whole config is one JSON document under the `sockitt` key in
`chrome.storage.local`. `sanitizeConfig()` validates every load, and the same
routine backs the options page's Import feature, so untrusted files cannot
smuggle malformed state in. The MV3 worker is effectively stateless: any wake-up
(`onStartup`, `onInstalled`, a storage change) re-derives everything from
storage.
