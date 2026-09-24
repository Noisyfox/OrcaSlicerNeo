// Test/profile-only identity and staging helpers for the repository's real
// project fixture. Production code must not import this module.
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile } from 'node:fs/promises';
import { basename, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

export const EXPECTED_FIXTURE_PATH = resolve(
  import.meta.dirname,
  '..',
  'packages',
  'slicer-wasm',
  'fixtures',
  'big-proj.3mf',
);
export const EXPECTED_FIXTURE_BASENAME = basename(EXPECTED_FIXTURE_PATH);
export const EXPECTED_FIXTURE_BYTES = 44_473_498;
export const EXPECTED_FIXTURE_SHA256 =
  'de8afeac2e7b53a63fe5925d8b05ddfe0c0b7f0a7b3f88fbc2a5fc29c0524ce0';

export function fixtureIdentity(bytes) {
  return {
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function readFixtureIdentity(path) {
  const bytes = await readFile(resolve(path));
  return fixtureIdentity(bytes);
}

export function expectedFixtureIdentity() {
  return { bytes: EXPECTED_FIXTURE_BYTES, sha256: EXPECTED_FIXTURE_SHA256 };
}

export function assertExpectedFixtureIdentity(identity, label = 'fixture') {
  const expected = expectedFixtureIdentity();
  if (identity.bytes !== expected.bytes || identity.sha256 !== expected.sha256) {
    throw new Error(
      `${label} identity mismatch: expected ${expected.bytes} bytes sha256 ${expected.sha256}, ` +
      `got ${identity.bytes} bytes sha256 ${identity.sha256}`,
    );
  }
  return identity;
}

export async function assertExpectedFixture(path, label = 'fixture') {
  const identity = await readFixtureIdentity(path);
  return assertExpectedFixtureIdentity(identity, label);
}

/**
 * Verify the immutable source and copy it to a newly-created temporary
 * directory under the fixture's original basename.  The returned directory
 * is intentionally left for the caller to remove after the profile exits so
 * the profile output can be inspected on failure.
 */
export async function createFixtureCopy({ source = EXPECTED_FIXTURE_PATH, parent = tmpdir() } = {}) {
  const sourcePath = resolve(source);
  if (basename(sourcePath).toLowerCase() !== EXPECTED_FIXTURE_BASENAME.toLowerCase()) {
    throw new Error(`fixture source must retain the expected basename: ${EXPECTED_FIXTURE_BASENAME}`);
  }
  const sourceIdentity = await assertExpectedFixture(sourcePath, 'source fixture');
  const root = await mkdtemp(join(resolve(parent), 'orca-real-project-profile-'));
  const copyPath = join(root, EXPECTED_FIXTURE_BASENAME);
  await copyFile(sourcePath, copyPath);
  const copyIdentity = await assertExpectedFixture(copyPath, 'temporary fixture copy');
  return { root, sourcePath, copyPath, sourceIdentity, copyIdentity };
}

export async function assertFixtureUnchanged(path, expected = expectedFixtureIdentity()) {
  const actual = await readFixtureIdentity(path);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw new Error(
      `fixture changed during profile: expected ${expected.bytes} bytes sha256 ${expected.sha256}, ` +
      `got ${actual.bytes} bytes sha256 ${actual.sha256}`,
    );
  }
  return actual;
}

export function fixturePathIsExpectedSource(path) {
  return resolve(path).toLowerCase() === EXPECTED_FIXTURE_PATH.toLowerCase();
}

export function fixturePathIsDistinctCopy(path, source = EXPECTED_FIXTURE_PATH) {
  const copyPath = resolve(path);
  return copyPath.toLowerCase() !== resolve(source).toLowerCase() &&
    basename(copyPath).toLowerCase() === EXPECTED_FIXTURE_BASENAME.toLowerCase();
}
