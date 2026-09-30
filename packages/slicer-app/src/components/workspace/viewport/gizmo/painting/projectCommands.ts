import type { PaintingController } from './PaintingController';
import type { FilamentSessionSnapshot, FilamentMutationSummary } from '@slicer/client';

let owner: PaintingController | null = null;

/** The app owns one painter even when its viewport is hidden. Shared action
 * entrypoints consult this owner before dialogs and before FIFO admission. */
export function registerPaintingCommands(controller: PaintingController): () => void {
  owner = controller;
  return () => { if (owner === controller) owner = null; };
}
export function paintingCommandAllowed(): boolean {
  return owner?.commandAllowed ?? true;
}
export function coordinatePaintingProjectOperation<T>(operation: () => Promise<T>, enqueue: (operation: () => Promise<T>) => Promise<T>): Promise<T> {
  return owner?.active ? owner.projectOperation(operation) : enqueue(operation);
}
export async function closePaintingForCommand(): Promise<boolean> {
  return !owner?.active || (paintingCommandAllowed() && await owner.close());
}
export function resetPaintingProjectPalette(): void { owner?.resetProjectPalette(); }
export function reconcilePaintingPalette(snapshot: FilamentSessionSnapshot, mutation?: FilamentMutationSummary): void {
  owner?.reconcilePalette(snapshot, mutation);
}
export function paintingSessionActive(): boolean { return owner?.active ?? false; }
export async function beforePaintingTopologyChange(target: {
  objects?: readonly number[]; parts?: readonly number[]; instances?: readonly number[];
}): Promise<boolean> {
  if (!paintingCommandAllowed()) return false;
  const session = owner?.getSnapshot().session;
  if (!session) return true;
  const affected = target.objects?.includes(session.objectId) || target.instances?.includes(session.instanceId) ||
    session.parts.some((part) => target.parts?.includes(part.volumeId));
  return !affected || await closePaintingForCommand();
}
