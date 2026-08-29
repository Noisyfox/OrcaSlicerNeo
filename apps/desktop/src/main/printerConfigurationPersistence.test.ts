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
});
