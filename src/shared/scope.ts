import { Config } from './types';

/**
 * Incognito windows can run their own proxy scope (settings.incognitoProfileId).
 * Chrome keeps that scope apart from the regular one, so everything Sockitt
 * stores and shows about it has to be kept apart too — which is what this
 * module decides, once, for the worker and the popup alike.
 *
 * The rule both of them follow: an incognito window has a scope of its own only
 * when Chrome allows Sockitt into incognito AND a separate profile is set.
 * "Same as regular windows" clears the incognito scope outright, so those
 * windows ride the regular settings — overrides included — and every readout
 * about them is simply the regular one.
 */
export type Scope = 'regular' | 'incognito';

/**
 * The profile an incognito window routes by, or null when it follows the
 * regular one. `allowed` is chrome.extension.isAllowedIncognitoAccess(): without
 * it the incognito scope is not ours to set, so the setting means nothing and
 * incognito spans the regular settings as it did before the feature existed.
 */
export function incognitoActiveId(config: Config, allowed: boolean): string | null {
  const id = config.settings.incognitoProfileId;
  return allowed && id ? id : null;
}

/**
 * Where a scope's temporary overrides on `profileId` live in the session-storage
 * map. Each scope gets its own slot because each gets its own proxy settings:
 * one shared slot would let a route chosen by hand in an incognito window keep
 * routing that way in regular ones, and the reverse.
 *
 * Both scopes are named in the key, rather than only incognito being prefixed,
 * so the two namespaces cannot meet whatever a profile id turns out to be — an
 * imported configuration may carry any string as an id, including one shaped
 * like the prefix itself.
 */
export function tempRuleKey(profileId: string, scope: Scope): string {
  return `${scope}:${profileId}`;
}
