import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, process.argv[2] ?? 'packages/slicer-wasm/.work/painting-benchmark/results/index.json');
const destination = resolve(root, process.argv[3] ?? 'packages/slicer-wasm/benchmarks/painting/reference-2026-09-29');
const index = JSON.parse(await readFile(source, 'utf8'));
const expectedSamples = Number(process.argv[4] ?? 36);
if (!Number.isInteger(expectedSamples) || expectedSamples < 1 || index.samples.length !== expectedSamples)
  throw new Error(`expected ${expectedSamples} repeated samples, found ${index.samples.length}`);
await mkdir(resolve(destination, 'raw'), { recursive: true });
index.samples = await Promise.all(index.samples.map(async (sample) => {
  const name = basename(sample.file) + '.gz';
  const bytes = await readFile(resolve(dirname(source), sample.file));
  await writeFile(resolve(destination, 'raw', name), gzipSync(bytes, { level: 9, mtime: 0 }));
  return { ...sample, file: `raw/${name}` };
}));
await writeFile(resolve(destination, 'index.json'), JSON.stringify(index, null, 2) + '\n');
const result = spawnSync(process.execPath, ['scripts/summarize-painting-benchmark.mjs', resolve(destination, 'index.json')],
  { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`archive summary failed with ${result.status}`);
console.log(`archived ${index.samples.length} painting samples at ${destination}`);
