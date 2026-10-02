/** Collect each owned ArrayBuffer once; SharedArrayBuffer is never transferable. */
export function collectTransferables(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const visited = new Set<object>();
  const visit = (item: unknown): void => {
    if (!item || typeof item !== 'object' || visited.has(item)) return;
    visited.add(item);
    if (item instanceof ArrayBuffer) { buffers.add(item); return; }
    if (ArrayBuffer.isView(item)) {
      if (item.buffer instanceof ArrayBuffer) buffers.add(item.buffer);
      return;
    }
    for (const child of Object.values(item)) visit(child);
  };
  visit(value);
  return [...buffers];
}
