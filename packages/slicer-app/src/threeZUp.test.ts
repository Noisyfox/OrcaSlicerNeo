import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import './threeZUp';

describe('threeZUp', () => {
  it('sets the global Object3D up vector to Z', () => {
    expect(THREE.Object3D.DEFAULT_UP.toArray()).toEqual([0, 0, 1]);
  });
});
