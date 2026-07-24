import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const watch = process.argv.includes('--watch');
const zip = process.argv.includes('--zip');

await rm('dist', { recursive: true, force: true });
await mkdir('dist/img', { recursive: true });

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
  await cp('img', 'dist/img', { recursive: true });
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
    execFileSync('zip', ['-r', '-X', '../sockitt.zip', '.'], { cwd: 'dist', stdio: 'inherit' });
    console.log('packaged → sockitt.zip');
  }
  console.log('build complete → dist/');
}
