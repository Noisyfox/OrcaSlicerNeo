// ----------------------------------------------------------------
// ------------ Node harness: drive the WASM slicer ---------------
// ----------------------------------------------------------------
// Loads an Emscripten module (MODULARIZE + EXPORT_ES6), stages a model + config
// into MEMFS, runs the CLI via callMain, reads the G-code back out, and
// validates it. The engine-agnostic runSlice() is exported so it can be tested
// against a mock module before the real build exists (see selftest.mjs).
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { argv } from 'node:process';

// Runs one slice against a module factory. `stagedFiles` maps MEMFS paths to
// Uint8Array/Buffer contents; returns the exit code and output bytes.
export async function runSlice({ createModule, stagedFiles, mainArgs, outputPath, onLog }) {
  const logs = [];
  const record = (line) => {
    logs.push(line);
    if (onLog) onLog(line);
  };

  const Module = await createModule({
    noInitialRun: true,
    print: record,
    printErr: record,
  });

  for (const [path, data] of Object.entries(stagedFiles)) {
    Module.FS.writeFile(path, data);
  }

  let exitCode = 0;
  try {
    const returned = Module.callMain(mainArgs);
    exitCode = typeof returned === 'number' ? returned : 0;
  } catch (error) {
    // Emscripten throws ExitStatus on exit(); treat its status as the code.
    if (error && typeof error.status === 'number') {
      exitCode = error.status;
    } else {
      throw error;
    }
  }

  let output = null;
  try {
    output = Module.FS.readFile(outputPath);
  } catch {
    output = null;
  }

  return { exitCode, output, logs };
}

// Validates a slice output buffer looks like real G-code.
export function validateGcode(output) {
  if (!output || output.length === 0) {
    return { ok: false, reason: 'no output written' };
  }
  const text = Buffer.from(output).toString('utf8');
  const hasMove = /^\s*G[01]\b/m.test(text);
  const lineCount = text.split('\n').length;
  if (!hasMove) {
    return { ok: false, reason: 'no G0/G1 movement commands found', lineCount };
  }
  return { ok: true, lineCount, bytes: output.length };
}

// Prints spot-check evidence for the slice brief's Step 3: the first G-code
// lines, the first G1 extrusion move (X/Y + E), and the Z-step spacing between
// layers (layer_height consistency). Diagnostic only — the exit-code contract
// stays with validateGcode().
function spotCheckGcode(output) {
  const lines = Buffer.from(output).toString('utf8').split('\n');
  const extrusion = lines.find((l) => /^\s*G1\s+X[\d.-]+\s+Y[\d.-]+\s+E[\d.-]+/.test(l));
  const zLevels = [...new Set(
    lines
      .filter((l) => /^\s*G1\s+Z[\d.]+\b/.test(l))
      .map((l) => parseFloat(l.match(/Z([\d.]+)/)[1]))
  )].sort((a, b) => a - b);
  const zSteps = [...new Set(zLevels.slice(1).map((z, i) => +(z - zLevels[i]).toFixed(4)))];
  console.log('spot-check: first G-code lines:');
  console.log(lines.slice(0, 5).join('\n'));
  console.log(`spot-check: first extrusion move: ${extrusion ?? '(none found)'}`);
  const range = zLevels.length ? `${zLevels[0]}..${zLevels[zLevels.length - 1]}` : 'n/a';
  console.log(`spot-check: Z levels: ${zLevels.length} (${range}), step(s): ${zSteps.join(', ') || 'n/a'}`);
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (key) out[key] = args[i + 1];
  }
  return out;
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  const { module, stl, config, out = '/out.gcode' } = opts;
  if (!module || !stl || !config) {
    console.error(
      'usage: node run-slice.mjs --module out/orca_slice.js --stl fixtures/cube.stl --config fixtures/config.json'
    );
    process.exit(2);
  }

  const factory = (await import(pathToFileURL(module).href)).default;
  // The BBS fork of libslic3r only loads .json configs (load_from_ini was
  // removed); stage the config under its real basename so is_json_file()
  // picks it up. e.g. --config fixtures/config.json -> /config.json.
  const configName = config.split(/[\\/]/).pop();
  const configPath = `/${configName}`;
  const result = await runSlice({
    createModule: factory,
    stagedFiles: {
      '/model.stl': await readFile(stl),
      [configPath]: await readFile(config),
    },
    mainArgs: ['/model.stl', configPath, out],
    outputPath: out,
    onLog: (line) => console.error(`[wasm] ${line}`),
  });

  const check = validateGcode(result.output);
  console.log(`exit code: ${result.exitCode}`);
  console.log(`gcode: ${check.ok ? `OK (${check.bytes} bytes, ${check.lineCount} lines)` : `FAIL (${check.reason})`}`);
  if (check.ok) spotCheckGcode(result.output);
  process.exit(check.ok && result.exitCode === 0 ? 0 : 1);
}

// Run as CLI only when invoked directly (not when imported by tests).
if (import.meta.url === pathToFileURL(argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
