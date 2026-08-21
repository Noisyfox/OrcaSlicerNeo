// ----------------------------------------------------------------
// ------------ Node harness: drive the WASM slicer ---------------
// ----------------------------------------------------------------
// Loads an Emscripten module (MODULARIZE + EXPORT_ES6), stages a model + config
// into MEMFS, runs the CLI via callMain, reads the G-code back out, and
// validates it. The engine-agnostic runSlice() is exported so it can be tested
// against a mock module before the real build exists (see selftest.mjs).
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argv, chdir } from 'node:process';

// Runs one slice against a module factory. `stagedFiles` maps MEMFS paths to
// Uint8Array/Buffer contents; returns the exit code, output bytes, captured
// console output, and (with `readFiles`) the named MEMFS files read back
// after the run (null when absent).
export async function runSlice({ createModule, stagedFiles, mainArgs, outputPath, readFiles = [], onLog }) {
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

  const extraFiles = {};
  for (const path of readFiles) {
    try {
      extraFiles[path] = Module.FS.readFile(path);
    } catch {
      extraFiles[path] = null;
    }
  }

  return { exitCode, output, logs, extraFiles };
}

// Derives the MEMFS invocation from host fixture paths. main() and the
// self-test share this so a regression that passes a HOST path into mainArgs
// (the C++ side can never open it inside its virtual FS — config.load() gets
// an empty stream and dies with "parse error ... unexpected end of input")
// fails the self-test instead of the next 40-minute CI cycle.
export function buildSliceArgs(stlPath, configPath, out = '/out.gcode') {
  const configName = configPath.split(/[\\/]/).pop();
  return {
    stlMemfsPath: '/model.stl',
    configMemfsPath: `/${configName}`,
    mainArgs: ['/model.stl', `/${configName}`, out],
  };
}

// Loads the module factory with the process anchored to the module's own
// directory. Emscripten's Node runtime resolves the preload-file bundle
// (.data) as a bare CWD-relative path (scriptDirectory is empty in the
// dynamic-import ESM path) — without this, `open 'orca_slice.data'` fails
// with ENOENT whenever the harness runs outside out/. Host-side paths passed
// by callers are resolved to absolutes first, so chdir cannot break them.
export async function loadModuleFactory(modulePath) {
  const abs = resolve(modulePath);
  chdir(dirname(abs));
  return (await import(pathToFileURL(abs).href)).default;
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
  const { module, stl, config, out = '/out.gcode', loglevel = 'info' } = opts;
  if (!module || !stl || !config) {
    console.error(
      'usage: node run-slice.mjs --module out/orca_slice.js --stl fixtures/cube.stl --config fixtures/config.json [--loglevel trace|debug|info|warning|error|fatal]'
    );
    process.exit(2);
  }

  // Boost.Log spot-check (doc/2026-08-21-wasm-boost-log.md): slice_main reads
  // globalThis.ORCA_LOG_LEVEL at main() to set the severity filter; the file
  // sink writes every accepted record to /tmp/orca.log (MEMFS). Levels up to
  // info guarantee records (libslic3r logs config parsing at info); for
  // warning/error/fatal an empty file is legitimate, so the check is
  // informational then.
  globalThis.ORCA_LOG_LEVEL = loglevel;

  // Fixture paths must be absolutized BEFORE loadModuleFactory chdirs —
  // resolve() against the old CWD would silently join the module dir instead.
  const stlPath = resolve(stl);
  const configPath = resolve(config);
  const factory = await loadModuleFactory(module);
  // The BBS fork of libslic3r only loads .json configs (load_from_ini was
  // removed); stage the config under its real basename so is_json_file()
  // picks it up. e.g. --config fixtures/config.json -> /config.json.
  const inv = buildSliceArgs(stlPath, configPath, out);
  const result = await runSlice({
    createModule: factory,
    stagedFiles: {
      [inv.stlMemfsPath]: await readFile(stlPath),
      [inv.configMemfsPath]: await readFile(configPath),
    },
    mainArgs: inv.mainArgs,
    outputPath: out,
    readFiles: ['/tmp/orca.log'],
    onLog: (line) => console.error(`[wasm] ${line}`),
  });

  const check = validateGcode(result.output);
  console.log(`exit code: ${result.exitCode}`);
  console.log(`gcode: ${check.ok ? `OK (${check.bytes} bytes, ${check.lineCount} lines)` : `FAIL (${check.reason})`}`);
  if (check.ok) spotCheckGcode(result.output);

  // Boost.Log evidence: console records that match the C++ formatter's
  // [%Y-%m-%d ...] prefix, and the file sink's MEMFS output.
  const consoleRecords = result.logs.filter((l) => /^\[\d{4}-\d{2}-\d{2}/.test(l));
  const logBytes = result.extraFiles['/tmp/orca.log'];
  const logText = logBytes ? Buffer.from(logBytes).toString('utf8') : '';
  const logLines = logText ? logText.split('\n').filter((l) => l.trim()) : [];
  const strictLog = ['trace', 'debug', 'info'].includes(loglevel);
  const logOk = logLines.length > 0;
  console.log(`log: file ${logOk ? `OK (${logBytes.length} bytes, ${logLines.length} records)` : `FAIL (${logBytes ? 'no records' : 'no /tmp/orca.log'})`}; console records: ${consoleRecords.length}`);
  if (logLines.length > 0) {
    console.log('log: first records:');
    console.log(logLines.slice(0, 3).join('\n'));
  }

  process.exit(check.ok && result.exitCode === 0 && (!strictLog || logOk) ? 0 : 1);
}

// Run as CLI only when invoked directly (not when imported by tests).
if (import.meta.url === pathToFileURL(argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
