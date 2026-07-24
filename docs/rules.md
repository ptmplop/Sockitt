# Rule & pattern reference

An **Auto Switch** profile is an ordered list of rules. For every request the
browser evaluates rules top to bottom; the **first match wins** and decides the
route (a proxy profile, or Direct). If nothing matches, the profile's
*"Everything else"* target applies.

Disabled rules (toggle off) and rules with invalid patterns are skipped
entirely — an invalid pattern is outlined red in the editor and never breaks
the other rules.

## Condition types

### Host wildcard

Matches against the request's hostname (case-insensitive).

| Pattern | Matches | Doesn't match |
|---|---|---|
| `*.example.com` | `example.com`, `www.example.com`, `a.b.example.com` | `notexample.com` |
| `example.com` | `example.com` only | `www.example.com` |
| `internal-*` | `internal-git`, `internal-db` | `git.internal` |

- `*` matches any run of characters, `?` matches exactly one.
- A leading `*.` is special-cased: it also matches the bare domain, and is
  compiled to a fast suffix comparison rather than a regex.

### Host regex

A JavaScript regular expression tested against the hostname. Unanchored by
default — anchor it yourself:

```
(^|\.)example\.(com|net)$
^api\.
```

### URL wildcard

Wildcard tested against the full URL. A trailing `*` is implied, so a prefix
is enough:

```
https://example.com/api/
http://*/admin/*
```

> Note: for HTTPS sites the browser only exposes scheme and host to the proxy
> resolver — path-based URL rules are effectively host-level for HTTPS.

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
203.0.113.7        (a single address — /32 implied)
```

Sockitt deliberately performs no DNS resolution while routing (it would slow
every request), so CIDR rules do not apply to domain names. IPv6 CIDR is not
supported.

### URL keyword

A plain substring searched anywhere in the full URL — `tracker` matches
`https://cdn.example/tracker.js`. The cheapest condition of all.

### Host levels

Matches on how many dot-separated labels the hostname has: `example.com` has
2, `a.b.example.com` has 4. Pattern is a count or range: `2` or `2-4`.

### Weekday / Time of day

Route differently by schedule. Weekday patterns: `mon-fri`, `sat,sun`,
`fri-mon` (ranges may wrap the week; digits 0–6 with 0 = Sunday also work).
Time patterns: `09:00-17:30`, and `22:00-06:00` wraps midnight.

> The browser caches proxy decisions per URL for a short while, so a schedule
> boundary can take effect with a small delay on already-visited sites.

## Rule targets can be other profiles

A rule (or the "everything else" default) can route to another Auto Switch
profile, a rule list, or an **alias** — not just proxies and Direct. Aliases
are simple pointers: aim several rules at an alias, then retarget the alias
once to move them all. The options UI hides choices that would create a
cycle, and the compiler independently resolves any cycle to Direct.

## Temporary rules

The popup's **"Only until browser restart"** toggle adds the quick rule to
session storage instead of your config. Temp rules sit *above* permanent
rules, show as removable chips in the popup, and vanish when the browser
fully exits.

## Rule lists

A Rule List profile routes URLs matching an online (or pasted) list through a
chosen target. Two formats:

- **AutoProxy / GFWList** — `||domain`, `|https://prefix`, `/regex/`, plain
  keywords, `@@` whitelist entries, `!` comments. Base64-encoded payloads
  (GFWList's distribution format) are decoded automatically.
- **Switchy** — one wildcard per line: bare patterns are host wildcards,
  entries containing `://` are URL wildcards, `@@` prefixes whitelist
  entries, `#`/`;`/`!` start comments.

Whitelist entries always win, sending the URL to the profile's default
target. Lists auto-refresh on the interval you set (the URL's host must allow
cross-origin requests — `raw.githubusercontent.com` does). Performance note:
`||domain` entries compile into a single dictionary lookup, so even a
6,000-entry GFWList costs roughly constant time per request.

## Bypass lists

Each proxy profile has a bypass list — hosts that connect **directly** even
when that profile is chosen (whether activated directly or via a switch rule).
One entry per line:

| Entry | Meaning |
|---|---|
| `<local>` | `localhost`, `127.0.0.1`, `[::1]`, and any dotless hostname (`nas`, `router`) |
| `*.internal.example` | host wildcard, same semantics as above |
| `10.0.0.0/8` | IPv4 CIDR block |
| `printer.lan` | exact host |

## Order matters — worked example

| # | Condition | Pattern | Route via |
|---|---|---|---|
| 1 | Host wildcard | `*.corp.example` | Direct |
| 2 | Host wildcard | `*.example.com` | Tokyo |
| 3 | IP / CIDR | `10.0.0.0/8` | Office |
| — | Everything else | | Direct |

`wiki.corp.example` hits rule 1 and goes direct even though rule 2 would also
have sent `*.example` traffic to Tokyo — rule 1 sits above it. Drag rules by
the `⋮⋮` grip to change priority.
