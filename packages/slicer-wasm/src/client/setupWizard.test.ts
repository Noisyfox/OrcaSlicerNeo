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
    await expect(client.prepareProfileActivation(MOCK_PROFILE_ACTIVATION)).rejects.toThrow('unknown bridge fn');
    await expect(client.applyProfileActivation()).rejects.toThrow('unknown bridge fn');
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
