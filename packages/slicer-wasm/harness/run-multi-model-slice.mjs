// ----------------------------------------------------------------
// ---- Repro harness: add one STL multiple times, then slice -----
// ----------------------------------------------------------------
// Usage:
//   node run-multi-model-slice.mjs <orca_slice.js> <model.stl> [count]
//
// This exercises the bridge path used by the desktop scene: each import is
// additive, then one orc_slice call processes every object together. Keep the
// fixture external so large customer models are not committed to the repo.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { callAsyncTask } from './async-task-mailbox.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const [modulePath, modelPath, countText = '2'] = argv.slice(2);
const count = Number(countText);
if (!modulePath || !modelPath || !Number.isInteger(count) || count < 1) {
  console.error('usage: node run-multi-model-slice.mjs <orca_slice.js> <model.stl> [count]');
  process.exit(2);
}

// loadModuleFactory changes the process CWD to the module directory, so make
// the host model path absolute before loading it.
const absoluteModelPath = resolve(modelPath);
const factory = await loadModuleFactory(modulePath);
const Module = await factory({ noInitialRun: true, print: console.error, printErr: console.error });

function callJson(name, argTypes, args) {
  const ptr = Number(Module.ccall(name, 'number', argTypes, args));
  const text = Module.UTF8ToString(ptr);
  Module._free(ptr);
  return JSON.parse(text);
}

const init = callJson('orc_init', ['string'], ['']);
if (!init.ok) throw new Error(`orc_init failed: ${JSON.stringify(init)}`);

const bytes = await readFile(absoluteModelPath);
for (let i = 0; i < count; ++i) {
  const ptr = Number(Module._malloc(bytes.length));
  try {
    Module.HEAPU8.set(bytes, ptr);
    const added = callJson('orc_add_model', ['pointer', 'number', 'string', 'string'],
                           [ptr, bytes.length, 'stl', 'model.stl']);
    if (!added.ok || added.objects !== i + 1)
      throw new Error(`add ${i + 1} failed: ${JSON.stringify(added)}`);
  } finally {
    Module._free(ptr);
  }
}

const result = await callAsyncTask(callJson, 'orc_slice', ['string'], ['{}']);
if (!result.ok) throw new Error(`multi-model slice failed: ${JSON.stringify(result)}`);
console.log(`multi-model slice passed: models=${count}`);
