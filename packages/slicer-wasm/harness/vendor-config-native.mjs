import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadModuleFactory } from './run-slice.mjs';
if (!process.argv[2]) throw new Error('usage: node vendor-config-native.mjs <standalone-test-module.js>');
const factory = await loadModuleFactory(resolve(process.argv[2]));
const module = await factory({ noInitialRun: true, print: console.log, printErr: console.error });
async function copy(source, target) {
  module.FS.mkdirTree(target);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) await copy(join(source, entry.name), `${target}/${entry.name}`);
    else module.FS.writeFile(`${target}/${entry.name}`, await readFile(join(source, entry.name)));
  }
}
await copy(resolve(import.meta.dirname, 'fixtures/compatibility-profiles'), '/profiles');
const manifest = JSON.parse(module.FS.readFile('/profiles/CompatibilityFixture.json', { encoding: 'utf8' }));
const chosen = { ...JSON.parse(module.FS.readFile('/profiles/CompatibilityFixture/filament/alpha-explicit.json', { encoding: 'utf8' })),
  name: 'Z Chosen Filament', filament_id: 'chosen-input' };
module.FS.writeFile('/profiles/CompatibilityFixture/filament/chosen.json', JSON.stringify(chosen));
manifest.filament_list.push({ name: chosen.name, sub_path: 'filament/chosen.json' });
module.FS.writeFile('/profiles/CompatibilityFixture.json', JSON.stringify(manifest));
module.FS.mkdirTree('/system');
for (const vendor of ['CompatibilityFixture', 'OrcaFilamentLibrary']) {
  module.FS.symlink(`/profiles/${vendor}.json`, `/system/${vendor}.json`);
  module.FS.symlink(`/profiles/${vendor}`, `/system/${vendor}`);
}
const result = module.callMain([]);
if (result !== 0) throw new Error(`native API cases failed: ${result}`);
