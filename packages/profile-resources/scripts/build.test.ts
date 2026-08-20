import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const script = resolve(import.meta.dirname, 'build.mjs');
const fixture = resolve(import.meta.dirname, '../fixtures/upstream');

async function build(source: string, version = 'fixture-1') {
  const output = await mkdtemp(join(tmpdir(), 'orca-profile-pack-'));
  await run(process.execPath, [script], { env: { ...process.env, ORCA_PROFILES_DIR: source, ORCA_PROFILE_OUTPUT: output, ORCA_PROFILE_VERSION: version } });
  return output;
}

function archiveEntries(data: Uint8Array): string[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const entries: string[] = [];
  let p = 0;
  while (p + 30 <= data.byteLength && view.getUint32(p, true) === 0x04034b50) {
    const nameLength = view.getUint16(p + 26, true);
    const extraLength = view.getUint16(p + 28, true);
    const size = view.getUint32(p + 18, true);
    entries.push(new TextDecoder().decode(data.subarray(p + 30, p + 30 + nameLength)));
    p += 30 + nameLength + extraLength + size;
  }
  return entries;
}

describe('profile package layout', () => {
  it('derives core/vendor ownership and preserves relative paths', async () => {
    const output = await build(fixture);
    try {
      const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
      expect(manifest.packages).toEqual([
        { id: 'core', kind: 'core', path: 'core.fixture-1.zip' },
        { id: 'Creality', kind: 'vendor', path: 'vendors/Creality.fixture-1.zip' },
      ]);
      expect(archiveEntries(await readFile(join(output, 'core.fixture-1.zip')))).toEqual(['machine.json']);
      expect(archiveEntries(await readFile(join(output, 'vendors/Creality.fixture-1.zip')))).toEqual(['machine/ender.json', 'printer/ender.json']);
    } finally { await rm(output, { recursive: true, force: true }); }
  });

  it('is deterministic and changes output when profile content changes', async () => {
    const source = await mkdtemp(join(tmpdir(), 'orca-profile-input-'));
    await mkdir(join(source, 'Vendor'), { recursive: true });
    await writeFile(join(source, 'core.json'), 'one');
    await writeFile(join(source, 'Vendor', 'v.json'), 'vendor');
    const first = await build(source, 'same');
    const second = await build(source, 'same');
    try {
      expect(await readFile(join(first, 'manifest.json'), 'utf8')).toBe(await readFile(join(second, 'manifest.json'), 'utf8'));
      expect(await readFile(join(first, 'core.same.zip'))).toEqual(await readFile(join(second, 'core.same.zip')));
      await writeFile(join(source, 'core.json'), 'changed');
      const changed = await build(source, 'same');
      try { expect(await readFile(join(first, 'core.same.zip'))).not.toEqual(await readFile(join(changed, 'core.same.zip'))); }
      finally { await rm(changed, { recursive: true, force: true }); }
    } finally {
      await rm(first, { recursive: true, force: true }); await rm(second, { recursive: true, force: true }); await rm(source, { recursive: true, force: true });
    }
  });

  it('rejects empty sources and empty vendor directories', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'orca-empty-profiles-'));
    const vendor = await mkdtemp(join(tmpdir(), 'orca-empty-vendor-'));
    await mkdir(join(vendor, 'Vendor'));
    try {
      await expect(build(empty)).rejects.toThrow(/source is empty/);
      await expect(build(vendor)).rejects.toThrow(/vendor profile directory is empty/);
    } finally { await rm(empty, { recursive: true, force: true }); await rm(vendor, { recursive: true, force: true }); }
  });
});
