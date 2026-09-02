import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  isFinalToolpathEndpoint,
  TOOL_MARKER_GEOMETRY,
  TOOL_MARKER_MATERIAL,
  toolMarkerAnchor,
} from './ToolpathMarker';

const pathData = {
  segmentCount: 3,
  layerIds: new Uint32Array([0, 1, 1]),
  moveOrders: new Uint32Array([0, 0, 1]),
};

describe('Orca-style toolpath marker', () => {
  it('uses the native downward arrow dimensions and anchor offset', () => {
    const root = new THREE.Group();
    const tip = new THREE.Mesh(new THREE.ConeGeometry(
      TOOL_MARKER_GEOMETRY.tipRadius,
      TOOL_MARKER_GEOMETRY.tipHeight,
      TOOL_MARKER_GEOMETRY.radialSegments,
    ));
    tip.position.z = TOOL_MARKER_GEOMETRY.tipHeight / 2;
    tip.rotation.x = -Math.PI / 2;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(
      TOOL_MARKER_GEOMETRY.stemRadius,
      TOOL_MARKER_GEOMETRY.stemRadius,
      TOOL_MARKER_GEOMETRY.stemHeight,
      TOOL_MARKER_GEOMETRY.radialSegments,
    ));
    stem.position.z = TOOL_MARKER_GEOMETRY.tipHeight + TOOL_MARKER_GEOMETRY.stemHeight / 2;
    stem.rotation.x = -Math.PI / 2;
    root.add(tip, stem);
    root.updateMatrixWorld(true);

    const bounds = new THREE.Box3().setFromObject(root);
    expect(bounds.min.z).toBeCloseTo(0);
    expect(bounds.max.z).toBeCloseTo(TOOL_MARKER_GEOMETRY.tipHeight + TOOL_MARKER_GEOMETRY.stemHeight);
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(TOOL_MARKER_GEOMETRY.tipRadius * 2);
    expect(bounds.max.y - bounds.min.y).toBeCloseTo(TOOL_MARKER_GEOMETRY.tipRadius * 2);
    expect(toolMarkerAnchor([10, 20, 30])).toEqual([10, 20, 30.5]);
  });

  it('matches native transparent marker render state and lighting intent', () => {
    const material = new THREE.MeshPhongMaterial(TOOL_MARKER_MATERIAL);
    expect(material.color.getHex()).toBe(0xffffff);
    expect(material.transparent).toBe(true);
    expect(material.opacity).toBe(0.5);
    expect(material.blending).toBe(THREE.NormalBlending);
    expect(material.depthTest).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.side).toBe(THREE.DoubleSide);
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
