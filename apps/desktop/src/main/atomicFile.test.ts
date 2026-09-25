import { describe, expect, it, vi } from 'vitest';
import { basename, dirname, join } from 'node:path';
import { writeFileAtomically, type AtomicFileDependencies } from './atomicFile';

function dependencies(overrides: Partial<AtomicFileDependencies> = {}): any {
  return {
    writeFile: vi.fn<AtomicFileDependencies['writeFile']>(async () => undefined),
    rename: vi.fn<AtomicFileDependencies['rename']>(async () => undefined),
    unlink: vi.fn<AtomicFileDependencies['unlink']>(async () => undefined),
    ...overrides,
  };
}

describe('atomic project writes', () => {
  it('writes a unique sibling temporary file before replacing the target', async () => {
    const fs = dependencies();
    const target = join('projects', 'scene.3mf');
    await writeFileAtomically(target, Uint8Array.from([1, 2]), fs);
    const temporary = fs.writeFile.mock.calls[0]![0];
    expect(dirname(temporary)).toBe(dirname(target));
    expect(basename(temporary)).toMatch(/^\.scene\.3mf\.[0-9a-f-]+\.tmp$/);
    expect(fs.writeFile).toHaveBeenCalledWith(temporary, expect.any(Uint8Array), { flag: 'wx' });
    expect(fs.rename).toHaveBeenCalledWith(temporary, target);
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('cleans up the temporary file and preserves the target when writing fails', async () => {
    const failure = new Error('disk full');
    const fs = dependencies({ writeFile: vi.fn(async () => { throw failure; }) });
    await expect(writeFileAtomically('scene.3mf', new Uint8Array([1]), fs)).rejects.toBe(failure);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('.scene.3mf.'));
  });

  it('cleans up the temporary file and preserves the target when replacement fails', async () => {
    const failure = new Error('replace failed');
    const fs = dependencies({ rename: vi.fn(async () => { throw failure; }) });
    await expect(writeFileAtomically('scene.3mf', new Uint8Array([1]), fs)).rejects.toBe(failure);
    expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('.scene.3mf.'));
  });
});
