import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const renderer = join(root, 'apps/desktop/out/renderer');
const mode = process.argv[2] ?? 'production';
// The runtime client always exposes takeNativePerformanceProfile() for
// diagnostics. The colon distinguishes the E2E hook object's alias from that
// ordinary runtime method.
const appHooks = ['projectLoadEvidence', 'takeNativePerformanceProfile:'];
const profileHooks = [
  'takeRealProjectProfileSnapshot',
  'realProjectProfileActiveSliceCount',
  'realProjectProfileLastRestoreSliceActive',
  'realProjectProfileMutationPendingCount',
];
const scopedGateHooks = ['installScopedConfigurationGate', '__orcaScopedConfigurationGate'];
const allHooks = [...appHooks, ...profileHooks, ...scopedGateHooks];

const expectedByMode = {
  production: [],
  e2e: appHooks,
  profile: [...appHooks, ...profileHooks],
  'scoped-gate': [...appHooks, ...scopedGateHooks],
};
const expected = expectedByMode[mode];
if (!expected) throw new Error(`unknown probe bundle mode: ${mode}`);

async function jsFilesBelow(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await jsFilesBelow(child));
    else if (/\.(?:c|m)?js$/i.test(entry.name)) result.push(child);
  }
  return result;
}

const files = await jsFilesBelow(renderer);
if (files.length === 0) throw new Error(`no renderer JavaScript found under ${renderer}`);
const contents = await Promise.all(files.map((file) => readFile(file)));
const found = new Map(allHooks.map((hook) => [hook, []]));
for (let index = 0; index < files.length; index += 1) {
  for (const hook of allHooks) {
    if (contents[index].includes(Buffer.from(hook))) found.get(hook).push(files[index]);
  }
}

const missing = expected.filter((hook) => found.get(hook).length === 0);
const forbidden = allHooks.filter((hook) => !expected.includes(hook) && found.get(hook).length > 0);
if (missing.length > 0 || forbidden.length > 0) {
  throw new Error([
    ...(missing.length ? [`missing ${mode} probe markers: ${missing.join(', ')}`] : []),
    ...(forbidden.length ? [`unexpected ${mode} probe markers: ${forbidden.map((hook) => `${hook} (${found.get(hook).join(', ')})`).join('; ')}`] : []),
  ].join('\n'));
}

console.log(`${mode} renderer probe boundary passed (${files.length} JavaScript files)`);
