import { normalizePrinterConfigurationDocument, type PrinterConfiguration, type PrinterConfigurationDocument } from './configuration';
import { MoonrakerDriver, PrinterControlError, type GcodeUpload, type PrinterApiDriver, type PrinterConnectionInfo, type PrinterStatus, type ProgressSink, type UploadedGcode } from './driver';
import type { PrinterTransport } from './transport';

export interface SendAndPrintResult { uploaded: UploadedGcode; started: true; }

/** Coordinates records and drivers while keeping each operation on a config snapshot. */
export class PrinterControlService {
  private readonly document: PrinterConfigurationDocument;
  private readonly drivers: ReadonlyMap<string, PrinterApiDriver>;

  constructor(document: PrinterConfigurationDocument, transport: PrinterTransport, drivers?: readonly PrinterApiDriver[]) {
    this.document = normalizePrinterConfigurationDocument(document);
    const available = drivers ?? [new MoonrakerDriver(transport)];
    this.drivers = new Map(available.map(driver => [driver.id, driver]));
  }

  get printers(): readonly PrinterConfiguration[] { return this.document.printers; }

  private resolve(printerId: string): { printer: PrinterConfiguration; driver: PrinterApiDriver } {
    const printer = this.document.printers.find(candidate => candidate.id === printerId);
    if (!printer) throw new PrinterControlError('protocol', 'The selected printer is no longer configured', 'connection');
    const driver = this.drivers.get(printer.driverId);
    if (!driver) throw new PrinterControlError('protocol', 'The selected printer driver is unavailable', 'connection');
    return { printer: { ...printer }, driver };
  }

  testConnection(printerId: string, signal?: AbortSignal): Promise<PrinterConnectionInfo> { const { printer, driver } = this.resolve(printerId); return driver.testConnection(printer, signal); }
  getStatus(printerId: string, signal?: AbortSignal): Promise<PrinterStatus> { const { printer, driver } = this.resolve(printerId); return driver.getStatus(printer, signal); }
  uploadGcode(printerId: string, input: GcodeUpload, progress?: ProgressSink, signal?: AbortSignal): Promise<UploadedGcode> { const { printer, driver } = this.resolve(printerId); return driver.uploadGcode(printer, input, progress, signal); }
  startPrint(printerId: string, remoteFile: UploadedGcode, signal?: AbortSignal): Promise<void> { const { printer, driver } = this.resolve(printerId); return driver.startPrint(printer, remoteFile, signal); }
  pausePrint(printerId: string, signal?: AbortSignal): Promise<void> { const { printer, driver } = this.resolve(printerId); return driver.pausePrint(printer, signal); }
  resumePrint(printerId: string, signal?: AbortSignal): Promise<void> { const { printer, driver } = this.resolve(printerId); return driver.resumePrint(printer, signal); }
  cancelPrint(printerId: string, signal?: AbortSignal): Promise<void> { const { printer, driver } = this.resolve(printerId); return driver.cancelPrint(printer, signal); }

  /** Explicit Send action: upload, and never call print/start. */
  uploadOnly(printerId: string, input: GcodeUpload, progress?: ProgressSink, signal?: AbortSignal): Promise<UploadedGcode> {
    return this.uploadGcode(printerId, input, progress, signal);
  }

  /** Explicit Send & Print action. A failed start retains the successful upload. */
  async uploadThenStart(printerId: string, input: GcodeUpload, progress?: ProgressSink, signal?: AbortSignal): Promise<SendAndPrintResult> {
    const { printer, driver } = this.resolve(printerId);
    const uploaded = await driver.uploadGcode(printer, input, progress, signal);
    try {
      // Upload cancellation ends when upload resolves. Start is a distinct
      // operation, so an upload AbortSignal cannot cancel it or hide the fact
      // that a remote file now exists.
      await driver.startPrint(printer, uploaded);
    } catch (error) {
      throw new PrinterControlError('start-failed-after-upload', 'Print start failed after upload; the file remains on the printer', 'start', error instanceof PrinterControlError ? error.status : undefined, uploaded);
    }
    return { uploaded, started: true };
  }

  sendAndPrint(printerId: string, input: GcodeUpload, progress?: ProgressSink, signal?: AbortSignal): Promise<SendAndPrintResult> {
    return this.uploadThenStart(printerId, input, progress, signal);
  }
}
