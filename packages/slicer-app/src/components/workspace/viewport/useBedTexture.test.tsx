// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Texture } from 'three';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { loadBedTexture, useBedTexture, type BedTexture } from './useBedTexture';

vi.mock('@react-three/fiber', () => {
  const invalidate = vi.fn();
  return { useThree: (select: (state: { invalidate: () => void }) => unknown) => select({ invalidate }) };
});

describe('profile bed artwork', () => {
  const decode = vi.fn(async () => {});
  const revoke = vi.fn();
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    decode.mockReset().mockResolvedValue(undefined);
    revoke.mockClear();
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:bed'), revokeObjectURL: revoke });
    vi.stubGlobal('Image', class { src = ''; naturalWidth = 400; naturalHeight = 200; decode = decode; });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); useSettingsStore.setState({ bedTexture: '' }); });

  it('rasterizes SVG/PNG at bounded resolution and releases URLs on decode failure', async () => {
    for (const path of ['/bed.svg', '/bed.png']) {
      const texture = await loadBedTexture(Uint8Array.of(1), path);
      expect(texture.image.width).toBe(2048);
      expect(texture.image.height).toBe(1024);
      expect(texture.colorSpace).toBe('srgb');
      texture.dispose();
    }
    decode.mockRejectedValueOnce(new Error('Invalid image'));
    await expect(loadBedTexture(Uint8Array.of(1), '/broken.svg')).rejects.toThrow('Invalid image');
    expect(revoke).toHaveBeenCalledTimes(3);
    await expect(loadBedTexture(Uint8Array.of(1), '/bed.jpg')).rejects.toThrow('Unsupported');
  });

  it('rejects stale requests, retains the plain bed on failure and disposes replaced textures', async () => {
    const pending = new Map<string, (bytes: Uint8Array) => void>();
    const read = vi.fn((path: string) => path === '/missing.svg' ? Promise.reject(new Error('ENOENT'))
      : new Promise<Uint8Array>((resolve) => pending.set(path, resolve)));
    let loaded: BedTexture | null = null;
    function Probe() { loaded = useBedTexture(); return null; }
    const platform = { runtime: { readFilesystemFile: read } } as unknown as PlatformCapabilities;
    const root = createRoot(document.createElement('div'));
    const dispose = vi.spyOn(Texture.prototype, 'dispose');
    try {
      useSettingsStore.setState({ bedTexture: '/old.svg' });
      await act(async () => root.render(<PlatformProvider value={platform}><Probe /></PlatformProvider>));
      await act(async () => useSettingsStore.setState({ bedTexture: '/new.svg' }));
      await act(async () => pending.get('/old.svg')!(Uint8Array.of(1)));
      expect(loaded).toBeNull();
      expect(decode).not.toHaveBeenCalled();
      await act(async () => pending.get('/new.svg')!(Uint8Array.of(1)));
      expect(loaded).toMatchObject({ path: '/new.svg' });
      await act(async () => useSettingsStore.setState({ bedTexture: '/missing.svg' }));
      expect(loaded).toBeNull();
      expect(dispose).toHaveBeenCalledTimes(1);
      // A texture decoded after its owner unmounts must also be released.
      let release!: () => void;
      decode.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
      await act(async () => useSettingsStore.setState({ bedTexture: '/late.svg' }));
      await act(async () => pending.get('/late.svg')!(Uint8Array.of(1)));
      await act(async () => root.unmount());
      await act(async () => release());
      expect(dispose).toHaveBeenCalledTimes(2);
    } finally { await act(async () => root.unmount()); }
  });
});
