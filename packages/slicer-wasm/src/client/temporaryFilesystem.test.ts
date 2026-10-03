import { describe, expect, it, vi } from 'vitest';
import { createMockModule } from './testing/mock-module';
import { mountNativeTemporaryDirectory } from './temporaryFilesystem';
import type { OrcaModule } from './types';

function nodefsModule(): OrcaModule {
  const module = createMockModule();
  return { ...module, FS: { ...module.FS, filesystems: { NODEFS: {} }, mount: vi.fn() } };
}

describe('native temporary filesystem setup', () => {
  it.each(['C:\\Temp with spaces\\临时目录\\orca-slicer-aBc123', '/tmp/orca-slicer-aBc123', '\\\\server\\temp\\orca-slicer-aBc123'])(
    'mounts an empty /tmp at the exact host path %s', (directory) => {
      const module = nodefsModule();
      mountNativeTemporaryDirectory(module, directory);
      expect(module.FS.mount).toHaveBeenCalledWith(module.FS.filesystems!.NODEFS, { root: directory }, '/tmp');
    },
  );

  it.each(['', 'relative/temp', 'C:relative', 'C:\\temp\0hidden'])(
    'rejects invalid host paths before touching the filesystem: %s', (directory) => {
      const module = nodefsModule();
      expect(() => mountNativeTemporaryDirectory(module, directory)).toThrow(/absolute host path/);
      expect(module.FS.mount).not.toHaveBeenCalled();
    },
  );

  it('fails clearly when NODEFS was not linked instead of silently using MEMFS', () => {
    expect(() => mountNativeTemporaryDirectory(createMockModule(), '/tmp/native')).toThrow(/provide NODEFS/);
  });

  it('rejects a late mount instead of hiding existing temporary files', () => {
    const module = nodefsModule();
    module.FS.writeFile('/tmp/orca.log', new Uint8Array([1]));
    expect(() => mountNativeTemporaryDirectory(module, '/tmp/native')).toThrow(/before first use/);
    expect(module.FS.mount).not.toHaveBeenCalled();
    expect(module.FS.readFile('/tmp/orca.log')).toEqual(new Uint8Array([1]));
  });
});
