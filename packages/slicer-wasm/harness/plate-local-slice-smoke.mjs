// Step 7 bridge harness: current-plate slicing uses local coordinates and
// rejects stale/non-current operation targets without touching the global
// editing model.
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const [moduleArg] = argv.slice(2);
if (!moduleArg) throw new Error('usage: node plate-local-slice-smoke.mjs <out/orca_slice.js>');
const repoRoot = resolve(import.meta.dirname, '../../..');
const factory = await loadModuleFactory(moduleArg);
const Module = await factory({ noInitialRun: true, printErr: console.error });
await installProfilePackages(Module, createNodeProfileSource(resolve(repoRoot, 'packages/profile-resources/dist')));

function callJson(name, argTypes = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', argTypes, args));
  const result = JSON.parse(Module.UTF8ToString(ptr));
  Module._free(ptr);
  return result;
}
function check(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}
let failures = 0;
const init = callJson('orc_init', ['string'], ['{"log_level":"error"}']);
check('init', init.ok === true);
check('plate 1 model', callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Cube']).ok === true);
let first = callJson('orc_get_plate_session_snapshot');
const added = callJson('orc_add_plate');
check('add plate selects plate 2', added.ok === true && added.current_plate_id !== first.current_plate_id);
first = callJson('orc_get_plate_session_snapshot');
check('plate 2 model', callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Cube']).ok === true);
callJson('orc_recompute_plate_membership');
const addedEmpty = callJson('orc_add_plate');
check('add empty plate selects plate 3', addedEmpty.ok === true);
const empty = callJson('orc_get_plate_session_snapshot');
const emptyTarget = { id: empty.current_plate_id, revision: empty.input_revisions[empty.current_plate_id] };
const emptySlice = callJson('orc_slice_plate', ['string', 'string', 'number'], ['{}', emptyTarget.id, emptyTarget.revision]);
check('empty current plate rejected', emptySlice.ok !== true && /empty/.test(emptySlice.error ?? ''));
let second = callJson('orc_select_plate', ['string'], [first.plates[1].plate_id]);
check('return to plate 2', second.ok === true);
second = callJson('orc_get_plate_session_snapshot');
const firstTarget = { id: first.plates[0].plate_id, revision: second.input_revisions[first.plates[0].plate_id] };
const secondTarget = { id: second.current_plate_id, revision: second.input_revisions[second.current_plate_id] };

const selectUnslicedSecond = callJson('orc_select_plate', ['string'], [secondTarget.id]);
check('select unsliced plate 2', selectUnslicedSecond.ok === true && selectUnslicedSecond.current_plate_id === secondTarget.id);
const unslicedSecondResult = callJson('orc_get_slice_result');
check('unsliced plate 2 result rejected', unslicedSecondResult.ok !== true &&
  /stale or unavailable/.test(unslicedSecondResult.error ?? ''), JSON.stringify(unslicedSecondResult));
const selectFirst = callJson('orc_select_plate', ['string'], [firstTarget.id]);
check('select plate 1', selectFirst.ok === true && selectFirst.current_plate_id === firstTarget.id);
const modelBeforeSlice = callJson('orc_get_model_structure');
const sliceFirst = callJson('orc_slice_plate', ['string', 'string', 'number'], ['{}', firstTarget.id, firstTarget.revision]);
check('slice plate 1', sliceFirst.ok === true, JSON.stringify(sliceFirst));
const modelAfterSlice = callJson('orc_get_model_structure');
check('local slice preserves global model', JSON.stringify(modelAfterSlice) === JSON.stringify(modelBeforeSlice));
const firstPreview = callJson('orc_get_slice_result');
check('preview plate 1 uses its print', firstPreview.ok === true && firstPreview.objects === 1,
  JSON.stringify(firstPreview));
const exportFirst = callJson('orc_export_gcode_plate', ['string', 'number'], [firstTarget.id, firstTarget.revision]);
const firstGcode = exportFirst.ok ? Buffer.from(Module.FS.readFile('/out.gcode')).toString('utf8') : '';
check('export plate 1', exportFirst.ok === true, JSON.stringify(exportFirst));

const resliceFirst = callJson('orc_slice_plate', ['string', 'string', 'number'], ['{}', firstTarget.id, firstTarget.revision]);
check('explicit re-slice keeps plate 1 revision', resliceFirst.ok === true, JSON.stringify(resliceFirst));
const refreshedFirstExport = callJson('orc_export_gcode_plate', ['string', 'number'], [firstTarget.id, firstTarget.revision]);
check('re-slice refreshes presentation through export', refreshedFirstExport.ok === true, JSON.stringify(refreshedFirstExport));
const refreshedFirstPreview = callJson('orc_get_slice_result');
check('re-slice result refresh restores presentation', refreshedFirstPreview.ok === true &&
  refreshedFirstPreview.objects === 1, JSON.stringify(refreshedFirstPreview));

const selectSecond = callJson('orc_select_plate', ['string'], [secondTarget.id]);
check('select plate 2', selectSecond.ok === true && selectSecond.current_plate_id === secondTarget.id);
const sliceSecond = callJson('orc_slice_plate', ['string', 'string', 'number'], ['{}', secondTarget.id, secondTarget.revision]);
check('slice plate 2', sliceSecond.ok === true, JSON.stringify(sliceSecond));
const secondPreview = callJson('orc_get_slice_result');
check('preview plate 2 uses its print', secondPreview.ok === true && secondPreview.objects === 1,
  JSON.stringify(secondPreview));
const exportSecond = callJson('orc_export_gcode_plate', ['string', 'number'], [secondTarget.id, secondTarget.revision]);
const secondGcode = exportSecond.ok ? Buffer.from(Module.FS.readFile('/out.gcode')).toString('utf8') : '';
const moves = (gcode) => gcode.split('\n').filter((line) => /^G[01]\s/.test(line)).join('\n');
check('export plate 2', exportSecond.ok === true, JSON.stringify(exportSecond));
check('equivalent local geometry has equivalent moves', moves(firstGcode) === moves(secondGcode));

const secondRevisionChange = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Second plate extra']);
check('second plate state change accepted', secondRevisionChange.ok === true);
const secondChanged = callJson('orc_get_plate_session_snapshot');
const secondChangedTarget = {
  id: secondChanged.current_plate_id,
  revision: secondChanged.input_revisions[secondChanged.current_plate_id],
};
const staleSecondResult = callJson('orc_get_slice_result');
check('stale plate 2 result rejected', staleSecondResult.ok !== true &&
  /stale or unavailable/.test(staleSecondResult.error ?? ''), JSON.stringify(staleSecondResult));
const staleSecondExport = callJson('orc_export_gcode_plate', ['string', 'number'], [secondTarget.id, secondTarget.revision]);
check('stale plate 2 export rejected', staleSecondExport.ok !== true && /stale/.test(staleSecondExport.error ?? ''),
  JSON.stringify(staleSecondExport));

const nonCurrent = callJson('orc_export_gcode_plate', ['string', 'number'], [firstTarget.id, firstTarget.revision]);
check('non-current export rejected', nonCurrent.ok !== true && /current plate/.test(nonCurrent.error ?? ''));
check('distinct plate previews have distinct result storage',
  firstPreview.metadata?.result_id !== secondPreview.metadata?.result_id);
const sliceSecondChanged = callJson('orc_slice_plate', ['string', 'string', 'number'],
  ['{}', secondChangedTarget.id, secondChangedTarget.revision]);
check('slice changed plate 2', sliceSecondChanged.ok === true, JSON.stringify(sliceSecondChanged));
const changedSecondPreview = callJson('orc_get_slice_result');
check('changed plate 2 preview is still selected',
  changedSecondPreview.ok === true && changedSecondPreview.objects === 2,
  JSON.stringify(changedSecondPreview));
const cancelSecond = callJson('orc_cancel');
check('cancel resets the selected plate print', cancelSecond.ok === true, JSON.stringify(cancelSecond));
const returnFirst = callJson('orc_select_plate', ['string'], [firstTarget.id]);
check('return to plate 1', returnFirst.ok === true);
const returnedFirstPreview = callJson('orc_get_slice_result');
check('returning to plate 1 reads plate 1 print',
  returnedFirstPreview.ok === true && returnedFirstPreview.objects === 1,
  JSON.stringify(returnedFirstPreview));
const changed = callJson('orc_add_shape', ['string', 'string'], ['Cube', 'Revision change']);
check('revision change accepted', changed.ok === true);
const stale = callJson('orc_slice_plate', ['string', 'string', 'number'], ['{}', firstTarget.id, firstTarget.revision]);
check('stale slice rejected', stale.ok !== true && /stale/.test(stale.error ?? ''));

if (failures > 0) process.exitCode = 1;
