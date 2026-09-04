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
