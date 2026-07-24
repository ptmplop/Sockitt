# Sockitt Privacy Policy

**Effective date:** 24 July 2026

Sockitt is a browser extension that switches your browser between proxy
servers. This policy explains what data the extension handles and what it does
with it.

## Summary

**Sockitt does not collect, transmit, sell, or share any personal data.** It
has no analytics, no tracking, no advertising, and no backend server operated
by the developer. Everything the extension stores stays on your own device (or
in your own browser account if you turn on Sync). Uninstalling the extension
removes its local data.

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
- **The active tab's address** - when you open the popup (or enable the
  optional per-tab route badge), Sockitt reads the current tab's URL to show
  which proxy that page will use and to let you add or override a rule for it.
  This is used momentarily to compute routing and is not stored, logged, or
  transmitted.
- **Rule-list subscriptions (optional)** - if you add a rule-list profile with
  a URL, your browser fetches that list directly from the address you entered,
  on the schedule you set, and stores the returned text locally as routing
  patterns. These requests go from your browser to that URL; the developer is
  not involved and receives nothing.

## What the extension does not do

- It does not collect or transmit your browsing history.
- It does not read, record, or modify the content of the pages you visit.
- It does not contain analytics, telemetry, crash reporting, or advertising.
- It does not send any data to the developer, and the developer runs no server
  that receives your data.

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
the feature that needs them: `tabs` (per-tab route badge), and `webRequest` +
`webRequestAuthProvider` + host access (only to answer HTTP/HTTPS proxy
authentication challenges with your saved credentials). Sockitt requests no
host permissions by default.

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
