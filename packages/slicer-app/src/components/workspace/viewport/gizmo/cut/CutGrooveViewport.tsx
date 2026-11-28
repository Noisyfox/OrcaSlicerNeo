import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { usePlatform } from '@orca/platform-contract';
import type { CutGroove, CutPiecesResult, CutSectionRequest } from '@slicer/client';
import { buildPieceMeshes } from './CutPieceViewport';
import { CutSectionQueue } from './CutSectionQueue';
import { grooveSpacing } from './CutGroovePanel';
import { normalOf, quaternionOf, type CutSession } from './CutSession';
import { useHistoryNavigationStore } from '@/stores/useHistoryNavigationStore';

function guide(g: CutGroove, radius: number) {
  const segment: number[] = [];
  const slope = Math.tan(g.angle*Math.PI/180), span = radius*1.125;
  const spacing = grooveSpacing(g,radius);
  for (let i=0; i<Math.min(100,g.count); ++i) for (const side of [-1,1]) for (const level of [-1,1]) {
    const width = level > 0 ? g.width : g.width + 2*g.depth/Math.tan(g.flankAngle*Math.PI/180);
    const x = (i - (g.count-1)/2)*spacing + side*width/2;
    const endY = slope > 0 ? Math.min(span,width/(2*slope)) : span;
    segment.push(x+side*span*slope,-span,level*g.depth/2, x-side*endY*slope,endY,level*g.depth/2);
  }
  return new BufferGeometry().setAttribute('position',new Float32BufferAttribute(segment.every(Number.isFinite) ? segment : [],3));
}

export function CutGrooveViewport({ cut }: { cut: CutSession }) {
  const { runtime } = usePlatform();
  const target = cut.target!, pose = cut.draft!, groove = pose.groove!, revision = cut.revision;
  const historyRevision = useHistoryNavigationStore(s => s.status?.revision);
  const key = historyRevision !== undefined && historyRevision !== revision ? '' : cut.grooveKey;
  const [reply,setReply] = useState<{ key: string; result: CutPiecesResult } | null>(null);
  const queue = useMemo(() => new CutSectionQueue<Extract<CutPiecesResult,{ok:true}>>(q => runtime.getCutPieces(q),
    (k,result) => { setReply({ key:k, result }); cut.setGrooveReply(k, result.ok ? undefined : result.error); }), [cut,runtime]);
  const request = useMemo((): CutSectionRequest | null => key && revision !== null ? {
    objectId:target.objectId, instanceId:target.instanceId, center:pose.center, rotation:pose.rotation, revision, groove,
  } : null, [key,revision,target,pose.center,pose.rotation,groove]);
  useLayoutEffect(() => {
    if (historyRevision !== undefined && historyRevision !== revision && cut.grooveKey)
      cut.setGrooveReply(cut.grooveKey, 'Model changed. Reopen Cut to preview the current geometry.');
    else if (request) queue.request(request,key);
    return () => queue.clear();
  }, [request,key,queue,cut,historyRevision,revision]);
  const meshes = useMemo(() => reply?.key === key && reply.result.ok ? buildPieceMeshes(reply.result, false) : [], [reply,key]);
  useEffect(() => () => meshes.forEach(m => { m.geometry.dispose(); m.material.dispose(); }), [meshes]);
  const lines = useMemo(() => guide(groove,target.solidRadius),[groove,target.solidRadius]);
  useEffect(() => () => lines.dispose(), [lines]);
  const normal = normalOf(pose);
  return <>
    <lineSegments position={pose.center} quaternion={quaternionOf(pose)} geometry={lines} renderOrder={7} raycast={() => {}}>
      <lineBasicMaterial color={cut.groovePreview?.error ? '#f65040' : '#ffe070'} depthTest={false}/>
    </lineSegments>
    {meshes.map(mesh => {
      const upper = mesh.userData.piece.upper;
      mesh.material.color.set(upper ? '#28a5d5' : '#e98536');
      mesh.position.copy(normal).multiplyScalar((upper ? 1 : -1) * groove.depth);
      return <primitive key={mesh.uuid} object={mesh}/>;
    })}
  </>;
}
