# Rule and pattern reference

An **Auto Switch** profile is an ordered list of rules. For every request the
browser evaluates rules top to bottom; the **first match wins** and decides the
route (a proxy, Direct, or another profile). If nothing matches, the profile's
*Everything else* target applies.

Disabled rules (toggled off) and rules with invalid patterns are skipped
entirely. An invalid pattern is outlined red in the editor and never breaks the
other rules.

## Condition types

### Host wildcard

Matches against the request's hostname (case-insensitive).

| Pattern | Matches | Doesn't match |
|---|---|---|
| `*.example.com` | `example.com`, `www.example.com`, `a.b.example.com` | `notexample.com` |
| `example.com` | `example.com` only | `www.example.com` |
| `internal-*` | `internal-git`, `internal-db` | `git.internal` |

- `*` matches any run of characters; `?` matches exactly one.
- A leading `*.` is special-cased so it also matches the bare domain, and it is
  compiled to a fast suffix comparison rather than a regex.

### Host regex

A JavaScript regular expression tested against the hostname. It is unanchored
by default, so anchor it yourself:

```
(^|\.)example\.(com|net)$
^api\.
```

### URL wildcard

A wildcard tested against the full URL. A trailing `*` is implied, so a prefix
is enough:

```
https://example.com/api/
http://*/admin/*
```

> For HTTPS sites the browser only exposes the scheme and host to the proxy
> resolver, so path-based URL rules effectively behave as host-level rules on
> HTTPS.

### URL regex

A JavaScript regular expression tested against the full URL:

```
^https?://(www\.)?example\.com/
```

### IP / CIDR

Matches when the hostname is a **literal IPv4 address** inside the block:

```
10.0.0.0/8
192.168.1.0/24
203.0.113.7        (a single address, /32 implied)
```

Sockitt performs no DNS resolution while routing (it would slow every request),
so CIDR rules do not apply to domain names. IPv6 CIDR is not supported.

### URL keyword

A plain substring searched anywhere in the full URL. `tracker` matches
`https://cdn.example/tracker.js`. This is the cheapest condition of all.

### Host levels

Matches on how many dot-separated labels the hostname has: `example.com` has 2,
`a.b.example.com` has 4. The pattern is a count or a range, such as `2` or
`2-4`.

### Weekday and time of day

Route differently on a schedule.

- **Weekday** patterns: `mon-fri`, `sat,sun`, `fri-mon` (ranges may wrap the
  week; digits 0 to 6 with 0 = Sunday also work).
- **Time** patterns: `09:00-17:30`, and `22:00-06:00` which wraps midnight.

> The browser caches proxy decisions per URL for a short while, so a schedule
> boundary can take effect with a small delay on already-visited sites.

## Rule targets can be other profiles

A rule (or the *Everything else* default) can route to another Auto Switch
profile, a rule list, or an **alias**, not only to a proxy or Direct. Aliases
are simple pointers: aim several rules at an alias, then retarget the alias once
to move them all. The options UI hides choices that would create a cycle, and
the compiler independently resolves any cycle to Direct.

## Per-site override (temporary)

While an Auto Switch profile is active, the popup's top section manages the
current site. Alongside the matching permanent rule, you can set a single
**Override**: an always-temporary rule for the current site that takes priority
over permanent rules, greys out the matching rule while it is set, and is
cleared when the browser restarts (or when you remove it). Overrides live in
session storage and are never written to your saved configuration.

## Rule lists

A rule-list profile routes URLs matching an online (or pasted) list through a
chosen target. Two formats:

- **AutoProxy / GFWList**: `||domain`, `|https://prefix`, `/regex/`, plain
  keywords, `@@` whitelist entries, and `!` comments. Base64-encoded payloads
  (GFWList's distribution format) are decoded automatically.
- **Switchy**: one pattern per line. Bare patterns are host wildcards, entries
  containing `://` are URL wildcards, `@@` prefixes whitelist entries, and `#`,
  `;`, or `!` start comments.

Whitelist entries always win, sending the URL to the profile's default target.
Lists auto-refresh on the interval you set; the URL's host must allow
cross-origin requests (`raw.githubusercontent.com` does). Performance note:
`||domain` entries compile into a single dictionary lookup, so even a
6,000-entry GFWList costs roughly constant time per request.

## Bypass lists

Each proxy profile has a bypass list of hosts that connect **directly** even
when that profile is chosen (whether activated directly or via a switch rule).
One entry per line:

| Entry | Meaning |
|---|---|
| `<local>` | `localhost`, `127.0.0.1`, `[::1]`, and any dotless hostname (`nas`, `router`) |
| `*.internal.example` | host wildcard, same semantics as above |
| `10.0.0.0/8` | IPv4 CIDR block |
| `printer.lan` | exact host |

## Order matters: a worked example

| # | Condition | Pattern | Route via |
|---|---|---|---|
| 1 | Host wildcard | `*.corp.example` | Direct |
| 2 | Host wildcard | `*.example.com` | Tokyo |
| 3 | IP / CIDR | `10.0.0.0/8` | Office |
| * | Everything else | | Direct |

`wiki.corp.example` hits rule 1 and goes direct even though rule 2 would also
have matched, because rule 1 sits above it. Drag rules by the grip handle to
change priority.
