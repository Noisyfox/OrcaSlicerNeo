// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type { ClientSliceResult } from '@slicer/client';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { StatusBar } from '../../layout/StatusBar';
import { useSliceResult, type ToolpathGeometry } from './useSliceResult';
import { lastMovePosition } from './previewSemantics';

function PreviewProbe({ onToolpath }: { onToolpath?: (toolpath: ToolpathGeometry) => void }) {
  const { toolpath } = useSliceResult();
  useEffect(() => {
    if (toolpath) onToolpath?.(toolpath);
  }, [onToolpath, toolpath]);
  return null;
}

function arcSliceResult(): ClientSliceResult {
  return {
    ok: true,
    objects: 1,
    layers: 1,
    toolpath: {
      features: new Uint32Array([0, 0, 0, 0]),
      palette: [],
      segmentCount: 4,
      starts: new Float32Array([
        0, 0, 0,
        1, 0, 0,
        2, 0, 0,
        3, 0, 0,
      ]),
      ends: new Float32Array([
        1, 0, 0,
        2, 0, 0,
        3, 0, 0,
        4, 0, 0,
      ]),
      layerIds: new Uint32Array([0, 0, 0, 0]),
      // Raw bridge order increments at each new gcode id, including arc
      // tessellation; the hook canonicalizes this to [0, 0, 0, 1].
      moveOrders: new Uint32Array([0, 1, 1, 1]),
      gcodeIds: new Uint32Array([41, 41, 41, 42]),
      sourceLineOrderValid: true,
      moveTypes: new Uint8Array([1, 1, 1, 1]),
      extrusionRoles: new Uint16Array(4),
      extruderIds: new Uint8Array(4),
      colorPrintIds: new Uint8Array(4),
      widths: new Float32Array([0.4, 0.4, 0.4, 0.4]),
      heights: new Float32Array([0.2, 0.2, 0.2, 0.2]),
      metrics: {},
    },
    metadata: {
      resultId: 41,
      layerRanges: [{ id: 0, z: 0.2, firstSegment: 0, segmentCount: 4 }],
      featurePalette: [],
    },
  };
}

describe('useSliceResult', () => {
  let root: Root | undefined;

  afterEach(() => {
    root?.unmount();
    root = undefined;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    useSlicerStore.setState({
      status: 'idle', progress: 0, layers: 0, error: null, resultExported: false, layer: 0, maxLayer: 0,
    });
  });

  it('surfaces a failed preview extraction through the visible slice error state', async () => {
    const runtime = {
      getSliceResult: vi.fn(async () => ({ ok: false, error: 'nozzle context is unavailable' })),
    };
    const platform = {
      runtime,
      chrome: { kind: 'desktop' },
    } as unknown as PlatformCapabilities;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    useSlicerStore.setState({ status: 'done' });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <PlatformProvider value={platform}>
          <PreviewProbe />
          <StatusBar />
        </PlatformProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(useSlicerStore.getState()).toMatchObject({
        status: 'error', error: 'preview: nozzle context is unavailable',
      });
    });

    expect(container.querySelector('[data-testid="slicer-status"]')?.textContent).toBe('Error');
    expect(container.querySelector('[data-testid="slicer-error"]')?.textContent)
      .toBe('preview: nozzle context is unavailable');
    expect(consoleError).toHaveBeenCalled();
  });

  it('coalesces arc segments in the actual hook output without dropping geometry', async () => {
    const runtime = {
      getSliceResult: vi.fn(async () => arcSliceResult()),
    };
    const platform = {
      runtime,
      chrome: { kind: 'desktop' },
    } as unknown as PlatformCapabilities;
    const onToolpath = vi.fn<(toolpath: ToolpathGeometry) => void>();
    useSlicerStore.setState({ status: 'done' });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <PlatformProvider value={platform}>
          <PreviewProbe onToolpath={onToolpath} />
        </PlatformProvider>,
      );
    });

    await vi.waitFor(() => expect(onToolpath).toHaveBeenCalled());
    const output = onToolpath.mock.lastCall?.[0];
    expect(output).toBeDefined();
    expect(output?.moveOrders).toEqual(new Uint32Array([0, 0, 0, 1]));
    expect(lastMovePosition(output!, 0, 0)).toEqual([3, 0, 0]);
    expect(output?.segmentCount).toBe(4);
    expect(output?.ends).toEqual(new Float32Array([
      1, 0, 0,
      2, 0, 0,
      3, 0, 0,
      4, 0, 0,
    ]));
    expect(output?.source?.moveOrders).toBe(output?.moveOrders);
    expect(output?.source?.ends).toBe(output?.ends);
  });
});
