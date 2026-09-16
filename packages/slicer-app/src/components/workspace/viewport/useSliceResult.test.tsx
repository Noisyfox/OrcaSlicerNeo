// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider, type PlatformCapabilities } from '@orca/platform-contract';
import type { ClientSliceResult } from '@slicer/client';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { useSliceResult, type ToolpathGeometry } from './useSliceResult';
import { lastMovePosition } from './previewSemantics';

function PreviewProbe({ enabled = true, onToolpath }: {
  enabled?: boolean;
  onToolpath?: (toolpath: ToolpathGeometry) => void;
}) {
  const { toolpath, projectionStatus } = useSliceResult(enabled);
  useEffect(() => {
    if (toolpath) onToolpath?.(toolpath);
  }, [onToolpath, toolpath]);
  return <output data-testid="projection-status">{projectionStatus}</output>;
}

const receipt = { plateId: 'plate-1', inputStamp: 1, resultGeneration: '1', sliceTaskId: '17' };

function arcSliceResult(resultReceipt = receipt, finalX = 4): ClientSliceResult {
  return {
    ok: true,
    status: 'ok',
    receipt: resultReceipt,
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
        finalX, 0, 0,
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
      status: 'idle', progress: 0, layers: 0, error: null, resultExported: false,
      sliceTarget: null, plateResults: {}, activeSliceTarget: null, layer: 0, maxLayer: 0,
    });
    usePlateSessionStore.getState().reset();
  });

  it('shows needs-slicing for an explicitly activated unsliced plate without requesting a payload', async () => {
    const runtime = { getSliceResult: vi.fn() };
    const platform = { runtime, chrome: { kind: 'desktop' } } as unknown as PlatformCapabilities;
    usePlateSessionStore.getState().setSnapshot({
      ok: true, version: 1, currentPlateId: 'plate-2',
      plates: [{ plateId: 'plate-2', displayIndex: 1, origin: [250, 0, 0], name: 'Plate 2' }],
      inputRevisions: { 'plate-2': 0 },
    });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PlatformProvider value={platform}><PreviewProbe /></PlatformProvider>);
    });
    expect(container.querySelector('[data-testid="projection-status"]')?.textContent).toBe('needs-slicing');
    expect(runtime.getSliceResult).not.toHaveBeenCalled();
  });

  it('does not materialize a renderer projection outside Preview', async () => {
    const runtime = { getSliceResult: vi.fn(async () => arcSliceResult()) };
    const platform = { runtime, chrome: { kind: 'desktop' } } as unknown as PlatformCapabilities;
    usePlateSessionStore.getState().setSnapshot({
      ok: true, version: 1, currentPlateId: 'plate-1',
      plates: [{ plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1' }],
      inputRevisions: { 'plate-1': 1 },
    });
    useSlicerStore.getState().setPlateResult(receipt);
    useSlicerStore.getState().activatePlateResult('plate-1', 1);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><PreviewProbe enabled={false} /></PlatformProvider>);
    });

    expect(container.querySelector('[data-testid="projection-status"]')?.textContent).toBe('needs-slicing');
    expect(runtime.getSliceResult).not.toHaveBeenCalled();
  });

  it('keeps a failed preview projection local while the completed Slice stays usable', async () => {
    const runtime = {
      getSliceResult: vi.fn(async () => ({
        ok: false, status: 'failed', objects: 0, layers: 0, error: 'nozzle context is unavailable',
      })),
    };
    const platform = {
      runtime,
      chrome: { kind: 'desktop' },
    } as unknown as PlatformCapabilities;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    usePlateSessionStore.getState().setSnapshot({
      ok: true, version: 1, currentPlateId: 'plate-1',
      plates: [{ plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1' }],
      inputRevisions: { 'plate-1': 1 },
    });
    useSlicerStore.getState().setPlateResult(receipt);
    useSlicerStore.getState().activatePlateResult('plate-1', 1);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <PlatformProvider value={platform}>
          <PreviewProbe />
        </PlatformProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="projection-status"]')?.textContent).toBe('failed');
    });

    expect(useSlicerStore.getState()).toMatchObject({ status: 'done', error: null });
    expect(runtime.getSliceResult).toHaveBeenCalledWith(receipt);
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
    usePlateSessionStore.getState().setSnapshot({
      ok: true, version: 1, currentPlateId: 'plate-1',
      plates: [{ plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1' }],
      inputRevisions: { 'plate-1': 1 },
    });
    useSlicerStore.getState().setPlateResult(receipt);
    useSlicerStore.getState().activatePlateResult('plate-1', 1);
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

  it('discards a delayed old-plate payload after a newer Preview activation', async () => {
    const oldReceipt = receipt;
    const newReceipt = { plateId: 'plate-2', inputStamp: 3, resultGeneration: '1', sliceTaskId: '18' };
    let resolveOld!: (result: ClientSliceResult) => void;
    const oldPayload = new Promise<ClientSliceResult>((resolve) => { resolveOld = resolve; });
    const runtime = {
      getSliceResult: vi.fn((requested: typeof receipt) => requested.plateId === 'plate-1'
        ? oldPayload : Promise.resolve(arcSliceResult(newReceipt, 99))),
    };
    const platform = { runtime, chrome: { kind: 'desktop' } } as unknown as PlatformCapabilities;
    const onToolpath = vi.fn<(toolpath: ToolpathGeometry) => void>();
    const plate = (currentPlateId: string) => ({
      ok: true as const, version: 1 as const, currentPlateId,
      plates: [
        { plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0] as const, name: 'Plate 1' },
        { plateId: 'plate-2', displayIndex: 1, origin: [250, 0, 0] as const, name: 'Plate 2' },
      ],
      inputRevisions: { 'plate-1': 1, 'plate-2': 3 },
    });
    usePlateSessionStore.getState().setSnapshot(plate('plate-1'));
    useSlicerStore.getState().setPlateResult(oldReceipt);
    useSlicerStore.getState().setPlateResult(newReceipt);
    useSlicerStore.getState().activatePlateResult('plate-1', 1);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<PlatformProvider value={platform}><PreviewProbe onToolpath={onToolpath} /></PlatformProvider>);
    });
    await vi.waitFor(() => expect(runtime.getSliceResult).toHaveBeenCalledWith(oldReceipt));

    await act(async () => {
      usePlateSessionStore.getState().setSnapshot(plate('plate-2'));
      useSlicerStore.getState().activatePlateResult('plate-2', 3);
    });
    await vi.waitFor(() => expect(onToolpath).toHaveBeenCalledOnce());
    expect(onToolpath.mock.lastCall?.[0].ends.at(-3)).toBe(99);

    await act(async () => { resolveOld(arcSliceResult(oldReceipt, 7)); });
    expect(onToolpath).toHaveBeenCalledOnce();
    expect(onToolpath.mock.lastCall?.[0].ends.at(-3)).toBe(99);
  });
});
