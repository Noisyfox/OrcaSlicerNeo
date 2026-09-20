import { describe, expect, it } from 'vitest';
import type { ClientToolpath } from '@slicer/client';
import {
  adaptClientToolpath,
  createGpuStreamingPagePlan,
  deriveLogicalMoveOrders,
  planGpuStreamingPages,
  rebuildGpuStreamingSelection,
} from './gpuStreamingPlanner';

function clientToolpath(overrides: Partial<ClientToolpath> = {}): ClientToolpath {
  const layerIds = Uint32Array.from([0, 0, 0, 1, 1, 2, 2, 2, 2, 2, 2]);
  const segmentCount = layerIds.length;
  const starts = new Float32Array(segmentCount * 3);
  const ends = new Float32Array(segmentCount * 3);
  for (let i = 0; i < segmentCount; i++) {
    starts[i * 3] = i;
    ends[i * 3] = i + 1;
  }
  return {
    features: Uint32Array.from([0, 1, 0, 1, 0, 1, 2, 0, 1, 2, 0]),
    palette: [
      { id: 0, name: 'one', color: [1, 2, 3] },
      { id: 1, name: 'two', color: [4, 5, 6] },
      { id: 2, name: 'three', color: [7, 8, 9] },
    ],
    segmentCount,
    starts,
    ends,
    layerIds,
    moveOrders: Uint32Array.from([0, 1, 2, 0, 1, 0, 1, 2, 3, 4, 5]),
    gcodeIds: Uint32Array.from({ length: segmentCount }, (_, i) => i + 10),
    moveTypes: Uint8Array.from([10, 10, 8, 10, 10, 8, 10, 10, 10, 10, 10]),
    extrusionRoles: new Uint16Array(segmentCount),
    extruderIds: new Uint8Array(segmentCount),
    colorPrintIds: new Uint8Array(segmentCount),
    widths: new Float32Array(segmentCount).fill(0.4),
    heights: new Float32Array(segmentCount).fill(0.2),
    metrics: {},
    ...overrides,
  };
}

describe('GPU streaming source adapter and page planner', () => {
  it('coalesces consecutive arc-like source ids into one logical move while retaining segments', () => {
    const layerIds = Uint32Array.from([0, 0, 0, 0]);
    const gcodeIds = Uint32Array.from([41, 41, 41, 42]);
    const bridgeMoveOrders = Uint32Array.from([0, 1, 1, 1]);
    expect(deriveLogicalMoveOrders(layerIds, gcodeIds, 4)).toEqual(new Uint32Array([0, 0, 0, 1]));
    const input = clientToolpath({
      layerIds: Uint32Array.from([...layerIds, 1, 1, 2, 2, 2, 2, 2]),
      gcodeIds: Uint32Array.from([...gcodeIds, 50, 51, 52, 53, 54, 55, 56]),
      moveOrders: Uint32Array.from([...bridgeMoveOrders, 0, 1, 2, 3, 4, 5, 6]),
    });
    const source = adaptClientToolpath(input);
    expect(source.segmentCount).toBe(11);
    expect(source.starts).toBe(input.starts);
    expect(source.ends).toBe(input.ends);
    expect(source.metrics).toBe(input.metrics);
    expect(source.moveOrders).toBe(input.moveOrders);
    expect(source.moveOrders.slice(0, 4)).toEqual(bridgeMoveOrders);
  });

  it('retains bridge move order semantics for distinct and unmapped moves', () => {
    const input = clientToolpath({
      layerIds: Uint32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 2]),
      moveOrders: Uint32Array.from([0, 0, 1, 0, 1, 1, 0, 1, 2, 3, 4]),
      gcodeIds: Uint32Array.from([7, 7, 0, 0, 7, 7, 8, 9, 10, 11, 12]),
    });
    const source = adaptClientToolpath(input);
    expect(source.moveOrders).toBe(input.moveOrders);
    expect(Array.from(source.moveOrders.slice(0, 6))).toEqual([0, 0, 1, 0, 1, 1]);
  });

  it('retains source SoA arrays and derives immutable layer metadata', () => {
    const input = clientToolpath();
    const source = adaptClientToolpath(input, {
      layerRanges: [
        { id: 0, z: 0.2, firstSegment: 0, segmentCount: 3 },
        { id: 1, z: 0.4, firstSegment: 3, segmentCount: 2 },
        { id: 2, z: 0.6, firstSegment: 5, segmentCount: 6 },
      ],
    });
    expect(source.starts).toBe(input.starts);
    expect(source.ends).toBe(input.ends);
    expect(source.features).toBe(input.features);
    expect(source.layers).toEqual([
      { id: 0, firstSegment: 0, segmentCount: 3, z: 0.2 },
      { id: 1, firstSegment: 3, segmentCount: 2, z: 0.4 },
      { id: 2, firstSegment: 5, segmentCount: 6, z: 0.6 },
    ]);
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.layers)).toBe(true);
  });

  it.each([
    ['empty', []],
    ['gapped', [{ id: 0, firstSegment: 0, segmentCount: 3 }, { id: 2, firstSegment: 5, segmentCount: 6 }]],
    ['overlapping', [{ id: 0, firstSegment: 0, segmentCount: 3 }, { id: 1, firstSegment: 2, segmentCount: 3 }]],
    ['mismatched ids', [{ id: 99, firstSegment: 0, segmentCount: 11 }]],
  ] as const)('normalizes a direct source with a %s layer table', (_name, layers) => {
    const adapted = adaptClientToolpath(clientToolpath());
    const directSource = { ...adapted, layers };
    const plan = planGpuStreamingPages(directSource);
    expect(plan.source).not.toBe(directSource);
    expect(plan.layers).not.toBe(layers);
    expect(plan.layers).toEqual([
      { id: 0, firstSegment: 0, segmentCount: 3 },
      { id: 1, firstSegment: 3, segmentCount: 2 },
      { id: 2, firstSegment: 5, segmentCount: 6 },
    ]);
    expect(plan.pages.at(0)?.firstSegment).toBe(0);
    expect(plan.pages.at(-1)!.firstSegment + plan.pages.at(-1)!.segmentCount).toBe(plan.source.segmentCount);
    expect(Object.isFrozen(plan.layers)).toBe(true);
    expect(Object.isFrozen(plan.pages)).toBe(true);
    expect(Object.isFrozen(plan.pages[0])).toBe(true);
  });

  it('rejects a direct source whose static SoA cannot cover every segment', () => {
    const adapted = adaptClientToolpath(clientToolpath());
    expect(() => planGpuStreamingPages({
      ...adapted,
      ends: adapted.ends.subarray(0, adapted.ends.length - 3),
    })).toThrow(/ends/);
    expect(() => planGpuStreamingPages({
      ...adapted,
      metrics: { feedrate: new Float32Array(adapted.segmentCount - 1) },
    })).toThrow(/metrics.feedrate/);
  });

  it('keeps normal pages layer-aligned and marks a soft-target exception', () => {
    const plan = createGpuStreamingPagePlan(clientToolpath(), undefined, { softPageTarget: 5 });
    expect(plan.pages.map(({ firstSegment, segmentCount, firstLayer, lastLayer, oversized }) => ({
      firstSegment, segmentCount, firstLayer, lastLayer, oversized,
    }))).toEqual([
      { firstSegment: 0, segmentCount: 5, firstLayer: 0, lastLayer: 1, oversized: false },
      { firstSegment: 5, segmentCount: 6, firstLayer: 2, lastLayer: 2, oversized: true },
    ]);
    expect(plan.diagnostics.oversizedLayerCount).toBe(1);
    expect(plan.diagnostics.splitOversizedLayerCount).toBe(0);
  });

  it('splits only an oversized layer when a future hard capacity requires it', () => {
    const plan = createGpuStreamingPagePlan(clientToolpath(), undefined, {
      softPageTarget: 5,
      hardCapacity: 4,
    });
    expect(plan.pages.map((page) => [page.firstSegment, page.segmentCount, page.firstLayer, page.lastLayer])).toEqual([
      [0, 3, 0, 0], [3, 2, 1, 1], [5, 4, 2, 2], [9, 2, 2, 2],
    ]);
    expect(plan.pages.slice(2).every((page) => page.oversized && page.oversizedLayer)).toBe(true);
    expect(plan.diagnostics.hardCapacity).toBe(4);
    expect(plan.diagnostics.splitOversizedLayerCount).toBe(1);
  });

  it('rebuilds page-local indices in source order with inclusive filters', () => {
    const plan = createGpuStreamingPagePlan(clientToolpath(), undefined, { softPageTarget: 5 });
    const selection = rebuildGpuStreamingSelection(plan, {
      visibleLayerStart: 1,
      visibleLayerEnd: 2,
      activeMoveEnd: 2,
      showTravel: false,
      visibility: { 1: false },
    });
    const globalIndices = selection.pages.flatMap((page) => Array.from(page.indices, (id) => page.firstSegment + id));
    expect(selection.visitedSegments).toBe(plan.source.segmentCount);
    expect(globalIndices).toEqual([4, 6, 7]);
    expect(globalIndices).toEqual([...globalIndices].sort((a, b) => a - b));
    expect(selection.emittedSegments).toBe(globalIndices.length);
  });

  it('applies a filament legend filter by tool id while leaving travel global', () => {
    const plan = createGpuStreamingPagePlan(clientToolpath({
      extruderIds: Uint8Array.from([0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0]),
    }));
    const selection = rebuildGpuStreamingSelection(plan, {
      visibleLayerStart: 0,
      visibleLayerEnd: 2,
      activeMoveEnd: Number.MAX_SAFE_INTEGER,
      showTravel: true,
      visibility: { 1: false },
      visibilityField: 'filament',
    });
    const globalIndices = selection.pages.flatMap((page) => Array.from(page.indices, (id) => page.firstSegment + id));
    expect(globalIndices).toEqual([0, 2, 3, 5, 8, 10]);
    expect(globalIndices).toContain(2);
    expect(globalIndices).not.toContain(1);
  });

  it('covers every segment exactly once without splitting normal layers', () => {
    const source = adaptClientToolpath(clientToolpath());
    const plan = planGpuStreamingPages(source, { softPageTarget: 5 });
    let cursor = 0;
    for (const page of plan.pages) {
      expect(page.firstSegment).toBe(cursor);
      expect(page.segmentCount).toBeGreaterThan(0);
      expect(page.firstLayer).toBe(source.layerIds[page.firstSegment]);
      expect(page.lastLayer).toBe(source.layerIds[page.firstSegment + page.segmentCount - 1]);
      expect(page.firstSegment === 0 || source.layerIds[page.firstSegment - 1] !== page.firstLayer).toBe(true);
      expect(page.firstSegment + page.segmentCount === source.segmentCount || source.layerIds[page.firstSegment + page.segmentCount] !== page.lastLayer).toBe(true);
      cursor += page.segmentCount;
    }
    expect(cursor).toBe(source.segmentCount);
    const estimatedStaticBytes = plan.pages.reduce((sum, page) => sum + page.estimatedStaticBytes, 0);
    expect(plan.diagnostics.estimatedStaticBytes).toBe(estimatedStaticBytes);
    expect(plan.diagnostics.estimatedIndexCapacityBytes).toBeGreaterThan(0);
    expect(plan.diagnostics.estimatedBytes).toBe(estimatedStaticBytes + plan.diagnostics.estimatedIndexCapacityBytes);
  });

  it('exposes budget and texture-capacity inputs without querying WebGL', () => {
    const source = adaptClientToolpath(clientToolpath());
    const plan = planGpuStreamingPages(source, {
      maxTextureSize: 8,
      gpuBudgetBytes: 10_000,
      pageOverheadBytes: 32,
      sharedTemplateBytes: 64,
    });
    expect(plan.diagnostics.texelSchema.texelsPerSegment).toBe(4);
    expect(plan.diagnostics.hardCapacity).toBe(Math.floor(64 / 3));
    expect(plan.pages.every((page) => page.geometryAtlasWidth <= 8 && page.identityAtlasWidth <= 8)).toBe(true);
    expect(plan.diagnostics.allocatedBytes).toBeNull();
  });
});
