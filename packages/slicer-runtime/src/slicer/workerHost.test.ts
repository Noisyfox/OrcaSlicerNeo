import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrcaModule, OrcaModuleFactory } from '../../../slicer-wasm/src/client/types';

const calls = vi.hoisted(() => ({ startWorker: vi.fn(), mount: vi.fn(), install: vi.fn() }));
vi.mock('@slicer/client', () => ({ startWorker: calls.startWorker, mountNativeTemporaryDirectory: calls.mount }));
vi.mock('@slicer/testing', () => ({ createMockModule: vi.fn() }));
vi.mock('../profiles', () => ({ installProfiles: calls.install }));

async function start(threaded: boolean, nativeTemporaryDirectory?: string, failThreaded = false) {
  const { startSlicerHost } = await import('./workerHost');
  const module = {} as OrcaModule;
  const load = vi.fn(async (variant: string) => {
    if (failThreaded && variant === 'threaded') throw new Error('threaded load failed');
    return module;
  });
  startSlicerHost({ threaded, nativeTemporaryDirectory, load,
    profiles: { fetch: vi.fn() }, post: vi.fn(), onMessage: vi.fn() });
  const factory = calls.startWorker.mock.calls[0][0] as OrcaModuleFactory;
  const beforeInit = calls.startWorker.mock.calls[0][3] as (module: OrcaModule) => Promise<void>;
  return { module, load, factory, beforeInit };
}

describe('Worker host temporary filesystem selection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv('VITE_USE_MOCK', '0');
    vi.stubEnv('VITE_REAL_PROJECT_PROFILE', '0');
    vi.stubEnv('VITE_SCOPED_CONFIGURATION_GATE', '0');
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('mounts the native directory before profiles and client initialization', async () => {
    const { module, factory, beforeInit } = await start(true, 'C:\\Temp\\orca-slicer-abc123');
    await expect(factory()).resolves.toBe(module);
    expect(calls.mount).toHaveBeenCalledWith(module, 'C:\\Temp\\orca-slicer-abc123');
    expect(calls.install).not.toHaveBeenCalled();
    await beforeInit(module);
    expect(calls.mount.mock.invocationCallOrder[0]).toBeLessThan(calls.install.mock.invocationCallOrder[0]);
  });

  it.each([true, false])('retains MEMFS for a browser host (threaded=%s)', async (threaded) => {
    const { factory } = await start(threaded);
    await factory();
    expect(calls.mount).not.toHaveBeenCalled();
  });

  it('retains MEMFS for Electron serial', async () => {
    const { factory, load } = await start(false, 'C:\\Temp\\orca-slicer-abc123');
    await factory();
    expect(load).toHaveBeenCalledWith('serial');
    expect(calls.mount).not.toHaveBeenCalled();
  });

  it('retains MEMFS when threaded startup falls back to serial', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { factory, load } = await start(true, 'C:\\Temp\\orca-slicer-abc123', true);
    await factory();
    expect(load.mock.calls).toEqual([['threaded'], ['serial']]);
    expect(warning).toHaveBeenCalledOnce();
    expect(calls.mount).not.toHaveBeenCalled();
  });

  it('propagates a mount failure instead of silently starting a different filesystem', async () => {
    calls.mount.mockImplementation(() => { throw new Error('NODEFS unavailable'); });
    const { factory, load } = await start(true, 'C:\\Temp\\orca-slicer-abc123');
    await expect(factory()).rejects.toThrow('NODEFS unavailable');
    expect(load.mock.calls).toEqual([['threaded']]);
    expect(calls.install).not.toHaveBeenCalled();
  });
});
