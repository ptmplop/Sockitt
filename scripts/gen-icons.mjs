// Regenerates every image asset from img/logo-source.png (the original artwork)
// using ImageMagick (`brew install imagemagick`).
//
//   img/logo-banner.png   full lockup, trimmed, on its light background (README)
//   img/logo-mark.png     the sock alone, on transparency (in-app brand, either theme)
//   img/icon-*.png        transparent toolbar/store icons (16/32/48/128)
//
// The service worker repaints the toolbar icon at runtime with the active
// profile's initials avatar; the icon-*.png files are the neutral defaults.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const SRC = 'img/logo-source.png';
const BG = 'srgb(254,254,254)';
const magick = (...args) => execFileSync('magick', args, { stdio: 'inherit' });

function sockTrimmed(out, extraArgs) {
  // Crop the sock (above the wordmark), then trim its border.
  magick(SRC, '-crop', '640x600+300+150', '+repage', '-fuzz', '8%', ...extraArgs, out);
}

// README banner: whole lockup, trimmed, light background kept.
magick(SRC, '-fuzz', '6%', '-transparent', BG, '-trim', '+repage', '-background', BG,
  '-bordercolor', BG, '-border', '40', '-resize', '900x900', '-strip', 'img/logo-banner.png');

// In-app brand mark: the sock alone, on transparency. The pages follow the
// system theme since 1.27, and a light tile behind the mark showed as a white
// square on the dark one.
sockTrimmed('img/mark-raw.png', ['-transparent', BG, '-trim', '+repage', '-strip']);
const [w, h] = execFileSync('magick', ['identify', '-format', '%w %h', 'img/mark-raw.png'])
  .toString().trim().split(' ').map(Number);
const markSide = Math.round(Math.max(w, h) * 1.06);
magick('img/mark-raw.png', '-background', 'none', '-gravity', 'center', '-extent', `${markSide}x${markSide}`,
  '-resize', '256x256', '-strip', 'img/logo-mark.png');

// Toolbar / extensions-page / store icons: the sock on a light tile, with the
// corners rounded (26%). A tile rather than a transparent sock, so the icon
// reads as one solid mark on a dark toolbar as well as a light one instead of
// dissolving into it.
const side = Math.round(Math.max(w, h) * 1.22);
magick('img/mark-raw.png', '-background', BG, '-gravity', 'center', '-extent', `${side}x${side}`,
  '-resize', '256x256', '-strip', 'img/mark-square.png');
const RADIUS = Math.round(256 * 0.26);
magick('img/mark-square.png', '-alpha', 'set',
  '(', '+clone', '-alpha', 'transparent', '-background', 'none', '-fill', 'white',
  '-draw', `roundrectangle 0,0,255,255,${RADIUS},${RADIUS}`, ')',
  '-compose', 'DstIn', '-composite', '-strip', 'img/mark-tile.png');
for (const size of [16, 32, 48, 128]) {
  magick('img/mark-tile.png', '-resize', `${size}x${size}`, '-strip', `img/icon-${size}.png`);
  console.log(`img/icon-${size}.png`);
}
rmSync('img/mark-raw.png');
rmSync('img/mark-square.png');
rmSync('img/mark-tile.png');
console.log('img/logo-banner.png, img/logo-mark.png done');
