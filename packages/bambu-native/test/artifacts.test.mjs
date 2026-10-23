import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { test } from 'node:test';
import { acquire, manifest } from '../scripts/acquire.mjs';

test('rejects a corrupted cached artifact before extraction or replacement', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'neo-bambu-artifact-'));
  try {
    const artifact = manifest.artifacts['darwin-arm64'];
    await writeFile(join(cache, `${manifest.release}-${basename(artifact.url)}`), 'corrupted');
    await assert.rejects(acquire('darwin-arm64', cache), /checksum mismatch/);
  } finally { await rm(cache, { recursive: true, force: true }); }
});

test('does not substitute an unpinned platform artifact', async () => {
  await assert.rejects(acquire('unknown-architecture'), /No pinned Bambu plugin/);
});
