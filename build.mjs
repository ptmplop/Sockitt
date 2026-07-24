import * as esbuild from 'esbuild';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const watch = process.argv.includes('--watch');
const zip = process.argv.includes('--zip');

// Clean the CONTENTS of dist/ without removing the directory itself. Removing
// and recreating dist/ changes its inode and breaks Chrome's handle to an
// unpacked extension loaded from it ("Your file couldn't be accessed"); this
// keeps the same directory so a loaded extension survives a rebuild.
async function cleanDist() {
  await mkdir('dist', { recursive: true });
  for (const entry of await readdir('dist')) {
    await rm(`dist/${entry}`, { recursive: true, force: true });
  }
  await mkdir('dist/img', { recursive: true });
}

await cleanDist();

// Only the runtime icon sizes ship in the extension — not the source artwork,
// the SVG, or the README screenshots that also live under img/.
const ICONS = ['icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png', 'logo-mark.png'];

const options = {
  entryPoints: [
    { in: 'src/background.ts', out: 'background' },
    { in: 'src/popup/popup.ts', out: 'popup' },
    { in: 'src/options/options.ts', out: 'options' },
  ],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  target: 'chrome110',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

async function copyStatic() {
  await cp('static/manifest.json', 'dist/manifest.json');
  await cp('src/theme.css', 'dist/theme.css');
  await cp('src/popup/popup.html', 'dist/popup.html');
  await cp('src/popup/popup.css', 'dist/popup.css');
  await cp('src/options/options.html', 'dist/options.html');
  await cp('src/options/options.css', 'dist/options.css');
  for (const icon of ICONS) await cp(`img/${icon}`, `dist/img/${icon}`);
}

if (watch) {
  const ctx = await esbuild.context(options);
  await copyStatic();
  await ctx.watch();
  console.log('watching… (static files copied once; re-run on html/css changes)');
} else {
  await esbuild.build(options);
  await copyStatic();
  if (zip) {
    await rm('sockitt.zip', { force: true }); // zip -r appends; start fresh
    execFileSync('zip', ['-r', '-X', '../sockitt.zip', '.'], { cwd: 'dist', stdio: 'inherit' });
    console.log('packaged → sockitt.zip');
  }
  console.log('build complete → dist/');
}
