import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBuildInfo, repositoryRoot } from './version.mjs';

const runtimeFiles = ['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data'];

export function assertBuildInfo(actual, expected, label) {
  if (actual?.neoVersion !== expected.neoVersion || actual?.coreRevision !== expected.coreRevision) {
    throw new Error(`${label} version mismatch. Expected Neo ${expected.neoVersion}, core ${expected.coreRevision}. Rebuild the artifact.`);
  }
}

export function verifyNativeAddon(path) {
  // A short-lived process releases Windows DLL locks before a retry/rebuild.
  const output = execFileSync(process.execPath, ['-e',
    'process.stdout.write(JSON.stringify(require(process.argv[1]).buildInfo))', path], { encoding: 'utf8' });
  assertBuildInfo(JSON.parse(output), readBuildInfo(), path);
}

async function hashes(directory) {
  const entries = await Promise.all(runtimeFiles.map(async file => [file,
    createHash('sha256').update(await readFile(join(directory, file))).digest('hex')]));
  return Object.fromEntries(entries);
}

export async function stampWasm(directory, configuredInfo) {
  const info = JSON.parse(await readFile(configuredInfo, 'utf8'));
  await writeFile(join(directory, 'build-info.json'), `${JSON.stringify({ ...info, files: await hashes(directory) }, null, 2)}\n`);
}

export async function verifyWasm(directory, expected = readBuildInfo()) {
  const info = JSON.parse(await readFile(join(directory, 'build-info.json'), 'utf8'));
  assertBuildInfo(info, expected, directory);
  const actualHashes = await hashes(directory);
  for (const file of runtimeFiles) {
    if (info.files?.[file] !== actualHashes[file]) throw new Error(`${directory}/${file} does not match its build metadata`);
  }
  return info;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, directory, configuredInfo] = process.argv.slice(2);
  if (command === 'stamp') await stampWasm(directory, configuredInfo);
  else if (command === 'verify') await verifyWasm(directory, readBuildInfo(repositoryRoot));
  else throw new Error('Expected stamp <directory> <configured-info> or verify <directory>');
}
