import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { drawnPlane, normalOf, type CutPose } from './CutSession';

describe('Shift-drag cut line', () => {
  const pose: CutPose = { center: [1, 2, 3], rotation: [1,0,0,0,1,0,0,0,1] };
  it('places a vertical cut through the screen line and preserves the projected center', () => {
    const a = new Vector3(10,5,3), b = new Vector3(10,-8,3), view = new Vector3(0,0,-1);
    const plane = drawnPlane(pose, a, b, view)!;
    expect(plane.center).toEqual([10,2,3]);
    const n = normalOf(plane);
    expect(n.x).toBeCloseTo(1);
    expect(n.dot(view)).toBeCloseTo(0);
    expect(n.dot(a.clone().sub(new Vector3(...plane.center)))).toBeCloseTo(0);
  });
  it('ignores a zero-length line', () => {
    expect(drawnPlane(pose, new Vector3(), new Vector3(), new Vector3(0,0,-1))).toBeNull();
  });
});

it('restores reassignment with its plane and preserves grouping through an in-plane shift or flip', async () => {
  const { CutSession } = await import('./CutSession');
  const cut = new CutSession(() => {});
  const pose: CutPose = { center: [0,0,0], rotation: [1,0,0,0,1,0,0,0,1] };
  cut.open({ initial: pose, objectId: 1, instanceId: 2, signature: 'cube', radius: 20, solidRadius:16 }, 3);
  cut.togglePiece(pose, 2); cut.update({ center: [3,0,0] }); cut.flip();
  expect(cut.draft?.grouping?.toggled).toEqual([2]);
  cut.begin(); cut.move(1); cut.move(2); cut.finish();
  expect(cut.draft?.grouping).toBeUndefined();
  cut.navigate('undo');
  expect(cut.draft?.grouping?.toggled).toEqual([2]);
  expect(cut.draft?.center).toEqual([3,0,0]);
  cut.close(false);
});

it('projects confirmed connectors onto a tilted plane and discards only the unconfirmed editor visit', async () => {
  const { CutSession, rotationOf } = await import('./CutSession');
  const { Quaternion } = await import('three');
  const cut = new CutSession(() => {});
  const target = { initial: { center: [0,0,0], rotation: [1,0,0,0,1,0,0,0,1] } as CutPose, signature:'ref', objectId:1, instanceId:3, radius:10, solidRadius:8 };
  cut.open(target,2); cut.editConnectors(); cut.addConnector([4,0,0]);
  cut.changeConnector({ type:'dowel' }); cut.validateConnectors(cut.draft!,cut.connectors!,[]); cut.endConnectorEdit(true);
  cut.editConnectors(); cut.addConnector([0,4,0]); cut.endConnectorEdit(false);
  expect(cut.draft?.connectors).toHaveLength(1);
  cut.update({ rotation:rotationOf(new Quaternion().setFromAxisAngle(new Vector3(0,1,0),Math.PI/4)) });
  const position = new Vector3(...cut.connectors![0].position);
  expect(position.dot(normalOf(cut.draft!))).toBeCloseTo(0);
  expect(position.x).toBeCloseTo(2);
  cut.editConnectors(); cut.removeConnectors(true); cut.close(true); cut.open(target,3);
  expect(cut.draft?.connectors?.[0].position).toEqual(position.toArray());
  cut.close(false); cut.open(target,3); expect(cut.connectors).toBeUndefined(); cut.close(false);
});

it('invalidates exact dovetail previews during gestures and accepts only the settled pose', async () => {
  const { CutSession } = await import('./CutSession');
  const { initialGroove,grooveSpacing } = await import('./CutGroovePanel');
  const cut=new CutSession(()=>{});
  const target={ initial:{ center:[0,0,0],rotation:[1,0,0,0,1,0,0,0,1] } as CutPose, signature:'target', objectId:1, instanceId:2, radius:24, solidRadius:20 };
  cut.open(target,1); cut.update({groove:{...initialGroove,count:2}});
  const first=cut.grooveKey; cut.setGrooveReply(first); expect(cut.groovePreview?.error).toBeUndefined();
  cut.begin(); cut.move(1); expect(cut.grooveKey).toBe('');
  cut.move(1); cut.finish(); expect(cut.grooveKey).not.toBe(first);
  cut.setGrooveReply(first,'stale'); expect(cut.groovePreview).toBeNull();
  cut.setGrooveReply(cut.grooveKey,'invalid'); expect(cut.groovePreview?.error).toBe('invalid');
  expect(grooveSpacing({...initialGroove,width:4,flankAngle:90,gap:3},20)).toBeCloseTo(7);
  cut.close(false);
});
