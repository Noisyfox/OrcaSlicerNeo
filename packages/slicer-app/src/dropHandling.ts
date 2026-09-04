/** MIME values commonly reported for a 3MF dragged from the desktop. */
export const THREE_MF_MIME_TYPES = new Set([
  'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
  'model/3mf',
]);

/**
 * Identify a 3MF without relying on the platform's MIME database. Desktop
 * drag sources frequently report an empty or generic type, so the extension
 * remains authoritative for normal files while the known MIME values cover
 * sources that do not provide a useful filename.
 */
export function isThreeMfDropFile(file: Pick<File, 'name' | 'type'>): boolean {
  const name = file.name.trim().toLowerCase();
  return name.endsWith('.3mf') || THREE_MF_MIME_TYPES.has(file.type.toLowerCase());
}

export function externalDropFiles(dataTransfer: DataTransfer | null | undefined): File[] {
  return Array.from(dataTransfer?.files ?? []);
}

/** Install shared external-file listeners at capture phase. */
export function registerProjectDropHandlers(
  target: Pick<Document, 'addEventListener' | 'removeEventListener'>,
  onProjectDrop: (files: File[]) => void | Promise<void>,
): () => void {
  const onDragOver = (event: DragEvent) => {
    if (externalDropFiles(event.dataTransfer).length) event.preventDefault();
  };
  const onDrop = (event: DragEvent) => {
    const files = externalDropFiles(event.dataTransfer);
    // Prevent Chromium from opening an external file as a new document. A
    // text-only application drag has no files and remains untouched.
    if (files.length === 0) return;
    event.preventDefault();
    if (!files.some(isThreeMfDropFile)) return;
    void onProjectDrop(files);
  };
  target.addEventListener('dragover', onDragOver, true);
  target.addEventListener('drop', onDrop, true);
  return () => {
    target.removeEventListener('dragover', onDragOver, true);
    target.removeEventListener('drop', onDrop, true);
  };
}
