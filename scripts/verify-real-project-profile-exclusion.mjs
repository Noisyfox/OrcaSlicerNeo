import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const enabled = process.argv.includes('--enabled');
const roots = enabled
  ? [join(root, 'apps/desktop/out/renderer'), join(root, 'packages/slicer-wasm/out/profile-threaded')]
  : [join(root, 'apps/desktop/out/renderer'), join(root, 'packages/slicer-wasm/out/threaded')];
const sentinels = [
  'ORCA_REAL_PROJECT_PROFILE_V1',
  'orc_take_real_project_profile_snapshot',
  'ORCA_REAL_PROJECT_PROFILE_JS_V1',
  'takeRealProjectProfileSnapshot',
  'ORCA_REAL_PROJECT_PROFILE_RENDERER_V1',
  'profile-threaded',
];

async function filesBelow(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(child));
    else result.push(child);
  }
  return result;
}

const files = (await Promise.all(roots.map(filesBelow))).flat();
const found = new Map(sentinels.map((sentinel) => [sentinel, []]));
for (const file of files) {
  const bytes = await readFile(file);
  for (const sentinel of sentinels) {
    if (bytes.indexOf(Buffer.from(sentinel)) >= 0) found.get(sentinel).push(file);
  }
}

for (const [sentinel, matches] of found) {
  if (enabled && matches.length === 0)
    throw new Error(`enabled profile artifact is missing sentinel: ${sentinel}`);
  if (!enabled && matches.length !== 0)
    throw new Error(`production artifact retained profile sentinel ${sentinel}: ${matches.join(', ')}`);
}
console.log(enabled
  ? 'dedicated profile artifact contains every native/Worker/renderer sentinel'
  : 'production artifacts contain no real-project profile sentinel or call site');
