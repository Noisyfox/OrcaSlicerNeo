import type { PrinterError, PrinterService, RemoteFileRef } from '@orca/printer-control/domain';
export type FileDeletionOutcome = { state: 'deleted' } | { state: 'failed'; error: PrinterError } | { state: 'unconfirmed'; message: string };
/** Observe only a recorded command, never re-query the filesystem or resend an uncertain mutation. */
export async function deleteStorageFile(service: PrinterService, file: RemoteFileRef, signal: AbortSignal): Promise<FileDeletionOutcome> {
  const unknown = (): FileDeletionOutcome => ({ state: 'unconfirmed', message: 'Deletion was not confirmed. Refresh storage manually.' });
  try {
    const result = await service.controls.submit({ target: { printerId: file.printerId, routeId: file.routeId, expectedConfigurationRevision: file.configurationRevision },
      requestId: crypto.randomUUID() as never, command: { type: 'files.delete', params: { target: file } } });
    if (result.kind === 'rejected') return { state: 'failed', error: result.error };
    if (result.kind === 'outcome-unknown') return unknown();
    for await (const operation of service.operations.watch(result.operation, { signal })) {
      if (operation.phase.kind === 'completed') return { state: 'deleted' };
      if (operation.phase.kind === 'failed') return { state: 'failed', error: operation.phase.error };
      if (operation.phase.kind === 'accepted' || operation.phase.kind === 'outcome-unknown') return unknown();
    }
  } catch { /* Delivery cannot be inferred from a broken response or observation. */ }
  return unknown();
}
export function pausesDeletion(outcome: FileDeletionOutcome): boolean {
  return outcome.state === 'unconfirmed' || outcome.state === 'failed' && ['transport', 'offline', 'authentication-required', 'storage-unavailable', 'stale-context'].includes(outcome.error.code);
}
