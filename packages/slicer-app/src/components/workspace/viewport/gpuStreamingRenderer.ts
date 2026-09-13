import * as THREE from 'three';
import type { PreviewColorScheme } from '../../../stores/useSlicerStore';
import type {
  GpuStreamingPage,
  GpuStreamingPagePlan,
  GpuStreamingSelection,
} from './gpuStreamingPlanner';
import { resolvePreviewColor, TRAVEL_MOVE_TYPE } from './toolpathColors';

/** WebGL2 adapter for Orca/libvgcode's native SegmentTemplate renderer. */
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
  readonly domElement?: Pick<
    EventTarget,
    'addEventListener' | 'removeEventListener'
  >;
  compile?: (scene: THREE.Scene, camera: THREE.Camera) => void;
}
export interface GpuStreamingSegmentTemplateResource {
  readonly geometry: THREE.BufferGeometry;
  readonly dispose: () => void;
}
export interface GpuStreamingResourceFacade {
  createSegmentTemplate?: () => GpuStreamingSegmentTemplateResource;
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
  | {
      readonly ok: false;
      readonly diagnostics: GpuStreamingUnavailableDiagnostics;
    };
const REQUIRED_TEXTURE_UNITS = 4;
/**
 * libvgcode's default travels radius (ViewerImpl::m_travels_radius).
 * Travel moves use this thin preview width instead of the physical extrusion
 * width supplied by the slicer. The native shader receives the radius as both
 * height and width, so the rendered band is 0.1 mm across.
 */
export const LIBVGCODE_DEFAULT_TRAVEL_RADIUS_MM = 0.1;
const SEGMENT_TEMPLATE_VERTEX_IDS = Object.freeze([
  0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 6, 0, 6, 1, 5, 4, 7, 5, 7, 6,
]);
export const SEGMENT_TEMPLATE_LOGICAL_VERTEX_COUNT = 8;
export const SEGMENT_TEMPLATE_INVOCATION_COUNT =
  SEGMENT_TEMPLATE_VERTEX_IDS.length;

function onceDispose(dispose: () => void): () => void {
  let done = false;
  return () => {
    if (!done) {
      done = true;
      dispose();
    }
  };
}
function createSegmentTemplateGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'vertex_id',
    new THREE.Uint8BufferAttribute(SEGMENT_TEMPLATE_VERTEX_IDS, 1),
  );
  geometry.setDrawRange(0, SEGMENT_TEMPLATE_INVOCATION_COUNT);
  return geometry;
}

// This is the GLSL ES 3.00 equivalent of libvgcode/Shaders.hpp. POINTY_CAPS
// and FIX_TWISTING are intentionally visible as defines for native parity.
const SEGMENTS_VERTEX_SHADER = `precision highp float; precision highp int; precision highp usampler2D;
#define POINTY_CAPS
#define FIX_TWISTING
const vec3 UP=vec3(0.,0.,1.);
uniform sampler2D position_tex; uniform sampler2D height_width_angle_tex;
uniform sampler2D color_tex; uniform usampler2D segment_index_tex;
uniform ivec2 position_tex_size; uniform ivec2 shape_tex_size;
uniform ivec2 color_tex_size; uniform ivec2 segment_index_tex_size;
uniform int segment_base;
uniform float active_layer; uniform float earlier_layer_dim;
in float vertex_id; out vec3 v_color;
ivec2 coord(ivec2 s,int id){return ivec2(id%s.x,id/s.x);}
vec4 positionAt(int id){return texelFetch(position_tex,coord(position_tex_size,id),0);}
vec4 shapeAt(int id){return texelFetch(height_width_angle_tex,coord(shape_tex_size,id),0);}
vec4 colorAt(int id){return texelFetch(color_tex,coord(color_tex_size,id),0);}
uint selected(){return texelFetch(segment_index_tex,coord(segment_index_tex_size,gl_InstanceID),0).r;}
float light(vec3 p,vec3 n){const vec3 t=vec3(-.4574957,.4574957,.7624929);const vec3 f=vec3(.6985074,.1397015,.6985074);return .2+.6*.8*max(dot(n,t),0.)+.6*.2*max(dot(n,f),0.)+.6*.125*pow(max(dot(-normalize(p),reflect(-t,n)),0.),20.)+.15;}
void main(){
 int a=(int(selected())+segment_base)*2; int b=a+1; vec3 pa=positionAt(a).xyz; vec3 pb=positionAt(b).xyz; vec3 line=pb-pa; float len=length(line); vec3 dir=len<1e-4?vec3(1.,0.,0.):line/len;
 vec3 right=abs(dot(dir,UP))>.9?normalize(cross(vec3(1.,0.,0.),dir)):normalize(cross(dir,UP)); vec3 up=normalize(cross(right,dir));
 const vec2 signs[16]=vec2[](vec2(1,0),vec2(0,1),vec2(0,0),vec2(0,-1),vec2(0,-1),vec2(1,0),vec2(0,1),vec2(0,0),vec2(0,1),vec2(-1,0),vec2(0,0),vec2(1,0),vec2(1,0),vec2(0,1),vec2(-1,0),vec2(0,0));
 int id=int(vertex_id<4.?a:b); vec3 endpoint=vertex_id<4.?pa:pb; vec4 hwa=shapeAt(id);
 int closeId=dot(cameraPosition-pa,cameraPosition-pa)<dot(cameraPosition-pb,cameraPosition-pb)?a:b; vec3 closePos=closeId==a?pa:pb; vec3 view=normalize(closePos-cameraPosition); vec3 closeHwa=shapeAt(closeId).xyz; vec3 diagonal=normalize(closeHwa.x*up+closeHwa.y*right);
 bool vertical=abs(dot(view,up))/max(abs(dot(diagonal,up)),1e-6)>abs(dot(view,right))/max(abs(dot(diagonal,right)),1e-6); vec2 signPair=signs[int(vertex_id)+8*int(vertical)];
 float hh=.5*hwa.x; float hw=.5*hwa.y; vec3 horizontal=hw*right; vec3 verticalDir=hh*up; vec3 pos=endpoint+signPair.x*sign(dot(-view,right))*horizontal+signPair.y*sign(dot(-view,up))*verticalDir;
 if(int(vertex_id)==2||int(vertex_id)==7){float ds=int(vertex_id)==2?-1.:1.; if(hwa.z==0.)pos+=ds*dir*hw; else {pos+=ds*dir*hw*sin(abs(hwa.z)*.5);pos+=sign(hwa.z)*horizontal*cos(abs(hwa.z)*.5);}}
 vec3 eye=(modelViewMatrix*vec4(pos,1.)).xyz; eye.z+=hwa.w; vec3 normal=(modelViewMatrix*vec4(normalize(pos-endpoint),0.)).xyz; vec4 base=colorAt(id); float dim=base.a<active_layer?earlier_layer_dim:1.; v_color=base.rgb*dim*light(eye,normal); gl_Position=projectionMatrix*vec4(eye,1.);
}`;
const SEGMENTS_FRAGMENT_SHADER = `precision highp float; in vec3 v_color; out vec4 fragment_color; void main(){fragment_color=vec4(v_color,1.);}`;

interface StaticTextures {
  readonly position: THREE.DataTexture;
  readonly shape: THREE.DataTexture;
  readonly color: THREE.DataTexture;
  readonly positionSize: readonly [number, number];
  readonly shapeSize: readonly [number, number];
  readonly colorSize: readonly [number, number];
  readonly dispose: () => void;
}
interface PageState {
  readonly planPage: GpuStreamingPage;
  readonly mesh: THREE.InstancedMesh;
  readonly indexData: Uint32Array;
  readonly indexTexture: THREE.DataTexture;
}
function dimensions(count: number, max: number): [number, number] {
  const width = Math.max(1, Math.min(max, count || 1));
  return [width, Math.max(1, Math.ceil(count / width))];
}
function textureParameters(texture: THREE.Texture): void {
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
}
function floatTexture(
  data: Float32Array,
  count: number,
  max: number,
): { texture: THREE.DataTexture; size: [number, number] } {
  const size = dimensions(count, max);
  const padded = new Float32Array(size[0] * size[1] * 4);
  padded.set(data);
  const texture = new THREE.DataTexture(
    padded,
    size[0],
    size[1],
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  textureParameters(texture);
  texture.needsUpdate = true;
  return { texture, size };
}
function indexTexture(
  data: Uint32Array,
  max: number,
): { texture: THREE.DataTexture; size: [number, number] } {
  const size = dimensions(data.length, max);
  const padded = new Uint32Array(size[0] * size[1]);
  padded.set(data);
  const texture = new THREE.DataTexture(
    padded,
    size[0],
    size[1],
    THREE.RedIntegerFormat,
    THREE.UnsignedIntType,
  );
  texture.internalFormat = 'R32UI';
  textureParameters(texture);
  texture.needsUpdate = true;
  return { texture, size };
}
function buildStaticTextures(
  source: GpuStreamingPagePlan['source'],
  max: number,
  scheme: PreviewColorScheme = 'feature',
): StaticTextures {
  const n = source.segmentCount * 2;
  const positions = new Float32Array(n * 4);
  const shapes = new Float32Array(n * 4);
  const colors = new Float32Array(n * 4);
  for (let i = 0; i < source.segmentCount; i++) {
    for (const [endpoint, xyz] of [
      [i * 2, source.starts],
      [i * 2 + 1, source.ends],
    ] as const) {
      const si = endpoint === i * 2 ? i * 3 : i * 3;
      const o = endpoint * 4;
      positions[o] = xyz[si] ?? 0;
      positions[o + 1] = xyz[si + 1] ?? 0;
      positions[o + 2] = xyz[si + 2] ?? 0;
      const isTravel = source.moveTypes[i] === TRAVEL_MOVE_TYPE;
      shapes[o] = isTravel
        ? LIBVGCODE_DEFAULT_TRAVEL_RADIUS_MM
        : Math.max(0, source.heights[i] ?? 0);
      shapes[o + 1] = isTravel
        ? LIBVGCODE_DEFAULT_TRAVEL_RADIUS_MM
        : Math.max(0, source.widths[i] ?? 0);
      shapes[o + 2] = source.capAngles?.[i] ?? source.angles?.[i] ?? 0;
      shapes[o + 3] = source.biases?.[i] ?? 0;
      const c = resolvePreviewColor(source, i, scheme);
      colors[o] = c[0];
      colors[o + 1] = c[1];
      colors[o + 2] = c[2];
      colors[o + 3] = source.layerIds[i] ?? 0;
    }
  }
  const position = floatTexture(positions, n, max),
    shape = floatTexture(shapes, n, max),
    color = floatTexture(colors, n, max);
  const dispose = onceDispose(() => {
    position.texture.dispose();
    shape.texture.dispose();
    color.texture.dispose();
  });
  return {
    position: position.texture,
    shape: shape.texture,
    color: color.texture,
    positionSize: position.size,
    shapeSize: shape.size,
    colorSize: color.size,
    dispose,
  };
}
function makeMaterial(
  staticTextures: StaticTextures,
  index: THREE.DataTexture,
  size: readonly [number, number],
  segmentBase: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: SEGMENTS_VERTEX_SHADER,
    fragmentShader: SEGMENTS_FRAGMENT_SHADER,
    uniforms: {
      position_tex: { value: staticTextures.position },
      height_width_angle_tex: { value: staticTextures.shape },
      color_tex: { value: staticTextures.color },
      segment_index_tex: { value: index },
      position_tex_size: { value: staticTextures.positionSize },
      shape_tex_size: { value: staticTextures.shapeSize },
      color_tex_size: { value: staticTextures.colorSize },
      segment_index_tex_size: { value: size },
      segment_base: { value: segmentBase },
      active_layer: { value: -1 },
      earlier_layer_dim: { value: 1 },
    },
    transparent: true,
    opacity: 1,
    blending: THREE.NoBlending,
    depthTest: true,
    depthWrite: true,
    // libvgcode disables GL_CULL_FACE for segments. Keep both faces visible;
    // opaque output and depth testing still provide correct occlusion.
    side: THREE.DoubleSide,
  });
}
function isWebGL2Context(context: WebGLRenderingContext): boolean {
  const version = String(context.getParameter?.(context.VERSION) ?? '');
  return (
    /WebGL\s*2/i.test(version) ||
    (typeof WebGL2RenderingContext !== 'undefined' &&
      context instanceof WebGL2RenderingContext)
  );
}
function numberParameter(
  context: WebGLRenderingContext,
  p: number,
): number | null {
  const value = context.getParameter?.(p);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
export function probeGpuStreamingCapabilities(
  context: WebGLRenderingContext,
): GpuStreamingCapabilityProbe {
  const limits = {
    maxTextureSize: numberParameter(context, context.MAX_TEXTURE_SIZE),
    maxTextureImageUnits: numberParameter(
      context,
      context.MAX_TEXTURE_IMAGE_UNITS,
    ),
    maxVertexTextureImageUnits: numberParameter(
      context,
      context.MAX_VERTEX_TEXTURE_IMAGE_UNITS,
    ),
    textureUnitsRequired: REQUIRED_TEXTURE_UNITS,
  };
  if (!isWebGL2Context(context))
    return { supported: false, reason: 'webgl2-required', limits };
  if ((limits.maxTextureSize ?? 0) < 1)
    return { supported: false, reason: 'texture-size-unavailable', limits };
  if ((limits.maxTextureImageUnits ?? 0) < REQUIRED_TEXTURE_UNITS)
    return { supported: false, reason: 'texture-units-insufficient', limits };
  if ((limits.maxVertexTextureImageUnits ?? 0) < 1)
    return {
      supported: false,
      reason: 'vertex-texture-fetch-unavailable',
      limits,
    };
  return { supported: true, reason: null, limits };
}

export class GpuStreamingRenderer {
  readonly capabilities: GpuStreamingCapabilityProbe;
  readonly template: GpuStreamingSegmentTemplateResource;
  readonly pages: readonly PageState[];
  private readonly source: GpuStreamingPagePlan['source'];
  private readonly staticTextures: StaticTextures;
  private readonly contextElement?: GpuStreamingRendererHost;
  private disposed = false;
  private contextLost = false;
  private gpuDisposed = false;
  constructor(
    plan: GpuStreamingPagePlan,
    capabilities: GpuStreamingCapabilityProbe,
    template: GpuStreamingSegmentTemplateResource,
    staticTextures: StaticTextures,
    pages: readonly PageState[],
    renderer?: GpuStreamingRendererHost,
  ) {
    this.source = plan.source;
    this.capabilities = capabilities;
    this.template = template;
    this.staticTextures = staticTextures;
    this.pages = pages;
    this.contextElement = renderer;
    renderer?.domElement?.addEventListener?.(
      'webglcontextlost',
      this.handleContextLost,
    );
  }
  get status() {
    return this.disposed
      ? 'disposed'
      : this.contextLost
        ? 'context-lost'
        : 'ready';
  }
  attachToScene(scene: THREE.Object3D) {
    for (const p of this.pages) if (p.mesh.parent !== scene) scene.add(p.mesh);
  }
  detachFromScene(scene: THREE.Object3D) {
    for (const p of this.pages)
      if (p.mesh.parent === scene) scene.remove(p.mesh);
  }
  private readonly handleContextLost = (event?: Event) => {
    event?.preventDefault?.();
    if (!this.disposed) {
      this.contextLost = true;
      this.disposeGpuResources();
    }
  };
  updateSelection(
    selection: GpuStreamingSelection,
  ): void {
    if (this.disposed || this.contextLost)
      throw new Error('GPU SegmentTemplate renderer is unavailable');
    if (selection.pages.length !== this.pages.length)
      throw new RangeError('selection page count does not match page plan');
    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i]!,
        selected = selection.pages[i]!;
      if (
        selected.firstSegment !== page.planPage.firstSegment ||
        selected.indices.length !== selected.emittedCount
      )
        throw new RangeError(`selection page ${i} does not match page plan`);
      if (selected.emittedCount > page.planPage.segmentCount)
        throw new RangeError(`selection page ${i} exceeds index capacity`);
      for (const local of selected.indices)
        if (local >= page.planPage.segmentCount)
          throw new RangeError(
            `selection page ${i} contains an out-of-range local index`,
          );
      page.indexData.fill(0);
      page.indexData.set(selected.indices);
      page.indexTexture.needsUpdate = true;
      page.mesh.count = selected.emittedCount;
    }
  }
  updateDimming(activeLayer: number, earlierLayerDim = 0.25) {
    if (this.disposed || this.contextLost) return;
    for (const page of this.pages) {
      const uniforms = (page.mesh.material as THREE.ShaderMaterial).uniforms;
      uniforms.active_layer.value = activeLayer;
      uniforms.earlier_layer_dim.value = earlierLayerDim;
    }
  }
  updateColorScheme(scheme: PreviewColorScheme): void {
    if (this.disposed || this.contextLost)
      throw new Error('GPU SegmentTemplate renderer is unavailable');
    const colors = this.staticTextures.color.image.data as Float32Array;
    for (let i = 0; i < this.source.segmentCount; i++) {
      const c = resolvePreviewColor(this.source, i, scheme);
      for (const endpoint of [i * 2, i * 2 + 1]) {
        const o = endpoint * 4;
        colors[o] = c[0];
        colors[o + 1] = c[1];
        colors[o + 2] = c[2];
      }
    }
    this.staticTextures.color.needsUpdate = true;
  }
  /**
   * Return the colors currently uploaded to the SegmentTemplate color texture.
   * This is used only by the real-renderer E2E diagnostic seam; the renderer
   * itself still consumes the preview source and active scheme normally.
   */
  debugColorSamples(): readonly (readonly [number, number, number])[] {
    const data = this.staticTextures.color.image.data as Float32Array;
    const samples: [number, number, number][] = [];
    const seen = new Set<string>();
    for (let offset = 0; offset + 2 < data.length; offset += 4) {
      const sample: [number, number, number] = [
        data[offset] ?? 0,
        data[offset + 1] ?? 0,
        data[offset + 2] ?? 0,
      ];
      const key = sample.join(',');
      if (!seen.has(key)) {
        seen.add(key);
        samples.push(sample);
      }
    }
    return samples;
  }
  private disposeGpuResources() {
    if (this.gpuDisposed) return;
    this.gpuDisposed = true;
    for (const page of this.pages) {
      page.mesh.count = 0;
      page.indexTexture.dispose();
      (page.mesh.material as THREE.Material).dispose();
    }
    this.staticTextures.dispose();
    this.template.dispose();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.contextElement?.domElement?.removeEventListener?.(
      'webglcontextlost',
      this.handleContextLost,
    );
    this.disposeGpuResources();
  }
}
function defaultTemplate(): GpuStreamingSegmentTemplateResource {
  const geometry = createSegmentTemplateGeometry();
  return { geometry, dispose: onceDispose(() => geometry.dispose()) };
}
export function createGpuStreamingRenderer(
  plan: GpuStreamingPagePlan,
  options: GpuStreamingRendererOptions = {},
): GpuStreamingBuildResult {
  if (!plan || !plan.diagnostics || !Array.isArray(plan.pages))
    return {
      ok: false,
      diagnostics: {
        reason: 'invalid-page-plan',
        message: 'A valid GpuStreamingPagePlan is required',
        capabilities: null,
      },
    };
  if (plan.diagnostics.budgetExceeded)
    return {
      ok: false,
      diagnostics: {
        reason: 'gpu-budget-exceeded',
        message: `GPU SegmentTemplate plan exceeds configured budget of ${plan.diagnostics.budgetBytes} bytes`,
        capabilities: null,
      },
    };
  let context: WebGLRenderingContext | undefined;
  try {
    context = options.context ?? options.renderer?.getContext();
  } catch (error) {
    return {
      ok: false,
      diagnostics: {
        reason: 'context-query-failed',
        message: error instanceof Error ? error.message : String(error),
        capabilities: null,
      },
    };
  }
  if (!context)
    return {
      ok: false,
      diagnostics: {
        reason: 'no-context',
        message:
          'A WebGL2 context is required for native SegmentTemplate rendering',
        capabilities: null,
      },
    };
  let capabilities: GpuStreamingCapabilityProbe;
  try {
    capabilities = probeGpuStreamingCapabilities(context);
  } catch (error) {
    return {
      ok: false,
      diagnostics: {
        reason: 'capability-query-failed',
        message: error instanceof Error ? error.message : String(error),
        capabilities: null,
      },
    };
  }
  if (!capabilities.supported)
    return {
      ok: false,
      diagnostics: {
        reason: capabilities.reason ?? 'unsupported',
        message:
          'Native SegmentTemplate rendering requires WebGL2, integer textures, and vertex texture fetch',
        capabilities,
      },
    };
  let template: GpuStreamingSegmentTemplateResource | undefined;
  let textures: StaticTextures | undefined;
  const pages: PageState[] = [];
  try {
    const facade = options.resourceFacade;
    const create = facade?.createSegmentTemplate ?? defaultTemplate;
    const created = create();
    template = { ...created, dispose: onceDispose(created.dispose) };
    if (template.geometry.getAttribute('vertex_id') === undefined)
      template.geometry.setAttribute(
        'vertex_id',
        new THREE.Uint8BufferAttribute(SEGMENT_TEMPLATE_VERTEX_IDS, 1),
      );
    template.geometry.setDrawRange(0, SEGMENT_TEMPLATE_INVOCATION_COUNT);
    textures = buildStaticTextures(
      plan.source,
      capabilities.limits.maxTextureSize!,
    );
    for (const page of plan.pages) {
      const index = indexTexture(
        new Uint32Array(page.segmentCount),
        capabilities.limits.maxTextureSize!,
      );
      const material = makeMaterial(
        textures,
        index.texture,
        index.size,
        page.firstSegment,
      );
      const mesh = new THREE.InstancedMesh(
        template.geometry,
        material,
        page.segmentCount,
      );
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.renderOrder = 1000;
      pages.push({
        planPage: page,
        mesh,
        indexData: index.texture.image.data as Uint32Array,
        indexTexture: index.texture,
      });
    }
    const backend = new GpuStreamingRenderer(
      plan,
      capabilities,
      template,
      textures,
      pages,
      options.renderer,
    );
    if (options.compile !== false && options.renderer?.compile) {
      const scene = new THREE.Scene();
      pages.forEach((p) => scene.add(p.mesh));
      options.renderer.compile(scene, new THREE.Camera());
    }
    return { ok: true, backend };
  } catch (error) {
    for (const page of pages) {
      page.indexTexture.dispose();
      (page.mesh.material as THREE.Material).dispose();
    }
    textures?.dispose();
    template?.dispose();
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
