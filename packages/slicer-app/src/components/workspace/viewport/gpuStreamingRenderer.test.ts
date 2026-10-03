import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  planGpuStreamingPages,
  rebuildGpuStreamingSelection,
  type GpuStreamingSource,
} from './gpuStreamingPlanner';
import {
  createGpuStreamingRenderer,
  LIBVGCODE_DEFAULT_TRAVEL_RADIUS_MM,
  probeGpuStreamingCapabilities,
  type GpuStreamingSegmentTemplateResource,
  type GpuStreamingResourceFacade,
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
    moveTypes: new Uint8Array([10, 8, 10, 10]),
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
function context(
  overrides: Record<string, unknown> = {},
): WebGLRenderingContext {
  const values: Record<string, unknown> = {
    VERSION: 'WebGL 2.0 mock',
    MAX_TEXTURE_SIZE: 4096,
    MAX_TEXTURE_IMAGE_UNITS: 8,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 8,
    ...overrides,
  };
  return {
    VERSION: 'VERSION',
    MAX_TEXTURE_SIZE: 'MAX_TEXTURE_SIZE',
    MAX_TEXTURE_IMAGE_UNITS: 'MAX_TEXTURE_IMAGE_UNITS',
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 'MAX_VERTEX_TEXTURE_IMAGE_UNITS',
    getParameter: (key: unknown) => values[key as string],
  } as unknown as WebGLRenderingContext;
}
function templateFacade() {
  const dispose = vi.fn();
  const resourceFacade: GpuStreamingResourceFacade = {
    createSegmentTemplate: (): GpuStreamingSegmentTemplateResource => ({
      geometry: new THREE.BufferGeometry(),
      dispose,
    }),
  };
  return { resourceFacade, dispose };
}

describe('native SegmentTemplate GPU renderer', () => {
  it('draws zero-length events as endpoint diamonds, partitions one index stream, and releases marker resources', () => {
    const input = source();
    input.moveTypes.set([10, 9, 3, 4]);
    input.starts.set([25, 10, 0.4], 6);
    input.ends.set([25, 10, 0.4], 6);
    input.widths[3] = 0; input.heights[3] = 0;
    const plan = planGpuStreamingPages(input, { softPageTarget: 4 });
    const result = createGpuStreamingRenderer(plan, { context: context(), compile: false });
    expect(result.ok).toBe(true); if (!result.ok) return;
    const backend = result.backend, page = backend.pages[0]!;
    const scene = new THREE.Scene(); backend.attachToScene(scene);
    expect(scene.children).toEqual([page.mesh, page.markerMesh]);
    expect(page.markerMesh.geometry.getAttribute('position').count).toBe(96);
    const material = page.markerMesh.material as THREE.ShaderMaterial;
    expect(material.blending).toBe(THREE.NoBlending);
    expect(material.depthWrite).toBe(true);
    const shape = material.uniforms.height_width_angle_tex.value.image.data as Float32Array;
    expect(shape[8]).toBeCloseTo(0.1); expect(shape[9]).toBeCloseTo(0.1); // Wipe thin line
    expect(shape[10]).toBe(0); expect(shape[11]).toBeCloseTo(0.05);
    expect(shape[28]).toBeCloseTo(0.2); expect(shape[29]).toBeCloseTo(0.4); // startup fallback
    const options = { visibleLayerStart: 0, visibleLayerEnd: 1, activeMoveEnd: 10, showTravel: true };
    backend.updateSelection(rebuildGpuStreamingSelection(plan, options));
    expect(page.mesh.count).toBe(2); expect(page.markerMesh.count).toBe(2);
    expect(Array.from(page.indexData.slice(0, 4))).toEqual([0, 1, 2, 3]);
    expect(material.uniforms.index_offset.value).toBe(2);
    backend.updateSelection(rebuildGpuStreamingSelection(plan, { ...options, visibility: { 4: false }, moveVisibility: { 3: false } }));
    expect(page.mesh.count).toBe(1); expect(page.markerMesh.count).toBe(1);
    expect(Array.from(page.indexData.slice(0, 2))).toEqual([1, 3]);
    expect(material.uniforms.index_offset.value).toBe(1);
    backend.updateDimming(1, 0.34);
    expect(material.uniforms.active_layer.value).toBe(1);
    expect(material.uniforms.earlier_layer_dim.value).toBe(0.34);
    const geometryDispose = vi.spyOn(page.markerMesh.geometry, 'dispose');
    const meshDispose = vi.spyOn(page.markerMesh, 'dispose');
    const materialDispose = vi.spyOn(material, 'dispose');
    backend.detachFromScene(scene); expect(scene.children).toHaveLength(0);
    backend.dispose(); backend.dispose();
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(meshDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
  });

  it('releases event geometry and the context listener when shader compilation fails', () => {
    const input = source(); input.moveTypes[0] = 3;
    const element = new EventTarget();
    const add = vi.spyOn(element, 'addEventListener'), remove = vi.spyOn(element, 'removeEventListener');
    let releaseGeometry: ReturnType<typeof vi.spyOn> | undefined;
    let releaseMaterial: ReturnType<typeof vi.spyOn> | undefined;
    const result = createGpuStreamingRenderer(planGpuStreamingPages(input), {
      renderer: { domElement: element, getContext: () => context(), compile: (scene) => {
        const marker = scene.children[1] as THREE.InstancedMesh;
        releaseGeometry = vi.spyOn(marker.geometry, 'dispose');
        releaseMaterial = vi.spyOn(marker.material as THREE.Material, 'dispose');
        throw new Error('shader compilation failed');
      } },
    });
    expect(result.ok).toBe(false);
    expect(releaseGeometry).toHaveBeenCalledTimes(1);
    expect(releaseMaterial).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('webglcontextlost', add.mock.calls[0]![1]);
  });

  it('requires WebGL2, integer-texture units, and vertex texture fetch', () => {
    expect(probeGpuStreamingCapabilities(context()).supported).toBe(true);
    expect(
      probeGpuStreamingCapabilities(context({ VERSION: 'WebGL 1.0' })).reason,
    ).toBe('webgl2-required');
    expect(
      probeGpuStreamingCapabilities(context({ MAX_TEXTURE_IMAGE_UNITS: 1 }))
        .reason,
    ).toBe('texture-units-insufficient');
    expect(
      probeGpuStreamingCapabilities(
        context({ MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0 }),
      ).reason,
    ).toBe('vertex-texture-fetch-unavailable');
  });

  it('constructs page-local draws over one shared 8-vertex/24-invocation template', () => {
    const plan = planGpuStreamingPages(source(), { softPageTarget: 2 });
    const result = createGpuStreamingRenderer(plan, {
      context: context(),
      compile: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backend.pages).toHaveLength(2);
    for (const page of result.backend.pages) {
      const mesh = page.mesh;
      expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
      expect(mesh.geometry).toBeInstanceOf(THREE.BufferGeometry);
      expect(mesh.geometry.getAttribute('vertex_id').count).toBe(24);
      expect(mesh.geometry.getAttribute('position')).toBeUndefined();
      expect(mesh.geometry.index).toBeNull();
      expect(mesh.material).toBeInstanceOf(THREE.ShaderMaterial);
      const material = mesh.material as THREE.ShaderMaterial;
      // Transparent queue membership is used only to draw after the
      // transparent model shell; the actual blend state remains disabled.
      expect(material.transparent).toBe(true);
      expect(material.opacity).toBe(1);
      expect(material.blending).toBe(THREE.NoBlending);
      expect(material.depthTest).toBe(true);
      expect(material.depthWrite).toBe(true);
      // Native ViewerImpl disables GL_CULL_FACE. DoubleSide does the same
      // without enabling blending; depth test/write remain authoritative.
      expect(material.side).toBe(THREE.DoubleSide);
      // The physical prism has no vertex color attribute. The renderer must leave
      // vertexColors off so Three does not multiply the instance color by a
      // missing (zero-valued) `color` attribute.
      expect(material.vertexColors).toBe(false);
      expect(material.glslVersion).toBe(THREE.GLSL3);
      expect(material.vertexShader).toContain('#define POINTY_CAPS');
      expect(material.vertexShader).toContain('#define FIX_TWISTING');
      expect(material.vertexShader).toContain('cameraPosition');
      expect(material.vertexShader).toContain('hwa.z');
      expect(material.vertexShader).toContain('gl_InstanceID');
      expect(material.uniforms.segment_index_tex).toBeDefined();
      const position = material.uniforms.position_tex
        .value as THREE.DataTexture;
      const shape = material.uniforms.height_width_angle_tex
        .value as THREE.DataTexture;
      const color = material.uniforms.color_tex.value as THREE.DataTexture;
      const index = material.uniforms.segment_index_tex
        .value as THREE.DataTexture;
      for (const texture of [position, shape, color, index]) {
        expect(texture.minFilter).toBe(THREE.NearestFilter);
        expect(texture.magFilter).toBe(THREE.NearestFilter);
        expect(texture.wrapS).toBe(THREE.ClampToEdgeWrapping);
        expect(texture.wrapT).toBe(THREE.ClampToEdgeWrapping);
        expect(texture.generateMipmaps).toBe(false);
      }
      expect(position.format).toBe(THREE.RGBAFormat);
      expect(position.type).toBe(THREE.FloatType);
      expect(shape.format).toBe(THREE.RGBAFormat);
      expect(shape.type).toBe(THREE.FloatType);
      expect(color.format).toBe(THREE.RGBAFormat);
      expect(color.type).toBe(THREE.FloatType);
      expect(index.format).toBe(THREE.RedIntegerFormat);
      expect(index.type).toBe(THREE.UnsignedIntType);
      expect(index.internalFormat).toBe('R32UI');
      expect(index.image.width).toBe(2);
      expect(index.image.height).toBe(1);
    }
    result.backend.dispose();
  });

  it('uses libvgcode travel radius instead of the physical extrusion width', () => {
    const plan = planGpuStreamingPages(source(), { softPageTarget: 4 });
    const result = createGpuStreamingRenderer(plan, {
      context: context(),
      compile: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const shape = (
      (result.backend.pages[0]!.mesh.material as THREE.ShaderMaterial)
        .uniforms.height_width_angle_tex.value as THREE.DataTexture
    ).image.data as Float32Array;
    // Segment 0 is extrusion: preserve its source geometry.
    expect(shape[0]).toBeCloseTo(0.2);
    expect(shape[1]).toBeCloseTo(0.4);
    // Segment 1 is travel: both endpoint texels use native 0.1 mm radius,
    // regardless of the source's 0.2 mm height / 0.5 mm width.
    expect(shape[8]).toBeCloseTo(LIBVGCODE_DEFAULT_TRAVEL_RADIUS_MM);
    expect(shape[9]).toBeCloseTo(LIBVGCODE_DEFAULT_TRAVEL_RADIUS_MM);
    expect(shape[12]).toBeCloseTo(LIBVGCODE_DEFAULT_TRAVEL_RADIUS_MM);
    expect(shape[13]).toBeCloseTo(LIBVGCODE_DEFAULT_TRAVEL_RADIUS_MM);
    result.backend.dispose();
  });

  it('adds each page base before reading global static segment textures', () => {
    const plan = planGpuStreamingPages(source(), { softPageTarget: 2 });
    expect(plan.pages.map((page) => page.firstSegment)).toEqual([0, 2]);
    const result = createGpuStreamingRenderer(plan, {
      context: context(),
      compile: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const materials = result.backend.pages.map(
      (page) => page.mesh.material as THREE.ShaderMaterial,
    );
    expect(materials.map((material) => material.uniforms.segment_base.value)).toEqual([0, 2]);
    expect(materials[0]!.vertexShader).toContain(
      'int a=(int(selected())+segment_base)*2;',
    );
    result.backend.dispose();
  });

  it('streams pointy caps at selected boundaries with native continuity', () => {
    const p = planGpuStreamingPages(
      {
        ...source(),
        segmentCount: 2,
        starts: new Float32Array([0, 0, 0, 1, 0, 0]),
        ends: new Float32Array([1, 0, 0, 1, 1, 0]),
        layerIds: new Uint32Array([0, 0]),
        moveTypes: new Uint8Array([10, 10]),
        widths: new Float32Array([0.4, 0.4]),
        heights: new Float32Array([0.2, 0.2]),
      },
      { softPageTarget: 4 },
    );
    const result = createGpuStreamingRenderer(p, {
      context: context(),
      compile: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.backend.updateSelection(
      rebuildGpuStreamingSelection(p, {
        visibleLayerStart: 0,
        visibleLayerEnd: 0,
        activeMoveEnd: Number.MAX_SAFE_INTEGER,
        showTravel: true,
      }),
    );
    result.backend.dispose();
  });

  it('uses the native eight-logical-vertex template in every page draw', () => {
    const plan = planGpuStreamingPages(source(), { softPageTarget: 4 });
    const result = createGpuStreamingRenderer(plan, {
      context: context(),
      compile: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const vertexIds =
      result.backend.pages[0]!.mesh.geometry.getAttribute('vertex_id');
    expect(vertexIds.count).toBe(24);
    expect(new Set(Array.from(vertexIds.array as Uint8Array))).toEqual(
      new Set([0, 1, 2, 3, 4, 5, 6, 7]),
    );
    result.backend.dispose();
  });

  it('uploads only selected index streams, preserves pages, and leaves camera static data untouched', () => {
    const plan = planGpuStreamingPages(source(), { softPageTarget: 2 });
    const result = createGpuStreamingRenderer(plan, {
      context: context(),
      compile: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const selection = rebuildGpuStreamingSelection(plan, {
      visibleLayerStart: 0,
      visibleLayerEnd: 1,
      activeMoveEnd: Number.MAX_SAFE_INTEGER,
      showTravel: true,
      visibility: { 4: true, 5: true, 6: true, 7: true },
    });
    expect(selection.visitedSegments).toBe(4);
    result.backend.updateSelection(selection);
    const firstMesh = result.backend.pages[0]!.mesh;
    expect(firstMesh.count).toBe(2);
    expect(firstMesh.material).toBeInstanceOf(THREE.ShaderMaterial);
    const firstIndex = result.backend.pages[0]!.indexData;
    expect(Array.from(firstIndex.slice(0, 2))).toEqual([0, 1]);
    const filtered = rebuildGpuStreamingSelection(plan, {
      visibleLayerStart: 1,
      visibleLayerEnd: 1,
      activeMoveEnd: Number.MAX_SAFE_INTEGER,
      showTravel: false,
      visibility: { 4: false },
    });
    result.backend.updateSelection(filtered);
    expect(result.backend.pages.map((page) => page.mesh.count)).toEqual([0, 2]);
    expect(Array.from(firstIndex.slice(0, 2))).toEqual([0, 0]);
    result.backend.dispose();
  });

  it('resolves indexed legacy palettes as well as explicit feature ids', () => {
    const legacy = {
      ...source(),
      palette: [
        {
          id: 100,
          name: 'first',
          color: [255, 0, 0] as [number, number, number],
        },
        {
          id: 101,
          name: 'second',
          color: [0, 255, 0] as [number, number, number],
        },
      ],
      features: new Uint32Array([0, 1, 0, 1]),
    };
    const plan = planGpuStreamingPages(legacy, { softPageTarget: 4 });
    const result = createGpuStreamingRenderer(plan, {
      context: context(),
      compile: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const selection = rebuildGpuStreamingSelection(plan, {
      visibleLayerStart: 0,
      visibleLayerEnd: 1,
      activeMoveEnd: Number.MAX_SAFE_INTEGER,
      showTravel: true,
    });
    result.backend.updateSelection(selection);
    expect(
      (result.backend.pages[0]!.mesh.material as THREE.ShaderMaterial)
        .uniforms.color_tex.value,
    ).toBeDefined();
    result.backend.dispose();
  });

  it('resolves travel by move type even when its stale role palette is hidden', () => {
    const plan = planGpuStreamingPages(source(), { softPageTarget: 4 });
    const result = createGpuStreamingRenderer(plan, {
      context: context(),
      compile: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const selection = rebuildGpuStreamingSelection(plan, {
      visibleLayerStart: 0,
      visibleLayerEnd: 1,
      activeMoveEnd: Number.MAX_SAFE_INTEGER,
      showTravel: true,
      visibility: { 5: false },
    });
    expect(selection.emittedSegments).toBe(4);
    result.backend.updateSelection(selection);
    expect(
      (result.backend.pages[0]!.mesh.material as THREE.ShaderMaterial)
        .uniforms.segment_index_tex.value,
    ).toBeDefined();
    result.backend.dispose();
  });

  it('uses opaque fallback colors and releases the template on context loss/dispose', () => {
    const f = templateFacade();
    const plan = planGpuStreamingPages(source(), { softPageTarget: 2 });
    const result = createGpuStreamingRenderer(plan, {
      context: context(),
      resourceFacade: f.resourceFacade,
      compile: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const selection = rebuildGpuStreamingSelection(plan, {
      visibleLayerStart: 0,
      visibleLayerEnd: 1,
      activeMoveEnd: Number.MAX_SAFE_INTEGER,
      showTravel: true,
    });
    result.backend.updateSelection(selection);
    result.backend.updateColorScheme('feature');
    result.backend.dispose();
    result.backend.dispose();
    expect(f.dispose).toHaveBeenCalledTimes(1);
  });
});
