import { avatarEl, builtinTile, initialsFor } from '../shared/avatar';
import { resolveRoute } from '../shared/match';
import { loadConfig, saveConfig } from '../shared/state';
import {
  Config,
  DIRECT,
  SYSTEM,
  SwitchProfile,
  proxyProfiles,
  switchProfiles,
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
let firstRender = true;

async function init(): Promise<void> {
  config = await loadConfig();
  const session = await chrome.storage.session.get('sockitt-error').catch(() => ({}));
  proxyError = (session as Record<string, { message: string }>)['sockitt-error'] ?? null;
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

function setActive(id: string): void {
  config.activeId = id;
  void saveConfig(config);
  render();
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
  } else if (profile.kind === 'proxy') {
    tile = avatarEl(profile, 44);
    name = profile.name;
    status = `SOCKS5 · ${profile.host}:${profile.port}`;
    tint = profile.color;
  } else {
    tile = avatarEl(profile, 44);
    name = profile.name;
    const n = profile.rules.filter((r) => r.enabled).length;
    status = `Auto switch · ${n} active rule${n === 1 ? '' : 's'}`;
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
  const route = resolveRoute(config, active, tab.url, tab.host);
  const target = config.profiles.find((p) => p.id === route.targetId);
  const viaName = route.bypassed ? 'Direct (bypass)' : target?.name ?? 'Direct';
  const viaTile = target && !route.bypassed ? avatarEl(target, 18) : builtinTile('D', 18);

  const select = el('select', { class: 'input' }) as HTMLSelectElement;
  select.append(el('option', { value: DIRECT }, 'Direct'));
  for (const p of proxyProfiles(config)) select.append(el('option', { value: p.id }, p.name));
  const firstProxy = proxyProfiles(config)[0];
  if (firstProxy && route.targetId !== firstProxy.id) select.value = firstProxy.id;

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
      el(
        'button',
        {
          class: 'btn primary',
          title: `Route *.${tab.host} via the selected target`,
          onclick: () => {
            active.rules.push({
              id: uid(),
              enabled: true,
              type: 'hostWildcard',
              pattern: `*.${tab!.host}`,
              targetId: select.value,
            });
            void saveConfig(config);
            toast('Rule added');
            render();
          },
        },
        '+ Rule'
      )
    )
  );
}

/* ---- render ---- */

function render(): void {
  const activeProfile = config.profiles.find((p) => p.id === config.activeId);
  const proxies = proxyProfiles(config);
  const switches = switchProfiles(config);

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
      proxies.length ? enter(el('div', { class: 'section-label' }, 'Proxies')) : null,
      ...proxies.map((p) =>
        enter(profileRow(p.id, avatarEl(p, 24), p.name, `${p.host}:${p.port}`, p.color))
      ),
      switches.length ? enter(el('div', { class: 'section-label' }, 'Auto switch')) : null,
      ...switches.map((p) =>
        enter(
          profileRow(
            p.id,
            avatarEl(p, 24),
            p.name,
            `${p.rules.length} rule${p.rules.length === 1 ? '' : 's'}`,
            p.color
          )
        )
      ),
      activeProfile?.kind === 'switch' ? enter(tabCard(activeProfile)) : null,
      el(
        'div',
        { class: 'foot' },
        el('span', { class: 'hint' }, activeProfile ? `${initialsFor(activeProfile)} shown in toolbar` : ''),
        el('button', { class: 'btn ghost', onclick: () => chrome.runtime.openOptionsPage() }, 'Manage')
      )
    )
  );
  firstRender = false;
}

void init();
