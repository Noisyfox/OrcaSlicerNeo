import { describe, expect, it, vi } from 'vitest';
import type { HistoryStatus, PaintingDraftResult, PaintingSessionMetadata, PaintingPointerEvent } from '@slicer/client';
import { PaintingController, type PaintingPorts } from './PaintingController';
import { PaintingResources, paintingPartMatrix } from './PaintingResources';
import * as THREE from 'three';
import type { FilamentSessionSnapshot, PaintingGeometryResult } from '@slicer/client';
import { Selection } from '../../Selection';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const event = (x: number): PaintingPointerEvent => ({ pointer: [x, 2], viewport: [0, 0, 100, 100], projection: identity, view: identity });
const status = { revision: 1 } as HistoryStatus;
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture() {
  let session: PaintingSessionMetadata = { id: 'ps-1', historySessionId: 'hs-1', revision: 1, objectId: 1, instanceId: 2, instanceTransform: identity, parts: [], phase: 'idle', strokeId: null, annotation: 'mmu' };
  const receipt = (phase: 'idle' | 'drawing' | 'finished' = 'drawing'): Exclude<PaintingDraftResult, { error: string }> => {
    session = { ...session, revision: session.revision + 1, phase, strokeId: phase === 'idle' ? null : 'pst-1-1' };
    return { ok: true, version: 1, sessionId: session.id, revision: session.revision, strokeId: session.strokeId, phase, effective: true, changedPartIds: [3], hit: { volumeId: 3, originalFacet: 9, world: [0, 0, 0] }, candidateRevision: session.revision };
  };
  const frames: (() => void)[] = [];
  const ports: PaintingPorts = {
    coordinate: async (operation) => operation(),
    palette: () => null,
    targetAvailable: () => true,
    api: {
      openHistorySession: vi.fn(async () => ({ sessionId: 'hs-1', status })),
      closeHistorySession: vi.fn(async () => status),
      openPaintingSession: vi.fn(async () => ({ ok: true as const, version: 1 as const, session })),
      targetPaintingSession: vi.fn(async (r) => ({ ok: true as const, version: 1 as const, session: session = { ...session, objectId: r.objectId, instanceId: r.instanceId, revision: session.revision + 1 } })),
      readPaintingSession: vi.fn(async () => ({ ok: true as const, version: 1 as const, session })),
      closePaintingSession: vi.fn(async () => ({ ok: true as const, version: 1 as const })),
      previewPainting: vi.fn(async () => receipt('idle')),
      beginPaintingStroke: vi.fn(async (r) => receipt(r.tool === 'gap' || r.tool === 'eraseAll' ? 'finished' : 'drawing')),
      samplePaintingStroke: vi.fn(async () => receipt()),
      finishPaintingStroke: vi.fn(async () => receipt('finished')),
      cancelPaintingStroke: vi.fn(async () => receipt('idle')),
      commitPaintingStroke: vi.fn(async () => ({ ...receipt('idle'), committed: true, affectedPlateIds: ['plate1'], history: status })),
      getPaintingGeometry: vi.fn(async () => ({ ok: true as const, version: 1 as const, sessionId: session.id, revision: session.revision, parts: [], candidates: [], resources: [] })),
      settlePainting: vi.fn(async () => ({ ok: true as const, version: 1 as const, settledVersion: 1, projections: {} })),
    },
    schedule: (callback) => { frames.push(callback); return () => { const i = frames.indexOf(callback); if (i >= 0) frames.splice(i, 1); }; },
    history: vi.fn(), committed: vi.fn(), prepareClosed: vi.fn(async () => {}),
  };
  const controller = new PaintingController(ports);
  return { controller, ports, frames, receipt, frame: async () => { frames.shift()?.(); await tick(); } };
}
describe('painting event admission and reliable terminal', () => {
  it('drops every busy move, retains release endpoint/settings, and requires a fresh press', async () => {
    const { controller: c, ports: p, receipt, frame } = fixture(); await c.open(1, 2); await frame();
    const pending = deferred<PaintingDraftResult>(); vi.mocked(p.api.beginPaintingStroke).mockReturnValueOnce(pending.promise);
    const press = c.press(event(1));
    expect(c.move(event(2))).toBe(false); expect(c.move(event(3))).toBe(false);
    c.setSettings({ state: 2, radius: 5 }); c.release(event(4), true);
    expect(await c.press(event(5))).toBe('ignored'); c.release(event(6));
    pending.resolve(receipt()); await press;
    expect(p.api.samplePaintingStroke).not.toHaveBeenCalled();
    expect(p.api.commitPaintingStroke).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: event(4), settings: expect.objectContaining({ state: 2, radius: 5, erase: true }) }));
    expect(c.getSnapshot().phase).toBe('idle'); expect(c.move(event(7))).toBe(false);
    expect(await c.press(event(8))).toBe('paint');
  });
  it('waits for an admitted sample then Escape cancels without an endpoint', async () => {
    const { controller: c, ports: p, receipt, frame } = fixture(); await c.open(1, 2); await frame(); await c.press(event(1));
    const pending = deferred<PaintingDraftResult>(); vi.mocked(p.api.samplePaintingStroke).mockReturnValueOnce(pending.promise);
    expect(c.move(event(2))).toBe(true); c.release(event(3)); c.cancel();
    expect(c.move(event(4))).toBe(false); expect(await c.press(event(5))).toBe('ignored');
    pending.resolve(receipt()); await tick();
    expect(p.api.cancelPaintingStroke).toHaveBeenCalledTimes(1); expect(p.api.commitPaintingStroke).not.toHaveBeenCalled();
    expect(c.getSnapshot().phase).toBe('idle'); c.release(event(6)); expect(p.api.commitPaintingStroke).not.toHaveBeenCalled();
  });
  it('focus/capture interruptions commit once without sampling the interruption', async () => {
    const { controller: c, ports: p, frame } = fixture(); await c.open(1, 2); await frame(); await c.press(event(1));
    c.release(); c.release(); await tick(); c.release(event(9));
    expect(p.api.commitPaintingStroke).toHaveBeenCalledTimes(1);
    expect(vi.mocked(p.api.commitPaintingStroke).mock.calls[0][0]).not.toHaveProperty('event');
  });
  it('press waits behind display; terminal survives both commands and display never races native', async () => {
    const { controller: c, ports: p, frames } = fixture(); await c.open(1, 2);
    const pending = deferred<Awaited<ReturnType<typeof p.api.getPaintingGeometry>>>();
    vi.mocked(p.api.getPaintingGeometry).mockReturnValueOnce(pending.promise); frames.shift()?.();
    const press = c.press(event(1)); c.release(event(2));
    expect(p.api.beginPaintingStroke).not.toHaveBeenCalled();
    pending.resolve({ ok: true, version: 1, sessionId: 'ps-1', revision: 1, parts: [], candidates: [], resources: [] }); await press;
    expect(p.api.beginPaintingStroke).toHaveBeenCalledTimes(1); expect(p.api.commitPaintingStroke).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().phase).toBe('idle');
  });
  it('display during a drawing gesture drops moves but retains termination', async () => {
    const { controller: c, ports: p, frames, frame } = fixture(); await c.open(1, 2); await frame(); await c.press(event(1));
    const pending = deferred<Awaited<ReturnType<typeof p.api.getPaintingGeometry>>>(); vi.mocked(p.api.getPaintingGeometry).mockReturnValueOnce(pending.promise); frames.shift()?.();
    expect(c.move(event(2))).toBe(false); c.release(event(3));
    pending.resolve({ ok: true, version: 1, sessionId: 'ps-1', revision: 2, parts: [], candidates: [], resources: [] }); await tick();
    expect(p.api.commitPaintingStroke).toHaveBeenCalledTimes(1); expect(c.getSnapshot().phase).toBe('idle');
  });
  it('keeps admitted settings immutable and blocks tool switches/history/close until terminal completes', async () => {
    const { controller: c, ports: p, frame } = fixture(); await c.open(1, 2); await frame(); await c.press(event(1));
    c.setTool('sphere'); c.setSettings({ state: 2, erase: true, radius: 7 }); c.move(event(2)); await tick();
    expect(c.getSnapshot().tool).toBe('circle');
    expect(vi.mocked(p.api.beginPaintingStroke).mock.calls[0][0].settings).toMatchObject({ state: 1, radius: 2, erase: false });
    expect(vi.mocked(p.api.samplePaintingStroke).mock.calls[0][0].settings).toMatchObject({ state: 2, radius: 7, erase: true });
    const history = vi.fn(async () => true); expect(await c.betweenStrokes(history)).toBe(false); expect(history).not.toHaveBeenCalled(); expect(await c.close()).toBe(false);
  });
  it('recoverable commit discards the failed draft and permits a fresh press', async () => {
    const { controller: c, ports: p, frame } = fixture(); await c.open(1, 2); await frame(); await c.press(event(1));
    vi.mocked(p.api.commitPaintingStroke).mockResolvedValueOnce({ error: 'allocation failed', recovered: true, sessionId: 'ps-1', revision: 3 });
    c.release(event(2)); await tick();
    expect(c.getSnapshot()).toMatchObject({ phase: 'idle', error: 'allocation failed' });
    expect(p.committed).not.toHaveBeenCalled(); expect(await c.press(event(3))).toBe('paint');
  });
  it('native initial miss owns empty-space rotation; no frontend face filter exists', async () => {
    const { controller: c, ports: p, receipt, frame } = fixture(); await c.open(1, 2); await frame();
    vi.mocked(p.api.beginPaintingStroke).mockImplementationOnce(async () => ({ ...receipt(), hit: null }));
    expect(await c.press(event(100))).toBe('camera'); expect(p.api.cancelPaintingStroke).toHaveBeenCalledTimes(1);
    expect(p.api.commitPaintingStroke).not.toHaveBeenCalled();
  });
});
describe('painting session and display ownership', () => {
  it('waits for the coordinator before opening native history', async () => {
    const { controller: c, ports: p } = fixture();
    const gate = deferred<void>();
    p.coordinate = async (operation) => { await gate.promise; return operation(); };
    const opening = c.open(1, 2);
    expect(p.api.openHistorySession).not.toHaveBeenCalled();
    gate.resolve();
    expect(await opening).toBe(true);
    expect(p.api.openHistorySession).toHaveBeenCalledTimes(1);
  });
  it('closes an active session when a project operation removes its target', async () => {
    const { controller: c, ports: p } = fixture();
    expect(await c.open(1, 2)).toBe(true);
    p.targetAvailable = () => false;
    const mutation = vi.fn(async () => 'removed');
    expect(await c.projectOperation(mutation)).toBe('removed');
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(p.api.closeHistorySession).toHaveBeenCalledTimes(1);
    expect(p.prepareClosed).toHaveBeenCalledTimes(1);
    expect(p.api.readPaintingSession).not.toHaveBeenCalled();
    expect(c.getSnapshot().phase).toBe('closed');
  });
  it('rejects a second selection during deferred target binding without replaying it later', async () => {
    const { controller: c, ports: p, frame } = fixture(); await c.open(1, 2); await frame();
    const selection = new Selection(); selection.replaceIds(['A']); selection.setAdmissionGuard(() => c.selectionAllowed());
    const pending = deferred<Awaited<ReturnType<typeof p.api.targetPaintingSession>>>();
    vi.mocked(p.api.targetPaintingSession).mockReturnValueOnce(pending.promise);
    selection.replaceIds(['B']); const change = c.target(4, 5);
    expect(selection.replaceIds(['C'])).toBe(false); expect(selection.clear()).toBe(false);
    pending.resolve({ ok: true, version: 1, session: { ...c.getSnapshot().session!, objectId: 4, instanceId: 5, revision: 2 } }); await change;
    expect([...selection.ids]).toEqual(['B']); expect(c.getSnapshot().session?.objectId).toBe(4);
    expect(p.api.targetPaintingSession).toHaveBeenCalledTimes(1); expect(selection.replaceIds(['C'])).toBe(true);
  });
  it('opens history first; switches targets in one session; retains tool settings across close', async () => {
    const { controller: c, ports: p, frame } = fixture(); await c.open(1, 2); await frame();
    expect(vi.mocked(p.api.openHistorySession).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(p.api.openPaintingSession).mock.invocationCallOrder[0]);
    c.setTool('height'); c.setSettings({ height: 9, state: 2 }); expect(await c.target(4, 5)).toBe(true);
    expect(p.api.openHistorySession).toHaveBeenCalledTimes(1); expect(await c.close()).toBe(true); await c.open(1, 2); await frame();
    expect(c.getSnapshot()).toMatchObject({ tool: 'height', settings: { height: 9, state: 2 } });
  });
  it('a failed history close remains retryable; a failed projection retries without closing history twice', async () => {
    const { controller: c, ports: p, frame } = fixture(); await c.open(1, 2); await frame();
    await c.press(event(1)); c.release(event(2)); await tick();
    vi.mocked(p.api.closeHistorySession).mockRejectedValueOnce(new Error('close failed'));
    expect(await c.close()).toBe(false); expect(c.getSnapshot().phase).toBe('idle');
    vi.mocked(p.prepareClosed).mockRejectedValueOnce(new Error('projection failed'));
    expect(await c.close()).toBe(false); expect(c.getSnapshot().phase).toBe('error');
    expect(await c.close()).toBe(true); expect(p.api.closeHistorySession).toHaveBeenCalledTimes(2);
    expect(vi.mocked(p.prepareClosed).mock.calls).toEqual([[[1]], [[1]]]);
  });
  it('returns an untouched or cancelled session to the retained Prepare scene', async () => {
    const { controller: c, ports: p, frame } = fixture(); await c.open(1, 2); await frame();
    await c.press(event(1)); c.cancel(); await tick();
    expect(await c.close()).toBe(true);
    expect(p.prepareClosed).toHaveBeenCalledExactlyOnceWith([]);
    expect(p.api.closeHistorySession).toHaveBeenCalledTimes(1);
  });
  it('refreshes all committed targets across target switches and Undo, then resets for reopening', async () => {
    const { controller: c, ports: p, frame } = fixture(); await c.open(1, 2); await frame();
    expect(await c.apply('eraseAll')).toBe(true); expect(await c.target(4, 5)).toBe(true); await frame();
    expect(await c.apply('eraseAll')).toBe(true);
    await c.betweenStrokes(async () => true); // Undo can already refresh Prepare.
    expect(await c.close()).toBe(true);
    expect(p.prepareClosed).toHaveBeenCalledExactlyOnceWith([1, 4]);
    await c.open(1, 2); await frame(); expect(await c.close()).toBe(true);
    expect(p.prepareClosed).toHaveBeenLastCalledWith([]);
  });
  it('does not refresh Prepare for an ineffective commit', async () => {
    const { controller: c, ports: p, frame, receipt } = fixture(); await c.open(1, 2); await frame();
    vi.mocked(p.api.commitPaintingStroke).mockImplementationOnce(async () => ({ ...receipt('idle'), committed: false, affectedPlateIds: [], history: status }));
    await c.apply('eraseAll'); expect(await c.close()).toBe(true);
    expect(p.prepareClosed).toHaveBeenCalledExactlyOnceWith([]);
  });
  it('does not refresh Prepare after a recovered failed commit', async () => {
    const { controller: c, ports: p, frame } = fixture(); await c.open(1, 2); await frame();
    vi.mocked(p.api.commitPaintingStroke).mockResolvedValueOnce({ error: 'allocation failed', recovered: true, sessionId: 'ps-1', revision: 3 });
    expect(await c.apply('eraseAll')).toBe(false);
    expect(await c.close()).toBe(true); expect(p.prepareClosed).toHaveBeenCalledExactlyOnceWith([]);
  });
  it('gap apply uses an exact fresh native candidate and commits all parts once', async () => {
    const { controller: c, ports: p, frame } = fixture(); await c.open(1, 2); await frame(); c.setSettings({ gapArea: 2.5 });
    expect(await c.apply('gap')).toBe(true);
    expect(p.api.beginPaintingStroke).toHaveBeenCalledWith(expect.objectContaining({ tool: 'gap', candidateRevision: 2, settings: expect.objectContaining({ gapArea: 2.5 }) }));
    expect(p.api.commitPaintingStroke).toHaveBeenCalledTimes(1); expect(p.committed).toHaveBeenCalledWith(['plate1']);
  });
  it('history reconciliation adopts latest selector revision before another stroke', async () => {
    const { controller: c, ports: p, receipt, frame } = fixture(); await c.open(1, 2); await frame();
    await c.betweenStrokes(async () => { receipt('idle'); return true; }); await c.press(event(1));
    expect(p.api.readPaintingSession).toHaveBeenCalledWith(expect.objectContaining({ latest: true }));
    expect(p.api.beginPaintingStroke).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
  });
  it('coalesces preview settings without a fixed timer and rejects stale candidates', async () => {
    const { controller: c, ports: p, receipt, frames, frame } = fixture(); await c.open(1, 2); await frame(); c.setTool('region'); c.hoverAt(event(1));
    const pending = deferred<PaintingDraftResult>(); vi.mocked(p.api.previewPainting).mockReturnValueOnce(pending.promise); frames.shift()?.();
    c.setSettings({ angle: 80 }); c.hoverAt(); pending.resolve(receipt('idle')); await tick(); await frame();
    expect(c.getSnapshot().display?.candidates).toEqual([]);
    expect(p.api.previewPainting).toHaveBeenCalledTimes(1);
  });
  it('remaps logical palette and falls back to one without losing numeric settings', () => {
    const { controller: c } = fixture(); c.setSettings({ state: 3, radius: 7 }); c.remapPalette({ 3: 2 }, 3);
    expect(c.getSnapshot().settings.state).toBe(2); c.remapPalette({ 2: 17 }, 18); expect(c.getSnapshot().settings.state).toBe(1);
    c.setSettings({ state: 4 }); c.resetProjectPalette(); expect(c.getSnapshot().settings).toMatchObject({ state: 1, radius: 7 });
  });
});

function visualFixture() {
  const f = fixture();
  let session: PaintingSessionMetadata = { id: 'ps-1', historySessionId: 'hs-1', revision: 1, objectId: 1, instanceId: 2, instanceTransform: identity, parts: [{ volumeId: 3, volumeTransform: identity, sourceTriangleCount: 1, draftResourceId: 'a', facetCounts: [] }], phase: 'idle', strokeId: null, annotation: 'mmu' };
  let palette = { slots: [{ slot: 1, colour: { effective: '#112233' } }] } as unknown as FilamentSessionSnapshot;
  f.ports.palette = () => palette;
  vi.mocked(f.ports.api.openPaintingSession).mockImplementation(async () => ({ ok: true, version: 1, session }));
  vi.mocked(f.ports.api.readPaintingSession).mockImplementation(async () => ({ ok: true, version: 1, session }));
  const geometry = (resourceId = 'a', include = true): Extract<PaintingGeometryResult, { ok: true }> => ({ ok: true, version: 1, sessionId: session.id, revision: session.revision, parts: [{ volumeId: 3, resourceId }], candidates: [], resources: include ? [{ resourceId, volumeId: 3, kind: 'draft', vertices: new Float32Array(18), groups: [[0, 0, 3]], contour: new Float32Array() }] : [] });
  vi.mocked(f.ports.api.getPaintingGeometry).mockImplementation(async () => geometry());
  const cache = new PaintingResources();
  return { ...f, cache, geometry, setSession: (next: PaintingSessionMetadata) => { session = next; },
    setPalette: (colour: string) => { palette = { ...palette, slots: [{ ...palette.slots[0], colour: { ...palette.slots[0].colour, effective: colour } }] }; },
    publish: () => { const display = f.controller.getSnapshot().display!; cache.update(display, display.session); return display; } };
}

describe.each(['triangle', 'region'] as const)('%s native hover admission and selection receipts', (tool) => {
  async function pointerPreview() {
    const f = visualFixture(), c = f.controller;
    await c.open(1, 2); await f.frame(); c.setTool(tool); await f.frame();
    vi.mocked(f.ports.api.getPaintingGeometry).mockImplementation(async () => {
      const snapshot = c.getSnapshot(), result = f.geometry();
      const resourceId = `pc-1-${snapshot.session!.revision}-3`;
      return { ...result, revision: snapshot.session!.revision,
        candidates: [{ volumeId: 3, resourceId, kind: tool }],
        resources: [...result.resources, { resourceId, volumeId: 3, kind: tool, vertices: new Float32Array(18), groups: [[0, 0, 3]], contour: new Float32Array(18) }] };
    });
    return f;
  }
  if (tool === 'triangle') {
  it('retains the matched triangle during press, admitted held movement and a newer terminal over obsolete geometry', async () => {
    const f = await pointerPreview(), c = f.controller;
    c.hoverAt(event(1)); await f.frame(); const before = c.getSnapshot().display;
    const pressResult = deferred<PaintingDraftResult>(); vi.mocked(f.ports.api.beginPaintingStroke).mockReturnValueOnce(pressResult.promise);
    const press = c.press(event(2)); expect(c.getSnapshot().display).toBe(before);
    pressResult.resolve(f.receipt()); await press; expect(c.getSnapshot().display).toBe(before);
    await f.frame(); const pressed = c.getSnapshot().display;
    const sample = deferred<PaintingDraftResult>(), geometry = deferred<PaintingGeometryResult>();
    vi.mocked(f.ports.api.samplePaintingStroke).mockReturnValueOnce(sample.promise);
    vi.mocked(f.ports.api.getPaintingGeometry).mockReturnValueOnce(geometry.promise);
    const displays: unknown[] = []; c.subscribe(() => displays.push(c.getSnapshot().display));
    expect(c.move(event(3))).toBe(true); expect(c.move(event(4))).toBe(false);
    expect(c.getSnapshot().display).toBe(pressed);
    sample.resolve(f.receipt()); await tick(); f.frames.shift()?.(); await tick();
    expect(c.getSnapshot().display).toBe(pressed);
    c.release(event(5)); geometry.resolve({ ...f.geometry('obsolete'), revision: c.getSnapshot().session!.revision }); await tick();
    expect(displays.every((display) => display === pressed)).toBe(true);
    expect(f.ports.api.commitPaintingStroke).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: event(5) }));
    await f.frame(); expect(c.getSnapshot().display?.candidates).toHaveLength(1);
    expect(f.ports.api.previewPainting).toHaveBeenLastCalledWith(expect.objectContaining({ event: event(5) }));
    expect(c.getSnapshot().display?.parts[0].resourceId).toBe('a');
  });
  }
  if (tool === 'region') {
  it('hands the retained Region hover to completed painted geometry without inventing a held candidate', async () => {
    const f = await pointerPreview(), c = f.controller;
    c.hoverAt(event(1)); await f.frame(); const before = c.getSnapshot().display;
    const pressResult = deferred<PaintingDraftResult>(), painted = deferred<PaintingGeometryResult>();
    vi.mocked(f.ports.api.beginPaintingStroke).mockReturnValueOnce(pressResult.promise);
    vi.mocked(f.ports.api.getPaintingGeometry).mockReturnValueOnce(painted.promise);
    const press = c.press(event(2), true); expect(c.getSnapshot().display).toBe(before);
    pressResult.resolve(f.receipt()); await press; f.frames.shift()?.(); await tick();
    expect(c.getSnapshot().display).toBe(before);
    painted.resolve({ ...f.geometry('painted'), revision: c.getSnapshot().session!.revision }); await tick();
    expect(c.getSnapshot().display?.parts[0].resourceId).toBe('painted');
    expect(c.getSnapshot().display?.candidates).toEqual([]);
    expect(f.ports.api.beginPaintingStroke).toHaveBeenCalledWith(expect.objectContaining({ tool: 'region', settings: expect.objectContaining({ erase: true }) }));
    const sample = deferred<PaintingDraftResult>(), geometry = deferred<PaintingGeometryResult>();
    vi.mocked(f.ports.api.samplePaintingStroke).mockReturnValueOnce(sample.promise);
    vi.mocked(f.ports.api.getPaintingGeometry).mockReturnValueOnce(geometry.promise);
    const held = c.getSnapshot().display;
    expect(c.move(event(3))).toBe(true); expect(c.move(event(4))).toBe(false);
    sample.resolve(f.receipt()); await tick(); f.frames.shift()?.(); await tick();
    c.release(event(5)); geometry.resolve({ ...f.geometry('obsolete'), revision: c.getSnapshot().session!.revision }); await tick();
    expect(c.getSnapshot().display).toBe(held);
    await f.frame(); expect(c.getSnapshot().display?.candidates).toHaveLength(1);
    expect(f.ports.api.previewPainting).toHaveBeenLastCalledWith(expect.objectContaining({ tool: 'region', event: event(5) }));
    expect(f.ports.api.commitPaintingStroke).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: event(5) }));
  });
  }
  it.each(['begin', 'sample'] as const)('replaces the retained selection with a complete native %s miss', async (stage) => {
    const f = await pointerPreview(), c = f.controller;
    c.hoverAt(event(1)); await f.frame();
    if (stage === 'sample') { await c.press(event(1)); await f.frame(); }
    const before = c.getSnapshot().display, geometry = deferred<PaintingGeometryResult>();
    vi.mocked(f.ports.api.getPaintingGeometry).mockReturnValueOnce(geometry.promise);
    if (stage === 'begin') {
      vi.mocked(f.ports.api.beginPaintingStroke).mockImplementationOnce(async () => ({ ...f.receipt(), hit: null }));
      expect(await c.press(event(100))).toBe('camera');
    } else {
      vi.mocked(f.ports.api.samplePaintingStroke).mockImplementationOnce(async () => ({ ...f.receipt(), hit: null }));
      expect(c.move(event(100))).toBe(true); await tick();
    }
    f.frames.shift()?.(); await tick(); expect(c.getSnapshot().display).toBe(before);
    geometry.resolve({ ...f.geometry(), revision: c.getSnapshot().session!.revision }); await tick();
    expect(c.getSnapshot().display?.candidates).toEqual([]);
    expect(f.ports.committed).not.toHaveBeenCalled(); f.cache.dispose();
  });
  it('clears cancellation immediately and cannot revive a selected leaf from the pending held geometry', async () => {
    const f = await pointerPreview(), c = f.controller;
    c.hoverAt(event(1)); await f.frame(); await c.press(event(1)); await f.frame(); const selected = c.getSnapshot().display!;
    const geometry = deferred<PaintingGeometryResult>(); vi.mocked(f.ports.api.getPaintingGeometry).mockReturnValueOnce(geometry.promise);
    expect(c.move(event(2))).toBe(true); await tick(); f.frames.shift()?.(); await tick();
    c.cancel(); expect(c.getSnapshot().display?.candidates).toEqual([]);
    geometry.resolve({ ...selected, revision: c.getSnapshot().session!.revision }); await tick();
    expect(c.getSnapshot().display?.candidates).toEqual([]);
    expect(f.ports.api.cancelPaintingStroke).toHaveBeenCalledTimes(1);
    await f.frame(); expect(c.getSnapshot().display?.candidates).toEqual([]);
    expect(f.ports.api.previewPainting).toHaveBeenCalledTimes(1);
  });
  it('immediately invalidates a displayed contour on leave and prevents an outstanding read restoring it', async () => {
    const f = await pointerPreview(), c = f.controller;
    c.hoverAt(event(1)); await f.frame(); const before = c.getSnapshot().display!;
    const geometry = deferred<PaintingGeometryResult>(); vi.mocked(f.ports.api.getPaintingGeometry).mockReturnValueOnce(geometry.promise);
    c.hoverAt(event(2)); f.frames.shift()?.(); await tick();
    c.hoverAt();
    expect(c.getSnapshot().display?.candidates).toEqual([]);
    expect(c.getSnapshot().display?.parts).toBe(before.parts);
    geometry.resolve({ ...before, revision: c.getSnapshot().session!.revision }); await tick();
    expect(c.getSnapshot().display?.candidates).toEqual([]);
    await f.frame(); expect(c.getSnapshot().display?.candidates).toEqual([]);
    expect(f.ports.api.previewPainting).toHaveBeenCalledTimes(2);
  });
  it('clears the candidate on native preview failure without clearing the displayed model or retrying dropped input', async () => {
    const f = await pointerPreview(), c = f.controller;
    c.hoverAt(event(1)); await f.frame(); const before = f.publish();
    const pending = deferred<PaintingDraftResult>(); vi.mocked(f.ports.api.previewPainting).mockReturnValueOnce(pending.promise);
    c.hoverAt(event(2)); f.frames.shift()?.(); await tick(); c.hoverAt(event(3));
    pending.reject(new Error('preview unavailable')); await tick();
    expect(c.getSnapshot().display?.parts).toBe(before.parts);
    expect(c.getSnapshot().display?.candidates).toEqual([]); expect(c.getSnapshot().error).toBe('preview unavailable');
    await f.frame(); expect(f.ports.api.previewPainting).toHaveBeenCalledTimes(2);
    c.hoverAt(event(4)); await f.frame(); expect(c.getSnapshot().display?.candidates).toHaveLength(1);
    expect(f.ports.api.previewPainting).toHaveBeenLastCalledWith(expect.objectContaining({ event: event(4) }));
    f.cache.dispose();
  });
  it('admits the first hover, drops all intermediate scheduled/busy moves, and accepts only a fresh later event', async () => {
    const f = await pointerPreview(), c = f.controller;
    c.hoverAt(event(1)); c.hoverAt(event(2)); c.hoverAt(event(3));
    const pending = deferred<PaintingDraftResult>(); vi.mocked(f.ports.api.previewPainting).mockReturnValueOnce(pending.promise);
    f.frames.shift()?.(); c.hoverAt(event(4)); c.hoverAt(event(5));
    pending.resolve(f.receipt('idle')); await tick(); await f.frame();
    expect(f.ports.api.previewPainting).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tool, event: event(1) }));
    expect(c.getSnapshot().display?.candidates).toHaveLength(1);
    c.hoverAt(event(6)); await f.frame();
    expect(f.ports.api.previewPainting).toHaveBeenLastCalledWith(expect.objectContaining({ event: event(6) }));
    expect(f.ports.history).toHaveBeenCalledTimes(1);
    expect(f.ports.committed).not.toHaveBeenCalled();
  });
  it.each(['leave', 'tool', 'settings'] as const)('rejects a pending pointer-preview receipt after %s without replaying a dropped move', async (mode) => {
    const f = await pointerPreview(), c = f.controller;
    c.hoverAt(event(1));
    const pending = deferred<PaintingDraftResult>(); vi.mocked(f.ports.api.previewPainting).mockReturnValueOnce(pending.promise); f.frames.shift()?.();
    c.hoverAt(event(2));
    if (mode === 'leave') c.hoverAt();
    if (mode === 'tool') c.setTool('circle');
    if (mode === 'settings') c.setSettings({ state: 2 });
    pending.resolve(f.receipt('idle')); await tick();
    expect(c.getSnapshot().display?.candidates).toEqual([]);
    expect(f.ports.api.previewPainting).toHaveBeenCalledTimes(1);
    await f.frame();
    if (mode === 'settings') {
      expect(f.ports.api.previewPainting).toHaveBeenCalledTimes(2);
      expect(f.ports.api.previewPainting).toHaveBeenLastCalledWith(expect.objectContaining({ event: event(1), settings: expect.objectContaining({ state: 2 }) }));
      expect(c.getSnapshot().display?.candidates).toHaveLength(1);
    } else expect(c.getSnapshot().display?.candidates).toEqual([]);
  });
  if (tool === 'triangle') {
  it('uses the press/sample native selection while drawing, clears held leave, and retains a busy terminal endpoint', async () => {
    const f = await pointerPreview(), c = f.controller;
    await c.press(event(1)); await f.frame();
    expect(c.getSnapshot().display?.candidates).toHaveLength(1);
    const geometry = deferred<PaintingGeometryResult>();
    vi.mocked(f.ports.api.getPaintingGeometry).mockReturnValueOnce(geometry.promise);
    expect(c.move(event(2))).toBe(true); await tick(); f.frames.shift()?.();
    expect(c.move(event(3))).toBe(false); c.hoverAt();
    expect(c.getSnapshot().display?.candidates).toEqual([]);
    c.release(event(4), true);
    expect(f.ports.api.commitPaintingStroke).not.toHaveBeenCalled();
    geometry.resolve({ ...f.geometry(), revision: c.getSnapshot().session!.revision, candidates: [{ volumeId: 3, resourceId: 'old', kind: tool }] }); await tick();
    expect(c.getSnapshot().display?.candidates).toEqual([]);
    expect(f.ports.api.commitPaintingStroke).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: event(4), settings: expect.objectContaining({ erase: true }) }));
    expect(f.ports.api.samplePaintingStroke).toHaveBeenCalledTimes(1);
    expect(f.ports.api.previewPainting).not.toHaveBeenCalled();
  });
  it('does not grant a candidate to a terminal without an endpoint after canvas leave', async () => {
    const f = await pointerPreview(), c = f.controller;
    await c.press(event(1)); await f.frame(); expect(c.getSnapshot().display?.candidates).toHaveLength(1);
    c.hoverAt(); c.release(); await tick(); await f.frame();
    expect(c.getSnapshot().display?.candidates).toEqual([]);
    expect(f.ports.api.commitPaintingStroke).toHaveBeenCalledExactlyOnceWith(expect.not.objectContaining({ event: expect.anything() }));
    expect(f.ports.api.previewPainting).not.toHaveBeenCalled(); f.cache.dispose();
  });

  }
});

describe.each(['triangle', 'region', 'gap'] as const)('%s shared candidate preview ownership', (tool) => {
  async function candidatePreview() {
    const f = visualFixture(), c = f.controller;
    await c.open(1, 2); await f.frame();
    vi.mocked(f.ports.api.targetPaintingSession).mockImplementation(async (request) => {
      const session = { ...c.getSnapshot().session!, objectId: request.objectId, instanceId: request.instanceId, revision: c.getSnapshot().session!.revision + 1 };
      f.setSession(session); return { ok: true, version: 1, session };
    });
    vi.mocked(f.ports.api.previewPainting).mockImplementation(async () => ({ ...f.receipt('idle'), revision: c.getSnapshot().session!.revision + 1 }));
    const candidateGeometry = (id = `candidate-${c.getSnapshot().session!.revision}`, draft = 'a', includeDraft = true): Extract<PaintingGeometryResult, { ok: true }> => {
      const result = f.geometry(draft, includeDraft);
      return { ...result, revision: c.getSnapshot().session!.revision,
        candidates: [{ volumeId: 3, resourceId: id, kind: tool }],
        resources: [...result.resources, { resourceId: id, volumeId: 3, kind: tool, vertices: new Float32Array(18).fill(1), groups: [[0, 0, 3]], contour: new Float32Array(tool === 'gap' ? 0 : 18) }] };
    };
    vi.mocked(f.ports.api.getPaintingGeometry).mockImplementation(async () => candidateGeometry());
    c.setTool(tool); c.setSettings({ gapArea: 3 }); if (tool !== 'gap') c.hoverAt(event(1)); await f.frame(); f.publish();
    return { ...f, candidateGeometry };
  }
  it('preserves the exact display/resource/palette through settings preview and geometry, then replaces together or clears a complete empty result', async () => {
    const f = await candidatePreview(), c = f.controller, before = f.publish();
    const selected = f.cache.resources.get(before.candidates[0].resourceId)!, disposed = vi.spyOn(selected.contour, 'dispose');
    const displays: unknown[] = [], unsubscribe = c.subscribe(() => { displays.push(c.getSnapshot().display); f.publish(); });
    const preview = deferred<PaintingDraftResult>(), geometry = deferred<PaintingGeometryResult>();
    vi.mocked(f.ports.api.previewPainting).mockReturnValueOnce(preview.promise);
    vi.mocked(f.ports.api.getPaintingGeometry).mockReturnValueOnce(geometry.promise);
    c.setSettings({ gapArea: 4, state: 2 }); f.frames.shift()?.(); await tick();
    if (tool === 'gap') { c.hoverAt(event(1)); c.hoverAt(); } preview.resolve(f.receipt('idle')); await tick();
    if (tool === 'gap') { c.hoverAt(event(100)); c.hoverAt(); } f.setPalette('#445566');
    expect(c.getSnapshot().display).toBe(before); expect(displays.every((d) => d === before)).toBe(true);
    expect(f.cache.resources.get(before.candidates[0].resourceId)).toBe(selected); expect(disposed).not.toHaveBeenCalled();
    expect(before.palette?.slots[0].colour.effective).toBe('#112233');
    const next = f.candidateGeometry('new', 'b'); geometry.resolve(next); await tick();
    expect(c.getSnapshot().display).toMatchObject({ candidates: next.candidates, parts: next.parts, palette: { slots: [{ colour: { effective: '#445566' } }] } });
    expect(c.getSnapshot().display?.session).toBe(c.getSnapshot().session);
    expect(disposed).toHaveBeenCalledTimes(1); expect(f.cache.resources.size).toBe(2);
    expect(f.ports.api.previewPainting).toHaveBeenLastCalledWith(expect.objectContaining({ tool, settings: expect.objectContaining({ gapArea: 4, state: 2 }) }));
    expect(vi.mocked(f.ports.api.previewPainting).mock.calls.every(([r]) => tool === 'gap' ? !('event' in r) : JSON.stringify(r.event) === JSON.stringify(event(1)))).toBe(true);
    const matched = c.getSnapshot().display, empty = deferred<PaintingGeometryResult>();
    vi.mocked(f.ports.api.getPaintingGeometry).mockReturnValueOnce(empty.promise);
    c.setSettings({ gapArea: 0 }); f.frames.shift()?.(); await tick(); expect(c.getSnapshot().display).toBe(matched);
    empty.resolve({ ...f.geometry('b', false), revision: c.getSnapshot().session!.revision }); await tick();
    expect(c.getSnapshot().display?.candidates).toEqual([]); expect(f.cache.resources.size).toBe(1);
    unsubscribe(); f.cache.dispose();
  });
  if (tool === 'gap') {
  it('owns model/empty-space camera presses and retains static candidates without any RPC or history changes', async () => {
    const f = await candidatePreview(), c = f.controller, before = c.getSnapshot().display;
    const snapshot = c.getSnapshot(), calls = Object.values(f.ports.api).map((api) => vi.mocked(api).mock.calls.length);
    const selected = f.cache.resources.get(before!.candidates[0].resourceId), disposed = vi.spyOn(selected!.geometry, 'dispose');
    for (const point of [event(100), event(1)]) {
      expect(await c.press(point)).toBe('camera'); expect(c.move(event(2))).toBe(false); c.release(event(3)); c.cancel();
      expect(c.getSnapshot()).toBe(snapshot);
    }
    for (const point of [event(1), event(100), undefined, event(2), undefined]) c.hoverAt(point);
    await f.frame(); expect(c.getSnapshot().display).toBe(before);
    expect(Object.values(f.ports.api).map((api) => vi.mocked(api).mock.calls.length)).toEqual(calls);
    expect(f.cache.resources.get(before!.candidates[0].resourceId)).toBe(selected); expect(disposed).not.toHaveBeenCalled();
    expect(f.ports.history).toHaveBeenCalledTimes(1); expect(f.ports.committed).not.toHaveBeenCalled(); f.cache.dispose();
  });
  it('drops busy Gap presses without queuing and waits for a complete idle target before camera admission', async () => {
    const f = await candidatePreview(), c = f.controller;
    const pending = deferred<PaintingDraftResult>(); vi.mocked(f.ports.api.previewPainting).mockReturnValueOnce(pending.promise);
    c.setSettings({ gapArea: 4 }); f.frames.shift()?.(); await tick();
    expect(await c.press(event(100))).toBe('ignored'); c.release(event(1));
    pending.resolve(f.receipt('idle')); await tick(); await f.frame();
    expect(f.ports.api.beginPaintingStroke).not.toHaveBeenCalled(); expect(await c.press(event(1))).toBe('camera');
    const target = c.target(4, 5); expect(await c.press(event(1))).toBe('ignored');
    await target; expect(await c.press(event(1))).toBe('ignored');
    await f.frame(); expect(await c.press(event(1))).toBe('camera');
    const applyResult = deferred<PaintingDraftResult>(); vi.mocked(f.ports.api.beginPaintingStroke).mockReturnValueOnce(applyResult.promise);
    const commitResult = deferred<Awaited<ReturnType<typeof f.ports.api.commitPaintingStroke>>>(); vi.mocked(f.ports.api.commitPaintingStroke).mockReturnValueOnce(commitResult.promise);
    const apply = c.apply('gap'); await tick();
    expect(c.unfinished).toBe(true); expect(await c.press(event(1))).toBe('ignored');
    applyResult.resolve(f.receipt('finished')); await tick(); expect(c.getSnapshot().phase).toBe('ending'); expect(await c.press(event(1))).toBe('ignored');
    commitResult.resolve({ ...f.receipt('idle'), committed: true, affectedPlateIds: ['plate1'], history: status }); await apply; await f.frame();
    expect(await c.press(event(1))).toBe('camera');
    const cancelled = deferred<PaintingDraftResult>(); vi.mocked(f.ports.api.beginPaintingStroke).mockReturnValueOnce(cancelled.promise);
    const cancelledApply = c.apply('gap'); await tick(); c.cancel();
    expect(c.getSnapshot().phase).toBe('cancelling'); expect(await c.press(event(1))).toBe('ignored');
    cancelled.resolve(f.receipt('finished')); await cancelledApply; await f.frame(); expect(await c.press(event(1))).toBe('camera');
    const close = c.close(); expect(await c.press(event(1))).toBe('ignored'); await close;
    expect(await c.press(event(1))).toBe('ignored'); f.cache.dispose();
  });
  }
  it.each(['preview', 'geometry'] as const)('discards obsolete %s work across successive settings without corrupting known resources', async (stage) => {
    const f = await candidatePreview(), c = f.controller, before = f.publish();
    const preview = deferred<PaintingDraftResult>(), geometry = deferred<PaintingGeometryResult>();
    vi.mocked(f.ports.api.previewPainting).mockReturnValueOnce(preview.promise);
    vi.mocked(f.ports.api.getPaintingGeometry).mockReturnValueOnce(geometry.promise);
    c.setSettings({ gapArea: 4 }); f.frames.shift()?.(); await tick();
    if (stage === 'geometry') { preview.resolve(f.receipt('idle')); await tick(); }
    c.setSettings({ state: 2, gapArea: 3.5 });
    if (stage === 'preview') { preview.resolve(f.receipt('idle')); await tick(); }
    geometry.resolve(f.candidateGeometry('obsolete', 'obsolete-draft')); await tick();
    expect(c.getSnapshot().display).toBe(before); expect(f.cache.resources.has('obsolete')).toBe(false);
    await f.frame(); const after = f.publish();
    expect(after.candidates).toHaveLength(1); expect(after.resources.some((r) => r.resourceId.startsWith('obsolete'))).toBe(false);
    expect(f.ports.api.getPaintingGeometry).toHaveBeenLastCalledWith(expect.objectContaining({ knownResourceIds: before.resources.map((r) => r.resourceId) }));
    expect(f.ports.api.previewPainting).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ state: 2, gapArea: 3.5 }) })); f.cache.dispose();
  });
  it.each(['tool', 'target', 'error', 'close'].flatMap((mode) => (['preview', 'geometry'] as const).map((stage) => ({ mode, stage }))))('invalidates immediately on $mode and does not resurrect from pending $stage', async ({ mode, stage }) => {
    const f = await candidatePreview(), c = f.controller, before = c.getSnapshot().display!;
    const preview = deferred<PaintingDraftResult>(); vi.mocked(f.ports.api.previewPainting).mockReturnValueOnce(preview.promise);
    const geometry = deferred<PaintingGeometryResult>(); vi.mocked(f.ports.api.getPaintingGeometry).mockReturnValueOnce(geometry.promise);
    c.setSettings({ gapArea: 4 }); f.frames.shift()?.(); await tick();
    if (stage === 'geometry') { preview.resolve(f.receipt('idle')); await tick(); }
    let command: Promise<boolean> | undefined;
    if (mode === 'tool') c.setTool('circle');
    if (mode === 'target') command = c.target(4, 5);
    if (mode === 'error') c.reportDisplayError(new Error('renderer failed'));
    if (mode === 'close') command = c.close();
    expect(c.getSnapshot().display?.candidates).toEqual([]); expect(c.getSnapshot().display?.parts).toBe(before.parts);
    if (stage === 'preview') { preview.resolve(f.receipt('idle')); await tick(); }
    geometry.resolve(f.candidateGeometry('obsolete')); await tick(); if (command) expect(await command).toBe(true);
    expect(c.getSnapshot().display?.candidates ?? []).toEqual([]);
    if (mode === 'target') {
      if (tool !== 'gap') c.hoverAt(event(4));
      const pending = deferred<PaintingDraftResult>(); vi.mocked(f.ports.api.previewPainting).mockReturnValueOnce(pending.promise);
      f.frames.shift()?.(); await tick(); expect(c.getSnapshot().display?.candidates).toEqual([]);
      pending.resolve(f.receipt('idle')); await tick(); expect(c.getSnapshot().display?.session.objectId).toBe(4); expect(c.getSnapshot().display?.candidates).toHaveLength(1);
    } else { await f.frame(); expect(c.getSnapshot().display?.candidates ?? []).toEqual([]); }
    expect(c.getSnapshot().display?.resources.some((r) => r.resourceId === 'obsolete') ?? false).toBe(false); f.cache.dispose();
  });
  it.each(['preview', 'geometry'] as const)('clears on %s failure and keeps the model without automatic candidate resurrection', async (stage) => {
    const f = await candidatePreview(), c = f.controller, before = c.getSnapshot().display!;
    if (stage === 'preview') vi.mocked(f.ports.api.previewPainting).mockRejectedValueOnce(new Error('native failed'));
    else vi.mocked(f.ports.api.getPaintingGeometry).mockRejectedValueOnce(new Error('native failed'));
    c.setSettings({ gapArea: 4 }); await f.frame();
    expect(c.getSnapshot().display?.parts).toBe(before.parts); expect(c.getSnapshot().display?.candidates).toEqual([]); expect(c.getSnapshot().error).toBe('native failed');
    await f.frame(); await f.frame(); expect(c.getSnapshot().display?.candidates).toEqual([]);
    // An explicit complete native refresh, rather than old geometry, restores it.
    c.setSettings({ gapArea: 3 }); if (tool !== 'gap') c.hoverAt(event(4)); await f.frame(); expect(c.getSnapshot().display?.candidates).toHaveLength(1); f.cache.dispose();
  });
  it('does not revive old native candidates in the model-only refresh after a commit failure', async () => {
    const f = await candidatePreview(), c = f.controller, before = c.getSnapshot().display!;
    vi.mocked(f.ports.api.commitPaintingStroke).mockRejectedValueOnce(new Error('commit failed'));
    if (tool === 'gap') expect(await c.apply('gap')).toBe(false);
    else { await c.press(event(2)); c.release(event(3)); await tick(); } expect(c.getSnapshot().display?.candidates).toEqual([]);
    expect(c.getSnapshot().display?.parts).toBe(before.parts); expect(c.getSnapshot().error).toBe('commit failed');
    await f.frame(); expect(c.getSnapshot().display?.candidates).toEqual([]); expect(f.ports.api.previewPainting).toHaveBeenCalledTimes(tool === 'gap' ? 2 : 1);
    expect(f.ports.history).toHaveBeenCalledTimes(1); expect(f.ports.committed).not.toHaveBeenCalled();
    c.setSettings({ gapArea: 4 }); if (tool !== 'gap') c.hoverAt(event(4)); await f.frame(); expect(c.getSnapshot().display?.candidates).toHaveLength(1); f.cache.dispose();
  });
  it.each(['project', 'history'].flatMap((kind) => (['preview', 'geometry'] as const).map((stage) => ({ kind, stage }))))('reserves a $kind mutation behind pending $stage and refreshes a matched native preview', async ({ kind, stage }) => {
    const f = await candidatePreview(), c = f.controller, before = f.publish();
    const preview = deferred<PaintingDraftResult>(); vi.mocked(f.ports.api.previewPainting).mockReturnValueOnce(preview.promise);
    const geometry = deferred<PaintingGeometryResult>(); vi.mocked(f.ports.api.getPaintingGeometry).mockReturnValueOnce(geometry.promise);
    c.setSettings({ gapArea: 4 }); f.frames.shift()?.(); await tick();
    if (stage === 'geometry') { preview.resolve(f.receipt('idle')); await tick(); }
    const operation = vi.fn(async () => { f.setSession({ ...c.getSnapshot().session!, revision: 10 }); f.setPalette('#abcdef'); return true; });
    const command = kind === 'history' ? c.betweenStrokes(operation) : c.projectOperation(operation);
    expect(operation).not.toHaveBeenCalled();
    if (stage === 'preview') { preview.resolve(f.receipt('idle')); await tick(); }
    geometry.resolve(f.candidateGeometry('obsolete')); await tick(); expect(await command).toBe(true);
    expect(c.getSnapshot().display).toBe(before); expect(before.palette?.slots[0].colour.effective).toBe('#112233');
    await f.frame(); const after = f.publish(); expect(after.session.revision).toBe(11); expect(after.candidates).toHaveLength(1);
    expect(after.palette?.slots[0].colour.effective).toBe('#abcdef');
    expect(f.ports.api.getPaintingGeometry).toHaveBeenLastCalledWith(expect.objectContaining({ knownResourceIds: before.resources.map((r) => r.resourceId) })); f.cache.dispose();
  });
});

describe('complete painting visual handoffs', () => {
  it('keeps the opening fallback until the complete native resource receipt and rejects invisible-target input', async () => {
    const f = visualFixture(), c = f.controller;
    await c.open(1, 2);
    const pending = deferred<Awaited<ReturnType<typeof f.ports.api.getPaintingGeometry>>>();
    vi.mocked(f.ports.api.getPaintingGeometry).mockReturnValueOnce(pending.promise);
    expect(c.getSnapshot().display).toBeNull(); expect(await c.press(event(1))).toBe('ignored');
    f.frames.shift()?.(); await tick();
    expect(c.getSnapshot().display).toBeNull(); expect(f.cache.resources.size).toBe(0);
    pending.resolve(f.geometry()); await tick(); const display = f.publish();
    expect(display.session).toBe(c.getSnapshot().session); expect(display.palette?.slots[0].colour.effective).toBe('#112233');
    expect(f.cache.resources.size).toBe(1); f.cache.dispose();
  });
  it('retains the old matched bundle during a palette operation and changes colour without rebuilding geometry', async () => {
    const f = visualFixture(), c = f.controller; await c.open(1, 2); await f.frame();
    const before = f.publish(), mesh = f.cache.resources.get('a')!, disposal = vi.spyOn(mesh.geometry, 'dispose');
    const operation = deferred<void>(), replacement = deferred<Awaited<ReturnType<typeof f.ports.api.getPaintingGeometry>>>();
    vi.mocked(f.ports.api.getPaintingGeometry).mockReturnValueOnce(replacement.promise);
    const command = c.projectOperation(async () => { await operation.promise; f.setPalette('#445566'); });
    expect(c.getSnapshot().display).toBe(before); operation.resolve(); await command;
    f.frames.shift()?.(); await tick();
    expect(c.getSnapshot().display).toBe(before); expect(before.palette?.slots[0].colour.effective).toBe('#112233');
    expect(disposal).not.toHaveBeenCalled(); expect(f.ports.api.getPaintingGeometry).toHaveBeenLastCalledWith(expect.objectContaining({ knownResourceIds: ['a'] }));
    replacement.resolve(f.geometry('a', false)); await tick(); const after = f.publish();
    expect(after.palette?.slots[0].colour.effective).toBe('#445566'); expect(f.cache.resources.get('a')).toBe(mesh); expect(disposal).not.toHaveBeenCalled(); f.cache.dispose();
  });
  it('holds old matrices and palette through same-target transform changes, missing resources and a later complete replacement', async () => {
    const f = visualFixture(), c = f.controller; await c.open(1, 2); await f.frame(); const before = f.publish();
    const old = f.cache.resources.get('a')!, disposed = vi.spyOn(old.geometry, 'dispose');
    const latest = { ...before.session, revision: 2, instanceTransform: new THREE.Matrix4().makeTranslation(10, 20, 30).toArray(), parts: [{ ...before.session.parts[0], draftResourceId: 'b' }] };
    await c.projectOperation(async () => { f.setSession(latest); f.setPalette('#abcdef'); });
    expect(c.getSnapshot().session).toBe(latest); expect(c.getSnapshot().display).toBe(before);
    expect(await c.press(event(1))).toBe('ignored'); expect(await c.apply('eraseAll')).toBe(false);
    expect(paintingPartMatrix(before.session, 3).elements).toEqual(identity);
    vi.mocked(f.ports.api.getPaintingGeometry).mockResolvedValueOnce(f.geometry('missing', false)); await f.frame();
    expect(c.getSnapshot().error).toContain('Missing painting resource'); expect(c.getSnapshot().display).toBe(before); expect(disposed).not.toHaveBeenCalled();
    await c.projectOperation(async () => true); vi.mocked(f.ports.api.getPaintingGeometry).mockResolvedValueOnce({ ...f.geometry('b'), parts: [] }); await f.frame();
    expect(c.getSnapshot().error).toBe('Incomplete painting parts'); expect(c.getSnapshot().display).toBe(before); expect(disposed).not.toHaveBeenCalled();
    expect(f.ports.api.getPaintingGeometry).toHaveBeenLastCalledWith(expect.objectContaining({ knownResourceIds: ['a'] }));
    await c.projectOperation(async () => true); vi.mocked(f.ports.api.getPaintingGeometry).mockResolvedValueOnce(f.geometry('b')); await f.frame();
    const after = f.publish(); expect(after.session).toBe(latest); expect(after.palette?.slots[0].colour.effective).toBe('#abcdef');
    expect(paintingPartMatrix(after.session, 3).elements.slice(12, 15)).toEqual([10, 20, 30]); expect(disposed).toHaveBeenCalledTimes(1);
    expect(await c.press(event(1))).toBe('paint'); c.cancel(); await tick(); f.cache.dispose();
  });
  it('keeps a complete visual on latest-session failure and failed recovery, and permits explicit cleanup', async () => {
    const f = visualFixture(), c = f.controller; await c.open(1, 2); await f.frame(); const before = f.publish();
    vi.mocked(f.ports.api.readPaintingSession).mockRejectedValue(new Error('read unavailable'));
    await expect(c.projectOperation(async () => true)).rejects.toThrow('read unavailable');
    expect(c.getSnapshot()).toMatchObject({ phase: 'error', display: before }); expect(f.cache.resources.size).toBe(1); expect(await c.press(event(1))).toBe('ignored');
    expect(await c.close()).toBe(true); expect(c.getSnapshot().display).toBeNull(); f.cache.dispose(); expect(f.cache.resources.size).toBe(0);
  });
  it('cancels a draft retained by renderer failure before closing history, with safe cancellation/history retries', async () => {
    const f = fixture(), c = f.controller; await c.open(1, 2); await f.frame();
    expect(await c.press(event(1))).toBe('paint'); c.reportDisplayError(new Error('renderer allocation failed'));
    vi.mocked(f.ports.api.cancelPaintingStroke).mockRejectedValueOnce(new Error('cancel failed'));
    expect(await c.close()).toBe(false); expect(c.getSnapshot().phase).toBe('error'); expect(c.getSnapshot().session?.strokeId).not.toBeNull();
    expect(f.ports.api.closeHistorySession).not.toHaveBeenCalled();
    vi.mocked(f.ports.api.closeHistorySession).mockRejectedValueOnce(new Error('history close failed'));
    expect(await c.close()).toBe(false); expect(c.getSnapshot().phase).toBe('error'); expect(c.getSnapshot().session?.strokeId).toBeNull();
    expect(f.ports.api.cancelPaintingStroke).toHaveBeenCalledTimes(2);
    const cancellation = vi.mocked(f.ports.api.cancelPaintingStroke).mock.invocationCallOrder[1];
    expect(cancellation).toBeLessThan(vi.mocked(f.ports.api.closeHistorySession).mock.invocationCallOrder[0]);
    expect(await c.close()).toBe(true); expect(c.getSnapshot().phase).toBe('closed');
    expect(f.ports.api.cancelPaintingStroke).toHaveBeenCalledTimes(2); expect(f.ports.api.closeHistorySession).toHaveBeenCalledTimes(2);
    expect(f.ports.api.commitPaintingStroke).not.toHaveBeenCalled();
  });
  it('retains target A until target B geometry is complete and rejects stale results and renderer publication failures', async () => {
    const f = visualFixture(), c = f.controller; await c.open(1, 2); await f.frame(); const before = f.publish();
    const next = { ...before.session, objectId: 4, instanceId: 5, revision: 2, instanceTransform: new THREE.Matrix4().makeTranslation(40, 50, 60).toArray() };
    vi.mocked(f.ports.api.targetPaintingSession).mockResolvedValueOnce({ ok: true, version: 1, session: next });
    await c.target(4, 5); expect(c.getSnapshot().display).toBe(before); expect(await c.press(event(1))).toBe('ignored');
    vi.mocked(f.ports.api.getPaintingGeometry).mockResolvedValueOnce(f.geometry()); await f.frame();
    expect(c.getSnapshot().display).toBe(before); expect(f.cache.resources.size).toBe(1);
    f.setSession(next); await c.projectOperation(async () => true); vi.mocked(f.ports.api.getPaintingGeometry).mockResolvedValueOnce(f.geometry('b')); await f.frame();
    const after = c.getSnapshot().display!; expect(after.session.instanceId).toBe(5); expect(after.session.instanceTransform.slice(12, 15)).toEqual([40, 50, 60]);
    c.reportDisplayError(new Error('allocation failed')); expect(c.getSnapshot().phase).toBe('error'); expect(await c.press(event(1))).toBe('ignored'); expect(await c.close()).toBe(true); f.cache.dispose();
  });
});
