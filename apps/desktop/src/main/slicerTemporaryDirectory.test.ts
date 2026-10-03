import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';

const mocks = vi.hoisted(() => ({ mkdtemp: vi.fn(), realpath: vi.fn(), rm: vi.fn(), tmpdir: vi.fn() }));
vi.mock('node:fs', () => ({ mkdtempSync: mocks.mkdtemp, realpathSync: mocks.realpath }));
vi.mock('node:fs/promises', () => ({ rm: mocks.rm }));
vi.mock('node:os', () => ({ tmpdir: mocks.tmpdir }));
import { createSlicerTemporaryDirectory } from './slicerTemporaryDirectory';

describe('owned slicer temporary directories', () => {
  const root = resolve('native temp with spaces 临时');
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.tmpdir.mockReturnValue(root);
    mocks.realpath.mockReturnValue(root);
    mocks.rm.mockResolvedValue(undefined);
  });

  it('creates a unique child and removes only that exact directory', async () => {
    const path = join(root, 'orca-slicer-Ab12cD');
    mocks.mkdtemp.mockReturnValue(path);
    const directory = createSlicerTemporaryDirectory();
    expect(mocks.mkdtemp).toHaveBeenCalledWith(join(root, 'orca-slicer-'));
    expect(directory.path).toBe(path);
    expect(mocks.rm).not.toHaveBeenCalled();
    await directory.remove();
    expect(mocks.rm).toHaveBeenCalledWith(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it.each([root, join(root, '..', 'orca-slicer-Ab12cD'), join(root, 'unrelated-directory'), 'relative/orca-slicer-Ab12cD'])(
    'rejects cleanup outside the owned session path: %s', async (path) => {
      mocks.mkdtemp.mockReturnValue(path);
      await expect(createSlicerTemporaryDirectory().remove()).rejects.toThrow(/Invalid slicer session/);
      expect(mocks.rm).not.toHaveBeenCalled();
    },
  );
});
