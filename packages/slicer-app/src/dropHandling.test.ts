import { describe, expect, it } from 'vitest';
import { externalDropFiles, isThreeMfDropFile } from './dropHandling';

describe('project drag/drop filtering', () => {
  it('accepts a desktop 3MF extension even when the MIME type is generic', () => {
    expect(isThreeMfDropFile({ name: 'Scene.3MF', type: 'application/octet-stream' })).toBe(true);
  });

  it('accepts the known 3MF MIME type when the drag source omits a useful extension', () => {
    expect(isThreeMfDropFile({ name: 'download', type: 'model/3mf' })).toBe(true);
  });

  it('does not classify model files as project drops', () => {
    expect(isThreeMfDropFile({ name: 'cube.stl', type: 'model/stl' })).toBe(false);
  });

  it('extracts only external files and leaves text-only application drags alone', () => {
    const file = { name: 'scene.3mf', type: '', arrayBuffer: async () => new ArrayBuffer(0) } as File;
    expect(externalDropFiles({ files: [file] } as unknown as DataTransfer)).toEqual([file]);
    expect(externalDropFiles({ files: [] } as unknown as DataTransfer)).toEqual([]);
  });
});
