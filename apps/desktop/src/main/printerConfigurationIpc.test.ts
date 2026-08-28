import { describe, expect, it, vi } from 'vitest';
import { createPrinterConfigurationIpcHandlers } from './printerConfigurationIpc';

const document = {
  version: 1 as const,
  printers: [{
    id: 'p1', displayName: 'Printer', driverId: 'moonraker' as const,
    consoleUrl: 'http://printer.local/console', apiBaseUrl: 'http://printer.local:7125', apiKey: 'complete-key',
  }],
};

describe('printer configuration IPC sender policy', () => {
  it('returns an empty document and does not read for a non-current sender', async () => {
    const readText = vi.fn(async () => JSON.stringify(document));
    const handlers = createPrinterConfigurationIpcHandlers({
      path: () => 'printer-config.json', fs: { readText }, isCurrentRenderer: (sender) => sender === 'current',
    });
    await expect(handlers.load('guest-webview')).resolves.toEqual({ version: 1, printers: [] });
    expect(readText).not.toHaveBeenCalled();
  });

  it('rejects save for a non-current sender without writing', async () => {
    const writeText = vi.fn(async () => {});
    const handlers = createPrinterConfigurationIpcHandlers({
      path: () => 'printer-config.json', fs: { writeText }, isCurrentRenderer: (sender) => sender === 'current',
    });
    await expect(handlers.save('guest-webview', document)).rejects.toThrow('sender rejected');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('keeps current-renderer load and validated save behavior', async () => {
    const readText = vi.fn(async () => JSON.stringify(document));
    const writeText = vi.fn(async () => {});
    const handlers = createPrinterConfigurationIpcHandlers({
      path: () => 'printer-config.json', fs: { readText, writeText }, isCurrentRenderer: (sender) => sender === 'current',
    });
    await expect(handlers.load('current')).resolves.toMatchObject({ version: 1, printers: [{ apiKey: 'complete-key' }] });
    await handlers.save('current', document);
    expect(writeText).toHaveBeenCalledWith('printer-config.json', expect.stringContaining('complete-key'));
  });
});
