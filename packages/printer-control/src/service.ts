/** On-demand Moonraker agent, using the shared HTTP configuration and operation owner. */
import type * as D from './domain';
import { createHttpPrinterService, type HttpServiceOptions } from './http-service';

export type MoonrakerServiceOptions = HttpServiceOptions;

export function createMoonrakerService(options: MoonrakerServiceOptions): D.PrinterService {
  return createHttpPrinterService(options, 'moonraker', 'Moonraker', context => ({
    capabilities: context.capabilities,
    executeCommand: async ({ printer }, command, filePath) => {
      if (command.type === 'jobs.start') await context.http.post(printer, '/printer/print/start', { filename: filePath(command.params.source) });
      else await context.http.post(printer, '/printer/gcode/script', { script: { 'jobs.pause': 'PAUSE', 'jobs.resume': 'RESUME', 'jobs.cancel': 'CANCEL_PRINT' }[command.type as 'jobs.pause' | 'jobs.resume' | 'jobs.cancel'] });
    },
  }));
}
