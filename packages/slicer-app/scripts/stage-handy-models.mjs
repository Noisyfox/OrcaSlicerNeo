// Stage the shared app's handy-model assets from the pinned slicer source.
// They are intentionally generated host assets: the model binaries are never
// copied into the shared app or host source trees.
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import models from '../resources/handy-models.json' with { type: 'json' };

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '../..');
const sourceRoot = join(repoRoot, 'packages/slicer-wasm/cpp/resources/handy_models');
const defaultDestination = join(repoRoot, 'apps/desktop/src/renderer/public/handy-models');

const files = [...new Set(models.flatMap((model) => model.files))];

/** Stage exactly the resources referenced by the shared app manifest. */
export async function stageHandyModels(destination = defaultDestination) {
  if (!existsSync(sourceRoot)) {
    throw new Error(`missing pinned handy-model resources: ${sourceRoot}`);
  }
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    const source = join(sourceRoot, file);
    if (!existsSync(source)) {
      throw new Error(`missing handy-model resource referenced by the shared app: ${file}`);
    }
    await copyFile(source, join(destination, file));
  }
  return files;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const staged = await stageHandyModels();
  console.log(`[stage-handy-models] staged ${staged.length} shared-app resources`);
}
