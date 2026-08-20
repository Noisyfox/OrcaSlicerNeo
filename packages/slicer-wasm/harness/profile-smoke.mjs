import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { installProfilePackages, createNodeProfileSource } from './profile-installer.mjs';
import { loadModuleFactory, validateGcode } from './run-slice.mjs';
import createMockModule from './mock-module.mjs';

const moduleArg = argv[2];
const repoRoot = resolve(import.meta.dirname, '../../..');
const profileRoot = resolve(argv[3] ?? `${repoRoot}/apps/desktop/public/profiles`);
const stlPath = resolve(argv[4] ?? `${repoRoot}/packages/slicer-wasm/fixtures/cube.stl`);
const configPath = resolve(argv[5] ?? `${repoRoot}/packages/slicer-wasm/fixtures/config.json`);
const factory = moduleArg ? await loadModuleFactory(moduleArg) : createMockModule;
const Module = await factory({ noInitialRun: true, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(profileRoot));

if (typeof Module.ccall === 'function') {
  const ptr = Number(Module.ccall('orc_init', 'number', ['string'], ['']));
  const init = JSON.parse(Module.UTF8ToString(ptr)); Module._free(ptr);
  if (!init.ok) throw new Error(`orc_init failed: ${JSON.stringify(init)}`);
}
Module.FS.writeFile('/model.stl', await readFile(stlPath));
Module.FS.writeFile('/config.json', await readFile(configPath));
const exitCode = Module.callMain(['/model.stl', '/config.json', '/out.gcode']);
const result = validateGcode(Module.FS.readFile('/out.gcode'));
if (exitCode !== 0 || !result.ok) throw new Error(`profile smoke failed: exit=${exitCode} ${result.reason ?? ''}`);
console.log(`profile smoke OK: ${result.bytes} bytes; packages from ${profileRoot}`);
