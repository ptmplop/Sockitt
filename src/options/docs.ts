import { el } from '../shared/ui';

/* Small builders for readable, consistent documentation blocks. */

/** Stable in-page anchor derived from the card title (see toc). */
function slug(title: string): string {
  return 'doc-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function card(title: string, ...children: (Node | string | null)[]): HTMLElement {
  return el('div', { class: 'card panel doc-card', id: slug(title) }, el('h3', {}, title), ...children);
}

/**
 * In-page nav, derived from the card nodes themselves rather than a parallel
 * list of titles — so it can never drift out of step with the page.
 */
function toc(cards: HTMLElement[]): HTMLElement {
  return el(
    'nav',
    { class: 'doc-toc', ariaLabel: 'On this page' },
    ...cards.map((c) =>
      el(
        'a',
        {
          href: '#' + c.id,
          onclick: (e: Event) => {
            e.preventDefault();
            c.scrollIntoView({ behavior: 'smooth', block: 'start' });
          },
        },
        c.querySelector('h3')?.textContent ?? ''
      )
    )
  );
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
    ...rows.flatMap(([term, desc]) => [el('dt', {}, term), el('dd', {}, ...desc)])
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

function version(): string {
  try {
    return 'v' + chrome.runtime.getManifest().version;
  } catch {
    return '';
  }
}

/** The docs never change within a session; build the tree once per page. */
let cachedPanel: HTMLElement | null = null;

export function docsPanel(): HTMLElement {
  cachedPanel ??= buildDocsPanel();
  return cachedPanel;
}

function buildDocsPanel(): HTMLElement {
  const v = version();

  const cards = [
    card(
      'What Sockitt does',
      p(
        'Sockitt answers one question for every request your browser makes: does this go straight out to the network, or through a proxy — and if so, which one? You describe the answer once, as ',
        el('em', {}, 'profiles'),
        ', and Sockitt applies it to every request from then on.'
      ),
      p(
        'A profile is one of six things. ', code('Direct'), ' and ', code('System'), ' are built in and need no setup. A ',
        code('Proxy'), ' is a single server — SOCKS5, SOCKS4, HTTP, or HTTPS. An ', code('Auto switch'),
        ' is an ordered list of rules that picks between the others per request. A ', code('Rule list'),
        ' does the same from a subscribed AutoProxy/GFWList or Switchy list. An ', code('Alias'),
        ' is a pointer, so many rules can be retargeted by editing one thing. One profile is active at a time; you choose it in the toolbar popup, with a keyboard shortcut, or automatically at browser start. Incognito windows can follow a second profile of their own — see Settings.'
      ),
      p(
        'Activate a plain proxy and everything goes through it, minus that profile’s bypass list. Activate an Auto switch and the decision becomes per-request: rules are checked top to bottom, the first match wins, and each one can send the request to a proxy, to Direct, or on to another profile. Because profiles can point at profiles, a large setup stays a graph you edit in one place instead of a rule table you keep rewriting.'
      ),
      p(
        'Anything conditional is compiled into a PAC script that the browser runs for each request, with the work done up front: host wildcards become suffix comparisons, CIDR blocks become a single integer test, and rule-list domains become one dictionary lookup, so thousands of domain entries cost about what a single rule does. A plain proxy with an empty bypass list skips the PAC entirely and uses the browser’s own fixed-proxy mode.'
      ),
      p(
        'Either way the route is ',
        el('em', {}, 'mandatory'),
        ' — when a proxy is unreachable its requests fail rather than quietly retrying direct, so a dead proxy can never leak the traffic you meant to route through it.'
      ),
      p(
        'While you browse, the popup shows where the current tab actually lands — which rule decided it and the chain it walked — and lets you add, retarget, delete, or temporarily override that site’s rule without leaving the page.'
      )
    ),

    card(
      'Quick start',
      el(
        'ol',
        { class: 'doc-list' },
        el('li', {}, 'In the sidebar under ', code('Create'), ', click ', code('Proxy'), ', choose the protocol, and enter the host and port (for example a SOCKS5 ', code('ssh -D 1080 myserver'), ' tunnel on ', code('127.0.0.1:1080'), ', or an HTTP proxy with a username and password).'),
        el('li', {}, 'Open the toolbar popup and select the profile; all traffic now goes through it.'),
        el('li', {}, 'For per-site routing, create an ', code('Auto switch'), ' profile, activate it, and add rules (or add them straight from the popup while browsing).')
      )
    ),

    card(
      'Profile types',
      terms([
        ['Direct (built-in)', ['No proxy; traffic goes straight to the network.']],
        ['System (built-in)', ['Follows the proxy settings configured in your operating system.']],
        ['Proxy', ['A single proxy server (SOCKS5, SOCKS4, HTTP, or HTTPS) with a host, port, and bypass list. Activate it to send everything through that server.']],
        ['Auto switch', ['An ordered list of rules that route each request to a target based on its URL, host, IP, or the time of day. This is the profile the popup lets you manage per site.']],
        ['Rule list', ['Subscribes to an AutoProxy/GFWList or Switchy-format list (by URL or pasted in) and routes matching sites to a chosen target.']],
        ['Alias', ['A pointer to another profile. Aim several rules at one alias, then change the alias target once to retarget them all together.']],
      ])
    ),

    card(
      'Auto switch rules',
      p(
        'Rules are evaluated top to bottom and the ',
        el('strong', {}, 'first match wins'),
        '. If nothing matches, the profile’s ',
        code('Everything else'),
        ' target applies. Drag the grip handle to reorder; toggle a rule off to disable it without deleting it. A rule can route to a proxy, Direct, another Auto switch profile, a rule list, or an alias.'
      ),
      table(
        ['Condition', 'Example', 'Matches when'],
        [
          [code('Host wildcard'), code('*.example.com'), 'the hostname is example.com or any subdomain. * matches any run of characters, ? matches one.'],
          [code('Host regex'), code('(^|\\.)example\\.(com|net)$'), 'a JavaScript regular expression matches the hostname (unanchored; anchor it yourself).'],
          [code('URL wildcard'), code('https://example.com/api/*'), 'a wildcard matches the full URL (a trailing * is implied).'],
          [code('URL regex'), code('^https?://example\\.com/'), 'a JavaScript regular expression matches the full URL (unanchored, like the host form).'],
          [code('IP / CIDR'), code('10.0.0.0/8'), 'the hostname is a literal IPv4 address inside the block (no DNS lookup; IPv6 not supported).'],
          [code('URL keyword'), code('tracker'), 'the substring appears anywhere in the URL.'],
          [code('Host levels'), code('2-4'), 'the hostname has that many dot-separated labels (example.com = 2, a.b.example.com = 4).'],
          [code('Weekday'), code('mon-fri'), 'today is in the set. Combine with commas (sat,sun) and ranges, which may wrap the week (fri-mon); digits 0 to 6 (0 = Sunday) also work.'],
          [code('Time of day'), code('22:00-06:00'), 'the current time is in the range. Ranges may wrap midnight.'],
        ]
      ),
      p(
        'Both regex conditions run on every request, so each pattern is checked for catastrophic backtracking before it is used. One whose quantifiers nest — ',
        code('(a+)+'),
        ' — is refused with “Pattern is too complex”; the same guard silently drops such entries from a subscribed rule list. An invalid pattern is inert rather than dangerous: the field is outlined in red and the rule simply never matches.'
      ),
      el('p', { class: 'doc-note' },
        'For https pages the browser only exposes the scheme and host to the proxy resolver, so URL-path rules effectively behave as host-level rules on https. Time and weekday decisions may take a moment to apply on already-visited sites because the browser briefly caches proxy decisions.')
    ),

    card(
      'Proxy protocols and authentication',
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
        ' plus access to all sites); Sockitt asks for it when you set credentials, and only then. If credentials arrive another way (an imported backup), the options page shows a notice with an ', code('Enable authentication'), ' button. Credentials stay on the device where you enter them — they are never synced. SOCKS proxies cannot be authenticated by Chromium; secure them with an IP allow-list or a local tunnel instead.'
      )
    ),

    card(
      'Bypass lists',
      p('Each proxy profile has a bypass list of hosts that always connect directly even when that profile is active (whether chosen directly or reached by a rule). One entry per line:'),
      table(
        ['Entry', 'Meaning'],
        [
          [code('<local>'), 'localhost, 127.0.0.1, [::1], and any dotless hostname (nas, router). An IPv6 literal is never treated as local, so a public IPv6 destination is not bypassed past the proxy.'],
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
          'Lines: ', code('||domain'), ' (host or subdomain), ', code('|https://prefix'), ' (URL prefix), ', code('/regex/'), ', ', code('@@'), ' to whitelist, and ', code('!'), ' or ', code('['), ' for comments and headers. Anything else is a URL substring — or a URL wildcard, if it contains ', code('*'), ' or ', code('?'), '. Base64-encoded payloads (GFWList’s format) are decoded automatically.',
        ]],
        ['Switchy', [
          'One pattern per line: bare patterns are host wildcards; entries containing ', code('://'), ' match the start of the URL, with a trailing ', code('*'), ' implied; ', code('@@'), ' whitelists; and ', code('#'), ' / ', code(';'), ' / ', code('!'), ' / ', code('['), ' start comments.',
        ]],
      ]),
      p(
        'Set an ', code('Auto-update'), ' interval to refresh from the URL automatically — in hours, up to 720 (30 days), or 0 to disable; new lists start at 24. You can also press ',
        code('Update now'), '. The URL’s host must allow cross-origin requests (', code('raw.githubusercontent.com'), ' does). Domain entries compile to a single dictionary lookup, so even very large lists stay fast.'
      )
    ),

    card(
      'The toolbar popup',
      p('Clicking the Sockitt icon opens the popup. The left pane switches the active profile in one click (a filter box appears once you have a dozen or more); the right pane is about the tab you are on. What it offers depends on which kind of profile is active:'),
      terms([
        ['Route', ['Always shown, for every profile kind: the profile this tab actually lands on, and a tag saying what decided it — a rule, your override, a bypass entry, the profile’s default, or the profile kind itself (“all traffic” for a plain proxy, “alias”, “rule list”).']],
        ['Rule for this site', ['With an Auto switch profile active: the rule that currently matches this site, whose target you can change inline — or an ', code('Add rule'), ' button offering a ', code('*.host'), ' rule if none matches. The ', code('✕'), ' deletes that rule outright; it is the same rule you would find in the profile’s table here, so deleting a broad pattern like ', code('*.example.com'), ' stops routing every site it covered, not just this one.']],
        ['Override', ['With an Auto switch profile active: a single, always-temporary rule for the current site. It takes priority over permanent rules and is cleared when the browser restarts (or when you remove it). While an override is set for the site you are on, its matching rule is greyed out.']],
        ['Send this site direct', ['With a plain proxy active: adds ', code('*.host'), ' to that proxy’s bypass list, so this one site skips the proxy while everything else keeps using it. The button is replaced by a note if a broader entry (', code('<local>'), ', a parent wildcard, a CIDR block) already sends the host direct, and by a removable chip once added.']],
        ['Exit IP', ['A small line under the active profile showing where the current tab actually exits — flag, IP, and lookup latency, with the country name spelled out in the tooltip. Uses ', code('ipconfig.is'), ' and is off by default; turn on IP address lookups in Settings to use it. The first time, the line offers a ', code('Show where this tab exits…'), ' button to grant the network access it needs.']],
      ]),
      p('For System, or for a page that is not http(s), the popup says so rather than guessing — Sockitt cannot inspect an OS PAC’s per-site rules. The footer’s ', code('Manage profiles & rules'), ' opens this options page.')
    ),

    card(
      'Testing and inspection',
      terms([
        ['Route inspector', ['The sidebar’s ', code('Route inspector'), ' page traces any URL through your configuration with the same resolver real routing uses: which rule fired (including the popup override), the chain it walked through aliases and rule lists, and the proxy it landed on. It starts from the active profile, or from any profile you pick — so you can check one before switching to it.']],
        ['Connection test', ['Every proxy editor has a ', code('Test connection'), ' button. It briefly routes your browsing through that proxy, fetches ', code('ipconfig.is'), ' to capture the exit IP, country, and latency, then restores your configuration — auth included, so wrong credentials show up here too. The result appears beside the button, and is not kept once you leave the page. It’s an ', code('ipconfig.is'), ' lookup, so it needs IP address lookups turned on in Settings (off by default).']],
      ])
    ),

    card(
      'Settings reference',
      el('h4', { class: 'doc-sub' }, 'Switching'),
      terms([
        ['Quick switch', ['When on, clicking the toolbar icon cycles through the profiles you’ve ticked instead of opening the popup (while it’s on, the popup itself is unavailable). Tick at least two entries — with fewer, the cycle falls back to Direct, System, and every profile. The cycle keyboard shortcut works either way.']],
        ['On browser startup, activate', ['Which profile becomes active when the browser starts. ', code('Last used'), ' keeps whatever was active before.']],
        ['Incognito windows use', ['Route incognito windows through their own profile while regular windows keep the active one. Requires ', code('Allow in Incognito'), ' for Sockitt at ', code('chrome://extensions'), '; without it (or set to ', code('Same as regular windows'), '), incognito follows the regular profile.']],
        ['Reload tab after switching', ['Reload the active tab after you pick a profile (or change this tab’s rule or override), so the page re-fetches through the new route. The reload waits until you close the popup — Chrome dismisses the popup when the page beneath it navigates, so reloading straight away would close it mid-change. Several changes in one visit collapse into a single reload.']],
      ]),
      el('h4', { class: 'doc-sub' }, 'Behaviour'),
      terms([
        ['Guard proxy control', ['If another extension takes over the browser’s proxy settings, Sockitt re-applies its own (at most once every 30 seconds).']],
        ['Per-tab route badge', ['Shows which profile the current tab routes through as a small badge on the toolbar icon. It appears only where the route depends on the request — an Auto switch or rule-list profile; with a plain proxy or an alias the icon already names the destination, so the badge stays clear. Requires the optional ', code('tabs'), ' permission, which is requested when you enable it.']],
        ['IP address lookups', ['The master switch for everything that contacts ', code('ipconfig.is'), ' — the popup’s exit-IP readout and the connection test. Off by default: Sockitt never reaches ', code('ipconfig.is'), ' until you turn it on (which requests access to it), and turning it off disables both. With it off, the only network requests Sockitt makes on its own are fetches of the rule-list URLs you configure.']],
        ['Quick-added rules go to the bottom', ['Rules added from the popup are appended below existing rules. Turn off to give them top priority instead.']],
        ['Confirm before deleting', ['Ask for confirmation before a profile is deleted or everything is reset.']],
      ]),
      el('h4', { class: 'doc-sub' }, 'Sync'),
      terms([
        ['Sync configuration', ['Off (the default), your configuration is stored only in this browser and never leaves the device. On, it mirrors profiles and rules to your browser account so other machines pick them up; the newest change wins. Large rule-list bodies are not synced, so set a URL and each machine refreshes its own copy. Proxy credentials are never synced — enter them on each machine. Enabling sync on a machine that already has a synced setup adopts the existing one rather than overwriting it. If the devices disagree about the config format — one is running a much newer or a much older Sockitt — sync pauses instead of overwriting, and says so here.']],
      ])
    ),

    card(
      'Identity and appearance',
      terms([
        ['Name', ['A label for the profile, shown in the popup and this page.']],
        ['Initials', ['1 to 3 characters, drawn on the toolbar icon while the profile is active and on the profile’s avatar everywhere else. Left blank, they’re derived from the name.']],
        ['Colour', ['Tints the profile’s avatar and its toolbar icon, so you can tell at a glance which profile is live.']],
      ]),
      p('The toolbar icon always reflects the active profile; a red ', code('!'), ' badge appears if the proxy reports an error or another extension is controlling proxy settings.')
    ),

    card(
      'Backup, import, and reset',
      terms([
        ['Export', ['Downloads your entire configuration as a JSON file — including any proxy usernames and passwords, in plain text, so a restore brings everything back. Treat backups as secrets if your proxies use credentials.']],
        ['Import', ['Loads a configuration from a JSON file, replacing the current one. Imported data is validated, so a malformed file can’t break the extension.']],
        ['Reset', ['Removes all profiles and rules and returns to the System profile. Settings are kept — except the three that name a profile (the quick-switch picks, the startup profile, and the incognito profile), which are cleared along with the profiles they pointed at.']],
      ])
    ),

    card(
      'Keyboard shortcuts',
      p('Set or change these at ', code('chrome://extensions/shortcuts'), '.'),
      ul([
        el('span', {}, code('Alt+Shift+S'), ' activates the toolbar button (default): it opens the popup — or, with Quick switch on, cycles to the next profile, exactly like clicking the icon.'),
        el('span', {}, 'Cycle to the next quick-switch profile: unbound by default; assign a key if you use Quick switch.'),
      ])
    ),

    card(
      'Troubleshooting',
      terms([
        ['A red ! on the toolbar icon', ['Either the proxy reported an error, or another extension has taken over the browser’s proxy settings. Hover the icon — the tooltip says which, and the popup shows the message.']],
        ['“Another extension is controlling the proxy”', ['Only one extension can own Chrome’s proxy settings, and the last one to set them wins. Turn on ', code('Guard proxy control'), ' to have Sockitt take them back, or disable the other extension.']],
        ['Sites fail instead of loading', ['Routes are mandatory, so an unreachable proxy fails closed rather than leaking direct — that error is Sockitt working as intended. Use ', code('Test connection'), ' on the proxy to confirm it is up, and ', code('Route inspector'), ' to confirm the site lands where you expect.']],
        ['“Exit check failed” in the popup', ['The ', code('ipconfig.is'), ' lookup did not come back: the route is down, ', code('ipconfig.is'), ' is unreachable through it, or the request timed out. Hover the line for the underlying error; a connection test narrows it down.']],
        ['A rule never matches', ['Check the pattern field for a red outline — an invalid or over-complex pattern is kept but inert, and hovering it shows why. Otherwise check rule order (first match wins), and remember that on https the browser hides the path, so URL-path rules behave as host rules.']],
        ['Proxy auth never prompts', ['SOCKS proxies cannot be authenticated at all. For HTTP/HTTPS, look for the ', code('Enable authentication'), ' notice at the top of the options page — without that permission the challenge goes unanswered.']],
      ])
    ),

    card(
      'Limitations',
      ul([
        'SOCKS proxies cannot be authenticated (a Chromium limitation); use an IP allow-list or a local tunnel. HTTP/HTTPS proxies support username/password auth.',
        'IP / CIDR rules match literal IPv4 hosts only; Sockitt never resolves DNS while routing, and IPv6 CIDR is not supported.',
        'Chromium-family browsers only (Chrome, Edge, Brave, Opera, Vivaldi), version 110 or newer.',
      ])
    ),
  ];

  return el(
    'div',
    { class: 'pane docs' },
    el(
      'div',
      { class: 'doc-head' },
      el('h2', { class: 'doc-title' }, 'Documentation'),
      v ? el('span', { class: 'doc-version' }, v) : null
    ),
    toc(cards),
    ...cards
  );
}
