import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SELECTION_BOX_BRACKET_FRACTION, selectionBoundsBoxPositions } from './selectionBoundsBoxGeometry';

function expectPoint(positions: Float32Array, index: number, point: [number, number, number]) {
  expect([positions[index], positions[index + 1], positions[index + 2]]).toEqual(point);
}

describe('selectionBoundsBoxPositions', () => {
  it('emits 24 inward bracket segments (48 vertices) per corner', () => {
    const bounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(20, 20, 20));
    const positions = selectionBoundsBoxPositions(bounds);
    expect(positions.length).toBe(48 * 3);
    expect(positions).toHaveLength(48 * 3);
    // First bracket: min corner along +X.
    expectPoint(positions, 0, [0, 0, 0]);
    expectPoint(positions, 3, [4, 0, 0]);
    // Second bracket: min corner along +Y.
    expectPoint(positions, 6, [0, 0, 0]);
    expectPoint(positions, 9, [0, 4, 0]);
    // Third bracket: min corner along +Z.
    expectPoint(positions, 12, [0, 0, 0]);
    expectPoint(positions, 15, [0, 0, 4]);
  });

  it('extends max corners inward by the same fraction', () => {
    const bounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(20, 20, 20));
    const positions = selectionBoundsBoxPositions(bounds);
    // The max corner (20,20,20) is the 7th corner (index 6), first segment
    // runs inward along -X, then -Y, then -Z.
    expectPoint(positions, 6 * 3 * 6, [20, 20, 20]);
    expectPoint(positions, 6 * 3 * 6 + 3, [16, 20, 20]);
    expectPoint(positions, 6 * 3 * 6 + 6, [20, 20, 20]);
    expectPoint(positions, 6 * 3 * 6 + 9, [20, 16, 20]);
    expectPoint(positions, 6 * 3 * 6 + 12, [20, 20, 20]);
    expectPoint(positions, 6 * 3 * 6 + 15, [20, 20, 16]);
  });

  it('spans an aggregate multi-selection union in one box', () => {
    // Two 20 mm cubes at X∈[0,20] and X∈[50,70] — the controller's
    // selectionBounds() union. Brackets scale with the union's size, so the
    // max-X bracket is 14 mm long (20% of 70).
    const bounds = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(70, 20, 20));
    const positions = selectionBoundsBoxPositions(bounds);
    expect(positions.length).toBe(48 * 3);
    // Max-X corner: (70,0,0), inward along -X.
    expectPoint(positions, 3 * 6, [70, 0, 0]);
    expectPoint(positions, 3 * 6 + 3, [70 - 70 * SELECTION_BOX_BRACKET_FRACTION, 0, 0]);
    // No vertex may fall outside the union bounds.
    for (let i = 0; i < positions.length; i += 3) {
      expect(positions[i]).toBeGreaterThanOrEqual(0);
      expect(positions[i]).toBeLessThanOrEqual(70);
      expect(positions[i + 1]).toBeGreaterThanOrEqual(0);
      expect(positions[i + 1]).toBeLessThanOrEqual(20);
      expect(positions[i + 2]).toBeGreaterThanOrEqual(0);
      expect(positions[i + 2]).toBeLessThanOrEqual(20);
    }
  });
});
