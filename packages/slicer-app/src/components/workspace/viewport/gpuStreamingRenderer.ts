import * as THREE from 'three';
import type {
  GpuStreamingPage,
  GpuStreamingPagePlan,
  GpuStreamingPageSelection,
  GpuStreamingSelection,
} from './gpuStreamingPlanner';

/** GLSL ES 3.00 vertex shader for the indexed, camera-facing segment band. */
export const GPU_STREAMING_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

in vec3 position;
uniform sampler2D uStaticAtlas;
uniform usampler2D uStaticIdentity;
uniform usampler2D uEnabledIndices;
uniform int uAtlasWidth;
uniform int uIndexTextureWidth;
uniform vec3 uCameraPosition;
uniform int uActiveLayer;
uniform mat4 uViewProjection;
flat out uint vLayer;
flat out uint vFeature;

ivec2 atlasCoord(int index, int width) {
  return ivec2(index - (index / width) * width, index / width);
}

void main() {
  int enabledIndex = int(texelFetch(
    uEnabledIndices, atlasCoord(gl_InstanceID, uIndexTextureWidth), 0).r);
  int base = enabledIndex * 4;
  vec3 start = texelFetch(uStaticAtlas, atlasCoord(base, uAtlasWidth), 0).xyz;
  vec3 end = texelFetch(uStaticAtlas, atlasCoord(base + 1, uAtlasWidth), 0).xyz;
  vec4 shape = texelFetch(uStaticAtlas, atlasCoord(base + 2, uAtlasWidth), 0);
  uvec4 ids = texelFetch(uStaticIdentity, atlasCoord(base + 3, uAtlasWidth), 0);
  vLayer = ids.r;
  vFeature = ids.b;

  vec3 direction = end - start;
  float lengthDirection = length(direction);
  vec3 axis = lengthDirection > 1e-6 ? direction / lengthDirection : vec3(1.0, 0.0, 0.0);
  vec3 toCamera = uCameraPosition - mix(start, end, 0.5);
  vec3 side = cross(axis, toCamera);
  if (length(side) < 1e-6) side = cross(axis, vec3(0.0, 0.0, 1.0));
  if (length(side) < 1e-6) side = cross(axis, vec3(0.0, 1.0, 0.0));
  side = normalize(side);
  vec3 up = normalize(cross(side, axis));

  // Shape is width, height, cap angle and z-fighting bias.  The cap shift is
  // deliberately bounded so pathological source angles remain stable.
  float capShift = tan(clamp(shape.z, -1.4, 1.4)) * max(shape.y, 0.0) * 0.5;
  float along = position.x * lengthDirection + (position.x * 2.0 - 1.0) * capShift;
  vec3 world = start + axis * along
    + side * position.y * max(shape.x, 0.0) * 0.5
    + up * position.z * max(shape.y, 0.0) * 0.5;
  world += vec3(0.0, 0.0, shape.w);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}`;

/** GLSL ES 3.00 fragment shader. Dimming is uniform-only and filter-safe. */
export const GPU_STREAMING_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform vec3 uColor;
uniform float uEarlierLayerDim;
uniform int uActiveLayer;
flat in uint vLayer;
flat in uint vFeature;
out vec4 outColor;
void main() {
  float dim = (uActiveLayer >= 0 && int(vLayer) < uActiveLayer)
    ? uEarlierLayerDim : 1.0;
  outColor = vec4(uColor * dim, 1.0);
}`;

const STATIC_SCHEMA_TEXELS = 4;
const REQUIRED_TEXTURE_UNITS = 3;

/** Six quad faces, represented by the 24 byte-sized corner indices. */
export const GPU_STREAMING_TEMPLATE_FACE_INDICES = new Uint8Array([
  0, 1, 2, 3, 4, 6, 5, 7, 0, 4, 5, 1,
  1, 5, 6, 2, 2, 6, 7, 3, 4, 0, 3, 7,
]);

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

/** The smallest host surface needed by this module; it is easy to mock. */
export interface GpuStreamingRendererHost {
  getContext(): WebGLRenderingContext;
  readonly domElement?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  compile?: (scene: THREE.Scene, camera: THREE.Camera) => void;
}

export interface GpuStreamingStaticAtlasUpload {
  readonly width: number;
  readonly height: number;
  readonly texelCount: number;
  /** RGBA32F data; unused padding texels are zero. */
  readonly geometry: Float32Array;
  /** RGBA32UI data; one integer texel (four lossless channels) per atlas texel. */
  readonly identity: Uint32Array;
}

export interface GpuStreamingIndexStreamUpload {
  readonly width: number;
  readonly height: number;
  readonly indices: Uint32Array;
}

export interface GpuStreamingResource {
  readonly dispose: () => void;
}

export interface GpuStreamingStaticAtlasResource extends GpuStreamingResource {
  readonly geometryTexture?: THREE.Texture;
  readonly identityTexture?: THREE.Texture;
}

export interface GpuStreamingIndexStreamResource extends GpuStreamingResource {
  readonly texture?: THREE.Texture;
  readonly width?: number;
  readonly height?: number;
}

export interface GpuStreamingTemplateResource extends GpuStreamingResource {
  readonly geometry?: THREE.BufferGeometry;
  readonly material?: THREE.ShaderMaterial;
}

/**
 * Resource seam used by tests and by future host-specific allocation policy.
 * Implementations receive typed bulk uploads, never per-segment objects.
 */
export interface GpuStreamingResourceFacade {
  createStaticAtlas(upload: GpuStreamingStaticAtlasUpload): GpuStreamingStaticAtlasResource;
  createIndexStream(upload: GpuStreamingIndexStreamUpload): GpuStreamingIndexStreamResource;
  createSharedTemplate(): GpuStreamingTemplateResource;
}

export interface GpuStreamingRendererOptions {
  readonly renderer?: GpuStreamingRendererHost;
  /** A test context can be supplied when no Three renderer exists. */
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

function onceDispose(dispose: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    dispose();
  };
}

function safeDispose(resource: GpuStreamingResource | undefined | null): void {
  try { resource?.dispose(); } catch { /* continue releasing sibling GPU handles */ }
}

function textureDefaults(texture: THREE.DataTexture, integer: boolean): THREE.DataTexture {
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.colorSpace = THREE.NoColorSpace;
  if (integer) texture.internalFormat = 'R32UI';
  texture.needsUpdate = true;
  return texture;
}

function createThreeTexture(data: Float32Array | Uint32Array, width: number, height: number, integer: boolean, rgbaInteger = false): THREE.DataTexture {
  return textureDefaults(new THREE.DataTexture(
    data,
    width,
    height,
    integer ? (rgbaInteger ? THREE.RGBAIntegerFormat : THREE.RedIntegerFormat) : THREE.RGBAFormat,
    integer ? THREE.UnsignedIntType : THREE.FloatType,
  ), integer);
}

// ShaderMaterial asks Three to prepend the GLSL3 version line. Keep the
// exported source self-describing for contract tests, but avoid a duplicate
// #version directive in the actual WebGLProgram.
function threeShaderSource(source: string): string {
  return source.replace(/^#version 300 es\s*/, '');
}

const threeResourceFacade: GpuStreamingResourceFacade = {
  createStaticAtlas(upload) {
    const geometry = createThreeTexture(upload.geometry, upload.width, upload.height, false);
    const identity = createThreeTexture(upload.identity, upload.width, upload.height, true, true);
    identity.internalFormat = 'RGBA32UI';
    let disposed = false;
    return {
      geometryTexture: geometry,
      identityTexture: identity,
      dispose: onceDispose(() => {
        if (disposed) return;
        disposed = true;
        geometry.dispose();
        identity.dispose();
      }),
    };
  },
  createIndexStream(upload) {
    const texture = createThreeTexture(upload.indices, upload.width, upload.height, true);
    return { texture, width: upload.width, height: upload.height, dispose: onceDispose(() => texture.dispose()) };
  },
  createSharedTemplate() {
    // Eight corners and the six quad faces are the shared libvgcode-equivalent
    // template. No instance matrix or segment-shaped geometry is allocated.
    const corners = new Float32Array([
      0, -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1,
      1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1,
    ]);
    // WebGL2 has no GL_QUADS, so the six-face/24-byte index topology is
    // triangulated once in the shared template (still no per-segment data).
    const indices = new Uint8Array(36);
    for (let face = 0; face < 6; face++) {
      const source = face * 4;
      const target = face * 6;
      indices[target] = GPU_STREAMING_TEMPLATE_FACE_INDICES[source]!;
      indices[target + 1] = GPU_STREAMING_TEMPLATE_FACE_INDICES[source + 1]!;
      indices[target + 2] = GPU_STREAMING_TEMPLATE_FACE_INDICES[source + 2]!;
      indices[target + 3] = GPU_STREAMING_TEMPLATE_FACE_INDICES[source]!;
      indices[target + 4] = GPU_STREAMING_TEMPLATE_FACE_INDICES[source + 2]!;
      indices[target + 5] = GPU_STREAMING_TEMPLATE_FACE_INDICES[source + 3]!;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners, 3));
    geometry.setIndex(new THREE.Uint8BufferAttribute(indices, 1));
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: threeShaderSource(GPU_STREAMING_VERTEX_SHADER),
      fragmentShader: threeShaderSource(GPU_STREAMING_FRAGMENT_SHADER),
      uniforms: {
        uStaticAtlas: { value: null },
        uStaticIdentity: { value: null },
        uEnabledIndices: { value: null },
        uAtlasWidth: { value: 1 },
        uIndexTextureWidth: { value: 1 },
        uCameraPosition: { value: new THREE.Vector3(0, 0, 1) },
        uActiveLayer: { value: -1 },
        uEarlierLayerDim: { value: 0.25 },
        uColor: { value: new THREE.Color(0.9, 0.9, 0.9) },
        uViewProjection: { value: new THREE.Matrix4() },
      },
      side: THREE.DoubleSide,
    });
    return { geometry, material, dispose: onceDispose(() => { geometry.dispose(); material.dispose(); }) };
  },
};

function isWebGL2Context(context: WebGLRenderingContext): boolean {
  const version = String(context.getParameter?.(context.VERSION) ?? '');
  return /WebGL\s*2/i.test(version)
    || (typeof WebGL2RenderingContext !== 'undefined' && context instanceof WebGL2RenderingContext);
}

function numberParameter(context: WebGLRenderingContext, parameter: number): number | null {
  const value = context.getParameter?.(parameter);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Probe all limits needed by the three-texture vertex shader. */
export function probeGpuStreamingCapabilities(context: WebGLRenderingContext): GpuStreamingCapabilityProbe {
  const gl = context as WebGL2RenderingContext;
  const limits: GpuStreamingCapabilityLimits = {
    maxTextureSize: numberParameter(context, context.MAX_TEXTURE_SIZE),
    maxTextureImageUnits: numberParameter(context, context.MAX_TEXTURE_IMAGE_UNITS),
    maxVertexTextureImageUnits: numberParameter(context, context.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
    textureUnitsRequired: REQUIRED_TEXTURE_UNITS,
  };
  if (!isWebGL2Context(context)) return { supported: false, reason: 'webgl2-required', limits };
  if (!gl.R32UI || !gl.RED_INTEGER) return { supported: false, reason: 'integer-textures-unavailable', limits };
  if ((limits.maxTextureSize ?? 0) < 1) return { supported: false, reason: 'invalid-max-texture-size', limits };
  if ((limits.maxVertexTextureImageUnits ?? 0) < REQUIRED_TEXTURE_UNITS) {
    return { supported: false, reason: 'vertex-texture-fetch-unavailable', limits };
  }
  if ((limits.maxTextureImageUnits ?? 0) < REQUIRED_TEXTURE_UNITS) {
    return { supported: false, reason: 'texture-unit-budget-too-small', limits };
  }
  return { supported: true, reason: null, limits };
}

function atlasUpload(plan: GpuStreamingPagePlan, page: GpuStreamingPage): GpuStreamingStaticAtlasUpload {
  const schema = plan.diagnostics.texelSchema;
  if (schema.endpointTexels !== 2 || schema.shapeTexels !== 1 || schema.identityTexels !== 1
    || schema.paletteTexels !== 0 || schema.metricTexels !== 0 || schema.texelsPerSegment !== STATIC_SCHEMA_TEXELS) {
    throw new Error('unsupported-static-schema: expected the four-texel endpoint/shape/identity layout');
  }
  const { source } = plan;
  const geometry = new Float32Array(page.atlasWidth * page.atlasHeight * 4);
  const identity = new Uint32Array(page.atlasWidth * page.atlasHeight * 4);
  for (let local = 0; local < page.segmentCount; local++) {
    const sourceIndex = page.firstSegment + local;
    const base = local * STATIC_SCHEMA_TEXELS;
    const endpoint0 = base * 4;
    const endpoint1 = (base + 1) * 4;
    const shape = (base + 2) * 4;
    const start = sourceIndex * 3;
    geometry[endpoint0] = source.starts[start] ?? 0;
    geometry[endpoint0 + 1] = source.starts[start + 1] ?? 0;
    geometry[endpoint0 + 2] = source.starts[start + 2] ?? 0;
    geometry[endpoint1] = source.ends[start] ?? 0;
    geometry[endpoint1 + 1] = source.ends[start + 1] ?? 0;
    geometry[endpoint1 + 2] = source.ends[start + 2] ?? 0;
    geometry[shape] = source.widths[sourceIndex] ?? 0;
    geometry[shape + 1] = source.heights[sourceIndex] ?? 0;
    geometry[shape + 2] = source.capAngles?.[sourceIndex] ?? source.angles?.[sourceIndex] ?? 0;
    geometry[shape + 3] = source.biases?.[sourceIndex] ?? 0;
    const identityTexel = (base + 3) * 4;
    identity[identityTexel] = source.layerIds[sourceIndex] ?? 0;
    identity[identityTexel + 1] = source.moveOrders[sourceIndex] ?? 0;
    identity[identityTexel + 2] = source.features[sourceIndex] ?? 0;
    identity[identityTexel + 3] = source.moveTypes[sourceIndex] ?? 0;
  }
  return { width: page.atlasWidth, height: page.atlasHeight, texelCount: page.atlasTexelCount, geometry, identity };
}

function indexUpload(selection: GpuStreamingPageSelection, maxTextureSize: number): GpuStreamingIndexStreamUpload {
  const count = selection.indices.length;
  const width = Math.max(1, Math.min(maxTextureSize, Math.max(1, count)));
  const height = Math.max(1, Math.ceil(Math.max(1, count) / width));
  const indices = new Uint32Array(width * height);
  indices.set(selection.indices);
  return { width, height, indices };
}

interface PageState {
  readonly planPage: GpuStreamingPage;
  readonly staticAtlas: GpuStreamingStaticAtlasResource;
  indexStream: GpuStreamingIndexStreamResource | null;
  instanceCount: number;
  geometry?: THREE.InstancedBufferGeometry;
  mesh?: THREE.Mesh;
}

/**
 * A ready static-atlas renderer. It is deliberately not imported by
 * ToolpathLines yet: the next integration step owns feature-gating and B2
 * fallback selection.
 */
export class GpuStreamingRenderer {
  readonly capabilities: GpuStreamingCapabilityProbe;
  readonly template: GpuStreamingTemplateResource;
  readonly pages: readonly PageState[];
  private readonly retiredIndexStreams: GpuStreamingIndexStreamResource[] = [];
  private readonly contextElement?: GpuStreamingRendererOptions['renderer'];
  private disposed = false;
  private contextLost = false;
  private _staticUploadCount: number;
  private _indexUploadCount = 0;

  constructor(
    plan: GpuStreamingPagePlan,
    capabilities: GpuStreamingCapabilityProbe,
    template: GpuStreamingTemplateResource,
    pages: readonly PageState[],
    renderer?: GpuStreamingRendererHost,
    private readonly resourceFacade?: GpuStreamingResourceFacade,
    staticUploadCount = pages.length,
  ) {
    this.capabilities = capabilities;
    this.template = template;
    this.pages = pages;
    this.contextElement = renderer;
    this._staticUploadCount = staticUploadCount;
    const element = renderer?.domElement;
    element?.addEventListener?.('webglcontextlost', this.handleContextLost);
    void plan;
  }

  get staticUploadCount(): number { return this._staticUploadCount; }
  get indexUploadCount(): number { return this._indexUploadCount; }
  /** Driver-reported allocation is intentionally unavailable until a real GL query is wired. */
  get allocatedBytes(): number | null { return null; }
  get status(): 'ready' | 'context-lost' | 'disposed' { return this.disposed ? 'disposed' : this.contextLost ? 'context-lost' : 'ready'; }
  get drawInstanceCounts(): readonly number[] { return this.pages.map((page) => page.instanceCount); }

  private readonly handleContextLost = (event?: Event) => {
    event?.preventDefault?.();
    if (this.disposed || this.contextLost) return;
    this.contextLost = true;
    this.disposeGpuResources();
  };

  /** Upload only page-local R32UI streams; static atlas textures are untouched. */
  updateSelection(selection: GpuStreamingSelection): GpuStreamingSelectionUpdate {
    if (this.disposed || this.contextLost) throw new Error('GPU streaming renderer is unavailable');
    if (selection.pages.length !== this.pages.length) throw new RangeError('selection page count does not match page plan');
    const created: GpuStreamingIndexStreamResource[] = [];
    try {
      for (let i = 0; i < this.pages.length; i++) {
        const pageSelection = selection.pages[i]!;
        const page = this.pages[i]!;
        if (pageSelection.firstSegment !== page.planPage.firstSegment || pageSelection.indices.length !== pageSelection.emittedCount) {
          throw new RangeError(`selection page ${i} does not match page plan`);
        }
        for (const index of pageSelection.indices) {
          if (index >= page.planPage.segmentCount) throw new RangeError(`selection page ${i} contains an out-of-range local index`);
        }
        const createdStream = (this.resourceFacade ?? threeResourceFacade).createIndexStream(
          indexUpload(pageSelection, this.capabilities.limits.maxTextureSize!),
        );
        const stream: GpuStreamingIndexStreamResource = {
          ...createdStream,
          dispose: onceDispose(createdStream.dispose),
        };
        created.push(stream);
      }
      // Publish all replacement streams together. Until this point an
      // allocation failure leaves the previous draw state intact.
      for (let i = 0; i < this.pages.length; i++) {
        const page = this.pages[i]!;
        if (page.indexStream) this.retiredIndexStreams.push(page.indexStream);
        page.indexStream = created[i]!;
        page.instanceCount = selection.pages[i]!.emittedCount;
        if (page.geometry) page.geometry.instanceCount = page.instanceCount;
      }
      this._indexUploadCount += this.pages.length;
      return { uploadedPageCount: this.pages.length, drawInstanceCounts: this.drawInstanceCounts };
    } catch (error) {
      created.forEach((stream) => safeDispose(stream));
      throw error;
    }
  }

  /** Set camera uniforms only; this cannot rebuild plans, indices, or textures. */
  updateCamera(camera: { readonly position?: THREE.Vector3; readonly viewProjection?: THREE.Matrix4 }): void {
    if (this.disposed || this.contextLost) return;
    const uniforms = this.template.material?.uniforms;
    if (!uniforms) return;
    if (camera.position && uniforms.uCameraPosition) (uniforms.uCameraPosition.value as THREE.Vector3).copy(camera.position);
    if (camera.viewProjection && uniforms.uViewProjection) (uniforms.uViewProjection.value as THREE.Matrix4).copy(camera.viewProjection);
  }

  /** Update dimming uniforms without touching static or enabled-index data. */
  updateDimming(activeLayer: number, earlierLayerDim = 0.25): void {
    const uniforms = this.template.material?.uniforms;
    if (uniforms?.uActiveLayer) uniforms.uActiveLayer.value = activeLayer;
    if (uniforms?.uEarlierLayerDim) uniforms.uEarlierLayerDim.value = earlierLayerDim;
  }

  /** Release streams retired after a completed draw boundary. */
  commitDrawBoundary(): void {
    while (this.retiredIndexStreams.length > 0) safeDispose(this.retiredIndexStreams.pop());
  }

  private disposeGpuResources(): void {
    for (const page of this.pages) {
      safeDispose(page.indexStream);
      page.indexStream = null;
      safeDispose(page.staticAtlas);
      try { page.geometry?.dispose(); } catch { /* continue releasing sibling GPU handles */ }
      page.instanceCount = 0;
    }
    this.commitDrawBoundary();
    safeDispose(this.template);
  }

  /** Idempotent; caller-owned scenes, cameras, and renderers are untouched. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.contextElement?.domElement?.removeEventListener?.('webglcontextlost', this.handleContextLost);
    this.disposeGpuResources();
  }
}

/** Build static atlases and shared template, returning diagnostics on failure. */
export function createGpuStreamingRenderer(
  plan: GpuStreamingPagePlan,
  options: GpuStreamingRendererOptions = {},
): GpuStreamingBuildResult {
  if (!plan || !plan.diagnostics || !Array.isArray(plan.pages)) {
    return { ok: false, diagnostics: { reason: 'invalid-page-plan', message: 'A valid GpuStreamingPagePlan is required', capabilities: null } };
  }
  let context: WebGLRenderingContext | undefined;
  try { context = options.context ?? options.renderer?.getContext(); } catch (error) {
    return { ok: false, diagnostics: { reason: 'context-query-failed', message: error instanceof Error ? error.message : String(error), capabilities: null } };
  }
  if (!context) return { ok: false, diagnostics: { reason: 'no-context', message: 'A WebGL2 context is required', capabilities: null } };
  let capabilities: GpuStreamingCapabilityProbe;
  try { capabilities = probeGpuStreamingCapabilities(context); } catch (error) {
    return { ok: false, diagnostics: { reason: 'capability-query-failed', message: error instanceof Error ? error.message : String(error), capabilities: null } };
  }
  if (!capabilities.supported) {
    return { ok: false, diagnostics: { reason: capabilities.reason ?? 'unsupported', message: 'GPU streaming requires WebGL2 integer vertex texture fetch', capabilities } };
  }
  const schema = plan.diagnostics.texelSchema;
  if (schema.bytesPerTexel !== 16 || schema.bytesPerStaticSegment !== 64) {
    return { ok: false, diagnostics: { reason: 'unsupported-static-schema', message: 'The runtime backend supports the planner 64-byte schema only', capabilities } };
  }
  const factory = options.resourceFacade ?? threeResourceFacade;
  let template: GpuStreamingTemplateResource | null = null;
  const pages: PageState[] = [];
  try {
    const createdTemplate = factory.createSharedTemplate();
    template = { ...createdTemplate, dispose: onceDispose(createdTemplate.dispose) };
    for (let i = 0; i < plan.pages.length; i++) {
      const page = plan.pages[i]!;
      if (page.atlasWidth > capabilities.limits.maxTextureSize! || page.atlasHeight > capabilities.limits.maxTextureSize!) {
        throw new Error(`page ${i} atlas dimensions exceed MAX_TEXTURE_SIZE`);
      }
      const upload = atlasUpload(plan, page);
      const createdStaticAtlas = factory.createStaticAtlas(upload);
      const staticAtlas: GpuStreamingStaticAtlasResource = {
        ...createdStaticAtlas,
        dispose: onceDispose(createdStaticAtlas.dispose),
      };
      const state: PageState = { planPage: page, staticAtlas, indexStream: null, instanceCount: 0 };
      // Register immediately so any later template/mesh setup failure also
      // releases the atlas just allocated for this page.
      pages.push(state);
      if (template.geometry && template.material) {
        const pageGeometry = new THREE.InstancedBufferGeometry();
        pageGeometry.index = template.geometry.index;
        const position = template.geometry.getAttribute('position');
        if (!position) throw new Error('shared template has no position attribute');
        pageGeometry.setAttribute('position', position);
        pageGeometry.instanceCount = 0;
        state.geometry = pageGeometry;
        state.mesh = new THREE.Mesh(pageGeometry, template.material);
        state.mesh.frustumCulled = false;
        state.mesh.renderOrder = 1000;
        state.mesh.onBeforeRender = () => {
          const uniforms = template!.material?.uniforms;
          if (!uniforms) return;
          uniforms.uStaticAtlas.value = state.staticAtlas.geometryTexture ?? null;
          uniforms.uStaticIdentity.value = state.staticAtlas.identityTexture ?? null;
          uniforms.uEnabledIndices.value = state.indexStream?.texture ?? null;
          uniforms.uAtlasWidth.value = page.atlasWidth;
          uniforms.uIndexTextureWidth.value = state.indexStream?.width ?? 1;
          pageGeometry.instanceCount = state.instanceCount;
        };
      }
    }
    const backend = new GpuStreamingRenderer(plan, capabilities, template, pages, options.renderer, factory, pages.length);
    if (options.compile !== false && options.renderer?.compile) {
      const scene = new THREE.Scene();
      for (const page of pages) if (page.mesh) scene.add(page.mesh);
      options.renderer.compile(scene, new THREE.Camera());
    }
    return { ok: true, backend };
  } catch (error) {
    for (const page of pages) {
      safeDispose(page.indexStream);
      safeDispose(page.staticAtlas);
      try { page.geometry?.dispose(); } catch { /* continue releasing sibling GPU handles */ }
    }
    safeDispose(template);
    return {
      ok: false,
      diagnostics: {
        reason: 'construction-failed',
        message: error instanceof Error ? error.message : String(error),
        capabilities,
      },
    };
  }
}

/** Exported for contract tests and for a future worker-side atlas packer. */
export function packGpuStreamingStaticAtlas(plan: GpuStreamingPagePlan, page: GpuStreamingPage): GpuStreamingStaticAtlasUpload {
  return atlasUpload(plan, page);
}
