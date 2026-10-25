import type { NozzleMappingSnapshot } from '@slicer/client';

export interface MappingConfirmationRequest {
  readonly snapshot: NozzleMappingSnapshot;
  readonly revision: number;
}
let current: MappingConfirmationRequest | null = null;
let complete: ((mapping: readonly number[] | null) => void) | null = null;
const listeners = new Set<() => void>();
const publish = () => { for (const listener of listeners) listener(); };

/** Ephemeral dialog request only. It owns no project input or history state. */
export const mappingConfirmation = {
  getSnapshot: () => current,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  request(snapshot: NozzleMappingSnapshot, revision: number): Promise<readonly number[] | null> {
    if (current) throw new Error('A filament mapping confirmation is already open');
    return new Promise(resolve => {
      current = { snapshot, revision }; complete = resolve; publish();
    });
  },
  finish(request: MappingConfirmationRequest, mapping: readonly number[] | null) {
    if (current !== request) return;
    const resolve = complete;
    current = null; complete = null; publish();
    resolve?.(mapping === null ? null : [...mapping]);
  },
  cancel() { if (current) this.finish(current, null); },
};
