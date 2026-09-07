#!/usr/bin/env node
// Deterministic Step 9 handoff matrix.  Keep host runs sequential: the Web
// threaded/serial jobs share staged assets and must not race on dist/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const isWindows = process.platform === 'win32';
const runner = isWindows ? 'cmd.exe' : 'bash';
const reportPath = resolve(root, process.env.ORCA_UNDO_REDO_GATE_REPORT ??
  '.work/undo-redo-release-gates.json');
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';
const wasmDriver = isWindows ? ['scripts\\build-windows.bat'] : ['scripts/build.sh'];
const command = (name, args, required = true) => ({ name, args, required });
const gates = [
  command('pnpm test', [pnpm, 'test']),
  command('pnpm typecheck', [pnpm, 'typecheck']),
  command('WASM dual quick', [runner, ...(isWindows ? ['/c', ...wasmDriver, 'quick'] : [...wasmDriver, 'quick'])]),
  command('WASM dual smoke', [runner, ...(isWindows ? ['/c', ...wasmDriver, 'smoke'] : [...wasmDriver, 'smoke'])]),
  command('Desktop E2E', [pnpm, '--filter', '@orca/desktop', 'test:e2e']),
  command('Web threaded E2E', [pnpm, '--filter', '@orca/web', 'test:e2e:threaded']),
  command('Web serial E2E', [pnpm, '--filter', '@orca/web', 'test:e2e:serial']),
];

const started = new Date().toISOString();
const results = [];
for (const gate of gates) {
  const startedAt = new Date().toISOString();
  const [file, ...args] = gate.args;
  const result = spawnSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  results.push({
    name: gate.name,
    command: gate.args.join(' '),
    required: gate.required,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.status,
    signal: result.signal,
    passed: result.status === 0,
    output,
  });
  process.stdout.write(`\n[undo-redo] ${gate.name}: ${result.status === 0 ? 'PASS' : 'FAIL'}\n`);
  if (result.status !== 0) {
    process.stdout.write(output.slice(-4000));
    break;
  }
}

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify({
  version: 1, startedAt: started, finishedAt: new Date().toISOString(),
  passed: results.length === gates.length && results.every((result) => result.passed),
  gates: results,
}, null, 2));
process.exitCode = results.length === gates.length && results.every((result) => result.passed) ? 0 : 1;
