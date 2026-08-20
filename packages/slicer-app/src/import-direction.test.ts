import { describe, expect, it } from 'vitest';

const sources = import.meta.glob<string>('./**/*.{ts,tsx}', { eager: true, query: '?raw', import: 'default' });

// Keep this guard deliberately focused on module specifiers.  CSS classes such
// as `absolute` and prose mentioning Electron are valid in shared sources;
// only executable dependency edges can violate the package boundary.
const moduleSpecifier = /(?:import\s+(?:type\s+)?[^;]*?\s+from\s+|export\s+[^;]*?\s+from\s+|import\s*\(|require\s*\()(['"])(.*?)\1/g;

describe('slicer-app import direction', () => {
  it('does not depend on a host, Electron, Node, preload, or absolute path', async () => {
    const violations: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      for (const match of text.matchAll(moduleSpecifier)) {
        const specifier = match[2];
        const normalized = specifier.replaceAll('\\', '/').toLowerCase();
        const forbidden =
          normalized.includes('apps/desktop') ||
          normalized.includes('electron') ||
          normalized.startsWith('node:') ||
          normalized === 'node' ||
          normalized.includes('preload') ||
          /^[a-z]:\//.test(normalized) ||
          normalized.startsWith('/') ||
          normalized.startsWith('\\\\');
        if (forbidden) violations.push(`${file} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
