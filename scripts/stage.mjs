// scripts/stage.mjs — stage every generated renderer asset into the hosts'
// shared public directory: the built WASM variants, profile packages, and
// shared-app handy models. Run after `bash packages/slicer-wasm/build.sh`
// (or `build-windows.bat build`) and after profile-resource generation.
//   pnpm --filter @orca/profile-resources build
// --soft: warn and exit 0 when the build is missing — used by the desktop `predev`
// hook so mock-mode UI dev (VITE_USE_MOCK=1) still boots on a fresh checkout
// with no wasm build.
import { copyFile, cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidWasm } from './validate-wasm.mjs';
import { stageHandyModels } from '../packages/slicer-app/scripts/stage-handy-models.mjs';

const soft = process.argv.includes('--soft');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = join(root, 'packages/slicer-wasm/out');
const dstRoot = join(root, 'apps/desktop/src/renderer/public/wasm');
const profileSrc = join(root, 'packages/profile-resources/dist');
const profileDst = join(root, 'apps/desktop/src/renderer/public/profiles');
const previewSrc = join(root, 'packages/slicer-wasm/cpp/resources/profiles/hotend.stl');
const previewDstRoot = join(root, 'apps/desktop/src/renderer/public/preview');
const previewDst = join(previewDstRoot, 'hotend.stl');

await stageHandyModels();

// Orca's G-code marker is the translucent hotend STL loaded by
// GCodeViewer::SequentialView::Marker. Keep the exact upstream fallback
// model available to both hosts as one lazy static asset; vendor-specific
// models are emitted below without changing the renderer contract.
if (existsSync(previewSrc)) {
  await mkdir(previewDstRoot, { recursive: true });
  await copyFile(previewSrc, previewDst);
  console.log('staged preview/hotend.stl');
}

// PresetBundle resolves a printer's hotend_model from its vendor machine
// profile, then falls back to profiles/hotend.stl. Publish that same small
// lookup as static data. The renderer fetches only the selected STL; this
// staging step does not preload all models into the page.
const hotendModels = {};
if (existsSync(join(root, 'packages/slicer-wasm/cpp/resources/profiles'))) {
  const profilesRoot = join(root, 'packages/slicer-wasm/cpp/resources/profiles');
  for (const vendorEntry of (await readdir(profilesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
    const machineRoot = join(profilesRoot, vendorEntry.name, 'machine');
    if (!existsSync(machineRoot)) continue;
    for (const machineEntry of (await readdir(machineRoot, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))) {
      try {
        const machine = JSON.parse(await readFile(join(machineRoot, machineEntry.name), 'utf8'));
        if (typeof machine.name !== 'string' || typeof machine.hotend_model !== 'string' || !machine.hotend_model) continue;
        const sourceAsset = join(profilesRoot, vendorEntry.name, machine.hotend_model);
        if (!existsSync(sourceAsset)) continue;
        const relativeAsset = `hotends/${vendorEntry.name}/${machine.hotend_model}`;
        const targetAsset = join(previewDstRoot, relativeAsset);
        await mkdir(dirname(targetAsset), { recursive: true });
        await copyFile(sourceAsset, targetAsset);
        hotendModels[vendorEntry.name] ??= {};
        hotendModels[vendorEntry.name][machine.name] = relativeAsset;
      } catch {
        // Ignore malformed optional vendor entries; the native fallback still
        // applies and profile installation reports its own package errors.
      }
    }
  }
}
await writeFile(join(previewDstRoot, 'hotends.json'), JSON.stringify({ version: 1, fallback: 'hotend.stl', models: hotendModels }, null, 2) + '\n');
console.log(`staged preview/hotends.json (${Object.values(hotendModels).reduce((count, models) => count + Object.keys(models).length, 0)} model mappings)`);

if (!existsSync(outRoot)) {
  if (soft) {
    console.warn('[stage] no WASM build — skipped WASM/profile staging (mock-mode / UI-only dev)');
    process.exit(0);
  }
  console.error('no WASM build found — run: bash packages/slicer-wasm/build.sh');
  process.exit(1);
}
if (existsSync(profileSrc)) {
  await cp(profileSrc, profileDst, { recursive: true, force: true });
} else if (soft) {
  console.warn('[stage] no profile packages — skipping (build with: pnpm --filter @orca/profile-resources build)');
} else {
  console.error('no profile packages in packages/profile-resources/dist — run: pnpm --filter @orca/profile-resources build');
  process.exit(1);
}
for (const variant of ['threaded', 'serial']) {
  const src = join(outRoot, variant);
  const dst = join(dstRoot, variant);
  if (!existsSync(src)) {
    if (soft) { console.warn(`[stage] missing ${variant} artifact directory — skipping`); continue; }
    console.error(`missing ${variant} artifact directory in ${outRoot}`);
    process.exit(1);
  }
  const files = ['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data'];
  let complete = true;
  for (const f of files) {
    if (!existsSync(join(src, f))) {
      if (soft) {
        console.warn(`[stage] missing ${variant}/${f} — skipping (mock-mode / UI-only dev)`);
        complete = false;
        break;
      }
      console.error(`missing ${variant}/${f} in ${src}`);
      process.exit(1);
    }
  }
  if (!complete) continue;
  try {
    await assertValidWasm(join(src, 'orca_slice.wasm'));
  } catch (error) {
    const message = `[stage] ${error instanceof Error ? error.message : String(error)} — refusing to stage a module that browsers cannot instantiate`;
    if (soft) {
      console.warn(message);
      continue;
    }
    console.error(message);
    process.exit(1);
  }
  await mkdir(dst, { recursive: true });
  for (const f of files) {
    await copyFile(join(src, f), join(dst, f));
    console.log(`staged ${variant}/${f}`);
  }
}
