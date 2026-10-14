# Bundled fonts

The two families the popup and options pages are set in (see `docs/design.md`).
Both are licensed under the SIL Open Font License 1.1 — the licence for each
ships beside it here and in every build. Neither licence declares a Reserved
Font Name.

| File | Family | Source |
|---|---|---|
| `archivo.woff2` | Archivo 2.001, variable (`wght` 100–900, `wdth` 62–125) | `ofl/archivo/Archivo[wdth,wght].ttf` from [google/fonts](https://github.com/google/fonts), sha256 `0e094a7d…0b05053` |
| `plex-mono-400.woff2` | IBM Plex Mono 2.3 Regular | `ofl/ibmplexmono/IBMPlexMono-Regular.ttf` from [google/fonts](https://github.com/google/fonts), sha256 `6a3412f0…727734af46` |
| `plex-mono-500.woff2` | IBM Plex Mono 2.3 Medium | `ofl/ibmplexmono/IBMPlexMono-Medium.ttf`, sha256 `a9b4c49b…ab574a2d1ea6755` |
| `plex-mono-600.woff2` | IBM Plex Mono 2.3 SemiBold | `ofl/ibmplexmono/IBMPlexMono-SemiBold.ttf`, sha256 `d3c38e55…6d9aa46` |

Archivo carries the interface. Its width axis is used as part of the type
scale: titles are set wider (112–122%), labels narrower (90–96%), body text at
102%. IBM Plex Mono is for anything a person might paste — addresses, hosts,
patterns, error codes — and has no variable cut, so the three weights the UI
uses ship as statics.

They are subsets of the upstream files, not the copies on npm or the Google
Fonts API. Those strip OpenType features this UI depends on — `tnum` for
figures that hold their width when they re-render, `case`, `zero` — so they
were rebuilt from upstream with every layout feature and both variation axes
kept, cut to Latin, Latin Extended, general punctuation, currency, arrows and
the check marks:

```sh
U="U+0000-00FF,U+0100-02BA,U+02BB-02BC,U+02BD-02C5,U+02C6,U+02C7-02CC,U+02CE-02D7,U+02DA,U+02DC,U+02DD-02FF,U+0304,U+0308,U+0329,U+0131,U+0152-0153,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2000-206F,U+20A0-20C0,U+2113,U+2122,U+2190-21FF,U+2212,U+2215,U+2713-2714,U+2C60-2C7F,U+A720-A7FF,U+FEFF,U+FFFD"
python3 -m fontTools.subset 'Archivo[wdth,wght].ttf' --unicodes="$U" --layout-features='*' --name-IDs='*' --flavor=woff2 --output-file=archivo.woff2
for w in Regular:400 Medium:500 SemiBold:600; do
  python3 -m fontTools.subset "IBMPlexMono-${w%%:*}.ttf" --unicodes="$U" --layout-features='*' --name-IDs='*' --flavor=woff2 --output-file="plex-mono-${w##*:}.woff2"
done
```

Neither family has programming ligatures (no `calt`), so `net::ERR_…` and a
compressed IPv6 address read exactly as typed. Plex Mono's zero carries a dot
by default, so it can never be mistaken for the letter O in an address.

(fontTools 4.57, with `brotli` installed for the WOFF2 output. The `meta` table
is dropped by the subsetter; it carries no glyph data.) Any character outside
these ranges — a profile named in another script — falls back per glyph to the
system face.
