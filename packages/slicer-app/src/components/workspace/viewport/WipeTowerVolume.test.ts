import { describe, expect, it, vi } from 'vitest';
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
    scene.setWipeTowerMovePort({ commit });

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

  it('rejects unselectable non-current towers and blocks a new gesture while the native move is busy', () => {
    const wipe = tower();
    const ordinary = model();
    let busy = false;
    const scene = new SceneInteractionController(() => [ordinary, wipe]);
    scene.setWipeTowerMovePort({ commit: vi.fn(async () => undefined), busy: () => busy });

    wipe.selectable = false;
    expect(scene.selectFromHit(wipe, false)).toBe(false);
    wipe.selectable = true;
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
    scene.setWipeTowerMovePort({ commit });
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

  it('reuses matching volumes, disposes replaced/removed volumes, and prunes shared selection on current-plate changes', () => {
    const plate = (id: string, index: number) => ({ plateId: id, displayIndex: index, name: id, origin: [index * 250, 0, 0] as const });
    const session = { ok: true as const, version: 1 as const, currentPlateId: 'plate-1', plates: [plate('plate-1', 0), plate('plate-2', 1)] };
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
    expect(scene.selection.empty).toBe(true);
    expect(scene.gizmo).toBeNull();
    expect(collection.volumes[0]!.selectable).toBe(false);
    expect(collection.volumes[1]!.selectable).toBe(true);
    const removed = collection.volumes[1]!;
    const removedDispose = vi.spyOn(removed, 'dispose');
    collection.setProjection(null);
    expect(removedDispose).toHaveBeenCalledOnce();
  });

  it('holds collection busy across a deferred native move and rejects a second commit', async () => {
    let rejectMove: ((reason?: unknown) => void) | undefined;
    const move = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectMove = reject; }));
    const collection = new WipeTowerVolumeCollection({ move, reconcile: vi.fn(async () => undefined), revision: vi.fn(() => 1) });
    const session = { ok: true as const, version: 1 as const, currentPlateId: 'plate-1', plates: [{ plateId: 'plate-1', displayIndex: 0, name: 'plate-1', origin: [0, 0, 0] as const }] };
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
