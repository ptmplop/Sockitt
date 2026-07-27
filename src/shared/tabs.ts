/**
 * Which web page a tab is about — the one it is showing, or the one it is
 * TRYING to reach.
 *
 * Chrome leaves `tab.url` on the old document until a navigation commits, and a
 * navigation to a host you cannot reach commits only when it finally gives up —
 * a dropped SYN hangs for tens of seconds. So for that whole window `tab.url`
 * names the previous page, and in a fresh tab it is `""` or `chrome://newtab/`.
 * That is exactly when someone reaches for the popup ("why won't this load?"),
 * and reading `tab.url` alone answered with the wrong site, or with "no web page
 * here" and no rule to add at all.
 *
 * `tab.pendingUrl` is the address in flight, and it needs no extra permission:
 * the activeTab grant hands the extension the tabs API for the whole tab, not
 * just for its committed origin, so both fields arrive together.
 */
export interface TabTarget {
  /** The pending navigation's URL when there is one, else the committed one. */
  url: string;
  host: string;
  /** True when `url` names a navigation that has not committed yet. */
  pending: boolean;
}

/** The two fields this reads — a subset of chrome.tabs.Tab, so it stays testable. */
export interface TabUrls {
  url?: string;
  pendingUrl?: string;
}

function webPage(url: string | undefined): { url: string; host: string } | null {
  if (!url || !/^https?:/i.test(url)) return null;
  try {
    return { url, host: new URL(url).hostname };
  } catch {
    return null; // not a URL Chrome would route (nor one we could match against)
  }
}

/**
 * The http(s) page a tab is on or heading to — or null when it is neither
 * (a chrome:// page, a brand-new tab, a URL the extension may not see).
 * A pending navigation wins: it is the page the user is waiting on, and it is
 * the one a new rule needs to cover.
 */
export function tabTarget(tab: TabUrls | undefined | null): TabTarget | null {
  const pending = webPage(tab?.pendingUrl);
  if (pending) return { ...pending, pending: true };
  const committed = webPage(tab?.url);
  return committed ? { ...committed, pending: false } : null;
}
