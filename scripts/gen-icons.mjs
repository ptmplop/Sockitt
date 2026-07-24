// Generates the static toolbar/store icons from an inline SVG via rsvg-convert.
// The service worker repaints the toolbar icon at runtime in the active
// profile's colour; these are the neutral defaults.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6d5dfc"/>
      <stop offset="1" stop-color="#46c9e5"/>
    </linearGradient>
  </defs>
  <circle cx="64" cy="64" r="52" fill="none" stroke="url(#g)" stroke-width="17"/>
  <circle cx="64" cy="64" r="24" fill="url(#g)"/>
</svg>`;

mkdirSync('img', { recursive: true });
writeFileSync('img/icon.svg', svg);

for (const size of [16, 32, 48, 128]) {
  execFileSync('rsvg-convert', [
    '-w', String(size), '-h', String(size),
    '-o', `img/icon-${size}.png`,
    'img/icon.svg',
  ]);
  console.log(`img/icon-${size}.png`);
}
