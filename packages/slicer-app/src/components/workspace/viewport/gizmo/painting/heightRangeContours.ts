import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';

export function heightRangePlanes(bounds: THREE.Box3, hitZ: number, height: number): readonly [number, number] {
  // Orca stores cursor_z, min/max Z and the height addition as floats. A ray
  // hit infinitesimally below a cap must become the end plane, not a hairline
  // interior section caused by JavaScript's double precision.
  const min = Math.fround(bounds.min.z), max = Math.fround(bounds.max.z);
  const lower = THREE.MathUtils.clamp(Math.fround(hitZ), min, max);
  return [lower, THREE.MathUtils.clamp(Math.fround(lower + Math.fround(height)), min, max)];
}

/** Visual sections only. Borrow the immutable original BVH, never the native
 * selector's subdivided draft. Transform the plane for BVH pruning and vertices
 * for intersections so world Z survives rotation, reflection and scale. */
export function heightRangeContours(meshes: readonly THREE.Mesh[], bounds: THREE.Box3, planes: readonly [number, number]): THREE.BufferGeometry {
  const positions: number[] = [];
  const epsilon = Math.max(1, bounds.getSize(new THREE.Vector3()).length()) * 1e-9;
  const vertex = new THREE.Vector3(), points = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (const z of new Set(planes)) {
    // Pinned Orca resets contours at either global end plane.
    if (!(z > Math.fround(bounds.min.z) && z < Math.fround(bounds.max.z))) continue;
    const segments = new Set<string>();
    const key = (p: THREE.Vector3) => `${Math.round(p.x / epsilon)},${Math.round(p.y / epsilon)}`;
    for (const mesh of meshes) {
      const tree = (mesh.geometry as THREE.BufferGeometry & { boundsTree: MeshBVH }).boundsTree;
      if (!tree) throw new Error('Height cursor requires the original model BVH');
      const localPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z).applyMatrix4(mesh.matrix.clone().invert());
      tree.shapecast({
        intersectsBounds: (box) => box.intersectsPlane(localPlane),
        intersectsTriangle: (triangle) => {
          points[0].copy(triangle.a).applyMatrix4(mesh.matrix);
          points[1].copy(triangle.b).applyMatrix4(mesh.matrix);
          points[2].copy(triangle.c).applyMatrix4(mesh.matrix);
          const distances = points.map((p) => Math.abs(p.z - z) <= epsilon ? 0 : p.z - z);
          // Pinned TriangleMeshSlicer::slice_facet owns a triangle's top
          // edge, not its bottom edge. Horizontal faces do not contribute.
          if (distances.every((d) => d >= 0)) return false;
          const intersections: THREE.Vector3[] = [];
          for (let i = 0; i < 3; i++) {
            const j = (i + 1) % 3, a = distances[i], b = distances[j];
            if (a === 0) vertex.copy(points[i]);
            else if (a * b < 0) vertex.copy(points[i]).lerp(points[j], a / (a - b));
            else continue;
            vertex.z = z;
            if (!intersections.some((p) => p.distanceToSquared(vertex) <= epsilon * epsilon)) intersections.push(vertex.clone());
          }
          if (intersections.length !== 2 || intersections[0].distanceToSquared(intersections[1]) <= epsilon * epsilon) return false;
          const keys = intersections.map(key).sort(), segment = keys.join('|');
          if (!segments.has(segment)) {
            segments.add(segment);
            positions.push(...intersections[0].toArray(), ...intersections[1].toArray());
          }
          return false;
        },
      });
    }
  }
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
}
