import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { usePlatform } from '@orca/platform-contract';
import { registerOrcaE2eOwner } from './registerOrcaE2e';
import type { PaintingController } from '../components/workspace/viewport/gizmo/painting/PaintingController';
import type { PaintingResources } from '../components/workspace/viewport/gizmo/painting/PaintingResources';
import type { LoadedObject } from '../components/workspace/viewport/useModelLoader';
import { useSceneInteraction } from '../components/workspace/viewport/SceneInteractionContext';

export function paintingUploadBytes(method: 'bufferData' | 'bufferSubData', args: unknown[]): number {
  const payload = args[method === 'bufferData' ? 1 : 2];
  if (typeof payload === 'number') return method === 'bufferData' ? payload : 0;
  if (!ArrayBuffer.isView(payload)) return 0;
  const elementBytes = 'BYTES_PER_ELEMENT' in payload && typeof payload.BYTES_PER_ELEMENT === 'number'
    ? payload.BYTES_PER_ELEMENT : 1;
  const sourceOffset = typeof args[3] === 'number' ? args[3] : 0;
  const length = args[4];
  return typeof length === 'number' ? length * elementBytes : Math.max(0, payload.byteLength - sourceOffset * elementBytes);
}

/** Persistent across the Prepare/painting handoff. Count model draw callbacks
 * from the actual renderer, including every forced frame during async reads.
 * A manifest/cache count cannot detect an empty React scene between commits. */
export function PaintingVisualProbe() {
  const { gl, invalidate, scene: mainScene } = useThree();
  useEffect(() => {
    type Frame = { at: number; ordinary: string[]; painting: string[]; colors: string[] };
    let capture: { objectId: number; instanceId: number; frames: Frame[] } | null = null;
    let raf: number | null = null;
    const originalRender = gl.render;
    gl.render = function (scene, camera) {
      // GizmoHelper renders a separate overlay scene through this renderer.
      // Only the persistent model scene is a viewport model frame.
      if (!capture || scene !== mainScene) return originalRender.call(gl, scene, camera);
      const frame: Frame = { at: performance.now(), ordinary: [], painting: [], colors: [] };
      const restore: Array<() => void> = [];
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        let volume: LoadedObject | undefined;
        for (let ancestor: THREE.Object3D | null = object; ancestor; ancestor = ancestor.parent) {
          if (ancestor.userData.orcaVolume) { volume = ancestor.userData.orcaVolume; break; }
        }
        const kind = object.name === `painting-model-${capture!.objectId}-${capture!.instanceId}` ? 'painting'
          : volume?.buffer.objectId === capture!.objectId && volume.buffer.instanceId === capture!.instanceId ? 'ordinary' : null;
        if (!kind) return;
        const original = object.onBeforeRender;
        object.onBeforeRender = function (...args) {
          original.apply(this, args);
          frame[kind].push(object.geometry.uuid);
          const material = args[4] as THREE.MeshStandardMaterial;
          frame.colors.push(material.color?.getHexString() ?? '');
        };
        restore.push(() => { object.onBeforeRender = original; });
      });
      try { originalRender.call(gl, scene, camera); }
      finally {
        restore.forEach((callback) => callback());
        frame.ordinary = [...new Set(frame.ordinary)]; frame.painting = [...new Set(frame.painting)];
        capture.frames.push(frame);
      }
    };
    const stop = () => { if (raf !== null) cancelAnimationFrame(raf); raf = null; const frames = capture?.frames ?? []; capture = null; return frames; };
    const unregister = registerOrcaE2eOwner('painting-visual', {
      paintingVisualStart: (objectId: number, instanceId: number) => {
        stop(); capture = { objectId, instanceId, frames: [] };
        const frame = () => { invalidate(); raf = requestAnimationFrame(frame); };
        frame();
      },
      paintingVisualStop: stop,
      paintingVisualFrames: () => capture?.frames ?? [],
    });
    return () => { stop(); unregister(); gl.render = originalRender; };
  }, [gl, invalidate, mainScene]);
  return null;
}

/** Read-only observability for the real host journey; no alternate painting API. */
export function PaintingProbe({ owner, resources, volumes, cursor, pivot }: { owner: PaintingController; resources: PaintingResources; volumes: readonly LoadedObject[]; cursor: THREE.Vector3 | null; pivot: THREE.Vector3 | null }) {
  const { camera, gl, scene, controls } = useThree();
  const { runtime } = usePlatform();
  const interaction = useSceneInteraction();
  const rendered = useRef<{ revision: number; candidates: string[] }>({ revision: -1, candidates: [] });
  const input = useRef({ admittedMoves: 0, droppedMoves: 0 });
  const perf = useRef<{ calls: Array<{ name: string; ms: number; at: number; revision?: number; native?: unknown; resourceBytes?: number; committed?: boolean; effective?: boolean; changedPartIds?: number[]; hit?: unknown; pointer?: readonly number[]; tool?: string }>;
    frames: Array<{ at: number; revision: number; candidates: number }>; phases: Array<{ at: number; phase: string; revision: number }>;
    inputs: Array<{ at: number; kind: string }>; glUploads: Array<{ at: number; method: string; ms: number; bytes: number }>;
    resources: Array<{ at: number; ms: number; created: number; released: number; live: number; bytes: number }>;
    peakJsHeapBytes: number; totalCreated: number; totalReleased: number }>({
      calls: [], frames: [], phases: [], inputs: [], glUploads: [], resources: [], peakJsHeapBytes: 0, totalCreated: 0, totalReleased: 0,
    });
  useFrame(() => {
    const revision = owner.getSnapshot().display?.revision ?? -1;
    rendered.current = { revision, candidates: owner.getSnapshot().display?.candidates.map((c) => c.resourceId).filter((id) => resources.resources.has(id)) ?? [] };
    perf.current.frames.push({ at: performance.now(), revision, candidates: rendered.current.candidates.length });
    const jsMemory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    perf.current.peakJsHeapBytes = Math.max(perf.current.peakJsHeapBytes, jsMemory?.usedJSHeapSize ?? 0);
  });
  useEffect(() => {
    const unsubscribe = owner.subscribe(() => {
      const snapshot = owner.getSnapshot();
      perf.current.phases.push({ at: performance.now(), phase: snapshot.phase, revision: snapshot.display?.revision ?? -1 });
    });
    const canvas = gl.domElement;
    const pointerUp = () => perf.current.inputs.push({ at: performance.now(), kind: 'pointerup' });
    const keyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') perf.current.inputs.push({ at: performance.now(), kind: 'escape' }); };
    canvas.addEventListener('pointerup', pointerUp, true); window.addEventListener('keydown', keyDown, true);
    const ctx = gl.getContext() as WebGL2RenderingContext;
    const glMethods = ['bufferData', 'bufferSubData'] as const;
    const originalGl = glMethods.map((name) => [name, ctx[name]] as const);
    for (const [name, original] of originalGl) {
      (ctx as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        const start = performance.now();
        const result = (original as (...values: unknown[]) => unknown).apply(ctx, args);
        perf.current.glUploads.push({ at: start, method: name, ms: performance.now() - start,
          bytes: paintingUploadBytes(name, args) });
        return result;
      };
    }
    const api = (owner as unknown as { ports: { api: Record<string, (...args: unknown[]) => Promise<unknown>> } }).ports.api;
    const names = ['openPaintingSession', 'previewPainting', 'beginPaintingStroke', 'samplePaintingStroke', 'commitPaintingStroke',
      'cancelPaintingStroke', 'getPaintingGeometry', 'closePaintingSession'] as const;
    const originals = names.map((name) => [name, api[name]] as const);
    for (const [name, original] of originals) {
      if (!original) continue;
      api[name] = async (...args) => {
        const start = performance.now();
        try {
          const result = await original(...args) as { paintingProfile?: unknown; resources?: Array<{ vertices: Float32Array; contour: Float32Array }> };
          const paint = result as { committed?: boolean; effective?: boolean; changedPartIds?: number[]; revision?: number; hit?: unknown };
          const request = args[0] as { tool?: string; event?: { pointer: readonly number[] } };
          perf.current.calls.push({ name, at: start, ms: performance.now() - start,
            ...(paint.revision !== undefined ? { revision: paint.revision } : {}),
            ...(result.paintingProfile ? { native: result.paintingProfile } : {}),
            ...(result.resources ? { resourceBytes: result.resources.reduce((n, r) => n + r.vertices.byteLength + r.contour.byteLength, 0) } : {}),
            ...(paint.committed !== undefined ? { committed: paint.committed } : {}),
            ...(paint.effective !== undefined ? { effective: paint.effective } : {}),
            ...('hit' in paint ? { hit: paint.hit } : {}),
            ...(request?.event ? { pointer: request.event.pointer } : {}),
            ...(request?.tool ? { tool: request.tool } : {}),
            ...(paint.changedPartIds ? { changedPartIds: paint.changedPartIds } : {}) });
          return result;
        } catch (error) {
          perf.current.calls.push({ name, at: start, ms: performance.now() - start });
          throw error;
        }
      };
    }
    const originalUpdate = resources.update;
    resources.update = (...args) => {
      const start = performance.now(), before = new Set(resources.resources.keys());
      const result = originalUpdate.call(resources, ...args);
      const after = new Set(resources.resources.keys());
      perf.current.resources.push({ at: start, ms: performance.now() - start,
        created: [...after].filter((id) => !before.has(id)).length, released: [...before].filter((id) => !after.has(id)).length,
        live: after.size, bytes: [...resources.resources.values()].reduce((n, r) => n + r.source.vertices.byteLength + r.source.contour.byteLength, 0) });
      perf.current.totalCreated += [...after].filter((id) => !before.has(id)).length;
      perf.current.totalReleased += [...before].filter((id) => !after.has(id)).length;
      return result;
    };
    const originalDispose = resources.dispose;
    resources.dispose = () => {
      const live = resources.resources.size;
      originalDispose.call(resources);
      perf.current.totalReleased += live - resources.resources.size;
    };
    return () => {
      const liveBeforeCleanup = resources.resources.size;
      unsubscribe(); canvas.removeEventListener('pointerup', pointerUp, true); window.removeEventListener('keydown', keyDown, true);
      for (const [name, original] of originalGl) (ctx as unknown as Record<string, unknown>)[name] = original;
      for (const [name, original] of originals) if (original) api[name] = original;
      resources.update = originalUpdate; resources.dispose = originalDispose;
      queueMicrotask(() => {
        perf.current.totalReleased += Math.max(0, liveBeforeCleanup - resources.resources.size);
        (window as unknown as { __orcaPaintingBenchmarkFinal?: unknown }).__orcaPaintingBenchmarkFinal = {
          at: performance.now(), liveResources: resources.resources.size,
          totalCreated: perf.current.totalCreated, totalReleased: perf.current.totalReleased,
          phases: [...perf.current.phases], inputs: [...perf.current.inputs], frames: [...perf.current.frames],
          peakJsHeapBytes: perf.current.peakJsHeapBytes,
        };
      });
    };
  }, [owner, resources]);
  useEffect(() => {
    // This probe is mounted only in E2E builds. Observe real pointer routing
    // without changing the controller's admission decision or native calls.
    const originalMove = owner.move;
    owner.move = (...args) => {
      const admitted = originalMove.call(owner, ...args);
      if (admitted) input.current.admittedMoves++;
      else input.current.droppedMoves++;
      return admitted;
    };
    return () => { owner.move = originalMove; };
  }, [owner]);
  useEffect(() => registerOrcaE2eOwner('painting', {
    paintingEvidence: () => {
      const state = owner.getSnapshot(), rect = gl.domElement.getBoundingClientRect();
      const source = volumes.find((v) => v.buffer.objectId === state.session?.objectId && v.buffer.instanceId === state.session.instanceId);
      const center = source?.getWorldBounds().getCenter(new THREE.Vector3()).project(camera);
      let ordinaryModels = 0; scene.traverse((o) => { if (o.userData.orcaVolume) ordinaryModels++; });
      return { phase: state.phase, tool: state.tool, sessionId: state.session?.id, settings: state.settings, selection: [...interaction.selection.ids],
        camera: [...camera.position.toArray(), ...camera.quaternion.toArray()], target: (controls as unknown as { target?: THREE.Vector3 } | null)?.target?.toArray() ?? [0, 0, 0], cursor: cursor?.toArray() ?? null,
        pivot: pivot?.toArray() ?? null, pivotCamera: pivot?.clone().applyMatrix4(camera.matrixWorldInverse).toArray() ?? null,
        center: center ? { x: rect.left + (center.x + 1) * rect.width / 2, y: rect.top + (1 - center.y) * rect.height / 2 } : null,
        resources: [...resources.resources.values()].map((r) => ({ id: r.source.resourceId, volumeId: r.source.volumeId, kind: r.source.kind, groups: r.source.groups, hasBvh: !!(r.geometry as THREE.BufferGeometry & { boundsTree?: unknown }).boundsTree })), ordinaryModels,
        nativeTarget: state.session, displayTarget: state.display?.session,
        rendered: rendered.current, input: { ...input.current }, runtime: runtime.getRuntimeExecutionState?.(), error: state.error };
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
    paintingNativeFacetCounts: async () => {
      let parts: Array<{ volumeId: number; sourceTriangleCount: number; facetCounts: number[] }> | null = null;
      await owner.betweenStrokes(async () => {
        const session = owner.getSnapshot().session;
        if (!session) return false;
        const api = (owner as unknown as { ports: { api: { readPaintingSession(request: unknown): Promise<unknown> } } }).ports.api;
        const response = await api.readPaintingSession({ version: 1, sessionId: session.id, revision: session.revision }) as
          { session?: { parts: Array<{ volumeId: number; sourceTriangleCount: number; facetCounts: number[] }> } };
        parts = response.session?.parts ?? null;
        return true;
      });
      return parts;
    },
    paintingPerformanceEvidence: () => {
      const jsMemory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
      return { calls: [...perf.current.calls], frames: [...perf.current.frames], resources: [...perf.current.resources],
        phases: [...perf.current.phases], inputs: [...perf.current.inputs], glUploads: [...perf.current.glUploads],
        totalCreated: perf.current.totalCreated, totalReleased: perf.current.totalReleased,
        input: { ...input.current }, jsHeapBytes: jsMemory?.usedJSHeapSize ?? null,
        peakJsHeapBytes: perf.current.peakJsHeapBytes,
        gpuResourceCounts: { ...gl.info.memory } };
    },
    paintingWorldToScreen: (point: [number, number, number]) => {
      const rect = gl.domElement.getBoundingClientRect();
      const projected = new THREE.Vector3(...point).project(camera);
      return { x: rect.left + (projected.x + 1) * rect.width / 2,
        y: rect.top + (1 - projected.y) * rect.height / 2 };
    },
  }), [camera, controls, cursor, gl, owner, resources, runtime, scene, volumes, interaction, pivot]);
  return null;
}
