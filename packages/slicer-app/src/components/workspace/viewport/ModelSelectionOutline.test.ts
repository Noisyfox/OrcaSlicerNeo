import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildModelOutlineGeometry, modelOutlineColour } from './ModelSelectionOutline';

describe('Orca selection outline contrast', () => {
  it('expands each triangle uniformly without changing shared source normals', () => {
    // Two perpendicular triangles share a corner; the old outline reused
    // averaged normals and distorted the planar triangle at that corner.
    const source = new THREE.BufferGeometry();
    source.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10,
    ], 3));
    source.setIndex([0, 1, 2, 0, 3, 1]);
    source.computeVertexNormals();
    const originalNormals = source.getAttribute('normal').array.slice();
    const outline = buildModelOutlineGeometry(source);
    expect(outline.index).toBeNull();
    const normals = outline.getAttribute('normal');
    expect([...normals.array]).toEqual([
      0, 0, 1, 0, 0, 1, 0, 0, 1,
      0, 1, 0, 0, 1, 0, 0, 1, 0,
    ]);
    expect(source.getAttribute('normal').array).toEqual(originalNormals);
    expect(source.index?.count).toBe(6);
    outline.dispose(); source.dispose();
  });
  it('uses pale outlines for dark fills and blue-grey outlines for bright fills', () => {
    expect(modelOutlineColour('#008577')).toBe('#fcfcfc');
    expect(modelOutlineColour('#000000')).toBe('#fcfcfc');
    expect(modelOutlineColour('#ffffff')).toBe('#1c2a35');
    expect(modelOutlineColour('#ffff00')).toBe('#1c2a35');
  });
  it('uses the Orca 0.75 brightness threshold without treating red as a bright fill', () => {
    expect(modelOutlineColour('#bfbfbf')).toBe('#fcfcfc');
    expect(modelOutlineColour('#c0c0c0')).toBe('#1c2a35');
    expect(modelOutlineColour('#ff0000')).toBe('#fcfcfc');
  });
});
