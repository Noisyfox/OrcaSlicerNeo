import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { planGpuStreamingPages, rebuildGpuStreamingSelection, type GpuStreamingSource } from './gpuStreamingPlanner';
import {
  buildGpuStreamingInstanceMatrix,
  createGpuStreamingRenderer,
  probeGpuStreamingCapabilities,
  type GpuStreamingEntityTemplateResource,
  type GpuStreamingResourceFacade,
} from './gpuStreamingRenderer';
import { TOOLPATH_ENTITY_DIAMOND_HALF_EXTENT, TOOLPATH_ENTITY_PROFILE } from './toolpathEntityGeometry';

function source(): GpuStreamingSource {
  return {
    segmentCount: 4,
    starts: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]),
    ends: new Float32Array([1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0]),
    widths: new Float32Array([0.4, 0.5, 0.6, 0.7]), heights: new Float32Array([0.2, 0.2, 0.25, 0.3]),
    layerIds: new Uint32Array([0, 0, 1, 1]), moveOrders: new Uint32Array([0, 1, 0, 1]),
    gcodeIds: new Uint32Array([10, 11, 12, 13]), moveTypes: new Uint8Array([1, 8, 2, 3]),
    extrusionRoles: new Uint16Array([1, 2, 3, 4]), extruderIds: new Uint8Array([0, 0, 1, 1]),
    colorPrintIds: new Uint8Array([0, 0, 1, 1]), features: new Uint32Array([4, 5, 6, 7]),
    palette: [{ id: 4, name: 'feature', color: [1, 2, 3] }, { id: 5, name: 'travel', color: [4, 5, 6] }],
    metrics: {}, layers: [],
  };
}
function context(overrides: Record<string, unknown> = {}): WebGLRenderingContext {
  const values: Record<string, unknown> = { VERSION: 'WebGL 2.0 mock', MAX_TEXTURE_SIZE: 4096, MAX_TEXTURE_IMAGE_UNITS: 1, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0, ...overrides };
  return {
    VERSION: 'VERSION', MAX_TEXTURE_SIZE: 'MAX_TEXTURE_SIZE', MAX_TEXTURE_IMAGE_UNITS: 'MAX_TEXTURE_IMAGE_UNITS',
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 'MAX_VERTEX_TEXTURE_IMAGE_UNITS', getParameter: (key: unknown) => values[key as string],
  } as unknown as WebGLRenderingContext;
}
function entityFacade() {
  const dispose = vi.fn();
  const resourceFacade: GpuStreamingResourceFacade = {
    createEntityTemplate: (): GpuStreamingEntityTemplateResource => ({
      geometry: new THREE.BufferGeometry(),
      material: new THREE.MeshStandardMaterial({ vertexColors: false, flatShading: true, color: 0xffffff, roughness: 0.82, metalness: 0, transparent: false, opacity: 1, blending: THREE.NoBlending, depthTest: false, depthWrite: false }),
      dispose,
    }),
  };
  return { resourceFacade, dispose };
}

describe('opaque GPU entity renderer', () => {
  it('requires WebGL2 only; no texture fetch or shader capability is needed', () => {
    expect(probeGpuStreamingCapabilities(context()).supported).toBe(true);
    expect(probeGpuStreamingCapabilities(context({ VERSION: 'WebGL 1.0' })).reason).toBe('webgl2-required');
    expect(probeGpuStreamingCapabilities(context({ MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0 })).supported).toBe(true);
  });

  it('bakes segment direction, width and height into a real transform', () => {
    const p = planGpuStreamingPages(source(), { softPageTarget: 2 });
    const matrix = buildGpuStreamingInstanceMatrix(p.source, 0);
    const e = matrix.elements;
    expect(new THREE.Vector3().setFromMatrixPosition(matrix).toArray()).toEqual([0.5, 0, 0]);
    expect(new THREE.Vector3(e[0], e[1], e[2]).length()).toBeCloseTo(1);
    expect(new THREE.Vector3(e[4], e[5], e[6]).length()).toBeCloseTo(0.4);
    expect(new THREE.Vector3(e[8], e[9], e[10]).length()).toBeCloseTo(0.2);
  });

  it('overlaps contiguous straight and corner moves instead of drawing endpoint caps', () => {
    const straight = { ...source(), moveTypes: new Uint8Array([1, 1, 1, 1]) };
    const straightPlan = planGpuStreamingPages(straight, { softPageTarget: 4 });
    const first = buildGpuStreamingInstanceMatrix(straightPlan.source, 0);
    expect(new THREE.Vector3().setFromMatrixPosition(first).x).toBeCloseTo(0.6);
    expect(new THREE.Vector3().setFromMatrixScale(first).x).toBeCloseTo(1.2);

    const corner = {
      ...straight,
      starts: Float32Array.from([0, 0, 0, 1, 0, 0]),
      ends: Float32Array.from([1, 0, 0, 1, 1, 0]),
      layerIds: new Uint32Array([0, 0]),
      moveTypes: new Uint8Array([0, 0]),
      widths: new Float32Array([0.4, 0.4]),
      heights: new Float32Array([0.2, 0.2]),
      segmentCount: 2,
    };
    const cornerPlan = planGpuStreamingPages(corner, { softPageTarget: 4 });
    const horizontal = buildGpuStreamingInstanceMatrix(cornerPlan.source, 0);
    const vertical = buildGpuStreamingInstanceMatrix(cornerPlan.source, 1);
    expect(new THREE.Vector3().setFromMatrixScale(horizontal).x).toBeCloseTo(1.2);
    expect(new THREE.Vector3().setFromMatrixPosition(vertical).y).toBeCloseTo(0.4);
    expect(new THREE.Vector3().setFromMatrixScale(vertical).x).toBeCloseTo(1.2);
  });

  it('constructs page-local InstancedMesh objects with opaque direct materials', () => {
    const plan = planGpuStreamingPages(source(), { softPageTarget: 2 });
    const result = createGpuStreamingRenderer(plan, { context: context(), compile: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backend.sceneObjects).toHaveLength(2);
    for (const mesh of result.backend.sceneObjects) {
      expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
      expect(mesh.geometry).toBeInstanceOf(THREE.BufferGeometry);
      expect(mesh.geometry.getAttribute('position').count).toBe(24);
      expect(mesh.geometry.index).toBeNull();
      expect(mesh.material).toBeInstanceOf(THREE.MeshStandardMaterial);
      const material = mesh.material as THREE.MeshStandardMaterial;
      // Transparent queue membership is used only to draw after the
      // transparent model shell; the actual blend state remains disabled.
      expect(material.transparent).toBe(true);
      expect(material.opacity).toBe(1);
      expect(material.blending).toBe(THREE.NoBlending);
      expect(material.depthTest).toBe(true);
      expect(material.depthWrite).toBe(true);
      expect(material.side).toBe(THREE.FrontSide);
      // The physical prism has no vertex color attribute. The renderer must leave
      // vertexColors off so Three does not multiply the instance color by a
      // missing (zero-valued) `color` attribute.
      expect(material.vertexColors).toBe(false);
      expect(material.flatShading).toBe(true);
      expect(material.color.getHex()).toBe(0xffffff);
      expect(material.roughness).toBeCloseTo(0.82);
      expect(material.metalness).toBe(0);
      expect(material.forceSinglePass).toBe(true);
    }
    result.backend.dispose();
  });

  it('streams pointy caps at selected boundaries with the same continuity as B2', () => {
    const p = planGpuStreamingPages({
      ...source(),
      segmentCount: 2,
      starts: new Float32Array([0, 0, 0, 1, 0, 0]),
      ends: new Float32Array([1, 0, 0, 1, 1, 0]),
      layerIds: new Uint32Array([0, 0]),
      moveTypes: new Uint8Array([1, 1]),
      widths: new Float32Array([0.4, 0.4]),
      heights: new Float32Array([0.2, 0.2]),
    }, { softPageTarget: 4 });
    const result = createGpuStreamingRenderer(p, { context: context(), compile: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.backend.updateSelection(rebuildGpuStreamingSelection(p, {
      visibleLayerStart: 0, visibleLayerEnd: 0, activeMoveEnd: Number.MAX_SAFE_INTEGER, showTravel: true,
    }));
    expect(result.backend.endpointSceneObjects[0]!.count).toBe(2);
    result.backend.dispose();
  });

  it('uses the native four-point diamond profile in the GPU template', () => {
    expect(TOOLPATH_ENTITY_PROFILE).toBe('diamond');
    expect(TOOLPATH_ENTITY_DIAMOND_HALF_EXTENT).toBeCloseTo(0.5);
    const plan = planGpuStreamingPages(source(), { softPageTarget: 4 });
    const result = createGpuStreamingRenderer(plan, { context: context(), compile: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const positions = result.backend.sceneObjects[0]!.geometry.getAttribute('position');
    const crossSection = new Set<string>();
    for (let i = 0; i < positions.count; i++) {
      const y = positions.getY(i);
      const z = positions.getZ(i);
      if (Math.abs(Math.abs(y) + Math.abs(z) - 0.5) < 1e-6) crossSection.add(`${y},${z}`);
    }
    expect(crossSection).toEqual(new Set(['0,-0.5', '0.5,0', '0,0.5', '-0.5,0']));
    result.backend.dispose();
  });

  it('writes selected transforms/colors, preserves all high pages, and rebuilds filters without parsing', () => {
    const plan = planGpuStreamingPages(source(), { softPageTarget: 2 });
    const result = createGpuStreamingRenderer(plan, { context: context(), compile: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const selection = rebuildGpuStreamingSelection(plan, { visibleLayerStart: 0, visibleLayerEnd: 1, activeMoveEnd: Number.MAX_SAFE_INTEGER, showTravel: true, featureVisibility: { 4: true, 5: true, 6: true, 7: true } });
    expect(selection.visitedSegments).toBe(4);
    expect(result.backend.updateSelection(selection).drawInstanceCounts).toEqual([2, 2]);
    const firstMesh = result.backend.sceneObjects[0]!;
    expect(firstMesh.count).toBe(2);
    expect(firstMesh.instanceMatrix.count).toBeGreaterThanOrEqual(2);
    expect(firstMesh.instanceColor).not.toBeNull();
    expect(Array.from(firstMesh.instanceColor!.array.slice(0, 6))).toEqual([
      1 / 255, 2 / 255, 3 / 255,
      56 / 255, 72 / 255, 155 / 255,
    ].map((value) => expect.closeTo(value, 5)));
    const before = result.backend.entityUploadCount;
    const filtered = rebuildGpuStreamingSelection(plan, { visibleLayerStart: 1, visibleLayerEnd: 1, activeMoveEnd: Number.MAX_SAFE_INTEGER, showTravel: false, featureVisibility: { 4: false } });
    result.backend.updateSelection(filtered);
    expect(result.backend.entityUploadCount).toBe(before + 2);
    expect(result.backend.drawInstanceCounts).toEqual([0, 2]);
    result.backend.updateCamera({ position: new THREE.Vector3(1, 2, 3) });
    expect(result.backend.entityUploadCount).toBe(before + 2);
    result.backend.dispose();
  });

  it('resolves indexed legacy palettes as well as explicit feature ids', () => {
    const legacy = {
      ...source(),
      palette: [
        { id: 100, name: 'first', color: [255, 0, 0] as [number, number, number] },
        { id: 101, name: 'second', color: [0, 255, 0] as [number, number, number] },
      ],
      features: new Uint32Array([0, 1, 0, 1]),
    };
    const plan = planGpuStreamingPages(legacy, { softPageTarget: 4 });
    const result = createGpuStreamingRenderer(plan, { context: context(), compile: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const selection = rebuildGpuStreamingSelection(plan, { visibleLayerStart: 0, visibleLayerEnd: 1, activeMoveEnd: Number.MAX_SAFE_INTEGER, showTravel: true });
    result.backend.updateSelection(selection);
    const colors = result.backend.sceneObjects[0]!.instanceColor!;
    expect(Array.from(colors.array.slice(0, 6))).toEqual([
      1, 0, 0, 56 / 255, 72 / 255, 155 / 255,
    ].map((value) => expect.closeTo(value, 5)));
    result.backend.dispose();
  });

  it('resolves travel by move type even when its stale role palette is hidden', () => {
    const plan = planGpuStreamingPages(source(), { softPageTarget: 4 });
    const result = createGpuStreamingRenderer(plan, { context: context(), compile: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const selection = rebuildGpuStreamingSelection(plan, {
      visibleLayerStart: 0,
      visibleLayerEnd: 1,
      activeMoveEnd: Number.MAX_SAFE_INTEGER,
      showTravel: true,
      featureVisibility: { 5: false },
    });
    expect(selection.emittedSegments).toBe(4);
    result.backend.updateSelection(selection);
    expect(Array.from(result.backend.sceneObjects[0]!.instanceColor!.array.slice(3, 6)))
      .toEqual([56 / 255, 72 / 255, 155 / 255].map((value) => expect.closeTo(value, 5)));
    result.backend.dispose();
  });

  it('uses opaque fallback colors and releases the template on context loss/dispose', () => {
    const f = entityFacade();
    const plan = planGpuStreamingPages(source(), { softPageTarget: 2 });
    const result = createGpuStreamingRenderer(plan, { context: context(), resourceFacade: f.resourceFacade, compile: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const selection = rebuildGpuStreamingSelection(plan, { visibleLayerStart: 0, visibleLayerEnd: 1, activeMoveEnd: Number.MAX_SAFE_INTEGER, showTravel: true });
    result.backend.updateSelection(selection);
    result.backend.updatePalette([]);
    expect(result.backend.unknownFeatureIds).toEqual([4, 5, 6, 7]);
    result.backend.dispose(); result.backend.dispose();
    expect(f.dispose).toHaveBeenCalledTimes(1);
  });
});
