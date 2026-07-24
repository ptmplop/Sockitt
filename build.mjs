import * as esbuild from 'esbuild';
import { cp, mkdir, readdir, rename, rm, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const watch = process.argv.includes('--watch');
const zip = process.argv.includes('--zip');
const crx = process.argv.includes('--crx');

// Clean the CONTENTS of dist/ without removing the directory itself. Removing
// and recreating dist/ changes its inode and breaks Chrome's handle to an
// unpacked extension loaded from it ("Your file couldn't be accessed"); this
// keeps the same directory so a loaded extension survives a rebuild.
async function cleanDist() {
  await mkdir('dist', { recursive: true });
  await Promise.all(
    (await readdir('dist')).map((entry) => rm(`dist/${entry}`, { recursive: true, force: true }))
  );
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
  await Promise.all([
    cp('static/manifest.json', 'dist/manifest.json'),
    cp('src/theme.css', 'dist/theme.css'),
    cp('src/popup/popup.html', 'dist/popup.html'),
    cp('src/popup/popup.css', 'dist/popup.css'),
    cp('src/options/options.html', 'dist/options.html'),
    cp('src/options/options.css', 'dist/options.css'),
    ...ICONS.map((icon) => cp(`img/${icon}`, `dist/img/${icon}`)),
  ]);
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
  if (crx) await packCrx();
  console.log('build complete → dist/');
}

/**
 * Sign dist/ into sockitt.crx for Chrome Web Store "verified CRX uploads".
 * The private key stays out of the repo; point at it with SOCKITT_CRX_KEY
 * (defaults to ../sockitt-signing-key.pem, i.e. the personal/ folder). Uses a
 * local Chrome/Chromium (CHROME env, or a common macOS/Linux path).
 */
async function packCrx() {
  const key = resolve(process.env.SOCKITT_CRX_KEY || '../sockitt-signing-key.pem');
  await access(key).catch(() => {
    throw new Error(`signing key not found at ${key} (set SOCKITT_CRX_KEY)`);
  });
  const candidates = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'google-chrome',
    'chromium',
  ].filter(Boolean);
  const dist = resolve('dist');
  let packed = false;
  for (const chrome of candidates) {
    try {
      execFileSync(chrome, [
        '--headless=new', '--no-sandbox', '--no-message-box',
        `--pack-extension=${dist}`, `--pack-extension-key=${key}`,
        `--user-data-dir=${resolve('.crx-tmp')}`,
      ], { stdio: 'ignore' });
      packed = true;
      break;
    } catch {
      /* try next candidate */
    }
  }
  await rm('.crx-tmp', { recursive: true, force: true });
  if (!packed) throw new Error('could not run Chrome to pack the CRX (set CHROME to its path)');
  await rm('sockitt.crx', { force: true });
  await rename('dist.crx', 'sockitt.crx');
  console.log('signed → sockitt.crx');
}
