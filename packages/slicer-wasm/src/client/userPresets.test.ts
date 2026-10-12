import { describe, expect, it, vi } from 'vitest';
import { createClient } from './client';
import { createMockModule } from './testing/mock-module';

describe('user preset durable transaction', () => {
  function fixture(write = vi.fn(async () => {}), malformed = false) {
    const module = createMockModule();
    const original = module.ccall;
    const read = (name: string) => {
      const pointer = Number(original(name, 'number', [], []));
      try { return JSON.parse(module.UTF8ToString(pointer)); } finally { module._free(pointer); }
    };
    const finishes: boolean[] = [];
    module.ccall = (name, result, types, args) => {
      if (name !== 'orc_prepare_user_preset' && name !== 'orc_finish_user_preset') return original(name, result, types, args);
      const value = name === 'orc_prepare_user_preset' ? {
        ok: true, token: 7, change: { path: 'filament/Local.json', content: '{}' },
        result: { canonical_name: 'Local', history_entry_delta: 1,
          profile_snapshot: malformed ? {} : read('orc_get_preset_snapshot'),
          filament_session: read('orc_get_filament_session_snapshot'),
          plate_session: read('orc_mark_shared_configuration_mutation'),
          native_scoped_config: read('orc_get_native_scoped_config').native_scoped_config,
          history_status: read('orc_history_status') },
      } : (finishes.push(JSON.parse(String(args[0])).commit), { ok: true });
      const bytes = new TextEncoder().encode(JSON.stringify(value) + '\0');
      const pointer = module._malloc(bytes.length);
      module.HEAPU8.set(bytes, pointer);
      return pointer;
    };
    return { finishes, write, client: createClient(async () => module, undefined, undefined, undefined, undefined, undefined,
      { load: async () => [], write }) };
  }
  const request = { action: 'save-as', kind: 'filament', canonicalName: 'Source', name: 'Local', expectedRevision: 0 } as const;
  it('publishes only after the durable write completes', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(vi.fn(() => pending));
    const operation = f.client.mutateUserPreset(request);
    await vi.waitFor(() => expect(f.write).toHaveBeenCalledOnce());
    expect(f.finishes).toEqual([]);
    release();
    expect(await operation).toMatchObject({ ok: true, canonicalName: 'Local', historyEntryDelta: 1 });
    expect(f.finishes).toEqual([true]);
  });
  it('aborts native state when storage fails', async () => {
    const f = fixture(vi.fn(async () => { throw new Error('Disk full'); }));
    expect(await f.client.mutateUserPreset(request)).toMatchObject({ ok: false, error: 'Disk full' });
    expect(f.finishes).toEqual([false]);
  });
  it('validates the receipt before writing any file', async () => {
    const f = fixture(undefined, true);
    expect(await f.client.mutateUserPreset(request)).toMatchObject({ ok: false });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.finishes).toEqual([false]);
  });
});
