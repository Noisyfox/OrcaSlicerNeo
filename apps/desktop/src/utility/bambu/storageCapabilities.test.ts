import { expect, it, vi } from 'vitest';
import { readStorageCapabilities } from './storageCapabilities';
import type { BambuDeviceAccess } from './deviceAccess';
import type { BambuDeviceContext } from './controlContext';
const target = { printerId: 'p', routeId: 'r' } as BambuDeviceContext['target'];
function fixture(fresh: boolean, model = false, timelapse = false) {
  const context = { fresh, report: { fun: '0', fun2: '0' }, machine: { internalModelStorage: model, internalRecording: timelapse } } as unknown as BambuDeviceContext;
  const access = { context: vi.fn(async () => ({ ok: true as const, value: context })),
    read: vi.fn(async () => ({ ok: false as const, error: { code: 'busy' as const, message: 'Another printer is monitored.' } })) };
  return { context, access, read: () => readStorageCapabilities(access as unknown as Pick<BambuDeviceAccess, 'context' | 'read'>, target) };
}
it('reuses fresh capabilities without another status subscription', async () => {
  const f = fixture(true, true, false);
  expect(await f.read()).toEqual({ internalModel: true, internalTimelapse: false }); expect(f.access.read).not.toHaveBeenCalled();
});
it('retains known same-route capabilities when another monitored printer prevents a temporary read', async () => {
  const f = fixture(false, false, true);
  expect(await f.read()).toEqual({ internalModel: false, internalTimelapse: true });
  expect(f.access.read).toHaveBeenCalledWith({ target, topics: ['status'], source: 'device' });
  expect(await fixture(false).read()).toEqual({ internalModel: false, internalTimelapse: false });
});
it('uses new report capabilities and rejects cancellation after a temporary status read', async () => {
  const f = fixture(false), controller = new AbortController();
  const access = { ...f.access, read: vi.fn(async () => ({ ok: true as const, value: { context: { ...f.context,
    machine: { ...f.context.machine, internalModelStorage: true } } } })) } as unknown as Pick<BambuDeviceAccess, 'context' | 'read'>;
  expect(await readStorageCapabilities(access, target)).toEqual({ internalModel: true, internalTimelapse: false });
  const aborting = { ...access, read: async () => { controller.abort(); return f.access.read(); } } as unknown as Pick<BambuDeviceAccess, 'context' | 'read'>;
  await expect(readStorageCapabilities(aborting, target, controller.signal)).rejects.toMatchObject({ detail: { code: 'cancelled' } });
});

it('validates internal collection access from cached flags without acquiring a status lease', async () => {
  const f = fixture(false, true, true);
  expect(await readStorageCapabilities(f.access as unknown as Pick<BambuDeviceAccess, 'context' | 'read'>, target, undefined, false))
    .toEqual({ internalModel: true, internalTimelapse: true });
  expect(f.access.read).not.toHaveBeenCalled();
});

it('resolves capabilities for a cold direct internal-list request without requiring prior discovery', async () => {
  const f = fixture(false); f.context.report = {};
  await readStorageCapabilities(f.access as unknown as Pick<BambuDeviceAccess, 'context' | 'read'>, target, undefined, false);
  expect(f.access.read).toHaveBeenCalledOnce();
});
