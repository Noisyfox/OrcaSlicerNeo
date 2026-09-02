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
import { TOOLPATH_ENTITY_CHAMFER_RATIO } from './toolpathEntityGeometry';

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

  it('constructs page-local InstancedMesh objects with opaque direct materials', () => {
    const plan = planGpuStreamingPages(source(), { softPageTarget: 2 });
    const result = createGpuStreamingRenderer(plan, { context: context(), compile: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backend.sceneObjects).toHaveLength(2);
    for (const mesh of result.backend.sceneObjects) {
      expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
      expect(mesh.geometry).toBeInstanceOf(THREE.BufferGeometry);
      expect(mesh.geometry.getAttribute('position').count).toBe(96);
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

  it('uses a scale-aware physical chamfer for edge relief', () => {
    expect(TOOLPATH_ENTITY_CHAMFER_RATIO).toBeGreaterThan(0);
    expect(TOOLPATH_ENTITY_CHAMFER_RATIO).toBeLessThan(0.5);
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
    expect(Array.from(firstMesh.instanceColor!.array.slice(0, 6))).toEqual([1, 2, 3, 4, 5, 6].map((value) => expect.closeTo(value / 255, 5)));
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
    expect(Array.from(colors.array.slice(0, 6))).toEqual([1, 0, 0, 0, 1, 0]);
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
