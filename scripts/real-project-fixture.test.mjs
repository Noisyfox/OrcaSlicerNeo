import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import {
  EXPECTED_FIXTURE_BASENAME,
  EXPECTED_FIXTURE_PATH,
  EXPECTED_FIXTURE_BYTES,
  EXPECTED_FIXTURE_SHA256,
  assertExpectedFixture,
  assertExpectedFixtureIdentity,
  assertFixtureUnchanged,
  createFixtureCopy,
  fixturePathIsDistinctCopy,
  fixturePathIsExpectedSource,
  readFixtureIdentity,
} from './real-project-fixture.mjs';

test('pins the immutable source fixture by basename, byte length, and SHA-256', async () => {
  assert.equal(fixturePathIsExpectedSource(EXPECTED_FIXTURE_PATH), true);
  const identity = await assertExpectedFixture(EXPECTED_FIXTURE_PATH, 'source fixture');
  assert.deepEqual(identity, { bytes: EXPECTED_FIXTURE_BYTES, sha256: EXPECTED_FIXTURE_SHA256 });
});

test('creates a fresh same-basename copy and detects mismatched identities', async () => {
  const staged = await createFixtureCopy();
  try {
    assert.notEqual(staged.copyPath.toLowerCase(), staged.sourcePath.toLowerCase());
    assert.equal(fixturePathIsDistinctCopy(staged.copyPath, staged.sourcePath), true);
    assert.equal(staged.copyPath.endsWith(EXPECTED_FIXTURE_BASENAME), true);
    assert.deepEqual(await readFixtureIdentity(staged.copyPath), staged.sourceIdentity);

    const bytes = await readFile(staged.copyPath);
    bytes[0] ^= 0xff;
    await writeFile(staged.copyPath, bytes);
    await assert.rejects(
      () => assertExpectedFixture(staged.copyPath, 'temporary fixture copy'),
      /temporary fixture copy identity mismatch/,
    );
    await assertFixtureUnchanged(staged.sourcePath, staged.sourceIdentity);
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('rejects a fixture identity that has the expected size but wrong content', () => {
  assert.throws(
    () => assertExpectedFixtureIdentity({ bytes: EXPECTED_FIXTURE_BYTES, sha256: '0'.repeat(64) }),
    /fixture identity mismatch/,
  );
});
