import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

/** Node equivalent of the browser ProfileSource for package-based smoke runs. */
export function createNodeProfileSource(root) {
  const base = resolve(root);
  return {
    async fetch(relativePath) {
      if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => part === '..')) {
        throw new Error(`unsafe profile path: ${relativePath}`);
      }
      const file = resolve(base, relativePath);
      if (!file.startsWith(`${base}\\`) && !file.startsWith(`${base}/`)) {
        throw new Error(`unsafe profile path: ${relativePath}`);
      }
      return new Uint8Array(await readFile(file));
    },
  };
}
