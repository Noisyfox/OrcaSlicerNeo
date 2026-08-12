// Generates a 20mm ASCII STL cube fixture for the slice spike.
// Run: node fixtures/make-cube.mjs
import { writeFile } from 'node:fs/promises';

const s = 20;
const v = [
  [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], // bottom (z=0)
  [0, 0, s], [s, 0, s], [s, s, s], [0, s, s], // top (z=s)
];
// Each face: outward normal + 4 corner indices wound counter-clockwise.
const faces = [
  [[0, 0, -1], [0, 3, 2, 1]],
  [[0, 0, 1], [4, 5, 6, 7]],
  [[0, -1, 0], [0, 1, 5, 4]],
  [[1, 0, 0], [1, 2, 6, 5]],
  [[0, 1, 0], [2, 3, 7, 6]],
  [[-1, 0, 0], [3, 0, 4, 7]],
];

let out = 'solid cube\n';
const emit = (n, a, b, c) => {
  out += `  facet normal ${n[0]} ${n[1]} ${n[2]}\n    outer loop\n`;
  for (const p of [a, b, c]) out += `      vertex ${p[0]} ${p[1]} ${p[2]}\n`;
  out += '    endloop\n  endfacet\n';
};
for (const [n, quad] of faces) {
  const [a, b, c, d] = quad.map((i) => v[i]);
  emit(n, a, b, c);
  emit(n, a, c, d);
}
out += 'endsolid cube\n';

await writeFile(new URL('./cube.stl', import.meta.url), out);
console.log(`wrote cube.stl (${out.length} bytes, 12 facets)`);
