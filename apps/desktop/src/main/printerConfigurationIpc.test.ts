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

it('merges independent instance additions and refuses to resurrect a concurrently removed printer', async () => {
  let disk = JSON.stringify(document);
  const deps = { path: () => 'shared', fs: { readText: async () => disk, writeText: async (_path: string, value: string) => { disk = value; } }, isCurrentRenderer: () => true };
  const a = createPrinterConfigurationIpcHandlers(deps), b = createPrinterConfigurationIpcHandlers(deps);
  const first = await a.load('a'), second = await b.load('b');
  await a.save('a', { ...first, printers: [...first.printers, { ...first.printers[0], id: 'p2' }] });
  await b.save('b', { ...second, printers: [...second.printers, { ...second.printers[0], id: 'p3' }] });
  expect(JSON.parse(disk).printers.map((value: { id: string }) => value.id)).toEqual(['p1', 'p2', 'p3']);
  const latest = await a.load('a');
  await a.save('a', { ...latest, printers: latest.printers.filter(printer => printer.id !== 'p1') });
  await expect(b.save('b', { ...second, printers: [{ ...second.printers[0], displayName: 'Edited old snapshot' }] })).rejects.toThrow('another application instance');
  expect(JSON.parse(disk).printers.map((value: { id: string }) => value.id)).toEqual(['p2', 'p3']);
});
