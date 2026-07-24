import { avatarEl, builtinTile } from '../shared/avatar';
import { compileRule, pacRequestUrl, resolveRoute, testCondition } from '../shared/match';
import { parseRuleList } from '../shared/rulelist';
import { loadConfig, loadTempRules, saveConfig, saveTempRules } from '../shared/state';
import {
  Config,
  DIRECT,
  Profile,
  SCHEME_LABELS,
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
  await loadOverride(config.activeId);
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
  // Load the new profile's override before the single render so the section
  // never flashes the previous profile's state. The background applies the
  // proxy (and reloads the tab if refreshOnSwitch is on) off the storage write.
  await loadOverride(id);
  await saveConfig(config);
  render();
}

/**
 * The override is a single, always-temporary rule (session storage). Older
 * versions could store several temp rules; collapse to one so the UI only
 * ever manages a single override slot.
 */
async function loadOverride(profileId: string): Promise<void> {
  const rules = await loadTempRules(profileId);
  tempRules = rules.slice(0, 1);
  if (rules.length > 1) await saveTempRules(profileId, tempRules);
}

async function setOverride(profileId: string, rule: SwitchRule | null): Promise<void> {
  tempRules = rule ? [rule] : [];
  await saveTempRules(profileId, tempRules);
}

function statusFor(profile: Profile): string {
  switch (profile.kind) {
    case 'proxy':
      return `${SCHEME_LABELS[profile.scheme]} · ${profile.host}:${profile.port}`;
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
    status = 'No proxy - straight to the network';
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

/* ---- current-site auto-switch management (active switch profile only) ---- */

/** First enabled permanent rule whose condition matches the current site. */
function matchedRuleFor(profile: SwitchProfile, url: string, host: string): SwitchRule | undefined {
  return profile.rules.find((r) => r.enabled && testCondition(compileRule(r), url, host));
}

/** A target picker: Direct + proxies, plus the current value if it's some other profile. */
function siteTargetSelect(current: string, onChange: (v: string) => void): HTMLSelectElement {
  const select = el('select', { class: 'input sm' }) as HTMLSelectElement;
  select.append(el('option', { value: DIRECT }, 'Direct'));
  const proxies = proxyProfiles(config);
  for (const p of proxies) select.append(el('option', { value: p.id }, p.name));
  if (current !== DIRECT && !proxies.some((p) => p.id === current)) {
    const cp = config.profiles.find((p) => p.id === current);
    if (cp) select.append(el('option', { value: current }, cp.name));
  }
  select.value = [...select.options].some((o) => o.value === current) ? current : DIRECT;
  select.onchange = () => onChange(select.value);
  return select;
}

function targetChip(targetId: string, size: number): { tile: HTMLElement; name: string } {
  if (targetId === DIRECT) return { tile: builtinTile('D', size), name: 'Direct' };
  const p = config.profiles.find((x) => x.id === targetId);
  return p ? { tile: avatarEl(p, size), name: p.name } : { tile: builtinTile('D', size), name: 'Direct' };
}

function siteManager(active: SwitchProfile): HTMLElement {
  if (!tab) {
    return el('div', { class: 'card site-mgr muted' }, 'Open a website to manage its route here.');
  }
  const matchUrl = pacRequestUrl(tab.url);
  const override = tempRules[0];
  const hasOverride = !!override;

  const route = resolveRoute(config, active, matchUrl, tab.host, tempRules);
  const via = route.bypassed
    ? { tile: builtinTile('D', 22), name: 'Direct (bypass)' }
    : targetChip(route.targetId, 22);

  /* --- route summary --- */
  const routeSummary = el(
    'div',
    { class: 'site-route' },
    el('span', { class: 'site-route-lead' }, 'Now routing via'),
    el('span', { class: 'via' }, via.tile, el('span', { class: 'via-name' }, via.name))
  );

  /* --- rule block: edit the matching rule or add one; greyed while overridden --- */
  const matched = matchedRuleFor(active, matchUrl, tab.host);
  let ruleBlock: HTMLElement;
  if (matched) {
    const sel = siteTargetSelect(matched.targetId, (v) => {
      matched.targetId = v;
      void saveConfig(config);
      render();
    });
    sel.disabled = hasOverride;
    ruleBlock = el(
      'div',
      { class: `site-block${hasOverride ? ' greyed' : ''}` },
      el('div', { class: 'site-block-head' }, el('span', { class: 'site-block-label' }, 'Rule for this site')),
      el(
        'div',
        { class: 'site-block-ctl' },
        el('span', { class: 'mono site-pattern', title: matched.pattern }, matched.pattern),
        sel
      )
    );
  } else {
    const sel = siteTargetSelect(proxyProfiles(config)[0]?.id ?? DIRECT, () => undefined);
    sel.disabled = hasOverride;
    const add = el(
      'button',
      {
        class: 'btn sm',
        disabled: hasOverride,
        title: `Add a rule routing *.${tab.host}`,
        onclick: () => {
          const rule: SwitchRule = {
            id: uid(),
            enabled: true,
            type: 'hostWildcard',
            pattern: `*.${tab!.host}`,
            targetId: sel.value,
          };
          if (config.settings.addToBottom) active.rules.push(rule);
          else active.rules.unshift(rule);
          void saveConfig(config);
          toast('Rule added');
          render();
        },
      },
      'Add rule'
    );
    ruleBlock = el(
      'div',
      { class: `site-block${hasOverride ? ' greyed' : ''}` },
      el(
        'div',
        { class: 'site-block-head' },
        el('span', { class: 'site-block-label' }, 'No rule for this site'),
        el('span', { class: 'site-block-note' }, `routes via default`)
      ),
      el('div', { class: 'site-block-ctl' }, sel, add)
    );
  }

  /* --- override block: always temporary, single slot, deletable --- */
  const overrideHead = el(
    'div',
    { class: 'site-block-head' },
    el('span', { class: 'site-block-label temp' }, 'Override'),
    el('span', { class: 'site-block-note' }, 'temporary')
  );
  let overrideBlock: HTMLElement;
  if (override) {
    const chip = targetChip(override.targetId, 18);
    overrideBlock = el(
      'div',
      { class: 'site-block override active' },
      overrideHead,
      el(
        'div',
        { class: 'site-block-ctl' },
        el(
          'span',
          { class: 'ov-chip' },
          chip.tile,
          el('span', { class: 'mono', title: override.pattern }, override.pattern),
          el('span', { class: 'ov-arrow', innerHTML: '&#8594;' }),
          el('span', { class: 'ov-target' }, chip.name)
        ),
        el('button', {
          class: 'btn ghost icon ov-remove',
          title: 'Remove override',
          innerHTML: '&#10005;',
          onclick: () => {
            void setOverride(active.id, null);
            toast('Override removed');
            render();
          },
        })
      )
    );
  } else {
    const sel = siteTargetSelect(proxyProfiles(config)[0]?.id ?? DIRECT, () => undefined);
    overrideBlock = el(
      'div',
      { class: 'site-block override' },
      overrideHead,
      el(
        'div',
        { class: 'site-block-ctl' },
        sel,
        el(
          'button',
          {
            class: 'btn sm',
            title: `Temporarily route *.${tab.host} until the browser restarts`,
            onclick: () => {
              void setOverride(active.id, {
                id: uid(),
                enabled: true,
                type: 'hostWildcard',
                pattern: `*.${tab!.host}`,
                targetId: sel.value,
              });
              toast('Override set');
              render();
            },
          },
          'Set'
        )
      )
    );
  }

  return el(
    'div',
    { class: 'card site-mgr' },
    routeSummary,
    el('div', { class: 'site-div' }),
    ruleBlock,
    el('div', { class: 'site-div' }),
    overrideBlock
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
        el('span', { class: 'brand' }, el('img', { class: 'mark', src: 'img/logo-mark.png', alt: '' }), 'Sockitt'),
        el('button', {
          class: 'btn ghost icon cog',
          title: 'Options',
          innerHTML: '&#9881;',
          onclick: () => chrome.runtime.openOptionsPage(),
        })
      ),
      proxyError ? el('div', { class: 'banner' }, `Proxy error: ${proxyError.message}`) : null,
      activeProfile?.kind === 'switch'
        ? enter(
            el(
              'div',
              { class: 'site-section' },
              el(
                'div',
                { class: 'site-head' },
                el(
                  'div',
                  { class: 'site-head-top' },
                  el('span', { class: 'site-head-label' }, 'Auto switch'),
                  tempRules[0] ? el('span', { class: 'temp-badge' }, 'OVERRIDE ACTIVE') : null
                ),
                tab ? el('span', { class: 'site-head-host', title: tab.host }, tab.host) : null
              ),
              siteManager(activeProfile)
            )
          )
        : null,
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
      el(
        'div',
        { class: 'foot' },
        el(
          'button',
          { class: 'btn ghost foot-manage', onclick: () => chrome.runtime.openOptionsPage() },
          el('span', { innerHTML: '&#9881;' }),
          'Manage profiles & rules'
        )
      )
    )
  );
  firstRender = false;
}

void init();
