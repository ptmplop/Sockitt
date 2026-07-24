import { avatarEl, initialsFor } from '../shared/avatar';
import { patternError } from '../shared/match';
import {
  loadConfig,
  newProxyProfile,
  newSwitchProfile,
  sanitizeConfig,
  saveConfig,
} from '../shared/state';
import {
  Config,
  DIRECT,
  PALETTE,
  Profile,
  ProxyProfile,
  RuleType,
  SwitchProfile,
  proxyProfiles,
  switchProfiles,
  uid,
} from '../shared/types';
import { el, toast } from '../shared/ui';

const app = document.getElementById('app')!;

let config: Config;
let selectedId: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const RULE_TYPES: Record<RuleType, string> = {
  hostWildcard: 'Host wildcard',
  hostRegex: 'Host regex',
  urlWildcard: 'URL wildcard',
  urlRegex: 'URL regex',
  ipCidr: 'IP / CIDR',
};

function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveConfig(config).then(() => toast('Saved'));
  }, 300);
}

function selected(): Profile | null {
  return config.profiles.find((p) => p.id === selectedId) ?? null;
}

/* ---------- sidebar ---------- */

function sidebar(): HTMLElement {
  const proxies = proxyProfiles(config);
  const switches = switchProfiles(config);

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

  return el(
    'aside',
    { class: 'side' },
    el('div', { class: 'brand' }, el('img', { class: 'mark', src: 'img/icon-48.png', alt: '' }), 'Sockitt', el('small', {}, 'SOCKS5 switcher')),
    el(
      'nav',
      { class: 'nav' },
      proxies.length ? el('div', { class: 'section-label' }, 'Proxies') : null,
      ...proxies.map(item),
      switches.length ? el('div', { class: 'section-label' }, 'Auto switch') : null,
      ...switches.map(item)
    ),
    el(
      'div',
      { class: 'actions' },
      el('button', { class: 'btn primary', onclick: () => addProfile('proxy') }, '+ New proxy'),
      el('button', { class: 'btn', onclick: () => addProfile('switch') }, '+ New auto switch'),
      el(
        'div',
        { class: 'tools' },
        el('button', { class: 'btn ghost', onclick: exportConfig }, 'Export'),
        el('button', { class: 'btn ghost', onclick: importConfig }, 'Import'),
        el('button', { class: 'btn ghost danger', onclick: resetConfig }, 'Reset')
      )
    )
  );
}

function addProfile(kind: 'proxy' | 'switch'): void {
  const profile = kind === 'proxy' ? newProxyProfile(config.profiles) : newSwitchProfile(config.profiles);
  config.profiles.push(profile);
  selectedId = profile.id;
  scheduleSave();
  render();
}

/* ---------- shared editor chrome ---------- */

/**
 * Identity panel: avatar preview, name, custom initials, colour. The avatar
 * (DiceBear-initials style) is also what the toolbar icon shows while this
 * profile is active.
 */
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
          el('span', { class: 'note' }, 'Shown on the toolbar icon')
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
          if (!confirm(`Delete “${profile.name}”?`)) return;
          config.profiles = config.profiles.filter((p) => p.id !== profile.id);
          for (const s of switchProfiles(config)) {
            if (s.defaultTargetId === profile.id) s.defaultTargetId = DIRECT;
            for (const r of s.rules) if (r.targetId === profile.id) r.targetId = DIRECT;
          }
          if (config.activeId === profile.id) config.activeId = 'system';
          selectedId = config.profiles[0]?.id ?? null;
          scheduleSave();
          render();
        },
      },
      'Delete profile'
    )
  );
}

/* ---------- proxy editor ---------- */

function proxyEditor(profile: ProxyProfile): HTMLElement {
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

  return el(
    'div',
    { class: 'pane' },
    identityPanel(profile),
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'SOCKS5 server'),
      el(
        'div',
        { class: 'field-grid' },
        el('div', { class: 'field' }, el('label', {}, 'Host'), host),
        el('div', { class: 'field' }, el('label', {}, 'Port'), port)
      ),
      el(
        'div',
        { class: 'field' },
        el('span', { class: 'note' },
          'Chromium does not support SOCKS5 authentication — secure the proxy by IP allow-list or a local tunnel (e.g. ssh -D).')
      )
    ),
    el(
      'div',
      { class: 'card panel' },
      el('h3', {}, 'Bypass list'),
      el(
        'div',
        { class: 'field' },
        el('label', {}, 'One entry per line — these hosts connect directly'),
        bypass,
        el('span', { class: 'note' }, '<local> matches plain hostnames and localhost. Also accepts *.suffix wildcards and IPv4 CIDR blocks.')
      )
    ),
    dangerZone(profile)
  );
}

/* ---------- switch editor ---------- */

function targetSelect(value: string, onChange: (v: string) => void): HTMLSelectElement {
  const select = el('select', { class: 'input' }) as HTMLSelectElement;
  select.append(el('option', { value: DIRECT }, 'Direct'));
  for (const p of proxyProfiles(config)) select.append(el('option', { value: p.id }, p.name));
  select.value = value === DIRECT || proxyProfiles(config).some((p) => p.id === value) ? value : DIRECT;
  select.onchange = () => onChange(select.value);
  return select;
}

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
      targetSelect(rule.targetId, (v) => {
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
      el('h3', {}, 'Rules — first match wins'),
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
        targetSelect(profile.defaultTargetId, (v) => {
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
  }
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
  if (!confirm('Delete all profiles and rules?')) return;
  config = { version: 1, activeId: 'system', profiles: [] };
  selectedId = null;
  void saveConfig(config);
  render();
}

/* ---------- render ---------- */

function emptyPane(): HTMLElement {
  return el(
    'div',
    { class: 'card hero' },
    el('img', { class: 'mark hero-mark', src: 'img/icon-128.png', alt: '' }),
    el('h2', {}, 'Route traffic your way'),
    el('p', {}, 'Create a SOCKS5 proxy profile, then add an Auto Switch profile to route sites by rule — host wildcards, regex, or CIDR blocks.'),
    el(
      'div',
      { class: 'cta' },
      el('button', { class: 'btn primary', onclick: () => addProfile('proxy') }, 'Create a proxy'),
      el('button', { class: 'btn', onclick: () => addProfile('switch') }, 'Create auto switch')
    )
  );
}

let sideNode: HTMLElement;

function refreshSidebar(): void {
  const fresh = sidebar();
  sideNode.replaceWith(fresh);
  sideNode = fresh;
}

function render(): void {
  const profile = selected();
  sideNode = sidebar();
  app.replaceChildren(
    el(
      'div',
      { class: 'layout' },
      sideNode,
      profile
        ? profile.kind === 'proxy'
          ? proxyEditor(profile)
          : switchEditor(profile)
        : emptyPane()
    )
  );
}

void loadConfig().then((c) => {
  config = c;
  selectedId = config.profiles[0]?.id ?? null;
  render();
});
