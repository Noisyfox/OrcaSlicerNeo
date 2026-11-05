import { describe, expect, it, vi } from 'vitest';
import {
  loadPrinterConfigurationFile,
  savePrinterConfigurationFile,
  type PrinterConfigurationFileSystem,
} from './printerConfigurationPersistence';

const record = {
  id: 'printer-1',
  displayName: 'Living room',
  driverId: 'moonraker' as const,
  consoleUrl: 'http://printer.local/console',
  apiBaseUrl: 'http://printer.local:7125',
  apiKey: 'complete-secret-key',
};

function fs(readText: string | Error = ''): PrinterConfigurationFileSystem {
  return {
    readText: typeof readText === 'string' ? vi.fn(async () => readText) : vi.fn(async () => { throw readText; }),
    writeText: vi.fn(async () => {}),
  };
}

describe('Electron printer configuration persistence', () => {
  it.each(['{bad json', JSON.stringify({ version: 2, printers: [record] }), JSON.stringify({ version: 1, printers: [{ ...record, apiKey: 4 }] })])(
    'returns an empty document for invalid file content', async (content) => {
      await expect(loadPrinterConfigurationFile('printer-config.json', fs(content))).resolves.toEqual({ version: 1, printers: [] });
    },
  );

  it('returns an empty document when the file cannot be read', async () => {
    await expect(loadPrinterConfigurationFile('printer-config.json', fs(new Error('permission denied')))).resolves.toEqual({ version: 1, printers: [] });
  });

  it('writes normalized complete records, including the API key', async () => {
    const filesystem = fs();
    await savePrinterConfigurationFile('printer-config.json', { version: 1, printers: [record] }, filesystem);
    expect(filesystem.writeText).toHaveBeenCalledWith('printer-config.json', expect.stringContaining('complete-secret-key'));
    expect(filesystem.writeText).toHaveBeenCalledWith('printer-config.json', expect.stringContaining('"consoleUrl": "http://printer.local/console"'));
  });

  it('rejects invalid IPC payloads before writing', async () => {
    const filesystem = fs();
    await expect(savePrinterConfigurationFile('printer-config.json', { version: 1, printers: [{ ...record, apiKey: 4 }] }, filesystem)).rejects.toThrow();
    expect(filesystem.writeText).not.toHaveBeenCalled();
  });

  it('restores, edits and clears the configured model through the file repository', async () => {
    let content = '';
    const filesystem = { readText: async () => content, writeText: async (_path: string, next: string) => { content = next; } };
    const printerModel = { vendorId: 'Snapmaker', model: 'Snapmaker U1' };
    await savePrinterConfigurationFile('printer-config.json', { version: 1, printers: [{ ...record, printerModel }] }, filesystem);
    let document = await loadPrinterConfigurationFile('printer-config.json', filesystem);
    expect(document.printers[0].printerModel).toEqual(printerModel);
    document.printers[0].printerModel = { vendorId: 'BBL', model: 'Bambu Lab H2D' };
    await savePrinterConfigurationFile('printer-config.json', document, filesystem);
    document = await loadPrinterConfigurationFile('printer-config.json', filesystem);
    expect(document.printers[0].printerModel?.model).toBe('Bambu Lab H2D');
    delete document.printers[0].printerModel;
    await savePrinterConfigurationFile('printer-config.json', document, filesystem);
    expect((await loadPrinterConfigurationFile('printer-config.json', filesystem)).printers[0]).not.toHaveProperty('printerModel');
  });
});

describe('independent print preference edits', () => {
  it('merges different printers and different option keys without erasing connection records', async () => {
    const { mergePrinterConfigurations: merge } = await import('./printerConfigurationPersistence');
    const base = { version: 1 as const, printers: [record] };
    const next = { ...base, printPreferences: { bambu: { timelapse: true } } };
    const current = { ...base, printPreferences: { bambu: { bedLeveling: 'auto' as const }, second: { timelapse: false } }, allowAbnormalStorage: true };
    expect(merge(base, next, current)).toEqual({ ...current, printPreferences: { ...current.printPreferences, bambu: { timelapse: true, bedLeveling: 'auto' } } });
  });
  it('rejects conflicting edits to the same preference and preserves explicit deletion', async () => {
    const { mergePrinterConfigurations: merge } = await import('./printerConfigurationPersistence');
    const base = { version: 1 as const, printers: [], printPreferences: { bambu: { bedLeveling: 'auto' as const } } };
    expect(() => merge(base, { ...base, printPreferences: { bambu: { bedLeveling: 'on' } } }, { ...base, printPreferences: { bambu: { bedLeveling: 'off' } } })).toThrow(/another application instance/);
    expect(merge(base, { ...base, printPreferences: {} }, base)).toEqual({ version: 1, printers: [] });
  });
});
