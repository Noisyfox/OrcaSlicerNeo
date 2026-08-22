import { describe, expect, it } from 'vitest';
import { CUBE_SIZE_MM, createCubeStl } from './cubeStl';

interface Triangle {
  normal: [number, number, number];
  vertices: [[number, number, number], [number, number, number], [number, number, number]];
}

function parseStl(bytes: Uint8Array): { header: string; triangles: Triangle[] } {
  expect(bytes.length).toBe(80 + 4 + 12 * 50);
  const view = new DataView(bytes.buffer);
  const header = new TextDecoder().decode(bytes.subarray(0, 80)).replace(/\0+$/, '');
  const count = view.getUint32(80, true);
  const triangles: Triangle[] = [];
  for (let i = 0; i < count; i++) {
    const base = 84 + i * 50;
    const read = (o: number) => view.getFloat32(base + o, true);
    triangles.push({
      normal: [read(0), read(4), read(8)],
      vertices: [
        [read(12), read(16), read(20)],
        [read(24), read(28), read(32)],
        [read(36), read(40), read(44)],
      ],
    });
    expect(view.getUint16(base + 48, true)).toBe(0); // attribute byte count
  }
  return { header, triangles };
}

describe('createCubeStl', () => {
  it('produces a 12-triangle binary STL with a readable header', () => {
    const stl = createCubeStl();
    const { header, triangles } = parseStl(stl);
    expect(header).toContain('cube');
    expect(triangles).toHaveLength(12);
  });

  it('spans 20 mm, centered on X/Y and resting on Z=0', () => {
    const { triangles } = parseStl(createCubeStl());
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const t of triangles) {
      for (const [x, y, z] of t.vertices) {
        min[0] = Math.min(min[0], x);
        min[1] = Math.min(min[1], y);
        min[2] = Math.min(min[2], z);
        max[0] = Math.max(max[0], x);
        max[1] = Math.max(max[1], y);
        max[2] = Math.max(max[2], z);
      }
    }
    expect(min).toEqual([-CUBE_SIZE_MM / 2, -CUBE_SIZE_MM / 2, 0]);
    expect(max).toEqual([CUBE_SIZE_MM / 2, CUBE_SIZE_MM / 2, CUBE_SIZE_MM]);
  });

  it('is watertight: every cube edge is shared by exactly two triangles', () => {
    const { triangles } = parseStl(createCubeStl());
    const edgeCounts = new Map<string, number>();
    for (const { vertices } of triangles) {
      for (let i = 0; i < 3; i++) {
        const a = vertices[i];
        const b = vertices[(i + 1) % 3];
        const key = [
          [a[0], a[1], a[2]].join(','),
          [b[0], b[1], b[2]].join(','),
        ].sort().join('|');
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
    }
    expect(edgeCounts.size).toBe(18); // 6 faces × 4 edges / 2 shared
    for (const count of edgeCounts.values()) expect(count).toBe(2);
  });

  it('winds outward: positive signed volume equal to the 20 mm³ box', () => {
    const { triangles } = parseStl(createCubeStl());
    const dot = (a: [number, number, number], b: [number, number, number]) =>
      a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = (a: [number, number, number], b: [number, number, number]) =>
      [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] as [number, number, number];
    let volume = 0;
    for (const { vertices: [a, b, c] } of triangles) volume += dot(a, cross(b, c));
    expect(volume / 6).toBeCloseTo(CUBE_SIZE_MM ** 3, 6);
  });
});
