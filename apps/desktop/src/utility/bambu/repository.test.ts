import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { BambuRepository } from './repository';
it('initializes one shared identity and merges independent instance updates without proactive read synchronization', async () => {
  const directory = await mkdtemp(`${tmpdir()}/neo-bambu-repository-`);
  try {
    const a = new BambuRepository(directory), b = new BambuRepository(directory);
    const [first, second] = await Promise.all([a.read(), b.read()]);
    expect(first.clientId).toBe(second.clientId);
    await a.update(state => ({ ...state, region: 'China' }));
    expect((await b.read()).region).toBe('Others');
    await b.update(state => ({ ...state, lan: [{ deviceId: 'p', name: 'Printer', model: 'H2D', ip: '192.0.2.1', accessCode: 'private', revision: 'r1' }] }));
    const reopened = await new BambuRepository(directory).read();
    expect(reopened).toMatchObject({ region: 'China', clientId: first.clientId, lan: [{ deviceId: 'p' }] });
    expect((await a.read()).lan).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
