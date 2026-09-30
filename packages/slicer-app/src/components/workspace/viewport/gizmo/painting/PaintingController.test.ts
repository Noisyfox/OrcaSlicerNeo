import { describe, expect, it, vi } from 'vitest';
import type { HistoryStatus, PaintingDraftResult, PaintingSessionMetadata, PaintingPointerEvent } from '@slicer/client';
import { PaintingController, type PaintingPorts } from './PaintingController';
import { Selection } from '../../Selection';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const event = (x: number): PaintingPointerEvent => ({ pointer: [x, 2], viewport: [0, 0, 100, 100], projection: identity, view: identity });
const status = { revision: 1 } as HistoryStatus;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
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
    const { controller: c, ports: p, receipt } = fixture(); await c.open(1, 2);
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
    const { controller: c, ports: p, receipt } = fixture(); await c.open(1, 2); await c.press(event(1));
    const pending = deferred<PaintingDraftResult>(); vi.mocked(p.api.samplePaintingStroke).mockReturnValueOnce(pending.promise);
    expect(c.move(event(2))).toBe(true); c.release(event(3)); c.cancel();
    expect(c.move(event(4))).toBe(false); expect(await c.press(event(5))).toBe('ignored');
    pending.resolve(receipt()); await tick();
    expect(p.api.cancelPaintingStroke).toHaveBeenCalledTimes(1); expect(p.api.commitPaintingStroke).not.toHaveBeenCalled();
    expect(c.getSnapshot().phase).toBe('idle'); c.release(event(6)); expect(p.api.commitPaintingStroke).not.toHaveBeenCalled();
  });
  it('focus/capture interruptions commit once without sampling the interruption', async () => {
    const { controller: c, ports: p } = fixture(); await c.open(1, 2); await c.press(event(1));
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
    const { controller: c, ports: p, frames } = fixture(); await c.open(1, 2); await c.press(event(1));
    const pending = deferred<Awaited<ReturnType<typeof p.api.getPaintingGeometry>>>(); vi.mocked(p.api.getPaintingGeometry).mockReturnValueOnce(pending.promise); frames.shift()?.();
    expect(c.move(event(2))).toBe(false); c.release(event(3));
    pending.resolve({ ok: true, version: 1, sessionId: 'ps-1', revision: 2, parts: [], candidates: [], resources: [] }); await tick();
    expect(p.api.commitPaintingStroke).toHaveBeenCalledTimes(1); expect(c.getSnapshot().phase).toBe('idle');
  });
  it('keeps admitted settings immutable and blocks tool switches/history/close until terminal completes', async () => {
    const { controller: c, ports: p } = fixture(); await c.open(1, 2); await c.press(event(1));
    c.setTool('sphere'); c.setSettings({ state: 2, erase: true, radius: 7 }); c.move(event(2)); await tick();
    expect(c.getSnapshot().tool).toBe('circle');
    expect(vi.mocked(p.api.beginPaintingStroke).mock.calls[0][0].settings).toMatchObject({ state: 1, radius: 2, erase: false });
    expect(vi.mocked(p.api.samplePaintingStroke).mock.calls[0][0].settings).toMatchObject({ state: 2, radius: 7, erase: true });
    const history = vi.fn(async () => true); expect(await c.betweenStrokes(history)).toBe(false); expect(history).not.toHaveBeenCalled(); expect(await c.close()).toBe(false);
  });
  it('recoverable commit discards the failed draft and permits a fresh press', async () => {
    const { controller: c, ports: p } = fixture(); await c.open(1, 2); await c.press(event(1));
    vi.mocked(p.api.commitPaintingStroke).mockResolvedValueOnce({ error: 'allocation failed', recovered: true, sessionId: 'ps-1', revision: 3 });
    c.release(event(2)); await tick();
    expect(c.getSnapshot()).toMatchObject({ phase: 'idle', error: 'allocation failed' });
    expect(p.committed).not.toHaveBeenCalled(); expect(await c.press(event(3))).toBe('paint');
  });
  it('native initial miss owns empty-space rotation; no frontend face filter exists', async () => {
    const { controller: c, ports: p, receipt } = fixture(); await c.open(1, 2);
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
    const { controller: c, ports: p } = fixture(); await c.open(1, 2);
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
    const { controller: c, ports: p } = fixture(); await c.open(1, 2);
    expect(vi.mocked(p.api.openHistorySession).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(p.api.openPaintingSession).mock.invocationCallOrder[0]);
    c.setTool('height'); c.setSettings({ height: 9, state: 2 }); expect(await c.target(4, 5)).toBe(true);
    expect(p.api.openHistorySession).toHaveBeenCalledTimes(1); expect(await c.close()).toBe(true); await c.open(1, 2);
    expect(c.getSnapshot()).toMatchObject({ tool: 'height', settings: { height: 9, state: 2 } });
  });
  it('a failed history close remains retryable; a failed projection retries without closing history twice', async () => {
    const { controller: c, ports: p } = fixture(); await c.open(1, 2);
    vi.mocked(p.api.closeHistorySession).mockRejectedValueOnce(new Error('close failed'));
    expect(await c.close()).toBe(false); expect(c.getSnapshot().phase).toBe('idle');
    vi.mocked(p.prepareClosed).mockRejectedValueOnce(new Error('projection failed'));
    expect(await c.close()).toBe(false); expect(c.getSnapshot().phase).toBe('error');
    expect(await c.close()).toBe(true); expect(p.api.closeHistorySession).toHaveBeenCalledTimes(2);
  });
  it('gap apply uses an exact fresh native candidate and commits all parts once', async () => {
    const { controller: c, ports: p } = fixture(); await c.open(1, 2); c.setSettings({ gapArea: 2.5 });
    expect(await c.apply('gap')).toBe(true);
    expect(p.api.beginPaintingStroke).toHaveBeenCalledWith(expect.objectContaining({ tool: 'gap', candidateRevision: 2, settings: expect.objectContaining({ gapArea: 2.5 }) }));
    expect(p.api.commitPaintingStroke).toHaveBeenCalledTimes(1); expect(p.committed).toHaveBeenCalledWith(['plate1']);
  });
  it('history reconciliation adopts latest selector revision before another stroke', async () => {
    const { controller: c, ports: p, receipt } = fixture(); await c.open(1, 2);
    await c.betweenStrokes(async () => { receipt('idle'); return true; }); await c.press(event(1));
    expect(p.api.readPaintingSession).toHaveBeenCalledWith(expect.objectContaining({ latest: true }));
    expect(p.api.beginPaintingStroke).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
  });
  it('coalesces preview settings without a fixed timer and rejects stale candidates', async () => {
    const { controller: c, ports: p, receipt, frames, frame } = fixture(); await c.open(1, 2); c.setTool('region'); c.hoverAt(event(1));
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
