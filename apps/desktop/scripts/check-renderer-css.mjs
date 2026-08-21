import { readFile, readdir } from 'node:fs/promises';

// The renderer stylesheet is Tailwind v4 source (styles.css imports
// 'tailwindcss' and '@orca/slicer-app/styles.css'); the renderer build must
// compile it via @tailwindcss/vite. Guard the built CSS directly — without
// the plugin, @theme/@apply pass through unprocessed and every Tailwind class
// in the UI is dead (the 2026-08-20 web layout regression; the web host
// guards the same way in apps/web/scripts/non-root-smoke.mjs).
const outAssets = new URL('../out/renderer/assets/', import.meta.url);

const cssFiles = await readdir(outAssets);
const stylesheet = cssFiles.find((f) => f.startsWith('index-') && f.endsWith('.css'));
if (!stylesheet) throw new Error('renderer build produced no index-*.css in out/renderer/assets');
const css = await readFile(new URL(stylesheet, outAssets), 'utf8');
// electron-vite leaves the css prettified while the web build minifies —
// normalize whitespace so the same marker check covers both formats.
if (!css.replace(/\s+/g, '').includes('.flex{')) {
  throw new Error('built CSS lacks compiled Tailwind utilities (missing @tailwindcss/vite?)');
}
console.log('[desktop] renderer css smoke passed');
