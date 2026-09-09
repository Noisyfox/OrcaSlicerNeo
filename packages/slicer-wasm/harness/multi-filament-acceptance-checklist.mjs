// Step 8 acceptance inventory and machine-readable command runner.
// Default mode validates and prints the command plan. --run-real executes
// every real-WASM entry for the selected variants; package/build/host entries
// remain explicit delegated gates in the emitted result document.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { argv } from 'node:process';

const root = resolve(import.meta.dirname, '../../..');
const checklistPath = resolve(root, 'packages/slicer-wasm/fixtures/multi-filament/acceptance-checklist.json');
const checklist = JSON.parse(await readFile(checklistPath, 'utf8'));
assert.equal(checklist.schema, 'orca-multi-filament-acceptance-checklist');
assert.equal(checklist.schemaVersion, 1);
assert.equal(checklist.nativeCoreCommit, 'b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde');
assert.equal(checklist.sourcePolicy, 'deterministic-synthetic-only');
assert.ok(Array.isArray(checklist.checks) && checklist.checks.length >= 20);
const ids = new Set();
for (const check of checklist.checks) {
  assert.match(check.id, /^[a-z0-9-]+$/);
  assert.equal(ids.has(check.id), false, `duplicate check id: ${check.id}`);
  ids.add(check.id);
  assert.ok(['node', 'vitest', 'real-wasm', 'build', 'e2e'].includes(check.kind));
  assert.equal(typeof check.command, 'string');
  assert.ok(check.command.length > 0);
  assert.ok(Array.isArray(check.acceptance) && check.acceptance.length > 0);
}
for (const [requirement, evidence] of Object.entries(checklist.coverage)) {
  assert.ok(Array.isArray(evidence) && evidence.length > 0, `${requirement} has no evidence`);
  for (const id of evidence) assert.ok(ids.has(id), `${requirement} references unknown check ${id}`);
}

const runReal = argv.includes('--run-real');
if (argv.includes('--help')) {
  console.log('usage: node multi-filament-acceptance-checklist.mjs [--run-real] [--threaded-only|--serial-only] [--max-parallel N]');
  console.log('development: --threaded-only runs the fast threaded artifact only; default release acceptance always runs serial and threaded.');
  process.exit(0);
}
const variants = argv.includes('--threaded-only') ? ['threaded'] : argv.includes('--serial-only') ? ['serial'] : ['serial', 'threaded'];
const moduleRootIndex = argv.indexOf('--module-root');
const moduleRootArg = moduleRootIndex >= 0 ? argv[moduleRootIndex + 1] : undefined;
const moduleRoot = moduleRootArg ? resolve(root, moduleRootArg) : null;
const forceFailureIndex = argv.indexOf('--force-fail');
const forceFailureId = forceFailureIndex >= 0 ? argv[forceFailureIndex + 1] : undefined;
const parallelIndex = argv.indexOf('--max-parallel');
const requestedParallelism = parallelIndex >= 0 ? Number(argv[parallelIndex + 1]) : 0;
const maxParallel = Number.isSafeInteger(requestedParallelism) && requestedParallelism > 0
  ? requestedParallelism : 8;
const results = [];
const runnerStartedAt = Date.now();

function commandFor(check) {
  const tokens = check.command.trim().split(/\s+/);
  if (tokens.shift() !== 'node' || tokens.length < 2) return null;
  const script = resolve(root, tokens.shift());
  const moduleFlag = tokens.indexOf('--module');
  let modulePath;
  let moduleArgumentStyle;
  if (moduleFlag >= 0 && tokens[moduleFlag + 1]) {
    modulePath = resolve(root, tokens[moduleFlag + 1]);
    moduleArgumentStyle = 'flag';
  } else if (tokens.length > 0 && (script.endsWith('plate-local-slice-smoke.mjs') ||
                                    script.endsWith('history-smoke.mjs'))) {
    modulePath = resolve(root, tokens.shift());
    moduleArgumentStyle = 'positional';
  } else {
    return null;
  }
  const variant = modulePath.match(/[\\/]out[\\/](serial|threaded)[\\/]orca_slice\.js$/)?.[1];
  if (moduleRoot && variant) modulePath = resolve(moduleRoot, variant, 'orca_slice.js');
  if (forceFailureId === check.id) modulePath = resolve(root, 'packages/slicer-wasm/out/__acceptance_missing__/orca_slice.js');
  const args = [script];
  const scriptArgs = moduleArgumentStyle === 'positional'
    ? [modulePath, ...tokens]
    : (() => {
      tokens[moduleFlag] = '--module';
      tokens[moduleFlag + 1] = modulePath;
      return tokens;
    })();
  if (moduleArgumentStyle === 'positional') args.push(...scriptArgs);
  else {
    args.push(...scriptArgs);
  }
  return { executable: process.execPath, args, script, scriptArgs,
    display: `node ${args.map((arg) => JSON.stringify(arg)).join(' ')}` };
}

function isSelectedRealCheck(check) {
  if (check.id === 'plate-local-result-safety') return variants.includes('serial');
  return check.kind === 'real-wasm' && variants.some((variant) => check.id.endsWith(`-${variant}`));
}

async function run(check) {
  const command = commandFor(check);
  if (!command) return {
    id: check.id,
    status: 'fail',
    command: check.command,
    acceptance: check.acceptance,
    error: 'unsupported real-WASM command form',
  };
  const started = Date.now();
  const output = await new Promise((resolveResult) => {
    const child = spawn(command.executable, command.args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
  return {
    id: check.id,
    status: output.code === 0 ? 'pass' : 'fail',
    exitCode: output.code,
    signal: output.signal,
    durationMs: Date.now() - started,
    command: command.display,
    acceptance: check.acceptance,
    output: `${output.stdout}${output.stderr}`.slice(-4000),
  };
}

async function runBounded(checks) {
  const output = new Map();
  let next = 0;
  const workers = Array.from({ length: Math.min(maxParallel, checks.length) }, async () => {
    while (next < checks.length) {
      const check = checks[next++];
      output.set(check.id, await run(check));
    }
  });
  await Promise.all(workers);
  return output;
}

if (forceFailureId) {
  assert.ok(ids.has(forceFailureId), `--force-fail references unknown check ${forceFailureId}`);
  for (const check of checklist.checks) {
    results.push(check.id === forceFailureId
      ? { id: check.id, status: 'fail', command: check.command, acceptance: check.acceptance, error: 'forced acceptance-runner failure probe' }
      : { id: check.id, status: 'not-run', command: check.command, acceptance: check.acceptance, reason: 'failure probe stops before execution' });
  }
} else if (runReal) {
  const executable = checklist.checks.filter((check) => check.kind === 'real-wasm' && isSelectedRealCheck(check));
  const executed = await runBounded(executable);
  for (const check of checklist.checks) {
    if (check.kind !== 'real-wasm') {
      results.push({ id: check.id, status: 'delegated', command: check.command, acceptance: check.acceptance, reason: 'executed by its owning package/build/host gate' });
    } else if (!isSelectedRealCheck(check)) {
      results.push({ id: check.id, status: 'not-selected', command: check.command, acceptance: check.acceptance, reason: `variant selection: ${variants.join(', ')}` });
    } else {
      results.push(executed.get(check.id));
    }
  }
} else {
  for (const check of checklist.checks) results.push({ id: check.id, status: 'planned', command: check.command, acceptance: check.acceptance });
}
const failed = results.filter((result) => result.status === 'fail');
const wallClockMs = Date.now() - runnerStartedAt;
if (runReal && !forceFailureId && wallClockMs > 120_000) {
  results.push({ id: 'runner-wall-clock', status: 'fail', command: 'real-WASM acceptance runner',
    acceptance: ['prebuilt-wall-clock-under-120000ms'], durationMs: wallClockMs,
    error: `real-WASM acceptance exceeded 120000ms (${wallClockMs}ms)` });
}
console.log(JSON.stringify({
  schema: 'orca-multi-filament-acceptance-results', schemaVersion: 1,
  nativeCoreCommit: checklist.nativeCoreCommit, mode: forceFailureId ? 'failure-probe' : runReal ? 'real-wasm' : 'plan', variants,
  maxParallel, wallClockMs, results, failed: results.filter((result) => result.status === 'fail').map(({ id }) => id),
}, null, 2));
if (results.some((result) => result.status === 'fail')) process.exitCode = 1;
