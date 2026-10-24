import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareAndSwapPreferences, readPreferences } from './preferencePersistence';
it('detects competing snapshots and preserves unrelated fields on reapplication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'neo-prefs-'));
  try {
    const path = join(directory, 'preferences.json'), base = await readPreferences(path);
    const [a, b] = await Promise.all([
      compareAndSwapPreferences(path, base, { ...base, ui: { ...base.ui, lastDevicePrinterId: 'moonraker:p' } }),
      compareAndSwapPreferences(path, base, { ...base, selectedProfiles: { printer: 'P' } }),
    ]);
    expect([a.updated, b.updated].filter(Boolean)).toHaveLength(1);
    const loser = a.updated ? b : a;
    const next = a.updated ? { ...loser.current, selectedProfiles: { printer: 'P' } }
      : { ...loser.current, ui: { ...loser.current.ui, lastDevicePrinterId: 'moonraker:p' } };
    expect((await compareAndSwapPreferences(path, loser.current, next)).updated).toBe(true);
    expect(await readPreferences(path)).toMatchObject({ ui: { lastDevicePrinterId: 'moonraker:p' }, selectedProfiles: { printer: 'P' } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
