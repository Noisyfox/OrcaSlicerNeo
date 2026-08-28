import { describe, expect, it } from 'vitest';
import { normalizePrinterConfigurationDocument, PrinterConfigurationValidationError } from './configuration';
import { MoonrakerDriver, PrinterControlError } from './driver';
import type { PrinterTransport, PrinterTransportRequest, PrinterTransportResponse } from './transport';
import { PrinterControlService } from './service';

const printer = {
  id: 'printer-a',
  displayName: 'Living room',
  driverId: 'moonraker' as const,
  consoleUrl: 'http://console.local:80/mainsail',
  apiBaseUrl: 'http://printer.local:7125/moonraker',
  apiKey: 'full-api-key-value',
};

class FixtureTransport implements PrinterTransport {
  readonly requests: PrinterTransportRequest[] = [];
  responses: unknown[] = [];
  statuses: number[] = [];

  async request(request: PrinterTransportRequest): Promise<PrinterTransportResponse> {
    this.requests.push(request);
    const body = this.responses.shift() ?? { result: {} };
    return { status: this.statuses.shift() ?? 200, json: async () => body };
  }
}

function documentWith(...records: typeof printer[]) {
  return normalizePrinterConfigurationDocument({ version: 1, printers: records });
}

describe('printer configuration', () => {
  it('normalizes version 1 URLs, preserves the complete key, and permits duplicate names', () => {
    const result = documentWith(printer, { ...printer, id: 'printer-b' });
    expect(result.version).toBe(1);
    expect(result.printers).toHaveLength(2);
    expect(result.printers[0]).toMatchObject({
      consoleUrl: 'http://console.local/mainsail',
      apiBaseUrl: 'http://printer.local:7125/moonraker',
      apiKey: 'full-api-key-value',
    });
    expect(result.printers.map(item => item.displayName)).toEqual(['Living room', 'Living room']);
  });

  it('rejects unsupported URLs, credentials, duplicate IDs, and unsupported drivers', () => {
    expect(() => normalizePrinterConfigurationDocument({
      version: 1,
      printers: [
        printer,
        { ...printer, driverId: 'custom', id: 'printer-a', consoleUrl: 'ftp://host', apiBaseUrl: 'https://user:pass@host' },
      ],
    })).toThrow(PrinterConfigurationValidationError);
  });
});

describe('Moonraker driver', () => {
  it('uses server info and sends X-Api-Key only when non-empty', async () => {
    const transport = new FixtureTransport();
    transport.responses.push({ result: { machine_name: 'Voron', moonraker_version: '0.9', klippy_state: 'ready' } });
    const info = await new MoonrakerDriver(transport).testConnection(printer);
    expect(info.machineName).toBe('Voron');
    expect(transport.requests[0]).toMatchObject({ method: 'GET', url: 'http://printer.local:7125/moonraker/server/info', headers: { 'X-Api-Key': 'full-api-key-value' } });

    const noKey = { ...printer, apiKey: '' };
    transport.responses.push({ result: {} });
    await new MoonrakerDriver(transport).testConnection(noKey);
    expect(transport.requests[1].headers).toEqual({});
  });

  it('builds the multipart upload shape and returns the remote path', async () => {
    const transport = new FixtureTransport();
    transport.responses.push({ result: { item: { path: 'gcodes/cube.gcode' } } });
    const uploaded = await new MoonrakerDriver(transport).uploadGcode(printer, { bytes: new Uint8Array([1, 2, 3]), fileName: 'cube.gcode' });
    expect(uploaded.remotePath).toBe('gcodes/cube.gcode');
    const request = transport.requests[0];
    expect(request.method).toBe('POST');
    expect(request.url).toBe('http://printer.local:7125/moonraker/server/files/upload');
    expect(request.headers).toEqual({ 'X-Api-Key': 'full-api-key-value' });
    expect(request.body).toEqual({
      kind: 'multipart',
      fields: { root: 'gcodes' },
      file: { fileName: 'cube.gcode', bytes: new Uint8Array([1, 2, 3]) },
    });
  });

  it('uses exact remote path for a separate JSON start request', async () => {
    const transport = new FixtureTransport();
    transport.responses.push({ result: {} });
    await new MoonrakerDriver(transport).startPrint(printer, { remotePath: 'gcodes/remote.gcode', path: 'gcodes/remote.gcode', fileName: 'local.gcode' });
    expect(transport.requests[0]).toMatchObject({
      method: 'POST',
      url: 'http://printer.local:7125/moonraker/printer/print/start',
      headers: { 'X-Api-Key': 'full-api-key-value', 'Content-Type': 'application/json' },
    });
    expect(JSON.parse((transport.requests[0].body as { kind: 'json'; json: string }).json)).toEqual({ filename: 'gcodes/remote.gcode' });
  });

  it('uses the documented status query and Moonraker G-code control commands', async () => {
    const transport = new FixtureTransport();
    transport.responses.push(
      { result: { status: { print_stats: { state: 'printing' } } } },
      { result: {} },
      { result: {} },
      { result: {} },
    );
    const driver = new MoonrakerDriver(transport);
    await expect(driver.getStatus(printer)).resolves.toMatchObject({ state: 'printing' });
    await driver.pausePrint(printer);
    await driver.resumePrint(printer);
    await driver.cancelPrint(printer);
    expect(transport.requests.map(request => request.url)).toEqual([
      'http://printer.local:7125/moonraker/printer/objects/query?print_stats&virtual_sdcard&extruder&heater_bed&fan',
      'http://printer.local:7125/moonraker/printer/gcode/script',
      'http://printer.local:7125/moonraker/printer/gcode/script',
      'http://printer.local:7125/moonraker/printer/gcode/script',
    ]);
    expect(transport.requests.slice(1).map(request => JSON.parse((request.body as { kind: 'json'; json: string }).json))).toEqual([
      { script: 'PAUSE' }, { script: 'RESUME' }, { script: 'CANCEL_PRINT' },
    ]);
  });
});

describe('PrinterControlService orchestration', () => {
  it('supports upload-only without a start request', async () => {
    const transport = new FixtureTransport();
    transport.responses.push({ result: { item: { path: 'cube.gcode' } } });
    const service = new PrinterControlService(documentWith(printer), transport);
    await service.uploadOnly('printer-a', { bytes: new Uint8Array([1]), fileName: 'cube.gcode' });
    expect(transport.requests.map(request => request.url)).toEqual(['http://printer.local:7125/moonraker/server/files/upload']);
  });

  it('performs upload then start on success', async () => {
    const transport = new FixtureTransport();
    transport.responses.push({ result: { item: { path: 'cube.gcode' } } }, { result: {} });
    const service = new PrinterControlService(documentWith(printer), transport);
    const result = await service.uploadThenStart('printer-a', { bytes: new Uint8Array([1]), fileName: 'cube.gcode' });
    expect(result.started).toBe(true);
    expect(transport.requests).toHaveLength(2);
  });

  it('surfaces start-failed-after-upload and never retries the upload', async () => {
    const transport = new FixtureTransport();
    transport.responses.push({ result: { item: { path: 'cube.gcode' } } }, { result: {} });
    transport.statuses.push(200, 500);
    const service = new PrinterControlService(documentWith(printer), transport);
    await expect(service.uploadThenStart('printer-a', { bytes: new Uint8Array([1]), fileName: 'cube.gcode' })).rejects.toMatchObject({
      code: 'start-failed-after-upload',
      uploaded: { remotePath: 'cube.gcode' },
    });
    expect(transport.requests.filter(request => request.url.endsWith('/server/files/upload'))).toHaveLength(1);
  });

  it('does not leak an API key through operation errors', async () => {
    const transport = new FixtureTransport();
    transport.statuses.push(500);
    const service = new PrinterControlService(documentWith(printer), transport);
    try {
      await service.testConnection('printer-a');
      throw new Error('expected testConnection to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(PrinterControlError);
      expect((error as Error).message).not.toContain(printer.apiKey);
    }
  });
});
