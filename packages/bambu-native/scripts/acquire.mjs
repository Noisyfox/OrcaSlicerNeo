import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, join, resolve } from 'node:path';
import { downloadDependency } from '../../../scripts/download-dependency.mjs';
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const manifest = JSON.parse(await readFile(new URL('../artifacts.json', import.meta.url), 'utf8'));
export async function checksum(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function acquire(target = `${process.platform}-${process.arch}`, cache = join(packageRoot, '.cache')) {
  const artifact = manifest.artifacts[target];
  if (!artifact) throw new Error(`No pinned Bambu plugin for ${target}`);
  await mkdir(cache, { recursive: true });
  const archive = join(cache, `${manifest.release}-${basename(artifact.url)}`);
  try { await access(archive); } catch {
    await downloadDependency(artifact.url, archive, { sha256: artifact.sha256 });
  }
  if (await checksum(archive) !== artifact.sha256) throw new Error('Cached plugin archive checksum mismatch');
  const staging = join(cache, `extract-${target}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  // The archive is pinned and verified before tar is allowed to unpack it.
  const result = spawnSync('tar', ['-xf', archive, '-C', staging, `${artifact.root}/lib/v${manifest.series}`], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Plugin archive extraction failed');
  const source = join(staging, artifact.root, 'lib', `v${manifest.series}`);
  await access(join(source, artifact.library));
  const destination = join(packageRoot, 'out', target, 'plugin');
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
  await writeFile(join(destination, 'neo-artifact.json'), JSON.stringify({ release: manifest.release, series: manifest.series, target, sha256: artifact.sha256 }, null, 2) + '\n');
  await rm(staging, { recursive: true, force: true });
  return join(destination, artifact.library);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(await acquire(process.argv[2]));
