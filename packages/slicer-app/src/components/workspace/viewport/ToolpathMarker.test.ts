import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  isFinalToolpathEndpoint,
  TOOL_MARKER_MATERIAL,
  toolMarkerModelTransform,
} from './ToolpathMarker';

const pathData = {
  segmentCount: 3,
  layerIds: new Uint32Array([0, 1, 1]),
  moveOrders: new Uint32Array([0, 0, 1]),
};

describe('Orca-style toolpath marker', () => {
  it('uses Orca Marker::render transform so the STL top ends at the move', () => {
    const bounds = new THREE.Box3(new THREE.Vector3(-1.7, -1.75, 0), new THREE.Vector3(1.8, 1.75, 12));
    expect(toolMarkerModelTransform([10, 20, 30], bounds)).toEqual({
      position: [10, 20, 42.5],
      rotation: [Math.PI, 0, 0],
      scale: [1, 1, 1],
    });
  });

  it('matches native transparent marker render state and lighting intent', () => {
    const material = new THREE.MeshPhongMaterial(TOOL_MARKER_MATERIAL);
    expect(material.color.getHex()).toBe(0xffffff);
    expect(material.transparent).toBe(true);
    expect(material.opacity).toBe(0.5);
    expect(material.blending).toBe(THREE.NormalBlending);
    expect(material.depthTest).toBe(true);
    expect(material.depthWrite).toBe(true);
    expect(material.side).toBe(THREE.FrontSide);
    expect(material.shininess).toBe(20);
    material.dispose();
  });

  it('hides only at the final enabled layer and move', () => {
    expect(isFinalToolpathEndpoint(pathData, 0, 0)).toBe(false);
    expect(isFinalToolpathEndpoint(pathData, 1, 0)).toBe(false);
    expect(isFinalToolpathEndpoint(pathData, 1, 1)).toBe(true);
    expect(isFinalToolpathEndpoint(pathData, 1, Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});
