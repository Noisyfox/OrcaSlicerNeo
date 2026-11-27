import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { LayerHeightFrame } from '@slicer/client';
import { useLayerHeight } from './state';

// All instances and printable parts of an object sample the same native atlas.
const atlas = new WeakMap<LayerHeightFrame, THREE.DataTexture>();
function texture(frame: LayerHeightFrame) {
  let result = atlas.get(frame);
  if (!result) {
    result = new THREE.DataTexture(frame.pixels, frame.width, frame.height);
    result.magFilter = result.minFilter = THREE.LinearFilter;
    result.needsUpdate = true;
    atlas.set(frame, result);
  }
  return result;
}

export function releaseLayerTexture(frame: LayerHeightFrame | null) {
  if (frame) { atlas.get(frame)?.dispose(); atlas.delete(frame); }
}

export function LayerMaterial({ frame }: { frame: LayerHeightFrame }) {
  const invalidate = useThree(s => s.invalidate);
  const uniforms = useMemo(() => ({
    bands: { value: texture(frame) }, size: { value: new THREE.Vector2(frame.width, frame.height) },
    cells: { value: frame.cells }, height: { value: frame.profile.objectHeight },
    cursor: { value: -100 }, width: { value: 2 },
  }), [frame]);
  useEffect(() => {
    const update = () => {
      uniforms.cursor.value = useLayerHeight.getState().cursor ?? -100;
      uniforms.width.value = useLayerHeight.getState().width;
      invalidate();
    };
    update();
    return useLayerHeight.subscribe(update);
  }, [uniforms, invalidate]);
  return <shaderMaterial uniforms={uniforms}
    vertexShader={`varying float z;
      varying float light;
      void main() {
        z = (modelMatrix * vec4(position, 1.)).z;
        light = .62 + .38 * abs(normalize(normalMatrix * normal).z);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
      }`}
    fragmentShader={`uniform sampler2D bands;
      uniform vec2 size;
      uniform float cells, height, cursor, width;
      varying float z;
      varying float light;
      void main() {
        float cell = clamp(z / height, 0., 1.) * (cells - 1.);
        vec2 uv = (vec2(mod(cell, size.x - 1.), floor(cell / (size.x - 1.))) + .5) / size;
        vec3 rgb = texture2D(bands, uv).rgb * light;
        float brush = .25 * (1. + cos(min(3.14159, abs(3.14159 * (z - cursor) * 1.8 / width))));
        gl_FragColor = vec4(mix(rgb, vec3(1.), brush), 1.);
      }`} />;
}
