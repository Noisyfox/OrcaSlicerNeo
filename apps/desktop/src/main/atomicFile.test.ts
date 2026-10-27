import { describe, expect, it, vi } from 'vitest';
import { basename, dirname, join } from 'node:path';
import { appendFile, mkdtemp, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileAtomically, type AtomicFileDependencies } from './atomicFile';

function dependencies(overrides: Partial<AtomicFileDependencies> = {}): any {
  return {
    writeFile: vi.fn<AtomicFileDependencies['writeFile']>(async () => undefined),
    rename: vi.fn<AtomicFileDependencies['rename']>(async () => undefined),
    unlink: vi.fn<AtomicFileDependencies['unlink']>(async () => undefined),
    platform: 'linux',
    delay: vi.fn(async (_milliseconds: number) => undefined),
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
      },rename,unlink,platform:process.platform,delay,
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

  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries a Windows %s replacement without rewriting or deleting the target', async code => {
    const failure = Object.assign(new Error('temporarily occupied'), { code });
    const fs = dependencies({ platform: 'win32',
      rename: vi.fn().mockRejectedValueOnce(failure).mockRejectedValueOnce(failure).mockResolvedValue(undefined),
    });
    await writeFileAtomically('preferences.json', Buffer.from('{}'), fs);
    const temporary = fs.writeFile.mock.calls[0][0];
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    expect(fs.rename.mock.calls).toEqual(Array.from({ length: 3 }, () => [temporary, 'preferences.json']));
    expect(fs.delay).toHaveBeenCalledTimes(2);
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('bounds Windows replacement retries and propagates a persistent permission failure', async () => {
    const failure = Object.assign(new Error('access denied'), { code: 'EPERM' });
    const fs = dependencies({ platform: 'win32', rename: vi.fn().mockRejectedValue(failure) });
    await expect(writeFileAtomically('preferences.json', Buffer.from('{}'), fs)).rejects.toBe(failure);
    expect(fs.rename.mock.calls.length).toBeGreaterThan(1);
    expect(fs.rename.mock.calls.length).toBeLessThanOrEqual(10);
    expect(fs.delay.mock.calls.reduce((total: number, [delay]: [number]) => total + delay, 0)).toBeLessThanOrEqual(1_000);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    expect(fs.unlink).toHaveBeenCalledExactlyOnceWith(fs.writeFile.mock.calls[0][0]);
  });

  it('keeps the old document readable during retries and publishes the complete replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-atomic-retry-'));
    const target = join(directory, 'preferences.json');
    const before = '{"version":1,"favorites":[]}', after = '{"version":1,"favorites":["#2357AB"]}';
    await writeFile(target, before);
    let attempts = 0;
    try {
      await writeFileAtomically(target, Buffer.from(after), {
        platform: 'win32', writeFile, unlink,
        rename: async (from, to) => {
          if (attempts++ < 2) throw Object.assign(new Error('temporarily occupied'), { code: 'EPERM' });
          await rename(from, to);
        },
        delay: async () => { expect(await readFile(target, 'utf8')).toBe(before); },
      });
      expect(await readFile(target, 'utf8')).toBe(after);
      expect(await readdir(directory)).toEqual(['preferences.json']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(['linux', 'darwin'] as const)('does not retry permission errors on %s', async platform => {
    const failure = Object.assign(new Error('access denied'), { code: 'EPERM' });
    const fs = dependencies({ platform, rename: vi.fn().mockRejectedValue(failure) });
    await expect(writeFileAtomically('preferences.json', Buffer.from('{}'), fs)).rejects.toBe(failure);
    expect(fs.rename).toHaveBeenCalledTimes(1);
    expect(fs.delay).not.toHaveBeenCalled();
  });

  it('does not retry other Windows rename errors or a failed temporary-file write', async () => {
    const failure = Object.assign(new Error('missing file'), { code: 'ENOENT' });
    const fs = dependencies({ platform: 'win32', rename: vi.fn().mockRejectedValue(failure) });
    await expect(writeFileAtomically('preferences.json', Buffer.from('{}'), fs)).rejects.toBe(failure);
    expect(fs.rename).toHaveBeenCalledTimes(1);
    expect(fs.delay).not.toHaveBeenCalled();
    const writeFailure = Object.assign(new Error('write denied'), { code: 'EPERM' });
    const denied = dependencies({ platform: 'win32', writeFile: vi.fn().mockRejectedValue(writeFailure) });
    await expect(writeFileAtomically('preferences.json', Buffer.from('{}'), denied)).rejects.toBe(writeFailure);
    expect(denied.rename).not.toHaveBeenCalled();
    expect(denied.delay).not.toHaveBeenCalled();
  });
});
