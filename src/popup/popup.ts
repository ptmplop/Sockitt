import { resolveRoute } from '../shared/match';
import { loadConfig, saveConfig } from '../shared/state';
import {
  Config,
  DIRECT,
  Profile,
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

function profileRow(id: string, name: string, color: string, sub?: string): HTMLElement {
  const active = config.activeId === id;
  const row = el(
    'button',
    { class: `row${active ? ' active' : ''}`, onclick: () => setActive(id) },
    el('span', { class: 'dot', style: { background: color, color } }),
    el('span', { class: 'title' }, name),
    sub ? el('span', { class: 'sub' }, sub) : null,
    active ? el('span', { class: 'check' }, '✓') : null
  );
  row.style.setProperty('--row-color', color);
  return row;
}

function tabCard(active: SwitchProfile): HTMLElement {
  if (!tab) {
    return el('div', { class: 'card tab-card muted' }, 'Open a website to preview its route.');
  }
  const route = resolveRoute(config, active, tab.url, tab.host);
  const target = config.profiles.find((p) => p.id === route.targetId);
  const viaName = route.bypassed
    ? 'Direct (bypass)'
    : target?.name ?? 'Direct';
  const viaColor = route.bypassed ? 'var(--text-dim)' : target?.color ?? '#8b93a7';

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
      el('span', { class: 'arrow' }, '→'),
      el(
        'span',
        { class: 'via' },
        el('span', { class: 'dot', style: { background: viaColor, color: viaColor } }),
        viaName
      )
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

function render(): void {
  const activeProfile = config.profiles.find((p) => p.id === config.activeId);
  const proxies = proxyProfiles(config);
  const switches = switchProfiles(config);

  app.replaceChildren(
    el(
      'div',
      { class: 'pop' },
      el(
        'div',
        { class: 'pop-head' },
        el('span', { class: 'brand' }, el('span', { class: 'mark' }), 'Sockitt'),
        el('button', {
          class: 'btn ghost icon',
          title: 'Options',
          innerHTML: '⚙',
          onclick: () => chrome.runtime.openOptionsPage(),
        })
      ),
      proxyError
        ? el('div', { class: 'banner' }, `Proxy error: ${proxyError.message}`)
        : null,
      el(
        'div',
        { class: 'list' },
        profileRow(DIRECT, 'Direct', '#8b93a7'),
        profileRow(SYSTEM, 'System proxy', '#5f6b85'),
        proxies.length ? el('div', { class: 'section-label' }, 'Proxies') : null,
        ...proxies.map((p) => profileRow(p.id, p.name, p.color, `${p.host}:${p.port}`)),
        switches.length ? el('div', { class: 'section-label' }, 'Auto switch') : null,
        ...switches.map((p) =>
          profileRow(p.id, p.name, p.color, `${p.rules.length} rule${p.rules.length === 1 ? '' : 's'}`)
        )
      ),
      activeProfile?.kind === 'switch' ? tabCard(activeProfile) : null,
      el(
        'div',
        { class: 'foot' },
        el('span', { class: 'hint' }, footHint(activeProfile)),
        el(
          'button',
          { class: 'btn ghost', onclick: () => chrome.runtime.openOptionsPage() },
          'Manage'
        )
      )
    )
  );
}

function footHint(active: Profile | undefined): string {
  if (config.activeId === DIRECT) return 'No proxy in use';
  if (config.activeId === SYSTEM) return 'Using system settings';
  if (!active) return '';
  return active.kind === 'proxy' ? 'SOCKS5' : 'Rule-based routing';
}

void init();
