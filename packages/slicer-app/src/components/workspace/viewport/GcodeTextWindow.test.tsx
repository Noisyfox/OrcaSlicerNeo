// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { GcodeTextWindow } from './GcodeTextWindow';
import type { ToolpathGeometry } from './useSliceResult';

const data: ToolpathGeometry = {
  segmentCount: 3,
  palette: [],
  layerIds: Uint32Array.from([0, 0, 1]),
  moveOrders: Uint32Array.from([0, 1, 0]),
  gcodeIds: Uint32Array.from([4, 7, 11]),
  features: new Uint32Array(3),
  moveTypes: new Uint8Array(3),
  extruderIds: new Uint8Array(3),
  metrics: {},
  ends: new Float32Array(9),
  metadata: {
    resultId: 42,
    layerRanges: [
      { id: 0, z: 0.2, firstSegment: 0, segmentCount: 2 },
      { id: 1, z: 0.4, firstSegment: 2, segmentCount: 1 },
    ],
    featurePalette: [],
    sourceLineMapping: { available: true, lineCount: 100 },
    sourceText: { available: true },
  },
  dispose: () => undefined,
};

describe('GcodeTextWindow', () => {
  let root: Root | undefined;
  afterEach(() => {
    root?.unmount(); root = undefined; document.body.innerHTML = '';
    useSlicerStore.getState().resetPreviewState();
  });

  it('loads source text lazily and keeps only visible line elements', async () => {
    const readTextChunk = vi.fn(async ({ resultId, offset }: { resultId: number; offset: number; length: number }) => ({
      resultId, offset, eof: true, text: Array.from({ length: 11 }, (_, i) => `G1 X${i}`).join('\n'),
    }));
    const platform = { runtime: { readTextChunk } } as unknown as PlatformCapabilities;
    useSlicerStore.getState().setPreviewBounds(1, 1, 42);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<PlatformProvider value={platform}><GcodeTextWindow data={data} onClose={() => undefined} /></PlatformProvider>); });
    expect(readTextChunk).toHaveBeenCalledWith({ resultId: 42, offset: 0, length: 64 * 1024 });
    expect(container.querySelector('[data-testid="gcode-text-window"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid^="gcode-line-"]').length).toBeLessThan(100);
    expect(container.querySelector('[data-testid="gcode-line-1"]')?.textContent).toContain('G1 X0');
  });

  it('maps exact and unmappable line clicks using the preceding move rule', async () => {
    const readTextChunk = vi.fn(async ({ resultId, offset }: { resultId: number; offset: number; length: number }) => ({
      resultId, offset, eof: true, text: Array.from({ length: 11 }, (_, i) => `G1 X${i}`).join('\n'),
    }));
    const platform = { runtime: { readTextChunk } } as unknown as PlatformCapabilities;
    useSlicerStore.getState().setPreviewBounds(1, 1, 42);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => { root?.render(<PlatformProvider value={platform}><GcodeTextWindow data={data} onClose={() => undefined} /></PlatformProvider>); });
    await act(async () => { (container.querySelector('[data-testid="gcode-line-6"]') as HTMLElement).click(); });
    expect(useSlicerStore.getState().preview).toMatchObject({ visibleLayerEnd: 0, activeMoveEnd: 0 });
    await act(async () => { (container.querySelector('[data-testid="gcode-line-3"]') as HTMLElement).click(); });
    expect(useSlicerStore.getState().preview).toMatchObject({ visibleLayerEnd: 0, activeMoveEnd: 0 });
  });
});
