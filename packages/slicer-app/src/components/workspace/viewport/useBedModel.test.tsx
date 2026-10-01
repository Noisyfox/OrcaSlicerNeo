// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { BufferGeometry } from 'three';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useBedModel, type BedModel } from './useBedModel';

vi.mock('@react-three/fiber', () => {
  const invalidate = vi.fn();
  return { useThree: (select: (state: { invalidate: () => void }) => unknown) => select({ invalidate }) };
});

const stl = new TextEncoder().encode(`solid bed
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 10 0 0
vertex 0 10 0
endloop
endfacet
endsolid bed`);

describe('bed model loading', () => {
  it('ignores late responses, shares a model, releases replacements and falls back on errors', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const pending = new Map<string, (bytes: Uint8Array) => void>();
    const read = vi.fn((path: string) => path === '/missing.stl'
      ? Promise.reject(new Error('ENOENT'))
      : new Promise<Uint8Array>((resolve) => pending.set(path, resolve)));
    const platform = { runtime: { readFilesystemFile: read } } as unknown as PlatformCapabilities;
    let model: BedModel | null = null;
    function Probe() { model = useBedModel(); return null; }
    const container = document.createElement('div');
    const root = createRoot(container);
    const dispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    try {
      useSettingsStore.setState({ bedModel: '/old.stl' });
      await act(async () => root.render(<PlatformProvider value={platform}><Probe /></PlatformProvider>));
      await act(async () => useSettingsStore.setState({ bedModel: '/new.stl' }));
      await act(async () => pending.get('/old.stl')!(stl));
      expect(model).toBeNull();
      await act(async () => pending.get('/new.stl')!(stl));
      expect(model).toMatchObject({ path: '/new.stl' });
      expect(read).toHaveBeenCalledTimes(2);
      await act(async () => useSettingsStore.setState({ bedModel: '/missing.stl' }));
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(model).toBeNull();
      await act(async () => useSettingsStore.setState({ bedModel: '/invalid.stl' }));
      await act(async () => pending.get('/invalid.stl')!(new TextEncoder().encode('solid invalid\nendsolid invalid')));
      expect(model).toBeNull();
      // The loader may reject malformed input before allocating a geometry.
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      dispose.mockRestore();
      useSettingsStore.setState({ bedModel: '' });
    }
  });
});
