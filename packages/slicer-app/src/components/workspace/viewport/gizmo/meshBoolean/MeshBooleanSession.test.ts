import { describe, expect, it } from 'vitest';
import type { ModelObjectBuffer } from '@slicer/client';
import { GLVolume } from '../../GLVolume';
import { SceneInteractionController } from '../../SceneInteractionController';

function volume(object = 0, part = 0, instance = 0): GLVolume {
  return new GLVolume({ objectId: 100 + object, volumeId: 200 + object * 10 + part,
    instanceId: 300 + object * 10 + instance, objectIdx: object, volumeIdx: part, instanceIdx: instance,
    positions: new Float32Array([0,0,0, 1,0,0, 0,1,0]), indices: new Uint32Array([0,1,2]),
    vertexCount: 3, indexCount: 3, offset: [0,0,0],
    instanceTransform: { offset: [0,0,0], rotation: [0,0,0], scale: [1,1,1], mirror: [1,1,1] },
    volumeTransform: { offset: [0,0,0], rotation: [0,0,0], scale: [1,1,1], mirror: [1,1,1] },
  } satisfies ModelObjectBuffer, { kind: 'exclusive' });
}
function setup() {
  const volumes = [volume(), volume(0,1), volume(0,0,1), volume(0,1,1), volume(1), volume(1,1), volume(2)];
  const scene = new SceneInteractionController(() => volumes);
  scene.selectComposite(0, undefined, 0);
  expect(scene.toggleGizmo('mesh-boolean')).toBe(true);
  return { volumes, scene, session: scene.meshBoolean };
}

describe('Mesh Boolean scene interaction', () => {
  it('requires exactly one complete multipart instance and never auto-opens on selection', () => {
    const { scene } = setup();
    scene.closeGizmo();
    for (const select of [() => scene.clearSelection(), () => scene.selectComposite(0,0,0),
      () => scene.selectComposite(0), () => scene.selectComposite(2)]) {
      select(); expect(scene.gizmo).toBe(null); expect(scene.toggleGizmo('mesh-boolean')).toBe(false);
    }
    scene.selectComposite(0,undefined,1);
    expect(scene.toggleGizmo('mesh-boolean')).toBe(true);
    expect(scene.meshBoolean.getSnapshot().target).toEqual({ objectId: 100, instanceId: 301 });
  });

  it('keeps the full instance selected while viewport/list assignments preserve the anchor', () => {
    const { scene, session, volumes } = setup();
    const selected = [...scene.selection.ids];
    scene.prepareBodyDragFromPointerDown(volumes[0], false);
    expect(session.getSnapshot()).toMatchObject({ a: 200, b: null, picking: 'b' });
    expect(scene.bodyDragEnabled).toBe(false);
    expect(session.assign(session.volume(201)!)).toBe(true); // same entry used by Part rows
    expect(session.request(false)).toMatchObject({ sourceVolumeId: 200, toolVolumeId: 201, instanceId: 300 });
    expect([...scene.selection.ids]).toEqual(selected);
    expect(session.assign(volumes[2])).toBe(false); // another instance cannot silently change the anchor
  });

  it('keeps operands across modes, clears the opposite slot and remembers separate Delete input flags', () => {
    const { session, volumes } = setup();
    session.assign(volumes[0]); session.assign(volumes[1]);
    session.setOperation('difference'); session.setDeleteInput(true);
    expect(session.request(false)?.deleteInput).toBe(true);
    session.setOperation('intersection'); expect(session.request(false)?.deleteInput).toBe(false);
    session.setDeleteInput(true); session.setOperation('union');
    expect(session.request(false)).toMatchObject({ sourceVolumeId: 200, toolVolumeId: 201, deleteInput: false });
    session.setPicking('a'); session.assign(volumes[1]);
    expect(session.getSnapshot()).toMatchObject({ a: 201, b: null, picking: 'b' });
    expect(session.request(false)).toBe(null);
    session.clear('a'); expect(session.getSnapshot()).toMatchObject({ a: null, picking: 'a' });
  });

  it('retargets a different eligible object and closes for an ineligible ordinary selection', () => {
    const { scene, session, volumes } = setup();
    session.assign(volumes[0]); session.setOperation('difference');
    scene.selectComposite(1);
    expect(scene.gizmo).toBe('mesh-boolean');
    expect(session.getSnapshot()).toMatchObject({ target: { objectId: 101, instanceId: 310 }, a: null, b: null, operation: 'union' });
    scene.selectComposite(2);
    expect(scene.gizmo).toBe(null);
    expect(session.getSnapshot().target).toBe(null);
  });

  it('reconciles deleted operands and rejects stale IDs before dispatch', () => {
    const { scene, session, volumes } = setup();
    session.assign(volumes[0]); session.assign(volumes[1]);
    volumes.splice(1,1); scene.pruneSelection();
    expect(scene.gizmo).toBe(null);
    expect(session.request(false)).toBe(null);
  });

  it('keeps the tool through publication, selects the result without chaining, then closes when only one Part remains', () => {
    const { scene, session, volumes } = setup();
    session.assign(volumes[0]); session.assign(volumes[1]);
    session.publishing = true;
    const replacement = volume(0,2);
    volumes.splice(0,1,replacement); scene.pruneSelection();
    expect(scene.gizmo).toBe('mesh-boolean');
    expect(scene.toggleGizmo('move')).toBe(false);
    expect(scene.selectComposite(1)).toBe(false);
    session.completed(202); session.publishing = false;
    scene.setSelectionMode('volume'); scene.selectVolumeIds([replacement.id]);
    expect(scene.gizmo).toBe('mesh-boolean');
    expect(session.getSnapshot()).toMatchObject({ a: null, b: null, picking: 'a' });
    expect(session.request(false)).toBe(null);
    volumes.splice(1,1); scene.pruneSelection();
    expect(scene.gizmo).toBe(null);
  });

  it('clears picks when another tool opens or the project is replaced', () => {
    const { scene, session, volumes } = setup();
    session.assign(volumes[0]); scene.toggleGizmo('move');
    expect(session.getSnapshot().target).toBe(null);
    scene.toggleGizmo('mesh-boolean'); session.assign(volumes[0]); scene.resetForModel();
    expect(scene.gizmo).toBe(null); expect(session.getSnapshot().target).toBe(null);
  });

  it('rejects hidden-instance clicks and closes for a list-selected result Part in another instance', () => {
    const { scene, session, volumes } = setup();
    session.publishing = true;
    const replacement = volume(0,2), otherInstance = volume(0,2,1);
    volumes.splice(0,1,replacement); volumes.splice(2,1,otherInstance);
    scene.pruneSelection(); session.completed(202); session.publishing = false;
    scene.selectVolumeIds([replacement.id]);
    expect(scene.gizmo).toBe('mesh-boolean');
    expect(scene.prepareBodyDragFromPointerDown(otherInstance, false, true)).toBe(false);
    expect(scene.selectedVolumes()).toEqual([replacement]);
    expect(scene.gizmo).toBe('mesh-boolean');
    scene.selectComposite(0, 2, 1);
    expect(scene.selectedVolumes()).toEqual([otherInstance]);
    expect(scene.gizmo).toBe(null);
    expect(session.getSnapshot().target).toBe(null);
    expect(session.request(false)).toBe(null);
    expect(scene.instanceHider.getSnapshot()).toBe(null);
  });
});
