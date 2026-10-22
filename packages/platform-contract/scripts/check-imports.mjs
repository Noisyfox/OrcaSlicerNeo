import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('../src/', import.meta.url);
const forbidden = /(?:from\s*['"](?:electron|node:|\.\.\/\.\.\/apps\/desktop)|import\s*\(\s*['"](?:electron|node:))/;

async function walk(url, pattern = forbidden) {
  for (const entry of await readdir(url, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), url);
    if (entry.isDirectory()) await walk(child, pattern);
    else if (/\.(?:ts|tsx)$/.test(entry.name)) {
      const source = await readFile(child, 'utf8');
      if (pattern.test(source)) throw new Error(`forbidden host import in ${child.pathname}`);
    }
  }
}
await walk(root);

// Account contracts must not acquire a dependency on printer or native host domains.
await walk(new URL('../../service-provider/src/', import.meta.url), /(?:from\s*['"][^'"]*(?:printer-control|electron|node:|apps\/)|import\s*\(\s*['"][^'"]*(?:printer-control|electron|node:|apps\/))/);
