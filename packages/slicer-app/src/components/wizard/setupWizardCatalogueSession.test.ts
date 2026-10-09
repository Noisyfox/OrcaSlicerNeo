import { describe, expect, it, vi } from 'vitest';
import { createWizardCatalogueSession } from './setupWizardCatalogueSession';
describe('wizard catalogue ownership', () => {
  it('closes after terminal open and the old cleanup never closes a newer catalogue', async () => {
    let resolve!: (result: any) => void; const pending = new Promise<any>(r => { resolve = r; });
    const events: string[] = [];
    const runtime = { openSetupWizardCatalogue: vi.fn(async () => { events.push('open'); return await pending; }), closeSetupWizardCatalogue: vi.fn(async () => { events.push('close'); return { ok: true as const }; }) };
    const old = createWizardCatalogueSession(runtime); const opening = old.open(); await Promise.resolve();
    const cleanup = old.close(); const next = createWizardCatalogueSession(runtime); const reopen = next.open();
    expect(events).toEqual(['open']); expect(runtime.closeSetupWizardCatalogue).not.toHaveBeenCalled();
    resolve({ ok: true, catalogue: { models: [], filaments: [] } }); await opening; await cleanup; await reopen;
    expect(events).toEqual(['open', 'close', 'open']);
    await old.close(); expect(events).toEqual(['open', 'close', 'open']); await next.close(); expect(events).toEqual(['open', 'close', 'open', 'close']);
  });
  it('StrictMode cleanup before opening releases admission without calling native close', async () => {
    const runtime = { openSetupWizardCatalogue: vi.fn(async () => ({ ok: true as const, catalogue: { models: [], filaments: [] } })), closeSetupWizardCatalogue: vi.fn(async () => ({ ok: true as const })) };
    const discarded = createWizardCatalogueSession(runtime); const opening = discarded.open(); const closing = discarded.close();
    expect(await opening).toMatchObject({ ok: false }); await closing;
    const active = createWizardCatalogueSession(runtime); expect(await active.open()).toMatchObject({ ok: true });
    expect(runtime.openSetupWizardCatalogue).toHaveBeenCalledTimes(1); expect(runtime.closeSetupWizardCatalogue).not.toHaveBeenCalled(); await active.close();
  });
});
