# Sockitt Privacy Policy

**Effective date:** 24 July 2026

Sockitt is a browser extension that switches your browser between proxy
servers. This policy explains what data the extension handles and what it does
with it.

## Summary

**Sockitt has no analytics, no tracking, and no advertising, and it does not
collect, sell, or share your personal data.** Everything the extension stores
stays on your own device (or in your own browser account if you turn on Sync).
The one server the developer operates is the optional **IP address lookup**
(`ipconfig.is`), which is off by default: with it off the extension contacts no
developer server at all, and even with it on the lookup receives only your
connecting IP — never your configuration, credentials, or browsing (see the IP
address lookups entry below). Uninstalling the extension removes its local data.

## What the extension handles, and why

All of the following stays on your device unless noted otherwise. None of it is
ever sent to the developer or to any third party.

- **Your configuration** - the proxy profiles, switching rules, and settings
  you create. Stored locally via `chrome.storage.local`.
- **Sync (optional, off by default)** - if you enable "Sync configuration",
  your configuration is mirrored through your browser's built-in account sync
  (`chrome.storage.sync`) so your other signed-in browsers can pick it up. This
  data travels through your browser vendor's sync service under your own
  account; the developer has no access to it and operates no server. Proxy
  credentials are excluded from sync — they never leave the device.
- **Proxy credentials (optional)** - if you add a username and password to an
  HTTP or HTTPS proxy profile, they are stored with that profile locally and
  used only to answer that proxy's authentication challenges. They are never
  transmitted anywhere except to the proxy you configured, as part of normal
  proxy authentication, and they are excluded from Sync. The one way they can
  leave the device is a backup you create yourself: the Export button writes
  your full configuration — credentials included, in plain text — to a JSON
  file, so treat exported backups as secrets.
- **The proxy error log** - when a proxy fails, Sockitt records the browser's
  error code, the time, and which of your proxy profiles was carrying traffic
  (name, address, and port) so the Proxy errors page can tell you what broke.
  It is held in `chrome.storage.session` only: gone when the browser restarts,
  never written to your saved configuration, and never synced. It records no
  credential and no page address, and nothing in it is transmitted anywhere —
  the "Copy report" button puts it on your own clipboard and nowhere else.
- **The active tab's address** - when you open the popup (or enable the
  optional per-tab route badge), Sockitt reads the current tab's URL to show
  which proxy that page will use and to let you add or override a rule for it.
  This is used momentarily to compute routing and is not stored, logged, or
  transmitted.
- **Open tab addresses (optional)** - if you have granted the optional `tabs`
  permission, the Overview page's "Where your tabs go" card reads the URLs of
  your open tabs, resolves each one through your own rules, and shows how many
  land on each profile. Only the counts are ever displayed; the addresses are
  used in memory to compute them and are not stored, logged, or transmitted.
  Without that grant the card shows nothing and reads no URL.
- **Which profile was active, and when** - the Overview page's session timeline
  records the profile id and the time on each switch. Like the error log it is
  held in `chrome.storage.session` only: gone when the browser restarts, never
  written to your saved configuration, and never synced. It records no address
  of any kind.
- **Rule-list subscriptions (optional)** - if you add a rule-list profile with
  a URL, your browser fetches that list directly from the address you entered,
  on the schedule you set, and stores the returned text locally as routing
  patterns. These requests go from your browser to that URL; the developer is
  not involved and receives nothing.
- **IP address lookups (optional, off by default)** - the popup's exit-IP line,
  the same line on the Overview page, and the proxy "Test connection" button
  fetch `ipconfig.is/json`, an IP-echo service operated by the Sockitt
  developer, to display the IP address, country, and latency your traffic exits
  with. All are **off by default**: Sockitt makes no such request unless you
  turn on **IP address lookups** in Settings. With it on, the popup line runs
  when you open the popup, after a switch, and when a this-tab route change
  could move the exit; the Overview line runs when that page is open and the
  active profile changes; the test button runs only when you click it. With it
  off (the default), none of them ever runs. The request
  carries no identifying payload — the service simply reports the connecting
  address back, and Sockitt keeps the result only in `chrome.storage.session`
  (in memory, not written to disk; cleared when the browser closes). Access to
  `ipconfig.is` is an optional permission requested when you turn the setting on.

## What the extension does not do

- It does not collect or transmit your browsing history.
- It does not read, record, or modify the content of the pages you visit.
- It does not contain analytics, telemetry, crash reporting, or advertising.
- With IP address lookups off (the default), it sends no data to the developer
  and contacts no developer-operated server. With them on, the only
  developer-operated server it contacts is `ipconfig.is`, which receives just
  the connecting IP of the lookup request — never your configuration,
  credentials, or browsing history.

## Traffic routed through your proxies

When a proxy profile is active, your web traffic is routed through the proxy
server you configured. That server (and its operator) can see the traffic you
send through it, exactly as with any proxy. Sockitt only selects which proxy is
used; it does not operate any proxy and is not responsible for how a third-party
proxy handles your traffic. Choose proxies you trust.

## Permissions

Sockitt requests only the permissions its features need. By default:
`proxy` (apply proxy settings), `storage` (save your configuration),
`activeTab` (read the current tab's URL in the popup), and `alarms` (schedule
rule-list refreshes). Optional permissions are requested only when you turn on
the feature that needs them: `tabs` (per-tab route badge, and the Overview's
tab breakdown), `webRequest` +
`webRequestAuthProvider` + host access (only to answer HTTP/HTTPS proxy
authentication challenges with your saved credentials), and access to
`ipconfig.is` (only for IP address lookups — the exit-IP line and connection
test — which are off by default). Sockitt requests no host permissions by
default.

## Data retention and removal

Local configuration is kept until you delete it in the extension or uninstall
Sockitt. Synced configuration is managed by your browser account and is removed
when you disable Sync in Sockitt (which clears the synced copy) or through your
browser account's data controls.

## Changes to this policy

If this policy changes, the updated version will be published in this
repository and the effective date above will be revised.

## Contact

Questions or concerns: please open an issue at
<https://github.com/ptmplop/Sockitt/issues>.
