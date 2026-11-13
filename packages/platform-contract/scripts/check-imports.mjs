import { readdir, readFile } from 'node:fs/promises';

const root = new URL('../src/', import.meta.url);
// Contracts and their fixtures must never depend on printer implementations.
const forbidden = /(?:from\s*['"](?:[^'"]*printer-control|electron|node:|\.\.\/\.\.\/apps\/desktop)|import\s*\(\s*['"](?:[^'"]*printer-control|electron|node:))/;

async function walk(url, pattern = forbidden) {
  for (const entry of await readdir(url, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), url);
    if (entry.isDirectory()) await walk(child, pattern);
    else if (/\.(?:ts|tsx)$/.test(entry.name)) {
      const source = await readFile(child, 'utf8');
      if (pattern.test(source)) throw new Error(`forbidden dependency import in ${child.pathname}`);
    }
  }
}
await walk(root);
await walk(new URL('../typechecks/', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
  if (manifest[section]?.['@orca/printer-control']) throw new Error('platform-contract must not depend on printer-control');
}

// Sharing a package must not make account contracts depend on the central
// barrel, printer contracts, implementations or host code.
const accountSource = await readFile(new URL('../src/serviceProvider.ts', import.meta.url), 'utf8');
for (const match of accountSource.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)) {
  if (/(?:platform-contract|printer-control|electron|node:|apps\/|(?:^|\/)(?:index|contracts|context|printer))/.test(match[1])) {
    throw new Error(`forbidden account contract dependency: ${match[1]}`);
  }
}

// Native addon wrappers are exclusively owned by Electron host code.
const nativePluginImport = /(?:from\s*['"][^'"]*(?:bambu-native|color-sampler-native)|import\s*\(\s*['"][^'"]*(?:bambu-native|color-sampler-native))/;
for (const path of ['../src/', '../../printer-control/src/', '../../slicer-app/src/', '../../../apps/web/src/']) {
  await walk(new URL(path, import.meta.url), nativePluginImport);
}
