import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const script = resolve(import.meta.dirname, 'build.mjs');
const fixture = resolve(import.meta.dirname, '../fixtures/upstream');

async function build(source: string) {
  const output = await mkdtemp(join(tmpdir(), 'orca-profile-pack-'));
  try {
    await run(process.execPath, [script], { env: { ...process.env, ORCA_PROFILES_DIR: source, ORCA_PROFILE_OUTPUT: output } });
    return output;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
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
        { id: 'core', kind: 'core', path: 'core.upstream.zip' },
        { id: 'Creality', kind: 'vendor', path: 'vendors/Creality.02.03.02.75.zip' },
      ]);
      expect(archiveEntries(await readFile(join(output, 'core.upstream.zip')))).toEqual(['machine.json']);
      expect(archiveEntries(await readFile(join(output, 'vendors/Creality.02.03.02.75.zip')))).toEqual(['Creality/machine/ender.json', 'Creality/printer/ender.json', 'Creality.json']);
    } finally { await rm(output, { recursive: true, force: true }); }
  });

  it('is deterministic and changes output when profile content changes', async () => {
    const source = await mkdtemp(join(tmpdir(), 'orca-profile-input-'));
    await mkdir(join(source, 'Vendor'), { recursive: true });
    await writeFile(join(source, 'core.json'), 'one');
    await writeFile(join(source, 'Vendor.json'), '{"version":"1.2.3","name":"one"}');
    await writeFile(join(source, 'Vendor', 'v.json'), 'vendor');
    const first = await build(source);
    const second = await build(source);
    try {
      expect(await readFile(join(first, 'manifest.json'), 'utf8')).toBe(await readFile(join(second, 'manifest.json'), 'utf8'));
      expect(await readFile(join(first, 'core.upstream.zip'))).toEqual(await readFile(join(second, 'core.upstream.zip')));
      expect(await readFile(join(first, 'vendors/Vendor.1.2.3.zip'))).toEqual(await readFile(join(second, 'vendors/Vendor.1.2.3.zip')));
      await writeFile(join(source, 'core.json'), 'changed');
      const changed = await build(source);
      try {
        expect(await readFile(join(first, 'core.upstream.zip'))).not.toEqual(await readFile(join(changed, 'core.upstream.zip')));
        expect(await readFile(join(first, 'vendors/Vendor.1.2.3.zip'))).toEqual(await readFile(join(changed, 'vendors/Vendor.1.2.3.zip')));
      }
      finally { await rm(changed, { recursive: true, force: true }); }
      await writeFile(join(source, 'core.json'), 'one');
      await writeFile(join(source, 'Vendor.json'), '{"version":"1.2.3","name":"two"}');
      const changedMetadata = await build(source);
      try {
        expect(await readFile(join(first, 'core.upstream.zip'))).toEqual(await readFile(join(changedMetadata, 'core.upstream.zip')));
        expect(await readFile(join(first, 'vendors/Vendor.1.2.3.zip'))).not.toEqual(await readFile(join(changedMetadata, 'vendors/Vendor.1.2.3.zip')));
      }
      finally { await rm(changedMetadata, { recursive: true, force: true }); }
      await writeFile(join(source, 'Vendor.json'), '{"version":"1.2.4","name":"two"}');
      const changedVersion = await build(source);
      try {
        const manifest = JSON.parse(await readFile(join(changedVersion, 'manifest.json'), 'utf8'));
        expect(manifest.packages[1].path).toBe('vendors/Vendor.1.2.4.zip');
        expect(await readFile(join(first, 'core.upstream.zip'))).toEqual(await readFile(join(changedVersion, 'core.upstream.zip')));
      }
      finally { await rm(changedVersion, { recursive: true, force: true }); }
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

  it('requires a safe version in each vendor metadata file', async () => {
    const source = await mkdtemp(join(tmpdir(), 'orca-vendor-version-'));
    await mkdir(join(source, 'Vendor'));
    await writeFile(join(source, 'Vendor', 'v.json'), '{}');
    try {
      await expect(build(source)).rejects.toThrow(/vendor profile metadata is missing: Vendor.json/);
      await writeFile(join(source, 'Vendor.json'), '{"version":"../escape"}');
      await expect(build(source)).rejects.toThrow(/invalid vendor profile version/);
      await writeFile(join(source, 'Vendor.json'), '{"version":2}');
      await expect(build(source)).rejects.toThrow(/invalid vendor profile version/);
    } finally { await rm(source, { recursive: true, force: true }); }
  });
});
