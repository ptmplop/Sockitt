# Bundled fonts

The two faces the popup and options pages are set in (see `docs/design.md`).
Both are licensed under the SIL Open Font License 1.1 — the licence for each
ships beside it here and in every build. Neither licence declares a Reserved
Font Name.

| File | Family | Source |
|---|---|---|
| `dm-sans.woff2` | DM Sans 4.004, variable (`opsz` 9–40, `wght` 100–1000) | `Sans/fonts/variable/DMSans[opsz,wght].ttf` from [googlefonts/dm-fonts](https://github.com/googlefonts/dm-fonts), sha256 `a023f465…c81f6` |
| `jetbrains-mono.woff2` | JetBrains Mono 2.305, variable (`wght` 100–800) | `fonts/variable/JetBrainsMono[wght].ttf` from [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono), sha256 `3cfafa86…4ec34` |

They are subsets of the upstream files, not the copies on npm or the Google
Fonts API. Those strip the OpenType features this UI depends on — `tnum` for
figures that hold their width when they re-render, `case`, and the stylistic
sets — so they were rebuilt from upstream with every layout feature and both
variation axes kept, cut to Latin, Latin Extended, general punctuation,
currency, arrows and the check marks:

```sh
U="U+0000-00FF,U+0100-02BA,U+02BB-02BC,U+02BD-02C5,U+02C6,U+02C7-02CC,U+02CE-02D7,U+02DA,U+02DC,U+02DD-02FF,U+0304,U+0308,U+0329,U+0131,U+0152-0153,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2000-206F,U+20A0-20C0,U+2113,U+2122,U+2190-21FF,U+2212,U+2215,U+2713-2714,U+2C60-2C7F,U+A720-A7FF,U+FEFF,U+FFFD"
pyftsubset 'DMSans[opsz,wght].ttf'    --unicodes="$U" --layout-features='*' --name-IDs='*' --flavor=woff2 --output-file=dm-sans.woff2
# every JetBrains Mono feature except calt (see below)
F="aalt,case,ccmp,cv01,cv02,cv03,cv04,cv05,cv06,cv07,cv08,cv09,cv10,cv11,cv12,cv14,cv15,cv16,cv17,cv18,cv19,cv20,cv99,frac,locl,mark,mkmk,ordn,sinf,ss01,ss02,ss19,ss20,subs,sups,zero"
pyftsubset 'JetBrainsMono[wght].ttf'  --unicodes="$U" --layout-features="$F" --name-IDs='*' --flavor=woff2 --output-file=jetbrains-mono.woff2
```

JetBrains Mono is cut **without `calt`** — listed explicitly, because
`--layout-features-=calt` does nothing once the list is the `'*'` wildcard. That feature holds its programming
ligatures, which redraw `::` as one wide glyph — so `net::ERR_PROXY_…` read as
`net :: ERR` and a compressed IPv6 address would have changed shape. Every
string set in the mono here is an address, a pattern or an error code, and
each has to read exactly as typed.

(`pyftsubset` is fontTools 4.57, with `brotli` installed for the WOFF2 output.)
Any character outside these ranges — a profile named in another script —
falls back per glyph to the system face, exactly as everything did before the
fonts were bundled.
