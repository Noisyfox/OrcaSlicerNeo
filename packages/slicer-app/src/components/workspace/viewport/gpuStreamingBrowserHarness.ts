import * as THREE from 'three';
import {
  createGpuStreamingMetadata,
  GPU_STREAM_EXTRUSION_MOVE_TYPE,
  GPU_STREAM_TRAVEL_MOVE_TYPE,
  GPU_STREAM_FIXTURE_SEED,
  GPU_STREAM_FIXTURE_LAYER_COUNT,
  GPU_STREAM_PAGE_TARGET,
} from './gpuStreamingFixture';
import {
  planGpuStreamingPages,
  rebuildGpuStreamingSelection,
  type GpuStreamingSource,
} from './gpuStreamingPlanner';
import {
  createGpuStreamingRenderer,
  type GpuStreamingRenderer,
  type GpuStreamingRendererHost,
  type GpuStreamingUnavailableDiagnostics,
} from './gpuStreamingRenderer';

/** Result emitted by the opt-in real-browser renderer diagnostic. */
export interface GpuStreamingBrowserBenchmarkReport {
  readonly segmentCount: number;
  readonly pageCount: number;
  readonly capabilities: {
    readonly supported: boolean;
    readonly reason: string | null;
    readonly maxTextureSize: number | null;
    readonly maxTextureImageUnits: number | null;
    readonly maxVertexTextureImageUnits: number | null;
  } | null;
  readonly browser: {
    readonly userAgent: string;
    readonly vendor: string | null;
    readonly renderer: string | null;
  } | null;
  /** Shared native template plus immutable static source textures. */
  readonly staticTextureBytes: number;
  readonly staticUploadCount: number;
  readonly indexUploadCount: number;
  readonly staticUploadMs: number | null;
  readonly selectionRebuildUploadMs: number | null;
  readonly selectionVisitedSegments: number;
  readonly selectionUploadedBytes: number;
  readonly cameraFrames: number;
  readonly cameraTotalMs: number | null;
  readonly cameraAverageFrameMs: number | null;
  readonly cameraFps: number | null;
  /** Camera updates must not upload selection indices. */
  readonly cameraIndexUploadCountDelta: number;
  readonly fallbackReason: string | null;
  readonly fallbackMessage: string | null;
  readonly disposed: boolean;
  readonly gpuResourcesBeforeDispose: { readonly textures: number; readonly geometries: number } | null;
  readonly gpuResourcesAfterDispose: { readonly textures: number; readonly geometries: number } | null;
}

export interface GpuStreamingBrowserBenchmarkOptions {
  readonly frameCount?: number;
  readonly width?: number;
  readonly height?: number;
}

type BenchmarkWindow = Window & {
  __orcaE2e?: {
    gpuStreamingBenchmark?: (segmentCount: number, options?: GpuStreamingBrowserBenchmarkOptions) => Promise<GpuStreamingBrowserBenchmarkReport>;
    [key: string]: unknown;
  };
};

function makeBenchmarkSource(segmentCount: number): GpuStreamingSource {
  // The fixture remains metadata-only for unit tests. This browser-only
  // adapter adds bulk SoA geometry, never one object per segment, so the
  // actual solid InstancedMesh path is exercised without changing the
  // fixture's cheap contract.
  const metadata = createGpuStreamingMetadata({
    segmentCount,
    seed: GPU_STREAM_FIXTURE_SEED,
    layerCount: GPU_STREAM_FIXTURE_LAYER_COUNT,
    pageTarget: GPU_STREAM_PAGE_TARGET,
  });
  const starts = new Float32Array(segmentCount * 3);
  const ends = new Float32Array(segmentCount * 3);
  const widths = new Float32Array(segmentCount);
  const heights = new Float32Array(segmentCount);
  const gcodeIds = new Uint32Array(segmentCount);
  const extrusionRoles = new Uint16Array(segmentCount);
  const extruderIds = new Uint8Array(segmentCount);
  const colorPrintIds = new Uint8Array(segmentCount);
  const features = new Uint32Array(metadata.features);
  const angles = new Float32Array(segmentCount);
  const layers = metadata.pages.map((page) => ({
    id: page.firstLayer,
    firstSegment: page.firstSegment,
    segmentCount: page.segmentCount,
  }));
  for (let i = 0; i < segmentCount; i++) {
    const offset = i * 3;
    const x = (i % 2048) * 0.08;
    const y = Math.floor(i / 2048) * 0.08;
    const z = (metadata.layerIds[i] ?? 0) * 0.2;
    starts[offset] = x;
    starts[offset + 1] = y;
    starts[offset + 2] = z;
    ends[offset] = x + 0.06;
    ends[offset + 1] = y + 0.025;
    ends[offset + 2] = z;
    const moveType = metadata.moveTypes[i] ?? 0;
    widths[i] = moveType === GPU_STREAM_TRAVEL_MOVE_TYPE ? 0.05
      : moveType === GPU_STREAM_EXTRUSION_MOVE_TYPE ? 0.42 : 0.3;
    heights[i] = moveType === GPU_STREAM_TRAVEL_MOVE_TYPE ? 0.05 : 0.2;
    gcodeIds[i] = i;
  }
  return {
    segmentCount,
    starts,
    ends,
    widths,
    heights,
    layerIds: metadata.layerIds,
    moveOrders: metadata.moveOrders,
    gcodeIds,
    moveTypes: metadata.moveTypes,
    extrusionRoles,
    extruderIds,
    colorPrintIds,
    features,
    palette: [
      { id: 0, name: 'feature-0', color: [0.2, 0.7, 1] },
      { id: 1, name: 'feature-1', color: [1, 0.55, 0.2] },
      { id: 2, name: 'feature-2', color: [0.4, 1, 0.4] },
      { id: 3, name: 'feature-3', color: [1, 0.35, 0.8] },
    ],
    metrics: {},
    layers,
    angles,
  };
}

function resourceCounts(renderer: THREE.WebGLRenderer): { textures: number; geometries: number } {
  return {
    textures: renderer.info.memory.textures,
    geometries: renderer.info.memory.geometries,
  };
}

function capabilitySummary(renderer: GpuStreamingRenderer): GpuStreamingBrowserBenchmarkReport['capabilities'] {
  return {
    supported: renderer.capabilities.supported,
    reason: renderer.capabilities.reason,
    maxTextureSize: renderer.capabilities.limits.maxTextureSize,
    maxTextureImageUnits: renderer.capabilities.limits.maxTextureImageUnits,
    maxVertexTextureImageUnits: renderer.capabilities.limits.maxVertexTextureImageUnits,
  };
}

function unavailableReport(
  segmentCount: number,
  pageCount: number,
  diagnostics: GpuStreamingUnavailableDiagnostics,
): GpuStreamingBrowserBenchmarkReport {
  const capabilities = diagnostics.capabilities;
  return {
    segmentCount,
    pageCount,
    capabilities: capabilities ? {
      supported: capabilities.supported,
      reason: capabilities.reason,
      maxTextureSize: capabilities.limits.maxTextureSize,
      maxTextureImageUnits: capabilities.limits.maxTextureImageUnits,
      maxVertexTextureImageUnits: capabilities.limits.maxVertexTextureImageUnits,
    } : null,
    browser: null,
    staticTextureBytes: 0,
    staticUploadCount: 0,
    indexUploadCount: 0,
    staticUploadMs: null,
    selectionRebuildUploadMs: null,
    selectionVisitedSegments: 0,
    selectionUploadedBytes: 0,
    cameraFrames: 0,
    cameraTotalMs: null,
    cameraAverageFrameMs: null,
    cameraFps: null,
    cameraIndexUploadCountDelta: 0,
    fallbackReason: diagnostics.reason,
    fallbackMessage: diagnostics.message,
    disposed: true,
    gpuResourcesBeforeDispose: null,
    gpuResourcesAfterDispose: null,
  };
}

/**
 * Run the renderer benchmark in a real browser WebGL2 context. This is a
 * diagnostic API, intentionally not a unit-test timing assertion and never
 * called by normal production startup.
 */
export async function runGpuStreamingBrowserBenchmark(
  segmentCount: number,
  options: GpuStreamingBrowserBenchmarkOptions = {},
): Promise<GpuStreamingBrowserBenchmarkReport> {
  if (typeof document === 'undefined') throw new Error('GPU streaming browser harness requires a document');
  const source = makeBenchmarkSource(segmentCount);
  const plan = planGpuStreamingPages(source, { softPageTarget: GPU_STREAM_PAGE_TARGET });
  const canvas = document.createElement('canvas');
  canvas.width = options.width ?? 640;
  canvas.height = options.height ?? 480;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.position = 'fixed';
  canvas.style.left = '-10000px';
  document.body.appendChild(canvas);
  let renderer: THREE.WebGLRenderer | null = null;
  let backend: GpuStreamingRenderer | null = null;
  let beforeDispose: { textures: number; geometries: number } | null = null;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.setSize(canvas.width, canvas.height, false);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, canvas.width / canvas.height, 0.1, 10000);
    camera.position.set(0, -30, 30);
    camera.lookAt(40, 40, 20);
    const host: GpuStreamingRendererHost = {
      getContext: () => renderer!.getContext() as WebGLRenderingContext,
      domElement: renderer.domElement,
      compile: (nextScene, nextCamera) => renderer!.compile(nextScene, nextCamera),
    };
    const context = renderer.getContext() as WebGLRenderingContext;
    const debugInfo = context.getExtension('WEBGL_debug_renderer_info') as {
      UNMASKED_VENDOR_WEBGL: number;
      UNMASKED_RENDERER_WEBGL: number;
    } | null;
    const browser = {
      userAgent: navigator.userAgent,
      vendor: debugInfo ? String(context.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)) : null,
      renderer: debugInfo ? String(context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : null,
    };
    const buildStart = performance.now();
    const built = createGpuStreamingRenderer(plan, { renderer: host, compile: false });
    if (!built.ok) return unavailableReport(segmentCount, plan.pages.length, built.diagnostics);
    backend = built.backend;
    const initialSelection = rebuildGpuStreamingSelection(plan, {
      visibleLayerStart: 0,
      visibleLayerEnd: plan.layers.length - 1,
      activeMoveEnd: Number.MAX_SAFE_INTEGER,
      showTravel: true,
    });
    backend.updateSelection(initialSelection);
    backend.attachToScene(scene);
    renderer.render(scene, camera); // force Three.js to issue native segment draws
    const staticUploadMs = performance.now() - buildStart;

    const selectionStart = performance.now();
    const selection = rebuildGpuStreamingSelection(plan, {
      visibleLayerStart: Math.min(2, Math.max(0, plan.layers.length - 1)),
      visibleLayerEnd: Math.max(0, plan.layers.length - 1),
      activeMoveEnd: Number.MAX_SAFE_INTEGER,
      showTravel: false,
      featureVisibility: { 1: false },
    });
    backend.updateSelection(selection);
    renderer.render(scene, camera); // complete the draw boundary
    const selectionRebuildUploadMs = performance.now() - selectionStart;
    const indexUploadCountBeforeCamera = backend.indexUploadCount;

    const frameCountTarget = Math.max(1, Math.floor(options.frameCount ?? 30));
    let cameraFrames = 0;
    const cameraStart = performance.now();
    await new Promise<void>((resolve) => {
      const frame = () => {
        camera.position.x += 0.01;
        backend!.updateCamera({ position: camera.position });
        renderer!.render(scene, camera);
        cameraFrames++;
        if (cameraFrames >= frameCountTarget) resolve();
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    const cameraTotalMs = performance.now() - cameraStart;
    beforeDispose = resourceCounts(renderer);
    const staticTextureBytes = backend.staticUploadedBytes;
    const selectionUploadedBytes = backend.indexUploadedBytes;
    const cameraIndexUploadCountDelta = backend.indexUploadCount - indexUploadCountBeforeCamera;
    const capabilities = capabilitySummary(backend);
    backend.detachFromScene(scene);
    backend.dispose();
    renderer.renderLists.dispose();
    renderer.dispose();
    const afterDispose = resourceCounts(renderer);
    renderer.forceContextLoss();
    return {
      segmentCount,
      pageCount: plan.pages.length,
      capabilities,
      browser,
      staticTextureBytes,
      staticUploadCount: backend.staticUploadCount,
      indexUploadCount: backend.indexUploadCount,
      staticUploadMs,
      selectionRebuildUploadMs,
      selectionVisitedSegments: selection.visitedSegments,
      selectionUploadedBytes,
      cameraFrames,
      cameraTotalMs,
      cameraAverageFrameMs: cameraTotalMs / Math.max(1, cameraFrames),
      cameraFps: cameraFrames * 1000 / Math.max(0.001, cameraTotalMs),
      cameraIndexUploadCountDelta,
      fallbackReason: null,
      fallbackMessage: null,
      disposed: backend.status === 'disposed',
      gpuResourcesBeforeDispose: beforeDispose,
      gpuResourcesAfterDispose: afterDispose,
    };
  } catch (error) {
    const diagnostics: GpuStreamingUnavailableDiagnostics = {
      reason: 'browser-harness-failed',
      message: error instanceof Error ? error.message : String(error),
      capabilities: backend?.capabilities ?? null,
    };
    if (backend) backend.dispose();
    return unavailableReport(segmentCount, plan.pages.length, diagnostics);
  } finally {
    if (backend && backend.status !== 'disposed') backend.dispose();
    if (renderer) {
      try { renderer.renderLists.dispose(); } catch { /* best effort */ }
      try { renderer.dispose(); } catch { /* best effort */ }
    }
    canvas.remove();
  }
}

/** Install the diagnostic seam only in Vite/electron-vite e2e builds. */
export function installGpuStreamingBrowserHarness(): void {
  const env = (import.meta as ImportMeta & { env?: { MODE?: string; VITE_E2E?: string } }).env;
  if (env?.MODE !== 'e2e' && env?.VITE_E2E !== '1') return;
  const target = globalThis as typeof globalThis & { window?: BenchmarkWindow };
  if (!target.window) return;
  target.window.__orcaE2e = {
    ...target.window.__orcaE2e,
    gpuStreamingBenchmark: (count, options) => runGpuStreamingBrowserBenchmark(count, options),
  };
}
