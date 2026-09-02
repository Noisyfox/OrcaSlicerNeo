import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  buildLayerAlignedChunkRanges,
  createToolpathBandChunk,
  selectToolpathChunks,
  ToolpathBandCache,
  updateToolpathChunkVisibility,
} from './toolpathBandGeometry';
import { createToolpathEntityCapGeometry, createToolpathEntityGeometry, TOOLPATH_ENTITY_DIAMOND_HALF_EXTENT, TOOLPATH_ENTITY_PROFILE } from './toolpathEntityGeometry';
import type { ClientToolpath } from '@slicer/client';

describe('toolpath band geometry', () => {
  it('uses a native-style four-point diamond cross-section, not a square/chamfer', () => {
    const geometry = createToolpathEntityGeometry();
    const positions = geometry.getAttribute('position');
    const bounds = new THREE.Box3().setFromBufferAttribute(positions as THREE.BufferAttribute);
    // Four diamond-ring side facets; endpoint faces are intentionally absent
    // so every continuing move cannot expose a dark flat cap.
    expect(positions.count).toBe(24);
    expect(bounds.min.toArray()).toEqual([-0.5, -0.5, -0.5]);
    expect(bounds.max.toArray()).toEqual([0.5, 0.5, 0.5]);
    expect(TOOLPATH_ENTITY_PROFILE).toBe('diamond');
    expect(TOOLPATH_ENTITY_DIAMOND_HALF_EXTENT).toBeCloseTo(0.5);
    const ring = new Set<string>();
    for (let i = 0; i < positions.count; i++) {
      const y = positions.getY(i);
      const z = positions.getZ(i);
      if (Math.abs(Math.abs(y) + Math.abs(z) - 0.5) < 1e-6) ring.add(`${y},${z}`);
    }
    expect(ring).toEqual(new Set(['0,-0.5', '0.5,0', '0,0.5', '-0.5,0']));
    const normals = geometry.getAttribute('normal');
    const unique = new Set<string>();
    for (let i = 0; i < normals.count; i++) unique.add([normals.getX(i), normals.getY(i), normals.getZ(i)].map((value) => value.toFixed(3)).join(','));
    expect(unique.size).toBeGreaterThanOrEqual(4);
    geometry.dispose();
  });

  it('restores pointy caps only at true chain boundaries, including filtered boundaries', () => {
    const range = { firstSegment: 0, segmentCount: 3, firstLayer: 0, lastLayer: 0 };
    const starts = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0]);
    const ends = Float32Array.from([1, 0, 0, 1, 1, 0, 2, 1, 0]);
    const chunk = createToolpathBandChunk(
      starts, ends, Float32Array.from([0.4, 0.4, 0.4]), Float32Array.from([0.2, 0.2, 0.2]),
      Float32Array.from([1, 0, 0, 1, 0, 0, 1, 0, 0]), range,
      Uint32Array.from([0, 0, 0]), Uint8Array.from([0, 0, 0]),
    );
    // One cap at the beginning and one at the end; the straight and corner
    // junctions remain open as in SegmentTemplate's hidden continuing spike.
    expect(chunk.capMesh.count).toBe(2);
    expect(chunk.capGeometry.getAttribute('position').count).toBe(12);
    expect(Array.from(chunk.capGeometry.getAttribute('position').array.slice(0, 3))).toEqual([-1, 0, 0]);

    updateToolpathChunkVisibility([chunk], {
      // Removing the middle move creates four genuine visible boundaries.
      visible: Uint8Array.from([1, 0, 1]),
      dimmed: Uint8Array.from([0, 0, 0]),
    });
    expect(chunk.capMesh.count).toBe(4);

    updateToolpathChunkVisibility([chunk], {
      // A move-type boundary is discontinuous even when endpoints touch.
      visible: Uint8Array.from([1, 1, 1]),
      dimmed: Uint8Array.from([0, 0, 0]),
    });
    chunk.moveTypes![1] = 1;
    updateToolpathChunkVisibility([chunk], {
      visible: Uint8Array.from([1, 1, 1]),
      dimmed: Uint8Array.from([0, 0, 0]),
    });
    expect(chunk.capMesh.count).toBe(6);

    (chunk.mesh.material as THREE.Material).dispose();
    (chunk.capMesh.material as THREE.Material).dispose();
    chunk.geometry.dispose();
    chunk.capGeometry.dispose();
  });

  it('keeps chunk boundaries aligned to complete layers', () => {
    const ranges = buildLayerAlignedChunkRanges(
      Uint32Array.from([0, 0, 0, 1, 1, 2, 2, 2]),
      8,
      2,
    );
    expect(ranges).toEqual([
      { firstSegment: 0, segmentCount: 3, firstLayer: 0, lastLayer: 0 },
      { firstSegment: 3, segmentCount: 2, firstLayer: 1, lastLayer: 1 },
      { firstSegment: 5, segmentCount: 3, firstLayer: 2, lastLayer: 2 },
    ]);
  });

  it('uses a real capped prism template and per-segment instance matrices', () => {
    const range = { firstSegment: 0, segmentCount: 2, firstLayer: 4, lastLayer: 4 };
    const chunk = createToolpathBandChunk(
      Float32Array.from([0, 0, 1, 1, 0, 1]),
      Float32Array.from([1, 0, 1, 2, 0, 1]),
      Float32Array.from([0.42, 0.68]),
      Float32Array.from([0.2, 0.32]),
      Float32Array.from([1, 0, 0, 0, 1, 0]),
      range,
    );
    expect(chunk.geometry).toBeInstanceOf(THREE.BufferGeometry);
    expect(chunk.mesh).toBeInstanceOf(THREE.InstancedMesh);
    expect(chunk.mesh.count).toBe(2);
    const material = chunk.mesh.material as THREE.MeshStandardMaterial;
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(material.vertexColors).toBe(false);
    expect(material.flatShading).toBe(true);
    expect(material.color.getHex()).toBe(0xffffff);
    expect(material.roughness).toBeCloseTo(0.82);
    expect(material.metalness).toBe(0);
    expect(material.transparent).toBe(true);
    expect(material.opacity).toBe(1);
    expect(material.blending).toBe(THREE.NoBlending);
    expect(material.depthTest).toBe(true);
    expect(material.depthWrite).toBe(true);
    expect(material.side).toBe(THREE.FrontSide);
    expect(material.forceSinglePass).toBe(true);
    expect(chunk.mesh.instanceColor).not.toBeNull();
    expect(Array.from(chunk.mesh.instanceColor!.array.slice(0, 6))).toEqual([1, 0, 0, 0, 1, 0]);
    expect(chunk.instanceMatrices).toHaveLength(2);
    expect(new THREE.Vector3().setFromMatrixScale(chunk.instanceMatrices[0]!).x).toBeCloseTo(1);
    expect(new THREE.Vector3().setFromMatrixScale(chunk.instanceMatrices[0]!).y).toBeCloseTo(0.42);
    expect(new THREE.Vector3().setFromMatrixScale(chunk.instanceMatrices[0]!).z).toBeCloseTo(0.2);
    (chunk.mesh.material as THREE.Material).dispose();
    chunk.geometry.dispose();
  });

  it('preserves the active interval while reducing only nearby layers for large gestures', () => {
    const chunks = [0, 1, 2, 3, 4, 5].map((layer) => ({
      firstSegment: layer * 10,
      segmentCount: 10,
      firstLayer: layer,
      lastLayer: layer,
    }));
    expect(selectToolpathChunks(chunks, 3, 3, 1_000_000, true)).toEqual([3]);
    expect(selectToolpathChunks(chunks, 3, 3, 1_000_000, false)).toEqual([3]);
    expect(selectToolpathChunks(chunks, 2, 3, 1_000_000, true)).toEqual([2, 3]);
    expect(selectToolpathChunks(chunks, 3, 3, 250_000, true)).toEqual([3]);
  });

  it('reuses prepared geometry across camera-only state changes', () => {
    const source: ClientToolpath = {
      vertexCount: 2,
      positions: Float32Array.from([1, 0, 0, 2, 0, 0]),
      layers: Uint32Array.from([0, 0]),
      features: Uint32Array.from([0, 0]),
      palette: [{ id: 0, name: 'perimeter', color: [255, 0, 0] }],
      segmentCount: 2,
      starts: Float32Array.from([0, 0, 0, 1, 0, 0]),
      ends: Float32Array.from([1, 0, 0, 2, 0, 0]),
      layerIds: Uint32Array.from([0, 0]),
      moveOrders: Uint32Array.from([0, 1]),
      gcodeIds: Uint32Array.from([1, 2]),
      moveTypes: Uint8Array.from([0, 0]),
      extrusionRoles: Uint16Array.from([0, 0]),
      extruderIds: Uint8Array.from([0, 0]),
      colorPrintIds: Uint8Array.from([0, 0]),
      widths: Float32Array.from([0.4, 0.5]),
      heights: Float32Array.from([0.2, 0.2]),
      metrics: {},
    };
    const cache = new ToolpathBandCache();
    const prepared = cache.prepare(source);
    const geometry = prepared.chunks[0]?.geometry;
    for (const cameraGestureActive of [false, true, false]) {
      expect(selectToolpathChunks(
        prepared.chunks,
        0,
        0,
        source.segmentCount,
        cameraGestureActive,
      )).toEqual([0]);
      expect(cache.prepare(source)).toBe(prepared);
      expect(cache.prepare(source).chunks[0]?.geometry).toBe(geometry);
    }
    expect(cache.buildCount).toBe(1);
    prepared.dispose();
  });

  it('maps legacy indexed palettes to the actual instance colors', () => {
    const source: ClientToolpath = {
      vertexCount: 2,
      positions: Float32Array.from([1, 0, 0, 2, 0, 0]),
      layers: Uint32Array.from([0, 0]),
      features: Uint32Array.from([0, 1]),
      palette: [
        { id: 100, name: 'first', color: [255, 0, 0] },
        { id: 101, name: 'second', color: [0, 255, 0] },
      ],
      segmentCount: 2,
      starts: Float32Array.from([0, 0, 0, 1, 0, 0]),
      ends: Float32Array.from([1, 0, 0, 2, 0, 0]),
      layerIds: Uint32Array.from([0, 0]),
      moveOrders: Uint32Array.from([0, 1]),
      gcodeIds: Uint32Array.from([1, 2]),
      moveTypes: Uint8Array.from([0, 0]),
      extrusionRoles: Uint16Array.from([0, 0]),
      extruderIds: Uint8Array.from([0, 0]),
      colorPrintIds: Uint8Array.from([0, 0]),
      widths: Float32Array.from([0.4, 0.5]),
      heights: Float32Array.from([0.2, 0.2]),
      metrics: {},
    };
    const prepared = new ToolpathBandCache().prepare(source);
    const colors = prepared.chunks[0]!.mesh.instanceColor!;
    expect(Array.from(colors.array.slice(0, 6))).toEqual([1, 0, 0, 0, 1, 0].map((value) => expect.closeTo(value, 5)));
    prepared.dispose();
  });

  it('uses the native travel colour and keeps travel independent from feature filters', () => {
    const source: ClientToolpath = {
      vertexCount: 2,
      positions: Float32Array.from([1, 0, 0, 2, 0, 0]),
      layers: Uint32Array.from([0, 0]),
      features: Uint32Array.from([0, 1]),
      palette: [
        { id: 0, name: 'perimeter', color: [255, 0, 0] },
        { id: 1, name: 'stale travel role', color: [0, 255, 0] },
      ],
      segmentCount: 2,
      starts: Float32Array.from([0, 0, 0, 1, 0, 0]),
      ends: Float32Array.from([1, 0, 0, 2, 0, 0]),
      layerIds: Uint32Array.from([0, 0]),
      moveOrders: Uint32Array.from([0, 1]),
      gcodeIds: Uint32Array.from([1, 2]),
      moveTypes: Uint8Array.from([10, 8]),
      extrusionRoles: Uint16Array.from([0, 1]),
      extruderIds: Uint8Array.from([0, 0]),
      colorPrintIds: Uint8Array.from([0, 0]),
      widths: Float32Array.from([0.4, 0.05]),
      heights: Float32Array.from([0.2, 0.05]),
      metrics: {},
    };
    const prepared = new ToolpathBandCache().prepare(source);
    const colors = prepared.chunks[0]!.mesh.instanceColor!;
    expect(Array.from(colors.array.slice(3, 6))).toEqual([56 / 255, 72 / 255, 155 / 255].map((value) => expect.closeTo(value, 5)));
    updateToolpathChunkVisibility([prepared.chunks[0]!], { visible: Uint8Array.from([1, 1]), dimmed: Uint8Array.from([0, 0]) });
    expect(Array.from(colors.array.slice(3, 6))).toEqual([56 / 255, 72 / 255, 155 / 255].map((value) => expect.closeTo(value, 5)));
    prepared.dispose();
  });

  it('updates range buffers in place without reconstructing geometry', () => {
    const range = { firstSegment: 0, segmentCount: 2, firstLayer: 0, lastLayer: 0 };
    const chunk = createToolpathBandChunk(
      Float32Array.from([0, 0, 0, 1, 0, 0]), Float32Array.from([1, 0, 0, 2, 0, 0]),
      Float32Array.from([0.4, 0.4]), Float32Array.from([0.2, 0.2]),
      Float32Array.from([1, 0, 0, 1, 0, 0]), range,
    );
    const mesh = chunk.mesh;
    updateToolpathChunkVisibility([chunk], {
      visible: Uint8Array.from([1, 0]), dimmed: Uint8Array.from([0, 1]),
    });
    expect(chunk.mesh).toBe(mesh);
    const hidden = new THREE.Matrix4().fromArray(Array.from(mesh.instanceMatrix.array).slice(16, 32));
    expect(new THREE.Vector3().setFromMatrixScale(hidden).length()).toBe(0);
    (mesh.material as THREE.Material).dispose();
    chunk.geometry.dispose();
  });

  it('partitions the exact performance fixture sizes in linear time', () => {
    for (const [segmentCount, layerSize] of [[250_000, 1_000], [1_000_000, 1_000]]) {
      const layerIds = new Uint32Array(segmentCount);
      for (let i = 0; i < segmentCount; i++) layerIds[i] = Math.floor(i / layerSize);
      const chunks = buildLayerAlignedChunkRanges(layerIds);
      expect(chunks.reduce((sum, chunk) => sum + chunk.segmentCount, 0)).toBe(segmentCount);
      expect(chunks[0]?.firstSegment).toBe(0);
      expect(chunks.at(-1)?.lastLayer).toBe(segmentCount / layerSize - 1);
    }
  });
});
