// Closed, indexed icosphere fixtures shared by native scale and real UI gates.
import assert from 'node:assert/strict';

export function meshBooleanSphereFixture(level, radius = 20) {
  const t = (1 + Math.sqrt(5)) / 2;
  let points = [[-1,t,0],[1,t,0],[-1,-t,0],[1,-t,0],[0,-1,t],[0,1,t],[0,-1,-t],[0,1,-t],[t,0,-1],[t,0,1],[-t,0,-1],[-t,0,1]];
  const normalize = p => { const length = Math.hypot(...p); return p.map(v => v * radius / length); };
  points = points.map(normalize);
  let faces = [[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],
    [3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
  for (let iteration = 0; iteration < level; iteration++) {
    const edges = new Map();
    const midpoint = (a, b) => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      let index = edges.get(key);
      if (index === undefined) {
        index = points.length;
        points.push(normalize(points[a].map((v, axis) => (v + points[b][axis]) / 2)));
        edges.set(key, index);
      }
      return index;
    };
    faces = faces.flatMap(([a,b,c]) => {
      const ab = midpoint(a,b), bc = midpoint(b,c), ca = midpoint(c,a);
      return [[a,ab,ca],[b,bc,ab],[c,ca,bc],[ab,bc,ca]];
    });
  }
  assert.equal(faces.length, 20 * 4 ** level);
  assert.equal(points.length, 10 * 4 ** level + 2);
  const bytes = new Uint8Array(84 + 50 * faces.length), view = new DataView(bytes.buffer);
  view.setUint32(80, faces.length, true);
  faces.forEach((face, triangle) => face.forEach((vertex, corner) => points[vertex].forEach((v, axis) =>
    view.setFloat32(84 + triangle * 50 + 12 + corner * 12 + axis * 4, v, true))));
  return { bytes, triangles: faces.length };
}
