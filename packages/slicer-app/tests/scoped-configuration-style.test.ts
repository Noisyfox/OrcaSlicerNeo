import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sharedStyles = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

describe('configuration override styles', () => {
  it('defines the shared Orca orange token and label rule', () => {
    expect(sharedStyles).toMatch(/--color-config-override:\s*#F1754E;/);
    expect(sharedStyles).toMatch(/\.config-override-label\s*\{\s*color:\s*var\(--color-config-override\);\s*\}/);
  });
});
