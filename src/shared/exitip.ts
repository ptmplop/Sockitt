/**
 * Exit-IP lookup via ipconfig.is. Used by the popup (exit line in the hero
 * card) and by the background's proxy test. The request rides the browser's
 * current proxy settings, which is the whole point — the reported IP is the
 * exit the active route produces.
 *
 * ipconfig.is sends no CORS headers, so extension contexts need its origin
 * granted (covered by the manifest's optional <all_urls> host pattern). UI
 * surfaces request EXIT_IP_PERMS from a user gesture before first use.
 */

export const EXIT_IP_URL = 'https://ipconfig.is/json';

export const EXIT_IP_PERMS: chrome.permissions.Permissions = {
  origins: ['https://ipconfig.is/*'],
};

export interface ExitInfo {
  ip: string;
  /** Country name, e.g. "Thailand" — absent if the service has no geo data. */
  country?: string;
  /** ISO 3166-1 alpha-2, uppercased, e.g. "TH". */
  iso?: string;
  /** Round-trip time of the lookup in milliseconds. */
  ms: number;
}

export async function checkExitIp(timeoutMs = 8000): Promise<ExitInfo> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(EXIT_IP_URL, {
      cache: 'no-store',
      credentials: 'omit',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    const ms = Math.round(performance.now() - t0);
    const ip = typeof data.ip === 'string' && data.ip ? data.ip : '';
    if (!ip) throw new Error('no IP in response');
    const country =
      typeof data.country_name === 'string' && data.country_name ? data.country_name : undefined;
    const isoRaw = typeof data.country_code === 'string' ? data.country_code : '';
    const iso = /^[A-Za-z]{2}$/.test(isoRaw) ? isoRaw.toUpperCase() : undefined;
    return { ip, country, iso, ms };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new Error('timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** "TH" → 🇹🇭 (regional-indicator pair); '' for anything that isn't alpha-2. */
export function flagEmoji(iso?: string): string {
  if (!iso || !/^[A-Z]{2}$/.test(iso)) return '';
  return String.fromCodePoint(...[...iso].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
