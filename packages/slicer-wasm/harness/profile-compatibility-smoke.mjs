// ----------------------------------------------------------------
// ---- Deterministic native profile-compatibility smoke test ------
// ----------------------------------------------------------------
// Builds the checked-in minimal FDM profile source into the same versioned
// package layout that hosts install, then drives the real C++ bridge. This is
// intentionally independent of upstream profile names and ordering.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { argv } from 'node:process';
import { promisify } from 'node:util';
import { createNodeProfileSource, installProfilePackages } from './profile-installer.mjs';
import { loadModuleFactory } from './run-slice.mjs';

const run = promisify(execFile);
const moduleArg = argv[2];
if (!moduleArg) {
  console.error('usage: node profile-compatibility-smoke.mjs <out/orca_slice.js>');
  process.exit(2);
}

const fixtureSource = resolve(import.meta.dirname, 'fixtures/compatibility-profiles');
const packageBuilder = resolve(import.meta.dirname, '../../profile-resources/scripts/build.mjs');

function callJson(Module, name, argTypes = [], args = []) {
  const ptr = Number(Module.ccall(name, 'number', argTypes, args));
  const text = Module.UTF8ToString(ptr);
  Module._free(ptr);
  return JSON.parse(text);
}

function names(snapshot, kind) {
  return snapshot[`${kind}s`].map((preset) => preset.name);
}

function assertSnapshot(snapshot, expected) {
  assert.equal(snapshot.ok, true, `expected successful snapshot: ${JSON.stringify(snapshot)}`);
  assert.deepEqual(names(snapshot, 'printer'), expected.printers, 'printer candidates/order');
  assert.deepEqual(names(snapshot, 'print'), expected.prints, 'process candidates/order');
  assert.deepEqual(names(snapshot, 'filament'), expected.filaments, 'filament candidates/order');
  assert.equal(snapshot.printer.name, expected.printer, 'resolved printer');
  assert.equal(snapshot.print.name, expected.print, 'resolved process');
  assert.equal(snapshot.filament.name, expected.filament, 'resolved filament');
}

const packageRoot = await mkdtemp(join(tmpdir(), 'orca-profile-compatibility-'));
try {
  await run(process.execPath, [packageBuilder], {
    env: {
      ...process.env,
      ORCA_PROFILES_DIR: fixtureSource,
      ORCA_PROFILE_OUTPUT: packageRoot,
      ORCA_PROFILE_VERSION: 'compatibility-fixture-1',
    },
  });

  const factory = await loadModuleFactory(moduleArg);
  const Module = await factory({ noInitialRun: true, print: console.error, printErr: console.error });
  await installProfilePackages(Module, createNodeProfileSource(packageRoot));

  const init = callJson(Module, 'orc_init', ['string'], ['']);
  assert.equal(init.ok, true, `orc_init failed: ${JSON.stringify(init)}`);

  // Alpha is first in native collection order. Its explicit default selects
  // the name-list-compatible process and filament. The condition-based
  // process is also visible because Alpha's printer_notes satisfies it. Its
  // printer-specific Generic PLA supersedes the OrcaFilamentLibrary generic.
  let snapshot = callJson(Module, 'orc_get_preset_snapshot');
  assertSnapshot(snapshot, {
    printers: ['Compatibility Alpha 0.4 nozzle', 'Compatibility Beta 0.4 nozzle'],
    prints: ['Alpha Condition Process', 'Alpha Explicit Process'],
    filaments: ['Generic PLA @Compatibility Alpha', 'Alpha Explicit Filament'],
    printer: 'Compatibility Alpha 0.4 nozzle',
    print: 'Alpha Explicit Process',
    filament: 'Alpha Explicit Filament',
  });

  // A process change must recalculate the filament candidates against both
  // the active printer and the new process. This exercises compatible_prints
  // together with compatible_printers_condition on the filament.
  snapshot = callJson(Module, 'orc_select_preset', ['string', 'string'],
    ['print', 'Alpha Condition Process']);
  assertSnapshot(snapshot, {
    printers: ['Compatibility Alpha 0.4 nozzle', 'Compatibility Beta 0.4 nozzle'],
    prints: ['Alpha Condition Process', 'Alpha Explicit Process'],
    filaments: ['Generic PLA @Compatibility Alpha', 'Alpha Condition Filament'],
    printer: 'Compatibility Alpha 0.4 nozzle',
    print: 'Alpha Condition Process',
    filament: 'Generic PLA @Compatibility Alpha',
  });

  // Switching to Beta makes both selected Alpha profiles incompatible. The
  // C++ profile engine performs the printer -> process -> filament fallback
  // before the bridge emits its replacement snapshot. With no Beta-specific
  // Generic PLA, the installed OrcaFilamentLibrary generic is available.
  snapshot = callJson(Module, 'orc_select_preset', ['string', 'string'],
    ['printer', 'Compatibility Beta 0.4 nozzle']);
  assertSnapshot(snapshot, {
    printers: ['Compatibility Alpha 0.4 nozzle', 'Compatibility Beta 0.4 nozzle'],
    prints: ['Beta Explicit Process'],
    filaments: ['Generic PLA @System', 'Beta Explicit Filament'],
    printer: 'Compatibility Beta 0.4 nozzle',
    print: 'Beta Explicit Process',
    filament: 'Generic PLA @System',
  });

  // The native list and condition rules must also be enforced by the bridge
  // guard: an Alpha process is not silently substituted when stale UI asks
  // for it after the printer transition.
  const beforeRejected = JSON.stringify(snapshot);
  const rejected = callJson(Module, 'orc_select_preset', ['string', 'string'],
    ['print', 'Alpha Explicit Process']);
  assert.equal(rejected.ok, undefined, `incompatible process unexpectedly selected: ${JSON.stringify(rejected)}`);
  assert.match(rejected.error, /incompatible/);
  assert.equal(JSON.stringify(callJson(Module, 'orc_get_preset_snapshot')), beforeRejected,
    'rejected selection must not mutate the resolved snapshot');

  console.log('profile compatibility smoke OK: explicit lists, conditions, compatible prints, and native fallback');
} finally {
  await rm(packageRoot, { recursive: true, force: true });
}
