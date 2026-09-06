// Regression harness for Orca's below-bed/sinking-object OOB semantics.
// A small negative Z offset is valid when the object remains printable in the
// XY build volume; a genuine XY excursion must still be reported as OOB.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const [moduleArg, ...extraArgs] = argv.slice(2);
if (!moduleArg) throw new Error('usage: node sinking-out-of-bounds-smoke.mjs <out/orca_slice.js>');
const projectFlag = extraArgs.indexOf('--project');
const privateProjectPath = projectFlag >= 0 ? extraArgs[projectFlag + 1] : undefined;

const repoRoot = resolve(import.meta.dirname, '../../..');
const factory = await loadModuleFactory(moduleArg);
const Module = await factory({ noInitialRun: true, print: () => {}, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(repoRoot, 'packages/profile-resources/dist')));

function callJson(name, argTypes = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', argTypes, args));
  const result = JSON.parse(Module.UTF8ToString(ptr));
  Module._free(ptr);
  return result;
}

let failures = 0;
function check(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}

check('initialise real module', callJson('orc_init', ['string'], ['{"log_level":"error"}']).ok === true);
const added = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Sinking OOB fixture']);
check('add fixture model', added.ok === true && added.objects === 1);

const identity = JSON.stringify({ offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] });
const center = added.instance_transforms?.find((item) => item.object_index === 0)?.world_transform?.offset ?? [100, 100, 10];
const printer = callJson('orc_get_preset_snapshot');
const printableArea = printer.printable_area ?? [];
const maxX = Math.max(...printableArea.map((point) => Number(point[0])));
const sinking = JSON.stringify({ offset: [center[0], center[1], -0.01], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] });
check('place fixture with small below-bed offset', callJson('orc_set_model_transform',
  ['number', 'number', 'number', 'string', 'string'], [0, 0, 0, sinking, identity]).ok === true);
let membership = callJson('orc_recompute_plate_membership');
let instance = membership.instances?.find((item) => item.object_index === 0);
check('small below-bed offset remains valid like Orca', instance?.out_of_bounds === false,
  JSON.stringify(instance));

// The cube is 20 mm wide.  Placing its center 5 mm before the bed edge keeps
// it assigned to the plate while making its convex-hull box partly outside.
const outside = JSON.stringify({ offset: [maxX - 5, center[1], -0.01], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] });
check('move fixture outside XY bed', callJson('orc_set_model_transform',
  ['number', 'number', 'number', 'string', 'string'], [0, 0, 0, outside, identity]).ok === true);
membership = callJson('orc_recompute_plate_membership');
instance = membership.instances?.find((item) => item.object_index === 0);
check('genuine XY excursion remains out of bounds', instance?.out_of_bounds === true,
  JSON.stringify(instance));

// Optional private-project probe.  The project bytes are never copied into
// the repository or logged; only the bridge result and validity summary are
// reported.  This makes it possible to verify a user-provided 3MF on a host
// where its path is available without making it a committed fixture.
if (privateProjectPath) {
  const bytes = await readFile(privateProjectPath);
  const ptr = Number(Module._malloc(bytes.length));
  Module.HEAPU8.set(bytes, ptr);
  const loaded = callJson('orc_load_project', ['pointer', 'number', 'number', 'string'],
    [ptr, bytes.length, 0, 'private-oob-regression.3mf']);
  Module._free(ptr);
  const loadedSession = callJson('orc_get_plate_session_snapshot');
  check('private project opens', loaded.ok === true,
    JSON.stringify({ ok: loaded.ok, error: loaded.error, plates: loaded.plate_count }));
  check('private project has no out-of-bounds plates', loadedSession.plates?.every((plate) => plate.valid === true),
    JSON.stringify(loadedSession.plates?.map((plate) => ({ index: plate.display_index, valid: plate.valid }))));
}

if (failures) {
  console.error(`sinking OOB regression failed: ${failures} check(s)`);
  process.exitCode = 1;
} else {
  console.log('sinking OOB regression OK');
}
