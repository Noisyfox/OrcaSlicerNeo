import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  buildLayerAlignedChunkRanges,
  createToolpathBandChunk,
  selectToolpathChunks,
} from './toolpathBandGeometry';

describe('toolpath band geometry', () => {
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

  it('uses per-segment width and height attributes and remains instanced', () => {
    const range = { firstSegment: 0, segmentCount: 2, firstLayer: 4, lastLayer: 4 };
    const chunk = createToolpathBandChunk(
      Float32Array.from([0, 0, 1, 1, 0, 1]),
      Float32Array.from([1, 0, 1, 2, 0, 1]),
      Float32Array.from([0.42, 0.68]),
      Float32Array.from([0.2, 0.32]),
      Float32Array.from([1, 0, 0, 0, 1, 0]),
      range,
    );
    expect(chunk.geometry).toBeInstanceOf(THREE.InstancedBufferGeometry);
    expect(chunk.geometry.instanceCount).toBe(2);
    const widths = chunk.geometry.getAttribute('instanceWidth').array as Float32Array;
    const heights = chunk.geometry.getAttribute('instanceHeight').array as Float32Array;
    expect(widths[0]).toBeCloseTo(0.42);
    expect(widths[1]).toBeCloseTo(0.68);
    expect(heights[0]).toBeCloseTo(0.2);
    expect(heights[1]).toBeCloseTo(0.32);
    expect(chunk.geometry.getAttribute('instanceStart').count).toBe(2);
    expect(chunk.geometry.getAttribute('instanceEnd').count).toBe(2);
    chunk.geometry.dispose();
  });

  it('preserves the active interval while reducing only nearby layers for large gestures', () => {
    const chunks = [0, 1, 2, 3, 4, 5].map((layer) => ({
      firstSegment: layer * 10,
      segmentCount: 10,
      firstLayer: layer,
      lastLayer: layer,
    }));
    expect(selectToolpathChunks(chunks, 3, 3, 1_000_000, true)).toEqual([2, 3, 4]);
    expect(selectToolpathChunks(chunks, 3, 3, 1_000_000, false)).toEqual([3]);
    expect(selectToolpathChunks(chunks, 2, 3, 1_000_000, true)).toEqual([1, 2, 3, 4]);
    expect(selectToolpathChunks(chunks, 3, 3, 250_000, true)).toEqual([3]);
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
