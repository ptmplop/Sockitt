import { compileBypassEntry, compileRule, CompiledCondition } from './match';
import { Config, DIRECT, SwitchProfile, profileById } from './types';

/**
 * Compile a switch profile into a PAC script.
 *
 * The output is deliberately ES5-flavoured (Chrome's PAC sandbox) and shaped
 * for per-request speed: every regex is built once at the top level, `*.host`
 * wildcards become suffix string compares, and CIDR rules become one integer
 * mask test against a host IP parsed at most once per request.
 */
export function compilePac(config: Config, profile: SwitchProfile): string {
  const regexes: string[] = [];
  let needsIp = false;

  const regexRef = (source: string): string => {
    let i = regexes.indexOf(source);
    if (i === -1) i = regexes.push(source) - 1;
    return `R[${i}]`;
  };

  const emit = (c: CompiledCondition): string => {
    switch (c.op) {
      case 'suffix':
        return `(h===${JSON.stringify(c.alsoBare)}||E(h,${JSON.stringify(c.suffix)}))`;
      case 'hostEq':
        return `h===${JSON.stringify(c.host)}`;
      case 'hostRegex':
        return `${regexRef(c.source)}.test(h)`;
      case 'urlRegex':
        return `${regexRef(c.source)}.test(url)`;
      case 'cidr':
        needsIp = true;
        return `(ip>=0&&((ip&${c.mask | 0})>>>0)===${c.base})`;
      case 'local':
        return `(h==="localhost"||h==="127.0.0.1"||h==="[::1]"||h.indexOf(".")<0)`;
      case 'never':
        return 'false';
    }
  };

  // One return function per distinct proxy target so bypass lists are shared.
  const targetFns = new Map<string, string>(); // targetId -> fn name
  const targetBodies: string[] = [];

  const targetExpr = (targetId: string): string => {
    const target = profileById(config, targetId);
    if (!target || target.kind !== 'proxy') return 'return "DIRECT";';
    let fn = targetFns.get(target.id);
    if (!fn) {
      fn = `T${targetFns.size}`;
      targetFns.set(target.id, fn);
      const proxy = JSON.stringify(`SOCKS5 ${target.host}:${target.port}`);
      const bypass = target.bypass
        .map((entry) => compileBypassEntry(entry))
        .filter((c) => c.op !== 'never')
        .map((c) => `if(${emit(c)})return "DIRECT";`)
        .join('');
      targetBodies.push(`function ${fn}(url,h,ip){${bypass}return ${proxy};}`);
    }
    return `return ${fn}(url,h,ip);`;
  };

  const branches: string[] = [];
  for (const rule of profile.rules) {
    if (!rule.enabled) continue;
    const cond = compileRule(rule);
    if (cond.op === 'never') continue;
    branches.push(`if(${emit(cond)})${targetExpr(rule.targetId)}`);
  }
  const fallback = targetExpr(profile.defaultTargetId);

  const lines = [
    `/* Sockitt auto-switch: ${profile.name.replace(/\*\//g, '')} */`,
    `var R=[${regexes.map((s) => `new RegExp(${JSON.stringify(s)})`).join(',')}];`,
    `function E(h,s){var d=h.length-s.length;return d>=0&&h.lastIndexOf(s)===d;}`,
  ];
  if (needsIp) {
    lines.push(
      'function A(h){var m=/^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$/.exec(h);' +
        'if(!m)return -1;var r=0;for(var i=1;i<5;i++){var o=+m[i];if(o>255)return -1;r=((r<<8)|o)>>>0;}return r;}'
    );
  }
  lines.push(...targetBodies);
  lines.push(
    'function FindProxyForURL(url,host){' +
      'var h=host.toLowerCase();' +
      (needsIp ? 'var ip=A(h);' : 'var ip=-1;') +
      branches.join('') +
      fallback +
      '}'
  );
  return lines.join('\n');
}

/** Fixed-servers value for a plain SOCKS5 profile (non-PAC path). */
export function fixedServersValue(host: string, port: number, bypass: string[]) {
  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy: { scheme: 'socks5', host, port },
      bypassList: bypass.filter((b) => b.trim().length > 0),
    },
  } as const;
}

export { DIRECT };
