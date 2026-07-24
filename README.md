<p align="center">
  <img src="img/logo-banner.png" width="300" alt="Sockitt - Proxify your browser.">
</p>

<p align="center">
  <b>A fast, minimal proxy switcher for Chromium browsers.</b><br>
  One-click switching, rule-based auto routing, zero frameworks, Manifest V3.
</p>

<p align="center">
  <a href="https://github.com/ptmplop/Sockitt/releases/latest">Download</a> &nbsp;·&nbsp;
  <a href="docs/rules.md">Rules reference</a> &nbsp;·&nbsp;
  <a href="docs/architecture.md">Architecture</a> &nbsp;·&nbsp;
  <a href="docs/development.md">Development</a>
</p>

---

Sockitt manages your proxies - SOCKS5, SOCKS4, HTTP, and HTTPS - and decides,
per request, whether traffic goes direct or through one. It is a ground-up,
modern take on the classic proxy-switcher extension: no frameworks, a minimal
default permission set, and a rule engine that compiles to an optimised PAC
script.

<table align="center">
  <tr>
    <td align="center" valign="top"><img src="img/screenshots/popup.png" width="270" alt="Sockitt popup"><br><sub>Popup: switch profiles and manage the current site</sub></td>
    <td align="center" valign="top"><img src="img/screenshots/options.png" width="540" alt="Sockitt options - Auto Switch rules"><br><sub>Options: rule-based auto routing</sub></td>
  </tr>
</table>

## Features

- **Proxy profiles.** SOCKS5, SOCKS4, HTTP, or HTTPS servers with a host, port,
  and per-profile bypass list, plus optional username/password authentication
  for HTTP(S) proxies. Each profile has an identity: an initials avatar in a
  colour of your choice, drawn onto the toolbar icon while it is active.
- **Built-in modes.** *Direct* (no proxy) and *System* (use the OS proxy
  settings).
- **Auto Switch profiles.** An ordered, first-match-wins rule table. Route by
  host wildcard (`*.example.com`), host regex, URL wildcard, URL regex, URL
  keyword, IPv4 CIDR (`10.0.0.0/8`), host-label count, weekday, or time of day.
  Rules can target a proxy, Direct, another switch profile, a rule list, or an
  alias.
- **Rule lists.** Subscribe to AutoProxy/GFWList or Switchy-format lists by URL
  with auto-update, or paste one in. Domain entries compile to a single
  dictionary lookup, so even very large lists stay fast.
- **Aliases.** Pointer profiles: aim many rules at one alias, then retarget them
  all by editing the alias once.
- **Popup switcher.** Change profile in one click, see where the current tab
  routes, edit the matching rule inline, or set a temporary per-site override
  that lasts only until the browser restarts.
- **Quick switch.** Cycle a chosen set of profiles from the toolbar button or a
  keyboard shortcut, without opening the popup.
- **Sync and control.** Optional configuration sync across machines via your
  browser account, a startup profile, and a guard that re-takes proxy control
  if another extension grabs it.
- **Honest failure states.** A red `!` badge appears if the proxy errors or
  another extension controls proxy settings. When a proxy is down, requests
  fail closed rather than silently leaking direct.

## Install

**From a release (easiest).** Download `sockitt.zip` from the
[latest release](https://github.com/ptmplop/Sockitt/releases/latest) and unzip
it. Open `chrome://extensions`, enable **Developer mode**, click **Load
unpacked**, and select the unzipped folder. (The same zip is the artifact
intended for the Chrome Web Store; a store listing is planned.)

**From source.**

```sh
git clone https://github.com/ptmplop/Sockitt
cd Sockitt
npm install
npm run build
```

Then load the `dist/` folder unpacked as above. Works on Chrome, Edge, Brave,
Opera, Vivaldi, and other Chromium browsers (Chrome 110+).

## Quick start

1. Click the Sockitt icon, then **Manage** > **New proxy**. Pick the protocol
   and enter the host and port - for example a SOCKS5 `ssh -D 1080 myserver`
   tunnel on `127.0.0.1:1080`, or an HTTP proxy with a username and password.
2. Pick the profile in the popup. Everything now routes through it.
3. For per-site routing, create an **Auto Switch** profile and activate it. As
   you browse, the popup shows where the current tab routes and lets you add or
   edit a rule for it - permanently, or as a temporary override.

See [docs/rules.md](docs/rules.md) for the full pattern syntax and
[docs/architecture.md](docs/architecture.md) for how it works internally.

## Permissions and privacy

By default Sockitt requests four permissions - `proxy`, `storage`, `activeTab`,
and `alarms` - and **no host permissions**. It cannot read your browsing
history, does not touch page content, and contains no analytics of any kind.
The only network requests it makes are fetches of rule-list URLs that you
configure.

Extra capabilities are strictly opt-in and requested only when you use them:

- **Per-tab route badge** requests `tabs`.
- **HTTP/HTTPS proxy authentication** requests `webRequest`,
  `webRequestAuthProvider`, and all-sites access, which Chromium needs to answer
  proxy auth challenges. Sockitt asks the first time you set a username.
- **Sync** stores your configuration in your own browser account
  (`chrome.storage.sync`).

## Limitations

- **No SOCKS authentication.** This is a Chromium limitation, not a Sockitt
  choice; secure SOCKS proxies with an IP allow-list or a local tunnel
  (`ssh -D`, WireGuard, and so on). HTTP and HTTPS proxies support
  username/password auth.
- **IPv4-only CIDR.** CIDR rules match literal IPv4 hosts. Sockitt never
  resolves DNS in the request path, and IPv6 CIDR is not supported.
- **Chromium-family browsers only.**

## Development

```sh
npm install
npm run typecheck   # strict TypeScript, no emit
npm test            # runs generated PAC scripts in a Node VM
npm run build       # production build to dist/
npm run watch       # dev build with inline sourcemaps
npm run zip         # store-ready sockitt.zip
npm run icons       # regenerate icons from img/logo-source.png (needs ImageMagick)
```

Project layout and design notes are in [docs/development.md](docs/development.md).

## Acknowledgements

Sockitt is an independent, from-scratch implementation. Its concepts - proxy
profiles, PAC-based automatic switching, and the AutoProxy and Switchy
rule-list formats - are informed by
[Proxy SwitchyOmega](https://github.com/FelisCatus/SwitchyOmega) and its
Manifest V3 fork [ZeroOmega](https://github.com/zero-peak/ZeroOmega), which were
studied as a reference while designing this extension. Sockitt shares no code
with those projects and is released under the MIT license. Thanks to their
authors and maintainers for the prior art.

## License

[MIT](LICENSE)
