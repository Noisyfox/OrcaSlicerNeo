import { describe, expect, it, vi } from 'vitest';
import { planGpuStreamingPages, type GpuStreamingPagePlan, type GpuStreamingSource } from './gpuStreamingPlanner';
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
    palette: [],
    metrics: {},
    layers: [],
  };
}

function plan(): GpuStreamingPagePlan {
  return planGpuStreamingPages(source(), { softPageTarget: 2 });
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
  const staticDisposals: Array<ReturnType<typeof vi.fn>> = [];
  const indexDisposals: Array<ReturnType<typeof vi.fn>> = [];
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
  };
  return { resourceFacade, staticUploads, indexUploads, staticDisposals, indexDisposals, templateDispose };
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
    expect([upload.width, upload.height]).toEqual([p.pages[0]!.atlasWidth, p.pages[0]!.atlasHeight]);
    expect(upload.texelCount).toBe(p.pages[0]!.atlasTexelCount);
    expect(Array.from(upload.geometry.slice(0, 8))).toEqual([0, 0, 0, 0, 1, 0, 0, 0]);
    expect(upload.geometry[8]).toBeCloseTo(0.4);
    expect(upload.geometry[9]).toBeCloseTo(0.2);
    expect(Array.from(upload.geometry.slice(10, 12))).toEqual([0, 0]);
    // Identity is RGBA32UI: layer, move order, feature and move type.
    expect(Array.from(upload.identity.slice(12, 16))).toEqual([0, 0, 4, 1]);
  });

  it('constructs the default Three resources without requiring a renderer compile', () => {
    const result = createGpuStreamingRenderer(plan(), { context: context(), compile: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backend.template.material?.glslVersion).toBe('300 es');
    expect(GPU_STREAMING_TEMPLATE_FACE_INDICES).toHaveLength(24);
    result.backend.dispose();
  });

  it('uploads static atlases once, while selection replaces only dynamic streams', () => {
    const f = facade();
    const result = createGpuStreamingRenderer(plan(), { context: context(), resourceFacade: f.resourceFacade });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const backend = result.backend;
    expect(f.staticUploads).toHaveLength(2);
    const selection = {
      pages: plan().pages.map((page) => ({ firstSegment: page.firstSegment, indices: new Uint32Array([0]), emittedCount: 1 })),
      visitedSegments: 4,
      emittedSegments: 2,
    };
    expect(backend.updateSelection(selection)).toEqual({ uploadedPageCount: 2, drawInstanceCounts: [1, 1] });
    expect(f.staticUploads).toHaveLength(2);
    expect(f.indexUploads).toHaveLength(2);
    backend.updateCamera({ position: { x: 1, y: 2, z: 3 } as never });
    expect(f.staticUploads).toHaveLength(2);
    expect(f.indexUploads).toHaveLength(2);
    backend.dispose();
    backend.dispose();
    expect(f.templateDispose).toHaveBeenCalledTimes(1);
    expect(f.staticDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(f.indexDisposals.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
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
    result.backend.commitDrawBoundary();
    expect(f.indexDisposals.slice(0, 2).every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
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
    expect(GPU_STREAMING_FRAGMENT_SHADER).toContain('uEarlierLayerDim');
  });
});
