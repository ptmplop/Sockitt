import { el } from '../shared/ui';

/**
 * What changed, for the person it changed for.
 *
 * One entry per minor series rather than per tag. 1.8 alone shipped thirty
 * releases, most of them a single control moving a few pixels, and a list that
 * long tells you less than a short one — the reader wants to know what is
 * different since they last looked, not to audit the repository. So each entry
 * summarises a series, in the words someone using Sockitt would use, and drops
 * the ones that only moved build scaffolding.
 *
 * Add to the TOP when you cut a release. Keep it to a few lines; if an entry
 * needs a paragraph, it probably belongs in the documentation instead.
 */
interface Release {
  /** First tag in the series, e.g. '1.8.0'. */
  from: string;
  /** Last tag, when the series ran to more than one release. */
  to?: string;
  /** Human date, or a range when the series spanned days. */
  date: string;
  /** One line naming the theme — what this series was about. */
  title: string;
  notes: string[];
}

const RELEASES: Release[] = [
  {
    from: '1.21.0',
    to: '1.21.4',
    date: '30–31 July 2026',
    title: 'Incognito windows say what they are',
    notes: [
      'The icon shows the plain Sockitt mark while Sockitt is not pinned to the toolbar. Unpinned, it is only ever seen in Chrome’s puzzle-piece menu, and that menu reads the icon once when it opens and never again — so it could show a profile that has since changed, or the profile of a window you are not in. Nothing an extension can do makes it current, so it now says nothing rather than something that might be wrong, and a banner on the options page explains it. Pin Sockitt and the icon names the profile of whichever window it sits above, incognito included.',
      'The incognito toolbar icon held only until you went somewhere. Chrome drops a tab’s own icon when a navigation commits, and the icon underneath is the browser-wide one — so the first page you opened put the regular profile’s mark back over an incognito window. It is redrawn as each page commits now, the same way the per-tab route badge already was.',
      'The incognito setting says whether Chrome is actually letting Sockitt near incognito, and names the switch — Extensions › Sockitt › Details › Allow in Incognito — with a button that opens that page. It used to mention the requirement only when it was missing, and by replacing the description of what the setting does; whoever had it granted was never told what the setting depends on. Choosing a profile without that access now raises the same warning banner as any other setting that is on but inert.',
      'With an incognito profile set, an incognito window used to show the toolbar icon of the profile your REGULAR windows were on while its own traffic went somewhere else entirely. The icon over an incognito window is now that window’s profile, and so is the tooltip.',
      'The popup opened in an incognito window is about that window: it reads out the incognito profile, and picking a profile there sets the incognito one instead of quietly changing the windows you were not looking at. A row at the top puts it back to following your regular profile, and an ‘Incognito’ mark says which window you are in.',
      'Overrides set in an incognito window stay in incognito windows — they used to be the same temporary rules the regular scope was using, so a route chosen in one carried into the other. The per-tab route badge and “reload tab after switching” answer for the incognito scope now too.',
      'The exit-IP line does not run in an incognito window. It could only ever have measured the regular route, so it says where it applies rather than reporting a reading that belongs to another window.',
    ],
  },
  {
    from: '1.20.0',
    to: '1.20.2',
    date: '29 July 2026',
    title: 'A lighter sidebar',
    notes: [
      'The monitor\u2019s columns size themselves to the panel rather than the window, so the URL — the column you read the log for — is no longer squeezed to nothing inside a narrower pane, and the headings no longer wrap when a column drops out.',
      'Turning the network monitor on made the worker log a permission error on every start. It asks for one more permission now — one it never uses — because Chromium ties it to the one that answers proxy authentication, and granting them apart broke that.',
      'The documentation, the README and the privacy policy have caught up with the last few releases: the network monitor is described in all three, and the policy no longer says request-observing access is only ever used for proxy authentication.',
      'Create is one row that opens when you want it, sitting under Overview — it used to be a heading and four permanent rows at the foot of the sidebar, most of a screen of navigation spent on something you do rarely and placed as far from where you start as the sidebar allows.',
    ],
  },
  {
    from: '1.19.0',
    to: '1.19.2',
    date: '29 July 2026',
    title: 'The network monitor',
    notes: [
      'The monitor can be stopped, and stays stopped. There was no way to end a recording short of closing the page — and pausing it did not survive stepping over to another page and back, which quietly started it again. Stop now detaches the listeners rather than ignoring what they report, and the choice is remembered.',
      'The list could not be scrolled while requests were arriving — it was rebuilt on every one of them, and a rebuilt list has no memory of where you had scrolled to. It keeps its place now, and new rows arriving above do not drag the rows you are reading out from under you.',
      'A new page in the sidebar: every request the browser makes while you have it open, and which profile your rules route each one through. Where the Route inspector answers for one URL you type, this answers for everything a page actually asks for — including the subresources that never reach the address bar.',
      'It records only while the page is open, and only in that page. Nothing is written to disk, closing the tab discards the log, and leaving the page stops the recording. It asks for permission to observe requests the first time you open it, and nothing else in Sockitt uses that permission.',
    ],
  },
  {
    from: '1.18.0',
    to: '1.18.2',
    date: '28 July 2026',
    title: 'This page',
    notes: [
      'What you are reading: every release since the first, grouped by series rather than listed patch by patch. One click from the top of the Documentation page.',
      'The route on the Overview was losing its space to the exit IP beside it — an IPv6 address pushed two of the three chips off the end of the console entirely. The route keeps its width now, and a long address wraps at a group boundary instead of over its neighbour.',
      'Switching profile while the exit IP was still being measured left the previous proxy’s address on screen under the new profile’s name. A switch now supersedes the measurement in flight rather than waiting behind it.',
      'The Overview’s session card is called Profile timeline, which is what it draws.',
    ],
  },
  {
    from: '1.17.0',
    to: '1.17.3',
    date: '28 July 2026',
    title: 'A routing map you can trust',
    notes: [
      'The routing map drew no line at all between two profiles that sat on the same row, so a rule you had just added could look like it had never been added. Fixed, along with two other ways the map disagreed with the configuration behind it.',
      'The profile switcher on the Overview could not be used while a proxy was failing — the dropdown shut as fast as it opened, which is exactly when you want to switch away. It stays put now.',
      'Rule lists name the lines they ignored and why, instead of only counting them.',
    ],
  },
  {
    from: '1.16.0',
    to: '1.16.4',
    date: '28 July 2026',
    title: 'The Overview',
    notes: [
      'A landing page for the options tab: the live route and its exit IP, a map of how your profiles feed into each other, a health check with one-click fixes, and where your open tabs are actually going.',
      'Profiles are switched from a dropdown rather than a row of pills, which stayed one control however many profiles you keep.',
    ],
  },
  {
    from: '1.15.0',
    date: '28 July 2026',
    title: 'Large lists stay fast',
    notes: [
      'Rule lists parse in linear time, so a subscription with tens of thousands of entries loads without stalling the page.',
      'Entries that could never match are no longer counted as rules.',
    ],
  },
  {
    from: '1.14.0',
    to: '1.14.1',
    date: '28 July 2026',
    title: 'A list readout that keeps up',
    notes: [
      'The rule-list summary recomputes as you type, rather than standing by a verdict from before your last edit.',
      'A domain-list entry may carry a trailing comment.',
    ],
  },
  {
    from: '1.13.0',
    to: '1.13.1',
    date: '28 July 2026',
    title: 'Domain lists, by name',
    notes: [
      'The second list format is called a domain list everywhere and documented properly, instead of being described two different ways two inches apart.',
    ],
  },
  {
    from: '1.12.0',
    date: '28 July 2026',
    title: 'Support link',
    notes: [
      'A support link at the foot of the sidebar.',
      'The published screenshots are generated from the real interface, and no longer show routable IP addresses.',
    ],
  },
  {
    from: '1.11.0',
    date: '28 July 2026',
    title: 'One surface',
    notes: [
      'An interface pass: text came off the vivid brand colours, where it had been hard to read, and the popup and the options page now read as one piece rather than two designs that met once.',
    ],
  },
  {
    from: '1.10.0',
    to: '1.10.2',
    date: '27–28 July 2026',
    title: 'Route a site that will not load',
    notes: [
      'Sockitt follows the navigation rather than the page already on screen, so you can route a site from the popup while it is still failing to load — which is usually the moment you want to.',
      'The toolbar shows the Sockitt mark instead of a grey circle.',
    ],
  },
  {
    from: '1.9.0',
    date: '27 July 2026',
    title: 'Proxy errors, in one place',
    notes: [
      'Failures get a page of their own: the error code and what it means, which proxy was carrying the traffic, and the log — and they clear themselves once the proxy recovers.',
    ],
  },
  {
    from: '1.8.0',
    to: '1.8.29',
    date: '24–26 July 2026',
    title: 'A two-pane popup, and a safer default',
    notes: [
      'The popup became a two-pane window: switch profiles on one side, manage where the current tab goes on the other — add, retarget, delete or override that site’s rule without leaving the page.',
      'IP address lookups are one opt-in setting, off by default. Until you turn it on, Sockitt contacts nothing on its own but the rule-list URLs you configure.',
      'The exit readout says where the current tab exits, on one fixed line that no longer shifts the popup as it loads.',
      'Security fixes: a proxy that could fail open silently, a rule-list pattern that could hang the parser, and an IPv6 address that slipped past a bypass list.',
    ],
  },
  {
    from: '1.7.0',
    to: '1.7.5',
    date: '24 July 2026',
    title: 'Inspect and test',
    notes: [
      'Route inspector: trace any URL through the real resolver and see which rule fired, the chain it walked, and where it landed.',
      'Connection tests for each proxy, an exit-IP readout, and a separate profile for incognito windows.',
    ],
  },
  {
    from: '1.6.0',
    to: '1.6.6',
    date: '24 July 2026',
    title: 'Credentials and sync, hardened',
    notes: [
      'Proxy authentication survives the service worker being suspended, credentials stay out of synced data, and a device running a different configuration format pauses sync rather than overwriting what is there.',
      'A published privacy policy.',
    ],
  },
  {
    from: '1.5.0',
    to: '1.5.6',
    date: '24 July 2026',
    title: 'More than SOCKS5',
    notes: [
      'HTTP, HTTPS and SOCKS4 proxies alongside SOCKS5, with optional username and password authentication on HTTP(S).',
      'Renamed to Sockitt — Proxy Switcher, since SOCKS5 was no longer the whole story.',
    ],
  },
  {
    from: '1.4.0',
    date: '24 July 2026',
    title: 'Documentation inside the extension',
    notes: ['An in-app docs page, so the manual sits where the settings are.'],
  },
  {
    from: '1.3.0',
    to: '1.3.1',
    date: '24 July 2026',
    title: 'Site rules, and a light theme',
    notes: ['A site rule manager, a light theme, and a redesigned options page.'],
  },
  {
    from: '1.2.0',
    to: '1.2.1',
    date: '24 July 2026',
    title: 'Rules that scale',
    notes: [
      'Rule lists, profiles that point at other profiles, temporary rules, configuration sync, and quick switch.',
      'Fourteen review findings fixed, covering security and a path that could lose synced data.',
    ],
  },
  {
    from: '1.1.0',
    date: '24 July 2026',
    title: 'An identity for every profile',
    notes: ['Initials avatars and an identity panel, so the active profile is recognisable at a glance.'],
  },
  {
    from: '1.0.0',
    date: '24 July 2026',
    title: 'First release',
    notes: ['A SOCKS5 proxy switcher for Chromium, built on Manifest V3.'],
  },
];

/** '1.8.0' → '1.8', so a running 1.8.19 still matches its own entry. */
function seriesOf(version: string): string {
  return version.split('.').slice(0, 2).join('.');
}

function runningVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '';
  }
}

/**
 * The release history. Reached from the Documentation page rather than the
 * sidebar: it is worth reading once and then not again for a while, which is
 * not worth a permanent seat in the navigation.
 */
export function releasesPanel(onBack: () => void): HTMLElement {
  const running = seriesOf(runningVersion());

  const entry = (r: Release): HTMLElement => {
    const current = running !== '' && seriesOf(r.from) === running;
    return el(
      'article',
      { class: `card panel rel-card${current ? ' current' : ''}` },
      el(
        'div',
        { class: 'rel-head' },
        el('span', { class: 'rel-ver' }, r.to ? `${r.from} – ${r.to}` : r.from),
        current ? el('span', { class: 'rel-now' }, 'You are here') : null,
        el('span', { class: 'rel-date' }, r.date)
      ),
      el('h3', {}, r.title),
      el('ul', { class: 'rel-list' }, ...r.notes.map((n) => el('li', {}, n)))
    );
  };

  return el(
    'div',
    { class: 'pane docs releases' },
    el(
      'div',
      { class: 'doc-head' },
      el('h2', { class: 'doc-title' }, 'Release notes'),
      el(
        'button',
        {
          class: 'doc-link',
          type: 'button',
          onclick: (e: Event) => {
            e.preventDefault();
            onBack();
          },
        },
        '← Documentation'
      )
    ),
    el(
      'p',
      { class: 'doc-p rel-intro' },
      'Grouped by release series — a run of patches that shared a theme. Newest first.'
    ),
    ...RELEASES.map(entry)
  );
}
