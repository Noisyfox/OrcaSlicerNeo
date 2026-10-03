import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const readTree = async (dir) => {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...await readTree(path));
    else if (/\.(?:js|mjs|wasm)$/.test(entry.name)) files.push(path);
  }
  return files;
};

for (const variant of ['serial','threaded']) {
  const cache = await readFile(resolve(root, `packages/slicer-wasm/.work/${variant}/build/CMakeCache.txt`), 'utf8');
  if (!/^NEO_PAINTING_PROFILE:BOOL=(?:OFF|FALSE|0)$/m.test(cache)) throw new Error(`${variant} native build is not a normal production build`);
  if (!/^NEO_PROJECT_HISTORY_TEST:BOOL=(?:OFF|FALSE|0)$/m.test(cache)) throw new Error(`${variant} native build retains history test hooks`);
}
const targets = [
  ...['serial','threaded'].flatMap(variant => ['js','wasm'].map(extension => resolve(root, `packages/slicer-wasm/out/${variant}/orca_slice.${extension}`))),
  ...await readTree(resolve(root, 'apps/desktop/out')),
  ...await readTree(resolve(root, 'apps/web/dist')),
];
const sentinels = ['paintingFailNextClose', 'Injected painting close failure', 'nativeHitUs', 'nativeSelectorUs', 'nativeGeometryUs', '__orcaPaintingBenchmarkFinal', 'paintingPerformanceEvidence', 'paintingBenchmarkState', 'primeTowerProjectionPendingCount', 'trackPrimeTowerProjectionRead', 'exportedSourceGeometries', 'paintingVisualStart', 'paintingVisualStop', 'paintingVisualFrames', 'painting-model-', 'painting-candidate', 'painting-contour', 'painting-cursor-'];
for (const path of targets) {
  const bytes = await readFile(path);
  for (const sentinel of sentinels) if (bytes.includes(Buffer.from(sentinel)))
    throw new Error(`production painting-profile sentinel ${sentinel} remains in ${path}`);
}
console.log(`painting-profile elision verified in ${targets.length} production artifacts`);
