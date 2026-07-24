# Architecture

## Design in one paragraph

UI pages never touch proxy APIs. The popup and options app read and write a
single config object in `chrome.storage.local`; the service worker
([`src/background.ts`](../src/background.ts)) observes storage changes,
compiles the active profile into browser proxy settings, applies them via
`chrome.proxy`, and repaints the toolbar icon. One writer, one applier, no
races, and the UI stays a dumb view over stored state.

```
popup ──┐                       ┌─> chrome.proxy.settings
        ├─> chrome.storage ──> background.ts ─┤
options ┘        (config)                     └─> action icon / badge / title
```

## Modules

| File | Role |
|---|---|
| `src/shared/types.ts` | Data model: `Config`, `ProxyProfile`, `SwitchProfile`, `SwitchRule` |
| `src/shared/match.ts` | Compiles conditions to matcher primitives; TS-side evaluator |
| `src/shared/pac.ts` | Generates the PAC script from a switch profile |
| `src/shared/state.ts` | Storage load/save + `sanitizeConfig` (also validates imports/sync), temp rules |
| `src/shared/rulelist.ts` | AutoProxy/GFWList + Switchy list parsing (with base64 decode + memo) |
| `src/shared/sync.ts` | Chunked config mirroring over `chrome.storage.sync`, last-write-wins by revision |
| `src/shared/avatar.ts` | Initials avatars (DiceBear-initials style, local): derivation, contrast, DOM tile |
| `src/background.ts` | The applier: settings, icon painting, proxy-error badge |
| `src/popup/` | Switcher UI + live route preview |
| `src/options/` | Profile/rule management UI |

There is no UI framework. `src/shared/ui.ts` is a ~30-line `el()` helper; each
page re-renders its DOM from state, which at this scale is faster than any
framework's runtime would be.

## How profiles become proxy settings

| Active profile | `chrome.proxy` mode |
|---|---|
| Direct | `direct` |
| System | `system` |
| SOCKS5 profile (or an alias chain ending at one) | `fixed_servers` (scheme `socks5` + native bypass list) |
| Auto Switch / rule list (anything conditional) | `pac_script` with generated code, `mandatory: true` |

Profiles form a graph: switch rules and rule lists can target other profiles.
The compiler emits one function per reachable profile and resolves cycles to
DIRECT; `staticTerminal()` collapses unconditional alias chains so they still
take the `fixed_servers` fast path. Session-scoped temp rules are injected
above the active switch profile's permanent rules at compile time.

`mandatory: true` means a failing proxy fails the request rather than falling
back to a direct connection — deliberate, so a dead proxy can never silently
leak traffic.

## The PAC compiler

`compilePac()` emits a self-contained, ES5-flavoured script shaped for
per-request speed inside Chrome's PAC sandbox:

- **Regexes are constructed once** at the top level into a table `R`; the hot
  path only calls `.test()`. A unit test asserts no `new RegExp` appears
  inside `FindProxyForURL`.
- **`*.host` wildcards never become regexes** — they compile to a suffix
  string comparison (`E(h, ".example.com")`) plus a bare-domain equality
  check.
- **CIDR rules become one integer op** — the pattern is pre-parsed at compile
  time into base/mask integers; at request time the host is parsed to an
  IPv4 int at most once and tested with `(ip & mask) === base`.
- **Bypass lists are shared** — each distinct proxy target becomes one
  function containing its bypass checks, reused by every rule that routes
  there.
- **No DNS calls** (`dnsResolve`) ever — PAC-side DNS would add a blocking
  lookup to every request.

Rules with invalid patterns compile to nothing (the options UI flags them
red), so one bad regex can't take down routing.

Example output for one wildcard rule, one URL regex and one CIDR rule:

```js
var R=[new RegExp("^https://cdn\\.")];
function E(h,s){var d=h.length-s.length;return d>=0&&h.lastIndexOf(s)===d;}
function A(h){ /* IPv4 literal -> uint32, else -1 */ }
function T0(url,h,ip){ /* bypass checks */ return "SOCKS5 203.0.113.7:1080";}
function FindProxyForURL(url,host){
  var h=host.toLowerCase();var ip=A(h);
  if((h==="example.com"||E(h,".example.com")))return T0(url,h,ip);
  if(R[0].test(url))return T0(url,h,ip);
  if((ip>=0&&((ip&-16777216)>>>0)===167772160))return T0(url,h,ip);
  return "DIRECT";
}
```

## Route preview parity

The popup shows where the current tab would route by evaluating the same
compiled conditions in TypeScript (`resolveRoute()` in `match.ts`). A test
runs every fixture through **both** the generated PAC (in a Node VM) and
`resolveRoute()` and asserts they agree, so the preview can't drift from
reality.

## Error surfacing

`chrome.proxy.onProxyError` stores the failure in `chrome.storage.session` and
sets a red `!` badge; the popup shows the message. After applying settings the
worker also checks `levelOfControl` — if another extension holds proxy
control, the badge and title say so instead of pretending to work.

## Storage & lifecycle

The whole config is one JSON document under the `sockitt` key in
`chrome.storage.local`. `sanitizeConfig()` validates every load — the same
routine backs the options page's Import feature, so untrusted files can't
smuggle malformed state. The MV3 worker is stateless: any wake-up
(`onStartup`, `onInstalled`, storage change) re-derives everything from
storage.
