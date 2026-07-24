import { avatarEl, builtinTile, initialsFor } from '../shared/avatar';
import { pacRequestUrl, resolveRoute } from '../shared/match';
import { parseRuleList } from '../shared/rulelist';
import { loadConfig, loadTempRules, saveConfig, saveTempRules } from '../shared/state';
import {
  Config,
  DIRECT,
  Profile,
  SYSTEM,
  SwitchProfile,
  SwitchRule,
  proxyProfiles,
  uid,
} from '../shared/types';
import { el, toast } from '../shared/ui';

const app = document.getElementById('app')!;

interface TabInfo {
  url: string;
  host: string;
}

let config: Config;
let tab: TabInfo | null = null;
let proxyError: { message: string } | null = null;
let tempRules: SwitchRule[] = [];
let firstRender = true;

async function init(): Promise<void> {
  config = await loadConfig();
  const session = await chrome.storage.session.get('sockitt-error').catch(() => ({}));
  proxyError = (session as Record<string, { message: string }>)['sockitt-error'] ?? null;
  tempRules = await loadTempRules(config.activeId);
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active?.url && /^https?:/i.test(active.url)) {
      tab = { url: active.url, host: new URL(active.url).hostname };
    }
  } catch {
    tab = null;
  }
  render();
}

async function setActive(id: string): Promise<void> {
  config.activeId = id;
  // Load the new profile's temp rules before the single render so the tab card
  // never flashes the previous profile's rules. The background applies the
  // proxy (and reloads the tab if refreshOnSwitch is on) off the storage write.
  tempRules = await loadTempRules(id);
  await saveConfig(config);
  render();
}

function statusFor(profile: Profile): string {
  switch (profile.kind) {
    case 'proxy':
      return `SOCKS5 · ${profile.host}:${profile.port}`;
    case 'switch': {
      const n = profile.rules.filter((r) => r.enabled).length + tempRulesFor(profile.id).length;
      return `Auto switch · ${n} active rule${n === 1 ? '' : 's'}`;
    }
    case 'virtual': {
      const target = config.profiles.find((p) => p.id === profile.targetId);
      return `Alias → ${target?.name ?? 'Direct'}`;
    }
    case 'rulelist': {
      const n = parseRuleList(profile.format, profile.text).count;
      return `Rule list · ${n} entr${n === 1 ? 'y' : 'ies'}`;
    }
  }
}

function subFor(profile: Profile): string {
  switch (profile.kind) {
    case 'proxy':
      return `${profile.host}:${profile.port}`;
    case 'switch':
      return `${profile.rules.length} rule${profile.rules.length === 1 ? '' : 's'}`;
    case 'virtual':
      return 'alias';
    case 'rulelist':
      return profile.format;
  }
}

function tempRulesFor(profileId: string): SwitchRule[] {
  return config.activeId === profileId ? tempRules : [];
}

/* ---- hero: the current selection, big and unmistakable ---- */

function hero(): HTMLElement {
  const { activeId } = config;
  const profile = config.profiles.find((p) => p.id === activeId);

  let tile: HTMLElement;
  let name: string;
  let status: string;
  let tint = 'transparent';

  if (activeId === DIRECT) {
    tile = builtinTile('D', 44);
    name = 'Direct';
    status = 'No proxy — straight to the network';
  } else if (activeId === SYSTEM || !profile) {
    tile = builtinTile('S', 44);
    name = 'System';
    status = 'Following OS proxy settings';
  } else {
    tile = avatarEl(profile, 44);
    name = profile.name;
    status = statusFor(profile);
    tint = profile.color;
  }

  const card = el(
    'div',
    { class: 'card hero-card' },
    tile,
    el(
      'div',
      { class: 'hero-meta' },
      el('div', { class: 'hero-name' }, name),
      el('div', { class: 'hero-status' }, status)
    )
  );
  card.style.setProperty('--tint', tint);
  return card;
}

/* ---- rows ---- */

function profileRow(
  id: string,
  tile: HTMLElement,
  name: string,
  sub: string,
  color?: string
): HTMLElement {
  const active = config.activeId === id;
  const row = el(
    'button',
    { class: `row${active ? ' active' : ''}`, onclick: () => setActive(id) },
    tile,
    el(
      'span',
      { class: 'meta' },
      el('span', { class: 'title' }, name),
      el('span', { class: 'sub' }, sub)
    ),
    el('span', { class: 'check', innerHTML: active ? '&#10003;' : '' })
  );
  if (color) row.style.setProperty('--row-color', color);
  return row;
}

/* ---- current-tab routing card (active switch profile only) ---- */

function tabCard(active: SwitchProfile): HTMLElement {
  if (!tab) {
    return el('div', { class: 'card tab-card muted' }, 'Open a website to preview its route.');
  }
  const route = resolveRoute(config, active, pacRequestUrl(tab.url), tab.host, tempRules);
  const target = config.profiles.find((p) => p.id === route.targetId);
  const viaName = route.bypassed ? 'Direct (bypass)' : target?.name ?? 'Direct';
  const viaTile = target && !route.bypassed ? avatarEl(target, 18) : builtinTile('D', 18);

  const select = el('select', { class: 'input' }) as HTMLSelectElement;
  select.append(el('option', { value: DIRECT }, 'Direct'));
  for (const p of proxyProfiles(config)) select.append(el('option', { value: p.id }, p.name));
  const firstProxy = proxyProfiles(config)[0];
  if (firstProxy && route.targetId !== firstProxy.id) select.value = firstProxy.id;

  const untilRestart = el('input', {
    class: 'toggle mini',
    type: 'checkbox',
    id: 'temp-toggle',
  }) as HTMLInputElement;

  const addRule = (): void => {
    const rule: SwitchRule = {
      id: uid(),
      enabled: true,
      type: 'hostWildcard',
      pattern: `*.${tab!.host}`,
      targetId: select.value,
    };
    if (untilRestart.checked) {
      tempRules.push(rule);
      void saveTempRules(active.id, tempRules);
      toast('Temporary rule added');
    } else {
      if (config.settings.addToBottom) active.rules.push(rule);
      else active.rules.unshift(rule);
      void saveConfig(config);
      toast('Rule added');
    }
    render();
  };

  return el(
    'div',
    { class: 'card tab-card' },
    el(
      'div',
      { class: 'tab-route' },
      el('span', { class: 'host', title: tab.host }, tab.host),
      el('span', { class: 'arrow', innerHTML: '&#8594;' }),
      el('span', { class: 'via' }, viaTile, viaName)
    ),
    el(
      'div',
      { class: 'quick-add' },
      select,
      el('button', { class: 'btn primary', title: `Route *.${tab.host} via the selected target`, onclick: addRule }, '+ Rule')
    ),
    el(
      'label',
      { class: 'temp-row', htmlFor: 'temp-toggle' },
      untilRestart,
      el('span', {}, 'Only until browser restart')
    ),
    tempRules.length
      ? el(
          'div',
          { class: 'temp-list' },
          el('span', { class: 'temp-title' }, 'Temporary rules'),
          ...tempRules.map((rule) =>
            el(
              'span',
              { class: 'chip' },
              el('span', { class: 'mono' }, rule.pattern),
              el('button', {
                class: 'chip-x',
                title: 'Remove',
                innerHTML: '&#10005;',
                onclick: () => {
                  tempRules = tempRules.filter((r) => r.id !== rule.id);
                  void saveTempRules(active.id, tempRules);
                  render();
                },
              })
            )
          )
        )
      : null
  );
}

/* ---- render ---- */

function render(): void {
  const activeProfile = config.profiles.find((p) => p.id === config.activeId);

  const groups: Array<[string, Profile[]]> = [
    ['Proxies', config.profiles.filter((p) => p.kind === 'proxy')],
    ['Auto switch', config.profiles.filter((p) => p.kind === 'switch')],
    ['Rule lists', config.profiles.filter((p) => p.kind === 'rulelist')],
    ['Aliases', config.profiles.filter((p) => p.kind === 'virtual')],
  ];

  let stagger = 0;
  const enter = (node: HTMLElement): HTMLElement => {
    if (firstRender) {
      node.classList.add('enter');
      node.style.animationDelay = `${stagger}ms`;
      stagger += 22;
    }
    return node;
  };

  app.replaceChildren(
    el(
      'div',
      { class: 'pop' },
      el(
        'div',
        { class: 'pop-head' },
        el('span', { class: 'brand' }, el('img', { class: 'mark', src: 'img/icon-48.png', alt: '' }), 'Sockitt'),
        el('button', {
          class: 'btn ghost icon',
          title: 'Options',
          innerHTML: '&#9881;',
          onclick: () => chrome.runtime.openOptionsPage(),
        })
      ),
      proxyError ? el('div', { class: 'banner' }, `Proxy error: ${proxyError.message}`) : null,
      enter(hero()),
      enter(
        el(
          'div',
          { class: 'builtin-grid' },
          profileRow(DIRECT, builtinTile('D', 24), 'Direct', 'no proxy'),
          profileRow(SYSTEM, builtinTile('S', 24), 'System', 'OS settings')
        )
      ),
      ...groups.flatMap(([label, profiles]) =>
        profiles.length
          ? [
              enter(el('div', { class: 'section-label' }, label)),
              ...profiles.map((p) =>
                enter(profileRow(p.id, avatarEl(p, 24), p.name, subFor(p), p.color))
              ),
            ]
          : []
      ),
      activeProfile?.kind === 'switch' ? enter(tabCard(activeProfile)) : null,
      el(
        'div',
        { class: 'foot' },
        el(
          'span',
          { class: 'hint' },
          activeProfile ? `${initialsFor(activeProfile)} shown in toolbar` : ''
        ),
        el('button', { class: 'btn ghost', onclick: () => chrome.runtime.openOptionsPage() }, 'Manage')
      )
    )
  );
  firstRender = false;
}

void init();
