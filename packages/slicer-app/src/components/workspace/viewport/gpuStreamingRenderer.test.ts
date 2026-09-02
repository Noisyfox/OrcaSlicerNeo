import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  planGpuStreamingPages,
  rebuildGpuStreamingSelection,
  type GpuStreamingPagePlan,
  type GpuStreamingSource,
} from './gpuStreamingPlanner';
import {
  GPU_STREAMING_FRAGMENT_SHADER,
  GPU_STREAMING_TEMPLATE_FACE_INDICES,
  GPU_STREAMING_VERTEX_SHADER,
  createGpuStreamingRenderer,
  packGpuStreamingStaticAtlas,
  probeGpuStreamingCapabilities,
  type GpuStreamingIndexStreamUpload,
  type GpuStreamingResourceFacade,
  type GpuStreamingStaticAtlasUpload,
} from './gpuStreamingRenderer';

function source(): GpuStreamingSource {
  return {
    segmentCount: 4,
    starts: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]),
    ends: new Float32Array([1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0]),
    widths: new Float32Array([0.4, 0.5, 0.6, 0.7]),
    heights: new Float32Array([0.2, 0.2, 0.25, 0.3]),
    layerIds: new Uint32Array([0, 0, 1, 1]),
    moveOrders: new Uint32Array([0, 1, 0, 1]),
    gcodeIds: new Uint32Array([10, 11, 12, 13]),
    moveTypes: new Uint8Array([1, 8, 2, 3]),
    extrusionRoles: new Uint16Array([1, 2, 3, 4]),
    extruderIds: new Uint8Array([0, 0, 1, 1]),
    colorPrintIds: new Uint8Array([0, 0, 1, 1]),
    features: new Uint32Array([4, 5, 6, 7]),
    palette: [
      { id: 4, name: 'feature', color: [1, 2, 3] },
      { id: 5, name: 'travel', color: [4, 5, 6] },
    ],
    metrics: {},
    layers: [],
  };
}

function plan(): GpuStreamingPagePlan {
  return planGpuStreamingPages(source(), { softPageTarget: 2 });
}

/** A deterministic high-layer stream that necessarily spans several pages. */
function multiPageHighLayerSource(): GpuStreamingSource {
  const layerCounts = [18_000, 17_000, 16_000, 19_000];
  const segmentCount = layerCounts.reduce((sum, count) => sum + count, 0);
  const layerIds = new Uint32Array(segmentCount);
  const moveOrders = new Uint32Array(segmentCount);
  const starts = new Float32Array(segmentCount * 3);
  const ends = new Float32Array(segmentCount * 3);
  const widths = new Float32Array(segmentCount).fill(0.4);
  const heights = new Float32Array(segmentCount).fill(0.2);
  const features = new Uint32Array(segmentCount);
  let cursor = 0;
  layerCounts.forEach((count, layer) => {
    for (let move = 0; move < count; move++, cursor++) {
      layerIds[cursor] = layer;
      moveOrders[cursor] = move;
      starts[cursor * 3] = cursor;
      ends[cursor * 3] = cursor + 1;
    }
  });
  return {
    segmentCount,
    starts,
    ends,
    widths,
    heights,
    layerIds,
    moveOrders,
    gcodeIds: new Uint32Array(segmentCount),
    moveTypes: new Uint8Array(segmentCount).fill(1),
    extrusionRoles: new Uint16Array(segmentCount),
    extruderIds: new Uint8Array(segmentCount),
    colorPrintIds: new Uint8Array(segmentCount),
    features,
    palette: [{ id: 0, name: 'feature', color: [255, 128, 0] }],
    metrics: {},
    layers: [],
  };
}

function context(overrides: Record<string, unknown> = {}): WebGLRenderingContext {
  const values: Record<string, unknown> = {
    VERSION: 'WebGL 2.0 mock',
    MAX_TEXTURE_SIZE: 4096,
    MAX_TEXTURE_IMAGE_UNITS: 8,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 8,
    R32UI: 0x8236,
    RED_INTEGER: 0x8d94,
    ...overrides,
  };
  return {
    VERSION: 'VERSION',
    MAX_TEXTURE_SIZE: 'MAX_TEXTURE_SIZE',
    MAX_TEXTURE_IMAGE_UNITS: 'MAX_TEXTURE_IMAGE_UNITS',
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 'MAX_VERTEX_TEXTURE_IMAGE_UNITS',
    R32UI: values.R32UI,
    RED_INTEGER: values.RED_INTEGER,
    getParameter: (key: unknown) => values[key as string],
  } as unknown as WebGLRenderingContext;
}

function facade() {
  const staticUploads: GpuStreamingStaticAtlasUpload[] = [];
  const indexUploads: GpuStreamingIndexStreamUpload[] = [];
  const paletteUploads: Array<{ width: number; colors: Float32Array; unknownFeatureIds: readonly number[] }> = [];
  const staticDisposals: Array<ReturnType<typeof vi.fn>> = [];
  const indexDisposals: Array<ReturnType<typeof vi.fn>> = [];
  const paletteDisposals: Array<ReturnType<typeof vi.fn>> = [];
  const templateDispose = vi.fn();
  const resourceFacade: GpuStreamingResourceFacade = {
    createSharedTemplate: () => ({ dispose: templateDispose }),
    createStaticAtlas: (upload) => {
      staticUploads.push(upload);
      const dispose = vi.fn();
      staticDisposals.push(dispose);
      return { dispose };
    },
    createIndexStream: (upload) => {
      indexUploads.push(upload);
      const dispose = vi.fn();
      indexDisposals.push(dispose);
      return { width: upload.width, height: upload.height, dispose };
    },
    createPalette: (upload) => {
      paletteUploads.push(upload);
      const dispose = vi.fn();
      paletteDisposals.push(dispose);
      return { width: upload.width, dispose };
    },
  };
  return { resourceFacade, staticUploads, indexUploads, paletteUploads, staticDisposals, indexDisposals, paletteDisposals, templateDispose };
}

describe('GPU streaming WebGL2 renderer backend', () => {
  it('probes WebGL2 integer sampling, vertex fetch, limits and texture budget', () => {
    expect(probeGpuStreamingCapabilities(context()).supported).toBe(true);
    expect(probeGpuStreamingCapabilities(context({ VERSION: 'WebGL 1.0' })).reason).toBe('webgl2-required');
    expect(probeGpuStreamingCapabilities(context({ MAX_VERTEX_TEXTURE_IMAGE_UNITS: 2 })).reason)
      .toBe('vertex-texture-fetch-unavailable');
    expect(probeGpuStreamingCapabilities(context({ R32UI: undefined })).reason).toBe('integer-textures-unavailable');
  });

  it('packs planner pages using exact atlas dimensions/schema and round-trips static values', () => {
    const p = plan();
    const upload = packGpuStreamingStaticAtlas(p, p.pages[0]!);
    expect([upload.geometryWidth, upload.geometryHeight]).toEqual([p.pages[0]!.geometryAtlasWidth, p.pages[0]!.geometryAtlasHeight]);
    expect([upload.identityWidth, upload.identityHeight]).toEqual([p.pages[0]!.identityAtlasWidth, p.pages[0]!.identityAtlasHeight]);
    expect(upload.geometry.length / 4).toBe(p.pages[0]!.geometryAtlasTexelCount);
    expect(upload.identity.length / 4).toBe(p.pages[0]!.identityAtlasTexelCount);
    expect(upload.geometryTexelCount).toBe(6); // 3 float texels × 2 segments
    expect(upload.identityTexelCount).toBe(2); // 1 integer texel × 2 segments
    expect(upload.geometryTexelCount + upload.identityTexelCount).toBe(4 * p.pages[0]!.segmentCount);
    expect(upload.uploadedBytes).toBe(upload.geometry.byteLength + upload.identity.byteLength);
    expect(upload.texelCount).toBe(p.pages[0]!.atlasTexelCount);
    expect(Array.from(upload.geometry.slice(0, 8))).toEqual([0, 0, 0, 0, 1, 0, 0, 0]);
    expect(upload.geometry[8]).toBeCloseTo(0.4);
    expect(upload.geometry[9]).toBeCloseTo(0.2);
    expect(Array.from(upload.geometry.slice(10, 12))).toEqual([0, 0]);
    // Identity is RGBA32UI: layer, move order, feature and move type.
    expect(Array.from(upload.identity.slice(0, 4))).toEqual([0, 0, 1, 1]);
  });

  it('constructs the default Three resources without requiring a renderer compile', () => {
    const result = createGpuStreamingRenderer(plan(), { context: context(), compile: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backend.template.material?.glslVersion).toBe('300 es');
    expect(GPU_STREAMING_TEMPLATE_FACE_INDICES).toHaveLength(24);
    const scene = new THREE.Group();
    result.backend.attachToScene(scene);
    expect(scene.children).toHaveLength(2);
    result.backend.detachFromScene(scene);
    expect(scene.children).toHaveLength(0);
    result.backend.dispose();
  });

  it('keeps high layers visible across page boundaries and through the model shell', () => {
    const highLayerPlan = planGpuStreamingPages(multiPageHighLayerSource(), { softPageTarget: 20_000 });
    expect(highLayerPlan.pages.length).toBeGreaterThan(1);
    const result = createGpuStreamingRenderer(highLayerPlan, { context: context() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const selection = rebuildGpuStreamingSelection(highLayerPlan, {
      visibleLayerStart: 0,
      visibleLayerEnd: 3,
      activeMoveEnd: Number.MAX_SAFE_INTEGER,
      showTravel: true,
      featureVisibility: { 0: true },
    });
    expect(selection.visitedSegments).toBe(highLayerPlan.source.segmentCount);
    expect(selection.emittedSegments).toBe(highLayerPlan.source.segmentCount);
    const update = result.backend.updateSelection(selection);
    expect(update.drawInstanceCounts.reduce((sum, count) => sum + count, 0))
      .toBe(highLayerPlan.source.segmentCount);
    expect(update.drawInstanceCounts.at(-1)).toBe(19_000);
    expect(result.backend.template.material?.depthTest).toBe(false);
    expect(result.backend.template.material?.depthWrite).toBe(false);
    expect(result.backend.template.material?.transparent).toBe(true);
    result.backend.dispose();
  });

  it('uploads static atlases once, while selection replaces only dynamic streams', () => {
    const f = facade();
    const result = createGpuStreamingRenderer(plan(), { context: context(), resourceFacade: f.resourceFacade });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const backend = result.backend;
    expect(f.staticUploads).toHaveLength(2);
    expect(backend.staticUploadedBytes).toBe(f.staticUploads.reduce((sum, upload) => sum + upload.uploadedBytes, 0));
    expect(backend.unknownFeatureIds).toEqual([6, 7]);
    expect(f.paletteUploads).toHaveLength(1);
    const selection = {
      pages: plan().pages.map((page) => ({ firstSegment: page.firstSegment, indices: new Uint32Array([0]), emittedCount: 1 })),
      visitedSegments: 4,
      emittedSegments: 2,
    };
    expect(backend.updateSelection(selection)).toEqual({ uploadedPageCount: 2, drawInstanceCounts: [1, 1] });
    expect(f.staticUploads).toHaveLength(2);
    expect(f.indexUploads).toHaveLength(2);
    expect(backend.updatePalette([{ id: 4, name: 'feature', color: [9, 8, 7] }])).toEqual({ uploaded: true, unknownFeatureIds: [5, 6, 7] });
    expect(f.paletteUploads).toHaveLength(2);
    // Stable slot 2 belongs to source feature 5 even though the replacement
    // palette omitted it; it must remain an opaque deterministic fallback.
    expect(Array.from(f.paletteUploads[1]!.colors.slice(8, 12)).map((value) => Number(value.toFixed(2))))
      .toEqual([0.58, 0.58, 0.58, 1]);
    backend.updateCamera({ position: { x: 1, y: 2, z: 3 } as never });
    expect(f.staticUploads).toHaveLength(2);
    expect(f.indexUploads).toHaveLength(2);
    expect(f.paletteUploads).toHaveLength(2);
    backend.dispose();
    backend.dispose();
    expect(f.templateDispose).toHaveBeenCalledTimes(1);
    expect(f.staticDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(f.indexDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(f.paletteDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });

  it('keeps old index streams until draw boundary and reports page draw counts', () => {
    const f = facade();
    const result = createGpuStreamingRenderer(plan(), { context: context(), resourceFacade: f.resourceFacade });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const selection = { pages: plan().pages.map((p) => ({ firstSegment: p.firstSegment, indices: new Uint32Array([0]), emittedCount: 1 })), visitedSegments: 4, emittedSegments: 2 };
    result.backend.updateSelection(selection);
    result.backend.updateSelection(selection);
    expect(f.indexDisposals.every((dispose) => dispose.mock.calls.length === 0)).toBe(true);
    // Palette replacement follows the same retirement contract.
    result.backend.updatePalette([{ id: 4, name: 'feature', color: [9, 8, 7] }]);
    expect(f.paletteDisposals[0]).not.toHaveBeenCalled();
    // Simulate Three's post-draw callbacks. Both pages must finish before
    // either page's retired stream is released.
    result.backend.notifyPageRendered(0);
    expect(f.indexDisposals.slice(0, 2).every((dispose) => dispose.mock.calls.length === 0)).toBe(true);
    expect(f.paletteDisposals[0]).not.toHaveBeenCalled();
    result.backend.notifyPageRendered(1);
    expect(f.indexDisposals.slice(0, 2).every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(f.paletteDisposals[0]).toHaveBeenCalledTimes(1);
  });

  it('returns unavailable and cleans partial construction failures', () => {
    const f = facade();
    let count = 0;
    const failing: GpuStreamingResourceFacade = {
      ...f.resourceFacade,
      createStaticAtlas: (upload) => {
        count++;
        if (count === 2) throw new Error('atlas allocation failed');
        return f.resourceFacade.createStaticAtlas(upload);
      },
    };
    const result = createGpuStreamingRenderer(plan(), { context: context(), resourceFacade: failing });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.reason).toBe('construction-failed');
    expect(f.templateDispose).toHaveBeenCalledTimes(1);
    expect(f.staticDisposals[0]).toHaveBeenCalledTimes(1);
  });

  it('returns a diagnostic and cleans resources when Three compilation fails', () => {
    const f = facade();
    const result = createGpuStreamingRenderer(plan(), {
      context: context(),
      renderer: { getContext: () => context(), compile: () => { throw new Error('shader compile failed'); } },
      resourceFacade: f.resourceFacade,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.message).toContain('shader compile failed');
    expect(f.templateDispose).toHaveBeenCalledTimes(1);
    expect(f.staticDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });

  it('does not allocate when capability probing fails', () => {
    const f = facade();
    const result = createGpuStreamingRenderer(plan(), { context: context({ VERSION: 'WebGL 1.0' }), resourceFacade: f.resourceFacade });
    expect(result.ok).toBe(false);
    expect(f.staticUploads).toHaveLength(0);
    expect(f.templateDispose).not.toHaveBeenCalled();
  });

  it('rejects an over-budget plan before allocating template, palette, or atlases', () => {
    const overBudgetPlan = planGpuStreamingPages(source(), {
      softPageTarget: 2,
      gpuBudgetBytes: 1,
      pageOverheadBytes: 0,
      sharedTemplateBytes: 0,
    });
    expect(overBudgetPlan.diagnostics.hardCapacity).toBe(1);
    expect(overBudgetPlan.diagnostics.budgetExceeded).toBe(true);
    const f = facade();
    const result = createGpuStreamingRenderer(overBudgetPlan, { context: context(), resourceFacade: f.resourceFacade });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.reason).toBe('gpu-budget-exceeded');
    expect(f.templateDispose).not.toHaveBeenCalled();
    expect(f.staticUploads).toHaveLength(0);
    expect(f.paletteUploads).toHaveLength(0);
  });

  it('releases resources on context loss without owning the external renderer', () => {
    const f = facade();
    const element = new EventTarget();
    const result = createGpuStreamingRenderer(plan(), {
      context: context(),
      renderer: { getContext: () => context(), domElement: element },
      resourceFacade: f.resourceFacade,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    element.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(result.backend.status).toBe('context-lost');
    expect(f.templateDispose).toHaveBeenCalledTimes(1);
    expect(f.paletteDisposals[0]).toHaveBeenCalledTimes(1);
    result.backend.dispose();
    expect(f.templateDispose).toHaveBeenCalledTimes(1);
  });
});

describe('GPU streaming shader source contract', () => {
  it('uses GLSL ES 3, integer texelFetch and a shared indexed instance template', () => {
    expect(GPU_STREAMING_VERTEX_SHADER).toContain('#version 300 es');
    expect(GPU_STREAMING_VERTEX_SHADER).toContain('usampler2D');
    expect(GPU_STREAMING_VERTEX_SHADER).toContain('texelFetch');
    expect(GPU_STREAMING_VERTEX_SHADER).toContain('gl_InstanceID');
    expect(GPU_STREAMING_VERTEX_SHADER).toContain('uCameraPosition');
    expect(GPU_STREAMING_VERTEX_SHADER).not.toContain('samplerBuffer');
    expect(GPU_STREAMING_FRAGMENT_SHADER).toContain('uPalette');
    expect(GPU_STREAMING_FRAGMENT_SHADER).toContain('texelFetch');
    expect(GPU_STREAMING_FRAGMENT_SHADER).toContain('uEarlierLayerDim');
  });
});
