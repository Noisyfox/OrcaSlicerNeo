import { describe, expect, it } from 'vitest';
import { createClient } from './client';
import { createMockModule, MOCK_PROFILE_ACTIVATION } from './testing/mock-module';
import { createWorkerClient, startWorker, type WorkerMessage, type WorkerTransport } from './worker';

class Channel implements WorkerTransport {
  private listeners: ((message: WorkerMessage) => void)[] = [];
  onMessage(listener: (message: WorkerMessage) => void) { this.listeners.push(listener); }
  post(message: WorkerMessage) { for (const listener of this.listeners) listener(message); }
}

describe('temporary setup catalogue', () => {
  it('retains an enabled current printer when adding models and marks only a disabled-current fallback dirty', async () => {
    const client = createClient(async () => createMockModule());
    await client.init(null); await client.openSetupWizardCatalogue();
    const first = { models: [MOCK_PROFILE_ACTIVATION.models[0]], filaments: MOCK_PROFILE_ACTIVATION.filaments };
    const prepare = (activation: typeof first) => client.prepareProfileActivation({ activation,
      rememberedFilamentRacks: {}, rememberedBedTypes: {} });
    expect((await prepare(first)).ok).toBe(true);
    expect((await client.applyProfileActivation()).ok).toBe(true);
    expect((await client.markHistorySaved()).dirty).toBe(false);
    const before = await client.getProfileSnapshot();
    expect((await prepare(MOCK_PROFILE_ACTIVATION)).ok).toBe(true);
    const added = await client.applyProfileActivation();
    if (!added.ok || !before.ok) throw new Error('mock activation failed');
    expect(added.profileSnapshot.printer.name).toBe(before.printer.name);
    expect(added.configurationChanged).toBe(false); expect(added.historyStatus.dirty).toBe(false);
    expect((await prepare({ ...first, models: [MOCK_PROFILE_ACTIVATION.models[1]] })).ok).toBe(true);
    const fallback = await client.applyProfileActivation();
    if (!fallback.ok) throw new Error(fallback.error);
    expect(fallback.profileSnapshot.printer.name).not.toBe(before.printer.name);
    expect(fallback.configurationChanged).toBe(true); expect(fallback.historyStatus.dirty).toBe(true);
  });

  it('projects the full mock fixture through Worker while preserving the live session and links', async () => {
    const module = createMockModule();
    const channel = new Channel();
    const client = createWorkerClient(channel);
    await startWorker(async () => module, message => channel.post(message), listener => channel.onMessage(listener));
    await client.init({ models: [MOCK_PROFILE_ACTIVATION.models[0]], filaments: ['Generic PLA @System'] });
    const before = { profiles: await client.getProfileSnapshot(), history: await client.getHistoryStatus(), filaments: await client.getFilamentSessionSnapshot(),
      model: await client.getModelStructure(), system: module.FS.readdir('/system') };
    const opened = await client.openSetupWizardCatalogue();
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error);
    expect(opened.catalogue.models.some(model => model.vendor === 'afinia')).toBe(true);
    const group = opened.catalogue.filaments.find(group => group.name === 'Bambu PLA Basic')!;
    expect(group.vendor).toBe('Bambu Lab');
    expect(group.presets).toHaveLength(2);
    expect(group.presets.map(member => member.resource_vendor)).toEqual(['bambulab', 'bambulab']);
    expect(group.presets.map(member => member.compatible_models[0].model)).toEqual(['X1 Carbon', 'P1S']);
    expect(opened.catalogue.filaments.find(group => group.name === 'Generic PLA')!.presets[0].compatible_models).toEqual([]);
    expect(await client.closeSetupWizardCatalogue()).toEqual({ ok: true });
    expect(await client.openSetupWizardCatalogue()).toEqual(opened);
    expect(await client.closeSetupWizardCatalogue()).toEqual({ ok: true });
    expect({ profiles: await client.getProfileSnapshot(), history: await client.getHistoryStatus(), filaments: await client.getFilamentSessionSnapshot(),
      model: await client.getModelStructure(), system: module.FS.readdir('/system') }).toEqual(before);
    expect((await client.prepareProfileActivation({ activation: MOCK_PROFILE_ACTIVATION, rememberedFilamentRacks: {}, rememberedBedTypes: {} })).ok).toBe(false);
    await expect(client.applyProfileActivation()).rejects.toThrow('activation is not prepared');
  });

  it('rejects close and a second open while the Worker loading hook is pending, then releases the gate', async () => {
    const module = createMockModule();
    const channel = new Channel();
    const client = createWorkerClient(channel);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await startWorker(async () => module, message => channel.post(message), listener => channel.onMessage(listener),
      undefined, op => op === 'openSetupWizardCatalogue' ? pending : undefined);
    const opening = client.openSetupWizardCatalogue();
    await expect(client.closeSetupWizardCatalogue()).rejects.toThrow('setup_catalogue_loading');
    await expect(client.openSetupWizardCatalogue()).rejects.toThrow('setup_catalogue_loading');
    await expect(client.prepareProfileActivation({ activation: MOCK_PROFILE_ACTIVATION, rememberedFilamentRacks: {}, rememberedBedTypes: {} })).rejects.toThrow('setup_catalogue_loading');
    await expect(client.applyProfileActivation()).rejects.toThrow('setup_catalogue_loading');
    release();
    expect((await opening).ok).toBe(true);
    expect(await client.closeSetupWizardCatalogue()).toEqual({ ok: true });
  });

  it('releases the direct-client loading gate after a module failure', async () => {
    let reject!: (error: Error) => void;
    const client = createClient(() => new Promise((_, rejectFactory) => { reject = rejectFactory; }));
    const opening = client.openSetupWizardCatalogue();
    await expect(client.closeSetupWizardCatalogue()).rejects.toThrow('setup_catalogue_loading');
    reject(new Error('module unavailable'));
    await expect(opening).rejects.toThrow('module unavailable');
    await expect(client.closeSetupWizardCatalogue()).rejects.toThrow('module unavailable');
  });

  it('keeps preparation outside filesystem publication, retains it for apply retry, and invalidates it on failed reprepare/close', async () => {
    const module = createMockModule();
    const client = createClient(async () => module);
    await client.init(MOCK_PROFILE_ACTIVATION);
    await client.openSetupWizardCatalogue();
    const before = { profiles: await client.getProfileSnapshot(), history: await client.getHistoryStatus(),
      model: await client.getModelStructure(), links: module.FS.readdir('/system') };
    expect((await client.prepareProfileActivation({ activation: MOCK_PROFILE_ACTIVATION, rememberedFilamentRacks: {}, rememberedBedTypes: {} })).ok).toBe(true);
    expect({ profiles: await client.getProfileSnapshot(), history: await client.getHistoryStatus(),
      model: await client.getModelStructure(), links: module.FS.readdir('/system') }).toEqual(before);
    const symlink = module.FS.symlink;
    module.FS.symlink = () => { throw new Error('link failed'); };
    await expect(client.applyProfileActivation()).rejects.toThrow('link failed');
    expect(await client.getProfileSnapshot()).toEqual(before.profiles);
    expect(await client.getHistoryStatus()).toEqual(before.history);
    module.FS.symlink = symlink;
    const applied = await client.applyProfileActivation();
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error(applied.error);
    expect(applied.profileSnapshot).toEqual(await client.getProfileSnapshot());
    expect(applied.filamentSession).toEqual(await client.getFilamentSessionSnapshot());
    expect(applied.historyStatus).toEqual(await client.getHistoryStatus());
    expect((await client.prepareProfileActivation({ activation: { models: [], filaments: [] }, rememberedFilamentRacks: {}, rememberedBedTypes: {} })).ok).toBe(false);
    await expect(client.applyProfileActivation()).rejects.toThrow('activation is not prepared');
    expect((await client.prepareProfileActivation({ activation: MOCK_PROFILE_ACTIVATION, rememberedFilamentRacks: {}, rememberedBedTypes: {} })).ok).toBe(true);
    await client.closeSetupWizardCatalogue();
    await expect(client.applyProfileActivation()).rejects.toThrow('activation is not prepared');
  });

  it('reads excluded-vendor cover bytes through the existing client filesystem transport', async () => {
    const module = createMockModule();
    module.FS.mkdir('/profiles/Excluded');
    const bytes = new Uint8Array([137, 80, 78, 71]);
    module.FS.writeFile('/profiles/Excluded/P_cover.png', bytes);
    const channel = new Channel();
    const client = createWorkerClient(channel);
    await startWorker(async () => module, message => channel.post(message), listener => channel.onMessage(listener));
    await client.init(null);
    expect(await client.readFilesystemFile('/profiles/Excluded/P_cover.png')).toEqual(bytes);
    expect(module.FS.readdir('/system')).not.toContain('Excluded');
  });
});
