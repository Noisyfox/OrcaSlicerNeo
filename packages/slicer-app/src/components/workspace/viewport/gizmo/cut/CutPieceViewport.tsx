import { useEffect, useMemo, useRef, useState } from 'react';
import { BufferGeometry, BufferAttribute, DoubleSide, Mesh, MeshBasicMaterial, Raycaster } from 'three';
import { acceleratedRaycast } from 'three-mesh-bvh';
import { usePlatform } from '@orca/platform-contract';
import type { CutPiecesResult } from '@slicer/client';
import { attachBoundsTree, disposeBVHGeometry } from '../../GLVolume';
import { normalOf, type CutSession } from './CutSession';

function buildPieceMeshes(result: Extract<CutPiecesResult, { ok: true }>) {
  let offset = 0;
  return result.pieces.map(piece => {
    const end = offset + 9 * piece.triangles;
    const coordinates = result.positions.subarray(offset, end);
    offset = end;
    const geometry = attachBoundsTree(new BufferGeometry().setAttribute('position', new BufferAttribute(coordinates, 3)));
    const material = new MeshBasicMaterial({ side: DoubleSide, transparent: true, opacity: 0.85, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const mesh = new Mesh(geometry, material);
    mesh.raycast = acceleratedRaycast;
    mesh.userData.piece = piece;
    mesh.renderOrder = 2;
    return mesh;
  });
}

export function CutPieceViewport({ cut }: { cut: CutSession }) {
  const { runtime } = usePlatform();
  const target = cut.target!, draft = cut.draft!, revision = cut.revision;
  const group = draft.grouping;
  const center = group?.center ?? draft.center, rotation = group?.rotation ?? draft.rotation;
  const source = useMemo(() => ({ center, rotation, objectId: target.objectId, instanceId: target.instanceId }),
    [center, rotation, target]);
  const [meshes, setMeshes] = useState<ReturnType<typeof buildPieceMeshes>>([]);
  const loader = useRef<(() => Promise<ReturnType<typeof buildPieceMeshes>>) | null>(null);
  const assigned = !!group;
  useEffect(() => {
    let active = true, owned: ReturnType<typeof buildPieceMeshes> = [];
    let pending: Promise<typeof owned> | undefined;
    setMeshes([]);
    const load = () => {
      if (revision === null) return Promise.resolve([]);
      pending ??= runtime.getCutPieces({ ...source, revision }).then(result => {
        if (!active || !result.ok) return [];
        owned = buildPieceMeshes(result);
        setMeshes(owned);
        return owned;
      }).catch(() => []);
      return pending;
    };
    loader.current = load;
    cut.pickPiece = ray => {
      if (cut.draft?.asParts || cut.busy) return;
      void load().then(parts => {
        if (!active) return;
        const picker = new Raycaster(ray.origin, ray.direction);
        picker.firstHitOnly = true;
        const hit = picker.intersectObjects(parts, false)[0];
        if (hit) cut.togglePiece(source, hit.object.userData.piece.id);
      });
    };
    return () => {
      active = false; cut.pickPiece = null; loader.current = null;
      if (pending) void runtime.releaseCutPieces().catch(() => {});
      for (const mesh of owned) { disposeBVHGeometry(mesh.geometry); mesh.material.dispose(); }
    };
  }, [source, runtime, revision, cut]);
  useEffect(() => { if (assigned) void loader.current?.(); }, [assigned, source, revision]);
  if (!group) return null;
  const flipped = normalOf(draft).dot(normalOf(group)) < 0;
  return <>{meshes.map(mesh => {
    const { id, upper } = mesh.userData.piece;
    mesh.material.color.set(((upper !== flipped) !== group.toggled.includes(id)) ? '#28a5d5' : '#e98536');
    return <primitive key={mesh.uuid} object={mesh}/>;
  })}</>;
}
