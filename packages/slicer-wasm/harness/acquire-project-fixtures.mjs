// Acquire the pinned external 3MF compatibility fixtures and verify bytes.
// The archives are deliberately not checked in; this is the single controlled
// acquisition path used by local release verification and CI.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { argv } from 'node:process';

const root = resolve(import.meta.dirname, '../fixtures/project-compatibility');
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const download = argv.includes('--download');
const checkOnly = argv.includes('--check') || !download;

async function verify(path, fixture) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== fixture.size) return { ok: false, reason: `size ${bytes.length} != ${fixture.size}` };
  if (sha256 !== fixture.sha256) return { ok: false, reason: `sha256 ${sha256} != ${fixture.sha256}` };
  return { ok: true };
}

let failures = 0;
await mkdir(root, { recursive: true });
for (const fixture of manifest.fixtures) {
  const path = resolve(root, fixture.filename);
  let state = await verify(path, fixture);
  if (!state.ok && download) {
    const response = await fetch(fixture.url, { redirect: 'error' });
    if (!response.ok) throw new Error(`${fixture.id}: download failed (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(path, bytes);
    state = await verify(path, fixture);
  }
  if (state.ok) {
    console.log(`PASS ${fixture.id} ${fixture.filename}`);
  } else {
    failures++;
    console.error(`FAIL ${fixture.id}: ${state.reason}; run with --download or provide the pinned archive`);
  }
}

if (failures) {
  console.error(`project fixture acquisition/check failed: ${failures} fixture(s)`);
  process.exitCode = 1;
} else if (checkOnly) {
  console.log('project fixture check OK');
}
