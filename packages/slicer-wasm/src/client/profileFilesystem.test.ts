import { describe, expect, it } from 'vitest';
import { createMockModule } from './testing/mock-module';
import { installProfileArchive, linkProfileVendors } from './profileFilesystem';
import { createClient } from './client';

const encode = (text: string) => new TextEncoder().encode(text);
describe('profile resource activation', () => {
  it('links only model vendors plus the permanent library, sharing source files', () => {
    const module = createMockModule();
    installProfileArchive(module, 'core', [{ path: 'hotend.stl', data: encode('core') }]);
    for (const vendor of ['Enabled', 'Excluded']) installProfileArchive(module, 'vendor', [
      { path: `${vendor}.json`, data: encode('{}') }, { path: `${vendor}/machine/p.json`, data: encode(vendor) },
    ]);
    linkProfileVendors(module, { models: [{ vendor: 'Enabled', model: 'P', nozzle_diameter: ['0.4'] }],
      filaments: ['Excluded PLA'] });
    expect(module.FS.readdir('/system').sort()).toEqual(['.', '..', 'Enabled', 'Enabled.json', 'OrcaFilamentLibrary', 'OrcaFilamentLibrary.json', 'hotend.stl'].sort());
    expect(module.FS.readFile('/system/Enabled/machine/p.json')).toEqual(encode('Enabled'));
    module.FS.writeFile('/profiles/Enabled/machine/p.json', encode('changed'));
    expect(module.FS.readFile('/system/Enabled/machine/p.json')).toEqual(encode('changed'));
    linkProfileVendors(module, null);
    expect(() => module.FS.readFile('/system/Enabled.json')).toThrow('ENOENT');
    expect(module.FS.readFile('/profiles/Enabled.json')).toEqual(encode('{}'));
    expect(module.FS.readFile('/system/hotend.stl')).toEqual(encode('core'));
  });
  it.each(['../bad', 'C:', ' ', 'Bad\0'])('rejects unsafe activation vendor %j before changing the view', vendor => {
    const module = createMockModule();
    expect(() => linkProfileVendors(module, { models: [{ vendor, model: 'P', nozzle_diameter: ['0.4'] }], filaments: [] }))
      .toThrow();
  });
  it('does not initialize without an explicit nullable activation', async () => {
    const client = createClient(async () => createMockModule());
    await expect(client.init(undefined as never)).rejects.toThrow('explicit nullable activation');
    expect(await client.init(null)).toMatchObject({ ok: true, setupRequired: true });
    const snapshot = await client.getProfileSnapshot();
    expect(snapshot.ok && snapshot.printers).toEqual([]);
    expect(await client.selectProfile('printer', 'Bambu Lab X1 Carbon 0.4 nozzle')).toMatchObject({ error: expect.any(String) });
    expect(await client.selectPrinterWithRememberedRack('Bambu Lab X1 Carbon 0.4 nozzle', null, null)).toMatchObject({ ok: false });
  });
});
