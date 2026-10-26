import { describe, expect, it } from 'vitest';
import { createClient } from './client';
import { createMockModule } from './testing/mock-module';
import type { NozzleMappingSnapshot } from './nozzleMapping';

const fixture = (): NozzleMappingSnapshot => ({
  ok: true, plateId: 'plate-a', revision: 17, eligible: true,
  nozzles: [1, 2, 3].map(id => ({ id, diameter: 0.4, capacity: id })),
  usedFilaments: [1, 3],
  modes: [0, 1, 2, 3].map(mode => ({ mode: mode as 0 | 1 | 2 | 3,
    available: mode >= 2, reason: mode < 2 ? 'Unavailable native mode' : '' })),
  saved: { mode: 3, filamentMap: [2, 1, 3], volumeMap: null, nozzleMap: [0, 0, 0] },
  effective: { mode: 3, filamentMap: [2, 1, 3], volumeMap: [0, 0, 0], nozzleMap: [0, 0, 0] },
  diagnostics: [],
});
const client = (nozzleMapping: unknown) => createClient(async () => createMockModule({ nozzleMapping }));

describe('nozzle mapping projection boundary', () => {
  it('preserves non-dual manual mapping, hidden entries and absent saved values', async () => {
    const value = fixture();
    const c = client(value);
    expect(await c.getNozzleMapping('plate-a')).toEqual(value);
    expect(await c.getNozzleMapping('plate-a')).toEqual(value);
  });
  it('rejects a response for another Plate instead of redirecting it', async () => {
    expect(await client(fixture()).getNozzleMapping('plate-b')).toMatchObject({ ok: false, errorCode: 'invalid_projection' });
  });
  it('rejects malformed indices, unsafe capacities and inconsistent vectors', async () => {
    const base = fixture();
    for (const patch of [
      { usedFilaments: [1, 4] }, { usedFilaments: [1, 1] }, { usedFilaments: [3, 1] },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { nozzles: [{ id: 2, diameter: 0.4, capacity: 1 }] },
      { nozzles: [{ id: 1, diameter: 0.4, capacity: 2147483648 }] },
      { effective: { ...base.effective, nozzleMap: [0] } },
      { saved: { ...base.saved, mode: 9 } }, { modes: [] },
      { diagnostics: [{ code: 'invalid_target', severity: 'error', message: 'Invalid', filament: 4 }] },
    ]) expect(await client({ ...base, ...patch }).getNozzleMapping('plate-a')).toMatchObject({ ok: false });
  });
  it('preserves native failures and does not turn diagnostic errors into a different mode', async () => {
    const error = { ok: false, errorCode: 'plate_not_found', error: 'Plate removed' };
    expect(await client(error).getNozzleMapping('plate-a')).toEqual(error);
    const value = { ...fixture(), diagnostics: [{ code: 'invalid_target', severity: 'error', message: 'Invalid', filament: 1 }] };
    expect(await client(value).getNozzleMapping('plate-a')).toEqual(value);
  });
});

describe('nozzle mapping mutation receipts', () => {
  const context = { selection: { mode: 'object' as const, objectIds: [], partIds: [], instanceIds: [] },
    activePlateId: 'plate-a', gizmo: null, nativeScopedConfig: {} };
  const request = { plateId: 'plate-a', revision: 0, plateRevision: 17,
    change: { kind: 'mapping' as const, mode: 3 as const, filamentMap: [2, 1, 3] } };
  it('preserves a Nozzle Manual no-op without fabricating an invalidation', async () => {
    const history = await client(fixture()).getHistoryStatus();
    const c = createClient(async () => createMockModule({ nozzleMappingMutation: {
      ok: true, changed: false, snapshot: fixture(), history_status: history,
    } }));
    expect(await c.mutateNozzleMapping(request, context)).toMatchObject({ ok: true, changed: false,
      snapshot: { saved: { mode: 3 } }, historyStatus: { revision: 0 } });
  });
  it('rejects mismatched revision or incomplete publication and preserves native rejection', async () => {
    const history = await client(fixture()).getHistoryStatus();
    for (const receipt of [
      { ok: true, changed: false, snapshot: fixture(), history_status: { ...history, revision: 2 } },
      { ok: true, changed: true, snapshot: fixture(), history_status: { ...history, revision: 1 } },
    ]) {
      const c = createClient(async () => createMockModule({ nozzleMappingMutation: receipt }));
      expect(await c.mutateNozzleMapping(request, context)).toMatchObject({ ok: false, errorCode: 'invalid_response' });
    }
    const failure = { ok: false, errorCode: 'stale_revision', error: 'Refresh inputs' };
    const c = createClient(async () => createMockModule({ nozzleMappingMutation: failure }));
    expect(await c.mutateNozzleMapping(request, context)).toEqual(failure);
  });
});
