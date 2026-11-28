import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { BufferGeometry, Float32BufferAttribute, ShaderMaterial, Vector3 } from 'three';
import { useHistoryNavigationStore } from '@/stores/useHistoryNavigationStore';
import { usePlatform } from '@orca/platform-contract';
import type { CutSectionRequest, CutSectionResult } from '@slicer/client';
import type { GLVolume } from '../../GLVolume';
import { matrixFromTransform } from '../../transformDeltaMath';
import { CutSectionQueue } from './CutSectionQueue';
import { normalOf, quaternionOf, type CutPose, type CutTarget, type CutSession } from './CutSession';

const noRaycast = () => {};
function sectionLines(section: CutSectionResult) {
  if (!section.ok) return null;
  const positions: number[] = [];
  let offset = 0;
  for (const { count } of section.loops) {
    for (let index = 0; index < count; index++) {
      const a = 2 * (offset + index), b = 2 * (offset + (index + 1) % count);
      positions.push(section.xy[a], section.xy[a+1], 0, section.xy[b], section.xy[b+1], 0);
    }
    offset += count;
  }
  return new BufferGeometry().setAttribute('position', new Float32BufferAttribute(positions, 3));
}

export function CutPreview({ target, pose, revision, volumes, cut }: {
  cut: CutSession;
  target: CutTarget; pose: CutPose & Pick<CutSectionRequest, 'grouping'>; revision: number | null; volumes: GLVolume[];
}) {
  const { runtime } = usePlatform();
  const [reply, setReply] = useState<{ key: string; result: CutSectionResult } | null>(null);
  const queue = useMemo(() => new CutSectionQueue(r => runtime.getCutSection(r),
    (key, result) => setReply({ key, result })), [runtime]);
  const liveRevision = useHistoryNavigationStore(s => s.status?.revision);
  const stale = liveRevision !== undefined && revision !== liveRevision;
  const connectors = cut.connectors;
  const request: CutSectionRequest | null = useMemo(() => revision === null || stale ? null : ({
    revision, connectors, grouping: pose.grouping, center: pose.center, rotation: pose.rotation, objectId: target.objectId, instanceId: target.instanceId,
  }), [revision, stale, connectors, pose.grouping, pose.center, pose.rotation, target]);
  const key = target.signature + JSON.stringify(request);
  useLayoutEffect(() => {
    if (request) queue.request(request, key);
    return () => queue.clear();
  }, [request, key, queue]);
  useEffect(() => {
    if (connectors && request && reply?.key === key && reply.result.ok)
      cut.validateConnectors(request, connectors, reply.result.invalidConnectors);
  }, [cut, connectors, request, reply, key]);
  const section = useMemo(() => reply?.key === key ? sectionLines(reply.result) : null, [key, reply]);
  useEffect(() => () => section?.dispose(), [section]);
  const material = useMemo(() => new ShaderMaterial({
    uniforms: { center: { value: new Vector3() }, normal: { value: new Vector3() } },
    vertexShader: 'varying vec3 world; void main(){ vec4 p=modelMatrix*vec4(position,1.); world=p.xyz; gl_Position=projectionMatrix*viewMatrix*p; }',
    fragmentShader: 'varying vec3 world; uniform vec3 center; uniform vec3 normal; void main(){ gl_FragColor=vec4(dot(world-center, normal)>=0. ? vec3(.13,.62,.82) : vec3(.91,.45,.14),.60); }',
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  }), []);
  useLayoutEffect(() => {
    material.uniforms.center.value.fromArray(pose.center);
    material.uniforms.normal.value.copy(normalOf(pose));
  }, [pose, material]);
  useEffect(() => () => material.dispose(), [material]);
  return <>
    {volumes.map(v => <mesh key={v.buffer.volumeId} geometry={v.geometry} material={material} dispose={null}
      matrixAutoUpdate={false} matrix={matrixFromTransform(v.instanceTransform).multiply(matrixFromTransform(v.volumeTransform))}
      renderOrder={1} raycast={noRaycast}/>)}
    {section && <lineSegments position={pose.center} quaternion={quaternionOf(pose)} geometry={section} renderOrder={5} raycast={noRaycast}>
      <lineBasicMaterial color="#fff481" depthTest={false} depthWrite={false}/>
    </lineSegments>}
  </>;
}
