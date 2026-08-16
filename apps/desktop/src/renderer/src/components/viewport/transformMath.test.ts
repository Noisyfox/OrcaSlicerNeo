// apps/desktop/src/renderer/src/components/viewport/transformMath.test.ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  computeObjectMinZ,
  buildTransformSeeds,
  computeDropZ,
  parseNumberInput,
  formatPosition,
} from './transformMath';
import type { Vec3 } from '../../lib/vec3';

describe('computeObjectMinZ', () => {
  it('returns the local bounding-box min Z', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([0, 0, 0, 10, 0, 0, 0, 0, -5, 5, 5, 20]),
      3,
    ));
    expect(computeObjectMinZ(g)).toBe(-5);
  });
});

describe('buildTransformSeeds', () => {
  it('seeds positions and initialPositions from the load-time offsets', () => {
    const seeds = buildTransformSeeds([
      { objectIdx: 0, offset: [1, 2, 3] as Vec3, minZ: 0 },
      { objectIdx: 1, offset: [4, 5, 6] as Vec3, minZ: -2 },
    ]);
    expect(seeds.positions).toEqual({ 0: [1, 2, 3], 1: [4, 5, 6] });
    expect(seeds.initialPositions).toEqual({ 0: [1, 2, 3], 1: [4, 5, 6] });
    expect(seeds.objectMinZ).toEqual({ 0: 0, 1: -2 });
  });
});

describe('computeDropZ', () => {
  it('returns the z that rests the object on the bed', () => {
    expect(computeDropZ(-2)).toBe(2);
    expect(computeDropZ(0)).toBe(0);
    expect(computeDropZ(5)).toBe(-5);
  });
});

describe('parseNumberInput', () => {
  it('parses finite decimals and rejects garbage', () => {
    expect(parseNumberInput('12.5')).toBe(12.5);
    expect(parseNumberInput('-3')).toBe(-3);
    expect(parseNumberInput('')).toBeNull();
    expect(parseNumberInput('abc')).toBeNull();
    expect(parseNumberInput('1.2.3')).toBeNull();
    expect(parseNumberInput('Infinity')).toBeNull();
  });
});

describe('formatPosition', () => {
  it('formats to 3 decimals', () => {
    expect(formatPosition(12.3456)).toBe('12.346');
    expect(formatPosition(0)).toBe('0.000');
  });
});
