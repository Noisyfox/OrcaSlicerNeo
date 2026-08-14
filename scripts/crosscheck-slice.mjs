// scripts/crosscheck-slice.mjs — compare the WASM module's G-code output
// against desktop OrcaSlicer's for the same model/profile (Grand Plan M3:
// "Slice-output cross-check vs desktop OrcaSlicer"). Numeric tolerances, not
// byte equality — the module pins a different libslic3r SHA than desktop.
//
// Usage:
//   node scripts/crosscheck-slice.mjs <wasm.gcode> <desktop.gcode>
//
// Exit 0 = PASS (all comparisons within tolerance); 1 = FAIL with a report.
// Executed manually on an emsdk machine with desktop OrcaSlicer installed
// (headless export: orca-slicer --export-gcode --output out.gcode
//  --load profile.ini cube.stl) — see doc/2026-08-14-m3-implementation-notes.md.
import { readFileSync } from 'node:fs';

const FILAMENT_RE = /; total filament used \[mm\^3\] = ([\d.]+)/;
const LAYER_COUNT_RE = /;LAYER_COUNT:(\d+)/;
const TIME_RE = /; total estimated printing time .* = (\d+)/;

const [wasmPath, desktopPath] = process.argv.slice(2);
if (!wasmPath || !desktopPath) {
  console.error('usage: node scripts/crosscheck-slice.mjs <wasm.gcode> <desktop.gcode>');
  process.exit(2);
}

function parse(path) {
  const text = readFileSync(path, 'utf8');
  const layerCount = Number(text.match(LAYER_COUNT_RE)?.[1]);
  const filament = Number(text.match(FILAMENT_RE)?.[1]);
  const printTimeMin = Number(text.match(TIME_RE)?.[1]);
  const g1Moves = (text.match(/G1 /g) ?? []).length;
  return { path, text, layerCount, filament, printTimeMin, g1Moves };
}

function check(ok, label, actual, expected, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${label}: wasm=${actual} desktop=${expected}${detail ? ' — ' + detail : ''}`);
  return ok;
}

const wasm = parse(wasmPath);
const desktop = parse(desktopPath);
let pass = true;

pass = check(wasm.g1Moves > 0, 'extruder moves present', wasm.g1Moves, desktop.g1Moves, 'wasm must contain G1 moves') && pass;
pass = check(wasm.layerCount === desktop.layerCount, 'layer count', wasm.layerCount, desktop.layerCount) && pass;
if (Number.isFinite(wasm.filament) && Number.isFinite(desktop.filament)) {
  const rel = Math.abs(wasm.filament - desktop.filament) / desktop.filament;
  pass = check(rel <= 0.05, 'total filament (5% tolerance)', wasm.filament.toFixed(2), desktop.filament.toFixed(2), `rel diff ${(rel * 100).toFixed(2)}%`) && pass;
} else {
  console.log('SKIP  total filament — missing from one output (profile differs?)');
}

console.log(pass ? '\nCROSS-CHECK: PASS' : '\nCROSS-CHECK: FAIL');
process.exit(pass ? 0 : 1);
