import { describe, expect, it } from 'vitest';
import { createClient } from './client';
import { createMockModule } from './testing/mock-module';
import type { MaterialImportApplication, MaterialImportRequest } from './types';

async function fixture() {
  const client = createClient(async () => createMockModule());
  const rack = await client.getFilamentSessionSnapshot();
  if (!rack.ok) throw new Error(rack.error);
  const request: MaterialImportRequest = { version: 1, revision: rack.revisions.session,
    identity: { manufacturer: 'Bambu Lab', model: 'X1 Carbon', externalRefs: [] }, sources: [
      { slotId: 'opaque:unknown-presence', toolIndices: [0], materialType: 'PLA', catalogRefs: [], colour: { kind: 'solid', color: '#123456' } },
      { slotId: 'opaque:empty', toolIndices: [0], materialType: 'PLA', catalogRefs: [], colour: { kind: 'parallel', colors: ['#112233', '#445566'] } },
    ] };
  const apply: MaterialImportApplication = { ...request, mode: 'mapping', mapping: rack.slots.map(() => request.sources[0].slotId),
    replacements: rack.slots.map(() => null), appendUnused: true, colourOnly: false };
  return { client, request, apply, rack };
}
describe('material synchronization bridge contract', () => {
  it('prepares fallback and per-project-slot matches without changing project/history', async () => {
    const { client, request, rack } = await fixture();
    const before = await client.getHistoryStatus();
    expect(await client.prepareMaterialImport(request)).toMatchObject({ ok: true, revision: request.revision,
      sources: [{ slotId: request.sources[0].slotId, preset: 'Generic PLA @System', warning: expect.any(String), matches: expect.any(Array) },
        { slotId: request.sources[1].slotId }], projectTypes: ['PLA'] });
    expect(await client.getFilamentSessionSnapshot()).toEqual(rack);
    expect(await client.getHistoryStatus()).toEqual(before);
    expect(await client.prepareMaterialImport({ ...request, identity: { ...request.identity, model: 'Other model' } }))
      .toMatchObject({ ok: false, errorCode: 'printer_model_mismatch' });
  });
  it('publishes a single complete commit, independent slot identities, native colors and Undo', async () => {
    const { client, apply, rack } = await fixture();
    const result = await client.applyMaterialImport(apply);
    if (!result.ok) throw new Error(result.error);
    expect(result).toMatchObject({ ok: true, result: { mutation: { kind: 'synchronize', historyEntryDelta: 1,
      revisionBefore: apply.revision, revisionAfter: apply.revision + 1, allPlateResultsInvalidated: true },
      snapshot: { slots: [{ logicalId: rack.slots[0].logicalId, colour: { effective: '#123456' } },
        { colour: { native: { multiColour: '#112233 #445566', type: '1' } } }] },
      historyStatus: { canUndo: true } } });
    const after = await client.getFilamentSessionSnapshot();
    expect(await client.applyMaterialImport(apply)).toMatchObject({ ok: false, errorCode: 'stale_revision' });
    expect(await client.getFilamentSessionSnapshot()).toEqual(after);
    await client.undoHistory();
    expect(await client.getFilamentSessionSnapshot()).toMatchObject({ slots: rack.slots });
  });
  it('uses the same native parallel-color representation through ordinary color edits', async () => {
    const { client, rack } = await fixture();
    expect(await client.setFilamentSlotColour({ version: 1, revision: rack.revisions.session, slot: 1,
      colour: { kind: 'parallel', colors: ['#123456', '#654321'] } })).toMatchObject({ ok: true,
        result: { snapshot: { slots: [{ colour: { native: { multiColour: '#123456 #654321', type: '1' }, display: { mode: 'multicolor' } } }] } } });
  });

});
