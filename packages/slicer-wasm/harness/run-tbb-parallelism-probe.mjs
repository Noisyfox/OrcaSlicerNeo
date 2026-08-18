// Runs the standalone threaded oneTBB proof. The module factory is async when
// Emscripten pre-creates its pthread pool, so await it before calling main.
import { pathToFileURL } from 'node:url';
import { argv, chdir } from 'node:process';
import { dirname, resolve } from 'node:path';

const modulePath = resolve(argv[2] ?? 'out/orca_tbb_probe.js');
chdir(dirname(modulePath));
const imported = await import(pathToFileURL(modulePath).href);
const createModule = imported.default;
const lines = [];
const Module = await createModule({
  noInitialRun: true,
  print: (line) => lines.push(String(line)),
  printErr: (line) => lines.push(String(line)),
});

let exitCode = 0;
try {
  const returned = Module.callMain([]);
  exitCode = typeof returned === 'number' ? returned : 0;
} catch (error) {
  if (typeof error?.status === 'number') exitCode = error.status;
  else throw error;
}

const result = lines.find((line) => line.startsWith('ORCA_TBB_WORKERS='));
if (!result) throw new Error(`oneTBB probe did not report workers:\n${lines.join('\n')}`);
const workers = Number(/ORCA_TBB_WORKERS=(\d+)/.exec(result)?.[1]);
if (exitCode !== 0 || !Number.isInteger(workers) || workers < 2)
  throw new Error(`oneTBB parallelism probe failed (exit=${exitCode}): ${result}`);
console.log(`oneTBB parallelism probe passed: ${result}`);
