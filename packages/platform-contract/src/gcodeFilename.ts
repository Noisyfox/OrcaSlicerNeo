/** Use only the generated final path component as the host's filename suggestion. */
export function gcodeFilenameBasename(name: string): string {
  return name.split(/[\\/]/).pop() ?? '';
}
