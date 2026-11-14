import { describe, expect, it, vi } from 'vitest';
import type { MeasureApi, MeasureDisplay, MeasurePlane, MeasurePointerEvent, MeasureReceipt, MeasureStatus, MeasureTarget } from '@slicer/client';
import { MeasureController, type MeasurePorts } from './MeasureController';

const target: MeasureTarget = { objectId: 1, instanceId: 2, volumeId: 3 };
const other: MeasureTarget = { objectId: 4, instanceId: 5, volumeId: 6 };
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const event = (x: number): MeasurePointerEvent => ({ pointer: [x, 20], viewport: [0, 0, 100, 100], projection: [...identity], view: [...identity] });
const item = { target, kind: 'feature' as const, source: { type: 'point' as const, point: [1, 2, 3] as const },
  value: { type: 'point' as const, point: [1, 2, 3] as const } };
const status = (sessionId = 'ms-1', selectionRevision = 1, targetRevision = 1): MeasureStatus => ({
  ok: true, version: 1, sessionId, targetRevision, selectionRevision, first: null, second: null, sameTarget: false, result: null,
});
const display = (id: string, state = status()): MeasureDisplay => ({ ...state, displayId: id, hover: null,
  markers: [{ index: 0, position: [1, 2, 3], item }] });
const receipt = (selectionRevision: number): MeasureReceipt => ({ ...status('ms-1', selectionRevision), outcome: 'selected', first: item, sameTarget: true });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function tick() { for (let i = 0; i < 8; ++i) await Promise.resolve(); }

function fixture() {
  let selectionRevision = 1, nextDisplay = 1, canMeasure = true, admission = 'serial:0';
  const api = {
    openMeasureSession: vi.fn<MeasureApi['openMeasureSession']>(async () => status()),
    readMeasureSession: vi.fn<MeasureApi['readMeasureSession']>(async () => status('ms-1', selectionRevision)),
    getMeasureDisplay: vi.fn<MeasureApi['getMeasureDisplay']>(async () => display(`md-${nextDisplay++}`, status('ms-1', selectionRevision))),
    clickMeasure: vi.fn<MeasureApi['clickMeasure']>(async () => receipt(++selectionRevision)),
    resetMeasure: vi.fn<MeasureApi['resetMeasure']>(async () => ({ ...status('ms-1', ++selectionRevision), outcome: 'selected' })),
    rebaseMeasure: vi.fn<MeasureApi['rebaseMeasure']>(async () => status('ms-1', ++selectionRevision, 2)),
    closeMeasureSession: vi.fn<MeasureApi['closeMeasureSession']>(async request => ({ ok: true, version: 1, sessionId: request.sessionId })),
    releaseMeasureDisplay: vi.fn<MeasureApi['releaseMeasureDisplay']>(async () => {}),
    getMeasurePlane: vi.fn<MeasureApi['getMeasurePlane']>(async () => ({ error: 'unexpected plane' })),
  };
  const ports: MeasurePorts = { api: api as unknown as MeasureApi, coordinate: async operation => operation(),
    canMeasure: () => canMeasure, admissionKey: () => admission, invalidate: vi.fn() };
  const controller = new MeasureController(ports);
  return { controller, api, ports, setCanMeasure: (value: boolean) => { canMeasure = value; },
    setAdmission: (value: string) => { admission = value; } };
}

describe('Measure controller lifecycle', () => {
  it('closes locally while open is pending and releases its late session', async () => {
    const { controller, api } = fixture();
    const opening = deferred<MeasureStatus>(); api.openMeasureSession.mockReturnValueOnce(opening.promise);
    const opened = controller.open([target]); await tick();
    expect(controller.getSnapshot().phase).toBe('opening');
    const closed = controller.close();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'closed', status: null, targets: [] });
    opening.resolve(status());
    expect(await opened).toBe(false); await closed;
    expect(api.closeMeasureSession).toHaveBeenCalledExactlyOnceWith({ version: 1, sessionId: 'ms-1' });
    expect(controller.getSnapshot().phase).toBe('closed');
  });

  it('cannot let a late opening or cleanup close the retargeted session', async () => {
    const { controller, api } = fixture();
    const first = deferred<MeasureStatus>(); api.openMeasureSession.mockReturnValueOnce(first.promise).mockResolvedValueOnce(status('ms-2'));
    const a = controller.open([target]); await tick(); const b = controller.open([other]);
    first.resolve(status());
    expect(await a).toBe(false); expect(await b).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', targets: [other], status: { sessionId: 'ms-2' } });
    expect(api.closeMeasureSession).toHaveBeenCalledExactlyOnceWith({ version: 1, sessionId: 'ms-1' });
  });

  it('does not let an obsolete hover error close a later target', async () => {
    const { controller, api } = fixture(); await controller.open([target]);
    const pending = deferred<MeasureDisplay>(); api.getMeasureDisplay.mockReturnValueOnce(pending.promise);
    controller.hover(event(1)); await tick();
    api.openMeasureSession.mockResolvedValueOnce(status('ms-2'));
    const retarget = controller.open([other]); pending.reject(new Error('old hover failed'));
    expect(await retarget).toBe(true); await tick();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', status: { sessionId: 'ms-2' }, error: null });
    expect(api.closeMeasureSession).toHaveBeenCalledExactlyOnceWith({ version: 1, sessionId: 'ms-1' });
  });

  it('does not report old resource cleanup errors on a successor session', async () => {
    const { controller, api } = fixture(); await controller.open([target]);
    controller.hover(event(1)); await tick();
    const release = deferred<void>(); api.releaseMeasureDisplay.mockReturnValueOnce(release.promise);
    api.openMeasureSession.mockResolvedValueOnce(status('ms-2'));
    const retarget = controller.open([other]); await tick();
    release.reject(new Error('old cleanup failed'));
    expect(await retarget).toBe(true); await tick();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', status: { sessionId: 'ms-2' }, error: null });
  });

  it('rejects serial-busy admission before queuing native operations', async () => {
    const { controller, api, setCanMeasure } = fixture(); setCanMeasure(false);
    expect(await controller.open([target])).toBe(false);
    expect(api.openMeasureSession).not.toHaveBeenCalled();
    setCanMeasure(true); expect(await controller.open([target])).toBe(true);
    setCanMeasure(false); controller.hover(event(1));
    expect(controller.click(event(1))).toBe(false); expect(controller.reset('all')).toBe(false);
    await tick(); expect(api.getMeasureDisplay).not.toHaveBeenCalled(); expect(api.clickMeasure).not.toHaveBeenCalled();
  });

  it('drops a queued open if a serial slice finished before the project lane became available', async () => {
    const { controller, api, ports, setAdmission } = fixture();
    const gate = deferred<void>(); ports.coordinate = async operation => { await gate.promise; return operation(); };
    const opening = controller.open([target]); await tick(); setAdmission('serial:1'); gate.resolve();
    expect(await opening).toBe(false);
    expect(api.openMeasureSession).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'closed', error: 'slice_busy' });
  });
});

describe('Measure input and resource ownership', () => {
  it('discards a hover still in flight when camera navigation starts', async () => {
    const { controller, api } = fixture(); await controller.open([target]);
    const pending = deferred<MeasureDisplay>(); api.getMeasureDisplay.mockReturnValueOnce(pending.promise);
    controller.hover(event(1)); await tick(); controller.invalidateHover();
    pending.resolve(display('md-obsolete')); await tick(); await controller.settled();
    expect(controller.getSnapshot().display).toBeNull();
    expect(api.releaseMeasureDisplay).toHaveBeenCalledWith({ version: 1, sessionId: 'ms-1', displayId: 'md-obsolete' });
  });
  it('keeps one hover in flight and only processes the newest pending hover', async () => {
    const { controller, api } = fixture(); await controller.open([target]);
    const first = deferred<MeasureDisplay>(), last = deferred<MeasureDisplay>();
    api.getMeasureDisplay.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    const original = event(1); controller.hover(original); await tick();
    (original.pointer as unknown as number[])[0] = 99;
    controller.hover(event(2)); controller.hover(event(3));
    expect(api.getMeasureDisplay).toHaveBeenCalledTimes(1);
    expect(api.getMeasureDisplay.mock.calls[0][0].event.pointer[0]).toBe(1);
    first.resolve(display('md-1')); await tick();
    expect(api.releaseMeasureDisplay).toHaveBeenCalledWith({ version: 1, sessionId: 'ms-1', displayId: 'md-1' });
    expect(api.getMeasureDisplay).toHaveBeenCalledTimes(2);
    expect(api.getMeasureDisplay.mock.calls[1][0].event.pointer[0]).toBe(3);
    last.resolve(display('md-2')); await tick();
    expect(controller.getSnapshot().display?.displayId).toBe('md-2');
  });

  it('drops an admitted click and hover when the serial slice epoch changes', async () => {
    const { controller, api, setAdmission } = fixture(); await controller.open([target]);
    const pending = deferred<MeasureDisplay>(); api.getMeasureDisplay.mockReturnValueOnce(pending.promise);
    controller.hover(event(1)); await tick(); expect(controller.click(event(2))).toBe(true);
    setAdmission('serial:1'); pending.resolve(display('md-10')); await tick(); await controller.settled(); await tick();
    expect(api.releaseMeasureDisplay).toHaveBeenCalledWith({ version: 1, sessionId: 'ms-1', displayId: 'md-10' });
    expect(api.clickMeasure).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', error: 'slice_busy' });
  });

  it('retains the actual displayed marker for ordered clicks while an older hover finishes', async () => {
    const { controller, api } = fixture(); await controller.open([target]);
    controller.hover(event(1)); await tick(); expect(controller.getSnapshot().display?.displayId).toBe('md-1');
    const newer = deferred<MeasureDisplay>(), first = deferred<MeasureReceipt>(), second = deferred<MeasureReceipt>();
    api.getMeasureDisplay.mockReturnValueOnce(newer.promise);
    api.clickMeasure.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    controller.hover(event(2)); await tick();
    const pressed = event(10); expect(controller.click(pressed, false, 0)).toBe(true);
    expect(controller.click(event(20), true, 0)).toBe(true);
    (pressed.pointer as unknown as number[])[0] = 90;
    newer.resolve(display('md-20')); await tick();
    expect(controller.getSnapshot().display?.displayId).toBe('md-1');
    expect(api.releaseMeasureDisplay).toHaveBeenCalledWith({ version: 1, sessionId: 'ms-1', displayId: 'md-20' });
    expect(api.releaseMeasureDisplay).not.toHaveBeenCalledWith(expect.objectContaining({ displayId: 'md-1' }));
    expect(api.clickMeasure).toHaveBeenCalledTimes(1);
    expect(api.clickMeasure.mock.calls[0][0]).toMatchObject({ displayId: 'md-1', marker: 0, event: { pointer: [10, 20] } });
    first.resolve(receipt(2)); await tick();
    expect(api.clickMeasure).toHaveBeenCalledTimes(2);
    expect(api.clickMeasure.mock.calls[1][0]).toMatchObject({ displayId: 'md-1', marker: 0, shift: true, event: { pointer: [20, 20] } });
    api.getMeasureDisplay.mockResolvedValueOnce(display('md-3', status('ms-1', 3)));
    second.resolve(receipt(3)); await tick(); await controller.settled(); await tick();
    expect(api.releaseMeasureDisplay).toHaveBeenCalledWith({ version: 1, sessionId: 'ms-1', displayId: 'md-1' });
    expect(controller.getSnapshot().status?.selectionRevision).toBe(3);
  });

  it('refreshes the display after a click that had no prior hover', async () => {
    const { controller, api } = fixture(); await controller.open([target]);
    expect(controller.click(event(8))).toBe(true); await tick(); await controller.settled(); await tick();
    expect(api.getMeasureDisplay).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({ pointer: [8, 20] }) }));
    expect(controller.getSnapshot().display?.selectionRevision).toBe(2);
  });

  it('discards late plane geometry after close while retaining the display until the read completes', async () => {
    const { controller, api } = fixture(); await controller.open([target]);
    const planeFeature = { type: 'plane' as const, point: [0, 0, 0] as const, normal: [0, 0, 1] as const,
      resourceId: 'mp-1-1-1-2-3-0', transform: identity };
    const planeDisplay: MeasureDisplay = { ...display('md-1'), hover: { target, originalFacet: 0, local: [0, 0, 0], world: [0, 0, 0], feature: planeFeature } };
    const pending = deferred<MeasurePlane>(); api.getMeasureDisplay.mockResolvedValueOnce(planeDisplay); api.getMeasurePlane.mockReturnValueOnce(pending.promise);
    controller.hover(event(1)); await tick();
    expect(api.getMeasurePlane).toHaveBeenCalledTimes(1);
    const closed = controller.close(); expect(controller.getSnapshot().phase).toBe('closed');
    expect(api.releaseMeasureDisplay).not.toHaveBeenCalledWith(expect.objectContaining({ displayId: 'md-1' }));
    pending.resolve({ ok: true, version: 1, sessionId: 'ms-1', targetRevision: 1, displayId: 'md-1',
      resourceId: planeFeature.resourceId, vertices: new Float32Array(9), transform: identity });
    await closed; await tick(); await controller.settled();
    expect(controller.getSnapshot().planes.size).toBe(0);
    expect(api.releaseMeasureDisplay).toHaveBeenCalledWith({ version: 1, sessionId: 'ms-1', displayId: 'md-1' });
  });

  it('closes only after Escape reports an empty selection', async () => {
    const { controller, api } = fixture(); await controller.open([target]);
    api.resetMeasure.mockResolvedValueOnce({ ...status(), outcome: 'close' });
    expect(controller.reset('escape')).toBe(true); await controller.settled();
    expect(controller.getSnapshot().phase).toBe('closed');
    expect(api.closeMeasureSession).toHaveBeenCalledExactlyOnceWith({ version: 1, sessionId: 'ms-1' });
  });

  it('closes on an untrustworthy click receipt but keeps the session on a business rejection', async () => {
    const { controller, api } = fixture(); await controller.open([target]);
    api.clickMeasure.mockResolvedValueOnce({ error: 'slice_busy' });
    expect(controller.click(event(1))).toBe(true); await controller.settled(); await tick();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', error: 'slice_busy' });
    api.clickMeasure.mockRejectedValueOnce(new Error('invalid measurement response'));
    expect(controller.click(event(2))).toBe(true); await controller.settled(); await tick();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'closed', error: 'invalid measurement response' });
    await controller.settled();
    expect(api.closeMeasureSession).toHaveBeenCalledExactlyOnceWith({ version: 1, sessionId: 'ms-1' });
  });

  it('invalidates old display resources and retains the native result after a scale rebase', async () => {
    const { controller, api } = fixture(); await controller.open([target]);
    controller.hover(event(1)); await tick();
    const updated = { ...status('ms-1', 2, 2), first: item, sameTarget: true };
    api.rebaseMeasure.mockResolvedValueOnce(updated);
    const rebasing = controller.rebase();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'rebasing', display: null });
    expect(await rebasing).toBe(true); await controller.settled(); await tick();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', status: { targetRevision: 2, first: item } });
    expect(api.releaseMeasureDisplay).toHaveBeenCalledWith({ version: 1, sessionId: 'ms-1', displayId: 'md-1' });
  });
});
