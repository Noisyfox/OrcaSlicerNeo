import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { acceleratedRaycast } from 'three-mesh-bvh';
import { GLVolume } from './GLVolume';
import { BVH_RAYCAST } from './ModelMesh';
import { SceneInteractionController } from './SceneInteractionController';
import { WipeTowerVolume, WipeTowerVolumeCollection } from './WipeTowerVolume';

function tower() {
  return new WipeTowerVolume({
    plateId: 'plate-1', displayIndex: 0, eligible: true, forced: false, empty: false, usedSlots: [0], brimMargin: 0,
    position: { x: 20, y: 30 }, width: 20, depth: 16, height: 40,
    rotation: 0, footprint: { minX: 20, maxX: 40, minY: 30, maxY: 46 }, buildArea: { minX: 0, maxX: 220, minY: 0, maxY: 220, maxZ: 250 },
    bands: [
      { slot: 0, colour: '#ff0000', opacity: 0.66, startDepth: 0, endDepth: 8 },
      { slot: 1, colour: '#0000ff', opacity: 0.66, startDepth: 8, endDepth: 16 },
    ],
  }, [0, 0, 0], 0);
}

function model() {
  return new GLVolume({
    objectId: 1, volumeId: 2, instanceId: 3,
    objectIdx: 0, volumeIdx: 0, instanceIdx: 0, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), vertexCount: 3,
    indices: new Uint32Array([0, 1, 2]), indexCount: 3, offset: [0, 0, 0],
    instanceTransform: { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] },
    volumeTransform: { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] },
  });
}

describe('WipeTowerVolume shared scene integration', () => {
  it('owns BVH-backed geometry for every visible band and uses accelerated raycast', () => {
    const wipe = tower();
    const ordinary = model();

    expect(BVH_RAYCAST).toBe(acceleratedRaycast);
    const geometries = wipe.projection.bands.map((_, index) => wipe.getBandGeometry(index));
    for (const geometry of geometries) {
      expect(geometry.boundsTree).toBeDefined();
      expect(geometry.getAttribute('position').count).toBeGreaterThan(0);
    }
    expect(ordinary.geometry.boundsTree).toBeDefined();
    wipe.dispose();
    ordinary.dispose();
    for (const geometry of geometries) expect(geometry.boundsTree).toBeNull();
  });

  it('rebuilds and releases all band BVHs when dimensions or band geometry changes', () => {
    const wipe = tower();
    const oldGeometry = wipe.getBandGeometry(0);
    const oldSecondGeometry = wipe.getBandGeometry(1);
    const disposeBoundsTree = vi.spyOn(oldGeometry, 'disposeBoundsTree');
    const disposeSecondBoundsTree = vi.spyOn(oldSecondGeometry, 'disposeBoundsTree');
    const projection = { ...wipe.projection, width: 24, bands: [{ ...wipe.projection.bands[0]!, colour: '#00ff00' }] };

    wipe.reconcile(projection, [0, 0, 0]);

    const newGeometry = wipe.getBandGeometry(0);
    expect(newGeometry).not.toBe(oldGeometry);
    expect(newGeometry.boundsTree).toBeDefined();
    expect(disposeBoundsTree).toHaveBeenCalledOnce();
    expect(disposeSecondBoundsTree).toHaveBeenCalledOnce();
    expect(oldGeometry.boundsTree).toBeNull();
    expect(oldSecondGeometry.boundsTree).toBeNull();
    wipe.dispose();
  });

  it('reuses band geometry when only material or filament-slot data changes', () => {
    const wipe = tower();
    const geometries = wipe.projection.bands.map((_, index) => wipe.getBandGeometry(index));
    const disposeBoundsTrees = geometries.map((geometry) => vi.spyOn(geometry, 'disposeBoundsTree'));
    const projection = {
      ...wipe.projection,
      bands: wipe.projection.bands.map((band, index) => ({
        ...band,
        slot: band.slot + 10 + index,
        colour: index === 0 ? '#00ff00' : '#ffff00',
        opacity: 0.42,
      })),
    };

    wipe.reconcile(projection, [0, 0, 0]);

    expect(wipe.projection.bands).toEqual(projection.bands);
    expect(wipe.projection.bands.map((_, index) => wipe.getBandGeometry(index))).toEqual(geometries);
    for (const disposeBoundsTree of disposeBoundsTrees) expect(disposeBoundsTree).not.toHaveBeenCalled();
    wipe.dispose();
  });

  it('uses shared selection and Move-only gizmo, then commits native X/Y without model history', async () => {
    const wipe = tower();
    const ordinary = model();
    const history = { begin: vi.fn(), commit: vi.fn(), abort: vi.fn() };
    const commit = vi.fn(async () => undefined);
    const scene = new SceneInteractionController(() => [ordinary, wipe], history);
    scene.setSceneEntityCommitPort({ commit });

    expect(scene.selectFromHit(wipe, false)).toBe(true);
    expect(scene.selectedWipeTower()).toBe(wipe);
    expect(scene.toggleGizmo('rotate')).toBe(false);
    expect(scene.toggleGizmo('scale')).toBe(false);
    expect(scene.toggleGizmo('move')).toBe(true);
    expect(scene.prepareBodyDragFromPointerDown(wipe, false)).toBe(false);
    // An already-selected body preserves the selection; the common drag path
    // starts from the existing shared selection.
    expect(scene.tryBeginBodyDrag()).toBe(true);
    const pivot = scene.selectionPivot()!;
    const next = pivot.clone();
    next.x += 500;
    next.y += 10;
    next.z += 50;
    scene.updateDragPivot(next);
    scene.endDrag();
    await Promise.resolve();

    expect(wipe.position).toEqual({ x: 200, y: 40 });
    expect(wipe.instanceTransform.offset[2]).toBe(0);
    expect(commit).toHaveBeenCalledWith(wipe);
    expect(history.begin).not.toHaveBeenCalled();
    expect(scene.selectFromHit(ordinary, false)).toBe(true);
    expect(scene.selectedWipeTower()).toBeNull();
  });

  it('routes a regular volume and Prime Tower through the same pointer candidate and owner transitions', async () => {
    const ordinary = model();
    const wipe = tower();
    const history = { begin: vi.fn(), commit: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
    const towerCommit = vi.fn(async () => undefined);
    const scene = new SceneInteractionController(() => [ordinary, wipe], history);
    scene.setSceneEntityCommitPort({ commit: towerCommit });

    for (const entity of [ordinary, wipe]) {
      scene.clearSelection();
      scene.resolveGizmoPointerDown({ button: 0 } as PointerEvent);

      // Both entity types synchronously select on pointer-down, retain the
      // exact hit until DragControls crosses its threshold, and make the same
      // none -> body -> none ownership transition.
      expect(scene.prepareBodyDragFromPointerDown(entity, false)).toBe(true);
      expect(scene.selectedVolumes()).toEqual([entity]);
      expect(scene.tryBeginBodyDrag(entity)).toBe(true);
      expect(scene.owner).toBe('body');
      const pivot = scene.selectionPivot()!;
      expect(scene.updateDragPivot(pivot.clone().add(new THREE.Vector3(4, 3, 0)))).toBe(true);
      expect(scene.endDrag()).toBe(true);
      expect(scene.owner).toBe('none');
      await Promise.resolve();
    }

    expect(history.begin).toHaveBeenCalledOnce();
    expect(history.commit).toHaveBeenCalledOnce();
    expect(towerCommit).toHaveBeenCalledWith(wipe);
  });

  it('allows every eligible tower and blocks a new gesture while the native move is busy', () => {
    const wipe = tower();
    const ordinary = model();
    let busy = false;
    const scene = new SceneInteractionController(() => [ordinary, wipe]);
    scene.setSceneEntityCommitPort({ commit: vi.fn(async () => undefined), busy: () => busy });

    expect(scene.selectFromHit(wipe, false)).toBe(true);
    scene.selectVolumeIds([ordinary.id, wipe.id]);
    expect(scene.selectedWipeTower()).toBeNull();
    expect(scene.selectedVolumes()).toEqual([ordinary]);
    scene.selectFromHit(wipe, false);
    busy = true;
    expect(scene.tryBeginBodyDrag()).toBe(false);
    expect(scene.moveSelectionToPivot(scene.selectionPivot()!)).toBe(false);
    busy = false;
    expect(scene.tryBeginBodyDrag()).toBe(true);
    scene.cancelDrag();
  });

  it('commits a changed shared MovePanel pivot once, but ignores no-op and Z-only numeric pivots', () => {
    const wipe = tower();
    const history = { begin: vi.fn(), commit: vi.fn(), abort: vi.fn() };
    const commit = vi.fn(async () => undefined);
    const scene = new SceneInteractionController(() => [wipe], history);
    scene.setSceneEntityCommitPort({ commit });
    scene.selectFromHit(wipe, false);
    const pivot = scene.selectionPivot()!;
    expect(scene.moveSelectionToPivot(pivot.clone())).toBe(false);
    const zOnly = pivot.clone(); zOnly.z += 10;
    expect(scene.moveSelectionToPivot(zOnly)).toBe(false);
    const xy = pivot.clone(); xy.x += 5;
    expect(scene.moveSelectionToPivot(xy)).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(history.begin).not.toHaveBeenCalled();
  });

  it('reuses matching volumes, disposes replaced/removed volumes, and preserves non-current selection', () => {
    const plate = (id: string, index: number) => ({ plateId: id, displayIndex: index, name: id, origin: [index * 250, 0, 0] as const });
    const session = { instances: [], ok: true as const, version: 1 as const, currentPlateId: 'plate-1', plates: [plate('plate-1', 0), plate('plate-2', 1)] };
    const project = (currentPlateId: string, width = 20) => ({ ok: true as const, version: 1 as const, currentPlateId, buildArea: tower().projection.buildArea, plates: [
      { ...tower().projection, plateId: 'plate-1', displayIndex: 0, width },
      { ...tower().projection, plateId: 'plate-2', displayIndex: 1, width },
    ] });
    const collection = new WipeTowerVolumeCollection({ move: vi.fn(), reconcile: vi.fn(), revision: vi.fn(() => 1) });
    collection.setProjection(project('plate-1'), session);
    const first = collection.volumes[0]!;
    const dispose = vi.spyOn(first, 'dispose');
    collection.setProjection(project('plate-1'), session);
    expect(collection.volumes[0]).toBe(first);
    expect(dispose).not.toHaveBeenCalled();
    collection.setProjection(project('plate-1', 30), session);
    expect(dispose).toHaveBeenCalledOnce();
    const scene = new SceneInteractionController(() => [...collection.volumes]);
    scene.selectFromHit(collection.volumes[0]!, false);
    scene.toggleGizmo('move');
    collection.setProjection(project('plate-2', 30), session);
    scene.pruneSelection();
    expect(scene.selectedWipeTower()?.plateId).toBe('plate-1');
    expect(scene.gizmo).toBe('move');
    expect(collection.volumes[0]!.selectable).toBe(true);
    expect(collection.volumes[1]!.selectable).toBe(true);
    const removed = collection.volumes[1]!;
    const removedDispose = vi.spyOn(removed, 'dispose');
    collection.setProjection(null);
    expect(removedDispose).toHaveBeenCalledOnce();
  });

  it('updates only the current-plate marker without rebuilding the projection', () => {
    const plate = (id: string, index: number) => ({ plateId: id, displayIndex: index, name: id, origin: [index * 250, 0, 0] as const });
    const session = { instances: [], ok: true as const, version: 1 as const, currentPlateId: 'plate-1', plates: [plate('plate-1', 0), plate('plate-2', 1)] };
    const project = { ok: true as const, version: 1 as const, currentPlateId: 'plate-1', buildArea: tower().projection.buildArea, plates: [
      { ...tower().projection, plateId: 'plate-1', displayIndex: 0 },
      { ...tower().projection, plateId: 'plate-2', displayIndex: 1 },
    ] };
    const collection = new WipeTowerVolumeCollection({ move: vi.fn(), reconcile: vi.fn(), revision: vi.fn(() => 1) });
    collection.setProjection(project, session);
    const first = collection.volumes[0]!;
    const second = collection.volumes[1]!;
    const notify = vi.fn();
    collection.subscribe(notify);
    collection.setCurrentPlate('plate-2', { ...session, currentPlateId: 'plate-2' });
    expect(collection.projection?.currentPlateId).toBe('plate-2');
    expect(collection.volumes[0]).toBe(first);
    expect(collection.volumes[1]).toBe(second);
    expect(notify).toHaveBeenCalledOnce();
  });

  it('patches only the moved plate from the narrow native response', () => {
    const plate = (id: string, index: number) => ({ plateId: id, displayIndex: index, name: id, origin: [index * 250, 0, 0] as const });
    const session = { instances: [], ok: true as const, version: 1 as const, currentPlateId: 'plate-1', plates: [plate('plate-1', 0), plate('plate-2', 1)] };
    const second = { ...tower().projection, plateId: 'plate-2', displayIndex: 1, position: { x: 60, y: 70 } };
    const projection = { ok: true as const, version: 1 as const, currentPlateId: 'plate-1', buildArea: tower().projection.buildArea,
      plates: [tower().projection, second] };
    const collection = new WipeTowerVolumeCollection({ move: vi.fn(), reconcile: vi.fn(), revision: vi.fn(() => 1) });
    collection.setProjection(projection, session);

    collection.setPlatePosition('plate-1', { x: 35, y: 45 }, { minX: 35, maxX: 55, minY: 45, maxY: 61 });

    expect(collection.volumes.find((volume) => volume.plateId === 'plate-1')?.position).toEqual({ x: 35, y: 45 });
    expect(collection.volumes.find((volume) => volume.plateId === 'plate-2')?.position).toEqual({ x: 60, y: 70 });
  });

  it('reports aggregate projection reconciliation and publication timings without retaining projection data', () => {
    const plate = { plateId: 'plate-1', displayIndex: 0, name: 'plate-1', origin: [0, 0, 0] as const };
    const session = { instances: [], ok: true as const, version: 1 as const, currentPlateId: 'plate-1', plates: [plate] };
    const diagnostics = {
      recordSetProjection: vi.fn(), recordReconcile: vi.fn(), recordEmit: vi.fn(),
    };
    const collection = new WipeTowerVolumeCollection(
      { move: vi.fn(), reconcile: vi.fn(), revision: vi.fn(() => 1) }, diagnostics,
    );
    collection.setProjection({
      ok: true as const, version: 1 as const, currentPlateId: 'plate-1', buildArea: tower().projection.buildArea,
      plates: [tower().projection],
    }, session);

    for (const callback of [diagnostics.recordSetProjection, diagnostics.recordReconcile, diagnostics.recordEmit]) {
      expect(callback).toHaveBeenCalledOnce();
      expect(callback.mock.calls[0]![0]).toEqual(expect.any(Number));
      expect(callback.mock.calls[0]![0]).toBeGreaterThanOrEqual(0);
    }
  });

  it('republishes selected bounds and the gizmo pivot from the authoritative move receipt', async () => {
    const session = { instances: [], ok: true as const, version: 1 as const, currentPlateId: 'plate-1', plates: [
      { plateId: 'plate-1', displayIndex: 0, name: 'plate-1', origin: [0, 0, 0] as const },
    ] };
    const authoritativePosition = { x: 42, y: 55 };
    const authoritativeFootprint = { minX: 42, maxX: 62, minY: 55, maxY: 71 };
    const move = vi.fn(async () => ({
      ok: true as const,
      version: 1 as const,
      result: {
        mutation: {
          kind: 'move' as const, plateId: 'plate-1', historyEntryDelta: 1 as const,
          revisionBefore: 1, revisionAfter: 2, dirty: true, affectedPlateIds: ['plate-1'],
          position: authoritativePosition, footprint: authoritativeFootprint,
        },
        historyStatus: {
          canUndo: true, canRedo: false, undoEntries: [], redoEntries: [], cursor: 1,
          savedCheckpoint: 0, savedCheckpointEvicted: false, dirty: true, bytesUsed: 0,
          byteBudget: 1, evictedEntryCount: 0,
          lastEvictedEntryId: null, oldestRetainedEntryId: null, oversizedEntryRetained: false,
          disabled: false, activeTransactionId: null, revision: 2,
        },
      },
    }));
    const collection = new WipeTowerVolumeCollection({ move, reconcile: vi.fn(async () => undefined), revision: vi.fn(() => 1) });
    const projection = { ok: true as const, version: 1 as const, currentPlateId: 'plate-1', buildArea: tower().projection.buildArea, plates: [tower().projection] };
    collection.setProjection(projection, session);
    const scene = new SceneInteractionController(() => [...collection.volumes]);
    collection.subscribe(() => scene.pruneSelection());
    const volume = collection.volumes[0]!;
    scene.selectFromHit(volume, false);
    scene.toggleGizmo('move');

    const observedPivots: Array<[number, number, number]> = [];
    scene.subscribe(() => {
      const pivot = scene.selectionPivot();
      if (pivot) observedPivots.push([pivot.x, pivot.y, pivot.z]);
    });
    volume.setTransientPosition({ x: 70, y: 80 });
    await collection.commit(volume);

    expect(volume.position).toEqual(authoritativePosition);
    expect(scene.selectionBounds()!.min.toArray()).toEqual([42, 55, 0]);
    expect(scene.selectionBounds()!.max.toArray()).toEqual([62, 71, 40]);
    // The render controller must be notified after the receipt replaces the
    // local draft, otherwise SelectionBoundsBox and TransformControls keep
    // their pre-receipt geometry even though the tower mesh is correct.
    expect(observedPivots.at(-1)).toEqual([52, 63, 20]);

    // Direct Prime Tower Undo/Redo is projected as a Worker refresh rather
    // than a renderer-owned coordinate history. The retained selection must
    // receive both authoritative transitions too.
    collection.setProjection(projection, session);
    expect(observedPivots.at(-1)).toEqual([30, 38, 20]);
    collection.setProjection({
      ...projection,
      plates: [{ ...tower().projection, position: authoritativePosition, footprint: authoritativeFootprint }],
    }, session);
    expect(observedPivots.at(-1)).toEqual([52, 63, 20]);
  });

  it('rebuilds a retained selection from the Worker projection after a stale release', async () => {
    const session = { instances: [], ok: true as const, version: 1 as const, currentPlateId: 'plate-1', plates: [
      { plateId: 'plate-1', displayIndex: 0, name: 'plate-1', origin: [0, 0, 0] as const },
    ] };
    const projection = { ok: true as const, version: 1 as const, currentPlateId: 'plate-1', buildArea: tower().projection.buildArea, plates: [tower().projection] };
    let collection: WipeTowerVolumeCollection;
    const reconcile = vi.fn(async () => collection.setProjection(projection, session));
    collection = new WipeTowerVolumeCollection({
      move: vi.fn(async () => ({ ok: false as const, version: 1 as const, error: 'stale', errorCode: 'stale_revision' })),
      reconcile,
      revision: vi.fn(() => 1),
    });
    collection.setProjection(projection, session);
    const scene = new SceneInteractionController(() => [...collection.volumes]);
    collection.subscribe(() => scene.pruneSelection());
    const volume = collection.volumes[0]!;
    scene.selectFromHit(volume, false);
    scene.toggleGizmo('move');
    volume.setTransientPosition({ x: 70, y: 80 });

    await collection.commit(volume);

    expect(reconcile).toHaveBeenCalledOnce();
    expect(volume.position).toEqual({ x: 20, y: 30 });
    expect(scene.selectionPivot()!.toArray()).toEqual([30, 38, 20]);
  });

  it('holds collection busy across a deferred native move and rejects a second commit', async () => {
    let rejectMove: ((reason?: unknown) => void) | undefined;
    const move = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectMove = reject; }));
    const collection = new WipeTowerVolumeCollection({ move, reconcile: vi.fn(async () => undefined), revision: vi.fn(() => 1) });
    const session = { instances: [], ok: true as const, version: 1 as const, currentPlateId: 'plate-1', plates: [{ plateId: 'plate-1', displayIndex: 0, name: 'plate-1', origin: [0, 0, 0] as const }] };
    const projection = { ok: true as const, version: 1 as const, currentPlateId: 'plate-1', buildArea: tower().projection.buildArea, plates: [tower().projection] };
    collection.setProjection(projection, session);
    const volume = collection.volumes[0]!;
    const first = collection.commit(volume);
    expect(collection.busy).toBe(true);
    await collection.commit(volume);
    expect(move).toHaveBeenCalledOnce();
    rejectMove?.(new Error('stale'));
    await first;
    expect(collection.busy).toBe(false);
  });
});
