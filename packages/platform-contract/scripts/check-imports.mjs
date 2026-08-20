import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('../src/', import.meta.url);
const forbidden = /(?:from\s*['"](?:electron|node:|\.\.\/\.\.\/apps\/desktop)|import\s*\(\s*['"](?:electron|node:))/;

async function walk(url) {
  for (const entry of await readdir(url, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), url);
    if (entry.isDirectory()) await walk(child);
    else if (/\.(?:ts|tsx)$/.test(entry.name)) {
      const source = await readFile(child, 'utf8');
      if (forbidden.test(source)) throw new Error(`forbidden host import in ${child.pathname}`);
    }
  }
}
await walk(root);
