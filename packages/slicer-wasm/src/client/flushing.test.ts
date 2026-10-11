import { describe, expect, it } from 'vitest';
import { createClient } from './client';
import { createMockModule } from './testing/mock-module';

async function fixture() {
  const client = createClient(async () => createMockModule());
  const initial = await client.getFilamentSessionSnapshot();
  if (!initial.ok) throw new Error(initial.error);
  const added = await client.addFilamentSlot({ version: 1, revision: initial.revisions.session });
  if (!added.ok) throw new Error(added.error);
  return { client, revision: added.result.snapshot.revisions.session };
}

describe('flushing bridge contract', () => {
  it('reads defaults without changing the session, stores raw values and treats unchanged OK as a no-op', async () => {
    const { client, revision } = await fixture();
    const before = await client.getFlushingVolumes({ version: 1, revision });
    expect(before).toMatchObject({ ok: true, dimension: 2, planes: 1, defaults: [0, 280, 280, 0] });
    expect((await client.getFilamentSessionSnapshot()).ok).toBe(true);
    const committed = await client.setFlushingVolumes({ version: 1, revision, matrix: [0, 123, 456, 0], multipliers: [0.5] });
    expect(committed).toMatchObject({ ok: true, result: { mutation: { kind: 'flushing', historyEntryDelta: 1 }, snapshot: { flushing: { matrix: [0, 123, 456, 0] } } } });
    if (!committed.ok) throw new Error(committed.error);
    const nextRevision = committed.result.snapshot.revisions.session;
    expect(await client.getFlushingVolumes({ version: 1, revision: nextRevision })).toMatchObject({ multipliers: [0.5] });
    expect(await client.setFlushingVolumes({ version: 1, revision: nextRevision, matrix: [0, 123, 456, 0], multipliers: [0.5] }))
      .toMatchObject({ ok: true, result: { mutation: { historyEntryDelta: 0, affectedPlateIds: [], allPlateResultsInvalidated: false } } });
  });
  it('rejects stale and malformed drafts and safely preserves raw data at zero multiplier', async () => {
    const { client, revision } = await fixture();
    for (const request of [
      { revision: revision - 1, matrix: [0, 1, 2, 0], multipliers: [1] },
      { revision, matrix: [0, 1], multipliers: [1] },
      { revision, matrix: [1, 2, 3, 0], multipliers: [1] },
      { revision, matrix: [0, -1, 3, 0], multipliers: [1] },
      { revision, matrix: [0, 1, 2, 0], multipliers: [4] },
    ]) expect(await client.setFlushingVolumes({ version: 1, ...request })).toMatchObject({ ok: false });
    expect(await client.setFlushingVolumes({ version: 1, revision, matrix: [0, 123, 456, 0], multipliers: [0] }))
      .toMatchObject({ ok: true, result: { snapshot: { flushing: { matrix: [0, 123, 456, 0] } } } });
  });
  it('keeps unrelated manual pairs during Color and all manual pairs during None', async () => {
    const { client, revision } = await fixture();
    const third = await client.addFilamentSlot({ version: 1, revision });
    if (!third.ok) throw new Error(third.error);
    const matrix = [0, 101, 102, 103, 0, 105, 106, 107, 0];
    const saved = await client.setFlushingVolumes({ version: 1, revision: third.result.snapshot.revisions.session, matrix, multipliers: [1] });
    if (!saved.ok) throw new Error(saved.error);
    await client.setAutoFlushPolicy('disabled');
    const retained = await client.setFilamentSlotColour({ version: 1, revision: saved.result.snapshot.revisions.session, slot: 1, colour: { kind: 'solid', color: '#112233' } });
    expect(retained).toMatchObject({ ok: true, result: { snapshot: { flushing: { matrix } } } });
    if (!retained.ok) throw new Error(retained.error);
    await client.setAutoFlushPolicy('color change');
    const changed = await client.setFilamentSlotColour({ version: 1, revision: retained.result.snapshot.revisions.session, slot: 1, colour: { kind: 'solid', color: '#FFFFFF' } });
    if (!changed.ok) throw new Error(changed.error);
    expect(changed.result.snapshot.flushing.matrix[5]).toBe(105);
    expect(changed.result.snapshot.flushing.matrix[7]).toBe(107);
    expect(changed.result.snapshot.flushing.matrix[1]).not.toBe(101);
  });
});
