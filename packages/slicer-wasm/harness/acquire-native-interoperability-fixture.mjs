// Explicit acquisition/check tool for the Step 9 native fixture. This file is
// never imported by vitest, package scripts, or release automation.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { argv } from 'node:process';

const fixtureRoot = resolve(import.meta.dirname, '../fixtures/native-interoperability');
const manifestPath = resolve(fixtureRoot, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const fixture = manifest.fixture;
const destination = resolve(fixtureRoot, fixture.filename);
const fromIndex = argv.indexOf('--from');
const source = fromIndex >= 0 ? argv[fromIndex + 1] : null;

function describeExpected() {
  if (!Number.isSafeInteger(fixture.size) || fixture.size <= 0 ||
      !/^[0-9a-f]{64}$/.test(fixture.sha256)) {
    throw new Error('manifest must contain a real positive size and 64-character lowercase sha256 before acquisition');
  }
}

async function check(path) {
  let bytes;
  try { bytes = await readFile(path); } catch { return { ok: false, reason: 'missing' }; }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== fixture.size) return { ok: false, reason: `size ${bytes.length} != ${fixture.size}` };
  if (sha256 !== fixture.sha256) return { ok: false, reason: `sha256 ${sha256} != ${fixture.sha256}` };
  return { ok: true };
}

if (source) {
  describeExpected();
  await mkdir(dirname(destination), { recursive: true });
  const state = await check(resolve(source));
  if (!state.ok) throw new Error(`source fixture is not the pinned archive: ${state.reason}`);
  await copyFile(resolve(source), destination);
}

const state = await check(destination);
if (!state.ok) {
  console.error(`FAIL ${fixture.id}: ${state.reason}`);
  console.error('Acquire the native archive with --from, then run --check.');
  process.exitCode = 1;
} else {
  console.log(`PASS ${fixture.id} ${fixture.filename}`);
}
