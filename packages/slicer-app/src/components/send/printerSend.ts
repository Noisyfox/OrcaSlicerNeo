/** Send orchestration over explicit domain resources; no retained printer connection. */
import type { Id, PrinterService, PrinterError, RemoteFile, SavedPrinter } from '@orca/printer-control/domain';

export class SendFailure extends Error {
  constructor(readonly code: PrinterError['code'] | 'outcome-unknown') { super(code); }
}
const requestId = () => crypto.randomUUID() as Id<'request'>;
export interface SendProgress { loaded: number; total?: number; fraction?: number }

/** Select a route that can complete the whole requested action. */
export function sendRoute(printer: SavedPrinter, startPrint = false) {
  return printer.routes.find(route => {
    const upload = route.capabilities.files.upload;
    const start = route.capabilities.commands['jobs.start'];
    return upload.kind === 'supported'
      && upload.constraints.some(choice => choice.formats.includes('gcode') && choice.collisionPolicies.includes('overwrite'))
      && (!startPrint || (start.kind === 'supported' && start.constraints.formats.includes('gcode')));
  });
}

export async function uploadForSend(
  service: PrinterService, printerId: string, input: { bytes: Uint8Array; fileName: string },
  onProgress: (progress: SendProgress) => void, signal: AbortSignal, startPrint = false,
): Promise<RemoteFile> {
  const saved = await service.listSaved();
  if (!saved.ok) throw new SendFailure(saved.error.code);
  const printer = saved.value.find(value => value.identity.id === printerId);
  const route = printer && sendRoute(printer, startPrint);
  if (!printer || !route) throw new SendFailure('invalid-target');
  const capability = route.capabilities.files.upload;
  if (capability.kind !== 'supported') throw new SendFailure('unsupported');
  const choice = capability.constraints.find(value => value.formats.includes('gcode') && value.collisionPolicies.includes('overwrite'));
  if (!choice) throw new SendFailure('unsupported');
  if (signal.aborted) throw new SendFailure('cancelled');
  const submission = await service.files.upload({
    target: { printerId: printer.identity.id, routeId: route.id, expectedConfigurationRevision: route.configurationRevision },
    requestId: requestId(), destination: choice.destination, format: 'gcode', collisionPolicy: 'overwrite',
    fileName: input.fileName, sizeBytes: input.bytes.byteLength,
  }, { chunks: (async function* () { yield input.bytes; })() });
  if (submission.kind === 'rejected') throw new SendFailure(submission.error.code);
  if (submission.kind === 'outcome-unknown') throw new SendFailure('outcome-unknown');
  // An aborted observer alone does not cancel an upload. Request cancellation explicitly.
  const cancel = () => { void service.operations.requestUploadCancellation(submission.operation); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    for await (const operation of service.operations.watch(submission.operation)) {
      if (operation.kind !== 'upload') throw new SendFailure('device-failed');
      if (operation.progress) {
        const { sentBytes, totalBytes } = operation.progress;
        onProgress({ loaded: sentBytes, ...(totalBytes === null ? {} : { total: totalBytes, fraction: totalBytes > 0 ? sentBytes / totalBytes : 0 }) });
      }
      const phase = operation.phase;
      if (phase.kind === 'completed') return phase.result;
      if (phase.kind === 'failed') throw new SendFailure(phase.error.code);
      if (phase.kind === 'cancelled') throw new SendFailure('cancelled');
      if (phase.kind === 'outcome-unknown') throw new SendFailure('outcome-unknown');
    }
    throw new SendFailure('outcome-unknown');
  } finally { signal.removeEventListener('abort', cancel); }
}

export async function startUploadedPrint(service: PrinterService, file: RemoteFile): Promise<void> {
  const submission = await service.controls.submit({
    target: { printerId: file.ref.printerId, routeId: file.ref.routeId, expectedConfigurationRevision: file.ref.configurationRevision },
    requestId: requestId(), command: { type: 'jobs.start', params: {
      source: { consistency: 'best-effort', file: file.ref }, bindings: [],
    } },
  });
  if (submission.kind === 'rejected') throw new SendFailure(submission.error.code);
  if (submission.kind === 'outcome-unknown') throw new SendFailure('outcome-unknown');
  for await (const operation of service.operations.watch(submission.operation)) {
    if (operation.kind !== 'command' || operation.commandType !== 'jobs.start') throw new SendFailure('device-failed');
    const phase = operation.phase;
    // Accepted by Moonraker; physical printing is not independently observed here.
    if (phase.kind === 'acknowledged' || phase.kind === 'completed') return;
    if (phase.kind === 'failed') throw new SendFailure(phase.error.code);
    if (phase.kind === 'outcome-unknown') throw new SendFailure('outcome-unknown');
  }
  throw new SendFailure('outcome-unknown');
}
