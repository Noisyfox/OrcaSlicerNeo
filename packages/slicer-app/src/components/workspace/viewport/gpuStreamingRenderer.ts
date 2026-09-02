import * as THREE from 'three';
import type { ToolpathFeature } from '@slicer/client';
import type { GpuStreamingPage, GpuStreamingPagePlan, GpuStreamingSelection } from './gpuStreamingPlanner';
import { createToolpathEntityGeometry, createToolpathEntityMaterial } from './toolpathEntityGeometry';

/**
 * The renderer follows libvgcode's SegmentTemplate ownership model: one
 * shared indexed prism template is drawn through page-local instances.
 * Segment shape is materialized in instance matrices on the CPU; no custom
 * shader or texture fetch participates in toolpath rendering.
 */

export interface GpuStreamingCapabilityLimits {
  readonly maxTextureSize: number | null;
  readonly maxTextureImageUnits: number | null;
  readonly maxVertexTextureImageUnits: number | null;
  readonly textureUnitsRequired: number;
}
export interface GpuStreamingCapabilityProbe {
  readonly supported: boolean;
  readonly reason: string | null;
  readonly limits: GpuStreamingCapabilityLimits;
}
export interface GpuStreamingRendererHost {
  getContext(): WebGLRenderingContext;
  readonly domElement?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  compile?: (scene: THREE.Scene, camera: THREE.Camera) => void;
}
export interface GpuStreamingEntityTemplateResource {
  readonly geometry?: THREE.BufferGeometry;
  readonly material?: THREE.Material;
  readonly dispose: () => void;
}
/** Resource seam used by tests and host-specific allocation policy. */
export interface GpuStreamingResourceFacade {
  createEntityTemplate: () => GpuStreamingEntityTemplateResource;
}
export interface GpuStreamingRendererOptions {
  readonly renderer?: GpuStreamingRendererHost;
  readonly context?: WebGLRenderingContext;
  readonly resourceFacade?: GpuStreamingResourceFacade;
  readonly compile?: boolean;
}
export interface GpuStreamingUnavailableDiagnostics {
  readonly reason: string;
  readonly message: string;
  readonly capabilities: GpuStreamingCapabilityProbe | null;
  readonly failedPage?: number;
}
export type GpuStreamingBuildResult =
  | { readonly ok: true; readonly backend: GpuStreamingRenderer }
  | { readonly ok: false; readonly diagnostics: GpuStreamingUnavailableDiagnostics };
export interface GpuStreamingSelectionUpdate {
  readonly uploadedPageCount: number;
  readonly drawInstanceCounts: readonly number[];
}
export interface GpuStreamingPaletteUpdate {
  readonly uploaded: boolean;
  readonly unknownFeatureIds: readonly number[];
}

function onceDispose(dispose: () => void): () => void {
  let done = false;
  return () => { if (!done) { done = true; dispose(); } };
}
const FALLBACK_COLOR = new THREE.Color(0.58, 0.58, 0.58);
const WORLD_UP = new THREE.Vector3(0, 0, 1);
const X_AXIS = new THREE.Vector3(1, 0, 0);
function paletteColor(palette: readonly ToolpathFeature[], feature: number): THREE.Color {
  // Bridges normally emit local ids, but older preview payloads used the
  // feature's position as the id. Accept both wire forms so an otherwise
  // valid segment never silently falls back to gray.
  const entry = palette.find((candidate) => candidate.id === feature) ?? palette[feature];
  if (!entry) return FALLBACK_COLOR.clone();
  const scale = entry.color.some((value) => Number.isFinite(value) && Math.abs(value) > 1) ? 1 / 255 : 1;
  return new THREE.Color(
    (Number.isFinite(entry.color[0]) ? entry.color[0] : 0) * scale,
    (Number.isFinite(entry.color[1]) ? entry.color[1] : 0) * scale,
    (Number.isFinite(entry.color[2]) ? entry.color[2] : 0) * scale,
  );
}

/** Build the real world-space transform for one libvgcode-compatible prism. */
export function buildGpuStreamingInstanceMatrix(
  source: GpuStreamingPagePlan['source'],
  sourceIndex: number,
  target = new THREE.Matrix4(),
): THREE.Matrix4 {
  const start = new THREE.Vector3(
    source.starts[sourceIndex * 3] ?? 0,
    source.starts[sourceIndex * 3 + 1] ?? 0,
    source.starts[sourceIndex * 3 + 2] ?? 0,
  );
  const end = new THREE.Vector3(
    source.ends[sourceIndex * 3] ?? start.x,
    source.ends[sourceIndex * 3 + 1] ?? start.y,
    source.ends[sourceIndex * 3 + 2] ?? start.z,
  );
  const axis = end.clone().sub(start);
  const length = axis.length();
  if (length > 1e-6) axis.multiplyScalar(1 / length);
  else axis.copy(X_AXIS);
  // Matches libvgcode's line_right/line_up basis, including its vertical
  // fallback, while keeping all dimensions in the instance matrix.
  const side = new THREE.Vector3().crossVectors(axis, WORLD_UP);
  if (side.lengthSq() < 1e-12) side.crossVectors(X_AXIS, axis);
  side.normalize();
  const up = new THREE.Vector3().crossVectors(side, axis).normalize();
  const width = Math.max(0, source.widths[sourceIndex] ?? 0);
  const height = Math.max(0, source.heights[sourceIndex] ?? 0);
  const center = start.clone().add(end).multiplyScalar(0.5);
  center.z += source.biases?.[sourceIndex] ?? 0;
  // The unit centered cuboid spans +/-0.5 on each axis, so these scales
  // produce the requested full dimensions.
  target.makeBasis(axis, side, up).scale(new THREE.Vector3(Math.max(length, 1e-5), width, height));
  target.setPosition(center);
  return target;
}

function createEntityTemplate(): GpuStreamingEntityTemplateResource {
  const geometry = createToolpathEntityGeometry();
  const material = createToolpathEntityMaterial();
  return { geometry, material, dispose: onceDispose(() => { geometry.dispose(); material.dispose(); }) };
}
const threeResourceFacade: GpuStreamingResourceFacade = { createEntityTemplate };
function isWebGL2Context(context: WebGLRenderingContext): boolean {
  const version = String(context.getParameter?.(context.VERSION) ?? '');
  return /WebGL\s*2/i.test(version)
    || (typeof WebGL2RenderingContext !== 'undefined' && context instanceof WebGL2RenderingContext);
}
function numberParameter(context: WebGLRenderingContext, parameter: number): number | null {
  const value = context.getParameter?.(parameter);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
/** WebGL2 remains the shared app baseline; entity rendering needs no texture fetch. */
export function probeGpuStreamingCapabilities(context: WebGLRenderingContext): GpuStreamingCapabilityProbe {
  const limits = {
    maxTextureSize: numberParameter(context, context.MAX_TEXTURE_SIZE),
    maxTextureImageUnits: numberParameter(context, context.MAX_TEXTURE_IMAGE_UNITS),
    maxVertexTextureImageUnits: numberParameter(context, context.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
    textureUnitsRequired: 0,
  } satisfies GpuStreamingCapabilityLimits;
  if (!isWebGL2Context(context)) return { supported: false, reason: 'webgl2-required', limits };
  return { supported: true, reason: null, limits };
}
interface PageState {
  readonly planPage: GpuStreamingPage;
  readonly mesh?: THREE.InstancedMesh;
  readonly selectedSourceIndices: number[];
  instanceCount: number;
}

export class GpuStreamingRenderer {
  readonly capabilities: GpuStreamingCapabilityProbe;
  readonly template: GpuStreamingEntityTemplateResource;
  readonly pages: readonly PageState[];
  private readonly source: GpuStreamingPagePlan['source'];
  private palette: readonly ToolpathFeature[];
  private dimmingLayer = -1;
  private dimming = 1;
  private readonly contextElement?: GpuStreamingRendererHost;
  private disposed = false;
  private contextLost = false;
  private _entityUploadCount = 0;
  private _entityUploadedBytes = 0;
  constructor(plan: GpuStreamingPagePlan, capabilities: GpuStreamingCapabilityProbe, template: GpuStreamingEntityTemplateResource, pages: readonly PageState[], renderer?: GpuStreamingRendererHost) {
    this.source = plan.source;
    this.palette = plan.source.palette;
    this.capabilities = capabilities;
    this.template = template;
    this.pages = pages;
    this.contextElement = renderer;
    renderer?.domElement?.addEventListener?.('webglcontextlost', this.handleContextLost);
  }
  /** Entity geometry is uploaded once per selection rebuild; camera never touches it. */
  get entityUploadCount(): number { return this._entityUploadCount; }
  get entityUploadedBytes(): number { return this._entityUploadedBytes; }
  // Compatibility diagnostics retained for existing browser reports. They now
  // describe entity instance uploads, never index textures or atlas bytes.
  get staticUploadCount(): number { return 1; }
  get indexUploadCount(): number { return this._entityUploadCount; }
  get staticUploadedBytes(): number {
    const templateBytes = this.template.geometry?.attributes.position?.array.byteLength ?? 0;
    // InstancedMesh allocates one matrix (16 floats) and one RGB color (3
    // floats) per page capacity. These are the resident solid-entity buffers.
    return templateBytes + this.pages.reduce((sum, page) => sum + page.planPage.segmentCount * (16 + 3) * 4, 0);
  }
  get dynamicIndexBytes(): number { return this._entityUploadedBytes; }
  get paletteBytes(): number { return 0; }
  get allocatedBytes(): number | null { return null; }
  get knownResidentBytes(): number { return this.staticUploadedBytes + this._entityUploadedBytes; }
  get unknownFeatureIds(): readonly number[] { return this.collectUnknownFeatures(this.palette); }
  get sceneObjects(): readonly THREE.InstancedMesh[] { return this.pages.flatMap((page) => page.mesh ? [page.mesh] : []); }
  get status(): 'ready' | 'context-lost' | 'disposed' { return this.disposed ? 'disposed' : this.contextLost ? 'context-lost' : 'ready'; }
  get drawInstanceCounts(): readonly number[] { return this.pages.map((page) => page.instanceCount); }
  attachToScene(scene: THREE.Object3D): void { for (const mesh of this.sceneObjects) if (mesh.parent !== scene) scene.add(mesh); }
  detachFromScene(scene: THREE.Object3D): void { for (const mesh of this.sceneObjects) if (mesh.parent === scene) scene.remove(mesh); }
  notifyPageRendered(_pageIndex: number): void { /* retained as a draw-boundary seam */ }
  commitDrawBoundary(): void { /* no retired texture/index resources exist */ }
  private readonly handleContextLost = (event?: Event) => {
    event?.preventDefault?.();
    if (this.disposed || this.contextLost) return;
    this.contextLost = true;
    this.disposeGpuResources();
  };
  private collectUnknownFeatures(palette: readonly ToolpathFeature[]): readonly number[] {
    const known = new Set(palette.map((entry) => entry.id));
    return Object.freeze([...new Set(Array.from(this.source.features).filter((id) => !known.has(id)))].sort((a, b) => a - b));
  }
  private writeInstance(page: PageState, slot: number, sourceIndex: number): void {
    const mesh = page.mesh;
    if (!mesh) return;
    mesh.setMatrixAt(slot, buildGpuStreamingInstanceMatrix(this.source, sourceIndex));
    const color = paletteColor(this.palette, this.source.features[sourceIndex] ?? 0);
    if (this.dimmingLayer >= 0 && (this.source.layerIds[sourceIndex] ?? 0) < this.dimmingLayer) color.multiplyScalar(this.dimming);
    mesh.setColorAt(slot, color);
  }
  /** Rebuild only selected page instances; source parsing and page planning stay untouched. */
  updateSelection(selection: GpuStreamingSelection): GpuStreamingSelectionUpdate {
    if (this.disposed || this.contextLost) throw new Error('GPU entity renderer is unavailable');
    if (selection.pages.length !== this.pages.length) throw new RangeError('selection page count does not match page plan');
    let uploadedBytes = 0;
    for (let pageIndex = 0; pageIndex < this.pages.length; pageIndex++) {
      const page = this.pages[pageIndex]!;
      const selected = selection.pages[pageIndex]!;
      if (selected.firstSegment !== page.planPage.firstSegment || selected.indices.length !== selected.emittedCount) throw new RangeError(`selection page ${pageIndex} does not match page plan`);
      if (selected.emittedCount > page.planPage.segmentCount) throw new RangeError(`selection page ${pageIndex} exceeds instance capacity`);
      page.selectedSourceIndices.length = 0;
      selected.indices.forEach((local, slot) => {
        if (local >= page.planPage.segmentCount) throw new RangeError(`selection page ${pageIndex} contains an out-of-range local index`);
        const sourceIndex = page.planPage.firstSegment + local;
        page.selectedSourceIndices.push(sourceIndex);
        this.writeInstance(page, slot, sourceIndex);
      });
      page.instanceCount = selected.emittedCount;
      if (page.mesh) {
        page.mesh.count = page.instanceCount;
        page.mesh.instanceMatrix.needsUpdate = true;
        if (page.mesh.instanceColor) page.mesh.instanceColor.needsUpdate = true;
      }
      uploadedBytes += selected.emittedCount * (16 * 4 + 3 * 4);
    }
    this._entityUploadCount += this.pages.length;
    this._entityUploadedBytes = uploadedBytes;
    return { uploadedPageCount: this.pages.length, drawInstanceCounts: this.drawInstanceCounts };
  }
  updateCamera(_camera: { readonly position?: THREE.Vector3; readonly viewProjection?: THREE.Matrix4 }): void { /* matrices are camera-independent */ }
  updateDimming(activeLayer: number, earlierLayerDim = 0.25): void {
    if (this.disposed || this.contextLost) return;
    this.dimmingLayer = activeLayer;
    this.dimming = earlierLayerDim;
    for (const page of this.pages) {
      page.selectedSourceIndices.forEach((sourceIndex, slot) => this.writeInstance(page, slot, sourceIndex));
      if (page.mesh?.instanceColor) page.mesh.instanceColor.needsUpdate = true;
    }
  }
  updatePalette(palette: readonly ToolpathFeature[]): GpuStreamingPaletteUpdate {
    if (this.disposed || this.contextLost) throw new Error('GPU entity renderer is unavailable');
    this.palette = palette;
    for (const page of this.pages) {
      page.selectedSourceIndices.forEach((sourceIndex, slot) => this.writeInstance(page, slot, sourceIndex));
      if (page.mesh?.instanceColor) page.mesh.instanceColor.needsUpdate = true;
    }
    return { uploaded: true, unknownFeatureIds: this.collectUnknownFeatures(palette) };
  }
  private disposeGpuResources(): void {
    for (const page of this.pages) {
      page.instanceCount = 0;
      page.selectedSourceIndices.length = 0;
      if (page.mesh) page.mesh.count = 0;
    }
    this.template.dispose();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.contextElement?.domElement?.removeEventListener?.('webglcontextlost', this.handleContextLost);
    this.disposeGpuResources();
  }
}

export function createGpuStreamingRenderer(plan: GpuStreamingPagePlan, options: GpuStreamingRendererOptions = {}): GpuStreamingBuildResult {
  if (!plan || !plan.diagnostics || !Array.isArray(plan.pages)) return { ok: false, diagnostics: { reason: 'invalid-page-plan', message: 'A valid GpuStreamingPagePlan is required', capabilities: null } };
  if (plan.diagnostics.budgetExceeded) return { ok: false, diagnostics: { reason: 'gpu-budget-exceeded', message: `GPU entity plan exceeds the configured budget of ${plan.diagnostics.budgetBytes} bytes`, capabilities: null } };
  let context: WebGLRenderingContext | undefined;
  try { context = options.context ?? options.renderer?.getContext(); } catch (error) {
    return { ok: false, diagnostics: { reason: 'context-query-failed', message: error instanceof Error ? error.message : String(error), capabilities: null } };
  }
  if (!context) return { ok: false, diagnostics: { reason: 'no-context', message: 'A WebGL2 context is required', capabilities: null } };
  let capabilities: GpuStreamingCapabilityProbe;
  try { capabilities = probeGpuStreamingCapabilities(context); } catch (error) {
    return { ok: false, diagnostics: { reason: 'capability-query-failed', message: error instanceof Error ? error.message : String(error), capabilities: null } };
  }
  if (!capabilities.supported) return { ok: false, diagnostics: { reason: capabilities.reason ?? 'unsupported', message: 'GPU entity rendering requires WebGL2', capabilities } };
  const factory = options.resourceFacade ?? threeResourceFacade;
  let template: GpuStreamingEntityTemplateResource | undefined;
  const pages: PageState[] = [];
  try {
    const created = factory.createEntityTemplate();
    template = { ...created, dispose: onceDispose(created.dispose) };
    if (!template.geometry || !template.material) throw new Error('entity template did not provide geometry and material');
    for (const page of plan.pages) {
      const mesh = new THREE.InstancedMesh(template.geometry, template.material, page.segmentCount);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.renderOrder = 1000;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      pages.push({ planPage: page, mesh, selectedSourceIndices: [], instanceCount: 0 });
    }
    const backend = new GpuStreamingRenderer(plan, capabilities, template, pages, options.renderer);
    if (options.compile !== false && options.renderer?.compile) {
      const scene = new THREE.Scene();
      pages.forEach((page) => { if (page.mesh) scene.add(page.mesh); });
      options.renderer.compile(scene, new THREE.Camera());
    }
    return { ok: true, backend };
  } catch (error) {
    template?.dispose();
    return { ok: false, diagnostics: { reason: 'construction-failed', message: error instanceof Error ? error.message : String(error), capabilities } };
  }
}
