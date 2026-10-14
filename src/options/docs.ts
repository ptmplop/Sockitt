import { el } from '../shared/ui';

/* Small builders for readable, consistent documentation blocks. */

/** Stable in-page anchor derived from the card title (see toc). */
function slug(title: string): string {
  return 'doc-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function card(title: string, ...children: (Node | string | null)[]): HTMLElement {
  return el('section', { class: 'doc-sec', id: slug(title) }, el('h2', {}, title), ...children);
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
            c.scrollIntoView({
              behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
              block: 'start',
            });
          },
        },
        c.querySelector('h2')?.textContent ?? ''
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

/** A worked example. Inline `code` cannot hold one; this can. */
function pre(text: string): HTMLElement {
  return el('pre', { class: 'doc-pre' }, text);
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

/**
 * @param onReleases Opens the release history. Passed in rather than imported:
 *   navigation belongs to the options shell, and this module knows nothing
 *   about page ids.
 */
export function docsPanel(onReleases: () => void): HTMLElement {
  cachedPanel ??= buildDocsPanel(onReleases);
  return cachedPanel;
}

function buildDocsPanel(onReleases: () => void): HTMLElement {
  const v = version();

  const cards = [
    card(
      'What Sockitt does',
      p(
        'Sockitt answers one question for every request your browser makes: does this go straight out to the network, or through a proxy - and if so, which one? You describe the answer once, as ',
        el('em', {}, 'profiles'),
        ', and Sockitt applies it to every request from then on.'
      ),
      p(
        'A profile is one of six things. ', code('Direct'), ' and ', code('System'), ' are built in and need no setup. A ',
        code('Proxy server'), ' is one server - SOCKS5, SOCKS4, HTTP, or HTTPS. An ', code('Auto switch'),
        ' is an ordered list of rules that picks between the others per request. A ', code('Rule list'),
        ' does the same from a subscribed AutoProxy/GFWList or domain list. An ', code('Alias'),
        ' is a pointer, so many rules can be retargeted by editing one thing. One profile is active at a time; you choose it in the toolbar popup, in the Routing picker at the top of this page, with a keyboard shortcut, or automatically at browser start. Incognito windows can follow a second profile of their own - see Settings.'
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
        ' - when a proxy is unreachable its requests fail rather than quietly retrying direct, so a dead proxy can never leak the traffic you meant to route through it.'
      ),
      p(
        'The Overview draws the active profile as a track map: requests come in on the left, each rule is a junction, and each destination has a line in its own colour. While you browse, the popup draws the same thing for the current tab - the route it takes and the rule that decided it - and lets you add, retarget, delete, or temporarily override that site’s rule without leaving the page.'
      )
    ),

    card(
      'The options page',
      p(
        'A bar across the top holds six tabs - ', code('Overview'), ', ', code('Profiles'), ', ', code('Activity'), ', ',
        code('Inspector'), ', ', code('Settings'), ' and ', code('Docs'), ' - and, at its right-hand end, the route picker: ',
        code('Routing'), ', the active profile’s line key, and a list that switches the active profile from whichever page you are on. The Sockitt mark at the left goes back to the Overview.'
      ),
      p(
        'Two tabs carry a count when something needs you. ', code('Activity'),
        ' shows a red one - an alert icon and a number - while requests are failing at a proxy. ', code('Settings'),
        ' shows an amber one while a setting you switched on is waiting for a grant only you can give; see Needs your OK, under ',
        el('em', {}, 'Settings reference'), '.'
      ),
      p(
        'Colour means route. A profile’s colour is the line its traffic runs on, and it means the same wherever it appears - on the maps, in the key beside the profile’s name in lists and pickers, in the activity log, in the popup. Whether something is working is never left to colour: status is always an icon and a word.'
      ),
      p('Release notes have no tab of their own: they open from the ', code('Release notes'), ' button at the top of this page.')
    ),

    card(
      'Overview',
      p(
        'The page this options tab opens on. It answers the arrival questions - what is routing now, where each request would go, and whether anything is broken - from data Sockitt already holds. Nothing on it comes from recording your browsing: it is your configuration, read back to you, with a few measurements you can switch on.'
      ),
      terms([
        [
          'Routing now',
          [
            'The active profile’s name, large, and one line saying what it does - a proxy’s address and how many bypass entries it has, an Auto switch’s rule count and where everything else goes, a rule list’s size and where its matches go, or the profile an alias stands for - and since when it has been on. Switch with the ',
            code('Routing'),
            ' picker at the top of any page.',
          ],
        ],
        [
          'Alerts',
          [
            'Above the name, and only while something is wrong. Requests failing at a proxy name that proxy - or, when the active profile picks a server per request, the ones it could have been - with a ',
            code('Test'),
            ' button for that proxy when it is known, and ',
            code('Open errors'),
            '. When another extension controls the browser’s proxy settings, none of the routes below are in force; ',
            code('Show which extension'),
            ' opens Chrome’s own proxy setting, which names it and can turn it off. If a policy on this machine fixes the proxy settings, a note says Sockitt can show its routes but cannot apply them.',
          ],
        ],
        [
          'The track map',
          [
            'How the active profile routes, drawn as railway track on a tinted band - see ',
            el('em', {}, 'Reading the map'),
            ', below. The key under it explains the marks, and carries two links when they apply: ',
            code('Count the tabs on each line'),
            ', which asks for the optional ',
            code('tabs'),
            ' permission, and ',
            code('Show exit addresses'),
            ', which turns on IP address lookups.',
          ],
        ],
        [
          'Trace a URL',
          [
            'Type an address, or just a host, into the field over the map, and the path one request to it would take lights up, rule by rule, while the rest fades. A sentence under the field says which rule takes it and where it goes - and, when that destination is another Auto switch or rule list, where it is sent on to. Nothing is sent: it runs the same tests the compiled PAC script runs, against your configuration. The ',
            code('Inspector'),
            ' tab does the same for any profile, with every step written out.',
          ],
        ],
        [
          'Line ends',
          [
            'Each line ends at its destination’s name - click a profile’s name to open it - and what it is: a proxy’s protocol and address, ',
            code('Auto switch · decides again'),
            ', ',
            code('Your OS settings'),
            '. On an Auto switch or rule list, the default’s line is marked ',
            code('everything else'),
            '. Under the name: how many open tabs route along that line, a ',
            code('Test'),
            ' button and its last result for each proxy, ',
            code('Failing'),
            ' beside a proxy the alert names, and - on the line ipconfig.is’s own requests would take - the exit address it sees. Tab counts need the optional ',
            code('tabs'),
            ' permission, the same one the route badge uses; tab addresses are read to resolve them locally, and nothing is stored or sent. The test and the exit address need IP address lookups, which are off until you turn them on.',
          ],
        ],
        [
          'Needs attention',
          [
            'What the health check finds wrong with the configuration, worst first, each with the button that fixes it: patterns that will not compile, rules buried under a catch-all so they can never run, duplicate rules with conflicting targets, an Auto switch whose rules are all off or that never reaches a proxy, a proxy with no host, credentials without the permission that answers the sign-in, a missing ',
            code('<local>'),
            ' bypass, rule lists that are empty, unreadable, overdue, or skipping many lines, reference loops, and no proxy servers at all. The entries under Needs your OK on the Settings page are listed here too. When nothing is wrong, it says so.',
          ],
        ],
        [
          'This session',
          [
            'Which profile was active over this browser session, as a bar in each profile’s colour with the last few switches listed under it; then how many proxy errors there have been - a link to Activity › Proxy errors - and, with Sync on, how much of the browser’s 100 KB sync allowance Sockitt is using. Session-scoped, like the error log: it starts fresh with the browser and is never written to your saved configuration.',
          ],
        ],
      ]),
      p(
        'With no profiles yet, the Overview shows Direct or System on a single line and three ways to start: add a proxy server, start an auto switch, or bring a setup across by importing a backup or turning Sync on.'
      ),
      el(
        'p',
        { class: 'doc-note' },
        'Prefer to land somewhere else? Settings › Appearance › ',
        code('This page opens on'),
        ' switches it to whichever page you had open last. That preference is per device and is not synced.'
      )
    ),

    card(
      'Reading the map',
      p(
        'The Overview, the Inspector and the head of every editor draw a profile the same way: as railway track, read left to right, the way a request travels. An editor’s map is compact - numbers only, with the editor below it carrying the text - but its marks mean the same.'
      ),
      terms([
        ['The trunk', [
          'Requests enter on the left, on the ink trunk; the label at its start says what is coming in - all requests, with the number of open tabs when Sockitt may count them, or the host being traced. The trunk stays ink for as long as a request can still be decided. From the last junction on it is the default destination’s line, the one everything else takes. A proxy decides only at its bypass list, so its trunk is ink as far as the bypass diamond; with no bypass list nothing decides, and the line is the proxy’s from the start.',
        ]],
        ['Numbered junctions', [
          'Each rule of an Auto switch is a junction, numbered in the order rules are tried. The first junction whose rule matches takes the request, and nothing after it is tried. On the full-size map each junction is captioned with its kind of condition and its pattern, shortened to fit - hover the pattern for all of it.',
        ]],
        ['Branches', [
          'A rule that sends requests somewhere other than the default leaves the trunk at 45° onto its destination’s line. A rule that sends them to the default has no branch: its requests run straight on. Lines are stacked so that a destination first reached by an earlier junction sits lower, which keeps rules grouped by destination free of crossings; where a branch does cross another line, it is drawn passing over it, never joining it.',
        ]],
        ['Colours', [
          'Each line is drawn in its destination’s colour, the same as the key beside that profile’s name everywhere else. Direct and System share a neutral slate, and System’s line is dashed.',
        ]],
        ['Dashed junction', ['A rule that is switched off. It never branches.']],
        ['Folded junction', [
          'A map draws at most six rules one by one. With seven or more, the first five are drawn and the rest fold into one wide junction labelled with their numbers, such as ',
          code('6-24'),
          ', which branches to every destination those rules send requests to.',
        ]],
        ['Pin', [
          'The per-site overrides set from the popup: one junction ahead of rule 1, because overrides are tried before every rule. It is drawn only while an override is in force on the active profile.',
        ]],
        ['Diamond', ['A proxy’s bypass list, dropping onto Direct.']],
        ['List junction', [
          'A rule list, as a single junction for the whole list: entries on the list branch onto its target, and everything else runs on to the other.',
        ]],
        ['Aliases and onward routes', [
          'An alias is drawn as the profile it points at. A line that ends at another Auto switch or rule list is marked ',
          code('decides again'),
          ': that profile makes its own decision, on its own map.',
        ]],
      ]),
      p(
        'With a URL traced, the path it takes is drawn heavier, everything else fades, and the line it ends on says ',
        code('takes it'),
        ', with the rule that did.'
      )
    ),

    card(
      'Quick start',
      el(
        'ol',
        { class: 'doc-list' },
        el('li', {}, 'On the ', code('Profiles'), ' tab, open ', code('New'), ' and choose ', code('Proxy server'), ' (on a fresh install, ', code('Add a proxy server'), ' on the Overview does the same). Pick the protocol, and enter the host and port (for example a SOCKS5 ', code('ssh -D 1080 myserver'), ' tunnel on ', code('127.0.0.1:1080'), ', or an HTTP proxy with a username and password).'),
        el('li', {}, 'Switch to it - ', code('Switch to it'), ' at the top of its editor, the ', code('Routing'), ' picker at the top of any page, or the toolbar popup. All traffic now goes through it.'),
        el('li', {}, 'For per-site routing, make an ', code('Auto switch'), ' the same way, add rules, and switch to it - or add rules straight from the popup while browsing.')
      )
    ),

    card(
      'Profiles',
      terms([
        ['Direct (built-in)', ['No proxy; traffic goes straight to the network.']],
        ['System (built-in)', ['Follows the proxy settings configured in your operating system.']],
        ['Proxy server', ['A single proxy server (SOCKS5, SOCKS4, HTTP, or HTTPS) with a host, port, and bypass list. Activate it to send everything through that server. Its editor has ', code('Server'), ', ', code('Sign-in'), ', ', code('Bypass list'), ' and ', code('Test'), ' sections.']],
        ['Auto switch', ['An ordered list of rules that route each request to a target based on its URL, host, IP, or the time of day. This is the profile the popup lets you manage per site. Its editor is the rules table, under the map.']],
        ['Rule list', ['Subscribes to an AutoProxy/GFWList or plain domain list (by URL or pasted in) and routes matching sites to a chosen target. Its editor has ', code('Source'), ', ', code('Routing'), ' and ', code('List content'), ' sections.']],
        ['Alias', ['A pointer to another profile. Aim several rules at one alias, then change the alias target once to retarget them all together. Its editor’s ', code('Target'), ' section says which profiles use it.']],
      ]),
      el('h4', { class: 'doc-sub' }, 'The Profiles page'),
      p(
        'The list on the left holds every profile, grouped ', code('Built in'), ', ', code('Proxy servers'), ', ', code('Auto switch'), ', ',
        code('Rule lists'), ' and ', code('Aliases'), ', each with its line key and a word on what it is - a proxy’s protocol, a rule or entry count, an alias’s target - or ',
        code('Active'), '. The filter field narrows the list; ', code('New'), ' makes a profile of any kind - proxy server, auto switch, rule list or alias - and opens it.'
      ),
      p(
        'Selecting a profile opens its editor beside the list. Every editor starts with a head - the profile’s tile, its name and what it is, and ',
        code('Switch to it'), ' (or ', code('Active'), '), ', code('Duplicate'), ' and ', code('Delete'),
        ' - and a compact track map of how it routes, which follows your edits. Below that come its sections, each with a title on the left and the controls on the right; ',
        code('Name and colour'), ' is always the last. Changes save as you make them. Direct and System have a pane too: nothing to set up, and a button to switch to them.'
      ),
      p(
        code('Duplicate'), ' makes a copy to change without touching the original. ', code('Delete'),
        ' sends every rule, default, alias and rule list that pointed at the profile to Direct, and takes it out of the quick-switch picks and the startup and incognito settings; deleting the active profile switches to System.'
      )
    ),

    card(
      'Auto switch rules',
      p(
        'Rules are evaluated top to bottom and the ',
        el('strong', {}, 'first match wins'),
        '. If nothing matches, the profile’s ',
        code('Everything else'),
        ' target applies - the last row of the table. Each row is one rule: its number, ', code('Condition'), ', ', code('Pattern'), ', ',
        code('Route via'), ' and an ', code('On'), ' toggle. Turn a rule off to disable it without deleting it; ✕ deletes it, and ',
        code('Add rule'), ' adds one at the bottom. Drag a rule by its handle to reorder it, or focus the handle and press ', code('Alt+↑'), ' or ', code('Alt+↓'),
        '. Pointing at a rule highlights its junction on the map above. A rule can route to a proxy, Direct, another Auto switch profile, a rule list, or an alias - ',
        code('Route via'), ' leaves out any profile that would lead back to this one.'
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
        'Both regex conditions run on every request, so each pattern is checked for catastrophic backtracking before it is used. One whose quantifiers nest - ',
        code('(a+)+'),
        ' - is refused with “Pattern is too complex”; the same guard drops such entries from a subscribed rule list, where they are counted in the editor’s “N lines ignored”. An invalid pattern is inert rather than dangerous: the field is outlined in red and the rule simply never matches.'
      ),
      el('p', { class: 'doc-note' },
        'For https pages the browser only exposes the scheme and host to the proxy resolver, so URL-path rules effectively behave as host-level rules on https. Time and weekday decisions may take a moment to apply on already-visited sites because the browser briefly caches proxy decisions.')
    ),

    card(
      'Proxy protocols and authentication',
      p('A proxy server can use any protocol Chromium supports; pick it under ', code('Server'), ' in its editor:'),
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
        'For HTTP/HTTPS proxies you can set a username and password under ', code('Sign-in'), '. Answering proxy authentication challenges needs an optional permission (', code('webRequest'),
        ' plus access to all sites); Sockitt asks for it when you set credentials, and only then. If credentials arrive another way (an imported backup), the ', code('Sign-in'), ' section shows a notice with an ', code('Allow sign-in'), ' button, and Settings lists the same request under Needs your OK. Credentials stay on the device where you enter them - they are never synced. SOCKS proxies cannot be authenticated by Chromium; secure them with an IP allow-list or a local tunnel instead.'
      )
    ),

    card(
      'Bypass lists',
      p('Each proxy server has a bypass list - the ', code('Bypass list'), ' section of its editor - of hosts that always connect directly even when that profile is active (whether chosen directly or reached by a rule). On its map the list is the diamond that drops onto Direct. One entry per line:'),
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
      p('A rule-list profile routes URLs that match an online (or pasted) list through a chosen target. Whitelist entries always win and go where everything else goes. Two formats:'),
      terms([
        ['AutoProxy / GFWList', [
          'Lines: ', code('||domain'), ' (host or subdomain), ', code('|https://prefix'), ' (URL prefix), ', code('/regex/'), ', ', code('@@'), ' to whitelist, and ', code('!'), ' or ', code('['), ' for comments and headers. Anything else is a URL substring - or a URL wildcard, if it contains ', code('*'), ' or ', code('?'), '. Base64-encoded payloads (GFWList’s format) are decoded automatically.',
        ]],
        ['Domain list', [
          'One host or URL pattern per line. ', code('example.com'), ' matches that host exactly, ',
          code('*.example.com'), ' the host or any subdomain - ', code('.example.com'),
          ', the hosts-file and adblock spelling, means the same - and ', code('ad*.example.com'),
          ' is a host wildcard. An entry containing ', code('://'), ' matches the start of the URL, with a trailing ',
          code('*'), ' implied. ', code('@@'), ' whitelists. A line starting with ', code('#'), ' / ', code(';'),
          ' / ', code('!'), ' / ', code('['), ' is a comment, and ', code('#'), ' or ', code(';'),
          ' after whitespace starts a trailing one - a ', code('#'), ' with no space before it is left alone, so a URL fragment survives. A line that cannot be a hostname - one with spaces, a path, a port, a CIDR, or a non-ASCII character (use punycode: ',
          code('xn--bcher-kva.example'), ') - is counted as ignored in the editor instead of becoming a rule that could never match.',
        ]],
        ['Paths only work on http://', [
          'Chrome hands a PAC script the full URL for ', code('http://'), ', but only ',
          code('scheme://host/'), ' for ', code('https://'), ' and everything else - it strips the path and query for privacy. So ',
          code('https://cdn.example/px'), ' can never match, and is reported as ignored: match the host instead (',
          code('cdn.example'), '), or write ', code('http://cdn.example/px'), ' if the path is the point.',
        ]],
        ['Not SwitchyOmega', [
          'This is not SwitchyOmega’s conditions format. Its ', code('[SwitchyOmega Conditions]'),
          ' lists - typed prefixes like ', code('UrlRegex:'), ', ', code('Keyword:'), ' and ', code('Ip:'),
          ', and ', code('!'), ' bypass lines - are not supported. Paste one in and Sockitt says so rather than loading it half-dead.',
        ]],
      ]),
      el('h4', { class: 'doc-sub' }, 'Making a domain list'),
      el(
        'ol',
        { class: 'doc-list' },
        el('li', {}, 'On the ', code('Profiles'), ' tab, open ', code('New'), ' and choose ', code('Rule list'), '.'),
        el('li', {}, 'Under ', code('Source'), ', set ', code('Format'), ' to ', code('Domain list (one per line)'), '.'),
        el('li', {}, 'Either paste the list into ', code('List content'), ', or put a ', code('URL'), ' in and press ', code('Update now'), ' to fetch it.'),
        el('li', {}, 'Under ', code('Routing'), ', choose where entries on the list go (', code('On the list, route via'), ') and where everything else goes (', code('Everything else, via'), ').'),
        el('li', {}, 'Switch to the rule-list profile, or point an Auto switch rule at it.')
      ),
      p('A list looks like this - one entry per line, no punctuation needed for the common case:'),
      pre(
        [
          '# A whole line, or after whitespace at the end of one',
          'ads.example.com          # this host only',
          '*.tracker.example        # the host and every subdomain',
          'metrics*.example.net     # * and ? are wildcards',
          '.hosts-file.example      # leading dot: the host and its subdomains',
          'http://cdn.example/px    # a URL prefix; trailing * is implied',
          '@@safe.example.com       # never match this one',
        ].join('\n')
      ),
      p(
        'The readout beside the field, under the ', code('List content'), ' title, tells you how it was read - ', code('42 entries parsed'),
        ', and ', code('3 lines ignored'), ' if any line could not become a rule that can ever match (a space, a path, a port, a CIDR, a non-ASCII character, or an https entry with a path). Ignored lines are never compiled, so on a list with none ignored, every entry is doing something.'
      ),
      p(
        'Each ignored line is then listed under the field by number, with what is wrong with it - click one to select it in the field. A list can only be as good as the part of it that loads, and a count on its own tells you a line was dropped without telling you which.'
      ),
      p(
        'Set an ', code('Auto-update'), ' interval to refresh from the URL automatically - in hours, up to 720 (30 days), or 0 to disable; new lists start at 24. The first automatic fetch comes about a minute after you first set a URL; after changing it, press Update now, or the new address waits for the next scheduled update. You can also press ',
        code('Update now'), '. Domain entries compile to a single dictionary lookup, so even very large lists stay fast.'
      ),
      el('h4', { class: 'doc-sub', id: 'doc-list-fetch' }, 'How the list is fetched'),
      p(
        'A list is fetched like any other request the browser makes, so it goes wherever the active profile sends its host - not over some separate route. With an Auto switch active, its rules decide; with a proxy active, it goes through that proxy, unless the host is on its bypass list; with Direct, straight out; and only with System does it use your operating system’s proxy settings. The line under the ',
        code('URL'),
        ' field says where fetches go right now, and why - for example “Fetches go through Home VPS - rule 3 in Office routing, the active profile”. Automatic updates follow whichever profile is active when they run. While another extension holds the browser’s proxy, fetches use its settings instead, and the line says so.'
      ),
      p(
        'Two things follow from that. A list whose host you can only reach through a proxy needs a route there before its first fetch can succeed: give the active Auto switch a rule for that host, or switch to the proxy while you press ',
        code('Update now'),
        '. And a rule list that is itself active routes its own address by its own entries - an empty one sends the fetch by its default, and a refresh that drops the host changes where the next one goes; the line under the URL says when that is the case.'
      ),
      p(
        'The host has to allow cross-origin requests - it must send an ',
        code('Access-Control-Allow-Origin'),
        ' header (',
        code('raw.githubusercontent.com'),
        ' does) - unless Sockitt already has access to all sites, which proxy sign-in and the Activity monitor ask for. When a fetch fails, the editor says why under ',
        code('Update now'),
        ': the server’s answer (a 404, a 403…), a proxy that could not be reached or wouldn’t open a tunnel, a proxy sign-in Sockitt isn’t allowed to answer, a server that sent the list without allowing extensions to read it, an error page, or no answer at all - Chrome gives up connecting after 30 seconds, and Sockitt stops waiting for a reply after 60. A local address - localhost, 127.x - is always fetched directly: Chrome never sends those through a proxy.'
      )
    ),

    card(
      'The toolbar popup',
      p(
        'Clicking the Sockitt icon opens the popup: one column, 400 pixels wide and 600 tall. From the top it holds a header, a line about a failing proxy while one is failing, the tab you are on and how it routes, the controls for that site, and the profiles to switch between. The button at the top right, and ',
        code('Open Sockitt'),
        ' in the footer, open this page.'
      ),
      terms([
        ['This tab', [
          'The site in the current tab, and a small strip of track showing the route its requests take: in on the trunk, out at the junction that decided - a numbered rule, a pinned override, a bypass diamond - and along the destination’s line to its name. A route with no junction to show, such as a plain proxy’s, is a flat line in the destination’s colour. A sentence under the strip says why: the rule, with its pattern and the profile it belongs to; the override; the default route; or ',
          code('All traffic'),
          ' and the proxy’s bypass entries. For System, or for a page that is not http(s), the popup says so rather than guessing - Sockitt cannot inspect an OS PAC’s per-site rules.',
        ]],
        ['Exit line', [
          'With ', code('IP address lookups'), ' on (Settings), a line under the route says where the current tab actually exits: ', code('Exits from'),
          ', the address, and how long the lookup took. It asks ', code('ipconfig.is'), ', and is off by default.',
        ]],
        ['Rule for this site', [
          'With an Auto switch profile active: the rule that matches this site, numbered as in its table, with its pattern and its route editable where they stand - or, when no rule matches, a route picker and ',
          code('Add rule'), ', which adds a ', code('*.host'), ' rule (last, or first: see ', code('Rules added in the popup go last'),
          '). The ✕ deletes that rule outright; it is the same rule you would find in the profile’s table here, so deleting a broad pattern like ',
          code('*.example.com'), ' stops routing every site it covered, not just this one.',
        ]],
        ['Override', [
          'With an Auto switch profile active: a temporary route for this site alone. Choose a route and press ', code('Set'),
          '; it takes priority over every rule until the browser restarts, or until you press ', code('End'),
          '. Each site keeps its own - setting one leaves the overrides on other sites in place - and the popup shows only the one covering the site you are on; one set on ',
          code('*.example.com'), ' covers its subdomains, so it shows there too. While an override covers the site it is listed first, and the rule under it reads ',
          code('paused'), '. On the maps it is the pin ahead of rule 1.',
        ]],
        ['Switching profiles', [
          'The list at the bottom: Direct, System, then every profile, each numbered and shown with its line key and its address or kind, with a tick on the one in use. Click a row, or press its number from 1 to 9, to switch. Once there are a dozen or more profiles a filter field appears above the list; ',
          code('Enter'), ' in it switches to the first match.',
        ]],
        ['When a proxy fails', [
          'A line under the header says how many requests have failed, and names the proxy when Chrome’s report pins the failure to one - otherwise it says a proxy can’t be reached, and the candidates are in its tooltip. Clicking it opens Activity › Proxy errors. When this tab’s route runs through the failing proxy, its strip breaks before the destination, and the override comes preset to another proxy, with ',
          code('Set & reload'), '. See ', el('em', {}, 'When a proxy fails'), '.',
        ]],
      ]),
      p(
        'Per-site rules and overrides need an Auto switch profile. With a plain proxy active, ', code('This site'), ' offers ', code('Send this site direct'),
        ', which adds the site to that proxy’s bypass list - ✕ takes it out again. With a plain proxy, Direct or System active, the popup says per-site routing needs an auto switch, and its ',
        code('New auto switch'), ' button opens this page on a new one, ready to fill in.'
      )
    ),

    card(
      'Testing and inspection',
      terms([
        ['Inspector', [
          'The ', code('Inspector'), ' tab traces any address through your configuration with the same resolver real routing uses. Type a URL, or just a host, and choose where to ',
          code('Start at'), ' - the active profile, or any other, so you can check one before switching to it. It draws that profile’s track map with the request’s path lit, then writes the route out ',
          code('Step by step'), ': every profile it passes through and why - the rule that matched, a popup override, the default, an alias, on or off a list - and where it lands: a proxy and its address, Direct, or Direct because a bypass list matched. Popup overrides count only when you start at the active profile, as in real routing. For an https:// address it notes that Chrome hides the path from proxy routing, and shows what was matched instead. Nothing is sent.',
        ]],
        ['Connection test', [
          'A proxy’s editor has ', code('Test connection'), ' in its ', code('Test'), ' section; the Overview has ', code('Test'),
          ' at the end of each proxy’s line, and an opened request in Activity offers a test of the proxy it went to. Each briefly routes your browsing through that proxy, fetches ',
          code('ipconfig.is'), ' to capture the exit address, country, and latency, then restores your configuration - sign-in included, so wrong credentials show up here too. One test runs at a time: the browser has a single proxy setting, and a test borrows it for a few seconds. The result appears beside the button and is never saved. It’s an ',
          code('ipconfig.is'), ' lookup, so it needs IP address lookups turned on in Settings (off by default).',
        ]],
        ['Activity › Requests', [
          'Where the Inspector answers for one URL you type, ', code('Activity › Requests'), ' answers for everything the browser actually asks for: each request as it happens, and the route your rules give it. Useful for the question a single lookup cannot settle - whether a rule is firing on the subresources a page pulls in, not just on its address bar.',
          el('br'),
          el('br'),
          'Requests are listed newest first, with ', el('b', {}, 'Time'), ', ', el('b', {}, 'Method'), ', ', el('b', {}, 'URL'), ', ', el('b', {}, 'Route'),
          ' - the destination’s line key and name, and how it got there: ', code('rule 2'), ', ', code('default'), ', ', code('override'), ', ', code('bypass'), ' or ', code('on the list'),
          ' - ', el('b', {}, 'Result'), ' - the status code, or an icon and a short word such as ', code('Proxy refused'), ' for a failure - and ', el('b', {}, 'Took'),
          '. A bar over the table shows the mix of routes across everything recorded, with a key and a count of failures. The filter box searches URL, profile and result, and ',
          code('Failed only'), ' hides the rest. Click a URL to open its row: a small strip of that one request’s route - broken before the destination when its proxy failed it - a sentence saying which rule sent it where, what came back (the full ',
          code('net::'), ' code for a failure), the request’s type and declared size, and ', code('Test'), ' for its proxy, ', code('Open in Inspector'), ' and ', code('Copy as text'), '.',
          el('br'),
          el('br'),
          'It records only while the page is open, and only in that page. Nothing is written to disk, closing the tab discards the log, and leaving the page - even for Proxy errors beside it - stops the recording, so it can never become a browsing history that Sockitt keeps. It holds the newest 500 requests, and ', code('Clear'), ' empties it. ',
          code('Stop'), ' ends recording on demand, and detaches the listeners rather than quietly ignoring them; that choice is remembered, so a monitor you stopped stays stopped when you come back. It needs permission to observe requests, asked for once with ',
          code('Turn on the monitor'), '. That request is the same pair the extension uses for proxy authentication, because Chromium ties the two together; the monitor itself only ever observes.',
          el('br'),
          el('br'),
          el('b', {}, 'Route'), ' is computed, not observed: Chrome tells an extension that a request happened but never which proxy carried it, so this is the same resolver the Inspector uses, applied to every request. The size in an opened row is the response’s declared ',
          code('Content-Length'), ' - streamed and chunked responses do not carry one, and show no size - so it is not a measure of how much data a proxy has carried.',
        ]],
      ])
    ),

    card(
      'When a proxy fails',
      p(
        'Routes are mandatory, so a proxy that stops answering makes its requests fail rather than quietly fall back to a direct connection. That is deliberate - it is what stops a dead proxy leaking the traffic you meant to route through it - but it means a failure should be easy to see and easy to read. Four places show it, in increasing detail.'
      ),
      terms([
        ['The toolbar icon', [
          'A red mark on the icon while requests are failing. It carries a count once the same run of failures repeats - ', code('!'), ' for one, ', code('!4'), ' for four, ', code('!9+'), ' beyond nine - so a single blip and a proxy that is comprehensively down do not look alike.',
        ]],
        ['The popup', [
          'A line under the header naming the proxy and how many requests have failed. Clicking it opens Activity › Proxy errors.',
        ]],
        ['This page', [
          'The ', code('Activity'), ' tab carries a red count, and the Overview opens with an alert naming the proxy, with ', code('Test'), ' and ', code('Open errors'), '.',
        ]],
        ['Activity › Proxy errors', [
          'It names the error, what it means in plain English, and which proxy was carrying traffic at the time - the exact server when the active profile routes everything the same way, or the shortlist it chooses between when it decides per request (Chrome reports that a proxy failed but never says which one, so a shortlist is the honest answer). ',
          code('Check'), ', with the proxy’s name, opens its editor; ', code('Copy report'),
          ' puts the whole thing on the clipboard for a bug report - proxy addresses included, credentials never, because the log does not record them - and ', code('Dismiss'),
          ' clears the alert. Below that is the log: newest first, repeats of the same failure collapsed into one line with a count, each marked Failed or Warning. ',
          code('Clear log'), ' empties it, and clears the alert with it.',
        ]],
      ]),
      p(
        'The alert clears itself. Chrome reports failures but never recoveries, so “the proxy works again” has to be inferred from the failures stopping: 30 seconds without a new one and the mark, its count and the popup’s line all disappear. Applying settings - switching profile, editing a rule, running a connection test - clears it immediately too. A proxy that is still down simply re-raises on its next request, so nothing is hidden. The log itself is kept until the browser restarts, and is never written to your saved configuration or synced.'
      ),
      el('p', { class: 'doc-note' },
        'A failure Sockitt catches before the browser sees it - a profile that cannot be applied at all, say an empty proxy host - is logged the same way, marked “Could not apply the proxy settings”. In that case the previous route is still in force, so what you are browsing through is not what the popup says is active.')
    ),

    card(
      'Settings reference',
      el('h4', { class: 'doc-sub' }, 'Needs your OK'),
      p(
        'A list at the top of Settings, there only while something you switched on cannot work yet: a proxy has a password but Sockitt is not allowed to answer its sign-in; the route badge cannot see your tabs, or see a page start loading; incognito windows are set to their own profile but Chrome has not let Sockitt into incognito; Sockitt is not pinned to the toolbar; or a new version is downloaded but not running. Each entry says what is wrong and, where one click can fix it, carries the button - ',
        code('Allow sign-in'), ', ', code('Allow'), ', ', code('Open Sockitt’s details'),
        '. Pinning and restarting the browser are yours to do, so those two say how instead. The Settings tab counts the entries waiting on a grant from you, and the Overview lists them all under Needs attention.'
      ),
      el('h4', { class: 'doc-sub' }, 'Switching'),
      terms([
        ['Quick switch', ['When on, clicking the toolbar icon cycles through the profiles you tick under it instead of opening the popup (while it’s on, the popup itself is unavailable). Tick at least two entries - with fewer, the cycle falls back to Direct, System, and every profile. The cycle keyboard shortcut works either way.']],
        ['On browser startup', ['Which profile becomes active when the browser starts. ', code('The last one used'), ' keeps whatever was active before.']],
        ['Incognito windows use', ['Route incognito windows through their own profile while regular windows keep the active one. Requires ', code('Allow in Incognito'), ' for Sockitt - at ', code('chrome://extensions'), ', open Sockitt’s ', code('Details'), ' and turn it on; the setting says whether it is ', code('In force'), ' or ', code('Waiting for Chrome'), ', and while it waits offers ', code('Open Sockitt’s details'), ' to take you there. It can only open that page: Chrome keeps that switch for you alone, and gives no extension - Sockitt included - any way to grant itself incognito access. Without it (or set to ', code('Same as regular windows'), '), incognito follows the regular profile. Once it is set, those windows say so for themselves: the toolbar icon over an incognito window is that profile’s, and the popup opened there reads out - and switches - the incognito profile rather than the regular one. Overrides set there are the incognito scope’s own and never carry into regular windows; the exit line is the one thing that cannot be measured for that scope, and says so instead of reporting the regular route’s.']],
        ['Reload the tab after switching', ['Reload the active tab after you pick a profile (or change this site’s rule or override in the popup), so the page re-fetches through the new route. The reload waits until you close the popup - Chrome dismisses the popup when the page beneath it navigates, so reloading straight away would close it mid-change. Several changes in one visit collapse into a single reload. A page that never loaded is always requested again, setting or no setting: there is nothing on screen to lose, and the request left hanging is the one you just wrote a rule for.']],
      ]),
      el('h4', { class: 'doc-sub' }, 'Behaviour'),
      terms([
        ['Route badge', ['Shows which profile the current tab routes through as a small badge on the toolbar icon - that profile’s initials in its colour, or ', code('DIR'), ' when the tab goes direct. It appears only where the route depends on the request - an Auto switch or rule-list profile; with a plain proxy or an alias the icon already names the destination, so the badge stays clear. Sockitt reads the tab’s address to work it out locally; nothing is stored or sent. Requires the optional ', code('tabs'), ' and ', code('webNavigation'), ' permissions, which are requested together when you turn it on - Chrome shows them as the single “Read your browsing history” prompt it already showed for ', code('tabs'), ' alone. ', code('webNavigation'), ' is what tells Sockitt a page has started loading, so a site that never answers stops reading out the previous page’s profile. A permission cannot travel inside a config, so importing a backup (or syncing from another browser) with the setting already on asks for it again - until it is granted, Needs your OK lists it with an ', code('Allow'), ' button.']],
        ['IP address lookups', ['The master switch for everything that contacts ', code('ipconfig.is'), ', a service the Sockitt developer runs - the popup’s exit line, the exit address on the Overview’s map, and the connection test. Off by default: Sockitt never reaches ', code('ipconfig.is'), ' until you turn it on (which requests access to it), and turning it off stops all three. With it off, the only network requests Sockitt makes on its own are fetches of the rule-list URLs you configure.']],
        ['Rules added in the popup go last', ['Rules added from the popup are appended below existing rules. Turn it off to put them first instead, ahead of every rule you already have.']],
        ['Confirm before deleting', ['Ask for confirmation before a profile is deleted, everything is reset, or the proxy error log is cleared.']],
      ]),
      el('h4', { class: 'doc-sub' }, 'Appearance'),
      terms([
        ['Theme', [code('Match the system'), ' follows your operating system’s light or dark setting; ', code('Light'), ' and ', code('Dark'), ' keep this browser on one. It applies to this page and the popup.']],
        ['This page opens on', ['The ', code('Overview'), ', or ', code('The page I had open last'), '.']],
      ]),
      p('Both are kept per device and are never synced.'),
      // The Sync setting links here by id — anchoring on the card would land at
      // the top of a long reference, three settings above the answer.
      el('h4', { class: 'doc-sub', id: 'doc-sync' }, 'Sync'),
      terms([
        ['Sync profiles and rules', ['Off - the default - your configuration is stored only in this browser and never leaves the device. On, it mirrors profiles and rules through your browser’s own sync so your other machines pick them up, and the newest change wins. Sockitt runs no server of its own: the data travels through your browser vendor’s sync service, under your own account or chain, and Sockitt only reads and writes the ', code('chrome.storage.sync'), ' area the browser gives it. Proxy credentials are never synced - enter them on each machine. Large pasted rule-list bodies are not synced either, so give the list a URL and each machine refreshes its own copy. The theme and the page this one opens on are per-device preferences and do not travel. If the devices disagree about the config format - one is running a much newer or a much older Sockitt - sync pauses instead of overwriting, and says so on the Settings page.']],
        ['Setting your browser up to sync', ['Every browser arranges this differently, and Sockitt inherits whatever it decides. Chrome syncs through a Google account: sign in, turn sync on, and keep ', code('Extensions'), ' among the synced types at ', code('chrome://settings/syncSetup'), '. Brave has no account at all - you link each device into a sync chain with a code or QR at ', code('brave://settings/braveSync'), ', then switch ', code('Extensions'), ' on there. In both cases the ', code('Extensions'), ' type is the one that carries this: it covers extension settings, not just which extensions are installed. Sync is per browser, so Chrome reaches your other Chromes and Brave your other Braves, and the two never reach each other even on the same machine. A browser built without a sync service of its own will accept everything Sockitt writes and keep it locally forever - there is no error to report, and nothing on the Settings page will look wrong, so a machine that never receives anything is worth checking here first. Once it is working, Sockitt pulls when the browser starts, when Sockitt updates, and whenever the browser delivers a change from another device; there is no polling, so a change can take as long as your browser’s sync takes to carry it.']],
        ['Turning it on, and off', ['Turning Sync on joins whatever is already there rather than assuming this machine is right. If a synced configuration exists, this machine adopts it and its own is replaced - the credentials and rule-list bodies held here are kept, since neither ever travels. If nothing is synced, this machine’s configuration becomes the shared one, and every other machine with Sync on will take it, because a configuration you have just been editing carries the newest revision. That second case is the one to watch: set a machine up with Sync off and switch it on afterwards and you can overwrite the others, so switch Sync on first and make your changes after. Turning Sync off deletes the shared copy altogether. Every machine keeps the configuration it already has, and the next change made on a machine that still has Sync on seeds the shared copy again - which is also how you clear a sync that has paused on a version mismatch: switch it off, then on.']],
      ])
    ),

    card(
      'Name and colour',
      p('The last section of every editor: what the profile is called, and how it is drawn.'),
      terms([
        ['Name', ['A label for the profile, shown in the popup, the Profiles list, the Routing picker, and at the end of its line on the maps.']],
        ['Toolbar initials', ['1 to 3 characters, drawn on the toolbar icon while the profile is active, and in the route badge when a tab goes through it. The tile at the head of the editor previews them. Left blank, they’re derived from the name.']],
        ['Line colour', ['One of a fixed set. It is the profile’s line on every map and its key beside its name everywhere else - lists, pickers, the activity log, the popup - and it tints the profile’s toolbar icon, so you can tell at a glance which profile is live.']],
      ]),
      p('The toolbar icon always reflects the profile the window under it is routed by - the active one, or the incognito profile over an incognito window that has its own; a red ', code('!'), ' badge appears if the proxy reports an error (with a count, once it repeats) or another extension is controlling proxy settings. All of that needs Sockitt pinned to the toolbar. Unpinned, the icon appears only in Chrome’s puzzle-piece menu, which reads it once when the menu opens and never updates it again - it would show whatever was true when you opened it, including a profile that has since changed or another window’s. So while Sockitt is unpinned the icon names nothing at all: it is the plain Sockitt mark, which cannot be out of date, and the popup answers what the icon no longer does. Needs your OK on the Settings page says so, and pinning restores the icon immediately.')
    ),

    card(
      'Backup, import, and reset',
      p('All three are under Backup on the Settings page.'),
      terms([
        ['Export', ['Downloads your entire configuration as a JSON file - including any proxy usernames and passwords, in plain text, so a restore brings everything back. Treat backups as secrets if your proxies use credentials.']],
        ['Import', ['Loads a configuration from a JSON file, replacing the current one. Imported data is validated, so a malformed file can’t break the extension.']],
        ['Reset everything', ['Removes all profiles and rules and returns to the System profile. Settings are kept - except the three that name a profile (the quick-switch picks, the startup profile, and the incognito profile), which are cleared along with the profiles they pointed at.']],
      ])
    ),

    card(
      'Keyboard shortcuts',
      p('Set or change these at ', code('chrome://extensions/shortcuts'), '.'),
      ul([
        el('span', {}, code('Alt+Shift+S'), ' activates the toolbar button (default): it opens the popup - or, with Quick switch on, cycles to the next profile, exactly like clicking the icon.'),
        el('span', {}, 'Cycle to the next quick-switch profile: unbound by default; assign a key if you use Quick switch.'),
      ]),
      p('Inside Sockitt:'),
      ul([
        el('span', {}, 'In the popup, ', code('1'), ' to ', code('9'), ' switch to the profile with that number; with the filter showing, ', code('Enter'), ' switches to the first match.'),
        el('span', {}, 'In an Auto switch’s rules table, focus a rule’s drag handle and press ', code('Alt+↑'), ' or ', code('Alt+↓'), ' to move it one place.'),
      ])
    ),

    card(
      'Troubleshooting',
      terms([
        ['A red ! on the toolbar icon', ['Either the proxy reported an error, or another extension has taken over the browser’s proxy settings. Hover the icon - the tooltip says which. For a proxy error, ', code('Activity › Proxy errors'), ' has the code, what it means, which proxy was carrying traffic, and the log.']],
        ['The red mark will not go away', ['It should: 30 seconds with no new failure clears it, and so does applying settings. If it keeps coming back, requests are still failing - open ', code('Activity › Proxy errors'), ' and check the timestamps, which say whether this is one old incident or a live one.']],
        ['“Another extension is controlling the proxy”', [
          'Only one extension can control Chrome’s proxy settings: the most recently installed one that sets them. The order they set them in makes no difference, so nothing Sockitt does can outrank a newer extension. ',
          code('Show which extension'),
          ', on the Overview, opens Chrome’s own proxy setting, which names it and has a Disable button. Turn it off there, or in Extensions, and Sockitt’s routes apply again straight away, with nothing to re-apply; turn it back on and it takes over again. After either extension updates, Chrome may rank them differently from the next browser start.',
        ]],
        ['Sites fail instead of loading', ['Routes are mandatory, so an unreachable proxy fails closed rather than leaking direct - that error is Sockitt working as intended. ', code('Activity › Proxy errors'), ' names the failure; ', code('Test connection'), ' on the proxy confirms whether it is up, and the ', code('Inspector'), ' confirms the site lands where you expect. ', code('Activity › Requests'), ' shows every request the page makes, with its route and its result.']],
        ['“Exit check failed” in the popup', ['The ', code('ipconfig.is'), ' lookup did not come back: the route is down, ', code('ipconfig.is'), ' is unreachable through it, or the request timed out. Hover the line for the underlying error; a connection test narrows it down.']],
        ['A rule never matches', ['Check the pattern field for a red outline - an invalid or over-complex pattern is kept but inert, and hovering it shows why; the Overview lists it under Needs attention too. Otherwise check rule order (first match wins) - ', code('Trace a URL'), ' on the Overview names the rule that takes an address - and remember that on https the browser hides the path, so URL-path rules behave as host rules.']],
        ['A proxy’s sign-in is never answered', ['SOCKS proxies cannot be authenticated at all. For HTTP/HTTPS, look for ', code('Allow sign-in'), ' under Needs your OK on the Settings page, or in the proxy’s ', code('Sign-in'), ' section - without that permission the challenge goes unanswered.']],
        ['A new version is downloaded but not running', ['Chrome only swaps an extension for its new version while that extension is idle, and Sockitt wakes for rule-list updates, for proxy errors, and every time the popup opens - so an update can sit downloaded and unapplied for days. When that happens, Needs your OK on the Settings page says so and names both versions, and the Overview lists it under Needs attention; restarting the browser finishes it. Sockitt will not restart itself, because the moment it picked could be the middle of a connection test - and a test holds the live proxy settings and puts them back only when it finishes.']],
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
      'header',
      { class: 'page-head' },
      el(
        'div',
        { class: 'page-head-text' },
        el('h1', { class: 't-title' }, 'Docs'),
        el('p', { class: 'ink2' }, v ? `How Sockitt routes, and how to set it up. This is Sockitt ${v}.` : 'How Sockitt routes, and how to set it up.')
      ),
      // The one way in to the release history — it has no tab of its own, and
      // the version named beside it is what prompts the question.
      el(
        'div',
        { class: 'page-head-acts' },
        el(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: (e: Event) => {
              e.preventDefault();
              onReleases();
            },
          },
          'Release notes'
        )
      )
    ),
    el('div', { class: 'doc-layout' }, toc(cards), el('div', { class: 'doc-body' }, ...cards))
  );
}
