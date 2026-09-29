import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { usePlatform } from '@orca/platform-contract';
import { registerOrcaE2eOwner } from './registerOrcaE2e';
import type { PaintingController } from '../components/workspace/viewport/gizmo/painting/PaintingController';
import type { PaintingResources } from '../components/workspace/viewport/gizmo/painting/PaintingResources';
import type { LoadedObject } from '../components/workspace/viewport/useModelLoader';
import { useSceneInteraction } from '../components/workspace/viewport/SceneInteractionContext';

/** Read-only observability for the real host journey; no alternate painting API. */
export function PaintingProbe({ owner, resources, volumes, cursor }: { owner: PaintingController; resources: PaintingResources; volumes: readonly LoadedObject[]; cursor: THREE.Vector3 | null }) {
  const { camera, gl, scene, controls } = useThree();
  const { runtime } = usePlatform();
  const interaction = useSceneInteraction();
  const rendered = useRef<{ revision: number; candidates: string[] }>({ revision: -1, candidates: [] });
  useFrame(() => { rendered.current = { revision: owner.getSnapshot().display?.revision ?? -1, candidates: owner.getSnapshot().display?.candidates.map((c) => c.resourceId).filter((id) => resources.resources.has(id)) ?? [] }; });
  useEffect(() => registerOrcaE2eOwner('painting', {
    paintingEvidence: () => {
      const state = owner.getSnapshot(), rect = gl.domElement.getBoundingClientRect();
      const source = volumes.find((v) => v.buffer.objectId === state.session?.objectId && v.buffer.instanceId === state.session.instanceId);
      const center = source?.getWorldBounds().getCenter(new THREE.Vector3()).project(camera);
      let ordinaryModels = 0; scene.traverse((o) => { if (o.userData.orcaVolume) ordinaryModels++; });
      return { phase: state.phase, tool: state.tool, sessionId: state.session?.id, settings: state.settings, selection: [...interaction.selection.ids],
        camera: [...camera.position.toArray(), ...camera.quaternion.toArray()], target: (controls as unknown as { target?: THREE.Vector3 } | null)?.target?.toArray() ?? [0, 0, 0], cursor: cursor?.toArray() ?? null,
        center: center ? { x: rect.left + (center.x + 1) * rect.width / 2, y: rect.top + (1 - center.y) * rect.height / 2 } : null,
        resources: [...resources.resources.values()].map((r) => ({ id: r.source.resourceId, volumeId: r.source.volumeId, kind: r.source.kind, groups: r.source.groups, hasBvh: !!(r.geometry as THREE.BufferGeometry & { boundsTree?: unknown }).boundsTree })), ordinaryModels,
        rendered: rendered.current, runtime: runtime.getRuntimeExecutionState?.(), error: state.error };
    },
    paintingCommittedEvidence: async () => {
      let evidence: unknown = null;
      await owner.betweenStrokes(async () => {
        const mesh = await runtime.getModelMesh();
        evidence = { objects: mesh.objects.map((o) => ({ objectId: o.objectId, instanceId: o.instanceId, paintGeometryKey: o.paintGeometryKey })), paint: mesh.paintGeometries?.map((g) => ({ volumeId: g.volumeId, groups: g.drawGroups })) };
        return true;
      });
      return evidence;
    },
  }), [camera, controls, cursor, gl, owner, resources, runtime, scene, volumes, interaction]);
  return null;
}
