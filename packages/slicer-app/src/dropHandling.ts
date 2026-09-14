import { MODEL_FILE_EXTENSIONS } from '@orca/platform-contract';

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

const MODEL_DROP_EXTENSIONS = new Set<string>(MODEL_FILE_EXTENSIONS.filter((extension) => extension !== '3mf'));

/** Identify a model drop using the same extension contract as Add Model. */
export function isModelDropFile(file: Pick<File, 'name' | 'type'>): boolean {
  const name = file.name.trim().toLowerCase();
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return MODEL_DROP_EXTENSIONS.has(extension);
}

export function externalDropFiles(dataTransfer: DataTransfer | null | undefined): File[] {
  if (!dataTransfer) return [];

  // Chromium/Electron can expose native OS drops through `items` before the
  // protected file list is populated. Prefer the FileList when it is
  // available, then use getAsFile() as the drop-time fallback. In particular,
  // Windows Explorer may report an item during dragover while `files` is
  // empty; callers use hasExternalFileDrag() below to accept that drop.
  const files = Array.from(dataTransfer.files ?? []);
  if (files.length > 0) return files;
  return Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

/**
 * Detect an OS file drag during dragover, when DataTransfer.files is allowed
 * to remain protected/empty by Chromium. The drop handler can then call
 * getAsFile() after the data store becomes readable.
 */
export function hasExternalFileDrag(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.files.length > 0) return true;
  return Array.from(dataTransfer.items ?? []).some((item) => item.kind === 'file');
}

/** Install shared external-file listeners at capture phase. */
export interface ExternalDropHandlers {
  onProjectDrop?: (files: File[]) => void | Promise<void>;
  onModelDrop?: (files: File[]) => void | Promise<void>;
}

export function registerProjectDropHandlers(
  target: Pick<Document, 'addEventListener' | 'removeEventListener'>,
  handlers: ExternalDropHandlers,
): () => void;
export function registerProjectDropHandlers(
  target: Pick<Document, 'addEventListener' | 'removeEventListener'>,
  onProjectDrop: (files: File[]) => void | Promise<void>,
): () => void;
export function registerProjectDropHandlers(
  target: Pick<Document, 'addEventListener' | 'removeEventListener'>,
  handlers: ExternalDropHandlers | ((files: File[]) => void | Promise<void>),
): () => void {
  const normalizedHandlers: ExternalDropHandlers = typeof handlers === 'function'
    ? { onProjectDrop: handlers }
    : handlers ?? {};
  const { onProjectDrop, onModelDrop } = normalizedHandlers;
  const onDragOver = (event: DragEvent) => {
    if (hasExternalFileDrag(event.dataTransfer)) event.preventDefault();
  };
  const onDrop = (event: DragEvent) => {
    const files = externalDropFiles(event.dataTransfer);
    // Prevent Chromium from opening an external file as a new document. A
    // text-only application drag has no files and remains untouched.
    if (files.length === 0) return;
    event.preventDefault();
    const projectFiles = files.filter(isThreeMfDropFile);
    const modelFiles = files.filter(isModelDropFile);
    if (projectFiles.length > 0 && onProjectDrop) void onProjectDrop(projectFiles);
    if (modelFiles.length > 0 && onModelDrop) void onModelDrop(modelFiles);
  };
  target.addEventListener('dragover', onDragOver, true);
  target.addEventListener('drop', onDrop, true);
  return () => {
    target.removeEventListener('dragover', onDragOver, true);
    target.removeEventListener('drop', onDrop, true);
  };
}
