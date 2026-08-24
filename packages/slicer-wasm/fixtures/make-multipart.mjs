// Generates a two-disjoint-cube ASCII STL fixture (single volume, two shells)
// for the split-to-parts live check. Run: node fixtures/make-multipart.mjs
import { writeFile } from 'node:fs/promises';

const s = 20;
const cube = (ox) => {
  const v = [
    [ox, 0, 0], [ox + s, 0, 0], [ox + s, s, 0], [ox, s, 0],
    [ox, 0, s], [ox + s, 0, s], [ox + s, s, s], [ox, s, s],
  ];
  const faces = [
    [[0, 0, -1], [0, 3, 2, 1]],
    [[0, 0, 1], [4, 5, 6, 7]],
    [[0, -1, 0], [0, 1, 5, 4]],
    [[1, 0, 0], [1, 2, 6, 5]],
    [[0, 1, 0], [2, 3, 7, 6]],
    [[-1, 0, 0], [3, 0, 4, 7]],
  ];
  return { v, faces };
};

const a = cube(0);
const b = cube(40); // disjoint: [0,20] and [40,60] on X

let out = 'solid multipart\n';
const emit = (n, pa, pb, pc) => {
  out += `  facet normal ${n[0]} ${n[1]} ${n[2]}\n    outer loop\n`;
  for (const p of [pa, pb, pc]) out += `      vertex ${p[0]} ${p[1]} ${p[2]}\n`;
  out += '    endloop\n  endfacet\n';
};
for (const { v, faces } of [a, b]) {
  for (const [n, quad] of faces) {
    const [p, q, r, t] = quad.map((i) => v[i]);
    emit(n, p, q, r);
    emit(n, p, r, t);
  }
}
out += 'endsolid multipart\n';

await writeFile(new URL('./multipart.stl', import.meta.url), out);
console.log(`wrote multipart.stl (${out.length} bytes, 24 facets)`);
