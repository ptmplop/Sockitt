import { avatarEl, builtinTile, initialsFor } from '../shared/avatar';
import { docsPanel } from './docs';
import { patternError } from '../shared/match';
import { parseRuleList } from '../shared/rulelist';
import {
  loadConfig,
  newProxyProfile,
  newRuleListProfile,
  newSwitchProfile,
  newVirtualProfile,
  onConfigChanged,
  sanitizeConfig,
  saveConfig,
  saveConfigRaw,
} from '../shared/state';
import { SYNC_ERROR_KEY, clearSync, pullFromSync } from '../shared/sync';
import {
  Config,
  DIRECT,
  PALETTE,
  Profile,
  ProxyProfile,
  ProxyScheme,
  RuleListProfile,
  RuleType,
  SCHEME_LABELS,
  SwitchProfile,
  SYSTEM,
  VirtualProfile,
  proxyProfiles,
  reachableFrom,
  schemeSupportsAuth,
  uid,
} from '../shared/types';
import { el, toast } from '../shared/ui';

const app = document.getElementById('app')!;
const SETTINGS_ID = '@settings';
const DOCS_ID = '@docs';

let config: Config;
let selectedId: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let syncError: string | null = null;

const RULE_TYPES: Record<RuleType, string> = {
  hostWildcard: 'Host wildcard',
  hostRegex: 'Host regex',
  urlWildcard: 'URL wildcard',
  urlRegex: 'URL regex',
  ipCidr: 'IP / CIDR',
  keyword: 'URL keyword',
  hostLevels: 'Host levels',
  weekday: 'Weekday',
  time: 'Time of day',
};

const KIND_LABEL: Record<Profile['kind'], string> = {
  proxy: 'Proxies',
  switch: 'Auto switch',
  rulelist: 'Rule lists',
  virtual: 'Aliases',
};

let savePending = false;

function scheduleSave(): void {
  savePending = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    savePending = false;
    void saveConfig(config).then(() => toast('Saved'));
  }, 300);
}

function selected(): Profile | null {
  return config.profiles.find((p) => p.id === selectedId) ?? null;
}

function confirmMaybe(message: string): boolean {
  return !config.settings.confirmDeletion || confirm(message);
}

/* ---------- sidebar ---------- */

function sidebar(): HTMLElement {
  const item = (p: Profile) =>
    el(
      'button',
      {
        class: `nav-item${p.id === selectedId ? ' selected' : ''}`,
        onclick: () => {
          selectedId = p.id;
          render();
        },
      },
      avatarEl(p, 22),
      el('span', { class: 'name' }, p.name),
      config.activeId === p.id ? el('span', { class: 'badge' }, 'ACTIVE') : null
    );

  const groups = (['proxy', 'switch', 'rulelist', 'virtual'] as const).flatMap((kind) => {
    const items = config.profiles.filter((p) => p.kind === kind);
    return items.length
      ? [el('div', { class: 'section-label' }, KIND_LABEL[kind]), ...items.map(item)]
      : [];
  });

  return el(
    'aside',
    { class: 'side' },
    el(
      'div',
      { class: 'brand' },
      el('img', { class: 'mark', src: 'img/logo-mark.png', alt: '' }),
      el(
        'span',
        { class: 'brand-text' },
        el('span', { class: 'brand-name' }, 'Sockitt'),
        el('span', { class: 'brand-sub' }, 'Proxy Switcher')
      )
    ),
    el(
      'nav',
      { class: 'nav' },
      ...groups,
      el('div', { class: 'section-label' }, 'Extension'),
      el(
        'button',
        {
          class: `nav-item${selectedId === SETTINGS_ID ? ' selected' : ''}`,
          onclick: () => {
            selectedId = SETTINGS_ID;
            render();
          },
        },
        builtinTile('⚙', 22),
        el('span', { class: 'name' }, 'Settings')
      ),
      el(
        'button',
        {
          class: `nav-item${selectedId === DOCS_ID ? ' selected' : ''}`,
          onclick: () => {
            selectedId = DOCS_ID;
            render();
          },
        },
        builtinTile('?', 22),
        el('span', { class: 'name' }, 'Docs')
      ),
      el('div', { class: 'section-label' }, 'Create'),
      el('button', { class: 'btn create-btn primary', onclick: () => addProfile(newProxyProfile) }, 'New proxy'),
      el('button', { class: 'btn create-btn', onclick: () => addProfile(newSwitchProfile) }, 'New auto switch'),
      el('button', { class: 'btn create-btn', onclick: () => addProfile(newRuleListProfile) }, 'New rule list'),
      el('button', { class: 'btn create-btn', onclick: () => addProfile(newVirtualProfile) }, 'New alias')
    ),
    el(
      'div',
      { class: 'actions' },
      el(
        'div',
        { class: 'tools' },
        el('button', { class: 'btn ghost', onclick: exportConfig }, 'Export'),
        el('button', { class: 'btn ghost', onclick: importConfig }, 'Import'),
        el('button', { class: 'btn ghost danger', onclick: resetConfig }, 'Reset')
      )
    ),
    el(
      'div',
      { class: 'side-footer' },
      el(
        'a',
        {
          class: 'side-link ipcheck',
          href: 'https://ipconfig.is',
          target: '_blank',
          rel: 'noopener noreferrer',
          title: 'Open ipconfig.is in a new tab to check your current IP and location',
          innerHTML:
            '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></svg>',
        },
        el('span', {}, 'Check your IP')
      ),
      el(
        'a',
        {
          class: 'side-link',
          href: 'https://github.com/ptmplop/Sockitt',
          target: '_blank',
          rel: 'noopener noreferrer',
          innerHTML:
            '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>',
        },
        el('span', {}, 'View on GitHub')
      )
    )
  );
}

function addProfile(factory: (existing: Profile[]) => Profile): void {
  const profile = factory(config.profiles);
  config.profiles.push(profile);
  selectedId = profile.id;
  scheduleSave();
  render();
}

/* ---------- shared editor chrome ---------- */

function identityPanel(profile: Profile): HTMLElement {
  const preview = el('div', { class: 'id-preview' });
  const renderPreview = () => preview.replaceChildren(avatarEl(profile, 56));
  renderPreview();

  const name = el('input', {
    class: 'input',
    value: profile.name,
    spellcheck: false,
    oninput: () => {
      profile.name = name.value.trim() || 'Unnamed';
      initials.placeholder = initialsFor({ name: profile.name });
      scheduleSave();
      renderPreview();
      refreshSidebar();
    },
  }) as HTMLInputElement;

  const initials = el('input', {
    class: 'input',
    value: profile.initials ?? '',
    maxLength: 3,
    placeholder: initialsFor({ name: profile.name }),
    spellcheck: false,
    oninput: () => {
      const v = initials.value.trim();
      profile.initials = v ? v.slice(0, 3) : undefined;
      scheduleSave();
      renderPreview();
      refreshSidebar();
    },
  }) as HTMLInputElement;

  return el(
    'div',
    { class: 'card panel' },
    el('h3', {}, 'Identity'),
    el(
      'div',
      { class: 'id-row' },
      preview,
      el(
        'div',
        { class: 'id-fields' },
        el('div', { class: 'field' }, el('label', {}, 'Name'), name),
        el(
          'div',
          { class: 'field' },
          el('label', {}, 'Initials'),
          initials,
          el('span', { class: 'note' }, 'Toolbar icon text')
        ),
        el(
          'div',
          { class: 'field id-colors' },
          el('label', {}, 'Colour'),
          el(
            'div',
            { class: 'swatches' },
            ...PALETTE.map((color) =>
              el('button', {
                class: `swatch${profile.color === color ? ' selected' : ''}`,
                style: { background: color },
                title: color,
                onclick: () => {
                  profile.color = color;
                  scheduleSave();
                  render();
                },
              })
            )
          )
        )
      )
    )
  );
}

function dangerZone(profile: Profile): HTMLElement {
  return el(
    'div',
    { class: 'card panel danger-zone' },
    el('span', { class: 'muted' }, 'Remove this profile and any rules pointing at it.'),
    el(
      'button',
      {
        class: 'btn danger',
        onclick: () => {
          if (!confirmMaybe(`Delete “${profile.name}”?`)) return;
          config.profiles = config.profiles.filter((p) => p.id !== profile.id);
          for (const p of config.profiles) {
            switch (p.kind) {
              case 'switch':
                if (p.defaultTargetId === profile.id) p.defaultTargetId = DIRECT;
                for (const r of p.rules) if (r.targetId === profile.id) r.targetId = DIRECT;
                break;
              case 'virtual':
                if (p.targetId === profile.id) p.targetId = DIRECT;
                break;
              case 'rulelist':
                if (p.matchTargetId === profile.id) p.matchTargetId = DIRECT;
                if (p.defaultTargetId === profile.id) p.defaultTargetId = DIRECT;
                break;
              case 'proxy':
                break;
            }
          }
          config.settings.quickSwitchIds = config.settings.quickSwitchIds.filter(
            (id) => id !== profile.id
          );
          if (config.settings.startupProfileId === profile.id) config.settings.startupProfileId = '';
          if (config.activeId === profile.id) config.activeId = SYSTEM;
          selectedId = config.profiles[0]?.id ?? null;
          scheduleSave();
          render();
        },
      },
      'Delete profile'
    )
  );
}

/**
 * Routing-target selector. Offers Direct plus every profile that would not
 * create a cycle back to the profile being edited.
 */
function targetSelect(ownerId: string, value: string, onChange: (v: string) => void): HTMLSelectElement {
  const select = el('select', { class: 'input' }) as HTMLSelectElement;
  select.append(el('option', { value: DIRECT }, 'Direct'));
  for (const p of config.profiles) {
    if (p.id === ownerId) continue;
    if (reachableFrom(config, p.id).has(ownerId)) continue; // would cycle
    select.append(el('option', { value: p.id }, p.name));
  }
  select.value = [...select.options].some((o) => o.value === value) ? value : DIRECT;
  select.onchange = () => onChange(select.value);
  return select;
}

/* ---------- proxy editor ---------- */

const AUTH_PERMS: chrome.permissions.Permissions = {
  permissions: ['webRequest', 'webRequestAuthProvider'],
  origins: ['<all_urls>'],
};

async function requestAuthPermission(): Promise<boolean> {
  const has = await chrome.permissions.contains(AUTH_PERMS).catch(() => false);
  if (has) return true;
  const granted = await chrome.permissions.request(AUTH_PERMS).catch(() => false);
  toast(granted ? 'Authentication enabled' : 'Permission needed for proxy auth');
  return granted;
}

function proxyEditor(profile: ProxyProfile): HTMLElement {
  const schemeSel = el('select', { class: 'input' }) as HTMLSelectElement;
  for (const [value, label] of Object.entries(SCHEME_LABELS)) {
    schemeSel.append(el('option', { value }, label));
  }
  schemeSel.value = profile.scheme;
  schemeSel.onchange = () => {
    profile.scheme = schemeSel.value as ProxyScheme;
    if (!schemeSupportsAuth(profile.scheme)) {
      profile.username = undefined;
      profile.password = undefined;
    }
    scheduleSave();
    render();
  };

  const host = el('input', {
    class: 'input mono',
    value: profile.host,
    placeholder: '127.0.0.1',
    spellcheck: false,
    oninput: () => {
      profile.host = host.value.trim();
      scheduleSave();
    },
  }) as HTMLInputElement;

  const port = el('input', {
    class: 'input mono',
    value: String(profile.port),
    type: 'number',
    min: '1',
    max: '65535',
    oninput: () => {
      const n = Number(port.value);
      port.classList.toggle('invalid', !(Number.isInteger(n) && n >= 1 && n <= 65535));
      if (Number.isInteger(n) && n >= 1 && n <= 65535) {
        profile.port = n;
        scheduleSave();
      }
    },
  }) as HTMLInputElement;

  const bypass = el('textarea', {
    class: 'input mono',
    value: profile.bypass.join('\n'),
    placeholder: '<local>\n*.internal.example\n10.0.0.0/8',
    spellcheck: false,
    oninput: () => {
      profile.bypass = bypass.value.split('\n').map((s) => s.trim()).filter(Boolean);
      scheduleSave();
    },
  }) as HTMLTextAreaElement;

  const authPanel = schemeSupportsAuth(profile.scheme)
    ? authSection(profile)
    : el('div', { class: 'field' }, el('span', { class: 'note' },
        'Chromium cannot authenticate SOCKS proxies - secure the proxy by IP allow-list or a local tunnel (e.g. ssh -D).'));

  return el(
    'div',
    { class: 'pane' },
    identityPanel(profile),
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Proxy server'),
      el(
        'div',
        { class: 'field-grid trio' },
        el('div', { class: 'field' }, el('label', {}, 'Protocol'), schemeSel),
        el('div', { class: 'field' }, el('label', {}, 'Host'), host),
        el('div', { class: 'field' }, el('label', {}, 'Port'), port)
      ),
      authPanel
    ),
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Bypass list'),
      el(
        'div',
        { class: 'field' },
        el('label', {}, 'One entry per line - these hosts connect directly'),
        bypass,
        el('span', { class: 'note' }, '<local> matches plain hostnames and localhost. Also accepts *.suffix wildcards and IPv4 CIDR blocks.')
      )
    ),
    dangerZone(profile)
  );
}

function authSection(profile: ProxyProfile): HTMLElement {
  const username = el('input', {
    class: 'input',
    value: profile.username ?? '',
    placeholder: 'username (optional)',
    autocomplete: 'off',
    spellcheck: false,
    onchange: () => {
      profile.username = username.value.trim() || undefined;
      scheduleSave();
      if (profile.username) void requestAuthPermission();
    },
  }) as HTMLInputElement;

  const password = el('input', {
    class: 'input',
    type: 'password',
    value: profile.password ?? '',
    placeholder: 'password',
    autocomplete: 'off',
    onchange: () => {
      profile.password = password.value || undefined;
      scheduleSave();
      if (profile.username) void requestAuthPermission();
    },
  }) as HTMLInputElement;

  return el(
    'div',
    { class: 'field' },
    el('label', {}, 'Authentication'),
    el(
      'div',
      { class: 'field-grid' },
      el('div', { class: 'field' }, username),
      el('div', { class: 'field' }, password)
    ),
    el(
      'span',
      { class: 'note' },
      'Credentials are used only for HTTP/HTTPS proxies. Answering proxy auth needs an optional permission (webRequest + all sites); Sockitt asks for it when you set a username.'
    ),
    el(
      'button',
      {
        class: 'btn',
        style: { alignSelf: 'flex-start' },
        onclick: () => void requestAuthPermission(),
      },
      'Enable authentication'
    )
  );
}

/* ---------- switch editor ---------- */

function switchEditor(profile: SwitchProfile): HTMLElement {
  const rulesBox = el('div', { class: 'rules' });

  const ruleRow = (rule: SwitchProfile['rules'][number]): HTMLElement => {
    const typeSel = el('select', { class: 'input' }) as HTMLSelectElement;
    for (const [value, label] of Object.entries(RULE_TYPES)) {
      typeSel.append(el('option', { value }, label));
    }
    typeSel.value = rule.type;

    const pattern = el('input', {
      class: 'input mono',
      value: rule.pattern,
      placeholder: placeholderFor(rule.type),
      spellcheck: false,
    }) as HTMLInputElement;

    const markValidity = () => {
      const err = patternError(rule);
      pattern.classList.toggle('invalid', !!err);
      pattern.title = err ?? '';
    };
    markValidity();

    typeSel.onchange = () => {
      rule.type = typeSel.value as RuleType;
      pattern.placeholder = placeholderFor(rule.type);
      markValidity();
      scheduleSave();
    };
    pattern.oninput = () => {
      rule.pattern = pattern.value;
      markValidity();
      scheduleSave();
    };

    const enabled = el('input', {
      class: 'toggle',
      type: 'checkbox',
      checked: rule.enabled,
      onchange: () => {
        rule.enabled = enabled.checked;
        row.classList.toggle('disabled', !rule.enabled);
        scheduleSave();
      },
    }) as HTMLInputElement;

    const row = el(
      'div',
      { class: `rule${rule.enabled ? '' : ' disabled'}`, dataset: { id: rule.id } },
      el('span', { class: 'grip', title: 'Drag to reorder', draggable: true }, '⋮⋮'),
      typeSel,
      pattern,
      targetSelect(profile.id, rule.targetId, (v) => {
        rule.targetId = v;
        scheduleSave();
      }),
      enabled,
      el('button', {
        class: 'btn ghost icon',
        title: 'Delete rule',
        innerHTML: '✕',
        onclick: () => {
          profile.rules = profile.rules.filter((r) => r.id !== rule.id);
          scheduleSave();
          render();
        },
      })
    );
    wireDrag(row, rulesBox, () => {
      const order = [...rulesBox.querySelectorAll<HTMLElement>('.rule')].map((n) => n.dataset.id);
      profile.rules.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      scheduleSave();
    });
    return row;
  };

  rulesBox.append(
    el('div', { class: 'rule-head' },
      el('span'), el('span', {}, 'Condition'), el('span', {}, 'Pattern'),
      el('span', {}, 'Route via'), el('span', {}, 'On'), el('span')),
    ...profile.rules.map(ruleRow)
  );

  return el(
    'div',
    { class: 'pane' },
    identityPanel(profile),
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Rules - first match wins'),
      rulesBox,
      el(
        'button',
        {
          class: 'btn',
          style: { alignSelf: 'flex-start' },
          onclick: () => {
            profile.rules.push({
              id: uid(),
              enabled: true,
              type: 'hostWildcard',
              pattern: '',
              targetId: proxyProfiles(config)[0]?.id ?? DIRECT,
            });
            scheduleSave();
            render();
          },
        },
        '+ Add rule'
      ),
      el(
        'div',
        { class: 'default-row' },
        el('label', {}, 'Everything else'),
        targetSelect(profile.id, profile.defaultTargetId, (v) => {
          profile.defaultTargetId = v;
          scheduleSave();
        })
      )
    ),
    dangerZone(profile)
  );
}

function placeholderFor(type: RuleType): string {
  switch (type) {
    case 'hostWildcard': return '*.example.com';
    case 'hostRegex': return '(^|\\.)example\\.(com|net)$';
    case 'urlWildcard': return 'https://example.com/api/*';
    case 'urlRegex': return '^https?://example\\.com/';
    case 'ipCidr': return '10.0.0.0/8';
    case 'keyword': return 'tracker';
    case 'hostLevels': return '2-4';
    case 'weekday': return 'mon-fri';
    case 'time': return '09:00-17:30';
  }
}

/* ---------- rule list editor ---------- */

function ruleListEditor(profile: RuleListProfile): HTMLElement {
  const parsed = parseRuleList(profile.format, profile.text);

  const url = el('input', {
    class: 'input mono',
    value: profile.url,
    placeholder: 'https://example.com/gfwlist.txt',
    spellcheck: false,
    oninput: () => {
      profile.url = url.value.trim();
      scheduleSave();
    },
  }) as HTMLInputElement;

  const format = el('select', { class: 'input' }) as HTMLSelectElement;
  format.append(
    el('option', { value: 'autoproxy' }, 'AutoProxy / GFWList'),
    el('option', { value: 'switchy' }, 'Switchy (one pattern per line)')
  );
  format.value = profile.format;
  format.onchange = () => {
    profile.format = format.value as RuleListProfile['format'];
    scheduleSave();
    render();
  };

  const interval = el('input', {
    class: 'input mono',
    type: 'number',
    min: '0',
    max: '720',
    value: String(profile.updateIntervalH),
    oninput: () => {
      const n = Number(interval.value);
      if (Number.isFinite(n) && n >= 0 && n <= 720) {
        profile.updateIntervalH = n;
        scheduleSave();
      }
    },
  }) as HTMLInputElement;

  const source = el('textarea', {
    class: 'input mono rl-source',
    value: profile.text,
    placeholder: '! Paste list content here, or set a URL and press Update now.\n||example.com\n@@||allowed.example.com',
    spellcheck: false,
    oninput: () => {
      profile.text = source.value;
      scheduleSave();
    },
  }) as HTMLTextAreaElement;

  const status = el(
    'span',
    { class: 'note' },
    `${parsed.count} entr${parsed.count === 1 ? 'y' : 'ies'} parsed` +
      (profile.lastUpdated ? ` · updated ${new Date(profile.lastUpdated).toLocaleString()}` : '')
  );

  const updateNow = el(
    'button',
    {
      class: 'btn',
      onclick: async () => {
        if (!profile.url) {
          toast('Set a URL first');
          return;
    }
        updateNow.textContent = 'Updating…';
        (updateNow as HTMLButtonElement).disabled = true;
        try {
          const response = await fetch(profile.url, { cache: 'no-cache' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const text = await response.text();
          if (!text.trim()) throw new Error('Empty response');
          profile.text = text;
          profile.lastUpdated = Date.now();
          await saveConfig(config);
          toast('List updated');
          render();
        } catch (e) {
          toast(`Update failed: ${e instanceof Error ? e.message : e}`);
          updateNow.textContent = 'Update now';
          (updateNow as HTMLButtonElement).disabled = false;
        }
      },
    },
    'Update now'
  );

  return el(
    'div',
    { class: 'pane' },
    identityPanel(profile),
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Source'),
      el(
        'div',
        { class: 'field-grid' },
        el('div', { class: 'field' }, el('label', {}, 'URL'), url),
        el('div', { class: 'field' }, el('label', {}, 'Auto-update (hours, 0 = off)'), interval)
      ),
      el(
        'div',
        { class: 'rl-actions' },
        el('div', { class: 'field', style: { flex: '1' } }, el('label', {}, 'Format'), format),
        updateNow
      ),
      el('div', { class: 'field' }, el('label', {}, 'List content'), source, status),
      el('span', { class: 'note' },
        'The URL host must allow cross-origin requests (raw.githubusercontent.com does). GFWList base64 payloads are decoded automatically.')
    ),
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Routing'),
      el(
        'div',
        { class: 'field-grid wide' },
        el('div', { class: 'field' }, el('label', {}, 'Matching entries route via'),
          targetSelect(profile.id, profile.matchTargetId, (v) => {
            profile.matchTargetId = v;
            scheduleSave();
          })),
        el('div', { class: 'field' }, el('label', {}, 'Everything else (and whitelist)'),
          targetSelect(profile.id, profile.defaultTargetId, (v) => {
            profile.defaultTargetId = v;
            scheduleSave();
          }))
      )
    ),
    dangerZone(profile)
  );
}

/* ---------- virtual (alias) editor ---------- */

function virtualEditor(profile: VirtualProfile): HTMLElement {
  return el(
    'div',
    { class: 'pane' },
    identityPanel(profile),
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Alias target'),
      el(
        'div',
        { class: 'field' },
        el('label', {}, 'Activating or targeting this alias routes via'),
        targetSelect(profile.id, profile.targetId, (v) => {
          profile.targetId = v;
          scheduleSave();
        }),
        el('span', { class: 'note' },
          'Point switch rules and rule lists at an alias, then swap the alias target to retarget them all at once.')
      )
    ),
    dangerZone(profile)
  );
}

/* ---------- settings panel ---------- */

function toggleRow(
  label: string,
  description: string,
  checked: boolean,
  onChange: (v: boolean) => void | Promise<boolean | void>
): HTMLElement {
  const input = el('input', {
    class: 'toggle',
    type: 'checkbox',
    checked,
    onchange: async () => {
      const result = await onChange(input.checked);
      if (result === false) input.checked = !input.checked; // rejected (e.g. permission denied)
      scheduleSave();
      refreshSidebar();
    },
  }) as HTMLInputElement;
  return el(
    'label',
    { class: 'setting-row' },
    el(
      'span',
      { class: 'setting-text' },
      el('span', { class: 'setting-label' }, label),
      el('span', { class: 'note' }, description)
    ),
    input
  );
}

function settingsPanel(): HTMLElement {
  const s = config.settings;

  const quickList = el(
    'div',
    { class: 'quick-list' },
    ...[
      { id: DIRECT, name: 'Direct' },
      { id: SYSTEM, name: 'System' },
      ...config.profiles.map((p) => ({ id: p.id, name: p.name })),
    ].map((entry) => {
      const check = el('input', {
        type: 'checkbox',
        checked: s.quickSwitchIds.includes(entry.id),
        onchange: () => {
          s.quickSwitchIds = check.checked
            ? [...s.quickSwitchIds, entry.id]
            : s.quickSwitchIds.filter((id) => id !== entry.id);
          scheduleSave();
        },
      }) as HTMLInputElement;
      return el('label', { class: 'quick-item' }, check, entry.name);
    })
  );

  const startup = el('select', { class: 'input' }) as HTMLSelectElement;
  startup.append(
    el('option', { value: '' }, 'Last used (default)'),
    el('option', { value: DIRECT }, 'Direct'),
    el('option', { value: SYSTEM }, 'System')
  );
  for (const p of config.profiles) startup.append(el('option', { value: p.id }, p.name));
  startup.value = s.startupProfileId;
  startup.onchange = () => {
    s.startupProfileId = startup.value;
    scheduleSave();
  };

  return el(
    'div',
    { class: 'pane' },
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Switching'),
      toggleRow(
        'Quick switch',
        'Toolbar click cycles the profiles below instead of opening the popup. The cycle keyboard shortcut always works (set it at chrome://extensions/shortcuts).',
        s.quickSwitch,
        (v) => {
          s.quickSwitch = v;
        }
      ),
      quickList,
      el(
        'div',
        { class: 'field', style: { maxWidth: '280px' } },
        el('label', {}, 'On browser startup, activate'),
        startup
      ),
      toggleRow(
        'Reload tab after switching',
        'Refresh the active tab whenever you pick a profile in the popup.',
        s.refreshOnSwitch,
        (v) => {
          s.refreshOnSwitch = v;
        }
      )
    ),
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Behaviour'),
      toggleRow(
        'Guard proxy control',
        'If another extension takes over proxy settings, take them back automatically (at most every 30 s).',
        s.revertExternal,
        (v) => {
          s.revertExternal = v;
        }
      ),
      toggleRow(
        'Per-tab route badge',
        'Show which profile the current tab routes through as a toolbar badge. Requires the optional "tabs" permission.',
        s.badgeResult,
        async (v) => {
          if (!v) {
            s.badgeResult = false;
            return;
          }
          const granted = await chrome.permissions
            .request({ permissions: ['tabs'] })
            .catch(() => false);
          if (!granted) {
            toast('Permission declined');
            return false;
          }
          s.badgeResult = true;
        }
      ),
      toggleRow(
        'Quick-added rules go to the bottom',
        'Rules added from the popup append below existing rules (off = they take top priority).',
        s.addToBottom,
        (v) => {
          s.addToBottom = v;
        }
      ),
      toggleRow(
        'Confirm before deleting',
        'Ask before profiles are deleted or everything is reset.',
        s.confirmDeletion,
        (v) => {
          s.confirmDeletion = v;
        }
      )
    ),
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Sync'),
      syncError ? el('div', { class: 'banner' }, `Sync error: ${syncError}`) : null,
      toggleRow(
        'Sync configuration',
        'Mirror profiles and rules to your browser account (chrome.storage.sync) so other machines pick them up. Newest change wins. Large rule-list bodies are not synced - set a URL so each machine can refresh its own copy.',
        s.syncEnabled,
        async (v) => {
          if (!v) {
            s.syncEnabled = false;
            void clearSync();
            return;
          }
          // Joining: adopt an existing synced config instead of overwriting it
          // with this machine's (so enabling sync on a fresh install can't wipe
          // the group). pullFromSync(-1) returns any present remote.
          const remote = await pullFromSync(-1);
          if (remote) {
            const localText = new Map(
              config.profiles
                .filter((p) => p.kind === 'rulelist' && p.text)
                .map((p) => [p.id, (p as { text: string }).text])
            );
            for (const p of remote.profiles) {
              if (p.kind === 'rulelist' && !p.text && localText.has(p.id)) {
                p.text = localText.get(p.id)!;
              }
            }
            remote.settings.syncEnabled = true;
            config = remote;
            selectedId = SETTINGS_ID;
            await saveConfig(config);
            toast('Adopted synced configuration');
            render();
            return;
          }
          s.syncEnabled = true;
        }
      )
    )
  );
}

/* ---------- drag reorder ---------- */

function wireDrag(row: HTMLElement, container: HTMLElement, commit: () => void): void {
  const grip = row.querySelector<HTMLElement>('.grip')!;
  grip.addEventListener('dragstart', (e) => {
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setDragImage(row, 20, 20);
    row.classList.add('dragging');
  });
  grip.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    commit();
  });
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    const dragging = container.querySelector<HTMLElement>('.rule.dragging');
    if (!dragging || dragging === row) return;
    const rect = row.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    container.insertBefore(dragging, before ? row : row.nextSibling);
  });
  container.addEventListener('drop', (e) => e.preventDefault());
}

/* ---------- import / export / reset ---------- */

function exportConfig(): void {
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const a = el('a', {
    href: URL.createObjectURL(blob),
    download: `sockitt-backup-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Exported');
}

function importConfig(): void {
  const input = el('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const parsed = sanitizeConfig(JSON.parse(await file.text()));
      if (!parsed) throw new Error('not a Sockitt backup');
      config = parsed;
      selectedId = config.profiles[0]?.id ?? null;
      await saveConfig(config);
      toast('Imported');
      render();
    } catch (e) {
      alert(`Import failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  input.click();
}

function resetConfig(): void {
  if (!confirmMaybe('Delete all profiles and rules?')) return;
  config = {
    version: 2,
    rev: config.rev,
    activeId: SYSTEM,
    profiles: [],
    settings: { ...config.settings, quickSwitchIds: [], startupProfileId: '' },
  };
  selectedId = null;
  void saveConfig(config);
  render();
}

/* ---------- render ---------- */

function emptyPane(): HTMLElement {
  return el(
    'div',
    { class: 'card hero' },
    el('img', { class: 'mark hero-mark', src: 'img/logo-mark.png', alt: '' }),
    el('h2', {}, 'Route traffic your way'),
    el('p', {}, 'Create a SOCKS5 proxy profile, then add an Auto Switch profile to route sites by rule - host wildcards, regex, CIDR blocks, keywords, or time windows.'),
    el(
      'div',
      { class: 'cta' },
      el('button', { class: 'btn primary', onclick: () => addProfile(newProxyProfile) }, 'Create a proxy'),
      el('button', { class: 'btn', onclick: () => addProfile(newSwitchProfile) }, 'Create auto switch')
    )
  );
}

let sideNode: HTMLElement;

function refreshSidebar(): void {
  const fresh = sidebar();
  sideNode.replaceWith(fresh);
  sideNode = fresh;
}

function editorFor(profile: Profile): HTMLElement {
  switch (profile.kind) {
    case 'proxy': return proxyEditor(profile);
    case 'switch': return switchEditor(profile);
    case 'rulelist': return ruleListEditor(profile);
    case 'virtual': return virtualEditor(profile);
  }
}

function render(): void {
  const profile = selected();
  sideNode = sidebar();
  const content =
    selectedId === DOCS_ID
      ? docsPanel()
      : selectedId === SETTINGS_ID
        ? settingsPanel()
        : profile
          ? editorFor(profile)
          : emptyPane();
  app.replaceChildren(
    el('div', { class: 'layout' }, sideNode, el('div', { class: 'content' }, content))
  );
}

/**
 * Adopt config written by the background (rule-list auto-update, quick-switch
 * cycle, or a sync pull) so the page's long-lived snapshot can't silently
 * revert those writes on the next edit. Skipped while the user has an edit
 * pending (their in-progress change wins, last-write-wins as everywhere else).
 */
onConfigChanged((incoming) => {
  if (savePending || incoming.rev === config.rev) return;
  config = incoming;
  if (selectedId && selectedId !== SETTINGS_ID && !config.profiles.some((p) => p.id === selectedId)) {
    selectedId = config.profiles[0]?.id ?? null;
  }
  render();
});

function watchSyncError(): void {
  void chrome.storage.session.get(SYNC_ERROR_KEY).then((s) => {
    const err = (s as Record<string, { message: string }>)[SYNC_ERROR_KEY];
    if (err?.message && err.message !== syncError) {
      syncError = err.message;
      if (selectedId === SETTINGS_ID) render();
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes[SYNC_ERROR_KEY]) return;
    const next = changes[SYNC_ERROR_KEY].newValue as { message: string } | undefined;
    syncError = next?.message ?? null;
    if (selectedId === SETTINGS_ID) render();
  });
}

void loadConfig().then((c) => {
  config = c;
  selectedId = config.profiles[0]?.id ?? null;
  watchSyncError();
  render();
});
