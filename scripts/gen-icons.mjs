// Regenerates all logo assets from img/logo-source.png (the original artwork)
// using ImageMagick (`brew install imagemagick`).
//
//   img/logo.png       transparent trimmed lockup (README, store listing)
//   img/mark.png       the sock mark alone, square, 512px
//   img/icon-*.png     extension icons (manifest + toolbar default)
//
// The service worker repaints the toolbar icon at runtime with the active
// profile's initials avatar; these are the neutral/static defaults.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const SRC = 'img/logo-source.png';
const BG = 'srgb(254,254,255)';
const magick = (...args) => execFileSync('magick', args, { stdio: 'inherit' });

// Full lockup: transparent background, tight trim, small breathing border.
magick(SRC, '-fuzz', '5%', '-transparent', BG, '-trim', '+repage',
  '-bordercolor', 'none', '-border', '20', '-resize', '900x900>', '-strip', 'img/logo.png');

// Sock mark: crop above the wordmark, trim, pad square with a 12% margin.
magick(SRC, '-crop', '640x590+290+140', '+repage', '-fuzz', '5%', '-transparent', BG,
  '-trim', '+repage', '-strip', 'img/mark-raw.png');
const [w, h] = execFileSync('magick', ['identify', '-format', '%w %h', 'img/mark-raw.png'])
  .toString().trim().split(' ').map(Number);
const side = Math.round(Math.max(w, h) * 1.12);
magick('img/mark-raw.png', '-gravity', 'center', '-background', 'none',
  '-extent', `${side}x${side}`, '-resize', '512x512', 'img/mark.png');
rmSync('img/mark-raw.png');

for (const size of [16, 32, 48, 128]) {
  magick('img/mark.png', '-resize', `${size}x${size}`, '-strip', `img/icon-${size}.png`);
  console.log(`img/icon-${size}.png`);
}
console.log('img/logo.png, img/mark.png done');
