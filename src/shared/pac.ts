import { compileBypassEntry, compileRule, CompiledCondition } from './match';
import { parseRuleList } from './rulelist';
import { Config, DIRECT, Profile, ProxyProfile, ProxyScheme, SwitchRule, profileById } from './types';

/** The PAC return token for a proxy scheme (PAC uses its own directive names). */
export function pacDirective(scheme: ProxyScheme, host: string, port: number): string {
  const addr = `${host}:${port}`;
  switch (scheme) {
    case 'socks5': return `SOCKS5 ${addr}`;
    case 'socks4': return `SOCKS ${addr}`;
    case 'http': return `PROXY ${addr}`;
    case 'https': return `HTTPS ${addr}`;
  }
}

/**
 * Compile the profile graph rooted at `root` into a PAC script.
 *
 * Output is ES5-flavoured (Chrome's PAC sandbox) and shaped for per-request
 * speed: regexes are built once at the top level, `*.host` wildcards become
 * suffix string compares, CIDR rules become one integer mask test, rule-list
 * domains become a dictionary walked label-by-label, and per-request values
 * (host IP, host level count, weekday, minutes) are computed at most once and
 * only when some reachable condition needs them.
 *
 * Each reachable profile compiles to one function; switch/virtual/rulelist
 * targets call each other, cycles fall back to DIRECT.
 */
/** Prefix for rule-list dictionary keys — see emitBuckets. */
const DK = '$';

export function compilePac(config: Config, root: Profile, tempRules: SwitchRule[] = []): string {
  const regexes: string[] = [];
  const tables: string[] = []; // dict/array literals for rule-list buckets
  const bodies: string[] = [];
  const fnByProfile = new Map<string, string>();
  const emitting = new Set<string>();
  const need = { ip: false, lv: false, date: false, endsWith: false, suffixWalk: false, loops: false };

  const J = (s: string): string => JSON.stringify(s);
  const regexLiteral = (source: string): string => `new RegExp(${JSON.stringify(source)})`;

  const regexRef = (source: string): string => {
    let i = regexes.indexOf(source);
    if (i === -1) i = regexes.push(source) - 1;
    return `R[${i}]`;
  };

  const tableRef = (literal: string): string => {
    const name = `T${tables.length}`;
    tables.push(`var ${name}=${literal};`);
    return name;
  };

  const emitCond = (c: CompiledCondition): string => {
    switch (c.op) {
      case 'suffix':
        need.endsWith = true;
        return `(h===${JSON.stringify(c.alsoBare)}||E(h,${JSON.stringify(c.suffix)}))`;
      case 'hostEq':
        return `h===${JSON.stringify(c.host)}`;
      case 'hostRegex':
        return `${regexRef(c.source)}.test(h)`;
      case 'urlRegex':
        return `${regexRef(c.source)}.test(url)`;
      case 'urlKeyword':
        return `url.indexOf(${JSON.stringify(c.text)})>=0`;
      case 'cidr':
        need.ip = true;
        return `(ip>=0&&((ip&${c.mask | 0})>>>0)===${c.base})`;
      case 'hostLevels':
        need.lv = true;
        return c.min === c.max ? `lv===${c.min}` : `(lv>=${c.min}&&lv<=${c.max})`;
      case 'weekday':
        need.date = true;
        return `(wd&${c.mask})!==0`;
      case 'time':
        need.date = true;
        return c.from <= c.to
          ? `(mins>=${c.from}&&mins<=${c.to})`
          : `(mins>=${c.from}||mins<=${c.to})`;
      case 'local':
        return `(h==="localhost"||h==="127.0.0.1"||h==="[::1]"||h.indexOf(".")<0)`;
      case 'never':
        return 'false';
    }
  };

  /** Expression that routes to `targetId` (a call, or the DIRECT literal). */
  const targetExpr = (targetId: string): string => {
    if (targetId === DIRECT) return '"DIRECT"';
    const target = profileById(config, targetId);
    if (!target || emitting.has(target.id)) return '"DIRECT"'; // missing or cycle
    if (target.kind === 'virtual') {
      emitting.add(target.id);
      const expr = targetExpr(target.targetId);
      emitting.delete(target.id);
      return expr;
    }
    return `${fnFor(target)}(url,h)`;
  };

  const fnFor = (profile: Profile): string => {
    const existing = fnByProfile.get(profile.id);
    if (existing) return existing;
    const fn = `P${fnByProfile.size}`;
    fnByProfile.set(profile.id, fn);
    emitting.add(profile.id);
    bodies.push(`function ${fn}(url,h){${emitBody(profile)}}`);
    emitting.delete(profile.id);
    return fn;
  };

  const emitBody = (profile: Profile): string => {
    switch (profile.kind) {
      case 'proxy': {
        const proxy = JSON.stringify(pacDirective(profile.scheme, profile.host, profile.port));
        const bypass = profile.bypass
          .map((entry) => compileBypassEntry(entry))
          .filter((c) => c.op !== 'never')
          .map((c) => `if(${emitCond(c)})return "DIRECT";`)
          .join('');
        return `${bypass}return ${proxy};`;
      }
      case 'virtual':
        return `return ${targetExpr(profile.targetId)};`;
      case 'switch': {
        const rules =
          profile.id === root.id ? [...tempRules, ...profile.rules] : profile.rules;
        let out = '';
        for (const rule of rules) {
          if (!rule.enabled) continue;
          const cond = compileRule(rule);
          if (cond.op === 'never') continue;
          out += `if(${emitCond(cond)})return ${targetExpr(rule.targetId)};`;
        }
        return out + `return ${targetExpr(profile.defaultTargetId)};`;
      }
      case 'rulelist': {
        const parsed = parseRuleList(profile.format, profile.text);
        const defaultExpr = targetExpr(profile.defaultTargetId);
        const matchExpr = targetExpr(profile.matchTargetId);
        let out = '';
        const white = emitBuckets(parsed.whitelist);
        if (white) out += `if(${white})return ${defaultExpr};`;
        const black = emitBuckets(parsed.blacklist);
        if (black) out += `if(${black})return ${matchExpr};`;
        return out + `return ${defaultExpr};`;
      }
    }
  };

  /**
   * Rule-list buckets: exact hosts and `||domain` suffixes become dictionary
   * lookups, keywords one indexOf loop, regexes one test loop — instead of
   * thousands of sequential conditions.
   */
  const emitBuckets = (conds: CompiledCondition[]): string => {
    // Keys are prefixed with DK so that dangerous names — notably "__proto__",
    // which an object literal treats as a prototype setter rather than an own
    // key — become ordinary own properties both in TS and in the emitted
    // literal. Lookups below prepend the same prefix.
    const exact: Record<string, 1> = {};
    const suffix: Record<string, 1> = {};
    const keywords: string[] = [];
    const hostRegexes: string[] = [];
    const urlRegexes: string[] = [];
    let extra = '';
    for (const c of conds) {
      switch (c.op) {
        case 'hostEq': exact[DK + c.host] = 1; break;
        case 'suffix': suffix[DK + c.alsoBare] = 1; break;
        case 'urlKeyword': keywords.push(c.text); break;
        case 'hostRegex': hostRegexes.push(c.source); break;
        case 'urlRegex': urlRegexes.push(c.source); break;
        case 'never': break;
        default:
          extra += (extra ? '||' : '') + emitCond(c);
      }
    }
    const parts: string[] = [];
    if (Object.keys(exact).length) parts.push(`${tableRef(JSON.stringify(exact))}[${J(DK)}+h]===1`);
    if (Object.keys(suffix).length) {
      need.suffixWalk = true;
      parts.push(`SW(h,${tableRef(JSON.stringify(suffix))})`);
    }
    if (keywords.length) {
      need.loops = true;
      parts.push(`KH(url,${tableRef(JSON.stringify(keywords))})`);
    }
    if (hostRegexes.length) {
      need.loops = true;
      parts.push(`RH(h,${tableRef(`[${hostRegexes.map(regexLiteral).join(',')}]`)})`);
    }
    if (urlRegexes.length) {
      need.loops = true;
      parts.push(`RH(url,${tableRef(`[${urlRegexes.map(regexLiteral).join(',')}]`)})`);
    }
    if (extra) parts.push(extra);
    return parts.join('||');
  };

  // Compile the graph (fills bodies/tables/regexes and the `need` flags).
  let rootStmt: string;
  if (root.kind === 'virtual') {
    emitting.add(root.id);
    rootStmt = `return ${targetExpr(root.targetId)};`;
    emitting.delete(root.id);
  } else {
    rootStmt = `return ${fnFor(root)}(url,h);`;
  }

  const helpers: string[] = [];
  if (need.endsWith) {
    helpers.push('function E(h,s){var d=h.length-s.length;return d>=0&&h.lastIndexOf(s)===d;}');
  }
  if (need.suffixWalk) {
    helpers.push(
      `function SW(h,d){var p=h;for(;;){if(d[${J(DK)}+p]===1)return true;var j=p.indexOf(".");if(j<0)return false;p=p.slice(j+1);}}`
    );
  }
  if (need.loops) {
    helpers.push(
      'function KH(u,a){for(var i=0;i<a.length;i++)if(u.indexOf(a[i])>=0)return true;return false;}',
      'function RH(s,a){for(var i=0;i<a.length;i++)if(a[i].test(s))return true;return false;}'
    );
  }
  if (need.ip) {
    helpers.push(
      'function A(h){var m=/^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$/.exec(h);' +
        'if(!m)return -1;var r=0;for(var i=1;i<5;i++){var o=+m[i];if(o>255)return -1;r=((r<<8)|o)>>>0;}return r;}'
    );
  }

  const perRequest =
    'var h=host.toLowerCase();' +
    (need.ip ? 'ip=A(h);' : '') +
    (need.lv ? 'lv=1;for(var i=0;i<h.length;i++)if(h.charCodeAt(i)===46)lv++;' : '') +
    (need.date
      ? 'var n=new Date();wd=1<<n.getDay();mins=n.getHours()*60+n.getMinutes();'
      : '');

  return [
    `/* Sockitt: ${root.name.replace(/[/*\r\n]+/g, ' ')} */`,
    `var R=[${regexes.map(regexLiteral).join(',')}];`,
    'var ip=-1,lv=0,wd=0,mins=0;',
    ...helpers,
    ...tables,
    ...bodies,
    `function FindProxyForURL(url,host){${perRequest}${rootStmt}}`,
  ].join('\n');
}

/**
 * If the profile routes unconditionally (a proxy, or a virtual chain ending
 * at one), return that terminal so the browser can use fixed_servers instead
 * of a PAC. Returns 'direct' for direct-terminating chains, null when the
 * route depends on the request (switch/rulelist).
 */
export function staticTerminal(config: Config, profile: Profile): ProxyProfile | 'direct' | null {
  const seen = new Set<string>();
  let p: Profile | undefined = profile;
  while (p) {
    if (seen.has(p.id)) return 'direct'; // cycle — matches compiler fallback
    seen.add(p.id);
    if (p.kind === 'proxy') return p;
    if (p.kind !== 'virtual') return null;
    if (p.targetId === DIRECT) return 'direct';
    p = profileById(config, p.targetId);
  }
  return 'direct'; // dangling reference
}

/** Fixed-servers value for a single-proxy profile (non-PAC fast path). */
export function fixedServersValue(scheme: ProxyScheme, host: string, port: number, bypass: string[]) {
  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy: { scheme, host, port },
      bypassList: bypass.filter((b) => b.trim().length > 0),
    },
  } as const;
}

export { DIRECT };
