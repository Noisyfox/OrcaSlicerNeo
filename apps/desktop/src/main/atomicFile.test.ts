import { describe, expect, it, vi } from 'vitest';
import { basename, dirname, join } from 'node:path';
import { appendFile, mkdtemp, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeFileAtomically, type AtomicFileDependencies } from './atomicFile';

function dependencies(overrides: Partial<AtomicFileDependencies> = {}): any {
  return {
    writeFile: vi.fn<AtomicFileDependencies['writeFile']>(async () => undefined),
    rename: vi.fn<AtomicFileDependencies['rename']>(async () => undefined),
    unlink: vi.fn<AtomicFileDependencies['unlink']>(async () => undefined),
    ...overrides,
  };
}

describe('atomic file writes', () => {
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

  it('keeps preferences readable while a replacement document is only partially written', async () => {
    const directory=await mkdtemp(join(tmpdir(),'neo-atomic-preferences-'));
    const target=join(directory,'preferences.json');
    const before={version:1,colorPicker:{favorites:[]}};
    const after={version:1,colorPicker:{favorites:[{kind:'solid',color:'#123456'}]}};
    await writeFile(target,JSON.stringify(before));
    let started!:()=>void,release!:()=>void;
    const partial=new Promise<void>(resolve=>{started=resolve;});
    const resume=new Promise<void>(resolve=>{release=resolve;});
    const pending=writeFileAtomically(target,Buffer.from(JSON.stringify(after)),{
      writeFile:async(path,bytes,options)=>{
        await writeFile(path,bytes.slice(0,12),options);started();await resume;
        await appendFile(path,bytes.slice(12));
      },rename,unlink,
    });
    try {
      await partial;
      // Direct parse deliberately exposes any empty/partial published document.
      expect(JSON.parse(await readFile(target,'utf8'))).toEqual(before);
      release();await pending;
      expect(JSON.parse(await readFile(target,'utf8'))).toEqual(after);
    } finally {release();await pending;await unlink(target);await rmdir(directory);}
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
