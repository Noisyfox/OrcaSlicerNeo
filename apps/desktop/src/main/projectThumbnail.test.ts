import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { readProjectThumbnail } from './projectThumbnail';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const standard = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail';
const middle = 'http://schemas.bambulab.com/package/2021/cover-thumbnail-middle';
function relationships(entries: Array<[string, string]>): string {
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(([type, target]) => `<Relationship Target="${target}" Type="${type}"/>`).join('')}</Relationships>`;
}
async function archive(entries: Record<string, Uint8Array>, level: 0 | 6 = 6) {
  const dir = await mkdtemp(join(tmpdir(), 'neo-thumbnail-')); directories.push(dir);
  const path = join(dir, 'project.3mf');
  await writeFile(path, zipSync(entries, { level }));
  return path;
}

describe('Orca 3MF thumbnail extraction', () => {
  it.each([0, 6] as const)('selects middle before standard, without depending on relationship order (ZIP level %s)', async level => {
    const path = await archive({
      '_rels/.rels': strToU8(relationships([[middle, '/Metadata/middle.png'], [standard, '/Metadata/standard.png']])),
      'Metadata/middle.png': png,
      'Metadata/standard.png': strToU8('not the selected image'),
      '3D/3dmodel.model': strToU8('<ignored/>'),
    }, level);
    expect(await readProjectThumbnail(path)).toBe(`data:image/png;base64,${png.toString('base64')}`);
  });
  it('decodes XML entities and root-relative Unicode targets with case-insensitive ZIP lookup', async () => {
    const path = await archive({
      '_rels/.rels': strToU8(relationships([[standard, '/Metadata/模型&amp;封面.png']])),
      'metadata/模型&封面.PNG': png,
    });
    expect(await readProjectThumbnail(path)).toBe(`data:image/png;base64,${png.toString('base64')}`);
  });
  it('uses plate_1 only when no thumbnail relationship is supplied', async () => {
    const path = await archive({ '_rels/.rels': strToU8(relationships([])), 'Metadata/plate_1.png': png });
    expect(await readProjectThumbnail(path)).toBe(`data:image/png;base64,${png.toString('base64')}`);
    const missingTarget = await archive({
      '_rels/.rels': strToU8(relationships([[middle, '/missing.png'], [standard, '/Metadata/plate_1.png']])),
      'Metadata/plate_1.png': png,
    });
    expect(await readProjectThumbnail(missingTarget)).toBeNull();
  });
  it.each<Record<string, Uint8Array>>([
    { 'Metadata/plate_1.png': png },
    { '_rels/.rels': strToU8('<Relationships>') },
    { '_rels/.rels': strToU8(relationships([[standard, '/missing.png']])) },
    { '_rels/.rels': strToU8(relationships([])), 'Metadata/plate_1.png': strToU8('<svg/>') },
    { '_rels/.rels': strToU8('<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><Relationships/>') },
    { '_rels/.rels': strToU8(' '.repeat(1024 * 1024 + 1)) },
    { '_rels/.rels': strToU8(relationships([])), 'Metadata/plate_1.png': new Uint8Array(8 * 1024 * 1024 + 1) },
  ])('falls back for missing, corrupt or oversized preview data (%#)', async entries => {
    expect(await readProjectThumbnail(await archive(entries))).toBeNull();
  });
  it('reads ZIPs with long comments without scanning model data', async () => {
    const bytes = Buffer.from(zipSync({ '_rels/.rels': strToU8(relationships([])), 'Metadata/plate_1.png': png }));
    const comment = Buffer.alloc(1024, 65);
    bytes.writeUInt16LE(comment.length, bytes.length - 2);
    const path = await archive({}); await writeFile(path, Buffer.concat([bytes, comment]));
    expect(await readProjectThumbnail(path)).toBe(`data:image/png;base64,${png.toString('base64')}`);
  });
  it('returns no preview for a missing file or a non-ZIP project', async () => {
    expect(await readProjectThumbnail('/missing/project.3mf')).toBeNull();
    const path = await archive({}); await writeFile(path, 'invalid archive');
    expect(await readProjectThumbnail(path)).toBeNull();
  });
  it('reads the embedded image in the checked-in Orca project', async () => {
    const url = await readProjectThumbnail(resolve(__dirname, '../../../../packages/slicer-wasm/fixtures/project-compatibility/orca-upstream-flowrate.3mf'));
    expect(url).toMatch(/^data:image\/png;base64,/);
    expect(Buffer.from(url!.split(',')[1], 'base64').subarray(0, 8)).toEqual(png.subarray(0, 8));
  });
});
