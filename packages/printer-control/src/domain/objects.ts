/** Current-print object identity is issued by the provider, independently of Neo submissions. */
import type { Id, Revision, PrinterTarget, Reading, Capability, Availability } from './common';

export interface PrintObjectContextRef extends PrinterTarget {
  configurationRevision: Revision;
  taskId: Id<'device-task'>;
  /** Opaque catalogue/task context; not a caller session or a firmware object ID. */
  token: Id<'print-object-context'>;
}
export interface PrintObjectSnapshot {
  contextRef: PrintObjectContextRef;
  objects: readonly { id: Id<'print-object'>; name: string }[];
  /** An absent device report stays unknown; submission never increments this set. */
  skippedObjectIds: Reading<readonly Id<'print-object'>[]>;
  availability: Availability;
  pickingImage: Capability<{ mimeType: 'image/png' }>;
}
export interface PrintObjectMap {
  contextRef: PrintObjectContextRef;
  mimeType: 'image/png';
  /** Lossless RGB encodes provider object-map IDs; zero is background. */
  bytes: Uint8Array;
  /** Image IDs map to opaque catalogue IDs; consumers never interpret firmware IDs. */
  palette: readonly { colourId: number; objectId: Id<'print-object'> }[];
}
