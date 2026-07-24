import { el } from '../shared/ui';

/* Small builders for readable, consistent documentation blocks. */

function card(title: string, ...children: (Node | string | null)[]): HTMLElement {
  return el('div', { class: 'card panel doc-card' }, el('h3', {}, title), ...children);
}

function p(...children: (Node | string)[]): HTMLElement {
  return el('p', { class: 'doc-p' }, ...children);
}

function code(text: string): HTMLElement {
  return el('code', { class: 'doc-code' }, text);
}

function ul(items: (Node | string)[]): HTMLElement {
  return el('ul', { class: 'doc-list' }, ...items.map((i) => el('li', {}, i)));
}

/** A definition list: [term, ...description nodes]. */
function terms(rows: Array<[string, (Node | string)[]]>): HTMLElement {
  return el(
    'dl',
    { class: 'doc-dl' },
    ...rows.flatMap(([term, desc]) => [
      el('dt', {}, term),
      el('dd', {}, ...desc),
    ])
  );
}

function table(headers: string[], rows: (Node | string)[][]): HTMLElement {
  return el(
    'div',
    { class: 'doc-table-wrap' },
    el(
      'table',
      { class: 'doc-table' },
      el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', {}, h)))),
      el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((c) => el('td', {}, c)))))
    )
  );
}

export function docsPanel(): HTMLElement {
  return el(
    'div',
    { class: 'pane docs' },

    card(
      'What Sockitt does',
      p(
        'Sockitt routes your browser traffic through proxies. You create ',
        el('em', {}, 'profiles'),
        ', pick which one is active from the toolbar popup, and — with an Auto Switch profile — let rules decide per site whether a request goes direct or through a proxy.'
      ),
      p(
        'Everything is stored locally in the browser. The only network requests Sockitt makes on its own are fetches of rule-list URLs that you configure.'
      )
    ),

    card(
      'Quick start',
      el(
        'ol',
        { class: 'doc-list' },
        el('li', {}, 'Click ', code('New proxy'), ' and enter your SOCKS5 host and port (for example an ', code('ssh -D 1080 myserver'), ' tunnel on ', code('127.0.0.1:1080'), ').'),
        el('li', {}, 'Open the toolbar popup and select the profile — all traffic now goes through it.'),
        el('li', {}, 'For per-site routing, create an ', code('Auto Switch'), ' profile, activate it, and add rules (or add them straight from the popup while browsing).')
      )
    ),

    card(
      'Profile types',
      terms([
        ['Direct (built-in)', ['No proxy — traffic goes straight to the network.']],
        ['System (built-in)', ['Follows the proxy settings configured in your operating system.']],
        ['Proxy', ['A single proxy server — SOCKS5, SOCKS4, HTTP, or HTTPS — with a host, port, and bypass list. Activate it to send everything through that server.']],
        ['Auto Switch', ['An ordered list of rules that route each request to a target based on its URL, host, IP, or the time of day. This is the profile the popup lets you manage per site.']],
        ['Rule list', ['Subscribes to an AutoProxy/GFWList or Switchy-format list (by URL or pasted in) and routes matching sites to a chosen target.']],
        ['Alias', ['A pointer to another profile. Aim several rules at one alias, then change the alias target once to retarget them all together.']],
      ])
    ),

    card(
      'Auto Switch rules',
      p(
        'Rules are evaluated top to bottom and the ',
        el('strong', {}, 'first match wins'),
        '. If nothing matches, the profile’s ',
        code('Everything else'),
        ' target applies. Drag the ',
        code('⋮⋮'),
        ' handle to reorder; toggle a rule off to disable it without deleting it. A rule can route to a proxy, Direct, another Auto Switch profile, a rule list, or an alias.'
      ),
      table(
        ['Condition', 'Example', 'Matches when…'],
        [
          [code('Host wildcard'), code('*.example.com'), 'the hostname is example.com or any subdomain. * matches any run of characters, ? matches one.'],
          [code('Host regex'), code('(^|\\.)example\\.(com|net)$'), 'a JavaScript regular expression matches the hostname (unanchored — anchor it yourself).'],
          [code('URL wildcard'), code('https://example.com/api/*'), 'a wildcard matches the full URL (a trailing * is implied).'],
          [code('URL regex'), code('^https?://example\\.com/'), 'a JavaScript regular expression matches the full URL.'],
          [code('IP / CIDR'), code('10.0.0.0/8'), 'the hostname is a literal IPv4 address inside the block (no DNS lookup; IPv6 not supported).'],
          [code('URL keyword'), code('tracker'), 'the substring appears anywhere in the URL.'],
          [code('Host levels'), code('2-4'), 'the hostname has that many dot-separated labels (example.com = 2, a.b.example.com = 4).'],
          [code('Weekday'), code('mon-fri'), 'today is in the set. Ranges may wrap the week (fri-mon); digits 0–6 (0 = Sunday) also work.'],
          [code('Time of day'), code('22:00-06:00'), 'the current time is in the range. Ranges may wrap midnight.'],
        ]
      ),
      el('p', { class: 'doc-note' },
        'For https pages the browser only exposes the scheme and host to the proxy resolver, so URL-path rules effectively behave as host-level rules on https. Time and weekday decisions may take a moment to apply on already-visited sites because the browser briefly caches proxy decisions.')
    ),

    card(
      'Proxy protocols & authentication',
      p('A proxy profile can use any protocol Chromium supports:'),
      table(
        ['Protocol', 'Notes'],
        [
          [code('SOCKS5'), 'Recommended for SSH tunnels (ssh -D) and most proxies. No authentication (Chromium limitation).'],
          [code('SOCKS4'), 'Older SOCKS; no authentication.'],
          [code('HTTP'), 'Standard HTTP proxy. Supports username/password authentication.'],
          [code('HTTPS'), 'HTTP proxy over TLS. Supports username/password authentication.'],
        ]
      ),
      p(
        'For HTTP/HTTPS proxies you can set a username and password. Answering proxy authentication challenges needs an optional permission (', code('webRequest'),
        ' plus access to all sites) — Sockitt asks for it the first time you set a username, and only then. SOCKS proxies cannot be authenticated by Chromium; secure them with an IP allow-list or a local tunnel instead.'
      )
    ),

    card(
      'Bypass lists',
      p('Each proxy profile has a bypass list — hosts that always connect directly even when that profile is active (whether chosen directly or reached by a rule). One entry per line:'),
      table(
        ['Entry', 'Meaning'],
        [
          [code('<local>'), 'localhost, 127.0.0.1, [::1], and any dotless hostname (nas, router).'],
          [code('*.internal.example'), 'a host wildcard, same syntax as rules.'],
          [code('10.0.0.0/8'), 'an IPv4 CIDR block.'],
          [code('printer.lan'), 'an exact host.'],
        ]
      )
    ),

    card(
      'Rule lists',
      p('A rule-list profile routes URLs that match an online (or pasted) list through a chosen target. Whitelist entries always win and go to the profile’s default target. Two formats:'),
      terms([
        ['AutoProxy / GFWList', [
          'Lines: ', code('||domain'), ' (host or subdomain), ', code('|https://prefix'), ' (URL prefix), ', code('/regex/'), ', a bare keyword, ', code('@@'), ' to whitelist, and ', code('!'), ' for comments. Base64-encoded payloads (GFWList’s format) are decoded automatically.',
        ]],
        ['Switchy', [
          'One pattern per line: bare patterns are host wildcards, entries containing ', code('://'), ' are URL wildcards, ', code('@@'), ' whitelists, and ', code('#'), ' / ', code(';'), ' / ', code('!'), ' start comments.',
        ]],
      ]),
      p(
        'Set an ', code('Auto-update'), ' interval (hours; 0 disables) to refresh from the URL automatically, or press ',
        code('Update now'), '. The URL’s host must allow cross-origin requests — ', code('raw.githubusercontent.com'), ' does. Domain entries compile to a single dictionary lookup, so even very large lists stay fast.'
      )
    ),

    card(
      'The toolbar popup',
      p('Clicking the Sockitt icon opens the popup, where you switch the active profile in one click. When an Auto Switch profile is active, the top section manages the current site:'),
      terms([
        ['Rule', ['Shows the rule that currently matches this site and lets you change its target inline, or add a ', code('*.host'), ' rule if none exists.']],
        ['Override', ['A single, always-temporary rule for the current site. It takes priority over permanent rules and is cleared when the browser restarts (or when you remove it). While an override is set, the permanent rule is greyed out.']],
      ]),
      p('The footer’s ', code('Manage profiles & rules'), ' opens this options page.')
    ),

    card(
      'Settings reference',
      el('h4', { class: 'doc-sub' }, 'Switching'),
      terms([
        ['Quick switch', ['When on, clicking the toolbar icon cycles through the profiles you’ve ticked instead of opening the popup. The cycle keyboard shortcut works either way.']],
        ['On browser startup, activate', ['Which profile becomes active when the browser starts. ', code('Last used'), ' keeps whatever was active before.']],
        ['Reload tab after switching', ['Reload the active tab after you pick a profile in the popup, so the page reloads through the new route.']],
      ]),
      el('h4', { class: 'doc-sub' }, 'Behaviour'),
      terms([
        ['Guard proxy control', ['If another extension takes over the browser’s proxy settings, Sockitt re-applies its own (at most once every 30 seconds).']],
        ['Per-tab route badge', ['Shows which profile the current tab routes through as a small badge on the toolbar icon. Requires the optional ', code('tabs'), ' permission, which is requested when you enable it.']],
        ['Quick-added rules go to the bottom', ['Rules added from the popup are appended below existing rules. Turn off to give them top priority instead.']],
        ['Confirm before deleting', ['Ask for confirmation before a profile is deleted or everything is reset.']],
      ]),
      el('h4', { class: 'doc-sub' }, 'Sync'),
      terms([
        ['Sync configuration', ['Mirrors profiles and rules to your browser account so other machines pick them up; the newest change wins. Large rule-list bodies are not synced — set a URL so each machine refreshes its own copy. Enabling sync on a machine that already has a synced setup adopts the existing one rather than overwriting it.']],
      ])
    ),

    card(
      'Identity & appearance',
      terms([
        ['Name', ['A label for the profile, shown in the popup and this page.']],
        ['Initials', ['1–3 characters drawn on the toolbar icon while the profile is active. Left blank, they’re derived from the name.']],
        ['Colour', ['Tints the profile’s avatar and its toolbar icon, so you can tell at a glance which profile is live.']],
      ]),
      p('The toolbar icon always reflects the active profile; a red ', code('!'), ' badge appears if the proxy reports an error or another extension is controlling proxy settings.')
    ),

    card(
      'Backup, import & reset',
      terms([
        ['Export', ['Downloads your entire configuration as a JSON file.']],
        ['Import', ['Loads a configuration from a JSON file, replacing the current one. Imported data is validated, so a malformed file can’t break the extension.']],
        ['Reset', ['Removes all profiles and rules and returns to the System profile. Settings are kept.']],
      ])
    ),

    card(
      'Keyboard shortcuts',
      p('Set or change these at ', code('chrome://extensions/shortcuts'), '.'),
      ul([
        el('span', {}, code('Alt+Shift+S'), ' — open the Sockitt popup (default).'),
        el('span', {}, 'Cycle to the next quick-switch profile — unbound by default; assign a key if you use Quick switch.'),
      ])
    ),

    card(
      'Limitations',
      ul([
        'SOCKS proxies cannot be authenticated (a Chromium limitation) — use an IP allow-list or a local tunnel. HTTP/HTTPS proxies support username/password auth.',
        'IP / CIDR rules match literal IPv4 hosts only; Sockitt never resolves DNS while routing, and IPv6 CIDR is not supported.',
        'Chromium-family browsers only (Chrome, Edge, Brave, Opera, Vivaldi).',
      ])
    )
  );
}
