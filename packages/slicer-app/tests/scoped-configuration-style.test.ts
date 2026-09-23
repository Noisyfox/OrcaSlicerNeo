import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sharedStyles = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

describe('scoped configuration styles', () => {
  it('defines the Orca orange token and semantic label rule in shared CSS', () => {
    expect(sharedStyles).toMatch(/--color-scoped-config-local-override:\s*#F1754E;/);
    expect(sharedStyles).toMatch(/\.scoped-config-local-override-label\s*\{\s*color:\s*var\(--color-scoped-config-local-override\);\s*\}/);
  });
});
